import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, setupApp, type TestContext } from './helpers.js';
import { approvedRequisition, openVacancy, requisitionPayload, setupCompany } from './hiring-helpers.js';

let ctx: TestContext;
let s: Awaited<ReturnType<typeof setupCompany>>;
let admin: string;
let engManager: string;
let salesManager: string;
let recruiter: string;

beforeAll(async () => {
  ctx = await setupApp();
  s = await setupCompany(ctx, 'vac');
  [admin, engManager, salesManager, recruiter] = await Promise.all([s.as('admin'), s.as('engManager'), s.as('salesManager'), s.as('recruiter')]);
});
afterAll(() => ctx.close());

describe('opening vacancies', () => {
  it('opens a vacancy from an approved requisition with a generated code', async () => {
    const rq = await approvedRequisition(ctx, s, { headcount: 3 });
    const res = await call(ctx, admin, 'POST', `/requisitions/${rq}/vacancies`, { headcount: 1 });
    expect(res.statusCode).toBe(201);
    const v = res.json().data;
    expect(v.vacancy_code).toMatch(/^VAC-\d{4}$/);
    expect(v).toMatchObject({ title: 'Backend Engineer', location: 'Pune', headcount: 1, status: 'open', department_name: 'Engineering' });
    expect(v.owner_name).toBe('Admin User');
  });

  it('refuses a requisition that is not approved', async () => {
    const draft = (await call(ctx, admin, 'POST', '/requisitions', requisitionPayload(s.eng.id))).json().data;
    const res = await call(ctx, admin, 'POST', `/requisitions/${draft.id}/vacancies`, {});
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('NOT_APPROVED');
  });

  it('needs vacancies.manage', async () => {
    const rq = await approvedRequisition(ctx, s, { requesterCookie: engManager });
    const res = await call(ctx, engManager, 'POST', `/requisitions/${rq}/vacancies`, {});
    expect(res.statusCode).toBe(403);
  });

  it('never opens more positions than the requisition approved', async () => {
    const rq = await approvedRequisition(ctx, s, { headcount: 3 });
    await openVacancy(ctx, admin, rq, { headcount: 2 });
    const over = await call(ctx, admin, 'POST', `/requisitions/${rq}/vacancies`, { headcount: 2 });
    expect(over.statusCode).toBe(422);
    expect(over.json().error.code).toBe('HEADCOUNT_EXCEEDED');
    const rest = await openVacancy(ctx, admin, rq); // defaults to the 1 position left
    expect((await call(ctx, admin, 'GET', `/vacancies/${rest.id}`)).json().data.headcount).toBe(1);
    expect((await call(ctx, admin, 'POST', `/requisitions/${rq}/vacancies`, {})).statusCode).toBe(422);
  });

  it('concurrent openings cannot exceed the headcount', async () => {
    const rq = await approvedRequisition(ctx, s, { headcount: 2 });
    const results = await Promise.all(
      Array.from({ length: 5 }, () => call(ctx, admin, 'POST', `/requisitions/${rq}/vacancies`, { headcount: 1 })),
    );
    expect(results.filter((r) => r.statusCode === 201)).toHaveLength(2);
    const codes = results.filter((r) => r.statusCode === 201).map((r) => r.json().data.vacancy_code);
    expect(new Set(codes).size).toBe(2);
  });

  it('shows the requisition progress once vacancies exist', async () => {
    const rq = await approvedRequisition(ctx, s, { headcount: 2 });
    await openVacancy(ctx, admin, rq, { headcount: 1 });
    const detail = (await call(ctx, admin, 'GET', `/requisitions/${rq}`)).json().data;
    expect(detail.headcount_allocated).toBe(1);
    expect(detail.vacancies).toHaveLength(1);
    expect(detail.can.open_vacancy).toBe(true);
  });
});

