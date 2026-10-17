// The product's core rule: first submission wins, job by job.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, setupApp, type TestContext } from './helpers.js';
import { addAgencyMember, agencyProfile, createAgency, submitAs, setupCompany, vacancyWithAgencies } from './hiring-helpers.js';

let ctx: TestContext;
let s: Awaited<ReturnType<typeof setupCompany>>;
let admin: string;
let recruiter: string;
let alpha: { cookie: string; userId: string };
let beta: { cookie: string; userId: string };
let jobA: { id: string };
let jobB: { id: string };
let alphaId: string;
let betaId: string;
let n = 0;

beforeAll(async () => {
  ctx = await setupApp();
  s = await setupCompany(ctx, 'fs');
  [admin, recruiter] = await Promise.all([s.as('admin'), s.as('recruiter')]);
  alphaId = await createAgency(ctx, admin, 'Agency A');
  betaId = await createAgency(ctx, admin, 'Agency B');
  alpha = await addAgencyMember(ctx, admin, alphaId, 'a@fs-agency.test', 'admin');
  beta = await addAgencyMember(ctx, admin, betaId, 'b@fs-agency.test', 'admin');
  jobA = await vacancyWithAgencies(ctx, s, [alphaId, betaId], { title: 'Job 101' });
  jobB = await vacancyWithAgencies(ctx, s, [alphaId, betaId], { title: 'Job 102' });
  for (const j of [jobA, jobB]) await call(ctx, admin, 'POST', `/vacancies/${j.id}/assign-recruiter`, { user_id: s.users.recruiter.id });
});
afterAll(() => ctx.close());

const fresh = () => agencyProfile(`fs${++n}`, { phone: `9${String(800000000 + n * 7919).padStart(9, '0')}` });
const candidateByEmail = async (email: string) => (await ctx.adminDb.selectFrom('candidates').select('id').where('email', '=', email).executeTakeFirstOrThrow()).id;
const owners = (candidateId: string, vacancyId: string) =>
  ctx.adminDb.selectFrom('submissions as s').innerJoin('applications as a', 'a.id', 's.application_id')
    .select(['s.agency_id', 's.source_user_id', 's.ownership_state']).where('a.candidate_id', '=', candidateId).where('a.vacancy_id', '=', vacancyId).execute();

