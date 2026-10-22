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
  const cand = (await call(ctx, admin, 'POST', '/candidates', { full_name: `Pay ${label}`, email: `pay.${label}@mail.test` })).json().data;
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
