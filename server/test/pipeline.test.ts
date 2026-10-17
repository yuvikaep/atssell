import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, setupApp, type TestContext } from './helpers.js';
import { approvedRequisition, openVacancy, setupCompany } from './hiring-helpers.js';

let ctx: TestContext;
let s: Awaited<ReturnType<typeof setupCompany>>;
let admin: string;
let recruiter: string;
let engManager: string;
let stages: Record<string, { id: string; next: { stage_id: string; requires_reason: boolean }[] }>;

const newCandidate = async (n: string) =>
  (await call(ctx, admin, 'POST', '/candidates', { full_name: `Pipeline ${n}`, email: `pipeline.${n}@mail.test` })).json().data.id as string;
const newVacancy = async () => (await openVacancy(ctx, admin, await approvedRequisition(ctx, s))).id;
const apply = (cookie: string, candidate_id: string, vacancy_id: string, extra: object = {}) =>
  call(ctx, cookie, 'POST', '/applications', { candidate_id, vacancy_id, ...extra });
const move = (cookie: string, id: string, stage: string, reason?: string) =>
  call(ctx, cookie, 'PATCH', `/applications/${id}/stage`, { stage_id: stages[stage]!.id, ...(reason ? { reason } : {}) });

beforeAll(async () => {
  ctx = await setupApp();
  s = await setupCompany(ctx, 'pipe');
  [admin, recruiter, engManager] = await Promise.all([s.as('admin'), s.as('recruiter'), s.as('engManager')]);
  const list = (await call(ctx, admin, 'GET', '/pipeline/stages')).json().data as { id: string; code: string; next: { stage_id: string; requires_reason: boolean }[] }[];
  stages = Object.fromEntries(list.map((st) => [st.code, st]));
});
afterAll(() => ctx.close());

describe('pipeline stages', () => {
  it('provides a default pipeline with allowed moves', async () => {
    const list = (await call(ctx, admin, 'GET', '/pipeline/stages')).json().data;
    expect(list.map((x: { code: string }) => x.code)).toEqual(['submitted', 'screening', 'shortlisted', 'interview', 'offer', 'hired', 'rejected', 'withdrawn']);
    expect(list[0].is_initial).toBe(true);
    const toRejected = stages.screening!.next.find((n) => n.stage_id === stages.rejected!.id);
    expect(toRejected?.requires_reason).toBe(true);
  });
});

describe('adding candidates to vacancies', () => {
  it('creates an application at the first stage, with history and a source record', async () => {
    const [c, v] = [await newCandidate('one'), await newVacancy()];
    const res = await apply(admin, c, v, { source_type: 'referral', source_reference: 'Referred by Meera' });
    expect(res.statusCode).toBe(201);
    const id = res.json().data.id;

    const list = (await call(ctx, admin, 'GET', `/applications?vacancy_id=${v}`)).json().data;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ stage_code: 'submitted', candidate_name: 'Pipeline one', source_type: 'referral' });

    const history = (await call(ctx, admin, 'GET', `/applications/${id}/history`)).json().data;
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ from_stage: null, to_stage: 'Submitted', actor_name: 'Admin User' });

    const sub = await ctx.adminDb.selectFrom('submissions').selectAll().where('application_id', '=', id).executeTakeFirstOrThrow();
    expect(sub).toMatchObject({ source_type: 'referral', source_reference: 'Referred by Meera', ownership_state: 'accepted' });
  });

  it('refuses a second active application for the same candidate and vacancy', async () => {
    const [c, v] = [await newCandidate('twice'), await newVacancy()];
    await apply(admin, c, v);
    const dup = await apply(admin, c, v);
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe('ALREADY_APPLIED');
  });

  it('concurrent adds create exactly one application', async () => {
    const [c, v] = [await newCandidate('race'), await newVacancy()];
    const results = await Promise.all(Array.from({ length: 5 }, () => apply(admin, c, v)));
    expect(results.filter((r) => r.statusCode === 201)).toHaveLength(1);
  });

  it('only open vacancies take candidates', async () => {
    const [c, v] = [await newCandidate('closed'), await newVacancy()];
    await call(ctx, admin, 'PATCH', `/vacancies/${v}`, { status: 'closed' });
    const res = await apply(admin, c, v);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('VACANCY_NOT_OPEN');
  });

  it('a recruiter can only add to vacancies assigned to them', async () => {
    const [c, v] = [await newCandidate('assigned'), await newVacancy()];
    expect((await apply(recruiter, c, v)).statusCode).toBe(404);
    await call(ctx, admin, 'POST', `/vacancies/${v}/assign-recruiter`, { user_id: s.users.recruiter.id });
    expect((await apply(recruiter, c, v)).statusCode).toBe(201);
  });

  it('a hiring manager cannot move candidates through the pipeline', async () => {
    const [c, v] = [await newCandidate('hm'), await newVacancy()];
    expect((await apply(engManager, c, v)).statusCode).toBe(403);
    const id = (await apply(admin, c, v)).json().data.id;
    expect((await move(engManager, id, 'screening')).statusCode).toBe(403);
  });

  it('will not add a merged candidate', async () => {
    const [a, b, v] = [await newCandidate('keep'), await newCandidate('gone'), await newVacancy()];
    await call(ctx, admin, 'POST', `/candidates/${a}/merge`, { source_candidate_id: b, reason: 'Duplicate' });
    const res = await apply(admin, b, v);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('CANDIDATE_NOT_ACTIVE');
  });
});

