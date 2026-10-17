// Cross-tenant isolation for Sprint 2: a user of company A must never read or change company B's
// requisitions, vacancies, candidates, documents or applications, through the API or the database.
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant } from '../src/db.js';
import { signFileToken } from '../src/storage.js';
import { call, setupApp, type TestContext } from './helpers.js';
import { approvedRequisition, openVacancy, PDF, requisitionPayload, setupCompany, uploadDocument } from './hiring-helpers.js';

let ctx: TestContext;
let a: Awaited<ReturnType<typeof setupCompany>>;
let b: Awaited<ReturnType<typeof setupCompany>>;
let adminA: string;
let adminB: string;
let B: { requisition: string; vacancy: string; candidate: string; application: string; document: string; agency: string; stage: string };

beforeAll(async () => {
  ctx = await setupApp();
  a = await setupCompany(ctx, 'ta');
  b = await setupCompany(ctx, 'tb');
  [adminA, adminB] = await Promise.all([a.as('admin'), b.as('admin')]);

  const requisition = await approvedRequisition(ctx, b);
  const vacancy = (await openVacancy(ctx, adminB, requisition)).id;
  const candidate = (await call(ctx, adminB, 'POST', '/candidates', { full_name: 'Bee Candidate', email: 'bee@secret.test', phone: '9000000001' })).json().data.id;
  const application = (await call(ctx, adminB, 'POST', '/applications', { candidate_id: candidate, vacancy_id: vacancy })).json().data.id;
  const document = (await uploadDocument(ctx, adminB, candidate, 'bee.pdf', PDF('bee'))).json().data.id;
  const agency = (await call(ctx, adminB, 'POST', '/agencies', { name: 'B Agency' })).json().data.id;
  const stage = (await call(ctx, adminB, 'GET', '/pipeline/stages')).json().data[1].id;
  B = { requisition, vacancy, candidate, application, document, agency, stage };
});
afterAll(() => ctx.close());