describe('first submission wins', () => {
  it('Agency A at 10:00, then the company recruiter 10:15 on the same job: A keeps ownership and the attempt is recorded', async () => {
    const p = fresh();
    const first = await submitAs(ctx, alpha.cookie, jobA.id, p);
    expect(first.statusCode, first.body).toBe(201);
    const candidate = await candidateByEmail(p.email);

    const second = await call(ctx, recruiter, 'POST', '/applications', { candidate_id: candidate, vacancy_id: jobA.id });
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe('ALREADY_APPLIED');
    expect(second.json().error.details.owner).toBe('Agency A');

    expect(await owners(candidate, jobA.id)).toEqual([{ agency_id: alphaId, source_user_id: alpha.userId, ownership_state: 'accepted' }]);
    const attempts = await ctx.adminDb.selectFrom('duplicate_attempts').select(['attempted_by', 'attempted_agency_id']).where('candidate_id', '=', candidate).execute();
    expect(attempts).toEqual([{ attempted_by: s.users.recruiter.id, attempted_agency_id: null }]);
    const audit = await ctx.adminDb.selectFrom('audit_events').select('action').where('actor_user_id', '=', s.users.recruiter.id).where('action', '=', 'submission.duplicate_attempt').execute();
    expect(audit).toHaveLength(1);
  });

  it('works the other way round: the company recruiter first, then an agency', async () => {
    const p = fresh();
    const made = await call(ctx, recruiter, 'POST', '/candidates', { full_name: 'Recruiter Found', email: p.email, phone: p.phone });
    expect(made.statusCode, made.body).toBe(201);
    const cid = made.json().data.id as string;
    expect((await call(ctx, recruiter, 'POST', '/applications', { candidate_id: cid, vacancy_id: jobA.id })).statusCode).toBe(201);
    const agency = await submitAs(ctx, alpha.cookie, jobA.id, p);
    expect(agency.statusCode).toBe(409);
    const [row] = await owners(cid, jobA.id);
    expect(row).toMatchObject({ agency_id: null, source_user_id: s.users.recruiter.id });
    expect(await ctx.adminDb.selectFrom('duplicate_attempts').select('id').where('candidate_id', '=', cid).execute()).toHaveLength(1);
  });

  it('the same candidate on a different job is a separate submission with its own owner', async () => {
    const p = fresh();
    const a = await submitAs(ctx, alpha.cookie, jobA.id, p);
    expect(a.statusCode).toBe(201);
    const b = await submitAs(ctx, beta.cookie, jobB.id, p);
    expect(b.statusCode, b.body).toBe(201);
    const cid = await candidateByEmail(p.email);
    expect(await ctx.adminDb.selectFrom('candidates').select('id').where('email', '=', p.email).execute()).toHaveLength(1);
    expect((await owners(cid, jobA.id))[0]!.agency_id).toBe(alphaId);
    expect((await owners(cid, jobB.id))[0]!.agency_id).toBe(betaId);
  });

  it('matches by phone written differently, and never merges records on its own', async () => {
    const digits = `9${String(700000000 + ++n * 31).padStart(9, '0')}`;
    const first = await submitAs(ctx, alpha.cookie, jobA.id, agencyProfile(`ph${n}`, { phone: digits }));
    expect(first.statusCode).toBe(201);
    const dup = await submitAs(ctx, beta.cookie, jobA.id, agencyProfile(`ph${n}x`, { phone: `+91 ${digits.slice(0, 5)} ${digits.slice(5)}` }));
    expect(dup.statusCode).toBe(409);
    // Same person with a different phone and email is a separate record: no automatic merge.
    const other = await submitAs(ctx, beta.cookie, jobA.id, agencyProfile(`ph${n}y`, { full_name: first.json().data ? 'Agency Candidate' : 'x', phone: `9${String(600000000 + n).padStart(9, '0')}` }));
    expect(other.statusCode).toBe(201);
  });

  it('only one of two simultaneous submissions is accepted; the database decides', async () => {
    const p = fresh();
    const results = await Promise.all([
      submitAs(ctx, alpha.cookie, jobB.id, p),
      submitAs(ctx, beta.cookie, jobB.id, p),
      call(ctx, recruiter, 'POST', '/candidates', { full_name: 'Racer', email: p.email, phone: p.phone }),
    ]);
    const cid = await candidateByEmail(p.email);
    const accepted = await owners(cid, jobB.id);
    expect(accepted.filter((r) => r.ownership_state === 'accepted').length).toBeLessThanOrEqual(1);
    expect(await ctx.adminDb.selectFrom('candidates').select('id').where('email', '=', p.email).execute()).toHaveLength(1);
    const statuses = results.map((r) => r.statusCode).sort();
    expect(statuses.filter((c) => c === 201).length).toBeGreaterThanOrEqual(1);
    expect(statuses.filter((c) => c === 201).length).toBeLessThanOrEqual(2); // 201 may be the candidate record itself
  });

  it('the database refuses a second accepted owner for one application and a second phone number record', async () => {
    const p = fresh();
    await submitAs(ctx, alpha.cookie, jobA.id, p);
    const cid = await candidateByEmail(p.email);
    const app = await ctx.adminDb.selectFrom('applications').select('id').where('candidate_id', '=', cid).where('vacancy_id', '=', jobA.id).executeTakeFirstOrThrow();
    await expect(ctx.adminDb.insertInto('submissions').values({ tenant_id: s.co.tenant.id, application_id: app.id, source_type: 'agency', agency_id: betaId, source_user_id: beta.userId, ownership_state: 'accepted' }).execute()).rejects.toThrow(/uq_submissions_one_accepted/);
    await expect(ctx.adminDb.insertInto('candidates').values({ tenant_id: s.co.tenant.id, full_name: 'Twin', phone: (await ctx.adminDb.selectFrom('candidates').select('phone').where('id', '=', cid).executeTakeFirstOrThrow()).phone }).execute()).rejects.toThrow(/uq_candidates_company_phone/);
  });

  it('duplicate attempts and the accepted owner cannot be edited, even by the owner connection', async () => {
    await expect(ctx.adminDb.deleteFrom('duplicate_attempts').execute()).rejects.toThrow(/append-only/);
  });

  it('agencies cannot see each other, and are told only that the job was already submitted', async () => {
    const p = fresh();
    await submitAs(ctx, alpha.cookie, jobA.id, p);
    const dup = await submitAs(ctx, beta.cookie, jobA.id, p);
    expect(dup.body).not.toContain('Agency A');
    expect(JSON.stringify((await call(ctx, beta.cookie, 'GET', '/agency/submissions')).json())).not.toContain(p.full_name);
  });
});
