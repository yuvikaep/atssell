import type { FastifyRequest } from 'fastify';
import { sql } from 'kysely';
import { audit } from './audit.js';
import type { Tx } from './db.js';
import { AppError } from './errors.js';
import type { Principal } from './permissions.js';

/**
 * Moves an application to another stage, enforcing the company's allowed transitions, and records the
 * stage history and an audit event. Shared by the pipeline board and by offers/joining, so every route
 * to "hired" or "withdrawn" obeys the same rules.
 */
export async function moveStage(
  tx: Tx, req: FastifyRequest | null, p: Principal,
  a: { id: string; status: string; stage_id: string }, toStageId: string, reason?: string | null,
) {
  if (a.status !== 'active') throw new AppError(409, 'APPLICATION_CLOSED', 'This application is closed. Add the candidate to the vacancy again to reapply.');
  if (a.stage_id === toStageId) throw new AppError(409, 'SAME_STAGE', 'The application is already in this stage.');
  const t = await tx
    .selectFrom('pipeline_stage_transitions as t')
    .innerJoin('pipeline_stages as s', 's.id', 't.to_stage_id')
    .select(['t.requires_reason', 's.terminal_status', 's.name', 's.status'])
    .where('t.from_stage_id', '=', a.stage_id)
    .where('t.to_stage_id', '=', toStageId)
    .executeTakeFirst();
  if (!t || t.status !== 'active') throw new AppError(422, 'TRANSITION_NOT_ALLOWED', 'That move is not allowed from the current stage.');
  if (t.requires_reason && !reason) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Some fields are invalid.', [{ path: 'reason', message: 'A reason is required for this move.' }]);
  }
  await tx
    .updateTable('applications')
    .set({
      stage_id: toStageId,
      stage_changed_at: sql`now()`,
      ...(t.terminal_status ? { status: t.terminal_status, disposition_reason: reason ?? null } : {}),
    })
    .where('id', '=', a.id)
    .execute();
  await tx
    .insertInto('application_stage_events')
    .values({ tenant_id: p.tenantId, application_id: a.id, from_stage_id: a.stage_id, to_stage_id: toStageId, reason: reason ?? null, actor_user_id: p.userId })
    .execute();
  await audit(tx, req, {
    tenantId: p.tenantId, actorUserId: p.userId, action: 'application.stage_changed', entityType: 'application', entityId: a.id,
    metadata: { from: a.stage_id, to: toStageId, reason: reason ?? null },
  });
}

/** The company's stage with this code ('offer', 'hired', 'withdrawn'…), if it has one. */
export async function stageByCode(tx: Tx, code: string) {
  return tx.selectFrom('pipeline_stages').select(['id', 'terminal_status']).where('code', '=', code).where('status', '=', 'active').executeTakeFirst();
}

/**
 * Moves an application to a terminal stage on the HR Lead's authority, whatever stage it is in. Used when
 * the HR Lead records a real-world fact (the person joined) that the board may not have reached yet.
 * Still writes the stage history and an audit event.
 */
export async function forceTerminalStage(
  tx: Tx, req: FastifyRequest | null, p: Principal,
  a: { id: string; status: string; stage_id: string }, toStageId: string, reason: string,
) {
  if (a.status !== 'active') throw new AppError(409, 'APPLICATION_CLOSED', 'This application is already closed.');
  const stage = await tx.selectFrom('pipeline_stages').select('terminal_status').where('id', '=', toStageId).executeTakeFirstOrThrow();
  if (!stage.terminal_status) throw new Error('forceTerminalStage needs a terminal stage');
  await tx.updateTable('applications').set({ stage_id: toStageId, stage_changed_at: sql`now()`, status: stage.terminal_status, disposition_reason: reason }).where('id', '=', a.id).execute();
  await tx.insertInto('application_stage_events').values({ tenant_id: p.tenantId, application_id: a.id, from_stage_id: a.stage_id, to_stage_id: toStageId, reason, actor_user_id: p.userId }).execute();
  await audit(tx, req, { tenantId: p.tenantId, actorUserId: p.userId, action: 'application.stage_changed', entityType: 'application', entityId: a.id, metadata: { from: a.stage_id, to: toStageId, reason, forced: true } });
}
