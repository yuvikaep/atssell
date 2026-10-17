import type { FastifyInstance, FastifyRequest } from 'fastify';
import { sql } from 'kysely';
import { z } from 'zod';
import { audit } from '../audit.js';
import { setTenant, setTokenHash, type Tx } from '../db.js';
import { AppError } from '../errors.js';
import { hashPassword, sha256Hex } from '../security.js';
import { createSession } from '../services/sessions.js';
import { passwordSchema, publicRateLimit, requestIpHash, setSessionCookie, tokenSchema } from './common.js';

const LookupBody = z.object({ token: tokenSchema });
const AcceptBody = z.object({
  token: tokenSchema,
  full_name: z.string().trim().min(1).max(200),
  password: passwordSchema,
});

type OpenInvitation = Awaited<ReturnType<typeof loadOpen>>;

/**
 * Turns an open invitation into a user with its role (and agency membership). `byUserId` is set when
 * an admin creates the login with a password for the person, instead of them accepting the link.
 */
export async function createInvitedUser(tx: Tx, req: FastifyRequest, inv: OpenInvitation, fullName: string, passwordHash: string, byUserId: string | null) {
  const existing = await tx.selectFrom('users').select('id').where('email', '=', inv.email).executeTakeFirst();
  if (existing) {
    throw new AppError(409, 'USER_EXISTS', 'An account with this email already exists. Sign in instead.');
  }

  const user = await tx
    .insertInto('users')
    .values({ tenant_id: inv.tenant_id, email: inv.email, full_name: fullName, password_hash: passwordHash, ...(byUserId ? {} : { last_login_at: sql`now()` }) })
    .returning('id')
    .executeTakeFirstOrThrow();
  await tx
    .insertInto('user_role_assignments')
    .values({
  tenant_id: inv.tenant_id,
  user_id: user.id,
  role_id: inv.role_id,
  department_id: inv.department_id,
  assigned_by: inv.invited_by,
    })
    .execute();
  if (inv.agency_id) {
    const agency = await tx.selectFrom('agencies').select('status').where('id', '=', inv.agency_id).executeTakeFirst();
    if (!agency || agency.status !== 'active') throw invalidInvitation();
    await tx
  .insertInto('agency_members')
  .values({
    tenant_id: inv.tenant_id,
    agency_id: inv.agency_id,
    user_id: user.id,
    agency_role: inv.role_code === 'agency_admin' ? 'admin' : 'recruiter',
  })
  .execute();
  }
  await tx.updateTable('user_invitations').set({ accepted_at: sql`now()` }).where('id', '=', inv.id).execute();
  await audit(tx, req, {
    tenantId: inv.tenant_id,
    actorUserId: byUserId ?? user.id,
    action: byUserId ? 'user.login_created_by_admin' : 'user.invitation_accepted',
    entityType: 'user',
    entityId: user.id,
    metadata: { invitation_id: inv.id, role_id: inv.role_id, department_id: inv.department_id, agency_id: inv.agency_id },
  });
  return user;
}

const invalidInvitation = () => new AppError(410, 'INVITATION_INVALID', 'This invitation is invalid or has expired.');

/** Finds an open invitation by token and switches the transaction to its tenant. */
export async function findOpenInvitation(tx: Tx, token: string, lock: boolean) {
  return findInvitation(tx, { token }, lock);
}

/** By token (public link) or by id (admin, already inside the tenant). */
export async function findInvitation(tx: Tx, by: { token: string } | { id: string }, lock: boolean) {
  if ('id' in by) return loadOpen(tx, by.id, lock);
  const token = by.token;
  const tokenHash = sha256Hex(token);
  await setTokenHash(tx, 'app.invitation_token_hash', tokenHash);
  const found = await tx
    .selectFrom('user_invitations')
    .select(['id', 'tenant_id'])
    .where('token_hash', '=', tokenHash)
    .executeTakeFirst();
  if (!found) throw invalidInvitation();
  await setTenant(tx, found.tenant_id);
  return loadOpen(tx, found.id, lock);
}

async function loadOpen(tx: Tx, id: string, lock: boolean) {
  let query = tx
    .selectFrom('user_invitations as i')
    .innerJoin('roles as r', 'r.id', 'i.role_id')
    .innerJoin('tenants as t', 't.id', 'i.tenant_id')
    .select([
      'i.id', 'i.tenant_id', 'i.email', 'i.role_id', 'i.department_id', 'i.agency_id', 'i.invited_by',
      'i.expires_at', 'i.accepted_at', 'i.revoked_at', 'r.code as role_code', 'r.name as role_name', 't.name as company_name',
      't.status as tenant_status',
    ])
    .where('i.id', '=', id);
  if (lock) query = query.forUpdate('i');
  const inv = await query.executeTakeFirst();
  if (!inv) throw invalidInvitation();

  if (inv.accepted_at || inv.revoked_at || inv.expires_at <= new Date() || inv.tenant_status !== 'active') {
    throw invalidInvitation();
  }
  return inv;
}

export async function invitationPublicRoutes(app: FastifyInstance) {
  const { db, config } = app;

  app.post('/invitations/lookup', { config: publicRateLimit(20) }, async (req) => {
    const { token } = LookupBody.parse(req.body);
    const inv = await db.transaction().execute((tx) => findOpenInvitation(tx, token, false));
    return {
      data: { email: inv.email, company_name: inv.company_name, role_name: inv.role_name, expires_at: inv.expires_at },
    };
  });

  app.post('/invitations/accept', { config: publicRateLimit(10) }, async (req, reply) => {
    const body = AcceptBody.parse(req.body);
    const passwordHash = await hashPassword(body.password);

    const session = await db.transaction().execute(async (tx) => {
      const inv = await findOpenInvitation(tx, body.token, true);

      const user = await createInvitedUser(tx, req, inv, body.full_name, passwordHash, null);
      return createSession(tx, {
        tenantId: inv.tenant_id,
        userId: user.id,
        ttlHours: config.SESSION_TTL_HOURS,
        ipHash: requestIpHash(req),
        userAgent: req.headers['user-agent'],
      });
    });

    setSessionCookie(reply, config, session.token, session.expiresAt);
    return reply.status(201).send({ data: { status: 'accepted' } });
  });
}
