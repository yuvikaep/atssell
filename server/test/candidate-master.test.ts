import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseCsv } from '../src/routes/candidate-master.js';
import { call, setupApp, type TestContext } from './helpers.js';
import { addAgencyMember, agencyProfile, applicationOnVacancy, createAgency, setupCompany, submitAs, vacancyWithAgencies } from './hiring-helpers.js';

let ctx: TestContext;
let s: Awaited<ReturnType<typeof setupCompany>>;
let hr: string;
let recruiter: string;
let agency: { cookie: string };
let job: { id: string; vacancy_code: string };
let stages: Record<string, string>;
let n = 0;

beforeAll(async () => {
  ctx = await setupApp();
  s = await setupCompany(ctx, 'cmz');
  [hr, recruiter] = await Promise.all([s.as('admin'), s.as('recruiter')]);
  const ag = await createAgency(ctx, hr, 'Master Agency');
  agency = await addAgencyMember(ctx, hr, ag, 'm@master.test', 'admin');
  job = await vacancyWithAgencies(ctx, s, [ag], { title: 'Master job' });
  await call(ctx, hr, 'POST', `/vacancies/${job.id}/assign-recruiter`, { user_id: s.users.recruiter.id });
  stages = Object.fromEntries(((await call(ctx, hr, 'GET', '/pipeline/stages')).json().data as { id: string; code: string }[]).map((x) => [x.code, x.id]));
  await submitAs(ctx, agency.cookie, job.id, agencyProfile('zebra', { full_name: 'Zed Zebra', phone: '9000000111' }));
  await call(ctx, recruiter, 'POST', '/candidates', { full_name: 'Amy Alpha', email: 'amy@mail.test', phone: '9000000222', city: 'Pune' }).then(async (r) => call(ctx, recruiter, 'POST', '/applications', { candidate_id: r.json().data.id, vacancy_id: job.id }));
});
afterAll(() => ctx.close());

const master = async (cookie: string, qs = '') => (await call(ctx, cookie, 'GET', `/candidate-master${qs}`)).json();

describe('candidate master', () => {
  it('has one row per candidate with the latest job, status and source, sortable and filterable', async () => {
    const res = await master(hr);
    const names = res.data.map((r: { full_name: string }) => r.full_name);
    expect(names).toEqual(expect.arrayContaining(['Zed Zebra', 'Amy Alpha']));
    const zed = res.data.find((r: { full_name: string }) => r.full_name === 'Zed Zebra');
    expect(zed).toMatchObject({ job_title: 'Master job', stage_code: 'submitted', source: 'Agency: Master Agency', applications: 1 });
    expect(res.data.find((r: { full_name: string }) => r.full_name === 'Amy Alpha').source).toMatch(/^Recruiter: /);

    const asc = (await master(hr, '?sort=name&dir=asc')).data.map((r: { full_name: string }) => r.full_name);
    expect(asc).toEqual([...asc].sort((a: string, b: string) => a.localeCompare(b)));
    expect((await master(hr, '?sort=name&dir=desc')).data[0].full_name).toBe([...asc].sort((a: string, b: string) => b.localeCompare(a))[0]);
    expect((await master(hr, '?source=agency')).data.map((r: { full_name: string }) => r.full_name)).toEqual(['Zed Zebra']);
    expect((await master(hr, '?source=internal')).data.map((r: { full_name: string }) => r.full_name)).toContain('Amy Alpha');
    expect((await master(hr, '?q=zebra')).total).toBe(1);
    expect((await master(hr, '?city=pune')).data.map((r: { full_name: string }) => r.full_name)).toEqual(['Amy Alpha']);
    expect((await master(hr, '?stage=submitted')).total).toBeGreaterThanOrEqual(2);
    expect((await call(ctx, hr, 'GET', '/candidate-master?sort=drop_table')).statusCode).toBe(400);
  });

  it('tells each role which statuses it may set inline, and enforces it on the server', async () => {
    expect((await master(hr)).settable_stages).toEqual(expect.arrayContaining(['screening', 'interview', 'offer', 'rejected']));
    expect((await master(hr)).settable_stages).not.toContain('hired');
    expect((await master(recruiter)).settable_stages).toEqual(['screening', 'shortlisted']);
    const row = (await master(recruiter)).data.find((r: { full_name: string }) => r.full_name === 'Amy Alpha');
    expect((await call(ctx, recruiter, 'PATCH', `/applications/${row.application_id}/stage`, { stage_id: stages.screening })).statusCode).toBe(200);
    expect((await call(ctx, recruiter, 'PATCH', `/applications/${row.application_id}/stage`, { stage_id: stages.shortlisted })).statusCode).toBe(200);
    const denied = await call(ctx, recruiter, 'PATCH', `/applications/${row.application_id}/stage`, { stage_id: stages.interview });
    expect(denied.statusCode).toBe(403);
    expect((await call(ctx, hr, 'PATCH', `/applications/${row.application_id}/stage`, { stage_id: stages.interview })).statusCode).toBe(200);
    expect((await master(hr)).data.find((r: { full_name: string }) => r.full_name === 'Amy Alpha').stage_code).toBe('interview');
  });

  it('is closed to agencies and interviewers, and per company', async () => {
    expect((await call(ctx, agency.cookie, 'GET', '/candidate-master')).statusCode).toBe(403);
    const other = await setupCompany(ctx, 'cmy');
    expect((await master(await other.as('admin'))).data).toEqual([]);
  });
});