describe('API isolation', () => {
  it('lists never include the other company', async () => {
    for (const url of ['/requisitions', '/vacancies?status=all', '/candidates', '/applications?status=all', '/agencies?status=all']) {
      const body = (await call(ctx, adminA, 'GET', url)).body;
      for (const secret of [B.requisition, B.vacancy, B.candidate, B.application, B.agency, 'Bee Candidate', 'bee@secret.test']) {
        expect(body, `${url} leaked ${secret}`).not.toContain(secret);
      }
    }
  });

  it('every read of another company data is a 404', async () => {
    for (const url of [
      `/requisitions/${B.requisition}`,
      `/vacancies/${B.vacancy}`,
      `/candidates/${B.candidate}`,
      `/applications/${B.application}/history`,
    ]) {
      expect((await call(ctx, adminA, 'GET', url)).statusCode, url).toBe(404);
    }
  });

  it('every change to another company data is refused and changes nothing', async () => {
    const attempts: [string, 'PATCH' | 'POST', string, object][] = [
      ['requisition edit', 'PATCH', `/requisitions/${B.requisition}`, { title: 'Hacked' }],
      ['requisition submit', 'POST', `/requisitions/${B.requisition}/submit-approval`, { approver_user_ids: [a.users.hr1.id] }],
      ['requisition cancel', 'POST', `/requisitions/${B.requisition}/cancel`, { reason: 'x' }],
      ['open vacancy', 'POST', `/requisitions/${B.requisition}/vacancies`, {}],
      ['vacancy edit', 'PATCH', `/vacancies/${B.vacancy}`, { title: 'Hacked' }],
      ['assign recruiter', 'POST', `/vacancies/${B.vacancy}/assign-recruiter`, { user_id: a.users.recruiter.id }],
      ['assign agency', 'POST', `/vacancies/${B.vacancy}/assign-agency`, { agency_id: B.agency }],
      ['candidate edit', 'PATCH', `/candidates/${B.candidate}`, { full_name: 'Hacked Name' }],
      ['candidate note', 'POST', `/candidates/${B.candidate}/notes`, { body: 'planted' }],
      ['agency edit', 'PATCH', `/agencies/${B.agency}`, { name: 'Hacked Agency' }],
      ['stage move', 'PATCH', `/applications/${B.application}/stage`, { stage_id: B.stage }],
    ];
    for (const [label, method, url, body] of attempts) {
      const res = await call(ctx, adminA, method, url, body);
      expect([404, 422], `${label}: ${res.statusCode} ${res.body}`).toContain(res.statusCode);
    }
    const [rq, v, c, ag, app] = await Promise.all([
      ctx.adminDb.selectFrom('requisitions').select(['title', 'status']).where('id', '=', B.requisition).executeTakeFirstOrThrow(),
      ctx.adminDb.selectFrom('vacancies').select('title').where('id', '=', B.vacancy).executeTakeFirstOrThrow(),
      ctx.adminDb.selectFrom('candidates').select('full_name').where('id', '=', B.candidate).executeTakeFirstOrThrow(),
      ctx.adminDb.selectFrom('agencies').select('name').where('id', '=', B.agency).executeTakeFirstOrThrow(),
      ctx.adminDb.selectFrom('applications').select('stage_id').where('id', '=', B.application).executeTakeFirstOrThrow(),
    ]);
    expect(rq).toMatchObject({ title: 'Backend Engineer', status: 'approved' });
    expect(v.title).toBe('Backend Engineer');
    expect(c.full_name).toBe('Bee Candidate');
    expect(ag.name).toBe('B Agency');
    expect(app.stage_id).not.toBe(B.stage);
    const notes = await ctx.adminDb.selectFrom('candidate_notes').select('id').where('candidate_id', '=', B.candidate).execute();
    expect(notes).toHaveLength(0);
  });

  it('cannot use another company ids as references in its own data', async () => {
    const dept = await call(ctx, adminA, 'POST', '/requisitions', requisitionPayload(a.eng.id, { hiring_manager_id: b.users.hr1.id }));
    expect(dept.statusCode).toBe(422);
    const foreignDept = await call(ctx, adminA, 'POST', '/requisitions', requisitionPayload(b.eng.id));
    expect(foreignDept.statusCode).toBe(422);

    const ownVacancy = await openVacancy(ctx, adminA, await approvedRequisition(ctx, a));
    expect((await call(ctx, adminA, 'POST', `/vacancies/${ownVacancy.id}/assign-agency`, { agency_id: B.agency })).statusCode).toBe(422);
    expect((await call(ctx, adminA, 'POST', `/vacancies/${ownVacancy.id}/assign-recruiter`, { user_id: b.users.recruiter.id })).statusCode).toBe(422);
    expect((await call(ctx, adminA, 'PATCH', `/vacancies/${ownVacancy.id}`, { owner_user_id: b.users.hr1.id })).statusCode).toBe(422);

    const own = (await call(ctx, adminA, 'POST', '/candidates', { full_name: 'Aye Candidate', email: 'aye@mail.test' })).json().data.id;
    const app = await call(ctx, adminA, 'POST', '/applications', { candidate_id: own, vacancy_id: ownVacancy.id });
    expect(app.statusCode).toBe(201);
    // Another company's stage id is not a valid move in this company.
    expect((await call(ctx, adminA, 'PATCH', `/applications/${app.json().data.id}/stage`, { stage_id: B.stage })).statusCode).toBe(422);
    // Applications cannot link to another company's candidate or vacancy.
    expect((await call(ctx, adminA, 'POST', '/applications', { candidate_id: B.candidate, vacancy_id: ownVacancy.id })).statusCode).toBe(404);
    expect((await call(ctx, adminA, 'POST', '/applications', { candidate_id: own, vacancy_id: B.vacancy })).statusCode).toBe(404);
    // Nor can profiles be merged across companies.
    expect((await call(ctx, adminA, 'POST', `/candidates/${own}/merge`, { source_candidate_id: B.candidate, reason: 'x' })).statusCode).toBe(404);
    expect((await call(ctx, adminA, 'POST', `/candidates/${B.candidate}/merge`, { source_candidate_id: own, reason: 'x' })).statusCode).toBe(404);
  });

  it('cannot see, upload or download another company resumes', async () => {
    expect((await uploadDocument(ctx, adminA, B.candidate, 'planted.pdf', PDF('planted'))).statusCode).toBe(404);
    expect((await call(ctx, adminA, 'POST', `/candidates/${B.candidate}/documents/${B.document}/download-url`)).statusCode).toBe(404);

    // A link signed for tenant A cannot be pointed at B's document: documents are looked up under the
    // token's tenant, where B's rows do not exist.
    const token = signFileToken(ctx.app.config.FILE_URL_SECRET, { t: a.co.tenant.id, d: B.document, e: Math.floor(Date.now() / 1000) + 60 });
    expect((await ctx.app.inject({ method: 'GET', url: `/api/v1/files/${token}` })).statusCode).toBe(410);

    const real = signFileToken(ctx.app.config.FILE_URL_SECRET, { t: b.co.tenant.id, d: B.document, e: Math.floor(Date.now() / 1000) + 60 });
    expect((await ctx.app.inject({ method: 'GET', url: `/api/v1/files/${real}` })).statusCode).toBe(200);
  });

  it('duplicate checks do not reveal that another company has the same person', async () => {
    const res = await call(ctx, adminA, 'POST', '/candidates', { full_name: 'Bee Candidate', email: 'bee@secret.test', phone: '9000000001' });
    expect(res.statusCode).toBe(201);
    const check = await call(ctx, adminA, 'POST', '/candidates/duplicate-check', { full_name: 'Bee Candidate', email: 'bee@secret.test' });
    expect(check.json().data.exact.map((d: { id: string }) => d.id)).toEqual([res.json().data.id]);
  });

  it('vacancy codes are numbered per company', async () => {
    const codes = async (cookie: string) => (await call(ctx, cookie, 'GET', '/vacancies?status=all&page_size=100')).json().data.map((v: { vacancy_code: string }) => v.vacancy_code);
    expect((await codes(adminA)).includes('VAC-0001')).toBe(true);
    expect((await codes(adminB)).includes('VAC-0001')).toBe(true);
  });
});

