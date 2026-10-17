import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addUser, call, login, setupApp, type TestContext } from './helpers.js';
import { applicationOnVacancy, setupCompany } from './hiring-helpers.js';

let ctx: TestContext;
let s: Awaited<ReturnType<typeof setupCompany>>;
let admin: string;
let engManager: string;
let recruiter: string;
let interviewerId: string;
let interviewerCookie: string;
let applicationId: string;
let vacancyId: string;

beforeAll(async () => {
  ctx = await setupApp();
  s = await setupCompany(ctx, 'nr');
  [admin, engManager, recruiter] = await Promise.all([s.as('admin'), s.as('engManager'), s.as('recruiter')]);
  const a = await applicationOnVacancy(ctx, s, 'a');
  applicationId = a.applicationId;
  vacancyId = a.vacancyId;
  await call(ctx, admin, 'POST', `/vacancies/${vacancyId}/assign-recruiter`, { user_id: s.users.recruiter.id });
  const iv = await addUser(ctx, s.co.tenant.id, { email: `nri@${s.co.slug}.test`, role: 'interviewer' });
  interviewerId = iv.id;
  interviewerCookie = await login(ctx, s.co.slug, `nri@${s.co.slug}.test`);
});
afterAll(() => ctx.close());

const send = (cookie: string, body: object, app = applicationId) => call(ctx, cookie, 'POST', `/applications/${app}/next-round`, body);

describe('sending a candidate to the next round', () => {
  it('needs a remark and at least one interviewer', async () => {
    expect((await send(engManager, { interviewer_user_ids: [interviewerId] })).statusCode).toBe(400);
    expect((await send(engManager, { remark: 'Strong', interviewer_user_ids: [] })).statusCode).toBe(400);
  });

  it('creates an unscheduled round, and the same remark reaches the recruiter and the interviewers', async () => {
    const res = await send(engManager, { round_name: 'Final round', remark: 'Great depth in SQL. Please check leadership.', interviewer_user_ids: [interviewerId, s.users.hr1.id] });
    expect(res.statusCode, res.body).toBe(201);
    const iv = res.json().data;
    expect(iv).toMatchObject({ status: 'draft', round_name: 'Final round', request: { remark: 'Great depth in SQL. Please check leadership.' } });
    expect(iv.panel).toHaveLength(2);

    // Recruiter: notice, to-do and the remark on the interview itself.
    const inbox = (await call(ctx, recruiter, 'GET', '/notifications')).json().data as { type: string; body: string; link: string }[];
    const note = inbox.find((n) => n.type === 'interview.next_round_requested');
    expect(note?.body).toContain('Great depth in SQL');
    expect(note?.link).toBe(`/interviews/${iv.id}`);
    expect(((await call(ctx, recruiter, 'GET', '/tasks?status=open')).json().data as { task_type: string; entity_id: string }[]).some((t) => t.task_type === 'schedule_interview' && t.entity_id === iv.id)).toBe(true);
    expect((await call(ctx, recruiter, 'GET', `/interviews/${iv.id}`)).json().data.request).toMatchObject({ remark: 'Great depth in SQL. Please check leadership.' });

    // Chosen interviewer hears about it too, and the decision is on record with the same remark.
    const theirs = (await call(ctx, interviewerCookie, 'GET', '/notifications')).json().data as { body: string }[];
    expect(theirs.some((n) => n.body.includes('Great depth in SQL'))).toBe(true);
    const decisions = (await call(ctx, engManager, 'GET', `/applications/${applicationId}/decisions`)).json().data as { decision: string; reason: string }[];
    expect(decisions[0]).toMatchObject({ decision: 'additional_round', reason: 'Great depth in SQL. Please check leadership.' });
  });

  it('is limited to hiring managers of that department, and not for closed applications', async () => {
    expect((await send(recruiter, { remark: 'x', interviewer_user_ids: [interviewerId] })).statusCode).toBe(403);
    expect((await send(await s.as('salesManager'), { remark: 'x', interviewer_user_ids: [interviewerId] })).statusCode).toBe(404);
    const other = await applicationOnVacancy(ctx, s, 'bb');
    const stages = (await call(ctx, admin, 'GET', '/pipeline/stages')).json().data as { id: string; code: string }[];
    await call(ctx, admin, 'PATCH', `/applications/${other.applicationId}/stage`, { stage_id: stages.find((x) => x.code === 'rejected')!.id, reason: 'No' });
    expect((await send(engManager, { remark: 'x', interviewer_user_ids: [interviewerId] }, other.applicationId)).json().error.code).toBe('APPLICATION_CLOSED');
  });
});

describe('decision lists', () => {
  it('groups candidates by their latest decision with the remark', async () => {
    const a = await applicationOnVacancy(ctx, s, 'ccc');
    await call(ctx, engManager, 'POST', `/applications/${a.applicationId}/decisions`, { decision: 'hold', reason: 'Waiting on references' });
    await call(ctx, engManager, 'POST', `/applications/${a.applicationId}/decisions`, { decision: 'select', reason: 'References clear' });
    const selected = (await call(ctx, engManager, 'GET', '/decisions?decision=select')).json().data as { application_id: string; reason: string }[];
    expect(selected.find((r) => r.application_id === a.applicationId)).toMatchObject({ reason: 'References clear' });
    const held = (await call(ctx, engManager, 'GET', '/decisions?decision=hold')).json().data as { application_id: string }[];
    expect(held.map((r) => r.application_id)).not.toContain(a.applicationId);
    expect(((await call(ctx, engManager, 'GET', '/decisions')).json().data as unknown[]).length).toBeGreaterThanOrEqual(2);
  });

  it('shows nothing from other companies or departments, and is closed to people with no hiring role', async () => {
    expect(((await call(ctx, await s.as('salesManager'), 'GET', '/decisions')).json().data as unknown[])).toHaveLength(0);
    const other = await setupCompany(ctx, 'nx');
    expect(((await call(ctx, await other.as('admin'), 'GET', '/decisions')).json().data as unknown[])).toHaveLength(0);
    expect((await call(ctx, interviewerCookie, 'GET', '/decisions')).statusCode).toBe(403);
  });
});
