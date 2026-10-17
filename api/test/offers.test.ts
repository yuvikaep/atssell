import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, addUser, setupApp, type TestContext } from './helpers.js';
import { applicationOnVacancy, setupCompany } from './hiring-helpers.js';

let ctx: TestContext;
let s: Awaited<ReturnType<typeof setupCompany>>;
let admin: string;
let hr: string;
let recruiter: string;
let engManager: string;
let approverA: { id: string; cookie: string };
let approverB: { id: string; cookie: string };
let stages: Record<string, string>;
let n = 0;

const future = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

beforeAll(async () => {
  ctx = await setupApp();
  s = await setupCompany(ctx, 'of');
  [admin, hr, recruiter, engManager] = await Promise.all([s.as('admin'), s.as('hr1'), s.as('recruiter'), s.as('engManager')]);
  const { login } = await import('./helpers.js');
  const mk = async (name: string) => {
    const u = await addUser(ctx, s.co.tenant.id, { email: `${name}@${s.co.slug}.test`, role: 'offer_approver' });
    return { id: u.id, cookie: await login(ctx, s.co.slug, `${name}@${s.co.slug}.test`) };
  };
  approverA = await mk('apra');
  approverB = await mk('aprb');
  const list = (await call(ctx, admin, 'GET', '/pipeline/stages')).json().data as { id: string; code: string }[];
  stages = Object.fromEntries(list.map((x) => [x.code, x.id]));
});
afterAll(() => ctx.close());

async function freshApplication() {
  n += 1;
  return applicationOnVacancy(ctx, s, 'o'.repeat(n));
}
const moveTo = async (applicationId: string, code: string) => {
  const r = await call(ctx, admin, 'PATCH', `/applications/${applicationId}/stage`, { stage_id: stages[code] });
  expect(r.statusCode, r.body).toBe(200);
};
async function draftOffer(applicationId: string, over: Record<string, unknown> = {}) {
  const r = await call(ctx, hr, 'POST', `/applications/${applicationId}/offers`, { offered_ctc: 2_400_000, proposed_joining_date: future(30), ...over });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().data as { id: string; status: string };
}
const submit = (id: string, approvers: string[]) => call(ctx, hr, 'POST', `/offers/${id}/submit-approval`, { approver_user_ids: approvers });
const decide = (cookie: string, id: string, decision: 'approved' | 'rejected', reason?: string) => call(ctx, cookie, 'POST', `/offers/${id}/approve`, { decision, reason });
async function approvedOffer(applicationId: string) {
  const o = await draftOffer(applicationId);
  expect((await submit(o.id, [approverA.id])).statusCode).toBe(200);
  expect((await decide(approverA.cookie, o.id, 'approved')).statusCode).toBe(200);
  return o;
}
async function acceptedOffer() {
  const a = await freshApplication();
  for (const code of ['screening', 'shortlisted', 'interview']) await moveTo(a.applicationId, code);
  const o = await approvedOffer(a.applicationId);
  expect((await call(ctx, hr, 'POST', `/offers/${o.id}/release`)).statusCode).toBe(200);
  const r = await call(ctx, hr, 'POST', `/offers/${o.id}/respond`, { response: 'accepted' });
  expect(r.statusCode, r.body).toBe(200);
  return { a, o, joining: r.json().data.joining as { id: string } };
}

