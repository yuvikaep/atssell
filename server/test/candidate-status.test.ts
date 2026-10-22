import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, setupApp, type TestContext } from './helpers.js';
import { applicationOnVacancy, goodFeedback, inHours, PDF, scheduleInterview, setupCompany, uploadDocument } from './hiring-helpers.js';

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

describe('an interviewer decides on the candidate they interviewed', () => {
  it('selects, holds, rejects or sends to the next round without the decision permission; others cannot', async () => {
    const { addUser, login } = await import('./helpers.js');
    const head = await addUser(ctx, s.co.tenant.id, { email: `head@${s.co.slug}.test`, role: 'interviewer' });
    const outsider = await addUser(ctx, s.co.tenant.id, { email: `other@${s.co.slug}.test`, role: 'interviewer' });
    const headCookie = await login(ctx, s.co.slug, `head@${s.co.slug}.test`);
    const otherCookie = await login(ctx, s.co.slug, `other@${s.co.slug}.test`);
    const a = await assigned('ggggggg');
    const iv = await scheduleInterview(ctx, recruiter, a.applicationId, { scheduled_start: inHours(-2), scheduled_end: inHours(-1), panel: [{ user_id: head.id }] });
    expect((await call(ctx, headCookie, 'POST', `/me/interviews/${iv.id}/feedback`, goodFeedback())).statusCode).toBe(201);

    const detail = (await call(ctx, headCookie, 'GET', `/me/interviews/${iv.id}`)).json().data;
    expect(detail).toMatchObject({ application_id: a.applicationId, can_decide: true });

    expect((await call(ctx, otherCookie, 'POST', `/applications/${a.applicationId}/decisions`, { decision: 'select' })).statusCode).not.toBe(201);
    expect((await call(ctx, headCookie, 'POST', `/applications/${a.applicationId}/decisions`, { decision: 'hold', reason: 'Check notice' })).statusCode).toBe(201);
    const next = await call(ctx, headCookie, 'POST', `/applications/${a.applicationId}/next-round`, { remark: 'Meet the director', interviewer_user_ids: [outsider.id] });
    expect(next.statusCode, next.body).toBe(201);
    expect((await call(ctx, headCookie, 'GET', '/directory/users')).statusCode).toBe(200);
    expect((await call(ctx, headCookie, 'POST', `/applications/${a.applicationId}/decisions`, { decision: 'select' })).statusCode).toBe(201);
    const last = await ctx.adminDb.selectFrom('hiring_decisions').select(['decision', 'decided_by']).where('application_id', '=', a.applicationId).orderBy('decided_at', 'desc').executeTakeFirstOrThrow();
    expect(last).toEqual({ decision: 'select', decided_by: head.id });
    // Selected, not joined yet: listed under Employees → Yet to join, with the temp ID.
    const yet = (await call(ctx, admin, 'GET', '/employment/yet-to-join')).json().data;
    expect(yet.find((r: { application_id: string }) => r.application_id === a.applicationId)?.temp_employee_code).toMatch(/^TEMP-/);
  });
});

describe('resumes for recruiters and interviewers', () => {
  it('shows the latest resume on candidate status, and lets only the panel interviewer open it', async () => {
    const { addUser, login } = await import('./helpers.js');
    const panel = await addUser(ctx, s.co.tenant.id, { email: `panel@${s.co.slug}.test`, role: 'interviewer' });
    await addUser(ctx, s.co.tenant.id, { email: `nopanel@${s.co.slug}.test`, role: 'interviewer' });
    const a = await assigned('hhhhhhhh');
    const iv = await scheduleInterview(ctx, recruiter, a.applicationId, { scheduled_start: inHours(2), scheduled_end: inHours(3), panel: [{ user_id: panel.id }] });
    const panelCookie = await login(ctx, s.co.slug, `panel@${s.co.slug}.test`);
    const otherCookie = await login(ctx, s.co.slug, `nopanel@${s.co.slug}.test`);

    expect((await call(ctx, panelCookie, 'GET', `/me/interviews/${iv.id}`)).json().data.has_resume).toBe(false);
    expect((await call(ctx, panelCookie, 'POST', `/me/interviews/${iv.id}/resume-url`)).statusCode).toBe(404);
    expect((await uploadDocument(ctx, recruiter, a.candidateId, 'cv.pdf', PDF('panel'))).statusCode).toBe(201);

    const row = (await call(ctx, recruiter, 'GET', '/candidate-status')).json().data.find((r: { application_id: string }) => r.application_id === a.applicationId);
    expect(row.resume_document_id).toBeTruthy();
    expect((await call(ctx, panelCookie, 'GET', `/me/interviews/${iv.id}`)).json().data.has_resume).toBe(true);
    const link = await call(ctx, panelCookie, 'POST', `/me/interviews/${iv.id}/resume-url`);
    expect(link.statusCode, link.body).toBe(200);
    const file = await ctx.app.inject({ method: 'GET', url: link.json().data.url });
    expect(file.statusCode).toBe(200);
    expect(file.body).toContain('%PDF');
    expect((await call(ctx, otherCookie, 'POST', `/me/interviews/${iv.id}/resume-url`)).statusCode).toBe(404);
  });
});

describe('job interviewers and panels', () => {
  it('offers only the job interviewers and admins for a panel, and PDFs can be viewed in the browser', async () => {
    const a = await assigned('iiiiiiiii');
    const opts0 = (await call(ctx, recruiter, 'GET', `/applications/${a.applicationId}/panel-options`)).json().data;
    expect(opts0.every((u: { kind: string }) => u.kind === 'admin')).toBe(true);
    expect((await call(ctx, admin, 'POST', `/vacancies/${a.vacancyId}/assign-interviewer`, { user_id: s.users.engManager.id })).statusCode).toBe(200);
    const opts = (await call(ctx, recruiter, 'GET', `/applications/${a.applicationId}/panel-options`)).json().data;
    expect(opts.find((u: { id: string }) => u.id === s.users.engManager.id)?.kind).toBe('interviewer');
    expect(opts.some((u: { id: string }) => u.id === s.users.hr1.id)).toBe(false);
    expect((await call(ctx, recruiter, 'POST', `/vacancies/${a.vacancyId}/assign-interviewer`, { user_id: s.users.hr1.id })).statusCode).toBe(403);

    expect((await uploadDocument(ctx, recruiter, a.candidateId, 'cv.pdf', PDF('view'))).statusCode).toBe(201);
    const row = (await call(ctx, recruiter, 'GET', '/candidate-status')).json().data.find((r: { application_id: string }) => r.application_id === a.applicationId);
    const link = (await call(ctx, recruiter, 'POST', `/candidates/${a.candidateId}/documents/${row.resume_document_id}/download-url`)).json().data.url;
    expect((await ctx.app.inject({ method: 'GET', url: `${link}?view=1` })).headers['content-disposition']).toMatch(/^inline/);
    expect((await ctx.app.inject({ method: 'GET', url: link })).headers['content-disposition']).toMatch(/^attachment/);
  });
});
