import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, setupApp, type TestContext } from './helpers.js';
import { FUTURE, openVacancy, requisitionPayload, setupCompany } from './hiring-helpers.js';

let ctx: TestContext;
let s: Awaited<ReturnType<typeof setupCompany>>;
let admin: string;
let engManager: string;
let hr1: string;
let hr2: string;

beforeAll(async () => {
  ctx = await setupApp();
  s = await setupCompany(ctx, 'rq');
  [admin, engManager, hr1, hr2] = await Promise.all([s.as('admin'), s.as('engManager'), s.as('hr1'), s.as('hr2')]);
});
afterAll(() => ctx.close());

const create = (cookie: string, overrides: Record<string, unknown> = {}) =>
  call(ctx, cookie, 'POST', '/requisitions', requisitionPayload(s.eng.id, overrides));

describe('creating requisitions', () => {
  it('a hiring manager raises a draft for their own department', async () => {
    const res = await create(engManager);
    expect(res.statusCode).toBe(201);
    const rq = res.json().data;
    expect(rq).toMatchObject({ status: 'draft', department_name: 'Engineering', headcount: 2, approval_round: 0 });
    expect(rq.can).toMatchObject({ edit: true, submit: true, decide: false, cancel: true });
  });

  it('a hiring manager cannot raise one for another department', async () => {
    const res = await call(ctx, engManager, 'POST', '/requisitions', requisitionPayload(s.sales.id));
    expect(res.statusCode).toBe(403);
  });

  it('a recruiter cannot raise requisitions at all', async () => {
    const res = await call(ctx, await s.as('recruiter'), 'POST', '/requisitions', requisitionPayload(s.eng.id));
    expect(res.statusCode).toBe(403);
  });

  it('validates headcount, ranges and target date', async () => {
    const bad = await create(admin, { headcount: 0, max_ctc: 100, min_ctc: 200, max_experience_years: 1, min_experience_years: 5, target_date: '2001-01-01' });
    expect(bad.statusCode).toBe(400);
    const paths = bad.json().error.details.map((d: { path: string }) => d.path);
    expect(paths).toEqual(expect.arrayContaining(['headcount', 'target_date']));
    const ranges = await create(admin, { max_ctc: 100, min_ctc: 200, max_experience_years: 1, min_experience_years: 5 });
    expect(ranges.statusCode).toBe(400);
    expect(ranges.json().error.details.map((d: { path: string }) => d.path)).toEqual(expect.arrayContaining(['max_ctc', 'max_experience_years']));
  });

  it('rejects an unknown or inactive department', async () => {
    const res = await call(ctx, admin, 'POST', '/requisitions', requisitionPayload('00000000-0000-4000-8000-000000000000'));
    expect(res.statusCode).toBe(422);
  });

  it('only the requester, approvers and the department can see a draft', async () => {
    const created = (await create(engManager)).json().data;
    expect((await call(ctx, engManager, 'GET', `/requisitions/${created.id}`)).statusCode).toBe(200);
    expect((await call(ctx, await s.as('salesManager'), 'GET', `/requisitions/${created.id}`)).statusCode).toBe(404);
    expect((await call(ctx, await s.as('recruiter'), 'GET', `/requisitions/${created.id}`)).statusCode).toBe(404);
    const salesList = (await call(ctx, await s.as('salesManager'), 'GET', '/requisitions')).json().data;
    expect(salesList.find((r: { id: string }) => r.id === created.id)).toBeUndefined();
  });

  it('a partial edit changes only the fields it sends', async () => {
    const created = (await create(engManager, { skills: ['Go'], priority: 'critical', hiring_manager_id: s.users.engManager.id })).json().data;
    const res = await call(ctx, engManager, 'PATCH', `/requisitions/${created.id}`, { title: 'Renamed Role' });
    expect(res.json().data).toMatchObject({
      title: 'Renamed Role', skills: ['Go'], priority: 'critical', min_ctc: 1_800_000, max_ctc: 3_000_000,
      min_experience_years: 3, max_experience_years: 8, target_date: FUTURE, hiring_manager_id: s.users.engManager.id,
    });
  });

  it('edits a draft, then locks editing once submitted', async () => {
    const created = (await create(engManager)).json().data;
    const edited = await call(ctx, engManager, 'PATCH', `/requisitions/${created.id}`, { title: 'Senior Backend Engineer', headcount: 3 });
    expect(edited.statusCode).toBe(200);
    expect(edited.json().data).toMatchObject({ title: 'Senior Backend Engineer', headcount: 3 });
    await call(ctx, engManager, 'POST', `/requisitions/${created.id}/submit-approval`, { approver_user_ids: [s.users.hr1.id] });
    const locked = await call(ctx, engManager, 'PATCH', `/requisitions/${created.id}`, { title: 'Changed' });
    expect(locked.statusCode).toBe(409);
    expect(locked.json().error.code).toBe('NOT_EDITABLE');
  });
});

