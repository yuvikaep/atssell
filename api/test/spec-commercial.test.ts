// Jobs, agency commercial terms, employment (joined / exited), replacements and ownership correction.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, setupApp, type TestContext } from './helpers.js';
import { addAgencyMember, agencyProfile, applicationOnVacancy, createAgency, setupCompany, submitAs, vacancyWithAgencies } from './hiring-helpers.js';

let ctx: TestContext;
let s: Awaited<ReturnType<typeof setupCompany>>;
let hr: string;
let recruiter: string;
let agencyId: string;
let other: string;
let agency: { cookie: string; userId: string };
let otherAgency: { cookie: string; userId: string };
let job: { id: string };
let n = 0;

beforeAll(async () => {
  ctx = await setupApp();
  s = await setupCompany(ctx, 'cm');
  [hr, recruiter] = await Promise.all([s.as('admin'), s.as('recruiter')]);
  agencyId = await createAgency(ctx, hr, 'Talent Co');
  other = await createAgency(ctx, hr, 'Other Co');
  agency = await addAgencyMember(ctx, hr, agencyId, 'boss@talent.test', 'admin');
  otherAgency = await addAgencyMember(ctx, hr, other, 'boss@other.test', 'admin');
  job = await vacancyWithAgencies(ctx, s, [agencyId, other], { title: 'Commercial job', headcount: 5 });
  await call(ctx, hr, 'POST', `/vacancies/${job.id}/assign-recruiter`, { user_id: s.users.recruiter.id });
});
afterAll(() => ctx.close());

const terms = (over: Record<string, unknown> = {}) => ({ payment_model: 'one_time_fee', fee_type: 'percent_of_ctc', fee_value: 10, lockin_days: 90, replacement_days: 30, effective_from: '2020-01-01', agreement_ref: 'MSA-1', ...over });
const phone = () => `9${String(500000000 + ++n * 104729).padStart(9, '0')}`;
const iso = (d: Date) => d.toISOString().slice(0, 10);
const daysFrom = (base: string, days: number) => iso(new Date(new Date(`${base}T00:00:00Z`).getTime() + days * 86_400_000));
const ago = (days: number) => iso(new Date(Date.now() - days * 86_400_000));
async function agencyHire(joinedOn = ago(40), ctc = 1_200_000) {
  const p = agencyProfile(`cm${++n}`, { phone: phone() });
  const sub = await submitAs(ctx, agency.cookie, job.id, p);
  expect(sub.statusCode, sub.body).toBe(201);
  const cand = await ctx.adminDb.selectFrom('candidates').select('id').where('email', '=', p.email).executeTakeFirstOrThrow();
  const app = await ctx.adminDb.selectFrom('applications').select('id').where('candidate_id', '=', cand.id).where('vacancy_id', '=', job.id).executeTakeFirstOrThrow();
  const res = await call(ctx, hr, 'POST', `/applications/${app.id}/join`, { joined_on: joinedOn, designation: 'Sales Executive', annual_ctc: ctc });
  expect(res.statusCode, res.body).toBe(201);
  return { applicationId: app.id, employmentId: res.json().data.id as string, join: res.json().data };
}

describe('jobs', () => {
  it('only the HR Lead creates jobs, in one step, with target and actual joins', async () => {
    const body = { title: 'Account Executive', department_id: s.sales.id, location: 'Pune', openings: 3, salary_min: 900_000, salary_max: 1_500_000 };
    const res = await call(ctx, hr, 'POST', '/jobs', body);
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().data).toMatchObject({ title: 'Account Executive', status: 'open', headcount: 3 });
    for (const [who, cookie] of [['recruiter', recruiter], ['agency', agency.cookie], ['hr_head', await s.as('hr1')]] as const) {
      expect((await call(ctx, cookie, 'POST', '/jobs', body)).statusCode, who).toBe(403);
    }
    expect((await call(ctx, hr, 'POST', '/jobs', { ...body, salary_min: 5, salary_max: 1 })).statusCode).toBe(400);
    const list = (await call(ctx, hr, 'GET', '/vacancies?status=all')).json().data as { title: string; joined: number; headcount: number }[];
    expect(list.find((j) => j.title === 'Account Executive')).toMatchObject({ joined: 0, headcount: 3 });
  });

  it('closing a job needs an outcome and keeps target and joins on record', async () => {
    const made = (await call(ctx, hr, 'POST', '/jobs', { title: 'Short job', department_id: s.eng.id, location: 'Remote', openings: 1 })).json().data;
    expect((await call(ctx, hr, 'POST', `/jobs/${made.id}/close`, {})).statusCode).toBe(400);
    expect((await call(ctx, recruiter, 'POST', `/jobs/${made.id}/close`, { outcome: 'x' })).statusCode).toBe(403);
    const closed = await call(ctx, hr, 'POST', `/jobs/${made.id}/close`, { outcome: 'Filled internally' });
    expect(closed.json().data).toMatchObject({ status: 'closed', target: 1, joined: 0 });
    expect((await call(ctx, hr, 'POST', `/jobs/${made.id}/close`, { outcome: 'again' })).statusCode).toBe(409);
    const ev = await ctx.adminDb.selectFrom('audit_events').select('metadata').where('entity_id', '=', made.id).where('action', '=', 'job.closed').executeTakeFirstOrThrow();
    expect(ev.metadata).toMatchObject({ outcome: 'Filled internally', target: 1, joined: 0 });
  });
});

