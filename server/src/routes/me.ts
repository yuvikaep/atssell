import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { z } from 'zod';
import { principal } from '../app.js';
import { audit } from '../audit.js';
import { withTenant } from '../db.js';
import { AppError } from '../errors.js';
import { resumeLimit } from '../limits.js';
import { getDummyHash, hashPassword, verifyPassword } from '../security.js';
import { createSession } from '../services/sessions.js';
import { passwordSchema, requestIpHash, setSessionCookie } from './common.js';

const ChangePasswordBody = z.object({ current_password: z.string().min(1, 'Enter your current password.').max(200), new_password: passwordSchema });

export async function meRoutes(app: FastifyInstance) {
  app.get('/me', async (req) => {
    const p = principal(req);
    const [settings, heads] = await withTenant(app.db, p.tenantId, (tx) => Promise.all([
      tx.selectFrom('tenant_settings').select('resume_max_bytes').executeTakeFirst(),
      tx.selectFrom('departments').select('id').where('head_user_id', '=', p.userId).where('status', '=', 'active').execute(),
    ]));
    return {
      data: {
        limits: { resume_max_bytes: resumeLimit(settings?.resume_max_bytes) },
        user: { id: p.userId, email: p.email, full_name: p.fullName, must_change_password: p.mustChangePassword },
        tenant: { id: p.tenantId, name: p.tenantName, slug: p.tenantSlug },
        roles: p.roles.map((r) => ({ code: r.code, name: r.name, department_id: r.departmentId })),
        permissions: p.permissions,
        // Department heads see their department's employees and can mark exits.
        head_of_departments: heads.map((d) => d.id),
      },
    };
  });

  // Anyone signed in can change their own password. Their other sessions end; this one stays.
  app.post('/me/password', { config: { rateLimit: { max: 8, timeWindow: '1 minute', keyGenerator: (r) => r.principal?.userId ?? r.ip } } }, async (req) => {
    const p = principal(req);
    const body = ChangePasswordBody.parse(req.body);
    const invalid = (path: string, message: string) => new AppError(400, 'VALIDATION_ERROR', 'Some fields are invalid.', [{ path, message }]);
    if (body.new_password === body.current_password) throw invalid('new_password', 'Choose a password different from your current one.');
    const newHash = await hashPassword(body.new_password);
    const stored = await withTenant(app.db, p.tenantId, (tx) => tx.selectFrom('users').select('password_hash').where('id', '=', p.userId).executeTakeFirst());
    if (!stored?.password_hash || !(await verifyPassword(body.current_password, stored.password_hash))) {
      // Recorded in its own transaction so the failed attempt is kept even though the request fails.
      await withTenant(app.db, p.tenantId, (tx) => audit(tx, req, { tenantId: p.tenantId, actorUserId: p.userId, action: 'auth.password_change_failed', entityType: 'user', entityId: p.userId }));
      throw invalid('current_password', 'Your current password is not correct.');
    }
    await withTenant(app.db, p.tenantId, async (tx) => {
      await tx.updateTable('users').set({ password_hash: newHash, must_change_password: false }).where('id', '=', p.userId).execute();
      await tx.updateTable('sessions').set({ revoked_at: sql`now()` }).where('user_id', '=', p.userId).where('id', '<>', p.sessionId).where('revoked_at', 'is', null).execute();
      await audit(tx, req, { tenantId: p.tenantId, actorUserId: p.userId, action: 'auth.password_changed', entityType: 'user', entityId: p.userId });
    });
    return { data: { status: 'password_changed' } };
  });

  // Agency people often work for several companies with the same email. Switch to another of them
  // without signing out. The password is asked again, so an admin of one company who created an
  // account with someone's email can never step into that person's account elsewhere.
  app.post('/me/switch-company', { config: { rateLimit: { max: 10, timeWindow: '1 minute', keyGenerator: (r) => r.principal?.userId ?? r.ip } } }, async (req, reply) => {
    const p = principal(req);
    const body = z.object({ password: z.string().min(1, 'Enter your password.').max(256), company: z.string().trim().toLowerCase().max(63).optional() }).parse(req.body);
    const accounts = await app.db.transaction().execute(async (tx) => {
      await sql`SELECT set_config('app.login_email', ${p.email}, true)`.execute(tx);
      return tx.selectFrom('users as u').innerJoin('tenants as t', 't.id', 'u.tenant_id')
        .select(['u.id', 'u.status', 'u.password_hash', 't.id as tenant_id', 't.slug', 't.name'])
        .where('u.email', '=', p.email).where('t.status', '=', 'active').where('t.id', '<>', p.tenantId).execute();
    });
    const matched = [];
    for (const a of accounts) if (a.status === 'active' && a.password_hash && (await verifyPassword(body.password, a.password_hash))) matched.push(a);
    if (accounts.length === 0) await verifyPassword(body.password, await getDummyHash());
    const pick = body.company ? matched.filter((a) => a.slug === body.company) : matched;
    if (pick.length === 0) throw new AppError(401, 'NO_OTHER_COMPANY', 'No other company has an account with this email and password.');
    if (pick.length > 1) throw new AppError(409, 'CHOOSE_COMPANY', 'Choose the company to switch to.', pick.map((a) => ({ slug: a.slug, name: a.name })));
    const target = pick[0]!;
    const session = await withTenant(app.db, target.tenant_id, async (tx) => {
      const s = await createSession(tx, { tenantId: target.tenant_id, userId: target.id, ttlHours: app.config.SESSION_TTL_HOURS, ipHash: requestIpHash(req), userAgent: req.headers['user-agent'] });
      await tx.updateTable('users').set({ last_login_at: sql`now()` }).where('id', '=', target.id).execute();
      await audit(tx, req, { tenantId: target.tenant_id, actorUserId: target.id, action: 'auth.company_switched_in', entityType: 'user', entityId: target.id });
      return s;
    });
    // The session in the company being left ends.
    await withTenant(app.db, p.tenantId, async (tx) => {
      await tx.updateTable('sessions').set({ revoked_at: sql`now()` }).where('id', '=', p.sessionId).execute();
      await audit(tx, req, { tenantId: p.tenantId, actorUserId: p.userId, action: 'auth.company_switched_out', entityType: 'user', entityId: p.userId, metadata: { to: target.slug } });
    });
    setSessionCookie(reply, app.config, session.token, session.expiresAt);
    return { data: { company: { slug: target.slug, name: target.name } } };
  });
}
