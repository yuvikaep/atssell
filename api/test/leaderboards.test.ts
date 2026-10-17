import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, setupApp, type TestContext } from './helpers.js';
import { addAgencyMember, agencyProfile, createAgency, inHours, scheduleInterview, setupCompany, submitAs, vacancyWithAgencies } from './hiring-helpers.js';

let ctx: TestContext;
let s: Awaited<ReturnType<typeof setupCompany>>;
let hr: string;
let recruiter: string;
let a1: { cookie: string; userId: string };
let a2: { cookie: string; userId: string };
let aSub: { cookie: string; userId: string };
let ag1: string;
let ag2: string;
let job: { id: string };
let n = 0;

beforeAll(async () => {
  ctx = await setupApp();
  s = await setupCompany(ctx, 'lb');
  [hr, recruiter] = await Promise.all([s.as('admin'), s.as('recruiter')]);
  ag1 = await createAgency(ctx, hr, 'Rank One');
  ag2 = await createAgency(ctx, hr, 'Rank Two');
  a1 = await addAgencyMember(ctx, hr, ag1, 'one@rank.test', 'admin');
  a2 = await addAgencyMember(ctx, hr, ag2, 'two@rank.test', 'admin');
  aSub = await addAgencyMember(ctx, hr, ag1, 'sub@rank.test', 'recruiter');
  job = await vacancyWithAgencies(ctx, s, [ag1, ag2], { title: 'Ranked job', headcount: 6 });
  await call(ctx, hr, 'POST', `/vacancies/${job.id}/assign-recruiter`, { user_id: s.users.recruiter.id });
});
afterAll(() => ctx.close());

const ph = () => `9${String(300000000 + ++n * 100003).padStart(9, '0')}`;
async function applicationOf(email: string) {
  const c = await ctx.adminDb.selectFrom('candidates').select('id').where('email', '=', email).executeTakeFirstOrThrow();
  return (await ctx.adminDb.selectFrom('applications').select('id').where('candidate_id', '=', c.id).where('vacancy_id', '=', job.id).executeTakeFirstOrThrow()).id;
}
const join = (app: string) => call(ctx, hr, 'POST', `/applications/${app}/join`, { joined_on: new Date().toISOString().slice(0, 10), designation: 'Exec', annual_ctc: 1_000_000 });
async function agencySubmit(who: { cookie: string }) {
  const p = agencyProfile(`lb${++n}`, { phone: ph() });
  const res = await submitAs(ctx, who.cookie, job.id, p);
  expect(res.statusCode, res.body).toBe(201);
  return { p, app: await applicationOf(p.email) };
}
async function internalSubmit() {
  const p = agencyProfile(`lbi${++n}`, { phone: ph() });
  const made = await call(ctx, recruiter, 'POST', '/candidates', { full_name: p.full_name, email: p.email, phone: p.phone });
  expect(made.statusCode, made.body).toBe(201);
  expect((await call(ctx, recruiter, 'POST', '/applications', { candidate_id: made.json().data.id, vacancy_id: job.id })).statusCode).toBe(201);
  return { p, app: await applicationOf(p.email) };
}