describe('agency commercial terms', () => {
  it('are versioned: a change adds a version and old ones stay as they were', async () => {
    const v1 = await call(ctx, hr, 'POST', `/agencies/${agencyId}/terms`, terms());
    expect(v1.statusCode, v1.body).toBe(201);
    expect(v1.json().data).toMatchObject({ version: 1, payment_model: 'one_time_fee', fee_value: 10, lockin_days: 90, replacement_days: 30 });
    const v2 = await call(ctx, hr, 'POST', `/agencies/${agencyId}/terms`, terms({ fee_value: 8.33, effective_from: '2026-06-01', agreement_ref: 'MSA-2' }));
    expect(v2.json().data.version).toBe(2);
    const view = (await call(ctx, hr, 'GET', `/agencies/${agencyId}/terms`)).json().data;
    expect(view.history.map((t: { version: number }) => t.version)).toEqual([2, 1]);
    expect(view.current.version).toBe(2);
    await expect(ctx.adminDb.updateTable('agency_terms').set({ fee_value: 99 }).where('agency_id', '=', agencyId).execute()).rejects.toThrow(/append-only/);
  });

  it('are validated and limited to the HR Lead; the agency can only view its own', async () => {
    expect((await call(ctx, hr, 'POST', `/agencies/${agencyId}/terms`, terms({ fee_value: 140 }))).statusCode).toBe(400);
    expect((await call(ctx, hr, 'POST', `/agencies/${agencyId}/terms`, terms({ payment_model: 'barter' }))).statusCode).toBe(400);
    expect((await call(ctx, recruiter, 'POST', `/agencies/${agencyId}/terms`, terms())).statusCode).toBe(403);
    expect((await call(ctx, agency.cookie, 'POST', `/agencies/${agencyId}/terms`, terms())).statusCode).toBe(403);
    const own = (await call(ctx, agency.cookie, 'GET', '/agency/terms')).json().data;
    expect(own.history).toHaveLength(2);
    const theirs = (await call(ctx, otherAgency.cookie, 'GET', '/agency/terms')).json().data;
    expect(theirs).toMatchObject({ current: null, history: [] });
    expect((await call(ctx, agency.cookie, 'GET', `/agencies/${other}/terms`)).statusCode).toBe(403);
  });
});