describe('drafting offers', () => {
  it('creates a draft with the amount, and only compensation holders can see offers', async () => {
    const a = await freshApplication();
    const o = await draftOffer(a.applicationId);
    const detail = (await call(ctx, hr, 'GET', `/offers/${o.id}`)).json().data;
    expect(detail).toMatchObject({ status: 'draft', offered_ctc: 2_400_000, can: { edit: true, submit: true } });
    for (const who of [recruiter, engManager]) {
      expect((await call(ctx, who, 'GET', `/offers/${o.id}`)).statusCode).toBe(403);
      expect((await call(ctx, who, 'GET', '/offers')).statusCode).toBe(403);
      expect((await call(ctx, who, 'POST', `/applications/${a.applicationId}/offers`, { offered_ctc: 1, proposed_joining_date: future(5) })).statusCode).toBe(403);
    }
  });

  it('allows one live offer per candidate and validates the amount and date', async () => {
    const a = await freshApplication();
    await draftOffer(a.applicationId);
    expect((await call(ctx, hr, 'POST', `/applications/${a.applicationId}/offers`, { offered_ctc: 1_000_000, proposed_joining_date: future(10) })).json().error.code).toBe('OFFER_EXISTS');
    const b = await freshApplication();
    expect((await call(ctx, hr, 'POST', `/applications/${b.applicationId}/offers`, { offered_ctc: -5, proposed_joining_date: future(10) })).statusCode).toBe(400);
    expect((await call(ctx, hr, 'POST', `/applications/${b.applicationId}/offers`, { offered_ctc: 1000, proposed_joining_date: 'soon' })).statusCode).toBe(400);
  });

  it('edits a draft without wiping fields that were not sent, and locks it once submitted', async () => {
    const a = await freshApplication();
    const o = await draftOffer(a.applicationId, { notes: 'Includes relocation' });
    const r = await call(ctx, hr, 'PATCH', `/offers/${o.id}`, { offered_ctc: 2_600_000 });
    expect(r.json().data).toMatchObject({ offered_ctc: 2_600_000, notes: 'Includes relocation' });
    await submit(o.id, [approverA.id]);
    expect((await call(ctx, hr, 'PATCH', `/offers/${o.id}`, { offered_ctc: 1 })).statusCode).toBe(409);
  });
});

describe('approval', () => {
  it('runs approvers in order, and the approver can open the offer without vacancy access', async () => {
    const a = await freshApplication();
    const o = await draftOffer(a.applicationId);
    expect((await submit(o.id, [approverA.id, approverB.id])).json().data).toMatchObject({ status: 'pending_approval', current_approver_id: approverA.id });
    // The first approver has a to-do and a notice; the second does not yet.
    const tasksA = (await call(ctx, approverA.cookie, 'GET', '/tasks?status=open')).json().data as { entity_id: string }[];
    expect(tasksA.some((t) => t.entity_id === o.id)).toBe(true);
    expect(((await call(ctx, approverB.cookie, 'GET', '/tasks?status=open')).json().data as { entity_id: string }[]).some((t) => t.entity_id === o.id)).toBe(false);
    expect((await call(ctx, approverA.cookie, 'GET', `/offers/${o.id}`)).json().data.can.decide).toBe(true);
    expect((await decide(approverB.cookie, o.id, 'approved')).json().error.code).toBe('NOT_CURRENT_APPROVER');
    expect((await decide(approverA.cookie, o.id, 'approved')).json().data).toMatchObject({ status: 'pending_approval', current_approver_id: approverB.id });
    expect((await decide(approverB.cookie, o.id, 'approved')).json().data.status).toBe('approved');
    // The drafter hears the outcome.
    const inbox = (await call(ctx, hr, 'GET', '/notifications')).json().data as { type: string; link: string }[];
    expect(inbox.some((x) => x.type === 'offer.approved' && x.link === `/offers/${o.id}`)).toBe(true);
  });

  it('refuses approvers who cannot approve offers, and the drafter as approver', async () => {
    const a = await freshApplication();
    const o = await draftOffer(a.applicationId);
    expect((await submit(o.id, [s.users.recruiter.id])).json().error.code).toBe('INVALID_APPROVER');
    expect((await submit(o.id, [s.users.hr1.id])).json().error.code).toBe('SELF_APPROVAL');
    expect((await submit(o.id, [approverA.id, approverA.id])).json().error.code).toBe('DUPLICATE_APPROVER');
    expect((await call(ctx, hr, 'GET', `/offers/approvers?department_id=${s.eng.id}`)).json().data.map((u: { id: string }) => u.id)).toEqual(expect.arrayContaining([approverA.id, approverB.id]));
  });

  it('sends a rejected offer back to draft with the reason, and allows a new round', async () => {
    const a = await freshApplication();
    const o = await draftOffer(a.applicationId);
    await submit(o.id, [approverA.id]);
    expect((await decide(approverA.cookie, o.id, 'rejected')).statusCode).toBe(400);
    const r = await decide(approverA.cookie, o.id, 'rejected', 'Above band');
    expect(r.json().data.status).toBe('draft');
    expect(r.json().data.approvals[0]).toMatchObject({ decision: 'rejected', reason: 'Above band' });
    await call(ctx, hr, 'PATCH', `/offers/${o.id}`, { offered_ctc: 2_000_000 });
    const again = await submit(o.id, [approverA.id]);
    expect(again.json().data).toMatchObject({ status: 'pending_approval', approval_round: 2 });
    expect((await decide(approverA.cookie, o.id, 'approved')).json().data.status).toBe('approved');
  });
});