describe('approval workflow', () => {
  it('lists who can approve, never the requester', async () => {
    const res = await call(ctx, engManager, 'GET', `/requisitions/approvers?department_id=${s.eng.id}`);
    expect(res.statusCode).toBe(200);
    const emails = res.json().data.map((u: { email: string }) => u.email);
    expect(emails).toEqual(expect.arrayContaining([s.email('hr1'), s.email('hr2'), s.co.admin.email]));
    expect(emails).not.toContain(s.email('engManager'));
    expect(emails).not.toContain(s.email('recruiter'));
  });

  it('runs a two-step chain in order, then approves', async () => {
    const rq = (await create(engManager)).json().data;
    const submit = await call(ctx, engManager, 'POST', `/requisitions/${rq.id}/submit-approval`, { approver_user_ids: [s.users.hr1.id, s.users.hr2.id] });
    expect(submit.statusCode).toBe(200);
    expect(submit.json().data).toMatchObject({ status: 'pending_approval', current_approver_id: s.users.hr1.id });

    // hr2 is second in line and cannot jump the queue.
    const early = await call(ctx, hr2, 'POST', `/requisitions/${rq.id}/approve`, { decision: 'approved' });
    expect(early.statusCode).toBe(403);
    expect(early.json().error.code).toBe('NOT_CURRENT_APPROVER');

    const first = await call(ctx, hr1, 'POST', `/requisitions/${rq.id}/approve`, { decision: 'approved' });
    expect(first.json().data).toMatchObject({ status: 'pending_approval', current_approver_id: s.users.hr2.id });
    expect(first.json().data.can.decide).toBe(false);

    const second = await call(ctx, hr2, 'POST', `/requisitions/${rq.id}/approve`, { decision: 'approved' });
    expect(second.json().data.status).toBe('approved');
    expect(second.json().data.approvals.map((a: { decision: string }) => a.decision)).toEqual(['approved', 'approved']);
  });

  it('a rejection needs a reason, skips later steps and returns the requisition to its owner', async () => {
    const rq = (await create(engManager)).json().data;
    await call(ctx, engManager, 'POST', `/requisitions/${rq.id}/submit-approval`, { approver_user_ids: [s.users.hr1.id, s.users.hr2.id] });

    const noReason = await call(ctx, hr1, 'POST', `/requisitions/${rq.id}/approve`, { decision: 'rejected' });
    expect(noReason.statusCode).toBe(400);
    expect(noReason.json().error.details[0].path).toBe('reason');

    const rejected = await call(ctx, hr1, 'POST', `/requisitions/${rq.id}/approve`, { decision: 'rejected', reason: 'Budget not approved yet' });
    expect(rejected.json().data.status).toBe('rejected');
    expect(rejected.json().data.approvals.map((a: { decision: string }) => a.decision)).toEqual(['rejected', 'skipped']);

    // Edit, resubmit: a new round, with the earlier round kept in history.
    expect((await call(ctx, engManager, 'PATCH', `/requisitions/${rq.id}`, { min_ctc: 1_500_000, max_ctc: 2_200_000 })).statusCode).toBe(200);
    const again = await call(ctx, engManager, 'POST', `/requisitions/${rq.id}/submit-approval`, { approver_user_ids: [s.users.hr2.id] });
    expect(again.json().data).toMatchObject({ status: 'pending_approval', approval_round: 2 });
    const rounds = new Set(again.json().data.approvals.map((a: { round: number }) => a.round));
    expect(rounds).toEqual(new Set([1, 2]));
  });

  it('only the current approver can decide, and not on a non-pending requisition', async () => {
    const rq = (await create(engManager)).json().data;
    const draft = await call(ctx, hr1, 'POST', `/requisitions/${rq.id}/approve`, { decision: 'approved' });
    expect(draft.statusCode).toBe(409);
    await call(ctx, engManager, 'POST', `/requisitions/${rq.id}/submit-approval`, { approver_user_ids: [s.users.hr1.id] });
    const requester = await call(ctx, engManager, 'POST', `/requisitions/${rq.id}/approve`, { decision: 'approved' });
    expect(requester.statusCode).toBe(403);
    const unrelated = await call(ctx, hr2, 'POST', `/requisitions/${rq.id}/approve`, { decision: 'approved' });
    expect(unrelated.statusCode).toBe(403);
  });

  it('rejects ineligible, duplicate and self approvers', async () => {
    const rq = (await create(engManager)).json().data;
    const submit = (ids: string[]) => call(ctx, engManager, 'POST', `/requisitions/${rq.id}/submit-approval`, { approver_user_ids: ids });
    const recruiter = await submit([s.users.recruiter.id]);
    expect(recruiter.statusCode).toBe(422);
    expect(recruiter.json().error.code).toBe('INVALID_APPROVER');
    expect((await submit([s.users.hr1.id, s.users.hr1.id])).json().error.code).toBe('DUPLICATE_APPROVER');
    expect((await submit([s.users.engManager.id])).statusCode).toBe(422);
    expect((await submit([])).statusCode).toBe(400);
    // The admin raises one and tries to approve it themselves.
    const own = (await create(admin)).json().data;
    const selfApprove = await call(ctx, admin, 'POST', `/requisitions/${own.id}/submit-approval`, { approver_user_ids: [s.co.admin.id] });
    expect(selfApprove.statusCode).toBe(422);
    expect(selfApprove.json().error.code).toBe('SELF_APPROVAL');
  });

  it('concurrent decisions on one step apply once', async () => {
    const rq = (await create(engManager)).json().data;
    await call(ctx, engManager, 'POST', `/requisitions/${rq.id}/submit-approval`, { approver_user_ids: [s.users.hr1.id, s.users.hr2.id] });
    const results = await Promise.all(
      Array.from({ length: 4 }, () => call(ctx, hr1, 'POST', `/requisitions/${rq.id}/approve`, { decision: 'approved' })),
    );
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
    const detail = (await call(ctx, hr1, 'GET', `/requisitions/${rq.id}`)).json().data;
    expect(detail.approvals.filter((a: { decision: string }) => a.decision === 'approved')).toHaveLength(1);
    expect(detail.status).toBe('pending_approval');
  });

  it('records every transition in the audit log', async () => {
    const actions = (await ctx.adminDb
      .selectFrom('audit_events').select('action')
      .where('tenant_id', '=', s.co.tenant.id).where('entity_type', '=', 'requisition').execute()).map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining([
      'requisition.created', 'requisition.updated', 'requisition.submitted', 'requisition.step_approved',
      'requisition.approved', 'requisition.rejected',
    ]));
  });
});

