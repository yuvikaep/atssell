import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addUser, call, createCompany, login, nextIp, PASSWORD, sessionCookie, setupApp, type TestContext } from './helpers.js';

let ctx: TestContext;
let company: Awaited<ReturnType<typeof createCompany>>;

beforeAll(async () => {
  ctx = await setupApp();
  company = await createCompany(ctx, 'auth');
});
afterAll(() => ctx.close());

const loginReq = (payload: object, remoteAddress = nextIp()) =>
  ctx.app.inject({ method: 'POST', url: '/api/v1/auth/login', remoteAddress, payload });

describe('login', () => {
  it('sets an httpOnly session cookie and /me returns the user, tenant and permissions', async () => {
    const res = await loginReq({ company: company.slug, email: company.admin.email, password: PASSWORD });
    expect(res.statusCode).toBe(200);
    const cookie = res.cookies.find((c) => c.name === 'jm_session');
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite).toBe('Lax');

    const me = await call(ctx, sessionCookie(res), 'GET', '/me');
    expect(me.statusCode).toBe(200);
    const body = me.json().data;
    expect(body.user.email).toBe(company.admin.email);
    expect(body.tenant.slug).toBe(company.slug);
    expect(body.roles.map((r: { code: string }) => r.code)).toEqual(['company_admin']);
    expect(body.permissions['users.manage']).toBe('all');
  });

  it('accepts company code and email case-insensitively', async () => {
    const res = await loginReq({ company: company.slug.toUpperCase(), email: company.admin.email.toUpperCase(), password: PASSWORD });
    expect(res.statusCode).toBe(200);
  });

  it('gives the same generic error for wrong password, unknown email and unknown company', async () => {
    const wrongPassword = await loginReq({ company: company.slug, email: company.admin.email, password: 'nope-nope-nope' });
    const unknownEmail = await loginReq({ company: company.slug, email: 'ghost@nowhere.test', password: PASSWORD });
    const unknownCompany = await loginReq({ company: 'no-such-co', email: company.admin.email, password: PASSWORD });
    for (const res of [wrongPassword, unknownEmail, unknownCompany]) {
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe('INVALID_CREDENTIALS');
      expect(res.json().error.request_id).toBeTruthy();
    }
  });

  it('records failed logins in the audit log', async () => {
    await loginReq({ company: company.slug, email: company.admin.email, password: 'wrong-password-x' });
    const events = await ctx.adminDb
      .selectFrom('audit_events')
      .select('action')
      .where('tenant_id', '=', company.tenant.id)
      .where('action', '=', 'auth.login_failed')
      .execute();
    expect(events.length).toBeGreaterThan(0);
  });

  it('tells a disabled user their account is disabled only after a correct password', async () => {
    await addUser(ctx, company.tenant.id, { email: 'disabled@auth.test', role: 'internal_recruiter', status: 'inactive' });
    const right = await loginReq({ company: company.slug, email: 'disabled@auth.test', password: PASSWORD });
    expect(right.statusCode).toBe(403);
    expect(right.json().error.code).toBe('ACCOUNT_DISABLED');
    const wrong = await loginReq({ company: company.slug, email: 'disabled@auth.test', password: 'wrong-password-x' });
    expect(wrong.statusCode).toBe(401);
  });

  it('rate limits repeated login attempts from one IP', async () => {
    const ip = '192.0.2.77';
    const statuses = [];
    for (let i = 0; i < 12; i++) {
      statuses.push((await loginReq({ company: company.slug, email: company.admin.email, password: 'wrong-password-x' }, ip)).statusCode);
    }
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
  });
});

