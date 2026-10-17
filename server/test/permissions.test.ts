import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDepartment, addUser, call, createCompany, login, setupApp, type TestContext } from './helpers.js';

let ctx: TestContext;
let co: Awaited<ReturnType<typeof createCompany>>;
let adminCookie: string;
let sales: { id: string };

beforeAll(async () => {
  ctx = await setupApp();
  co = await createCompany(ctx, 'perm');
  sales = await addDepartment(ctx, co.tenant.id, 'Sales');
  await addDepartment(ctx, co.tenant.id, 'Engineering');
  adminCookie = await login(ctx, co.slug, co.admin.email);
});
afterAll(() => ctx.close());

describe('role permissions', () => {
  it('a recruiter cannot create departments or manage users', async () => {
    await addUser(ctx, co.tenant.id, { email: 'rec@perm.test', role: 'internal_recruiter' });
    const cookie = await login(ctx, co.slug, 'rec@perm.test');
    for (const res of [
      await call(ctx, cookie, 'POST', '/departments', { name: 'Nope' }),
      await call(ctx, cookie, 'GET', '/users'),
      await call(ctx, cookie, 'GET', '/roles'),
      await call(ctx, cookie, 'POST', '/users/invitations', { email: 'x@perm.test', role_code: 'company_admin' }),
    ]) {
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('FORBIDDEN');
    }
  });

  it('a department-scoped hiring manager sees only their department', async () => {
    await addUser(ctx, co.tenant.id, { email: 'hm@perm.test', role: 'hiring_manager', departmentId: sales.id });
    const cookie = await login(ctx, co.slug, 'hm@perm.test');
    const me = (await call(ctx, cookie, 'GET', '/me')).json().data;
    expect(me.permissions['interviews.manage']).toEqual([sales.id]);
    expect(me.permissions['requisitions.create']).toBeUndefined();
    expect(me.permissions['analytics.view']).toBeUndefined();
    expect((await call(ctx, cookie, 'POST', '/requisitions', { title: 'x' })).statusCode).toBe(403);
    const depts = (await call(ctx, cookie, 'GET', '/departments')).json().data;
    expect(depts.map((d: { name: string }) => d.name)).toEqual(['Sales']);
  });

  it('role changes apply on the next request without signing in again', async () => {
    const user = await addUser(ctx, co.tenant.id, { email: 'promote@perm.test', role: 'internal_recruiter' });
    const cookie = await login(ctx, co.slug, 'promote@perm.test');
    expect((await call(ctx, cookie, 'GET', '/users')).statusCode).toBe(403);

    const res = await call(ctx, adminCookie, 'PUT', `/users/${user.id}/roles`, {
      assignments: [{ role_code: 'company_admin', department_id: null }],
    });
    expect(res.statusCode).toBe(200);
    expect((await call(ctx, cookie, 'GET', '/users')).statusCode).toBe(200);

    await call(ctx, adminCookie, 'PUT', `/users/${user.id}/roles`, {
      assignments: [{ role_code: 'internal_recruiter', department_id: null }],
    });
    expect((await call(ctx, cookie, 'GET', '/users')).statusCode).toBe(403);
  });

  it('deactivating a user ends their sessions immediately', async () => {
    const user = await addUser(ctx, co.tenant.id, { email: 'leaver@perm.test', role: 'internal_recruiter' });
    const cookie = await login(ctx, co.slug, 'leaver@perm.test');
    const res = await call(ctx, adminCookie, 'PATCH', `/users/${user.id}`, { status: 'inactive' });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.status).toBe('inactive');
    expect((await call(ctx, cookie, 'GET', '/me')).statusCode).toBe(401);
  });
});

describe('last-admin protection', () => {
  it('blocks removing or deactivating the only Company Admin, including yourself', async () => {
    const solo = await createCompany(ctx, 'solo');
    const cookie = await login(ctx, solo.slug, solo.admin.email);
    const demote = await call(ctx, cookie, 'PUT', `/users/${solo.admin.id}/roles`, {
      assignments: [{ role_code: 'internal_recruiter', department_id: null }],
    });
    expect(demote.statusCode).toBe(409);
    expect(demote.json().error.code).toBe('LAST_ADMIN');
    const self = await call(ctx, cookie, 'PATCH', `/users/${solo.admin.id}`, { status: 'inactive' });
    expect(self.statusCode).toBe(409);
    expect(self.json().error.code).toBe('CANNOT_DEACTIVATE_SELF');
  });

  it('allows demoting an admin while another active admin remains', async () => {
    const second = await addUser(ctx, co.tenant.id, { email: 'admin2@perm.test', role: 'company_admin' });
    const res = await call(ctx, adminCookie, 'PUT', `/users/${second.id}/roles`, {
      assignments: [{ role_code: 'internal_recruiter', department_id: null }],
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.roles.map((r: { code: string }) => r.code)).toEqual(['internal_recruiter']);
  });

  it('records role changes in the audit log with before and after', async () => {
    const ev = await ctx.adminDb
      .selectFrom('audit_events')
      .select(['metadata', 'actor_user_id'])
      .where('tenant_id', '=', co.tenant.id)
      .where('action', '=', 'user.roles_changed')
      .orderBy('created_at', 'desc')
      .executeTakeFirstOrThrow();
    expect(ev.actor_user_id).toBe(co.admin.id);
    expect(ev.metadata).toMatchObject({ before: [{ role: 'company_admin' }], after: [{ role: 'internal_recruiter' }] });
  });

  it('rejects agency roles until agency management exists', async () => {
    const res = await call(ctx, adminCookie, 'POST', '/users/invitations', { email: 'ag@perm.test', role_code: 'agency_admin' });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('AGENCY_ROLE');
  });
});