describe('csv reader', () => {
  it('handles quotes, commas and line breaks inside quotes, a BOM and Windows line endings', () => {
    const rows = parseCsv('﻿Name,Notes\r\n"Doe, Jane","said ""hi""\nthere"\r\nPlain,x\r\n\r\n');
    expect(rows).toEqual([['Name', 'Notes'], ['Doe, Jane', 'said "hi"\nthere'], ['Plain', 'x']]);
  });
});

describe('csv import', () => {
  const post = (cookie: string, csv: string, extra: object = {}) => call(ctx, cookie, 'POST', '/candidates/import', { csv, ...extra });

  it('creates people, matches existing ones, rejects bad rows with the reason, and a dry run saves nothing', async () => {
    const uniq = ++n;
    const csv = [
      'Name,Email,Mobile,City,Experience,Skills',
      `New One,new.one${uniq}@mail.test,9${String(100000000 + uniq).padStart(9, '0')},Delhi,4,"Sales; CRM"`,
      'Amy Again,amy@mail.test,,Pune,2,',
      ',nobody@mail.test,,,,',
      'Bad Email,not-an-email,,,,',
      'Bad Phone,,12345,,,',
    ].join('\n');
    const dry = await post(hr, csv, { dry_run: true });
    expect(dry.json().data.summary).toMatchObject({ dry_run: true, total: 5, created: 1, existing: 1, failed: 3 });
    expect(await ctx.adminDb.selectFrom('candidates').select('id').where('email', '=', `new.one${uniq}@mail.test`).execute()).toHaveLength(0);

    const res = await post(hr, csv);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data.summary).toMatchObject({ total: 5, created: 1, existing: 1, failed: 3 });
    const failed = res.json().data.rows.filter((r: { status: string }) => r.status === 'failed');
    expect(failed.map((r: { error: string }) => r.error)).toEqual(['Name is missing.', 'Email is not valid.', 'Phone is not valid.']);
    const made = await ctx.adminDb.selectFrom('candidates').select(['skills', 'phone', 'city']).where('email', '=', `new.one${uniq}@mail.test`).executeTakeFirstOrThrow();
    expect(made).toMatchObject({ skills: ['Sales', 'CRM'], city: 'Delhi' });
    expect(made.phone).toMatch(/^\+91/);
    const audit = await ctx.adminDb.selectFrom('audit_events').select('metadata').where('action', '=', 'candidates.imported').orderBy('created_at', 'desc').executeTakeFirstOrThrow();
    expect(audit.metadata).toMatchObject({ created: 1, existing: 1, failed: 3 });
  });

  it('submits each person to a job by its code with first-submission-wins, recording duplicates', async () => {
    const uniq = ++n;
    const email = `job.import${uniq}@mail.test`;
    const csv = `Name,Email,Phone,Job\nImp Job,${email},9${String(200000000 + uniq).padStart(9, '0')},${job.vacancy_code}`;
    const first = await post(recruiter, csv);
    expect(first.json().data.summary).toMatchObject({ created: 1, submitted: 1, duplicates: 0 });
    const again = await post(recruiter, csv);
    expect(again.json().data.summary).toMatchObject({ existing: 1, submitted: 0, duplicates: 1 });
    const cand = await ctx.adminDb.selectFrom('candidates').select('id').where('email', '=', email).executeTakeFirstOrThrow();
    expect(await ctx.adminDb.selectFrom('duplicate_attempts').select('id').where('candidate_id', '=', cand.id).execute()).toHaveLength(1);
    const subs = await ctx.adminDb.selectFrom('submissions as s').innerJoin('applications as a', 'a.id', 's.application_id').select(['s.source_user_id', 's.ownership_state']).where('a.candidate_id', '=', cand.id).execute();
    expect(subs).toEqual([{ source_user_id: s.users.recruiter.id, ownership_state: 'accepted' }]);
  });

  it('refuses a job the recruiter is not assigned to, a file without the needed columns, and an oversized file', async () => {
    const unassigned = await applicationOnVacancy(ctx, s, 'unass');
    const code = (await ctx.adminDb.selectFrom('vacancies').select('vacancy_code').where('id', '=', unassigned.vacancyId).executeTakeFirstOrThrow()).vacancy_code;
    const res = await post(recruiter, `Name,Email,Job\nNo Access,no.access@mail.test,${code}`);
    expect(res.json().data.summary).toMatchObject({ failed: 1, created: 0 });
    expect(res.json().data.rows[0].error).toContain('not assigned to you');
    expect((await post(hr, 'Foo,Bar\n1,2')).statusCode).toBe(400);
    expect((await post(hr, 'Name\nA')).statusCode).toBe(400);
    expect((await post(hr, 'Name,Email\n' + Array.from({ length: 501 }, (_, i) => `P${i},p${i}@mail.test`).join('\n'))).statusCode).toBe(413);
    expect((await call(ctx, agency.cookie, 'POST', '/candidates/import', { csv: 'Name,Email\nA,a@mail.test' })).statusCode).toBe(403);
  });
});