describe('joined, exited and replacement', () => {
  it('Mark Joined records DOJ, designation and CTC, hires the candidate, and freezes the terms that applied', async () => {
    const h = await agencyHire(ago(200));
    expect(h.join).toMatchObject({ agency_terms_version: 1 });
    const app = await ctx.adminDb.selectFrom('applications').select('status').where('id', '=', h.applicationId).executeTakeFirstOrThrow();
    expect(app.status).toBe('hired');
    // Terms change later; this hire keeps what was agreed when they joined.
    await call(ctx, hr, 'POST', `/agencies/${agencyId}/terms`, terms({ fee_value: 20, effective_from: '2026-12-01', agreement_ref: 'MSA-3' }));
    const row = (await call(ctx, hr, 'GET', '/employment')).json().data.find((r: { id: string }) => r.id === h.employmentId);
    expect(row).toMatchObject({ terms_version: 1, fee_value: 10, designation: 'Sales Executive', status: 'active', agency_name: 'Talent Co', fee_amount: 120_000 });
    const audit = await ctx.adminDb.selectFrom('audit_events').select('metadata').where('entity_id', '=', h.employmentId).where('action', '=', 'employment.joined').executeTakeFirstOrThrow();
    expect(audit.metadata).toMatchObject({ joined_on: ago(200), designation: 'Sales Executive', annual_ctc: 1_200_000 });
  });

  it('only the HR Lead can mark joined, and only once', async () => {
    const a = await applicationOnVacancy(ctx, s, 'zzzzzz');
    for (const cookie of [recruiter, agency.cookie]) expect((await call(ctx, cookie, 'POST', `/applications/${a.applicationId}/join`, { joined_on: '2026-02-01', designation: 'X', annual_ctc: 1 })).statusCode).toBe(403);
    const ok = await call(ctx, hr, 'POST', `/applications/${a.applicationId}/join`, { joined_on: '2026-02-01', designation: 'Analyst', annual_ctc: 900_000 });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().data.agency_terms_version).toBeNull();
    expect((await call(ctx, hr, 'POST', `/applications/${a.applicationId}/join`, { joined_on: '2026-02-01', designation: 'Analyst', annual_ctc: 900_000 })).json().error.code).toBe('ALREADY_JOINED');
    expect((await call(ctx, hr, 'POST', `/applications/${a.applicationId}/join`, { joined_on: '2026-02-01', annual_ctc: 1 })).statusCode).toBe(400);
  });

  it('an exit inside the lock-in creates a replacement due by the agreed days; a later exit does not', async () => {
    const early = await agencyHire(ago(60));
    const bad = await call(ctx, hr, 'POST', `/employment/${early.employmentId}/exit`, { exit_date: ago(90), exit_reason: 'x' });
    expect(bad.statusCode).toBe(400);
    expect((await call(ctx, recruiter, 'POST', `/employment/${early.employmentId}/exit`, { exit_date: ago(45), exit_reason: 'x' })).statusCode).toBe(403);
    const res = await call(ctx, hr, 'POST', `/employment/${early.employmentId}/exit`, { exit_date: ago(45), exit_reason: 'Found another job' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data.replacement_due.due_by).toBe(daysFrom(ago(45), 30));
    expect((await call(ctx, hr, 'POST', `/employment/${early.employmentId}/exit`, { exit_date: ago(44), exit_reason: 'again' })).json().error.code).toBe('ALREADY_EXITED');

    const late = await agencyHire(ago(200));
    const lateExit = await call(ctx, hr, 'POST', `/employment/${late.employmentId}/exit`, { exit_date: ago(10), exit_reason: 'Relocated' });
    expect(lateExit.json().data.replacement_due).toBeNull();
    const events = await ctx.adminDb.selectFrom('audit_events').select('action').where('entity_id', '=', early.employmentId).execute();
    expect(events.map((e) => e.action)).toEqual(expect.arrayContaining(['employment.joined', 'employment.exited']));
  });

  it('a replacement is fulfilled by another hire of the same agency on the same job, or waived with a reason, or expires', async () => {
    const left = await agencyHire(ago(20));
    await call(ctx, hr, 'POST', `/employment/${left.employmentId}/exit`, { exit_date: ago(10), exit_reason: 'Left' });
    const due = ((await call(ctx, hr, 'GET', '/replacements?status=due')).json().data as { id: string; employment_id: string; agency_name: string }[]).find((r) => r.employment_id === left.employmentId)!;
    expect(due.agency_name).toBe('Talent Co');

    const wrong = await call(ctx, hr, 'POST', `/replacements/${due.id}/link`, { replacement_employment_id: left.employmentId });
    expect(wrong.json().error.code).toBe('WRONG_REPLACEMENT');
    const replacement = await agencyHire(ago(2));
    const linked = await call(ctx, hr, 'POST', `/replacements/${due.id}/link`, { replacement_employment_id: replacement.employmentId });
    expect(linked.json().data.status).toBe('replaced');
    expect((await call(ctx, hr, 'POST', `/replacements/${due.id}/waive`, { notes: 'x' })).json().error.code).toBe('NOT_DUE');

    const second = await agencyHire(ago(20));
    await call(ctx, hr, 'POST', `/employment/${second.employmentId}/exit`, { exit_date: ago(10), exit_reason: 'Left' });
    const r2 = ((await call(ctx, hr, 'GET', '/replacements?status=due')).json().data as { id: string; employment_id: string }[]).find((r) => r.employment_id === second.employmentId)!;
    expect((await call(ctx, hr, 'POST', `/replacements/${r2.id}/waive`, {})).statusCode).toBe(400);
    expect((await call(ctx, hr, 'POST', `/replacements/${r2.id}/waive`, { notes: 'Goodwill' })).json().data.status).toBe('waived');

    const third = await agencyHire(ago(20));
    await call(ctx, hr, 'POST', `/employment/${third.employmentId}/exit`, { exit_date: ago(10), exit_reason: 'Left' });
    await ctx.adminDb.updateTable('replacement_records').set({ due_by: '2020-01-01' }).where('employment_id', '=', third.employmentId).execute();
    const expired = (await call(ctx, hr, 'GET', '/replacements')).json().data as { employment_id: string; status: string }[];
    expect(expired.find((r) => r.employment_id === third.employmentId)!.status).toBe('expired');
  });

  it('tracks the hiring fee invoice for agency hires only', async () => {
    const h = await agencyHire(ago(5));
    const up = await call(ctx, hr, 'PATCH', `/employment/${h.employmentId}/invoice`, { invoice_status: 'invoiced', invoice_reference: 'INV-77' });
    expect(up.json().data.invoice_status).toBe('invoiced');
    const internal = await applicationOnVacancy(ctx, s, 'yyyyyyy');
    const joined = await call(ctx, hr, 'POST', `/applications/${internal.applicationId}/join`, { joined_on: '2026-06-01', designation: 'Analyst', annual_ctc: 800_000 });
    expect((await call(ctx, hr, 'PATCH', `/employment/${joined.json().data.id}/invoice`, { invoice_status: 'paid' })).json().error.code).toBe('NOT_AGENCY_HIRE');
    expect((await call(ctx, recruiter, 'GET', '/employment')).statusCode).toBe(403);
  });

  it('hides everything from other companies', async () => {
    const otherCo = await setupCompany(ctx, 'cz');
    const cookie = await otherCo.as('admin');
    expect((await call(ctx, cookie, 'GET', '/employment')).json().data).toHaveLength(0);
    expect((await call(ctx, cookie, 'GET', '/replacements')).json().data).toHaveLength(0);
  });
});