describe('database-level isolation for the new tables', () => {
  const TABLES = [
    'requisitions', 'requisition_approvals', 'vacancies', 'vacancy_recruiters', 'vacancy_agencies', 'agencies',
    'candidates', 'candidate_documents', 'candidate_notes', 'candidate_merges', 'applications',
    'application_stage_events', 'submissions', 'pipeline_stages', 'pipeline_stage_transitions', 'tenant_counters',
  ];

  it('without a tenant context the app role sees no rows in any of them', async () => {
    for (const t of TABLES) {
      const { rows } = await sql<{ n: number }>`SELECT count(*)::int AS n FROM ${sql.table(t)}`.execute(ctx.appDb);
      expect(rows[0]!.n, t).toBe(0);
    }
  });

  it('a tenant-scoped transaction sees only its own rows in each of them', async () => {
    for (const t of TABLES) {
      const rows = await withTenant(ctx.appDb, a.co.tenant.id, async (tx) => (await sql<{ tenant_id: string }>`SELECT tenant_id FROM ${sql.table(t)}`.execute(tx)).rows);
      expect(rows.every((r) => r.tenant_id === a.co.tenant.id), t).toBe(true);
    }
  });

  it('all of them have row-level security enabled and forced', async () => {
    const { rows } = await sql<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>`
      SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = ANY(${TABLES})`.execute(ctx.adminDb);
    expect(rows).toHaveLength(TABLES.length);
    for (const r of rows) expect(r, r.relname).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true });
  });

  it('composite keys stop a row pointing across companies even for a privileged connection', async () => {
    const vacancyA = (await openVacancy(ctx, adminA, await approvedRequisition(ctx, a))).id;
    const stageA = (await call(ctx, adminA, 'GET', '/pipeline/stages')).json().data[0].id;
    // Company A's own vacancy and stage, but company B's candidate.
    await expect(
      ctx.adminDb.insertInto('applications').values({
        tenant_id: a.co.tenant.id, candidate_id: B.candidate, vacancy_id: vacancyA, stage_id: stageA,
      }).execute(),
    ).rejects.toThrow(/foreign key/);
  });

  it('the app role cannot rewrite the audit trail or the stage history', async () => {
    for (const t of ['audit_events', 'application_stage_events'] as const) {
      await expect(withTenant(ctx.appDb, a.co.tenant.id, (tx) => tx.deleteFrom(t).execute())).rejects.toThrow(/permission denied/);
    }
  });
});
