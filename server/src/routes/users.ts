import type { FastifyInstance } from 'fastify';
import { inviteLinkToCopy } from '../mailer.js';
import { sql } from 'kysely';
import { z } from 'zod';
import { principal } from '../app.js';
import { audit } from '../audit.js';
import { pgConstraint, pgErrorCode, withTenant, type Tx } from '../db.js';
import { AppError, notFound } from '../errors.js';
import { requirePermission } from '../permissions.js';
import { hashPassword, randomToken, sha256Hex } from '../security.js';
import { revokeUserSessions } from '../services/sessions.js';
import { createInvitedUser, findInvitation } from './invitations.js';
import { idParams, pageQuery, passwordSchema } from './common.js';

// Agency members are invited from agency management (Sprint 3), where the agency is chosen.
const AGENCY_ROLES = new Set(['agency_admin', 'agency_recruiter']);
const ADMIN_ROLE = 'company_admin';

const ListQuery = pageQuery.extend({
  status: z.enum(['active', 'inactive', 'all']).default('all'),
  q: z.string().trim().max(200).optional(),
});

const InviteBody = z.object({
  email: z.email().trim().toLowerCase(),
  role_code: z.string().min(1).max(64),
  department_id: z.uuid().nullish(),
});

const UpdateUserBody = z
  .object({
    full_name: z.string().trim().min(1).max(200),
    status: z.enum(['active', 'inactive']),
  })
  .partial()
  .refine((b) => Object.keys(b).length > 0, 'Provide at least one field to update.');

const RolesBody = z.object({
  assignments: z
    .array(z.object({ role_code: z.string().min(1).max(64), department_id: z.uuid().nullable() }))
    .min(1, 'A user needs at least one role.')
    .max(20),
});

async function findAssignableRole(tx: Tx, code: string, alreadyHeld: ReadonlySet<string> = new Set()) {
  const role = await tx.selectFrom('roles').select(['id', 'code', 'name', 'is_assignable']).where('code', '=', code).executeTakeFirst();
  if (!role) throw new AppError(422, 'INVALID_ROLE', `Role "${code}" does not exist.`);
  // Retired roles can stay with the people who already have them but cannot be given to anyone new.
  if (!role.is_assignable && !alreadyHeld.has(role.code)) throw new AppError(422, 'ROLE_RETIRED', `The ${role.name} role is no longer available. Use HR Lead, Company Recruiter, Agency or Interviewer.`);
  if (AGENCY_ROLES.has(role.code)) {
    throw new AppError(422, 'AGENCY_ROLE', 'Agency members are invited from Agency management.');
  }
  return role;
}

async function assertActiveDepartment(tx: Tx, departmentId: string) {
  const dept = await tx.selectFrom('departments').select('status').where('id', '=', departmentId).executeTakeFirst();
  if (!dept || dept.status !== 'active') {
    throw new AppError(422, 'INVALID_DEPARTMENT', 'Department was not found or is inactive.');
  }
}

/**
 * Throws if removing userId's company-wide admin role (or deactivating them) would leave the tenant
 * without an active Company Admin. Locks the admin assignment rows so two admins cannot demote each
 * other concurrently.
 */
async function assertAnotherAdminRemains(tx: Tx, userId: string) {
  const admins = await tx
    .selectFrom('user_role_assignments as ura')
    .innerJoin('roles as r', 'r.id', 'ura.role_id')
    .innerJoin('users as u', 'u.id', 'ura.user_id')
    .select(['ura.user_id'])
    .where('r.code', '=', ADMIN_ROLE)
    .where('ura.department_id', 'is', null)
    .where('u.status', '=', 'active')
    .forUpdate('ura')
    .execute();
  if (!admins.some((a) => a.user_id !== userId)) {
    throw new AppError(409, 'LAST_ADMIN', 'The company needs at least one active Company Admin.');
  }
}

async function isCompanyAdmin(tx: Tx, userId: string) {
  const row = await tx
    .selectFrom('user_role_assignments as ura')
    .innerJoin('roles as r', 'r.id', 'ura.role_id')
    .select('ura.id')
    .where('ura.user_id', '=', userId)
    .where('r.code', '=', ADMIN_ROLE)
    .where('ura.department_id', 'is', null)
    .executeTakeFirst();
  return row !== undefined;
}

