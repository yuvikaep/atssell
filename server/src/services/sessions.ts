import { sql } from 'kysely';
import { setTenant, setTokenHash, type Db, type Tx } from '../db.js';
import { loadRolesAndPermissions, type Principal } from '../permissions.js';
import { randomToken, sha256Hex } from '../security.js';

export const SESSION_COOKIE = 'jm_session';
const LAST_SEEN_RESOLUTION_MS = 5 * 60 * 1000;

export async function createSession(
  tx: Tx,
  input: { tenantId: string; userId: string; ttlHours: number; ipHash: string; userAgent?: string },
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomToken();
  const expiresAt = new Date(Date.now() + input.ttlHours * 3600_000);
  await tx
    .insertInto('sessions')
    .values({
      tenant_id: input.tenantId,
      user_id: input.userId,
      token_hash: sha256Hex(token),
      expires_at: expiresAt,
      ip_hash: input.ipHash,
      user_agent: input.userAgent?.slice(0, 512) ?? null,
    })
    .execute();
  return { token, expiresAt };
}

/**
 * Resolves a session cookie to a principal. Returns null for unknown, expired or revoked sessions,
 * and for users or tenants that are no longer active. Roles and permissions are loaded on every
 * request, so role changes and deactivation take effect immediately.
 */
export async function resolveSession(db: Db, token: string): Promise<Principal | null> {
  const tokenHash = sha256Hex(token);
  return db.transaction().execute(async (tx) => {
    await setTokenHash(tx, 'app.session_token_hash', tokenHash);
    const session = await tx
      .selectFrom('sessions')
      .select(['id', 'tenant_id', 'user_id', 'expires_at', 'revoked_at', 'last_seen_at'])
      .where('token_hash', '=', tokenHash)
      .executeTakeFirst();
    if (!session || session.revoked_at || session.expires_at <= new Date()) return null;

    await setTenant(tx, session.tenant_id);
    const row = await tx
      .selectFrom('users as u')
      .innerJoin('tenants as t', 't.id', 'u.tenant_id')
      .select(['u.id', 'u.email', 'u.full_name', 'u.status', 'u.must_change_password', 't.name as tenant_name', 't.slug', 't.status as tenant_status'])
      .where('u.id', '=', session.user_id)
      .executeTakeFirst();
    if (!row || row.status !== 'active' || row.tenant_status !== 'active') return null;

    if (Date.now() - session.last_seen_at.getTime() > LAST_SEEN_RESOLUTION_MS) {
      await tx.updateTable('sessions').set({ last_seen_at: sql`now()` }).where('id', '=', session.id).execute();
    }

    const { roles, permissions } = await loadRolesAndPermissions(tx, row.id);
    return {
      userId: row.id,
      tenantId: session.tenant_id,
      tenantName: row.tenant_name,
      tenantSlug: row.slug,
      email: row.email,
      fullName: row.full_name,
      sessionId: session.id,
      mustChangePassword: row.must_change_password,
      roles,
      permissions,
    };
  });
}

export async function revokeUserSessions(tx: Tx, userId: string): Promise<void> {
  await tx
    .updateTable('sessions')
    .set({ revoked_at: sql`now()` })
    .where('user_id', '=', userId)
    .where('revoked_at', 'is', null)
    .execute();
}
