import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDepartment, call, createCompany, login, nextIp, sessionCookie, setupApp, type TestContext } from './helpers.js';

let ctx: TestContext;
let co: Awaited<ReturnType<typeof createCompany>>;
let cookie: string;
let sales: { id: string };

beforeAll(async () => {
  ctx = await setupApp();
  co = await createCompany(ctx, 'inv');
  sales = await addDepartment(ctx, co.tenant.id, 'Sales');
  cookie = await login(ctx, co.slug, co.admin.email);
});
afterAll(() => ctx.close());

const publicPost = (url: string, payload: object) =>
  ctx.app.inject({ method: 'POST', url: `/api/v1${url}`, remoteAddress: nextIp(), payload });

async function invite(email: string, role_code = 'internal_recruiter', department_id: string | null = sales.id) {
  const res = await call(ctx, cookie, 'POST', '/users/invitations', { email, role_code, department_id });
  return { res, token: ctx.mailer.invitations.at(-1)?.link.split('#')[1] };
}

describe('invitations', () => {
  it('invites, emails a fragment link, and stores only the token hash', async () => {
    const { res, token } = await invite('new.hm@inv.test');
    expect(res.statusCode).toBe(201);
    const mail = ctx.mailer.invitations.at(-1)!;
    expect(mail.to).toBe('new.hm@inv.test');
    expect(mail.roleName).toBe('Company Recruiter');
    expect(mail.link).toMatch(/^http:\/\/localhost:5180\/invite#[A-Za-z0-9_-]{43}$/);

    const row = await ctx.adminDb.selectFrom('user_invitations').select('token_hash').where('id', '=', res.json().data.id).executeTakeFirstOrThrow();
    expect(row.token_hash).not.toContain(token);
    expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('lookup shows the company and role; accept creates the user with that role and signs them in', async () => {
    const { token } = await invite('accept.me@inv.test');
    const lookup = await publicPost('/invitations/lookup', { token });
    expect(lookup.statusCode).toBe(200);
    expect(lookup.json().data).toMatchObject({ email: 'accept.me@inv.test', company_name: co.tenant.name, role_name: 'Company Recruiter' });

    const accept = await publicPost('/invitations/accept', { token, full_name: 'Accepted Person', password: 'a-good-long-password' });
    expect(accept.statusCode).toBe(201);
    const me = (await call(ctx, sessionCookie(accept), 'GET', '/me')).json().data;
    expect(me.user.full_name).toBe('Accepted Person');
    expect(me.roles).toEqual([{ code: 'internal_recruiter', name: 'Company Recruiter', department_id: sales.id }]);

    const again = await publicPost('/invitations/accept', { token, full_name: 'Twice', password: 'a-good-long-password' });
    expect(again.statusCode).toBe(410);
    expect(again.json().error.code).toBe('INVITATION_INVALID');
  });

  it('concurrent accepts of one invitation create exactly one user', async () => {
    const { token } = await invite('race@inv.test');
    const results = await Promise.all(
      Array.from({ length: 5 }, () => publicPost('/invitations/accept', { token, full_name: 'Racer', password: 'a-good-long-password' })),
    );
    expect(results.filter((r) => r.statusCode === 201)).toHaveLength(1);
    const users = await ctx.adminDb.selectFrom('users').select('id').where('email', '=', 'race@inv.test').execute();
    expect(users).toHaveLength(1);
  });

  it('rejects expired, revoked and unknown invitations with the same generic error', async () => {
    const expired = await invite('expired@inv.test');
    await ctx.adminDb
      .updateTable('user_invitations')
      .set({ expires_at: new Date(Date.now() - 1000), created_at: new Date(Date.now() - 2000) })
      .where('id', '=', expired.res.json().data.id)
      .execute();

    const revoked = await invite('revoked@inv.test');
    expect((await call(ctx, cookie, 'POST', `/users/invitations/${revoked.res.json().data.id}/revoke`)).statusCode).toBe(204);

    for (const token of [expired.token, revoked.token, 'unknown-token-unknown-token-unknown-token00']) {
      const res = await publicPost('/invitations/lookup', { token });
      expect(res.statusCode).toBe(410);
      expect(res.json().error.code).toBe('INVITATION_INVALID');
    }
  });

  it('resend revokes the old link and issues a new one', async () => {
    const first = await invite('resend@inv.test');
    const res = await call(ctx, cookie, 'POST', `/users/invitations/${first.res.json().data.id}/resend`);
    expect(res.statusCode).toBe(201);
    const newToken = ctx.mailer.invitations.at(-1)!.link.split('#')[1];
    expect(newToken).not.toBe(first.token);
    expect((await publicPost('/invitations/lookup', { token: first.token! })).statusCode).toBe(410);
    expect((await publicPost('/invitations/lookup', { token: newToken! })).statusCode).toBe(200);
  });

  it('refuses to invite an existing user or double-invite a pending email', async () => {
    const existing = await call(ctx, cookie, 'POST', '/users/invitations', { email: co.admin.email, role_code: 'internal_recruiter' });
    expect(existing.statusCode).toBe(409);
    expect(existing.json().error.code).toBe('USER_EXISTS');

    await invite('pending@inv.test');
    const dup = await invite('PENDING@inv.test');
    expect(dup.res.statusCode).toBe(409);
    expect(dup.res.json().error.code).toBe('INVITATION_PENDING');
  });

  it('lists pending invitations and marks expired ones', async () => {
    const list = (await call(ctx, cookie, 'GET', '/users/invitations')).json().data;
    const emails = list.map((i: { email: string }) => i.email);
    expect(emails).toContain('pending@inv.test');
    expect(emails).not.toContain('accept.me@inv.test');
    expect(emails).not.toContain('revoked@inv.test');
    expect(list.find((i: { email: string }) => i.email === 'expired@inv.test').expired).toBe(true);
  });
});

describe('invitation link to share while email is off', () => {
  it('is returned to the inviter, and only when email is not set up', async () => {
    const { res } = await invite('share.link@inv.test');
    expect(res.json().data.invite_link).toBe(ctx.mailer.invitations.at(-1)!.link);
    const { inviteLinkToCopy } = await import('../src/mailer.js');
    expect(inviteLinkToCopy({ MAIL_DRIVER: 'smtp', WEB_ORIGIN: 'https://a.test' }, 't')).toBeNull();
    expect(inviteLinkToCopy({ MAIL_DRIVER: 'off', WEB_ORIGIN: 'https://a.test' }, 't')).toBe('https://a.test/invite#t');
  });
});

describe('admin creates a login while email is off', () => {
  it('sets a first password for a pending invitation, which then signs in; other users cannot', async () => {
    const { res } = await invite('manual.login@inv.test');
    const id = res.json().data.id;
    const weak = await call(ctx, cookie, 'POST', `/users/invitations/${id}/create-login`, { full_name: 'Manual', password: 'short' });
    expect(weak.statusCode).toBe(400);
    const ok = await call(ctx, cookie, 'POST', `/users/invitations/${id}/create-login`, { full_name: 'Manual Person', password: 'first-password-123' });
    expect(ok.statusCode, ok.body).toBe(201);
    const signin = await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/login', remoteAddress: nextIp(), payload: { company: co.slug, email: 'manual.login@inv.test', password: 'first-password-123' } });
    expect(signin.statusCode).toBe(200);
    expect((await call(ctx, cookie, 'POST', `/users/invitations/${id}/create-login`, { full_name: 'Again', password: 'first-password-123' })).statusCode).toBe(410);
    const recruiterCookie = sessionCookie(signin);
    expect((await call(ctx, recruiterCookie, 'POST', '/me/password', { current_password: 'first-password-123', new_password: 'my-own-password-456' })).statusCode).toBe(200);
    const recruiter = await call(ctx, recruiterCookie, 'POST', `/users/invitations/${id}/create-login`, { full_name: 'X', password: 'first-password-123' });
    expect(recruiter.statusCode).toBe(403);
    expect(recruiter.json().error.code).toBe('FORBIDDEN');
  });

  it('makes the person choose their own password before they can do anything else', async () => {
    const { res } = await invite('forced.change@inv.test');
    const id = res.json().data.id;
    expect((await call(ctx, cookie, 'POST', `/users/invitations/${id}/create-login`, { full_name: 'Forced Change', password: 'admin-chose-this-1' })).statusCode).toBe(201);
    const them = await login(ctx, co.slug, 'forced.change@inv.test', 'admin-chose-this-1');

    const me = await call(ctx, them, 'GET', '/me');
    expect(me.statusCode).toBe(200);
    expect(me.json().data.user.must_change_password).toBe(true);
    for (const [method, url] of [['GET', '/vacancies'], ['GET', '/candidates'], ['GET', '/notifications'], ['POST', '/users/invitations']] as const) {
      const blocked = await call(ctx, them, method, url, method === 'GET' ? undefined : {});
      expect(blocked.statusCode, `${method} ${url}`).toBe(403);
      expect(blocked.json().error.code).toBe('PASSWORD_CHANGE_REQUIRED');
    }

    expect((await call(ctx, them, 'POST', '/me/password', { current_password: 'admin-chose-this-1', new_password: 'now-it-is-mine-2' })).statusCode).toBe(200);
    expect((await call(ctx, them, 'GET', '/me')).json().data.user.must_change_password).toBe(false);
    expect((await call(ctx, them, 'GET', '/vacancies')).statusCode).toBe(200);
  });

  it('does not ask people who chose their own password through an invitation link', async () => {
    const { res, token } = await invite('chose.own@inv.test');
    expect(res.statusCode).toBe(201);
    expect((await publicPost('/invitations/accept', { token, full_name: 'Chose Own', password: 'picked-it-myself-1' })).statusCode).toBe(201);
    const them = await login(ctx, co.slug, 'chose.own@inv.test', 'picked-it-myself-1');
    expect((await call(ctx, them, 'GET', '/me')).json().data.user.must_change_password).toBe(false);
  });
});
