// Ownership is first come, first credited. It is automatic, permanent, and nobody at the company can
// decide or change it. Sourcing a candidate who is already in the database is rejected as a duplicate.
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, setupApp, type TestContext } from './helpers.js';
import { addAgencyMember, agencyProfile, createAgency, setupCompany, submitAs, vacancyWithAgencies } from './hiring-helpers.js';

let ctx: TestContext;
let s: Awaited<ReturnType<typeof setupCompany>>;
let admin: string;
let manager: string;
let recruiter: string;
let alpha: string;
let beta: string;
let gamma: string;
let A: { cookie: string; userId: string };
let B: { cookie: string; userId: string };
let G: { cookie: string; userId: string };
let v1: { id: string };
let v2: { id: string };
let n = 0;

beforeAll(async () => {
  ctx = await setupApp();
  s = await setupCompany(ctx, 'ow');
  [admin, manager, recruiter] = await Promise.all([s.as('admin'), s.as('hr1'), s.as('recruiter')]);
  [alpha, beta, gamma] = await Promise.all([createAgency(ctx, admin, 'Alpha'), createAgency(ctx, admin, 'Beta'), createAgency(ctx, admin, 'Gamma')]);
  A = await addAgencyMember(ctx, admin, alpha, 'a@alpha.test', 'admin');
  B = await addAgencyMember(ctx, admin, beta, 'b@beta.test', 'admin');
  G = await addAgencyMember(ctx, admin, gamma, 'g@gamma.test', 'admin');
  v1 = await vacancyWithAgencies(ctx, s, [alpha, beta, gamma], { headcount: 5 });
  v2 = await vacancyWithAgencies(ctx, s, [alpha, beta, gamma], { headcount: 5 });
  await call(ctx, admin, 'POST', `/vacancies/${v1.id}/assign-recruiter`, { user_id: s.users.recruiter.id });
});
afterAll(() => ctx.close());

const fresh = () => agencyProfile(`own${++n}`);
const submit = (who: { cookie: string }, vacancy: { id: string }, profile: Record<string, unknown>) => submitAs(ctx, who.cookie, vacancy.id, profile);
const candidateId = async (email: string) => (await ctx.adminDb.selectFrom('candidates').select('id').where('email', '=', email).executeTakeFirstOrThrow()).id;
const profileOf = async (email: string) => (await call(ctx, admin, 'GET', `/candidates/${await candidateId(email)}`)).json().data;

describe('first to source is credited, automatically', () => {
  it('the first agency is credited at once, with no window and no review', async () => {
    const p = fresh();
    const res = await submit(A, v1, p);
    expect(res.statusCode).toBe(201);
    const sub = await ctx.adminDb.selectFrom('submissions').select(['id', 'ownership_state', 'ownership_expires_at']).where('id', '=', res.json().data.id).executeTakeFirstOrThrow();
    expect(sub).toMatchObject({ ownership_state: 'accepted', ownership_expires_at: null });
    const events = await ctx.adminDb.selectFrom('ownership_events').select(['event_type', 'new_state', 'reason']).where('submission_id', '=', sub.id).execute();
    expect(events).toEqual([{ event_type: 'credited', new_state: 'accepted', reason: 'First to source this candidate' }]);
  });

  it('the company sees who is credited on the candidate profile', async () => {
    const p = fresh();
    await submit(B, v1, p);
    expect((await profileOf(p.email)).sourced_by).toEqual({ kind: 'agency', id: beta, name: 'Beta' });
  });

  it('a candidate added by the company is credited to the company', async () => {
    const email = `company.first.${++n}@mail.test`;
    await call(ctx, recruiter, 'POST', '/candidates', { full_name: 'Company Found', email });
    expect((await profileOf(email)).sourced_by).toMatchObject({ kind: 'company', name: 'Company (internal)' });
  });

  it('credit does not expire with time', async () => {
    const p = fresh();
    const res = await submit(A, v1, p);
    await ctx.adminDb.updateTable('submissions').set({ submitted_at: new Date(Date.now() - 400 * 86_400_000) }).where('id', '=', res.json().data.id).execute();
    expect((await profileOf(p.email)).sourced_by.id).toBe(alpha);
    const late = await submit(B, v1, p); // the same job, a year later
    expect(late.statusCode).toBe(409);
  });
});

