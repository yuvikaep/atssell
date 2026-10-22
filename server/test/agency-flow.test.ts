// The whole flow for an agency candidate: a sub-recruiter sources, the admin schedules the job's
// interviewer, the interviewer sees it, gives feedback and decides.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addUser, call, login, setupApp, type TestContext } from './helpers.js';
import { addAgencyMember, agencyProfile, createAgency, goodFeedback, inHours, scheduleInterview, setupCompany, submitAs, vacancyWithAgencies } from './hiring-helpers.js';

let ctx: TestContext;
let s: Awaited<ReturnType<typeof setupCompany>>;
let admin: string;

beforeAll(async () => {
  ctx = await setupApp();
  s = await setupCompany(ctx, 'af');
  admin = await s.as('admin');
});
afterAll(() => ctx.close());

describe('agency candidate to interviewer', () => {
  it('reaches the job interviewer and can be decided', async () => {
    const agencyId = await createAgency(ctx, admin, 'Flow Staffing');
    await addAgencyMember(ctx, admin, agencyId, 'boss@flow.test', 'admin');
    const sub = await addAgencyMember(ctx, admin, agencyId, 'sub@flow.test', 'recruiter');
    const v = await vacancyWithAgencies(ctx, s, [agencyId]);
    const ravi = await addUser(ctx, s.co.tenant.id, { email: `ravi@${s.co.slug}.test`, role: 'interviewer' });
    expect((await call(ctx, admin, 'POST', `/vacancies/${v.id}/assign-interviewer`, { user_id: ravi.id })).statusCode).toBe(200);

    const res = await submitAs(ctx, sub.cookie, v.id, agencyProfile('flowone'));
    expect(res.statusCode, res.body).toBe(201);
    const appId = (await call(ctx, admin, 'GET', `/candidate-master?vacancy_id=${v.id}`)).json().data[0].application_id;
    // Before any interview: the job's interviewer sees the agency's candidate (with the resume);
    // a company recruiter on the same job does not.
    const raviEarly = await login(ctx, s.co.slug, `ravi@${s.co.slug}.test`);
    const jobCands = (await call(ctx, raviEarly, 'GET', '/my-job-candidates')).json().data;
    expect(jobCands.map((r: { application_id: string }) => r.application_id)).toContain(appId);
    expect(jobCands[0].source).toMatch(/^Agency: /);
    expect((await call(ctx, raviEarly, 'POST', `/my-job-candidates/${appId}/resume-url`)).statusCode).toBe(200);
    await call(ctx, admin, 'POST', `/vacancies/${v.id}/assign-recruiter`, { user_id: s.users.recruiter.id });
    const rec = await s.as('recruiter');
    expect((await call(ctx, rec, 'GET', '/candidate-status')).json().data.map((r: { application_id: string }) => r.application_id)).not.toContain(appId);
    expect((await call(ctx, rec, 'GET', `/candidate-master?vacancy_id=${v.id}`)).json().data.some((r: { application_id: string | null }) => r.application_id === appId)).toBe(false);
    const opts = (await call(ctx, admin, 'GET', `/applications/${appId}/panel-options`)).json().data.map((u: { id: string }) => u.id);
    expect(opts).toContain(ravi.id);
    const iv = await scheduleInterview(ctx, admin, appId, { scheduled_start: inHours(-2), scheduled_end: inHours(-1), panel: [{ user_id: ravi.id }] });
    const raviCookie = await login(ctx, s.co.slug, `ravi@${s.co.slug}.test`);
    const mine = (await call(ctx, raviCookie, 'GET', '/me/interviews')).json().data;
    expect(mine.map((i: { id: string }) => i.id)).toContain(iv.id);
    expect((await call(ctx, raviCookie, 'POST', `/me/interviews/${iv.id}/feedback`, goodFeedback())).statusCode).toBe(201);
    expect((await call(ctx, raviCookie, 'POST', `/applications/${appId}/decisions`, { decision: 'select' })).statusCode).toBe(201);
    expect((await call(ctx, raviCookie, 'GET', '/my-job-candidates?status=selected')).json().data.map((r: { application_id: string }) => r.application_id)).toContain(appId);
    // An interview whose feedback is all in shows as completed.
    expect((await call(ctx, admin, 'GET', `/interviews/${iv.id}`)).json().data.status).toBe('completed');
  });

  it("a recruiter never sees or edits another recruiter's candidate", async () => {
    const r2 = await addUser(ctx, s.co.tenant.id, { email: `rec2@${s.co.slug}.test`, role: 'internal_recruiter' });
    const r2c = await login(ctx, s.co.slug, `rec2@${s.co.slug}.test`);
    const rec = await s.as('recruiter');
    const mine = (await call(ctx, rec, 'POST', '/candidates', { full_name: 'Own Person', email: 'own.person@mail.test' })).json().data;
    expect((await call(ctx, rec, 'GET', `/candidates/${mine.id}`)).statusCode).toBe(200);
    expect((await call(ctx, r2c, 'GET', `/candidates/${mine.id}`)).statusCode).toBe(404);
    expect((await call(ctx, r2c, 'PATCH', `/candidates/${mine.id}`, { city: 'Delhi' })).statusCode).toBe(404);
    expect(r2.id).toBeTruthy();
  });
});
