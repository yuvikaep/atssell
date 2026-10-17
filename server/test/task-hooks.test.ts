import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, setupApp, type TestContext } from './helpers.js';
import { addAgencyMember, agencyProfile, createAgency, requisitionPayload, setupCompany, submitAs, vacancyWithAgencies } from './hiring-helpers.js';

let ctx: TestContext;
let s: Awaited<ReturnType<typeof setupCompany>>;
let admin: string;
let hr1: string;
let hr2: string;

beforeAll(async () => {
  ctx = await setupApp();
  s = await setupCompany(ctx, 'th');
  [admin, hr1, hr2] = await Promise.all([s.as('admin'), s.as('hr1'), s.as('hr2')]);
});
afterAll(() => ctx.close());

const inbox = async (cookie: string) => (await call(ctx, cookie, 'GET', '/notifications')).json().data as { type: string; link: string; body: string }[];
const todo = async (cookie: string) => (await call(ctx, cookie, 'GET', '/tasks?status=open')).json().data as { task_type: string; entity_id: string }[];

describe('requisition approvals reach the task centre', () => {
  it('asks each approver in turn, clears their to-do when they decide, and tells the requester the outcome', async () => {
    const created = await call(ctx, admin, 'POST', '/requisitions', requisitionPayload(s.eng.id));
    const id = created.json().data.id as string;
    await call(ctx, admin, 'POST', `/requisitions/${id}/submit-approval`, { approver_user_ids: [s.users.hr1.id, s.users.hr2.id] });

    expect((await inbox(hr1)).some((n) => n.type === 'requisition.approval_requested' && n.link === `/requisitions/${id}`)).toBe(true);
    expect((await todo(hr1)).some((t) => t.task_type === 'requisition_approval' && t.entity_id === id)).toBe(true);
    expect((await todo(hr2)).some((t) => t.entity_id === id)).toBe(false);

    await call(ctx, hr1, 'POST', `/requisitions/${id}/approve`, { decision: 'approved' });
    expect((await todo(hr1)).some((t) => t.entity_id === id)).toBe(false);
    expect((await todo(hr2)).some((t) => t.task_type === 'requisition_approval' && t.entity_id === id)).toBe(true);

    await call(ctx, hr2, 'POST', `/requisitions/${id}/approve`, { decision: 'rejected', reason: 'No budget' });
    expect((await todo(hr2)).some((t) => t.entity_id === id)).toBe(false);
    const note = (await inbox(admin)).find((n) => n.type === 'requisition.rejected');
    expect(note).toMatchObject({ link: `/requisitions/${id}` });
    expect(note!.body).toContain('No budget');
  });
});

describe('agency submissions reach the vacancy team', () => {
  it('notifies the vacancy owner and assigned recruiters', async () => {
    const agency = await createAgency(ctx, admin, 'Hook Agency');
    const member = await addAgencyMember(ctx, admin, agency, 'hook@agency.test');
    const v = await vacancyWithAgencies(ctx, s, [agency], { title: 'Hooked role' });
    const assigned = await call(ctx, admin, 'POST', `/vacancies/${v.id}/assign-recruiter`, { user_id: s.users.recruiter.id });
    expect(assigned.statusCode, assigned.body).toBe(200);
    const res = await submitAs(ctx, member.cookie, v.id, agencyProfile('hook one'));
    expect(res.statusCode, res.body).toBe(201);
    const recruiter = await s.as('recruiter');
    expect((await inbox(recruiter)).some((n) => n.type === 'submission.received' && n.body.includes('Hook Agency'))).toBe(true);
    // The owner (who opened the vacancy) hears too, and an agency user never sees internal notices.
    expect((await inbox(admin)).some((n) => n.type === 'submission.received')).toBe(true);
    expect((await inbox(member.cookie)).some((n) => n.type === 'submission.received')).toBe(false);
  });
});
