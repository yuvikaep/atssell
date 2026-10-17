import type { Db } from '../db.js';
import { randomToken, sha256Hex } from '../security.js';

// Default pipeline. Tenants can edit stages and transitions from Settings (later sprint).
const DEFAULT_STAGES = [
  { code: 'submitted', name: 'Submitted', terminal: null },
  { code: 'screening', name: 'Screening', terminal: null },
  { code: 'shortlisted', name: 'Shortlisted', terminal: null },
  { code: 'interview', name: 'Interview', terminal: null },
  { code: 'offer', name: 'Offer', terminal: null },
  { code: 'hired', name: 'Hired', terminal: 'hired' },
  { code: 'rejected', name: 'Rejected', terminal: 'rejected' },
  { code: 'withdrawn', name: 'Withdrawn', terminal: 'withdrawn' },
] as const;

export interface CreateTenantInput {
  name: string;
  slug: string;
  adminEmail: string;
  adminName: string;
  /** Hours the first admin's set-password link stays valid. */
  setupLinkHours?: number;
}

/**
 * Provisions a tenant: settings, default pipeline, and the first Company Admin. The admin gets a
 * one-time set-password link (a password reset token) instead of an invitation, because
 * invitations need an existing user as the inviter.
 *
 * Must run on the owner/admin connection (BYPASSRLS): the tenant does not exist yet.
 */
export async function createTenant(adminDb: Db, input: CreateTenantInput) {
  return adminDb.transaction().execute(async (tx) => {
    const tenant = await tx
      .insertInto('tenants')
      .values({ name: input.name, slug: input.slug })
      .returning(['id', 'name', 'slug'])
      .executeTakeFirstOrThrow();

    await tx.insertInto('tenant_settings').values({ tenant_id: tenant.id }).execute();

    const stages = await tx
      .insertInto('pipeline_stages')
      .values(
        DEFAULT_STAGES.map((s, i) => ({
          tenant_id: tenant.id,
          code: s.code,
          name: s.name,
          sort_order: (i + 1) * 10,
          is_initial: i === 0,
          terminal_status: s.terminal,
        })),
      )
      .returning(['id', 'code', 'terminal_status'])
      .execute();

    const open = stages.filter((s) => s.terminal_status === null);
    const byCode = Object.fromEntries(stages.map((s) => [s.code, s.id]));
    const transitions = [
      ...open.map((s, i) => ({ from: s.id, to: open[i + 1]?.id ?? byCode.hired!, reason: false })),
      ...open.map((s) => ({ from: s.id, to: byCode.rejected!, reason: true })),
      ...open.map((s) => ({ from: s.id, to: byCode.withdrawn!, reason: true })),
    ];
    await tx
      .insertInto('pipeline_stage_transitions')
      .values(transitions.map((t) => ({
        tenant_id: tenant.id,
        from_stage_id: t.from,
        to_stage_id: t.to,
        requires_reason: t.reason,
      })))
      .execute();

    const admin = await tx
      .insertInto('users')
      .values({ tenant_id: tenant.id, email: input.adminEmail, full_name: input.adminName })
      .returning(['id', 'email'])
      .executeTakeFirstOrThrow();

    const role = await tx
      .selectFrom('roles')
      .select('id')
      .where('code', '=', 'company_admin')
      .where('tenant_id', 'is', null)
      .executeTakeFirstOrThrow();
    await tx
      .insertInto('user_role_assignments')
      .values({ tenant_id: tenant.id, user_id: admin.id, role_id: role.id, department_id: null })
      .execute();

    const setupToken = randomToken();
    const expiresAt = new Date(Date.now() + (input.setupLinkHours ?? 72) * 3600_000);
    await tx
      .insertInto('password_reset_tokens')
      .values({ tenant_id: tenant.id, user_id: admin.id, token_hash: sha256Hex(setupToken), expires_at: expiresAt })
      .execute();

    await tx
      .insertInto('audit_events')
      .values({
        tenant_id: tenant.id,
        actor_user_id: null,
        actor_type: 'platform_admin',
        action: 'tenant.created',
        entity_type: 'tenant',
        entity_id: tenant.id,
        metadata: JSON.stringify({ admin_user_id: admin.id }),
      })
      .execute();

    return { tenant, admin, setupToken, setupExpiresAt: expiresAt };
  });
}
