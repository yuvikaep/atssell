import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { z } from 'zod';
import { principal } from '../app.js';
import { audit } from '../audit.js';
import { withTenant } from '../db.js';
import { AppError } from '../errors.js';
import { resumeLimit } from '../limits.js';
import { hashPassword, verifyPassword } from '../security.js';
import { passwordSchema } from './common.js';

const ChangePasswordBody = z.object({ current_password: z.string().min(1, 'Enter your current password.').max(200), new_password: passwordSchema });

export async function meRoutes(app: FastifyInstance) {
  app.get('/me', async (req) => {
    const p = principal(req);
    const settings = await withTenant(app.db, p.tenantId, (tx) => tx.selectFrom('tenant_settings').select('resume_max_bytes').executeTakeFirst());
    return {
      data: {
        limits: { resume_max_bytes: resumeLimit(settings?.resume_max_bytes) },
        user: { id: p.userId, email: p.email, full_name: p.fullName },
        tenant: { id: p.tenantId, name: p.tenantName, slug: p.tenantSlug },
        roles: p.roles.map((r) => ({ code: r.code, name: r.name, department_id: r.departmentId })),
        permissions: p.permissions,
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
      await tx.updateTable('users').set({ password_hash: newHash }).where('id', '=', p.userId).execute();
      await tx.updateTable('sessions').set({ revoked_at: sql`now()` }).where('user_id', '=', p.userId).where('id', '<>', p.sessionId).where('revoked_at', 'is', null).execute();
      await audit(tx, req, { tenantId: p.tenantId, actorUserId: p.userId, action: 'auth.password_changed', entityType: 'user', entityId: p.userId });
    });
    return { data: { status: 'password_changed' } };
  });
}