describe('leaderboards', () => {
  it('rank by actual joins, and show raw and valid submissions apart', async () => {
    // Rank One: 3 valid, 1 duplicate attempt, 2 joined. Rank Two: 5 valid, 0 joined (volume must not win).
    const one = [await agencySubmit(a1), await agencySubmit(a1), await agencySubmit(aSub)];
    for (let i = 0; i < 5; i++) await agencySubmit(a2);
    const dup = await submitAs(ctx, a1.cookie, job.id, one[0]!.p);
    expect(dup.statusCode).toBe(409);
    await join(one[0]!.app);
    await join(one[1]!.app);
    const iv = await scheduleInterview(ctx, recruiter, one[2]!.app, { scheduled_start: inHours(5), scheduled_end: inHours(6), panel: [{ user_id: s.users.recruiter.id }] });
    expect(iv.status).toBe('scheduled');
    await call(ctx, hr, 'POST', `/applications/${one[2]!.app}/decisions`, { decision: 'select' });

    const res = await call(ctx, hr, 'GET', '/leaderboards/agencies');
    expect(res.statusCode, res.body).toBe(200);
    const rows = res.json().data.rows as { rank: number; name: string; raw_submissions: number; valid_submissions: number; duplicate_attempts: number; joined: number; selected: number; interviewed: number; conversion_pct: number | null; fee_model: unknown }[];
    expect(rows.map((r) => r.name)).toEqual(['Rank One', 'Rank Two']);
    expect(rows[0]).toMatchObject({ rank: 1, valid_submissions: 3, duplicate_attempts: 1, raw_submissions: 4, joined: 2, selected: 3, interviewed: 1, conversion_pct: 66.7 });
    expect(rows[1]).toMatchObject({ rank: 2, valid_submissions: 5, joined: 0, raw_submissions: 5 });
    expect(res.json().data.definitions.ranking).toContain('actual joins');
  });

  it('ranks company recruiters too, including their duplicate attempts', async () => {
    const mine = [await internalSubmit(), await internalSubmit()];
    await join(mine[0]!.app);
    const cand = await ctx.adminDb.selectFrom('candidates').select('id').where('email', '=', mine[1]!.p.email).executeTakeFirstOrThrow();
    expect((await call(ctx, recruiter, 'POST', '/applications', { candidate_id: cand.id, vacancy_id: job.id })).statusCode).toBe(409);

    const rows = (await call(ctx, hr, 'GET', '/leaderboards/recruiters')).json().data.rows as { owner_id: string; valid_submissions: number; duplicate_attempts: number; raw_submissions: number; joined: number }[];
    const row = rows.find((r) => r.owner_id === s.users.recruiter.id)!;
    expect(row).toMatchObject({ valid_submissions: 2, duplicate_attempts: 1, raw_submissions: 3, joined: 1 });
  });

  it('filters by agency, job, department and dates', async () => {
    const byAgency = (await call(ctx, hr, 'GET', `/leaderboards/agencies?agency_id=${ag2}`)).json().data.rows as { name: string }[];
    expect(byAgency.map((r) => r.name)).toEqual(['Rank Two']);
    const wrongJob = (await call(ctx, hr, 'GET', `/leaderboards/agencies?vacancy_id=${'00000000-0000-4000-8000-000000000001'}`)).json().data.rows;
    expect(wrongJob).toEqual([]);
    const past = (await call(ctx, hr, 'GET', '/leaderboards/agencies?from=2020-01-01&to=2020-01-31')).json().data.rows;
    expect(past).toEqual([]);
    const inDept = (await call(ctx, hr, 'GET', `/leaderboards/agencies?department_id=${s.eng.id}`)).json().data.rows as unknown[];
    expect(inDept.length).toBeGreaterThan(0);
    expect((await call(ctx, hr, 'GET', '/leaderboards/agencies?from=soon')).statusCode).toBe(400);
  });

  it('shows each person only their own numbers, and the HR Lead everything', async () => {
    const mine = (await call(ctx, recruiter, 'GET', '/me/performance')).json().data;
    expect(mine.me).toMatchObject({ valid_submissions: 2, joined: 1 });
    expect(mine.me.rank).toEqual(expect.any(Number));
    expect(JSON.stringify(mine)).not.toContain('Rank One');

    const agencyAdmin = (await call(ctx, a1.cookie, 'GET', '/agency/performance')).json().data;
    expect(agencyAdmin).toMatchObject({ scope: 'agency', me: { valid_submissions: 3, joined: 2 } });
    expect(agencyAdmin.team.map((t: { name: string }) => t.name).length).toBeGreaterThanOrEqual(1);
    const sub = (await call(ctx, aSub.cookie, 'GET', '/agency/performance')).json().data;
    expect(sub).toMatchObject({ scope: 'me', me: { valid_submissions: 1 }, team: [] });
    const other = (await call(ctx, a2.cookie, 'GET', '/agency/performance')).json().data;
    expect(other.me.valid_submissions).toBe(5);
    expect(JSON.stringify(other)).not.toContain('Rank One');

    for (const [path, cookie] of [['/leaderboards/recruiters', recruiter], ['/leaderboards/agencies', a1.cookie], ['/hr/dashboard', recruiter], ['/hr/dashboard', a1.cookie], ['/me/performance', a1.cookie]] as const) {
      expect((await call(ctx, cookie, 'GET', path)).statusCode, path).toBe(403);
    }
  });

  it('the HR dashboard gives the whole picture', async () => {
    await call(ctx, hr, 'POST', `/agencies/${ag1}/terms`, { payment_model: 'one_time_fee', fee_type: 'percent_of_ctc', fee_value: 8.33, lockin_days: 90, replacement_days: 30, effective_from: '2020-01-01' });
    const d = (await call(ctx, hr, 'GET', '/hr/dashboard')).json().data;
    expect(d.totals).toMatchObject({ open_jobs: expect.any(Number), joined: 3, active_employees: 3, exits: 0, interviews_scheduled: 1 });
    expect(d.jobs.find((j: { title: string }) => j.title === 'Ranked job')).toMatchObject({ target: 6, joined: 3 });
    expect(d.by_department.length).toBeGreaterThan(0);
    expect(d.agencies[0].name).toBe('Rank One');
    expect(d.agency_models.find((m: { name: string }) => m.name === 'Rank One').terms).toMatchObject({ payment_model: 'one_time_fee', fee_value: 8.33 });
    expect(d.replacements_due).toEqual([]);
  });

  it('keeps other companies out', async () => {
    const other = await setupCompany(ctx, 'lx');
    const cookie = await other.as('admin');
    expect((await call(ctx, cookie, 'GET', '/leaderboards/agencies')).json().data.rows).toEqual([]);
    expect((await call(ctx, cookie, 'GET', '/hr/dashboard')).json().data.totals).toMatchObject({ joined: 0, open_jobs: 0 });
  });
});