describe('sessions', () => {
  it('rejects requests without a session', async () => {
    const res = await call(ctx, null, 'GET', '/me');
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('UNAUTHENTICATED');
  });

  it('rejects a forged session cookie', async () => {
    const res = await call(ctx, 'jm_session=forged-token-value-that-is-long-enough', 'GET', '/me');
    expect(res.statusCode).toBe(401);
  });

  it('logout revokes the session server-side', async () => {
    const cookie = await login(ctx, company.slug, company.admin.email);
    const out = await call(ctx, cookie, 'POST', '/auth/logout');
    expect(out.statusCode).toBe(204);
    expect((await call(ctx, cookie, 'GET', '/me')).statusCode).toBe(401);
  });

  it('rejects an expired session', async () => {
    const cookie = await login(ctx, company.slug, company.admin.email);
    await ctx.adminDb
      .updateTable('sessions')
      .set({ expires_at: new Date(Date.now() - 1000), created_at: new Date(Date.now() - 2000) })
      .where('user_id', '=', company.admin.id)
      .where('revoked_at', 'is', null)
      .execute();
    expect((await call(ctx, cookie, 'GET', '/me')).statusCode).toBe(401);
  });

  it('rejects state-changing requests from another origin', async () => {
    const cookie = await login(ctx, company.slug, company.admin.email);
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/departments',
      headers: { cookie, origin: 'https://evil.example' },
      payload: { name: 'Evil' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('BAD_ORIGIN');
  });

  it('sends Referrer-Policy: no-referrer and no-store', async () => {
    const res = await call(ctx, null, 'GET', '/me');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['cache-control']).toBe('no-store');
  });
});

describe('password reset', () => {
  it('always answers 202, and only emails real active users', async () => {
    const before = ctx.mailer.resets.length;
    const unknown = await ctx.app.inject({
      method: 'POST', url: '/api/v1/auth/password-reset/request', remoteAddress: nextIp(),
      payload: { company: company.slug, email: 'ghost@nowhere.test' },
    });
    expect(unknown.statusCode).toBe(202);
    expect(ctx.mailer.resets.length).toBe(before);
  });

  it('resets the password once, signs in, and revokes other sessions', async () => {
    const user = await addUser(ctx, company.tenant.id, { email: 'reset@auth.test', role: 'internal_recruiter' });
    const oldSession = await login(ctx, company.slug, 'reset@auth.test');

    await ctx.app.inject({
      method: 'POST', url: '/api/v1/auth/password-reset/request', remoteAddress: nextIp(),
      payload: { company: company.slug, email: 'reset@auth.test' },
    });
    const email = ctx.mailer.resets.at(-1)!;
    expect(email.to).toBe('reset@auth.test');
    const token = email.link.split('#')[1]!;
    expect(email.link.startsWith('http://localhost:5180/reset-password#')).toBe(true);

    const confirm = (password: string) => ctx.app.inject({
      method: 'POST', url: '/api/v1/auth/password-reset/confirm', remoteAddress: nextIp(),
      payload: { token, password },
    });
    const ok = await confirm('a-brand-new-password');
    expect(ok.statusCode).toBe(200);
    expect((await call(ctx, sessionCookie(ok), 'GET', '/me')).json().data.user.id).toBe(user.id);
    expect((await call(ctx, oldSession, 'GET', '/me')).statusCode).toBe(401);

    const reuse = await confirm('another-new-password');
    expect(reuse.statusCode).toBe(410);
    expect(reuse.json().error.code).toBe('LINK_INVALID');

    await login(ctx, company.slug, 'reset@auth.test', 'a-brand-new-password');
  });

  it('rejects passwords shorter than 12 characters', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/v1/auth/password-reset/confirm', remoteAddress: nextIp(),
      payload: { token: 'x'.repeat(43), password: 'short' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('lets a new company admin set their first password with the setup link', async () => {
    const fresh = await createCompany(ctx, 'setup');
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/v1/auth/password-reset/confirm', remoteAddress: nextIp(),
      payload: { token: fresh.setupToken, password: 'first-admin-password' },
    });
    expect(res.statusCode).toBe(200);
    await login(ctx, fresh.slug, fresh.admin.email, 'first-admin-password');
  });
});
