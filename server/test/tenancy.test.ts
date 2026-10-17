// Cross-tenant isolation (backlog EPIC-01 / EPIC-12): a user of company A must never read or change
// company B's data, whether through the API or through a bug that skips an authorization check.
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant } from '../src/db.js';
import { addDepartment, addUser, call, createCompany, login, setupApp, type TestContext } from './helpers.js';

let ctx: TestContext;
let a: Awaited<ReturnType<typeof createCompany>>;
let b: Awaited<ReturnType<typeof createCompany>>;
let cookieA: string;
let deptB: { id: string };
let userB: { id: string };

beforeAll(async () => {
  ctx = await setupApp();
  a = await createCompany(ctx, 'tena');
  b = await createCompany(ctx, 'tenb');
  await addDepartment(ctx, a.tenant.id, 'A Engineering');
  deptB = await addDepartment(ctx, b.tenant.id, 'B Secret Projects');
  userB = await addUser(ctx, b.tenant.id, { email: 'someone@b.test', role: 'internal_recruiter' });
  cookieA = await login(ctx, a.slug, a.admin.email);
});
afterAll(() => ctx.close());

describe('API isolation', () => {
  it('lists only the caller tenant departments and users', async () => {
    const depts = (await call(ctx, cookieA, 'GET', '/departments')).json().data;
    expect(depts.map((d: { name: string }) => d.name)).toEqual(['A Engineering']);
    const users = (await call(ctx, cookieA, 'GET', '/users')).json().data;
    expect(users.every((u: { email: string }) => !u.email.endsWith('@b.test'))).toBe(true);
  });

  it('returns 404, not 403, for another tenant department, and does not change it', async () => {
    const res = await call(ctx, cookieA, 'PATCH', `/departments/${deptB.id}`, { name: 'Hacked' });
    expect(res.statusCode).toBe(404);
    const row = await ctx.adminDb.selectFrom('departments').select('name').where('id', '=', deptB.id).executeTakeFirstOrThrow();
    expect(row.name).toBe('B Secret Projects');
  });

  it('cannot deactivate, re-role or read another tenant user', async () => {
    expect((await call(ctx, cookieA, 'PATCH', `/users/${userB.id}`, { status: 'inactive' })).statusCode).toBe(404);
    expect((await call(ctx, cookieA, 'PUT', `/users/${userB.id}/roles`, { assignments: [{ role_code: 'company_admin', department_id: null }] })).statusCode).toBe(404);
  });

  it('cannot reference another tenant department as parent, or another tenant user as head', async () => {
    const parent = await call(ctx, cookieA, 'POST', '/departments', { name: 'Child', parent_department_id: deptB.id });
    expect(parent.statusCode).toBe(422);
    const head = await call(ctx, cookieA, 'POST', '/departments', { name: 'Headed', head_user_id: userB.id });
    expect(head.statusCode).toBe(422);
  });

  it('cannot invite into another tenant department', async () => {
    const res = await call(ctx, cookieA, 'POST', '/users/invitations', {
      email: 'new@a.test', role_code: 'hiring_manager', department_id: deptB.id,
    });
    expect(res.statusCode).toBe(422);
  });

  it('ignores a tenant_id supplied in the request body', async () => {
    const res = await call(ctx, cookieA, 'POST', '/departments', { name: 'Smuggled', tenant_id: b.tenant.id });
    expect(res.statusCode).toBe(201);
    const row = await ctx.adminDb.selectFrom('departments').select('tenant_id').where('id', '=', res.json().data.id).executeTakeFirstOrThrow();
    expect(row.tenant_id).toBe(a.tenant.id);
  });
});

describe('database-level isolation (defence in depth under the API)', () => {
  it('the app role sees no rows without a tenant context', async () => {
    const { rows } = await sql<{ n: number }>`SELECT count(*)::int AS n FROM users`.execute(ctx.appDb);
    expect(rows[0]!.n).toBe(0);
  });

  it('a tenant-scoped transaction sees only that tenant, even with no WHERE clause', async () => {
    const names = await withTenant(ctx.appDb, a.tenant.id, (tx) => tx.selectFrom('departments').select('name').execute());
    expect(names.map((n) => n.name)).not.toContain('B Secret Projects');
  });

  it('a tenant-scoped transaction cannot write a row for another tenant', async () => {
    await expect(
      withTenant(ctx.appDb, a.tenant.id, (tx) =>
        tx.insertInto('departments').values({ tenant_id: b.tenant.id, name: 'Planted' }).execute()),
    ).rejects.toThrow(/row-level security/);
  });

  it('a tenant-scoped transaction cannot update another tenant rows', async () => {
    const result = await withTenant(ctx.appDb, a.tenant.id, (tx) =>
      tx.updateTable('departments').set({ name: 'Hacked' }).where('id', '=', deptB.id).executeTakeFirst());
    expect(result.numUpdatedRows).toBe(0n);
  });

  it('the app role cannot modify or delete audit events', async () => {
    await expect(
      withTenant(ctx.appDb, a.tenant.id, (tx) => tx.deleteFrom('audit_events').execute()),
    ).rejects.toThrow(/permission denied/);
  });

  it('the app role cannot write the tenants table or read platform admins', async () => {
    await expect(sql`UPDATE tenants SET name = 'x'`.execute(ctx.appDb)).rejects.toThrow(/permission denied/);
    await expect(sql`SELECT * FROM platform_admins`.execute(ctx.appDb)).rejects.toThrow(/permission denied/);
  });
});
