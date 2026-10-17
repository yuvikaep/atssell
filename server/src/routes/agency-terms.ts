// Agency commercial terms (HR Lead) and the agency's own view of them, plus the agency's optional
// sub-recruiters. Terms are versioned: a change adds a version and never edits an old one.
import type { FastifyInstance } from 'fastify';
import { inviteLinkToCopy } from '../mailer.js';
import { z } from 'zod';
import { principal } from '../app.js';
import { audit } from '../audit.js';
import { pgConstraint, pgErrorCode, withTenant, type Tx } from '../db.js';
import { AppError, forbidden, notFound } from '../errors.js';
import { termsEffectiveOn } from '../agency-terms.js';
import { can, requirePermission, type Principal } from '../permissions.js';
import { randomToken, sha256Hex } from '../security.js';
import { revokeUserSessions } from '../services/sessions.js';
import { idParams } from './common.js';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.');
const TermsBody = z
  .object({
    payment_model: z.enum(['payroll_management', 'one_time_fee']),
    fee_type: z.enum(['percent_of_ctc', 'fixed']),
    fee_value: z.number().min(0).max(1_000_000_000),
    lockin_days: z.number().int().min(0).max(3650).nullable().default(null),
    replacement_days: z.number().int().min(0).max(3650).nullable().default(null),
    effective_from: isoDate,
    agreement_ref: z.string().trim().max(200).nullable().default(null),
    notes: z.string().trim().max(4000).nullable().default(null),
    is_active: z.boolean().default(true),
  })
  .refine((b) => b.fee_type !== 'percent_of_ctc' || b.fee_value <= 100, { path: ['fee_value'], message: 'A percentage cannot be more than 100.' });

const COLS = ['id', 'agency_id', 'version', 'payment_model', 'fee_type', 'fee_value', 'lockin_days', 'replacement_days', 'effective_from', 'agreement_ref', 'notes', 'is_active', 'created_at'] as const;

async function history(tx: Tx, agencyId: string) {
  return tx.selectFrom('agency_terms').select([...COLS]).where('agency_id', '=', agencyId).orderBy('version', 'desc').execute();
}
const today = () => new Date().toISOString().slice(0, 10);

async function agencyOf(tx: Tx, p: Principal) {
  requirePermission(p, 'agency_portal.use');
  const m = await tx.selectFrom('agency_members as m').innerJoin('agencies as a', 'a.id', 'm.agency_id').select(['m.agency_id', 'm.agency_role', 'a.name', 'a.status']).where('m.user_id', '=', p.userId).executeTakeFirst();
  if (!m) throw forbidden();
  if (m.status !== 'active') throw new AppError(403, 'AGENCY_INACTIVE', 'Your agency account is not active. Contact the hiring team.');
  return m;
}