describe('release, response and withdrawal', () => {
  it('moves the candidate to the Offer stage on release when the pipeline allows it', async () => {
    const a = await freshApplication();
    await moveTo(a.applicationId, 'screening');
    await moveTo(a.applicationId, 'shortlisted');
    await moveTo(a.applicationId, 'interview');
    const o = await approvedOffer(a.applicationId);
    const r = await call(ctx, hr, 'POST', `/offers/${o.id}/release`);
    expect(r.json().data).toMatchObject({ status: 'released', application: { stage_name: 'Offer' } });
  });

  it('only releases an approved offer', async () => {
    const a = await freshApplication();
    const o = await draftOffer(a.applicationId);
    expect((await call(ctx, hr, 'POST', `/offers/${o.id}/release`)).json().error.code).toBe('INVALID_STATE');
  });

  it('needs a reason for a decline and frees the candidate for a new offer', async () => {
    const a = await freshApplication();
    const o = await approvedOffer(a.applicationId);
    expect((await call(ctx, hr, 'POST', `/offers/${o.id}/respond`, { response: 'accepted' })).statusCode).toBe(409);
    await call(ctx, hr, 'POST', `/offers/${o.id}/release`);
    expect((await call(ctx, hr, 'POST', `/offers/${o.id}/respond`, { response: 'declined' })).statusCode).toBe(400);
    const r = await call(ctx, hr, 'POST', `/offers/${o.id}/respond`, { response: 'declined', reason: 'Better offer elsewhere' });
    expect(r.json().data).toMatchObject({ status: 'declined', decline_reason: 'Better offer elsewhere' });
    await draftOffer(a.applicationId);
  });

  it('withdraws before acceptance with a reason, and not after', async () => {
    const a = await freshApplication();
    const o = await draftOffer(a.applicationId);
    expect((await call(ctx, hr, 'POST', `/offers/${o.id}/withdraw`, {})).statusCode).toBe(400);
    expect((await call(ctx, hr, 'POST', `/offers/${o.id}/withdraw`, { reason: 'Role on hold' })).json().data.status).toBe('withdrawn');
    const { o: accepted } = await acceptedOffer();
    expect((await call(ctx, hr, 'POST', `/offers/${accepted.id}/withdraw`, { reason: 'x' })).json().error.code).toBe('INVALID_STATE');
  });
});

describe('joining', () => {
  it('creates a joining record and a follow-up task when the offer is accepted', async () => {
    const { o, joining } = await acceptedOffer();
    const detail = (await call(ctx, hr, 'GET', `/offers/${o.id}`)).json().data;
    expect(detail.joining).toMatchObject({ id: joining.id, status: 'expected' });
    const tasks = (await call(ctx, hr, 'GET', '/tasks?status=open')).json().data as { task_type: string; entity_id: string }[];
    expect(tasks.some((t) => t.task_type === 'joining_followup' && t.entity_id === o.id)).toBe(true);
    const list = (await call(ctx, hr, 'GET', '/joining')).json().data as { id: string }[];
    expect(list.map((j) => j.id)).toContain(joining.id);
  });

  it('marks the application hired when the candidate joins, and closes the follow-up', async () => {
    const { a, o, joining } = await acceptedOffer();
    const r = await call(ctx, hr, 'PATCH', `/joining/${joining.id}`, { status: 'joined' });
    expect(r.statusCode, r.body).toBe(200);
    const app = await ctx.adminDb.selectFrom('applications').select('status').where('id', '=', a.applicationId).executeTakeFirstOrThrow();
    expect(app.status).toBe('hired');
    const task = await ctx.adminDb.selectFrom('tasks').select('completed_at').where('entity_id', '=', o.id).where('task_type', '=', 'joining_followup').executeTakeFirstOrThrow();
    expect(task.completed_at).not.toBeNull();
    expect((await call(ctx, hr, 'PATCH', `/joining/${joining.id}`, { status: 'delayed', reason: 'x' })).json().error.code).toBe('INVALID_STATE');
  });

  it('needs a reason to delay or back out; delay can be re-confirmed; back-out withdraws the application', async () => {
    const { a, joining } = await acceptedOffer();
    expect((await call(ctx, hr, 'PATCH', `/joining/${joining.id}`, { status: 'delayed' })).statusCode).toBe(400);
    const delayed = await call(ctx, hr, 'PATCH', `/joining/${joining.id}`, { status: 'delayed', reason: 'Notice period extended', joining_date: future(60) });
    expect(delayed.json().data).toMatchObject({ status: 'delayed', joining_date: future(60) });
    expect((await call(ctx, hr, 'PATCH', `/joining/${joining.id}`, { status: 'expected' })).json().data.status).toBe('expected');
    expect((await call(ctx, hr, 'PATCH', `/joining/${joining.id}`, { status: 'backed_out' })).statusCode).toBe(400);
    expect((await call(ctx, hr, 'PATCH', `/joining/${joining.id}`, { status: 'backed_out', reason: 'Took a counter-offer' })).json().data.status).toBe('backed_out');
    const app = await ctx.adminDb.selectFrom('applications').select('status').where('id', '=', a.applicationId).executeTakeFirstOrThrow();
    expect(app.status).toBe('withdrawn');
  });

  it('explains when the pipeline does not allow hiring from the current stage', async () => {
    const a = await freshApplication();
    await moveTo(a.applicationId, 'screening');
    const o = await approvedOffer(a.applicationId);
    await call(ctx, hr, 'POST', `/offers/${o.id}/release`);
    const j = (await call(ctx, hr, 'POST', `/offers/${o.id}/respond`, { response: 'accepted' })).json().data.joining;
    expect((await call(ctx, hr, 'PATCH', `/joining/${j.id}`, { status: 'joined' })).json().error.code).toBe('NOT_READY_TO_HIRE');
  });

  it('keeps joining outcomes to people who manage offers', async () => {
    const { joining } = await acceptedOffer();
    expect((await call(ctx, recruiter, 'PATCH', `/joining/${joining.id}`, { status: 'joined' })).statusCode).toBe(403);
    expect((await call(ctx, approverA.cookie, 'PATCH', `/joining/${joining.id}`, { status: 'joined' })).statusCode).toBeGreaterThanOrEqual(403);
  });
});