async function rolesByUser(tx: Tx, userIds: string[]) {
  if (userIds.length === 0) return new Map<string, { code: string; name: string; department_id: string | null; department_name: string | null }[]>();
  const rows = await tx
    .selectFrom('user_role_assignments as ura')
    .innerJoin('roles as r', 'r.id', 'ura.role_id')
    .leftJoin('departments as d', 'd.id', 'ura.department_id')
    .select(['ura.user_id', 'r.code', 'r.name', 'ura.department_id', 'd.name as department_name'])
    .where('ura.user_id', 'in', userIds)
    .orderBy('r.name')
    .execute();
  const map = new Map<string, { code: string; name: string; department_id: string | null; department_name: string | null }[]>();
  for (const { user_id, ...role } of rows) {
    map.set(user_id, [...(map.get(user_id) ?? []), role]);
  }
  return map;
}

async function getUser(tx: Tx, id: string) {
  const user = await tx
    .selectFrom('users')
    .select(['id', 'email', 'full_name', 'status', 'last_login_at', 'created_at'])
    .where('id', '=', id)
    .executeTakeFirst();
  if (!user) throw notFound('User');
  const roles = await rolesByUser(tx, [id]);
  return { ...user, roles: roles.get(id) ?? [] };
}

export async function userRoutes(app: FastifyInstance) {
  const { db, config } = app;

  app.get('/roles', async (req) => {
    const p = principal(req);
    requirePermission(p, 'users.manage');
    const rows = await withTenant(db, p.tenantId, async (tx) => {
      const roles = await tx
        .selectFrom('roles')
        .select(['id', 'code', 'name', 'is_system_role'])
        .where('is_assignable', '=', true)
        .orderBy('name')
        .execute();
      const perms = await tx
        .selectFrom('role_permissions')
        .select(['role_id', 'permission_code'])
        .where('role_id', 'in', roles.map((r) => r.id))
        .execute();
      return roles.map((r) => ({
        code: r.code,
        name: r.name,
        is_system_role: r.is_system_role,
        invitable: !AGENCY_ROLES.has(r.code),
        permissions: perms.filter((x) => x.role_id === r.id).map((x) => x.permission_code).sort(),
      }));
    });
    return { data: rows };
  });

  app.get('/users', async (req) => {
    const p = principal(req);
    requirePermission(p, 'users.manage');
    const { page, page_size, status, q } = ListQuery.parse(req.query);

    return withTenant(db, p.tenantId, async (tx) => {
      let base = tx.selectFrom('users');
      if (status !== 'all') base = base.where('status', '=', status);
      if (q) {
        const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
        base = base.where((eb) => eb.or([eb('full_name', 'ilike', like), eb('email', 'ilike', like)]));
      }
      const { total } = await base.select(sql<number>`count(*)::int`.as('total')).executeTakeFirstOrThrow();
      const users = await base
        .select(['id', 'email', 'full_name', 'status', 'last_login_at', 'created_at'])
        .orderBy('full_name')
        .limit(page_size)
        .offset((page - 1) * page_size)
        .execute();
      const roles = await rolesByUser(tx, users.map((u) => u.id));
      return {
        data: users.map((u) => ({ ...u, roles: roles.get(u.id) ?? [] })),
        page,
        page_size,
        total,
      };
    });
  });

  app.patch('/users/:id', async (req) => {
    const p = principal(req);
    requirePermission(p, 'users.manage');
    const { id } = idParams.parse(req.params);
    const body = UpdateUserBody.parse(req.body);

    const user = await withTenant(db, p.tenantId, async (tx) => {
      const current = await tx.selectFrom('users').select(['id', 'status', 'full_name']).where('id', '=', id).forUpdate().executeTakeFirst();
      if (!current) throw notFound('User');

      if (body.status === 'inactive' && current.status === 'active') {
        if (id === p.userId) throw new AppError(409, 'CANNOT_DEACTIVATE_SELF', 'You cannot deactivate your own account.');
        if (await isCompanyAdmin(tx, id)) await assertAnotherAdminRemains(tx, id);
        await revokeUserSessions(tx, id);
      }

      await tx.updateTable('users').set(body).where('id', '=', id).execute();
      await audit(tx, req, {
        tenantId: p.tenantId,
        actorUserId: p.userId,
        action: body.status && body.status !== current.status ? `user.${body.status === 'active' ? 'reactivated' : 'deactivated'}` : 'user.updated',
        entityType: 'user',
        entityId: id,
        metadata: { changes: body },
      });
      return getUser(tx, id);
    });
    return { data: user };
  });

  // Replaces the user's full set of role assignments.
  app.put('/users/:id/roles', async (req) => {
    const p = principal(req);
    requirePermission(p, 'users.manage');
    const { id } = idParams.parse(req.params);
    const { assignments } = RolesBody.parse(req.body);

    const user = await withTenant(db, p.tenantId, async (tx) => {
      const target = await tx.selectFrom('users').select('id').where('id', '=', id).forUpdate().executeTakeFirst();
      if (!target) throw notFound('User');
      // Agency members keep their agency role; moving one to an internal role would hand them
      // internal access while still counted as agency staff.
      const member = await tx.selectFrom('agency_members').select('id').where('user_id', '=', id).executeTakeFirst();
      if (member) throw new AppError(422, 'AGENCY_USER', 'Agency members are managed from the agency page.');

      const held = new Set((await tx.selectFrom('user_role_assignments as ura').innerJoin('roles as r', 'r.id', 'ura.role_id').select('r.code').where('ura.user_id', '=', id).execute()).map((r) => r.code));
      const resolved = [];
      for (const a of assignments) {
        const role = await findAssignableRole(tx, a.role_code, held);
        if (a.department_id) await assertActiveDepartment(tx, a.department_id);
        resolved.push({ role, department_id: a.department_id });
      }
      const keys = resolved.map((r) => `${r.role.id}:${r.department_id ?? ''}`);
      if (new Set(keys).size !== keys.length) {
        throw new AppError(422, 'DUPLICATE_ASSIGNMENT', 'The same role and department appear more than once.');
      }

      const keepsAdmin = resolved.some((r) => r.role.code === ADMIN_ROLE && r.department_id === null);
      if (!keepsAdmin && (await isCompanyAdmin(tx, id))) await assertAnotherAdminRemains(tx, id);

      const before = await rolesByUser(tx, [id]);
      await tx.deleteFrom('user_role_assignments').where('user_id', '=', id).execute();
      await tx
        .insertInto('user_role_assignments')
        .values(resolved.map((r) => ({
          tenant_id: p.tenantId,
          user_id: id,
          role_id: r.role.id,
          department_id: r.department_id,
          assigned_by: p.userId,
        })))
        .execute();
      await audit(tx, req, {
        tenantId: p.tenantId,
        actorUserId: p.userId,
        action: 'user.roles_changed',
        entityType: 'user',
        entityId: id,
        metadata: {
          before: (before.get(id) ?? []).map((r) => ({ role: r.code, department_id: r.department_id })),
          after: resolved.map((r) => ({ role: r.role.code, department_id: r.department_id })),
        },
      });
      return getUser(tx, id);
    });
    return { data: user };
  });

  // ---- Invitations --------------------------------------------------------

  app.get('/users/invitations', async (req) => {
    const p = principal(req);
    requirePermission(p, 'users.manage');
    const rows = await withTenant(db, p.tenantId, (tx) =>
      tx
        .selectFrom('user_invitations as i')
        .innerJoin('roles as r', 'r.id', 'i.role_id')
        .leftJoin('departments as d', 'd.id', 'i.department_id')
        .leftJoin('agencies as ag', 'ag.id', 'i.agency_id')
        .innerJoin('users as inviter', 'inviter.id', 'i.invited_by')
        .select([
          'i.id', 'i.email', 'i.expires_at', 'i.created_at', 'r.code as role_code', 'r.name as role_name',
          'i.department_id', 'd.name as department_name', 'ag.name as agency_name', 'inviter.full_name as invited_by_name',
        ])
        .where('i.accepted_at', 'is', null)
        .where('i.revoked_at', 'is', null)
        .orderBy('i.created_at', 'desc')
        .execute(),
    );
    const now = new Date();
    return { data: rows.map((r) => ({ ...r, expired: r.expires_at <= now })) };
  });

  async function issueInvitation(
    tx: Tx,
    p: ReturnType<typeof principal>,
    input: { email: string; roleId: string; departmentId: string | null; agencyId?: string | null },
  ) {
    const token = randomToken();
    const expiresAt = new Date(Date.now() + config.INVITATION_TTL_HOURS * 3600_000);
    const inv = await tx
      .insertInto('user_invitations')
      .values({
        tenant_id: p.tenantId,
        email: input.email,
        role_id: input.roleId,
        department_id: input.departmentId,
        agency_id: input.agencyId ?? null,
        token_hash: sha256Hex(token),
        expires_at: expiresAt,
        invited_by: p.userId,
      })
      .returning(['id', 'email', 'expires_at'])
      .executeTakeFirstOrThrow()
      .catch((err: unknown) => {
        if (pgErrorCode(err) === '23505' && pgConstraint(err) === 'uq_user_invitations_open') {
          throw new AppError(409, 'INVITATION_PENDING', 'This email already has a pending invitation. Resend it instead.');
        }
        throw err;
      });
    return { inv, token };
  }

  async function sendInvitationEmail(p: ReturnType<typeof principal>, email: string, roleName: string, token: string, expiresAt: Date) {
    await app.mailer.sendInvitation({
      to: email,
      companyName: p.tenantName,
      inviterName: p.fullName,
      roleName,
      link: `${config.WEB_ORIGIN}/invite#${token}`,
      expiresAt,
    });
    return inviteLinkToCopy(config, token);
  }

  app.post('/users/invitations', async (req, reply) => {
    const p = principal(req);
    requirePermission(p, 'users.manage');
    const body = InviteBody.parse(req.body);

    const result = await withTenant(db, p.tenantId, async (tx) => {
      const role = await findAssignableRole(tx, body.role_code);
      if (body.department_id) await assertActiveDepartment(tx, body.department_id);
      const existing = await tx.selectFrom('users').select('id').where('email', '=', body.email).executeTakeFirst();
      if (existing) throw new AppError(409, 'USER_EXISTS', 'A user with this email already exists.');

      const { inv, token } = await issueInvitation(tx, p, {
        email: body.email,
        roleId: role.id,
        departmentId: body.department_id ?? null,
      });
      await audit(tx, req, {
        tenantId: p.tenantId,
        actorUserId: p.userId,
        action: 'user.invited',
        entityType: 'user_invitation',
        entityId: inv.id,
        metadata: { email: body.email, role: role.code, department_id: body.department_id ?? null },
      });
      return { inv, token, roleName: role.name };
    });

    // Sent after commit. If sending fails the invitation still exists and can be resent.
    const invite_link = await sendInvitationEmail(p, result.inv.email, result.roleName, result.token, result.inv.expires_at);
    return reply.status(201).send({ data: { ...result.inv, invite_link } });
  });

  app.post('/users/invitations/:id/revoke', async (req, reply) => {
    const p = principal(req);
    requirePermission(p, 'users.manage');
    const { id } = idParams.parse(req.params);
    await withTenant(db, p.tenantId, async (tx) => {
      const updated = await tx
        .updateTable('user_invitations')
        .set({ revoked_at: sql`now()` })
        .where('id', '=', id)
        .where('accepted_at', 'is', null)
        .where('revoked_at', 'is', null)
        .returning('id')
        .executeTakeFirst();
      if (!updated) throw notFound('Pending invitation');
      await audit(tx, req, {
        tenantId: p.tenantId,
        actorUserId: p.userId,
        action: 'user.invitation_revoked',
        entityType: 'user_invitation',
        entityId: id,
      });
    });
    return reply.status(204).send();
  });

  // Revokes the old link and sends a new one with the same email, role and department.
  app.post('/users/invitations/:id/resend', async (req, reply) => {
    const p = principal(req);
    requirePermission(p, 'users.manage');
    const { id } = idParams.parse(req.params);

    const result = await withTenant(db, p.tenantId, async (tx) => {
      const old = await tx
        .updateTable('user_invitations')
        .set({ revoked_at: sql`now()` })
        .where('id', '=', id)
        .where('accepted_at', 'is', null)
        .where('revoked_at', 'is', null)
        .returning(['email', 'role_id', 'department_id', 'agency_id'])
        .executeTakeFirst();
      if (!old) throw notFound('Pending invitation');
      const role = await tx.selectFrom('roles').select('name').where('id', '=', old.role_id).executeTakeFirstOrThrow();
      const { inv, token } = await issueInvitation(tx, p, {
        email: old.email,
        roleId: old.role_id,
        departmentId: old.department_id,
        agencyId: old.agency_id,
      });
      await audit(tx, req, {
        tenantId: p.tenantId,
        actorUserId: p.userId,
        action: 'user.invitation_resent',
        entityType: 'user_invitation',
        entityId: inv.id,
        metadata: { replaces: id },
      });
      return { inv, token, roleName: role.name };
    });

    const invite_link = await sendInvitationEmail(p, result.inv.email, result.roleName, result.token, result.inv.expires_at);
    return reply.status(201).send({ data: { ...result.inv, invite_link } });
  });

  // While email is off: the admin sets a first password for an invited person and passes it on.
  // They can change it after signing in (Profile → Change password).
  app.post('/users/invitations/:id/create-login', async (req, reply) => {
    const p = principal(req);
    requirePermission(p, 'users.manage');
    const { id } = idParams.parse(req.params);
    const body = z.object({ full_name: z.string().trim().min(1, 'Enter their name.').max(200), password: passwordSchema }).parse(req.body);
    const passwordHash = await hashPassword(body.password);
    const user = await withTenant(db, p.tenantId, async (tx) => {
      const inv = await findInvitation(tx, { id }, true);
      return createInvitedUser(tx, req, inv, body.full_name, passwordHash, p.userId);
    });
    return reply.status(201).send({ data: { user_id: user.id, company: p.tenantSlug } });
  });
}