describe('vacancy status', () => {
  it('on hold and cancel need a reason; closed can reopen; cancelled is final', async () => {
    const v = await openVacancy(ctx, admin, await approvedRequisition(ctx, s));
    const patch = (body: object) => call(ctx, admin, 'PATCH', `/vacancies/${v.id}`, body);

    const noReason = await patch({ status: 'on_hold' });
    expect(noReason.statusCode).toBe(400);
    expect((await patch({ status: 'on_hold', status_reason: 'Waiting for budget' })).json().data.status).toBe('on_hold');
    expect((await patch({ status: 'open' })).json().data.status).toBe('open');
    const closed = (await patch({ status: 'closed' })).json().data;
    expect(closed.status).toBe('closed');
    expect(closed.closed_at).toBeTruthy();
    const reopened = (await patch({ status: 'open' })).json().data;
    expect(reopened).toMatchObject({ status: 'open', closed_at: null });

    expect((await patch({ status: 'cancelled', status_reason: 'Role removed' })).json().data.status).toBe('cancelled');
    const final = await patch({ status: 'open' });
    expect(final.statusCode).toBe(409);
    expect(final.json().error.code).toBe('INVALID_TRANSITION');
  });

  it('editing headcount respects the requisition total', async () => {
    const rq = await approvedRequisition(ctx, s, { headcount: 2 });
    const a = await openVacancy(ctx, admin, rq, { headcount: 1 });
    await openVacancy(ctx, admin, rq, { headcount: 1 });
    const over = await call(ctx, admin, 'PATCH', `/vacancies/${a.id}`, { headcount: 2 });
    expect(over.statusCode).toBe(422);
    expect((await call(ctx, admin, 'PATCH', `/vacancies/${a.id}`, { headcount: 1, title: 'Platform Engineer' })).json().data.title).toBe('Platform Engineer');
  });

  it('a hiring manager can view but not change a vacancy', async () => {
    const v = await openVacancy(ctx, admin, await approvedRequisition(ctx, s));
    expect((await call(ctx, engManager, 'GET', `/vacancies/${v.id}`)).statusCode).toBe(200);
    expect((await call(ctx, engManager, 'PATCH', `/vacancies/${v.id}`, { title: 'Nope' })).statusCode).toBe(403);
  });
});

describe('access', () => {
  it('a department-scoped manager sees only their department vacancies', async () => {
    const engVacancy = await openVacancy(ctx, admin, await approvedRequisition(ctx, s));
    const salesVacancy = await openVacancy(ctx, admin, await approvedRequisition(ctx, s, { departmentId: s.sales.id }));
    const ids = (cookie: string) => call(ctx, cookie, 'GET', '/vacancies?status=all&page_size=100').then((r) => r.json().data.map((x: { id: string }) => x.id));

    const eng = await ids(engManager);
    expect(eng).toContain(engVacancy.id);
    expect(eng).not.toContain(salesVacancy.id);
    expect((await call(ctx, engManager, 'GET', `/vacancies/${salesVacancy.id}`)).statusCode).toBe(404);
    const sales = await ids(salesManager);
    expect(sales).toContain(salesVacancy.id);
    expect(sales).not.toContain(engVacancy.id);
  });

  it('a recruiter sees only vacancies assigned to them, and loses access when unassigned', async () => {
    const v = await openVacancy(ctx, admin, await approvedRequisition(ctx, s));
    const list = () => call(ctx, recruiter, 'GET', '/vacancies?status=all&page_size=100').then((r) => r.json().data.map((x: { id: string }) => x.id));
    expect(await list()).not.toContain(v.id);
    expect((await call(ctx, recruiter, 'GET', `/vacancies/${v.id}`)).statusCode).toBe(404);

    const assign = await call(ctx, admin, 'POST', `/vacancies/${v.id}/assign-recruiter`, { user_id: s.users.recruiter.id });
    expect(assign.statusCode).toBe(200);
    expect(assign.json().data.recruiters.map((r: { id: string }) => r.id)).toEqual([s.users.recruiter.id]);
    expect(await list()).toContain(v.id);
    expect((await call(ctx, recruiter, 'GET', `/vacancies/${v.id}`)).statusCode).toBe(200);
    // The recruiter can see it but not manage it.
    expect((await call(ctx, recruiter, 'PATCH', `/vacancies/${v.id}`, { title: 'Nope' })).statusCode).toBe(403);

    const dup = await call(ctx, admin, 'POST', `/vacancies/${v.id}/assign-recruiter`, { user_id: s.users.recruiter.id });
    expect(dup.statusCode).toBe(409);

    await call(ctx, admin, 'POST', `/vacancies/${v.id}/unassign-recruiter`, { user_id: s.users.recruiter.id });
    expect(await list()).not.toContain(v.id);
  });

  it('filters the list by status, recruiter, department and text', async () => {
    const v = await openVacancy(ctx, admin, await approvedRequisition(ctx, s), { title: 'Distinctive Unicorn Wrangler' });
    await call(ctx, admin, 'POST', `/vacancies/${v.id}/assign-recruiter`, { user_id: s.users.recruiter.id });
    const q = await call(ctx, admin, 'GET', '/vacancies?q=unicorn');
    expect(q.json().data.map((x: { id: string }) => x.id)).toEqual([v.id]);
    expect(q.json().data[0].recruiters).toEqual(['rec']);
    const byRecruiter = await call(ctx, admin, 'GET', `/vacancies?recruiter_id=${s.users.recruiter.id}&status=all&page_size=100`);
    expect(byRecruiter.json().data.map((x: { id: string }) => x.id)).toContain(v.id);
    const none = await call(ctx, admin, 'GET', `/vacancies?department_id=${s.sales.id}&q=unicorn`);
    expect(none.json().total).toBe(0);
    const closed = await call(ctx, admin, 'GET', '/vacancies?status=closed&q=unicorn');
    expect(closed.json().total).toBe(0);
  });

  it('only company users can be assigned as recruiters', async () => {
    const v = await openVacancy(ctx, admin, await approvedRequisition(ctx, s));
    await ctx.adminDb.updateTable('users').set({ status: 'inactive' }).where('id', '=', s.users.salesManager.id).execute();
    const res = await call(ctx, admin, 'POST', `/vacancies/${v.id}/assign-recruiter`, { user_id: s.users.salesManager.id });
    expect(res.statusCode).toBe(422);
    await ctx.adminDb.updateTable('users').set({ status: 'active' }).where('id', '=', s.users.salesManager.id).execute();
  });
});