describe('tenancy and audit', () => {
  it('hides offers and joining records from another company', async () => {
    const other = await setupCompany(ctx, 'ox');
    const otherHr = await other.as('hr1');
    const { o, joining } = await acceptedOffer();
    expect((await call(ctx, otherHr, 'GET', `/offers/${o.id}`)).statusCode).toBe(404);
    expect((await call(ctx, otherHr, 'POST', `/offers/${o.id}/withdraw`, { reason: 'x' })).statusCode).toBe(404);
    expect((await call(ctx, otherHr, 'PATCH', `/joining/${joining.id}`, { status: 'joined' })).statusCode).toBe(404);
    expect(JSON.stringify((await call(ctx, otherHr, 'GET', '/offers?status=all')).json())).not.toContain(o.id);
  });

  it('records the lifecycle in the audit trail', async () => {
    const { o } = await acceptedOffer();
    const actions = (await ctx.adminDb.selectFrom('audit_events').select('action').where('entity_id', '=', o.id).execute()).map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(['offer.created', 'offer.submitted', 'offer.approved', 'offer.released', 'offer.accepted']));
  });
});

describe('offer reporting', () => {
  it('reports acceptance and joining without exposing pay, and the dashboard shows what is waiting', async () => {
    const { joining } = await acceptedOffer();
    await ctx.adminDb.updateTable('joining_records').set({ joining_date: future(5) }).where('id', '=', joining.id).execute();
    const report = (await call(ctx, admin, 'GET', '/analytics/offers')).json().data;
    expect(report.definition).toEqual(expect.any(String));
    expect(report.created).toBeGreaterThan(0);
    expect(report.acceptance_rate_pct).toBeGreaterThan(0);
    expect(JSON.stringify(report)).not.toContain('2400000');
    // An approver with a pending offer sees it on their dashboard.
    const a = await freshApplication();
    const o = await draftOffer(a.applicationId);
    await submit(o.id, [approverA.id]);
    const dash = (await call(ctx, approverA.cookie, 'GET', '/analytics/dashboard')).json();
    expect(dash.data.offers.waiting_on_me).toBeGreaterThanOrEqual(1);
    expect((await call(ctx, hr, 'GET', '/analytics/dashboard')).json().data.offers.upcoming_joiners.length).toBeGreaterThan(0);
    expect((await call(ctx, recruiter, 'GET', '/analytics/dashboard')).json().data.offers).toBeNull();
  });
});
