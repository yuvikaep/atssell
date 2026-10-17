import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, login, PASSWORD, setupApp, type TestContext } from './helpers.js';
import { setupCompany } from './hiring-helpers.js';

let ctx: TestContext;
let s: Awaited<ReturnType<typeof setupCompany>>;

beforeAll(async () => {
  ctx = await setupApp();
  s = await setupCompany(ctx, 'cp');
});
afterAll(() => ctx.close());

const change = (cookie: string, body: object) => call(ctx, cookie, 'POST', '/me/password', body);

describe('changing your own password', () => {
  it('works for every kind of user, keeps this session, ends the others, and the new password signs in', async () => {
    for (const who of ['admin', 'hr1', 'recruiter', 'engManager'] as const) {
      const email = s.email(who);
      const here = await login(ctx, s.co.slug, email);
      const other = await login(ctx, s.co.slug, email);
      const next = `new-${who}-password-123`;
      const res = await change(here, { current_password: PASSWORD, new_password: next });
      expect(res.statusCode, `${who}: ${res.body}`).toBe(200);
      expect((await call(ctx, here, 'GET', '/me')).statusCode).toBe(200);
      expect((await call(ctx, other, 'GET', '/me')).statusCode).toBe(401);
      await expect(login(ctx, s.co.slug, email, PASSWORD)).rejects.toThrow();
      expect(await login(ctx, s.co.slug, email, next)).toEqual(expect.any(String));
    }
  });

  it('checks the current password, enforces the length, and refuses an unchanged password', async () => {
    const cookie = await login(ctx, s.co.slug, s.email('salesManager'));
    const wrong = await change(cookie, { current_password: 'not-my-password', new_password: 'a-brand-new-password-1' });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().error.details[0].path).toBe('current_password');
    expect((await change(cookie, { current_password: PASSWORD, new_password: 'short' })).statusCode).toBe(400);
    expect((await change(cookie, { current_password: PASSWORD, new_password: PASSWORD })).json().error.details[0].path).toBe('new_password');
    // Still the old password after all that.
    expect(await login(ctx, s.co.slug, s.email('salesManager'))).toEqual(expect.any(String));
  });

  it('needs a session, and records the change and the failed attempt without the password', async () => {
    expect((await change(null as never, { current_password: PASSWORD, new_password: 'another-new-password-1' })).statusCode).toBe(401);
    const cookie = await login(ctx, s.co.slug, s.email('hr2'));
    await change(cookie, { current_password: 'wrong-password-123', new_password: 'another-new-password-1' });
    await change(cookie, { current_password: PASSWORD, new_password: 'another-new-password-1' });
    const rows = await ctx.adminDb.selectFrom('audit_events').select(['action', 'metadata']).where('entity_id', '=', s.users.hr2.id).where('action', 'like', 'auth.password_change%').execute();
    expect(rows.map((r) => r.action).sort()).toEqual(['auth.password_change_failed', 'auth.password_changed']);
    expect(JSON.stringify(rows)).not.toContain('another-new-password-1');
  });
});
