import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addUser, call, login, setupApp, type TestContext } from './helpers.js';
import { applicationOnVacancy, approvedRequisition, createAgency, openVacancy, requisitionPayload, setupCompany } from './hiring-helpers.js';

let ctx: TestContext;
let s: Awaited<ReturnType<typeof setupCompany>>;
let admin: string;
let recruiter: string;

beforeAll(async () => {
  ctx = await setupApp();
  s = await setupCompany(ctx, 'po');
  [admin, recruiter] = await Promise.all([s.as('admin'), s.as('recruiter')]);
});
afterAll(() => ctx.close());

describe('who may raise hiring requests and assign agencies', () => {
  it('only the company admin raises a hiring request; HR heads, recruiters and hiring managers cannot', async () => {
    const payload = requisitionPayload(s.eng.id);
    expect((await call(ctx, admin, 'POST', '/requisitions', payload)).statusCode).toBe(201);
    // (engManager and salesManager carry a test-only requester role, so use a plain hiring manager.)
    await addUser(ctx, s.co.tenant.id, { email: `hm@${s.co.slug}.test`, role: 'hiring_manager', departmentId: s.eng.id });
    const plainManager = await login(ctx, s.co.slug, `hm@${s.co.slug}.test`);
    for (const [who, cookie] of [['hr1', await s.as('hr1')], ['recruiter', recruiter], ['hiring_manager', plainManager]] as const) {
      expect((await call(ctx, cookie, 'POST', '/requisitions', payload)).statusCode, who).toBe(403);
    }
  });

  it('HR heads still approve what the admin raises', async () => {
    const id = await approvedRequisition(ctx, s);
    expect(id).toEqual(expect.any(String));
  });

  it('a recruiter cannot open vacancies, assign agencies or assign recruiters', async () => {
    const rq = await approvedRequisition(ctx, s);
    expect((await call(ctx, recruiter, 'POST', `/requisitions/${rq}/vacancies`, {})).statusCode).toBeGreaterThanOrEqual(403);
    const v = await openVacancy(ctx, admin, rq);
    const agency = await createAgency(ctx, admin, 'Policy Agency');
    await call(ctx, admin, 'POST', `/vacancies/${v.id}/assign-recruiter`, { user_id: s.users.recruiter.id });
    for (const [path, body] of [[`/vacancies/${v.id}/assign-agency`, { agency_id: agency }], [`/vacancies/${v.id}/assign-recruiter`, { user_id: s.users.recruiter.id }]] as const) {
      expect((await call(ctx, recruiter, 'POST', path, body)).statusCode, path).toBe(403);
    }
    expect((await call(ctx, recruiter, 'GET', '/agencies')).statusCode).toBe(403);
  });

  it('a recruiter works only on vacancies assigned to them', async () => {
    const a = await applicationOnVacancy(ctx, s, 'x');
    expect((await call(ctx, recruiter, 'GET', `/vacancies/${a.vacancyId}`)).statusCode).toBe(404);
    expect((await call(ctx, recruiter, 'PATCH', `/applications/${a.applicationId}/stage`, { stage_id: '00000000-0000-4000-8000-000000000001' })).statusCode).toBe(404);
    await call(ctx, admin, 'POST', `/vacancies/${a.vacancyId}/assign-recruiter`, { user_id: s.users.recruiter.id });
    expect((await call(ctx, recruiter, 'GET', `/vacancies/${a.vacancyId}`)).statusCode).toBe(200);
  });
});
