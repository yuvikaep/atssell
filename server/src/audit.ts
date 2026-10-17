import type { FastifyRequest } from 'fastify';
import type { Tx } from './db.js';
import { hashIp } from './security.js';

export interface AuditInput {
  tenantId: string;
  actorUserId: string | null;
  actorType?: 'user' | 'system' | 'platform_admin' | 'external_interviewer';
  actorLabel?: string;
  action: string;
  entityType: string;
  entityId?: string | null;
  metadata?: Record<string, unknown>;
}

/** Writes an audit event in the caller's transaction, so it commits or rolls back with the change. */
export async function audit(tx: Tx, req: FastifyRequest | null, input: AuditInput): Promise<void> {
  await tx
    .insertInto('audit_events')
    .values({
      tenant_id: input.tenantId,
      actor_user_id: input.actorUserId,
      actor_type: input.actorType ?? 'user',
      actor_label: input.actorLabel ?? null,
      action: input.action,
      entity_type: input.entityType,
      entity_id: input.entityId ?? null,
      request_id: req?.id ?? null,
      ip_hash: req ? hashIp(req.ip, req.server.config.IP_HASH_SALT) : null,
      user_agent: req?.headers['user-agent']?.slice(0, 512) ?? null,
      metadata: JSON.stringify(input.metadata ?? {}),
    })
    .execute();
}