describe('agencies on vacancies', () => {
  it('creates agencies, assigns them, and hides them from users who cannot manage', async () => {
    const created = await call(ctx, admin, 'POST', '/agencies', { name: 'TalentBridge', primary_contact_email: 'ops@talentbridge.test' });
    expect(created.statusCode).toBe(201);
    const agencyId = created.json().data.id;
    expect((await call(ctx, admin, 'POST', '/agencies', { name: 'TalentBridge' })).json().error.code).toBe('AGENCY_NAME_TAKEN');
    expect((await call(ctx, engManager, 'GET', '/agencies')).statusCode).toBe(403);

    const v = await openVacancy(ctx, admin, await approvedRequisition(ctx, s));
    const assigned = await call(ctx, admin, 'POST', `/vacancies/${v.id}/assign-agency`, { agency_id: agencyId });
    expect(assigned.json().data.agencies.map((a: { name: string }) => a.name)).toEqual(['TalentBridge']);
    expect((await call(ctx, admin, 'POST', `/vacancies/${v.id}/assign-agency`, { agency_id: agencyId })).statusCode).toBe(409);
    expect((await call(ctx, engManager, 'POST', `/vacancies/${v.id}/assign-agency`, { agency_id: agencyId })).statusCode).toBe(403);

    const list = (await call(ctx, admin, 'GET', `/agencies`)).json().data.find((a: { id: string }) => a.id === agencyId);
    expect(list.assigned_vacancies).toBe(1);

    await call(ctx, admin, 'POST', `/vacancies/${v.id}/unassign-agency`, { agency_id: agencyId });
    expect((await call(ctx, admin, 'GET', `/vacancies/${v.id}`)).json().data.agencies).toHaveLength(0);
    // Re-assigning reactivates the same record.
    expect((await call(ctx, admin, 'POST', `/vacancies/${v.id}/assign-agency`, { agency_id: agencyId })).statusCode).toBe(200);
  });

  it('deactivating an agency keeps its contact details', async () => {
    const a = (await call(ctx, admin, 'POST', '/agencies', { name: 'Keep Details Ltd', primary_contact_name: 'Ravi', primary_contact_email: 'ravi@keep.test' })).json().data;
    const res = await call(ctx, admin, 'PATCH', `/agencies/${a.id}`, { status: 'inactive' });
    expect(res.json().data).toMatchObject({ status: 'inactive', primary_contact_name: 'Ravi', primary_contact_email: 'ravi@keep.test' });
  });

  it('will not assign an inactive agency', async () => {
    const a = (await call(ctx, admin, 'POST', '/agencies', { name: 'Dormant Partners' })).json().data;
    await call(ctx, admin, 'PATCH', `/agencies/${a.id}`, { status: 'inactive' });
    const v = await openVacancy(ctx, admin, await approvedRequisition(ctx, s));
    const res = await call(ctx, admin, 'POST', `/vacancies/${v.id}/assign-agency`, { agency_id: a.id });
    expect(res.statusCode).toBe(422);
  });
});
