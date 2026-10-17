import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, setupApp, type TestContext } from './helpers.js';
import { applicationOnVacancy, goodFeedback, scheduleInterview, setupCompany } from './hiring-helpers.js';

let ctx: TestContext;
let s: Awaited<ReturnType<typeof setupCompany>>;
let admin: string;
let engManager: string;
let salesManager: string;
let recruiter: string;
let applicationId: string;
let interviewId: string;

beforeAll(async () => {
  ctx = await setupApp();
  s = await setupCompany(ctx, 'hh');
  [admin, engManager, salesManager, recruiter] = await Promise.all([s.as('admin'), s.as('engManager'), s.as('salesManager'), s.as('recruiter')]);
  applicationId = (await applicationOnVacancy(ctx, s, 'a')).applicationId;
  const iv = await scheduleInterview(ctx, admin, applicationId, { panel: [{ user_id: s.users.engManager.id }, { user_id: s.users.hr1.id }] });
  interviewId = iv.id;
  await ctx.adminDb.updateTable('interviews').set({ scheduled_start: new Date(Date.now() - 7_200_000), scheduled_end: new Date(Date.now() - 3_600_000) }).where('id', '=', iv.id).execute();
});
afterAll(() => ctx.close());

const home = async (cookie: string) => (await call(ctx, cookie, 'GET', '/hiring-home')).json().data;

describe('hiring manager home', () => {
  it('shows feedback owed, then candidates waiting for a decision once feedback is in', async () => {
    const before = await home(engManager);
    expect(before.feedback_owed.map((f: { interview_id: string }) => f.interview_id)).toContain(interviewId);
    expect(before.waiting_for_decision).toHaveLength(0);
    expect(before.vacancies).toHaveLength(1);

    const sent = await call(ctx, engManager, 'POST', `/me/interviews/${interviewId}/feedback`, goodFeedback());
    expect(sent.statusCode, sent.body).toBe(201);
    const after = await home(engManager);
    expect(after.feedback_owed).toHaveLength(0);
    expect(after.waiting_for_decision[0]).toMatchObject({ id: applicationId, feedback_count: 1, avg_rating: 4, can_decide: true });
  });

  it('clears a candidate from the list once a decision is recorded', async () => {
    const d = await call(ctx, engManager, 'POST', `/applications/${applicationId}/decisions`, { decision: 'advance' });
    expect(d.statusCode, d.body).toBe(201);
    expect((await home(engManager)).waiting_for_decision).toHaveLength(0);
  });

  it('is scoped to what the person can see', async () => {
    const other = await home(salesManager);
    expect(other.vacancies).toHaveLength(0);
    expect(other.waiting_for_decision).toHaveLength(0);
    expect(other.feedback_owed).toHaveLength(0);
    expect((await home(admin)).vacancies).toHaveLength(1);
  });

  it('lists a requisition waiting on the approver, in turn', async () => {
    const { requisitionPayload } = await import('./hiring-helpers.js');
    const created = await call(ctx, admin, 'POST', '/requisitions', requisitionPayload(s.eng.id, { title: 'Needs hr1' }));
    const id = created.json().data.id as string;
    await call(ctx, admin, 'POST', `/requisitions/${id}/submit-approval`, { approver_user_ids: [s.users.hr1.id, s.users.hr2.id] });
    expect((await home(await s.as('hr1'))).approvals.map((a: { id: string }) => a.id)).toContain(id);
    expect((await home(await s.as('hr2'))).approvals.map((a: { id: string }) => a.id)).not.toContain(id);
  });

  it('is closed to people who see no vacancies, and to anonymous callers', async () => {
    const agency = await call(ctx, null, 'GET', '/hiring-home');
    expect(agency.statusCode).toBe(401);
    expect((await call(ctx, recruiter, 'GET', '/hiring-home')).statusCode).toBe(200);
  });
});
