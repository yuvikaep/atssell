// Salary and joining: the job decides who settles it; the admin approves or sets it; then it is locked.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addUser, call, login, setupApp, type TestContext } from './helpers.js';
import { goodFeedback, inHours, scheduleInterview, setupCompany } from './hiring-helpers.js';

let ctx: TestContext;
let s: Awaited<ReturnType<typeof setupCompany>>;
let admin: string;
let recruiter: string;

beforeAll(async () => {
  ctx = await setupApp();
  s = await setupCompany(ctx, 'jt');
  [admin, recruiter] = await Promise.all([s.as('admin'), s.as('recruiter')]);
});
afterAll(() => ctx.close());

async function selectedCandidate(termsOwner: 'recruiter' | 'interviewer' | 'admin', label: string) {
  const job = await call(ctx, admin, 'POST', '/jobs', { title: `Job ${label}`, department_id: s.eng.id, location: 'Pune', openings: 1, terms_owner: termsOwner });
  expect(job.statusCode, job.body).toBe(201);
  const vacancyId = job.json().data.id;
  await call(ctx, admin, 'POST', `/vacancies/${vacancyId}/assign-recruiter`, { user_id: s.users.recruiter.id });
  const cand = (await call(ctx, recruiter, 'POST', '/candidates', { full_name: `Pay ${label}`, email: `pay.${label}@mail.test` })).json().data;
  const app = (await call(ctx, recruiter, 'POST', '/applications', { candidate_id: cand.id, vacancy_id: vacancyId })).json().data;
  const head = await addUser(ctx, s.co.tenant.id, { email: `head.${label}@${s.co.slug}.test`, role: 'interviewer' });
  const headCookie = await login(ctx, s.co.slug, `head.${label}@${s.co.slug}.test`);
  const iv = await scheduleInterview(ctx, recruiter, app.id, { scheduled_start: inHours(-2), scheduled_end: inHours(-1), panel: [{ user_id: head.id }] });
  await call(ctx, headCookie, 'POST', `/me/interviews/${iv.id}/feedback`, goodFeedback());
  expect((await call(ctx, headCookie, 'POST', `/applications/${app.id}/decisions`, { decision: 'select' })).statusCode).toBe(201);
  return { applicationId: app.id as string, headCookie };
}
const terms = { annual_ctc: 600000, joining_date: '2026-12-01' };

describe('salary and joining', () => {
  it('the interviewer proposes, the admin approves, then only the admin can change it; recruiters see the result', async () => {
    const { applicationId, headCookie } = await selectedCandidate('interviewer', 'iv');
    expect((await call(ctx, recruiter, 'POST', `/applications/${applicationId}/joining-terms`, terms)).statusCode).toBe(403);
    expect((await call(ctx, headCookie, 'GET', '/joining-terms')).json().data.map((r: { id: string }) => r.id)).toContain(applicationId);
    expect((await call(ctx, headCookie, 'POST', `/applications/${applicationId}/joining-terms`, terms)).json().data.status).toBe('proposed');
    expect((await call(ctx, headCookie, 'POST', `/applications/${applicationId}/joining-terms/approve`)).statusCode).toBe(403);

    const pending = (await call(ctx, admin, 'GET', '/joining-terms')).json().data.find((r: { id: string }) => r.id === applicationId);
    expect(pending).toMatchObject({ terms_status: 'proposed', can_approve: true });
    expect((await call(ctx, admin, 'POST', `/applications/${applicationId}/joining-terms/approve`)).statusCode).toBe(200);
    expect((await call(ctx, headCookie, 'POST', `/applications/${applicationId}/joining-terms`, { ...terms, annual_ctc: 900000 })).statusCode).toBe(409);
    expect((await call(ctx, admin, 'POST', `/applications/${applicationId}/joining-terms`, { ...terms, annual_ctc: 650000 })).json().data.status).toBe('approved');

    const row = (await call(ctx, recruiter, 'GET', '/candidate-status')).json().data.find((r: { application_id: string }) => r.application_id === applicationId);
    expect(row).toMatchObject({ agreed_salary: 650000, joining_date: '2026-12-01' });
  });

  it('a recruiter-settled job: the assigned recruiter proposes; an admin-settled job: only the admin', async () => {
    const r = await selectedCandidate('recruiter', 'rc');
    expect((await call(ctx, recruiter, 'POST', `/applications/${r.applicationId}/joining-terms`, terms)).statusCode).toBe(201);
    expect((await call(ctx, r.headCookie, 'POST', `/applications/${r.applicationId}/joining-terms`, terms)).statusCode).toBe(403);
    const a = await selectedCandidate('admin', 'ad');
    expect((await call(ctx, recruiter, 'POST', `/applications/${a.applicationId}/joining-terms`, terms)).statusCode).toBe(403);
    expect((await call(ctx, admin, 'POST', `/applications/${a.applicationId}/joining-terms`, terms)).json().data.status).toBe('approved');
  });
});

