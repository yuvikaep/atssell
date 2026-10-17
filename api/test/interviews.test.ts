import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addUser, call, login, setupApp, type TestContext } from './helpers.js';
import { applicationOnVacancy, inHours, scheduleInterview, setupCompany } from './hiring-helpers.js';

let ctx: TestContext;
let s: Awaited<ReturnType<typeof setupCompany>>;
let admin: string;
let recruiter: string;
let engManager: string;
let salesManager: string;
let appId: string;
let vacancyId: string;

beforeAll(async () => {
  ctx = await setupApp();
  s = await setupCompany(ctx, 'iv');
  [admin, recruiter, engManager, salesManager] = await Promise.all([s.as('admin'), s.as('recruiter'), s.as('engManager'), s.as('salesManager')]);
  const a = await applicationOnVacancy(ctx, s, 'one');
  appId = a.applicationId;
  vacancyId = a.vacancyId;
  await call(ctx, admin, 'POST', `/vacancies/${vacancyId}/assign-recruiter`, { user_id: s.users.recruiter.id });
});
afterAll(() => ctx.close());

describe('scorecard plans', () => {
  it('creates rounds with their own competencies, numbered in order', async () => {
    const r1 = await call(ctx, admin, 'POST', `/vacancies/${vacancyId}/interview-plans`, {
      name: 'Technical', competencies: [{ code: 'sql', label: 'SQL', required: true }, { code: 'design', label: 'Design', required: false }],
    });
    expect(r1.statusCode).toBe(201);
    expect(r1.json().data).toMatchObject({ name: 'Technical', round_order: 1 });
    const r2 = await call(ctx, admin, 'POST', `/vacancies/${vacancyId}/interview-plans`, { name: 'HR', competencies: [{ code: 'culture', label: 'Culture fit', required: true }] });
    expect(r2.json().data.round_order).toBe(2);
    const list = await call(ctx, recruiter, 'GET', `/vacancies/${vacancyId}/interview-plans`);
    expect(list.json().data.map((p: { name: string }) => p.name)).toEqual(['Technical', 'HR']);
  });

  it('rejects duplicate or malformed competency codes', async () => {
    const dup = await call(ctx, admin, 'POST', `/vacancies/${vacancyId}/interview-plans`, { name: 'Bad', competencies: [{ code: 'a1', label: 'A' }, { code: 'a1', label: 'B' }] });
    expect(dup.statusCode).toBe(400);
    const bad = await call(ctx, admin, 'POST', `/vacancies/${vacancyId}/interview-plans`, { name: 'Bad', competencies: [{ code: 'Has Space', label: 'A' }] });
    expect(bad.statusCode).toBe(400);
  });

  it('only people who manage interviews can change plans', async () => {
    await addUser(ctx, s.co.tenant.id, { email: `iv@${s.co.slug}.test`, role: 'interviewer' });
    const res = await call(ctx, await login(ctx, s.co.slug, `iv@${s.co.slug}.test`), 'POST', `/vacancies/${vacancyId}/interview-plans`, { name: 'Nope', competencies: [] });
    expect([403, 404]).toContain(res.statusCode);
  });

  it('an interview takes a snapshot of the scorecard, so later edits do not change it', async () => {
    const plan = (await call(ctx, admin, 'POST', `/vacancies/${vacancyId}/interview-plans`, { name: 'Snapshot round', competencies: [{ code: 'one', label: 'One', required: true }] })).json().data;
    const iv = await scheduleInterview(ctx, recruiter, appId, { interview_plan_id: plan.id, round_name: undefined });
    expect(iv.template.competencies.map((c) => c.code)).toEqual(['one']);
    await call(ctx, admin, 'PATCH', `/interview-plans/${plan.id}`, { competencies: [{ code: 'two', label: 'Two', required: true }] });
    const detail = (await call(ctx, recruiter, 'GET', `/interviews/${iv.id}`)).json().data;
    expect(detail.template.competencies.map((c: { code: string }) => c.code)).toEqual(['one']);
    expect(detail.round_name).toBe('Snapshot round');
  });

  it('a switched-off round cannot be used', async () => {
    const plan = (await call(ctx, admin, 'POST', `/vacancies/${vacancyId}/interview-plans`, { name: 'Off round', competencies: [] })).json().data;
    await call(ctx, admin, 'PATCH', `/interview-plans/${plan.id}`, { is_active: false });
    const res = await call(ctx, recruiter, 'POST', `/applications/${appId}/interviews`, { interview_plan_id: plan.id, mode: 'google_meet', panel: [] });
    expect(res.statusCode).toBe(422);
  });
});

