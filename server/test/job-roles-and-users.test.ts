// Job roles inside departments (picked while sourcing), and admins creating users directly.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, nextIp, setupApp, type TestContext } from './helpers.js';
import { approvedRequisition, createAgency, openVacancy, setupCompany } from './hiring-helpers.js';

let ctx: TestContext;
let s: Awaited<ReturnType<typeof setupCompany>>;
let admin: string;

beforeAll(async () => {
  ctx = await setupApp();
  s = await setupCompany(ctx, 'jr');
  admin = await s.as('admin');
});
afterAll(() => ctx.close());

const signIn = (email: string, password: string) =>
  ctx.app.inject({ method: 'POST', url: '/api/v1/auth/login', remoteAddress: nextIp(), payload: { company: s.co.slug, email, password } });

describe('job roles', () => {
  it('are created per department, picked while sourcing, shown and filtered on candidate status', async () => {
    const created = await call(ctx, admin, 'POST', '/job-roles', { department_id: s.eng.id, name: 'Backend Developer' });
    expect(created.statusCode, created.body).toBe(201);
    const role = created.json().data;
    expect((await call(ctx, admin, 'POST', '/job-roles', { department_id: s.eng.id, name: 'backend developer' })).statusCode).toBe(409);
    const salesRole = (await call(ctx, admin, 'POST', '/job-roles', { department_id: s.sales.id, name: 'Sales Executive' })).json().data;
    expect((await call(ctx, await s.as('recruiter'), 'POST', '/job-roles', { department_id: s.eng.id, name: 'X' })).statusCode).toBe(403);

    const vacancy = await openVacancy(ctx, admin, await approvedRequisition(ctx, s, { departmentId: s.eng.id }));
    const cand = (await call(ctx, admin, 'POST', '/candidates', { full_name: 'Role Person', email: 'role.person@mail.test' })).json().data;
    // A role from another department is refused.
    const wrong = await call(ctx, admin, 'POST', '/applications', { candidate_id: cand.id, vacancy_id: vacancy.id, job_role_id: salesRole.id });
    expect(wrong.statusCode).toBe(400);
    const ok = await call(ctx, admin, 'POST', '/applications', { candidate_id: cand.id, vacancy_id: vacancy.id, job_role_id: role.id });
    expect(ok.statusCode, ok.body).toBe(201);

    const rows = (await call(ctx, admin, 'GET', `/candidate-status?job_role_id=${role.id}`)).json().data;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ job_role_name: 'Backend Developer', candidate_name: 'Role Person' });
    const list = (await call(ctx, admin, 'GET', `/job-roles?department_id=${s.eng.id}`)).json().data;
    expect(list.find((r: { id: string }) => r.id === role.id).sourced).toBe(1);
  });
});

describe('creating users directly', () => {
  it('creates a company user with a role who can sign in and gets that role', async () => {
    const res = await call(ctx, admin, 'POST', '/users', { full_name: 'Rita Recruiter', email: 'rita@jr.test', password: 'first-password-123', role_code: 'internal_recruiter' });
    expect(res.statusCode, res.body).toBe(201);
    const login = await signIn('rita@jr.test', 'first-password-123');
    expect(login.statusCode).toBe(200);
    const me = (await call(ctx, `jm_session=${login.cookies.find((c) => c.name === 'jm_session')!.value}`, 'GET', '/me')).json().data;
    expect(me.roles.map((r: { code: string }) => r.code)).toEqual(['internal_recruiter']);
    expect((await call(ctx, admin, 'POST', '/users', { full_name: 'Again', email: 'rita@jr.test', password: 'first-password-123', role_code: 'interviewer' })).statusCode).toBe(409);
  });

  it('creates an agency user only with an agency, who then sees the agency portal', async () => {
    const noAgency = await call(ctx, admin, 'POST', '/users', { full_name: 'Agent', email: 'agent@jr.test', password: 'first-password-123', role_code: 'agency_admin' });
    expect(noAgency.statusCode).toBe(400);
    const agencyId = await createAgency(ctx, admin, 'Talent Bridge');
    const res = await call(ctx, admin, 'POST', '/users', { full_name: 'Agent', email: 'agent@jr.test', password: 'first-password-123', role_code: 'agency_admin', agency_id: agencyId });
    expect(res.statusCode, res.body).toBe(201);
    const login = await signIn('agent@jr.test', 'first-password-123');
    const me = (await call(ctx, `jm_session=${login.cookies.find((c) => c.name === 'jm_session')!.value}`, 'GET', '/me')).json().data;
    expect(me.permissions['agency_portal.use']).toBeTruthy();
  });

  it('is only for admins', async () => {
    const res = await call(ctx, await s.as('recruiter'), 'POST', '/users', { full_name: 'X', email: 'x@jr.test', password: 'first-password-123', role_code: 'interviewer' });
    expect(res.statusCode).toBe(403);
  });
});