export async function agencyTermsRoutes(app: FastifyInstance) {
  const { db, config } = app;

  app.get('/agencies/:id/terms', async (req) => {
    const p = principal(req);
    requirePermission(p, 'agencies.manage');
    const { id } = idParams.parse(req.params);
    return withTenant(db, p.tenantId, async (tx) => {
      if (!(await tx.selectFrom('agencies').select('id').where('id', '=', id).executeTakeFirst())) throw notFound('Agency');
      return { data: { current: await termsEffectiveOn(tx, id, today()), history: await history(tx, id) } };
    });
  });

  app.post('/agencies/:id/terms', async (req, reply) => {
    const p = principal(req);
    if (!can(p, 'agency_terms.manage')) throw forbidden();
    const { id } = idParams.parse(req.params);
    const body = TermsBody.parse(req.body);
    return withTenant(db, p.tenantId, async (tx) => {
      const agency = await tx.selectFrom('agencies').select('id').where('id', '=', id).forUpdate().executeTakeFirst();
      if (!agency) throw notFound('Agency');
      const last = await tx.selectFrom('agency_terms').select('version').where('agency_id', '=', id).orderBy('version', 'desc').limit(1).executeTakeFirst();
      const row = await tx
        .insertInto('agency_terms')
        .values({ tenant_id: p.tenantId, agency_id: id, version: (last?.version ?? 0) + 1, ...body, created_by: p.userId })
        .returning([...COLS])
        .executeTakeFirstOrThrow()
        .catch((err: unknown) => {
          if (pgErrorCode(err) === '23505' && pgConstraint(err)?.includes('agency_id')) throw new AppError(409, 'CONFLICT', 'Someone else just changed these terms. Reload and try again.');
          throw err;
        });
      await audit(tx, req, { tenantId: p.tenantId, actorUserId: p.userId, action: 'agency_terms.changed', entityType: 'agency', entityId: id, metadata: { version: row.version, payment_model: body.payment_model, fee_type: body.fee_type, fee_value: body.fee_value, effective_from: body.effective_from, is_active: body.is_active } });
      return reply.status(201).send({ data: row });
    });
  });

  // ---- The agency's own view: its terms, read-only ----
  app.get('/agency/terms', async (req) => {
    const p = principal(req);
    return withTenant(db, p.tenantId, async (tx) => {
      const a = await agencyOf(tx, p);
      return { data: { agency: a.name, current: await termsEffectiveOn(tx, a.agency_id, today()), history: await history(tx, a.agency_id), example_fee: null as number | null } };
    });
  });

  // ---- The agency's optional sub-recruiters. Only the agency admin manages them. ----
  const adminOf = async (tx: Tx, p: Principal) => {
    const a = await agencyOf(tx, p);
    if (a.agency_role !== 'admin') throw forbidden();
    return a;
  };

  app.get('/agency/team', async (req) => {
    const p = principal(req);
    return withTenant(db, p.tenantId, async (tx) => {
      const a = await adminOf(tx, p);
      const members = await tx.selectFrom('agency_members as m').innerJoin('users as u', 'u.id', 'm.user_id')
        .select(['u.id as user_id', 'u.full_name', 'u.email', 'u.status', 'm.agency_role']).where('m.agency_id', '=', a.agency_id).orderBy('u.full_name').execute();
      const invitations = await tx.selectFrom('user_invitations').select(['id', 'email', 'expires_at']).where('agency_id', '=', a.agency_id).where('accepted_at', 'is', null).where('revoked_at', 'is', null).orderBy('created_at', 'desc').execute();
      return { data: { members, invitations: invitations.map((i) => ({ ...i, expired: i.expires_at <= new Date() })) } };
    });
  });

  app.post('/agency/team/invitations', async (req, reply) => {
    const p = principal(req);
    const body = z.object({ email: z.email().trim().toLowerCase() }).parse(req.body);
    const sent = await withTenant(db, p.tenantId, async (tx) => {
      const a = await adminOf(tx, p);
      if (await tx.selectFrom('users').select('id').where('email', '=', body.email).executeTakeFirst()) throw new AppError(409, 'USER_EXISTS', 'A user with this email already exists.');
      const role = await tx.selectFrom('roles').select(['id', 'name']).where('code', '=', 'agency_recruiter').where('tenant_id', 'is', null).executeTakeFirstOrThrow();
      const token = randomToken();
      const expiresAt = new Date(Date.now() + config.INVITATION_TTL_HOURS * 3600_000);
      const inv = await tx.insertInto('user_invitations')
        .values({ tenant_id: p.tenantId, email: body.email, role_id: role.id, department_id: null, agency_id: a.agency_id, token_hash: sha256Hex(token), expires_at: expiresAt, invited_by: p.userId })
        .returning(['id', 'email', 'expires_at']).executeTakeFirstOrThrow()
        .catch((err: unknown) => {
          if (pgErrorCode(err) === '23505') throw new AppError(409, 'INVITATION_PENDING', 'This email already has a pending invitation.');
          throw err;
        });
      await audit(tx, req, { tenantId: p.tenantId, actorUserId: p.userId, action: 'agency.member_invited', entityType: 'agency', entityId: a.agency_id, metadata: { invitation_id: inv.id, email: body.email, agency_role: 'recruiter', by: 'agency_admin' } });
      return { inv, token, roleName: role.name };
    });
    await app.mailer.sendInvitation({ to: sent.inv.email, companyName: p.tenantName, inviterName: p.fullName, roleName: sent.roleName, link: `${config.WEB_ORIGIN}/invite#${sent.token}`, expiresAt: sent.inv.expires_at });
    return reply.status(201).send({ data: { ...sent.inv, invite_link: inviteLinkToCopy(config, sent.token) } });
  });

  app.patch('/agency/team/:id', async (req) => {
    const p = principal(req);
    const { id } = idParams.parse(req.params);
    const { status } = z.object({ status: z.enum(['active', 'inactive']) }).parse(req.body);
    return withTenant(db, p.tenantId, async (tx) => {
      const a = await adminOf(tx, p);
      const m = await tx.selectFrom('agency_members').select(['user_id', 'agency_role']).where('agency_id', '=', a.agency_id).where('user_id', '=', id).forUpdate().executeTakeFirst();
      if (!m) throw notFound('Team member');
      if (m.agency_role !== 'recruiter') throw new AppError(409, 'NOT_ALLOWED', 'Only sub-recruiters can be changed here.');
      await tx.updateTable('users').set({ status }).where('id', '=', id).execute();
      if (status === 'inactive') await revokeUserSessions(tx, id);
      await audit(tx, req, { tenantId: p.tenantId, actorUserId: p.userId, action: 'agency.member_updated', entityType: 'agency', entityId: a.agency_id, metadata: { user_id: id, status, by: 'agency_admin' } });
      return { data: { user_id: id, status } };
    });
  });
}