describe('what an agency sees of its candidates', () => {
  it('interview state, whether feedback is in, and joined, but never ratings or notes', async () => {
    const list = (await call(ctx, a1.cookie, 'GET', '/agency/submissions?page_size=100')).json();
    const progress = list.data.map((r: { progress: { interview: string | null; feedback: string | null; employment: string | null } | null }) => r.progress);
    expect(progress.filter((x: { employment: string | null }) => x?.employment === 'Joined').length).toBe(2);
    expect(progress.some((x: { interview: string | null; feedback: string | null }) => x?.interview === 'Scheduled' && x?.feedback === 'Pending')).toBe(true);
    expect(JSON.stringify(list)).not.toMatch(/rating|recommendation|notes/i);
    expect((await call(ctx, a1.cookie, 'GET', '/agency/home')).json().data.joined).toBe(2);
    expect(JSON.stringify((await call(ctx, a2.cookie, 'GET', '/agency/submissions?page_size=100')).json())).not.toContain('Joined');
  });
});

describe('agency sub-recruiters', () => {
  it('the agency admin invites and deactivates their own sub-recruiters; sub-recruiters cannot', async () => {
    const res = await call(ctx, a1.cookie, 'POST', '/agency/team/invitations', { email: 'newsub@rank.test' });
    expect(res.statusCode, res.body).toBe(201);
    expect(ctx.mailer.invitations.at(-1)).toMatchObject({ to: 'newsub@rank.test', roleName: 'Agency Sub-recruiter' });
    const team = (await call(ctx, a1.cookie, 'GET', '/agency/team')).json().data;
    expect(team.members.map((m: { email: string }) => m.email)).toEqual(expect.arrayContaining(['sub@rank.test', 'one@rank.test']));
    expect(team.invitations.map((i: { email: string }) => i.email)).toContain('newsub@rank.test');
    expect((await call(ctx, aSub.cookie, 'POST', '/agency/team/invitations', { email: 'x@rank.test' })).statusCode).toBe(403);
    expect((await call(ctx, aSub.cookie, 'GET', '/agency/team')).statusCode).toBe(403);
    expect((await call(ctx, a2.cookie, 'PATCH', `/agency/team/${aSub.userId}`, { status: 'inactive' })).statusCode).toBe(404);
    expect((await call(ctx, a1.cookie, 'PATCH', `/agency/team/${aSub.userId}`, { status: 'inactive' })).statusCode).toBe(200);
    expect((await call(ctx, aSub.cookie, 'GET', '/agency/performance')).statusCode).toBe(401);
    expect((await call(ctx, hr, 'POST', '/agency/team/invitations', { email: 'y@rank.test' })).statusCode).toBe(403);
    expect((await call(ctx, a1.cookie, 'POST', '/agency/team/invitations', { email: 'sub@rank.test' })).statusCode).toBe(409);
  });
});