describe('sourcing a candidate who is already there is a duplicate', () => {
  it('rejects every later agency, and nothing is stored for the attempt', async () => {
    const p = fresh();
    await submit(A, v1, p);
    const files = ctx.storage.files.size;
    for (const who of [B, G]) {
      const res = await submit(who, v1, p);
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('DUPLICATE_CANDIDATE');
    }
    expect(ctx.storage.files.size).toBe(files);
    const subs = await ctx.adminDb.selectFrom('submissions as s').innerJoin('applications as a', 'a.id', 's.application_id').select('s.agency_id').where('a.candidate_id', '=', await candidateId(p.email)).execute();
    expect(subs.map((x) => x.agency_id)).toEqual([alpha]);
  });

  it('a candidate the company already holds can still be submitted by an agency for a job nobody has submitted them for', async () => {
    const email = `company.owned.${++n}@mail.test`;
    await call(ctx, recruiter, 'POST', '/candidates', { full_name: 'Company Owned', email });
    const res = await submit(A, v1, agencyProfile('x', { email }));
    expect(res.statusCode, res.body).toBe(201);
    // One candidate record, not two; the agency owns this job's submission.
    expect(await ctx.adminDb.selectFrom('candidates').select('id').where('email', '=', email).execute()).toHaveLength(1);
    // The company recruiter now trying the same candidate on the same job is the duplicate.
    const dup = await call(ctx, admin, 'POST', '/applications', { candidate_id: await candidateId(email), vacancy_id: v1.id });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe('ALREADY_APPLIED');
    expect(dup.json().error.details.owner).toBe('Alpha');
  });

  it('rejects the company too: staff cannot source again what an agency already sourced', async () => {
    const p = fresh();
    await submit(A, v1, p);
    const res = await call(ctx, recruiter, 'POST', '/candidates', { full_name: 'Again', email: p.email });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('DUPLICATE_CANDIDATE');
    expect((await profileOf(p.email)).sourced_by.id).toBe(alpha);
  });

  it('the owner can submit its own candidate to another vacancy, but not the same one twice', async () => {
    const p = fresh();
    expect((await submit(A, v1, p)).statusCode).toBe(201);
    expect((await submit(A, v2, p)).statusCode).toBe(201);
    const again = await submit(A, v2, p);
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('DUPLICATE_CANDIDATE');
    expect((await profileOf(p.email)).sourced_by.id).toBe(alpha);
  });

  it('another agency is still rejected after the owner used the candidate on several vacancies', async () => {
    const p = fresh();
    await submit(A, v1, p);
    await submit(A, v2, p);
    expect((await submit(B, v2, p)).statusCode).toBe(409);
  });

  it('the company using an agency candidate on a vacancy does not change who is credited', async () => {
    const p = fresh();
    await submit(A, v1, p);
    const cand = await candidateId(p.email);
    const res = await call(ctx, admin, 'POST', '/applications', { candidate_id: cand, vacancy_id: v2.id });
    expect(res.statusCode).toBe(201);
    expect((await profileOf(p.email)).sourced_by.id).toBe(alpha);
    expect((await submit(B, v2, p)).statusCode).toBe(409);
  });

  it('after a merge, the earliest source of either profile is credited', async () => {
    const early = fresh();
    const late = fresh();
    await submit(A, v1, early);
    await new Promise((r) => setTimeout(r, 20));
    await submit(B, v2, late); // a different vacancy, so the merge itself has no conflict
    const target = await candidateId(late.email);
    const source = await candidateId(early.email);
    const merged = await call(ctx, admin, 'POST', `/candidates/${target}/merge`, { source_candidate_id: source, reason: 'Same person' });
    expect(merged.statusCode).toBe(200);
    expect(merged.json().data.sourced_by.id).toBe(alpha);
  });
});

describe('nobody can decide or change ownership', () => {
  it('the review queue, decisions and settings no longer exist', async () => {
    const p = fresh();
    const sub = (await submit(A, v1, p)).json().data.id;
    for (const cookie of [admin, manager]) {
      expect((await call(ctx, cookie, 'GET', '/ownership/submissions')).statusCode).toBe(404);
      expect((await call(ctx, cookie, 'GET', '/settings/ownership')).statusCode).toBe(404);
      expect((await call(ctx, cookie, 'PATCH', '/settings/ownership', { window_days: 5 })).statusCode).toBe(404);
      for (const decision of ['accept', 'reject', 'release']) {
        expect((await call(ctx, cookie, 'POST', `/submissions/${sub}/resolve-ownership`, { decision, reason: 'x' })).statusCode, decision).toBe(404);
      }
    }
  });

  it('only the HR Lead holds an ownership permission, and it is only for audited corrections', async () => {
    const roles = (await call(ctx, admin, 'GET', '/roles')).json().data as { code: string; permissions: string[] }[];
    const holders = roles.filter((r) => r.permissions.some((x) => x.startsWith('ownership.'))).map((r) => r.code);
    expect(holders).toEqual(['company_admin']);
    const rows = await sql<{ code: string }>`SELECT code FROM permissions WHERE code LIKE 'ownership.%'`.execute(ctx.adminDb);
    expect(rows.rows.map((r) => r.code)).toEqual(['ownership.correct']);
  });

  it('the credit is permanent even if someone edits data through the API the company uses', async () => {
    const p = fresh();
    await submit(A, v1, p);
    const cand = await candidateId(p.email);
    // Editing, noting, merging or applying never touches the credit.
    await call(ctx, admin, 'PATCH', `/candidates/${cand}`, { current_title: 'Changed' });
    await call(ctx, admin, 'POST', `/candidates/${cand}/notes`, { body: 'A note' });
    expect((await profileOf(p.email)).sourced_by.id).toBe(alpha);
  });

  it('the ownership history cannot be edited or deleted', async () => {
    const p = fresh();
    const id = (await submit(A, v1, p)).json().data.id;
    await expect(ctx.adminDb.deleteFrom('ownership_events').where('submission_id', '=', id).execute()).rejects.toThrow(/append-only/);
    await expect(ctx.adminDb.updateTable('ownership_events').set({ reason: 'edited' }).where('submission_id', '=', id).execute()).rejects.toThrow(/append-only/);
  });
});

