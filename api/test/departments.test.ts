import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, createCompany, login, setupApp, type TestContext } from './helpers.js';

let ctx: TestContext;
let co: Awaited<ReturnType<typeof createCompany>>;
let cookie: string;

beforeAll(async () => {
  ctx = await setupApp();
  co = await createCompany(ctx, 'dept');
  cookie = await login(ctx, co.slug, co.admin.email);
});
afterAll(() => ctx.close());

const create = (body: object) => call(ctx, cookie, 'POST', '/departments', body);

describe('departments', () => {
  it('creates a department with parent and head, and lists it', async () => {
    const parent = (await create({ name: 'Technology' })).json().data;
    const res = await create({ name: 'Data', parent_department_id: parent.id, head_user_id: co.admin.id });
    expect(res.statusCode).toBe(201);
    expect(res.json().data).toMatchObject({
      name: 'Data', parent_name: 'Technology', head_name: 'Admin User', status: 'active', active_vacancies: 0,
    });
    const list = (await call(ctx, cookie, 'GET', '/departments')).json().data;
    expect(list.map((d: { name: string }) => d.name)).toEqual(['Data', 'Technology']);
  });

  it('rejects a duplicate name with 409', async () => {
    await create({ name: 'Finance' });
    const res = await create({ name: 'Finance' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('DEPARTMENT_NAME_TAKEN');
  });

  it('rejects an empty name with a validation error', async () => {
    const res = await create({ name: '   ' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.details[0].path).toBe('name');
  });

  it('rejects a hierarchy cycle with 422', async () => {
    const top = (await create({ name: 'Ops' })).json().data;
    const mid = (await create({ name: 'Ops West', parent_department_id: top.id })).json().data;
    const res = await call(ctx, cookie, 'PATCH', `/departments/${top.id}`, { parent_department_id: mid.id });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('DEPARTMENT_CYCLE');
    const self = await call(ctx, cookie, 'PATCH', `/departments/${top.id}`, { parent_department_id: top.id });
    expect(self.statusCode).toBe(422);
  });

  it('will not deactivate a department with active sub-departments', async () => {
    const top = (await create({ name: 'Marketing' })).json().data;
    const child = (await create({ name: 'Brand', parent_department_id: top.id })).json().data;
    const blocked = await call(ctx, cookie, 'PATCH', `/departments/${top.id}`, { status: 'inactive' });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.code).toBe('HAS_ACTIVE_CHILDREN');

    expect((await call(ctx, cookie, 'PATCH', `/departments/${child.id}`, { status: 'inactive' })).statusCode).toBe(200);
    const ok = await call(ctx, cookie, 'PATCH', `/departments/${top.id}`, { status: 'inactive' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().data.status).toBe('inactive');
  });

  it('hides inactive departments by default and shows them with status=all', async () => {
    const active = (await call(ctx, cookie, 'GET', '/departments')).json().data.map((d: { name: string }) => d.name);
    expect(active).not.toContain('Marketing');
    const all = (await call(ctx, cookie, 'GET', '/departments?status=all')).json().data.map((d: { name: string }) => d.name);
    expect(all).toContain('Marketing');
  });

  it('will not place a department under an inactive parent', async () => {
    const parent = (await call(ctx, cookie, 'GET', '/departments?status=inactive')).json().data[0];
    const res = await create({ name: 'Orphan', parent_department_id: parent.id });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('PARENT_INACTIVE');
  });

  it('audits create, update and deactivate', async () => {
    const actions = (await ctx.adminDb
      .selectFrom('audit_events')
      .select('action')
      .where('tenant_id', '=', co.tenant.id)
      .where('entity_type', '=', 'department')
      .execute()).map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['department.created', 'department.deactivated']));
  });

  it('returns 404 for an unknown id and 400 for a malformed id', async () => {
    expect((await call(ctx, cookie, 'PATCH', '/departments/00000000-0000-4000-8000-000000000000', { name: 'X' })).statusCode).toBe(404);
    expect((await call(ctx, cookie, 'PATCH', '/departments/not-a-uuid', { name: 'X' })).statusCode).toBe(400);
  });
});