describe('moving through stages', () => {
  it('follows the allowed path, logging each move', async () => {
    const [c, v] = [await newCandidate('path'), await newVacancy()];
    const id = (await apply(admin, c, v)).json().data.id;
    for (const stage of ['screening', 'shortlisted', 'interview']) {
      const res = await move(admin, id, stage);
      expect(res.statusCode).toBe(200);
      expect(res.json().data).toMatchObject({ stage_id: stages[stage]!.id, status: 'active' });
    }
    const history = (await call(ctx, admin, 'GET', `/applications/${id}/history`)).json().data;
    expect(history.map((h: { to_stage: string }) => h.to_stage)).toEqual(['Interview', 'Shortlisted', 'Screening', 'Submitted']);
    expect(history[0]).toMatchObject({ from_stage: 'Shortlisted' });
  });

  it('rejects moves the pipeline does not allow', async () => {
    const [c, v] = [await newCandidate('skip'), await newVacancy()];
    const id = (await apply(admin, c, v)).json().data.id;
    const res = await move(admin, id, 'offer');
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('TRANSITION_NOT_ALLOWED');
    expect((await move(admin, id, 'submitted')).statusCode).toBe(409);
  });

  it('needs a reason to reject, and rejecting closes the application', async () => {
    const [c, v] = [await newCandidate('reject'), await newVacancy()];
    const id = (await apply(admin, c, v)).json().data.id;
    await move(admin, id, 'screening');
    const noReason = await move(admin, id, 'rejected');
    expect(noReason.statusCode).toBe(400);
    expect(noReason.json().error.details[0].path).toBe('reason');

    const res = await move(admin, id, 'rejected', 'Not enough backend experience');
    expect(res.json().data).toMatchObject({ status: 'rejected', disposition_reason: 'Not enough backend experience' });

    const closed = await move(admin, id, 'shortlisted');
    expect(closed.statusCode).toBe(409);
    expect(closed.json().error.code).toBe('APPLICATION_CLOSED');
  });

  it('a rejected candidate can be added to the same vacancy again, keeping the old history', async () => {
    const [c, v] = [await newCandidate('reapply'), await newVacancy()];
    const first = (await apply(admin, c, v)).json().data.id;
    await move(admin, first, 'rejected', 'Wrong location');
    const second = await apply(admin, c, v);
    expect(second.statusCode).toBe(201);
    const all = (await call(ctx, admin, 'GET', `/applications?candidate_id=${c}&status=all`)).json().data;
    expect(all.map((a: { status: string }) => a.status).sort()).toEqual(['active', 'rejected']);
    expect((await call(ctx, admin, 'GET', `/applications/${first}/history`)).json().data).toHaveLength(2);
  });

  it('reaching Hired marks the application hired', async () => {
    const [c, v] = [await newCandidate('hired'), await newVacancy()];
    const id = (await apply(admin, c, v)).json().data.id;
    for (const stage of ['screening', 'shortlisted', 'interview', 'offer']) await move(admin, id, stage);
    const res = await move(admin, id, 'hired');
    expect(res.json().data.status).toBe('hired');
  });

  it('concurrent identical moves apply once', async () => {
    const [c, v] = [await newCandidate('moverace'), await newVacancy()];
    const id = (await apply(admin, c, v)).json().data.id;
    const results = await Promise.all(Array.from({ length: 4 }, () => move(admin, id, 'screening')));
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
    expect(results.filter((r) => r.statusCode === 409)).toHaveLength(3);
    const history = (await call(ctx, admin, 'GET', `/applications/${id}/history`)).json().data;
    expect(history).toHaveLength(2);
  });

  it('stage history cannot be edited or deleted', async () => {
    const [c, v] = [await newCandidate('immutable'), await newVacancy()];
    const id = (await apply(admin, c, v)).json().data.id;
    await expect(ctx.adminDb.deleteFrom('application_stage_events').where('application_id', '=', id).execute()).rejects.toThrow(/append-only/);
    await expect(ctx.adminDb.updateTable('application_stage_events').set({ reason: 'edited' }).where('application_id', '=', id).execute()).rejects.toThrow(/append-only/);
  });

  it('audits creation and every move', async () => {
    const actions = (await ctx.adminDb.selectFrom('audit_events').select('action').where('tenant_id', '=', s.co.tenant.id).where('entity_type', '=', 'application').execute()).map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['application.created', 'application.stage_changed']));
  });
});

describe('kanban data', () => {
  it('lists a vacancy applications with stage counts on the vacancy', async () => {
    const v = await newVacancy();
    const [a, b, c] = [await newCandidate('k1'), await newCandidate('k2'), await newCandidate('k3')];
    const ids = [];
    for (const cand of [a, b, c]) ids.push((await apply(admin, cand, v)).json().data.id);
    await move(admin, ids[0], 'screening');
    const detail = (await call(ctx, admin, 'GET', `/vacancies/${v}`)).json().data;
    const counts = Object.fromEntries(detail.stage_counts.map((x: { code: string; count: number }) => [x.code, x.count]));
    expect(counts).toEqual({ submitted: 2, screening: 1 });
    const byStage = (await call(ctx, admin, 'GET', `/applications?vacancy_id=${v}&stage_id=${stages.screening!.id}`)).json();
    expect(byStage.total).toBe(1);
  });
});