describe('what agencies see', () => {
  it('their own submission is credited; a rejected duplicate is not listed at all', async () => {
    const p = fresh();
    const ok = (await submit(A, v1, p)).json().data;
    await submit(B, v1, p);
    const mine = (await call(ctx, A.cookie, 'GET', '/agency/submissions')).json().data.find((r: { id: string }) => r.id === ok.id);
    expect(mine.ownership).toEqual({ label: 'Credited', detail: 'You sourced this candidate first, so they are credited to your agency.' });
    const theirs = (await call(ctx, B.cookie, 'GET', '/agency/submissions?page_size=100')).json().data;
    expect(theirs.find((r: { candidate_name: string }) => r.candidate_name === p.full_name)).toBeUndefined();
  });

  it('a rejected submission (from before the rule changed) shows no stage and is not counted as in the pipeline', async () => {
    const p = fresh();
    await submit(A, v1, p);
    const cand = await candidateId(p.email);
    // Legacy data: a second agency's submission on the same application, marked rejected by the migration.
    const app = await ctx.adminDb.selectFrom('applications').select('id').where('candidate_id', '=', cand).executeTakeFirstOrThrow();
    const legacy = await ctx.adminDb.insertInto('submissions').values({
      tenant_id: s.co.tenant.id, application_id: app.id, source_type: 'agency', source_user_id: G.userId, agency_id: gamma,
      ownership_state: 'rejected', submitted_profile: JSON.stringify({ full_name: p.full_name }),
    }).returning('id').executeTakeFirstOrThrow();
    const home = (await call(ctx, G.cookie, 'GET', '/agency/home')).json().data;
    expect(home.in_pipeline).toBe(0);
    expect(home.submissions).toMatchObject({ credited: 0, total: 1 });
    expect(home.submissions.rejected_duplicates).toBeGreaterThanOrEqual(1);
    const row = (await call(ctx, G.cookie, 'GET', '/agency/submissions')).json().data.find((r: { id: string }) => r.id === legacy.id);
    expect(row).toMatchObject({ stage: null, application_status: null, ownership: { label: 'Rejected as duplicate' } });
    expect(JSON.stringify(row)).not.toMatch(/Submitted|Screening|Alpha/);
  });

  it('a vacancy shows the notes the company set for that agency, and no ownership window', async () => {
    const v = await vacancyWithAgencies(ctx, s, [alpha, beta]);
    const set = await call(ctx, admin, 'PATCH', `/vacancies/${v.id}/agencies/${alpha}/policy`, { submission_notes: 'Only candidates who can join within 45 days.' });
    expect(set.statusCode).toBe(200);
    expect((await call(ctx, A.cookie, 'GET', `/agency/vacancies/${v.id}`)).json().data.submission_policy).toEqual({ notes: 'Only candidates who can join within 45 days.' });
    expect((await call(ctx, B.cookie, 'GET', `/agency/vacancies/${v.id}`)).json().data.submission_policy).toEqual({ notes: null });
    await call(ctx, admin, 'PATCH', `/vacancies/${v.id}/agencies/${alpha}/policy`, { submission_notes: null });
    expect((await call(ctx, A.cookie, 'GET', `/agency/vacancies/${v.id}`)).json().data.submission_policy.notes).toBeNull();
  });

  it('only people who manage the vacancy can set notes, and only for assigned agencies', async () => {
    const v = await vacancyWithAgencies(ctx, s, [alpha]);
    expect((await call(ctx, await s.as('engManager'), 'PATCH', `/vacancies/${v.id}/agencies/${alpha}/policy`, { submission_notes: 'x' })).statusCode).toBe(403);
    expect((await call(ctx, admin, 'PATCH', `/vacancies/${v.id}/agencies/${beta}/policy`, { submission_notes: 'x' })).statusCode).toBe(404);
    expect((await call(ctx, admin, 'PATCH', `/vacancies/${v.id}/agencies/${alpha}/policy`, {})).statusCode).toBe(400);
  });
});

describe('across companies', () => {
  it('another company cannot see this companys credits, and its own sourcing is independent', async () => {
    const other = await setupCompany(ctx, 'ow2');
    const otherAdmin = await other.as('admin');
    const p = fresh();
    await submit(A, v1, p);
    expect((await call(ctx, otherAdmin, 'GET', `/candidates/${await candidateId(p.email)}`)).statusCode).toBe(404);
    const newOwner = await createAgency(ctx, otherAdmin, 'Their Agency');
    const member = await addAgencyMember(ctx, otherAdmin, newOwner, 'm@their.test', 'admin');
    const v = await vacancyWithAgencies(ctx, other, [newOwner]);
    expect((await submit(member, v, p)).statusCode).toBe(201);
  });
});