describe('exits', () => {
  it('the admin or the head of the department marks an exit; the head sees no pay', async () => {
    const { applicationId } = await selectedCandidate('admin', 'ex');
    const join = await call(ctx, admin, 'POST', `/applications/${applicationId}/join`, { joined_on: '2026-01-05', designation: 'Engineer', annual_ctc: 700000 });
    expect(join.statusCode, join.body).toBe(201);
    const emp = (await call(ctx, admin, 'GET', '/employment')).json().data.find((e: { application_id: string }) => e.application_id === applicationId);
    expect((await call(ctx, recruiter, 'POST', `/employment/${emp.id}/exit`, { exit_date: '2026-02-01', exit_reason: 'Left' })).statusCode).toBe(403);

    await ctx.adminDb.updateTable('departments').set({ head_user_id: s.users.hr2.id }).where('id', '=', s.eng.id).execute();
    const head = await s.as('hr2');
    expect((await call(ctx, head, 'GET', '/me')).json().data.head_of_departments).toEqual([s.eng.id]);
    const mine = (await call(ctx, head, 'GET', '/employment')).json().data.find((e: { id: string }) => e.id === emp.id);
    expect(mine.annual_ctc).toBeNull();
    const exit = await call(ctx, head, 'POST', `/employment/${emp.id}/exit`, { exit_date: '2026-02-01', exit_reason: 'Left for studies' });
    expect(exit.statusCode, exit.body).toBe(200);
  });
});

describe('editing a job', () => {
  it('changes title, openings, salary range, JD and who settles salary; recruiters cannot', async () => {
    const job = (await call(ctx, admin, 'POST', '/jobs', { title: 'Old title', department_id: s.eng.id, location: 'Pune', openings: 2 })).json().data;
    const res = await call(ctx, admin, 'PATCH', `/jobs/${job.id}`, { title: 'Telesales Executive', openings: 10, salary_min: 240000, salary_max: 300000, description: 'Calls and closes leads.', terms_owner: 'interviewer' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data).toMatchObject({ title: 'Telesales Executive', headcount: 10, terms_owner: 'interviewer', description: 'Calls and closes leads.' });
    expect(Number(res.json().data.max_ctc)).toBe(300000);
    expect((await call(ctx, admin, 'PATCH', `/jobs/${job.id}`, { salary_min: 500000 })).statusCode).toBe(400);
    expect((await call(ctx, recruiter, 'PATCH', `/jobs/${job.id}`, { title: 'Nope' })).statusCode).toBe(403);
  });
});

describe('interviewers chosen with the job', () => {
  it('are set when the job is created, can be changed when editing, and fill the panel list', async () => {
    const job = await call(ctx, admin, 'POST', '/jobs', { title: 'With panel', department_id: s.eng.id, location: 'Pune', openings: 1, interviewer_ids: [s.users.engManager.id] });
    expect(job.statusCode, job.body).toBe(201);
    expect(job.json().data.interviewers.map((u: { id: string }) => u.id)).toEqual([s.users.engManager.id]);
    const edited = await call(ctx, admin, 'PATCH', `/jobs/${job.json().data.id}`, { interviewer_ids: [s.users.hr1.id, s.users.hr2.id] });
    expect(edited.json().data.interviewers.map((u: { id: string }) => u.id).sort()).toEqual([s.users.hr1.id, s.users.hr2.id].sort());
    const bad = await call(ctx, admin, 'POST', '/jobs', { title: 'Bad panel', department_id: s.eng.id, location: 'Pune', openings: 1, interviewer_ids: ['00000000-0000-4000-8000-000000000000'] });
    expect(bad.statusCode).toBe(422);
  });
});
