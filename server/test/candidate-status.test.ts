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

describe('sourcing ID and temp employee ID', () => {
  type Row = { application_id: string; sourcing_code: string; temp_employee_code: string | null };
  const list = async (query = '') => (await call(ctx, recruiter, 'GET', `/candidate-status${query}`)).json().data as Row[];

  it('gives every sourced candidate a sourcing ID, and a temp employee ID once selected; both can be searched', async () => {
    const a = await assigned('eeeee');
    const b = await assigned('ffffff');
    const rows = await list();
    const ra = rows.find((r) => r.application_id === a.applicationId)!;
    const rb = rows.find((r) => r.application_id === b.applicationId)!;
    expect(ra.sourcing_code).toMatch(/^SRC-\d{6}$/);
    expect(rb.sourcing_code).not.toBe(ra.sourcing_code);
    expect(ra.temp_employee_code).toBeNull();

    await call(ctx, engManager, 'POST', `/applications/${a.applicationId}/decisions`, { decision: 'select', reason: 'Good' });
    const selected = (await list()).find((r) => r.application_id === a.applicationId)!;
    expect(selected.temp_employee_code).toMatch(/^TEMP-\d{5}$/);
    // A second select keeps the same ID.
    await call(ctx, engManager, 'POST', `/applications/${a.applicationId}/decisions`, { decision: 'select', reason: 'Still good' });
    expect((await list()).find((r) => r.application_id === a.applicationId)!.temp_employee_code).toBe(selected.temp_employee_code);

    expect((await list(`?q=${ra.sourcing_code}`)).map((r) => r.application_id)).toEqual([a.applicationId]);
    expect((await list(`?q=${selected.temp_employee_code}`)).map((r) => r.application_id)).toEqual([a.applicationId]);
    const onlySelected = await list('?selected=yes');
    expect(onlySelected.some((r) => r.application_id === a.applicationId)).toBe(true);
    expect(onlySelected.some((r) => r.application_id === b.applicationId)).toBe(false);
    expect((await list('?selected=no')).some((r) => r.application_id === b.applicationId)).toBe(true);
  });
});
