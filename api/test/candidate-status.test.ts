import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, setupApp, type TestContext } from './helpers.js';
import { applicationOnVacancy, goodFeedback, inHours, scheduleInterview, setupCompany } from './hiring-helpers.js';

let ctx: TestContext;
let s: Awaited<ReturnType<typeof setupCompany>>;
let admin: string;
let recruiter: string;
let engManager: string;

beforeAll(async () => {
  ctx = await setupApp();
  s = await setupCompany(ctx, 'cs');
  [admin, recruiter, engManager] = await Promise.all([s.as('admin'), s.as('recruiter'), s.as('engManager')]);
});
afterAll(() => ctx.close());

const rowFor = async (cookie: string, applicationId: string) => {
  const res = await call(ctx, cookie, 'GET', '/candidate-status');
  expect(res.statusCode, res.body).toBe(200);
  return (res.json().data as { application_id: string; label: string; action: { kind: string } | null; feedback: { avg_rating: number } | null; remark: string | null }[]).find((r) => r.application_id === applicationId);
};
async function assigned(label: string) {
  const a = await applicationOnVacancy(ctx, s, label);
  await call(ctx, admin, 'POST', `/vacancies/${a.vacancyId}/assign-recruiter`, { user_id: s.users.recruiter.id });
  return a;
}

describe('candidate status for recruiters', () => {
  it('shows only candidates on the jobs assigned to them, and never contact or pay', async () => {
    const mine = await assigned('a');
    const notMine = await applicationOnVacancy(ctx, s, 'bb');
    expect(await rowFor(recruiter, mine.applicationId)).toBeTruthy();
    expect(await rowFor(recruiter, notMine.applicationId)).toBeUndefined();
    const body = (await call(ctx, recruiter, 'GET', '/candidate-status')).body;
    expect(body).not.toContain('@mail.test');
    expect(body).not.toContain('ctc');
  });

  it('walks from sourced, to interview scheduled, waiting for feedback, feedback received, and the manager\'s decision', async () => {
    const a = await assigned('ccc');
    expect(await rowFor(recruiter, a.applicationId)).toMatchObject({ label: 'Sourced', action: { kind: 'schedule' } });

    const iv = await scheduleInterview(ctx, recruiter, a.applicationId, { scheduled_start: inHours(24), scheduled_end: inHours(25), panel: [{ user_id: s.users.engManager.id }] });
    expect(await rowFor(recruiter, a.applicationId)).toMatchObject({ label: 'Interview scheduled', action: null });

    await ctx.adminDb.updateTable('interviews').set({ scheduled_start: new Date(Date.now() - 7_200_000), scheduled_end: new Date(Date.now() - 3_600_000) }).where('id', '=', iv.id).execute();
    expect(await rowFor(recruiter, a.applicationId)).toMatchObject({ label: 'Waiting for feedback' });

    await call(ctx, engManager, 'POST', `/me/interviews/${iv.id}/feedback`, goodFeedback());
    expect(await rowFor(recruiter, a.applicationId)).toMatchObject({ label: 'Feedback received', feedback: { avg_rating: 4 }, action: null });

    await call(ctx, engManager, 'POST', `/applications/${a.applicationId}/decisions`, { decision: 'select', reason: 'Great fit' });
    expect(await rowFor(recruiter, a.applicationId)).toMatchObject({ label: 'Selected', remark: 'Great fit', action: null });
  });

  it('asks the recruiter to book the round when the manager sends a candidate to the next round, with the remark', async () => {
    const a = await assigned('dddd');
    const res = await call(ctx, engManager, 'POST', `/applications/${a.applicationId}/next-round`, { remark: 'Check leadership', interviewer_user_ids: [s.users.hr1.id] });
    expect(res.statusCode, res.body).toBe(201);
    expect(await rowFor(recruiter, a.applicationId)).toMatchObject({ label: 'Needs interview time', remark: 'Check leadership', action: { kind: 'set_time' } });
  });

  it('is limited by company and by permission', async () => {
    const other = await setupCompany(ctx, 'cx');
    const rows = (await call(ctx, await other.as('admin'), 'GET', '/candidate-status')).json().data as unknown[];
    expect(rows).toHaveLength(0);
    expect((await call(ctx, null, 'GET', '/candidate-status')).statusCode).toBe(401);
  });
});
