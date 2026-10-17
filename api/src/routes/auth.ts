import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { z } from 'zod';
import { audit } from '../audit.js';
import { setTenant, setTokenHash, withTenant } from '../db.js';
import { AppError } from '../errors.js';
import { getDummyHash, hashPassword, randomToken, sha256Hex, verifyPassword } from '../security.js';
import { createSession, revokeUserSessions, SESSION_COOKIE } from '../services/sessions.js';
import {
  clearSessionCookie,
  passwordSchema,
  publicRateLimit,
  requestIpHash,
  setSessionCookie,
  tokenSchema,
} from './common.js';

const companySchema = z.string().trim().toLowerCase().min(2).max(63);

const LoginBody = z.object({
  company: companySchema,
  email: z.email().trim(),
  password: z.string().min(1).max(256),
});

const ResetRequestBody = z.object({ company: companySchema, email: z.email().trim() });
const ResetConfirmBody = z.object({ token: tokenSchema, password: passwordSchema });

const invalidCredentials = () =>
  new AppError(401, 'INVALID_CREDENTIALS', 'Company, email or password is incorrect.');
const invalidLink = () => new AppError(410, 'LINK_INVALID', 'This link is invalid or has expired.');

export async function authRoutes(app: FastifyInstance) {
  const { db, config } = app;

  async function findActiveTenant(slug: string) {
    return db
      .selectFrom('tenants')
      .select(['id', 'name'])
      .where('slug', '=', slug)
      .where('status', '=', 'active')
      .executeTakeFirst();
  }

  app.post('/auth/login', { config: publicRateLimit(10) }, async (req, reply) => {
    const body = LoginBody.parse(req.body);
    const tenant = await findActiveTenant(body.company);
    if (!tenant) {
      await verifyPassword(body.password, await getDummyHash());
      throw invalidCredentials();
    }

    const result = await withTenant(db, tenant.id, async (tx) => {
      const user = await tx
        .selectFrom('users')
        .select(['id', 'full_name', 'status', 'password_hash'])
        .where('email', '=', body.email)
        .executeTakeFirst();

      const valid = await verifyPassword(body.password, user?.password_hash ?? (await getDummyHash()));
      if (!user || !user.password_hash || !valid) {
        await audit(tx, req, {
          tenantId: tenant.id,
          actorUserId: user?.id ?? null,
          actorType: user ? 'user' : 'system',
          action: 'auth.login_failed',
          entityType: 'user',
          entityId: user?.id ?? null,
        });
        return { ok: false as const, error: invalidCredentials() };
      }
      if (user.status !== 'active') {
        return {
          ok: false as const,
          error: new AppError(403, 'ACCOUNT_DISABLED', 'Your account is disabled. Contact your company admin.'),
        };
      }

      const session = await createSession(tx, {
        tenantId: tenant.id,
        userId: user.id,
        ttlHours: config.SESSION_TTL_HOURS,
        ipHash: requestIpHash(req),
        userAgent: req.headers['user-agent'],
      });
      await tx.updateTable('users').set({ last_login_at: sql`now()` }).where('id', '=', user.id).execute();
      await audit(tx, req, {
        tenantId: tenant.id,
        actorUserId: user.id,
        action: 'auth.login',
        entityType: 'user',
        entityId: user.id,
      });
      return { ok: true as const, session, user };
    });

    if (!result.ok) throw result.error;
    setSessionCookie(reply, config, result.session.token, result.session.expiresAt);
    return { data: { user: { id: result.user.id, full_name: result.user.full_name } } };
  });

  app.post('/auth/logout', async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) {
      const tokenHash = sha256Hex(token);
      await db.transaction().execute(async (tx) => {
        await setTokenHash(tx, 'app.session_token_hash', tokenHash);
        const session = await tx
          .selectFrom('sessions')
          .select(['id', 'tenant_id', 'user_id'])
          .where('token_hash', '=', tokenHash)
          .where('revoked_at', 'is', null)
          .executeTakeFirst();
        if (!session) return;
        await setTenant(tx, session.tenant_id);
        await tx.updateTable('sessions').set({ revoked_at: sql`now()` }).where('id', '=', session.id).execute();
        await audit(tx, req, {
          tenantId: session.tenant_id,
          actorUserId: session.user_id,
          action: 'auth.logout',
          entityType: 'user',
          entityId: session.user_id,
        });
      });
    }
    clearSessionCookie(reply);
    return reply.status(204).send();
  });

  // Always answers 202 so the response does not reveal which emails have accounts.
  app.post('/auth/password-reset/request', { config: publicRateLimit(5) }, async (req, reply) => {
    const body = ResetRequestBody.parse(req.body);
    const tenant = await findActiveTenant(body.company);
    if (tenant) {
      const sent = await withTenant(db, tenant.id, async (tx) => {
        const user = await tx
          .selectFrom('users')
          .select(['id', 'email'])
          .where('email', '=', body.email)
          .where('status', '=', 'active')
          .executeTakeFirst();
        if (!user) return null;

        // Only the newest link works.
        await tx
          .updateTable('password_reset_tokens')
          .set({ used_at: sql`now()` })
          .where('user_id', '=', user.id)
          .where('used_at', 'is', null)
          .execute();
        const token = randomToken();
        const expiresAt = new Date(Date.now() + config.PASSWORD_RESET_TTL_MINUTES * 60_000);
        await tx
          .insertInto('password_reset_tokens')
          .values({ tenant_id: tenant.id, user_id: user.id, token_hash: sha256Hex(token), expires_at: expiresAt })
          .execute();
        await audit(tx, req, {
          tenantId: tenant.id,
          actorUserId: user.id,
          action: 'auth.password_reset_requested',
          entityType: 'user',
          entityId: user.id,
        });
        return { email: user.email, token, expiresAt };
      });
      if (sent) {
        await app.mailer.sendPasswordReset({
          to: sent.email,
          companyName: tenant.name,
          link: `${config.WEB_ORIGIN}/reset-password#${sent.token}`,
          expiresAt: sent.expiresAt,
        });
      }
    }
    return reply.status(202).send({ data: { status: 'accepted' } });
  });

  // Also used by a new company's first admin to set their password.
  app.post('/auth/password-reset/confirm', { config: publicRateLimit(10) }, async (req, reply) => {
    const body = ResetConfirmBody.parse(req.body);
    const tokenHash = sha256Hex(body.token);
    const passwordHash = await hashPassword(body.password);

    const session = await db.transaction().execute(async (tx) => {
      await setTokenHash(tx, 'app.reset_token_hash', tokenHash);
      const reset = await tx
        .selectFrom('password_reset_tokens')
        .select(['id', 'tenant_id', 'user_id', 'expires_at', 'used_at'])
        .where('token_hash', '=', tokenHash)
        .executeTakeFirst();
      if (!reset || reset.used_at || reset.expires_at <= new Date()) throw invalidLink();

      await setTenant(tx, reset.tenant_id);
      // Lock and re-check so two concurrent confirms cannot both use the token.
      const locked = await tx
        .selectFrom('password_reset_tokens')
        .select('used_at')
        .where('id', '=', reset.id)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (locked.used_at) throw invalidLink();

      const user = await tx
        .selectFrom('users')
        .innerJoin('tenants', 'tenants.id', 'users.tenant_id')
        .select(['users.id', 'users.status', 'tenants.status as tenant_status'])
        .where('users.id', '=', reset.user_id)
        .executeTakeFirst();
      if (!user || user.status !== 'active' || user.tenant_status !== 'active') throw invalidLink();

      await tx.updateTable('password_reset_tokens').set({ used_at: sql`now()` }).where('id', '=', reset.id).execute();
      await tx.updateTable('users').set({ password_hash: passwordHash, last_login_at: sql`now()` }).where('id', '=', user.id).execute();
      await revokeUserSessions(tx, user.id);
      await audit(tx, req, {
        tenantId: reset.tenant_id,
        actorUserId: user.id,
        action: 'auth.password_reset',
        entityType: 'user',
        entityId: user.id,
      });
      return createSession(tx, {
        tenantId: reset.tenant_id,
        userId: user.id,
        ttlHours: config.SESSION_TTL_HOURS,
        ipHash: requestIpHash(req),
        userAgent: req.headers['user-agent'],
      });
    });

    setSessionCookie(reply, config, session.token, session.expiresAt);
    return { data: { status: 'password_updated' } };
  });
}