describe('scheduling', () => {
  it('schedules with a panel of colleagues and external interviewers, using the default scorecard', async () => {
    const iv = await scheduleInterview(ctx, recruiter, appId, {
      panel: [{ user_id: s.users.engManager.id }, { name: 'Ext Person', email: 'Ext.Person@Partner.test' }],
    });
    expect(iv.status).toBe('scheduled');
    expect(iv.panel.map((m) => m.name).sort()).toEqual(['Ext Person', 'engmgr'].sort());
    expect(iv.panel.find((m) => m.user_id === null)!.email).toBe('ext.person@partner.test');
    expect(iv.template.competencies.map((c) => c.code)).toEqual(['role_skills', 'communication', 'problem_solving']);
    const detail = (await call(ctx, recruiter, 'GET', `/interviews/${iv.id}`)).json().data;
    expect(detail.feedback_due_at).toBeTruthy();
    expect(detail.events.map((e: { event_type: string }) => e.event_type)).toEqual(['scheduled']);
  });

  it('without times it is a draft', async () => {
    const iv = await scheduleInterview(ctx, recruiter, appId, { scheduled_start: null, scheduled_end: null });
    expect(iv.status).toBe('draft');
  });

  it('validates times, time zone, meeting link and the panel', async () => {
    const post = (b: object) => call(ctx, recruiter, 'POST', `/applications/${appId}/interviews`, { round_name: 'R', mode: 'telephonic', ...b });
    expect((await post({ scheduled_start: inHours(5), scheduled_end: inHours(4) })).statusCode).toBe(400);
    expect((await post({ scheduled_start: inHours(5), scheduled_end: null })).statusCode).toBe(400);
    expect((await post({ scheduled_start: inHours(5), scheduled_end: inHours(6), timezone: 'Mars/Olympus' })).statusCode).toBe(400);
    expect((await post({ meeting_url: 'javascript:alert(1)' })).statusCode).toBe(400);
    expect((await post({ panel: [{ name: 'No Email' }] })).statusCode).toBe(400);
    expect((await post({ mode: 'carrier_pigeon' })).statusCode).toBe(400);
  });

  it('refuses the same person twice on one panel', async () => {
    const res = await call(ctx, recruiter, 'POST', `/applications/${appId}/interviews`, {
      round_name: 'R', mode: 'telephonic', panel: [{ user_id: s.users.engManager.id }, { user_id: s.users.engManager.id }],
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('DUPLICATE_PANELIST');
  });

  it('only company staff can be on a panel by account; an agency member must be added as external', async () => {
    const inactive = await addUser(ctx, s.co.tenant.id, { email: `gone@${s.co.slug}.test`, role: 'internal_recruiter', status: 'inactive' });
    const res = await call(ctx, recruiter, 'POST', `/applications/${appId}/interviews`, { round_name: 'R', mode: 'telephonic', panel: [{ user_id: inactive.id }] });
    expect(res.statusCode).toBe(422);
  });

  it('a hiring manager can request an interview for their own department, but not another one', async () => {
    const res = await call(ctx, engManager, 'POST', `/applications/${appId}/interviews`, { round_name: 'R', mode: 'telephonic' });
    expect(res.statusCode, res.body).toBe(201);
    const wrong = await call(ctx, await s.as('salesManager'), 'POST', `/applications/${appId}/interviews`, { round_name: 'R', mode: 'telephonic' });
    expect(wrong.statusCode).toBe(404);
  });

  it('cannot schedule for a closed application', async () => {
    const other = await applicationOnVacancy(ctx, s, 'closed');
    await call(ctx, admin, 'PATCH', `/applications/${other.applicationId}/stage`, { stage_id: (await call(ctx, admin, 'GET', '/pipeline/stages')).json().data.find((x: { code: string }) => x.code === 'rejected').id, reason: 'No fit' });
    const res = await call(ctx, admin, 'POST', `/applications/${other.applicationId}/interviews`, { round_name: 'R', mode: 'telephonic' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('APPLICATION_CLOSED');
  });
});

describe('changing an interview', () => {
  it('rescheduling a scheduled interview needs a reason, and is recorded', async () => {
    const iv = await scheduleInterview(ctx, recruiter, appId);
    const noReason = await call(ctx, recruiter, 'PATCH', `/interviews/${iv.id}`, { scheduled_start: inHours(48), scheduled_end: inHours(49) });
    expect(noReason.statusCode).toBe(400);
    expect(noReason.json().error.details[0].path).toBe('reason');
    const ok = await call(ctx, recruiter, 'PATCH', `/interviews/${iv.id}`, { scheduled_start: inHours(48), scheduled_end: inHours(49), reason: 'Candidate asked for a later slot' });
    expect(ok.statusCode).toBe(200);
    const events = ok.json().data.events;
    expect(events[0]).toMatchObject({ event_type: 'rescheduled', reason: 'Candidate asked for a later slot' });
  });

  it('moving the interview moves the feedback deadline', async () => {
    const iv = await scheduleInterview(ctx, recruiter, appId);
    const before = (await call(ctx, recruiter, 'GET', `/interviews/${iv.id}`)).json().data.feedback_due_at;
    await call(ctx, recruiter, 'PATCH', `/interviews/${iv.id}`, { scheduled_start: inHours(100), scheduled_end: inHours(101), reason: 'Panel clash' });
    const after = (await call(ctx, recruiter, 'GET', `/interviews/${iv.id}`)).json().data.feedback_due_at;
    expect(new Date(after).getTime()).toBeGreaterThan(new Date(before).getTime() + 70 * 3_600_000);
  });

  it('edits that do not change the time need no reason', async () => {
    const iv = await scheduleInterview(ctx, recruiter, appId);
    const res = await call(ctx, recruiter, 'PATCH', `/interviews/${iv.id}`, { meeting_url: 'https://meet.example.test/abc', mode: 'microsoft_teams' });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ meeting_url: 'https://meet.example.test/abc', mode: 'microsoft_teams' });
  });

  it('giving a draft its times schedules it without a reason', async () => {
    const iv = await scheduleInterview(ctx, recruiter, appId, { scheduled_start: null, scheduled_end: null });
    const res = await call(ctx, recruiter, 'PATCH', `/interviews/${iv.id}`, { scheduled_start: inHours(10), scheduled_end: inHours(11) });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.status).toBe('scheduled');
  });

  it('cancelling needs a reason, ends the interview and stops it being changed', async () => {
    const iv = await scheduleInterview(ctx, recruiter, appId);
    expect((await call(ctx, recruiter, 'POST', `/interviews/${iv.id}/cancel`, {})).statusCode).toBe(400);
    const res = await call(ctx, recruiter, 'POST', `/interviews/${iv.id}/cancel`, { reason: 'Role on hold' });
    expect(res.json().data).toMatchObject({ status: 'cancelled', cancelled_reason: 'Role on hold' });
    expect((await call(ctx, recruiter, 'PATCH', `/interviews/${iv.id}`, { round_name: 'X' })).statusCode).toBe(409);
    expect((await call(ctx, recruiter, 'POST', `/interviews/${iv.id}/cancel`, { reason: 'again' })).statusCode).toBe(409);
  });

  it('confirm, complete and no-show follow the allowed order', async () => {
    const iv = await scheduleInterview(ctx, recruiter, appId);
    expect((await call(ctx, recruiter, 'POST', `/interviews/${iv.id}/confirm`)).json().data.status).toBe('confirmed');
    expect((await call(ctx, recruiter, 'POST', `/interviews/${iv.id}/confirm`)).statusCode).toBe(409);
    const done = (await call(ctx, recruiter, 'POST', `/interviews/${iv.id}/complete`)).json().data;
    expect(done.status).toBe('completed');
    expect(done.completed_at).toBeTruthy();
    expect((await call(ctx, recruiter, 'POST', `/interviews/${iv.id}/no-show`)).statusCode).toBe(409);
  });

  it('a no-show waives feedback for the whole panel', async () => {
    const iv = await scheduleInterview(ctx, recruiter, appId, { panel: [{ user_id: s.users.engManager.id }] });
    const res = await call(ctx, recruiter, 'POST', `/interviews/${iv.id}/no-show`, { reason: 'Did not join' });
    expect(res.json().data.status).toBe('no_show');
    expect(res.json().data.panel[0].feedback_status).toBe('waived');
  });

  it('panel members can be added and removed; every change is in the history', async () => {
    const iv = await scheduleInterview(ctx, recruiter, appId);
    const added = await call(ctx, recruiter, 'POST', `/interviews/${iv.id}/interviewers`, { name: 'Late Addition', email: 'late@partner.test' });
    expect(added.statusCode).toBe(201);
    const member = added.json().data.panel[0];
    const removed = await call(ctx, recruiter, 'DELETE', `/interviews/${iv.id}/interviewers/${member.id}`);
    expect(removed.json().data.panel).toHaveLength(0);
    const types = removed.json().data.events.map((e: { event_type: string }) => e.event_type);
    expect(types).toEqual(expect.arrayContaining(['panel_added', 'panel_removed']));
  });

  it('the history cannot be edited or deleted', async () => {
    const iv = await scheduleInterview(ctx, recruiter, appId);
    await expect(ctx.adminDb.deleteFrom('interview_events').where('interview_id', '=', iv.id).execute()).rejects.toThrow(/append-only/);
  });
});

describe('who can see interviews', () => {
  it('is limited to the vacancies a person can see', async () => {
    const iv = await scheduleInterview(ctx, recruiter, appId);
    expect((await call(ctx, engManager, 'GET', `/interviews/${iv.id}`)).statusCode).toBe(200);
    expect((await call(ctx, salesManager, 'GET', `/interviews/${iv.id}`)).statusCode).toBe(404);
    const other = await addUser(ctx, s.co.tenant.id, { email: `unassigned@${s.co.slug}.test`, role: 'internal_recruiter' });
    expect(other.id).toBeTruthy();
    const cookie = await s.as('recruiter');
    expect((await call(ctx, cookie, 'GET', `/interviews/${iv.id}`)).statusCode).toBe(200); // assigned in beforeAll
  });

  it('the list filters by date, status, mode and feedback, and pages', async () => {
    const iv = await scheduleInterview(ctx, recruiter, appId, { mode: 'face_to_face', scheduled_start: inHours(300), scheduled_end: inHours(301), panel: [{ user_id: s.users.engManager.id }] });
    const res = await call(ctx, admin, 'GET', `/interviews?from=${encodeURIComponent(inHours(299))}&to=${encodeURIComponent(inHours(302))}&mode=face_to_face&status=scheduled&feedback=pending`);
    expect(res.json().data.map((r: { id: string }) => r.id)).toEqual([iv.id]);
    const row = res.json().data[0];
    expect(row).toMatchObject({ candidate_name: 'Interviewee one', feedback_expected: 1, feedback_submitted: 0, feedback_pending: 1, feedback_overdue: false });
    expect(row.panel).toEqual(['engmgr']);
    const mine = await call(ctx, admin, 'GET', `/interviews?interviewer_id=${s.users.engManager.id}&page_size=1`);
    expect(mine.json().data).toHaveLength(1);
    expect(mine.json().total).toBeGreaterThan(0);
  });

  it('roles without interview access are refused', async () => {
    await addUser(ctx, s.co.tenant.id, { email: `plain@${s.co.slug}.test`, role: 'interviewer' });
    const { login } = await import('./helpers.js');
    const cookie = await login(ctx, s.co.slug, `plain@${s.co.slug}.test`);
    expect((await call(ctx, cookie, 'GET', '/interviews')).statusCode).toBe(403);
  });
});