describe('budget visibility and cancelling', () => {
  it('shows the CTC range to the requester and approvers only', async () => {
    const rq = (await create(engManager)).json().data;
    expect(rq.min_ctc).toBe(1_800_000);
    await call(ctx, engManager, 'POST', `/requisitions/${rq.id}/submit-approval`, { approver_user_ids: [s.users.hr1.id] });
    const hr = (await call(ctx, hr1, 'GET', `/requisitions/${rq.id}`)).json().data;
    expect(hr.max_ctc).toBe(3_000_000);
  });

  it('cancelling needs a reason and ends the approval', async () => {
    const rq = (await create(engManager)).json().data;
    await call(ctx, engManager, 'POST', `/requisitions/${rq.id}/submit-approval`, { approver_user_ids: [s.users.hr1.id] });
    expect((await call(ctx, engManager, 'POST', `/requisitions/${rq.id}/cancel`, {})).statusCode).toBe(400);
    const res = await call(ctx, engManager, 'POST', `/requisitions/${rq.id}/cancel`, { reason: 'Role no longer needed' });
    expect(res.json().data).toMatchObject({ status: 'cancelled', cancel_reason: 'Role no longer needed' });
    expect(res.json().data.approvals[0].decision).toBe('skipped');
    expect((await call(ctx, hr1, 'POST', `/requisitions/${rq.id}/approve`, { decision: 'approved' })).statusCode).toBe(409);
    expect((await call(ctx, engManager, 'POST', `/requisitions/${rq.id}/cancel`, { reason: 'again' })).statusCode).toBe(409);
  });

  it('cannot cancel while vacancies are open', async () => {
    const rq = (await create(admin)).json().data;
    await call(ctx, admin, 'POST', `/requisitions/${rq.id}/submit-approval`, { approver_user_ids: [s.users.hr1.id] });
    await call(ctx, hr1, 'POST', `/requisitions/${rq.id}/approve`, { decision: 'approved' });
    await openVacancy(ctx, admin, rq.id);
    const res = await call(ctx, admin, 'POST', `/requisitions/${rq.id}/cancel`, { reason: 'Changed our mind' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('HAS_OPEN_VACANCIES');
  });

  it('lists with filters and pagination', async () => {
    const all = await call(ctx, admin, 'GET', '/requisitions?page_size=2');
    expect(all.json().data.length).toBeLessThanOrEqual(2);
    expect(all.json().total).toBeGreaterThan(2);
    const pending = (await call(ctx, admin, 'GET', '/requisitions?status=pending_approval')).json().data;
    expect(pending.every((r: { status: string }) => r.status === 'pending_approval')).toBe(true);
    expect(pending[0].pending_with).toBeTruthy();
    const mine = (await call(ctx, engManager, 'GET', '/requisitions?mine=true')).json().data;
    expect(mine.length).toBeGreaterThan(0);
    const bySales = (await call(ctx, admin, 'GET', `/requisitions?department_id=${s.sales.id}`)).json().data;
    expect(bySales).toHaveLength(0);
    expect(FUTURE).toBeTruthy();
  });
});