describe('ownership correction', () => {
  it('is an audited HR Lead action that records who owned it before, and not allowed once someone has joined', async () => {
    const p = agencyProfile(`oc${++n}`, { phone: phone() });
    const sub = await submitAs(ctx, agency.cookie, job.id, p);
    const id = sub.json().data.id as string;
    expect((await call(ctx, recruiter, 'POST', `/submissions/${id}/correct-ownership`, { agency_id: other, reason: 'Wrongly credited' })).statusCode).toBe(403);
    expect((await call(ctx, hr, 'POST', `/submissions/${id}/correct-ownership`, { agency_id: other })).statusCode).toBe(400);
    const res = await call(ctx, hr, 'POST', `/submissions/${id}/correct-ownership`, { agency_id: other, reason: 'Sourced first by Other Co per email trail' });
    expect(res.statusCode, res.body).toBe(200);
    const row = await ctx.adminDb.selectFrom('submissions').select(['agency_id', 'ownership_state']).where('id', '=', id).executeTakeFirstOrThrow();
    expect(row).toEqual({ agency_id: other, ownership_state: 'accepted' });
    const events = await ctx.adminDb.selectFrom('ownership_events').select(['event_type', 'previous_state', 'new_state', 'reason']).where('submission_id', '=', id).execute();
    expect(events.find((e) => e.event_type === 'corrected')).toMatchObject({ previous_state: `agency:${agencyId}`, new_state: `agency:${other}` });
    const ev = await ctx.adminDb.selectFrom('audit_events').select('actor_user_id').where('entity_id', '=', id).where('action', '=', 'ownership.corrected').executeTakeFirstOrThrow();
    expect(ev.actor_user_id).toBe(s.co.admin.id);

    const cand = await ctx.adminDb.selectFrom('candidates').select('id').where('email', '=', p.email).executeTakeFirstOrThrow();
    const app = await ctx.adminDb.selectFrom('applications').select('id').where('candidate_id', '=', cand.id).executeTakeFirstOrThrow();
    await call(ctx, hr, 'POST', `/applications/${app.id}/join`, { joined_on: '2026-07-01', designation: 'X', annual_ctc: 1000 });
    expect((await call(ctx, hr, 'POST', `/submissions/${id}/correct-ownership`, { agency_id: agencyId, reason: 'Changing back' })).json().error.code).toBe('ALREADY_JOINED');
  });
});

describe('recording an offer', () => {
  it('records status and offered CTC without an approval chain, one live offer per candidate', async () => {
    const a = await applicationOnVacancy(ctx, s, 'offerrec');
    expect((await call(ctx, recruiter, 'POST', `/applications/${a.applicationId}/offer`, { offered_ctc: 1, status: 'offered' })).statusCode).toBe(403);
    const first = await call(ctx, hr, 'POST', `/applications/${a.applicationId}/offer`, { offered_ctc: 1_500_000, status: 'offered' });
    expect(first.statusCode, first.body).toBe(201);
    const second = await call(ctx, hr, 'POST', `/applications/${a.applicationId}/offer`, { offered_ctc: 1_600_000, status: 'accepted' });
    expect(second.json().data.id).toBe(first.json().data.id);
    const rows = await ctx.adminDb.selectFrom('offers').select(['status', 'offered_ctc']).where('application_id', '=', a.applicationId).execute();
    expect(rows).toEqual([{ status: 'accepted', offered_ctc: 1_600_000 }]);
    expect((await call(ctx, hr, 'POST', `/applications/${a.applicationId}/offer`, { offered_ctc: 1, status: 'declined' })).statusCode).toBe(400);
    expect((await call(ctx, hr, 'POST', `/applications/${a.applicationId}/offer`, { offered_ctc: -5, status: 'offered' })).statusCode).toBe(400);
    const m = (await call(ctx, hr, 'GET', '/candidate-master?q=offerrec')).json().data[0];
    expect(m).toMatchObject({ offer_status: 'accepted' });
  });
});
