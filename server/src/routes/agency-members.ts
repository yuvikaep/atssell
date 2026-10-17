// Company-side management of an agency's people. Agency users only ever reach /agency/* (agency-portal.ts).
import type { FastifyInstance } from 'fastify';
import { inviteLinkToCopy } from '../mailer.js';
import { z } from 'zod';
import { principal } from '../app.js';
import { audit } from '../audit.js';
import { pgConstraint, pgErrorCode, withTenant, type Tx } from '../db.js';
import { AppError, notFound } from '../errors.js';
import { requirePermission } from '../permissions.js';
import { randomToken, sha256Hex } from '../security.js';
import { revokeUserSessions } from '../services/sessions.js';

const ROLE_CODE = { admin: 'agency_admin', recruiter: 'agency_recruiter' } as const;
const Params = z.object({ id: z.uuid() });
const MemberParams = z.object({ id: z.uuid(), userId: z.uuid() });
const InviteBody = z.object({ email: z.email().trim().toLowerCase(), agency_role: z.enum(['admin', 'recruiter']) });
const MemberBody = z
  .object({ agency_role: z.enum(['admin', 'recruiter']), status: z.enum(['active', 'inactive']) })
  .partial()
  .refine((b) => Object.keys(b).length > 0, 'Provide at least one field to update.');

async function loadAgency(tx: Tx, id: string) {
  const a = await tx.selectFrom('agencies').select(['id', 'name', 'status']).where('id', '=', id).executeTakeFirst();
  if (!a) throw notFound('Agency');
  return a;
}

async function membersOf(tx: Tx, agencyId: string) {
  const members = await tx
    .selectFrom('agency_members as m')
    .innerJoin('users as u', 'u.id', 'm.user_id')
    .select(['u.id as user_id', 'u.full_name', 'u.email', 'u.status', 'm.agency_role', 'u.last_login_at', 'm.created_at'])
    .where('m.agency_id', '=', agencyId)
    .orderBy('u.full_name')
    .execute();
  const invitations = await tx
    .selectFrom('user_invitations as i')
    .innerJoin('roles as r', 'r.id', 'i.role_id')
    .select(['i.id', 'i.email', 'i.expires_at', 'i.created_at', 'r.code as role_code'])
    .where('i.agency_id', '=', agencyId)
    .where('i.accepted_at', 'is', null)
    .where('i.revoked_at', 'is', null)
    .orderBy('i.created_at', 'desc')
    .execute();
  const now = new Date();
  return {
    members,
    invitations: invitations.map((i) => ({
      id: i.id, email: i.email, expires_at: i.expires_at, expired: i.expires_at <= now,
      agency_role: i.role_code === 'agency_admin' ? 'admin' : 'recruiter',
    })),
  };
}

export async function agencyMemberRoutes(app: FastifyInstance) {
  const { db, config } = app;

  app.get('/agencies/:id/members', async (req) => {
    const p = principal(req);
    requirePermission(p, 'agencies.manage');
    const { id } = Params.parse(req.params);
    return withTenant(db, p.tenantId, async (tx) => {
      const agency = await loadAgency(tx, id);
      return { data: { agency, ...(await membersOf(tx, id)) } };
    });
  });

  app.post('/agencies/:id/invitations', async (req, reply) => {
    const p = principal(req);
    requirePermission(p, 'agencies.manage');
    const { id } = Params.parse(req.params);
    const body = InviteBody.parse(req.body);

    const sent = await withTenant(db, p.tenantId, async (tx) => {
      const agency = await loadAgency(tx, id);
      if (agency.status !== 'active') throw new AppError(422, 'AGENCY_INACTIVE', 'Reactivate the agency before inviting people to it.');
      if (await tx.selectFrom('users').select('id').where('email', '=', body.email).executeTakeFirst()) {
        throw new AppError(409, 'USER_EXISTS', 'A user with this email already exists.');
      }
      const role = await tx.selectFrom('roles').select(['id', 'name']).where('code', '=', ROLE_CODE[body.agency_role]).where('tenant_id', 'is', null).executeTakeFirstOrThrow();
      const token = randomToken();
      const expiresAt = new Date(Date.now() + config.INVITATION_TTL_HOURS * 3600_000);
      const inv = await tx
        .insertInto('user_invitations')
        .values({ tenant_id: p.tenantId, email: body.email, role_id: role.id, department_id: null, agency_id: id, token_hash: sha256Hex(token), expires_at: expiresAt, invited_by: p.userId })
        .returning(['id', 'email', 'expires_at'])
        .executeTakeFirstOrThrow()
        .catch((err: unknown) => {
          if (pgErrorCode(err) === '23505' && pgConstraint(err) === 'uq_user_invitations_open') {
            throw new AppError(409, 'INVITATION_PENDING', 'This email already has a pending invitation. Resend it from Users & roles.');
          }
          throw err;
        });
      await audit(tx, req, {
        tenantId: p.tenantId, actorUserId: p.userId, action: 'agency.member_invited', entityType: 'agency', entityId: id,
        metadata: { invitation_id: inv.id, email: body.email, agency_role: body.agency_role },
      });
      return { inv, token, roleName: role.name };
    });

    await app.mailer.sendInvitation({
      to: sent.inv.email, companyName: p.tenantName, inviterName: p.fullName, roleName: sent.roleName,
      link: `${config.WEB_ORIGIN}/invite#${sent.token}`, expiresAt: sent.inv.expires_at,
    });
    return reply.status(201).send({ data: { ...sent.inv, invite_link: inviteLinkToCopy(config, sent.token) } });
  });

  // Change an agency member's role (admin or recruiter) or deactivate or reactivate them.
  app.patch('/agencies/:id/members/:userId', async (req) => {
    const p = principal(req);
    requirePermission(p, 'agencies.manage');
    const { id, userId } = MemberParams.parse(req.params);
    const body = MemberBody.parse(req.body);

    return withTenant(db, p.tenantId, async (tx) => {
      await loadAgency(tx, id);
      const member = await tx.selectFrom('agency_members').select(['id', 'agency_role']).where('agency_id', '=', id).where('user_id', '=', userId).forUpdate().executeTakeFirst();
      if (!member) throw notFound('Agency member');

      if (body.agency_role && body.agency_role !== member.agency_role) {
        const role = await tx.selectFrom('roles').select('id').where('code', '=', ROLE_CODE[body.agency_role]).where('tenant_id', 'is', null).executeTakeFirstOrThrow();
        await tx.updateTable('agency_members').set({ agency_role: body.agency_role }).where('id', '=', member.id).execute();
        await tx.deleteFrom('user_role_assignments').where('user_id', '=', userId).execute();
        await tx.insertInto('user_role_assignments').values({ tenant_id: p.tenantId, user_id: userId, role_id: role.id, department_id: null, assigned_by: p.userId }).execute();
      }
      if (body.status) {
        await tx.updateTable('users').set({ status: body.status }).where('id', '=', userId).execute();
        if (body.status === 'inactive') await revokeUserSessions(tx, userId);
      }
      await audit(tx, req, {
        tenantId: p.tenantId, actorUserId: p.userId, action: 'agency.member_updated', entityType: 'agency', entityId: id,
        metadata: { user_id: userId, changes: body, previous_role: member.agency_role },
      });
      return { data: await membersOf(tx, id) };
    });
  });
}
