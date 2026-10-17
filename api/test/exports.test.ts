import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { csvCell, toCsv } from '../src/exports.js';
import { runTenantTick, type WorkerDeps } from '../src/worker.js';
import { call, setupApp, type TestContext } from './helpers.js';
import { applicationOnVacancy, setupCompany } from './hiring-helpers.js';

let ctx: TestContext;
let s: Awaited<ReturnType<typeof setupCompany>>;
let other: Awaited<ReturnType<typeof setupCompany>>;
let admin: string;
let hr: string;
let recruiter: string;
let otherAdmin: string;
let deps: WorkerDeps;

beforeAll(async () => {
  ctx = await setupApp();
  s = await setupCompany(ctx, 'ex');
  other = await setupCompany(ctx, 'ey');
  [admin, hr, recruiter, otherAdmin] = await Promise.all([s.as('admin'), s.as('hr1'), s.as('recruiter'), other.as('admin')]);
  await applicationOnVacancy(ctx, s, 'a');
  await applicationOnVacancy(ctx, other, 'a');
  deps = { db: ctx.appDb, mailer: ctx.mailer, config: ctx.app.config, storage: ctx.storage };
});
afterAll(() => ctx.close());

const run = (tenantId = s.co.tenant.id) => runTenantTick(deps, tenantId, new Date());
async function exportCsv(cookie: string, body: object, tenantId = s.co.tenant.id) {
  const created = await call(ctx, cookie, 'POST', '/exports', body);
  expect(created.statusCode, created.body).toBe(202);
  const id = created.json().data.id as string;
  await run(tenantId);
  const link = await call(ctx, cookie, 'POST', `/exports/${id}/download-link`);
  expect(link.statusCode, link.body).toBe(200);
  const file = await ctx.app.inject({ method: 'GET', url: link.json().data.url });
  return { id, file, link };
}

describe('csv cells', () => {
  it('neutralise spreadsheet formulas and quote special characters', () => {
    expect(csvCell('=HYPERLINK("http://x")')).toBe(`"'=HYPERLINK(""http://x"")"`);
    expect(csvCell('+1 555')).toBe("'+1 555");
    expect(csvCell('-2+3')).toBe("'-2+3");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell(-5)).toBe('-5');
    expect(csvCell(null)).toBe('');
    expect(toCsv(['A'], [['x']])).toBe('﻿A\r\nx\r\n');
  });
});

describe('exports', () => {
  it('builds a candidates file through the worker and serves it by a signed link', async () => {
    const { file } = await exportCsv(admin, { type: 'candidates' });
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-type']).toContain('text/csv');
    expect(file.headers['cache-control']).toContain('no-store');
    expect(file.body).toContain('Interviewee a');
    expect(file.body).toContain('Name');
  });

  it('keeps another company out of the file', async () => {
    const { file } = await exportCsv(admin, { type: 'applications' });
    expect(file.body.split('\r\n').filter(Boolean)).toHaveLength(2);
    const theirs = await exportCsv(otherAdmin, { type: 'applications' }, other.co.tenant.id);
    expect(theirs.file.body.split('\r\n').filter(Boolean)).toHaveLength(2);
  });

  it('drops fields the requester may not see', async () => {
    const opts = (await call(ctx, hr, 'GET', '/exports/options')).json().data as { type: string; fields: { key: string }[] }[];
    const keys = opts.find((o) => o.type === 'candidates')!.fields.map((f) => f.key);
    expect(keys).toContain('full_name');
    const adminKeys = ((await call(ctx, admin, 'GET', '/exports/options')).json().data as typeof opts).find((o) => o.type === 'candidates')!.fields.map((f) => f.key);
    expect(adminKeys).toContain('current_ctc');
    const denied = await call(ctx, admin, 'POST', '/exports', { type: 'candidates', fields: ['nonsense'] });
    expect(denied.statusCode).toBe(400);
  });

  it('refuses people without export permission', async () => {
    expect((await call(ctx, recruiter, 'POST', '/exports', { type: 'candidates' })).statusCode).toBe(403);
    expect((await call(ctx, recruiter, 'GET', '/exports/options')).json().data).toEqual([]);
  });

  it('lets only the requester download, and refuses forged or foreign links', async () => {
    const created = await call(ctx, admin, 'POST', '/exports', { type: 'vacancies' });
    const id = created.json().data.id as string;
    await run();
    expect((await call(ctx, hr, 'POST', `/exports/${id}/download-link`)).statusCode).toBe(404);
    const link = (await call(ctx, admin, 'POST', `/exports/${id}/download-link`)).json().data.url as string;
    const forged = link.slice(0, -3) + 'abc';
    expect((await ctx.app.inject({ method: 'GET', url: forged })).statusCode).toBe(410);
  });

  it('fails a job whose requester lost access, and says why', async () => {
    const created = await call(ctx, hr, 'POST', '/exports', { type: 'candidates' });
    const id = created.json().data.id as string;
    await ctx.adminDb.updateTable('users').set({ status: 'inactive' }).where('id', '=', s.users.hr1.id).execute();
    await run();
    await ctx.adminDb.updateTable('users').set({ status: 'active' }).where('id', '=', s.users.hr1.id).execute();
    const row = await ctx.adminDb.selectFrom('export_jobs').select(['status', 'error']).where('id', '=', id).executeTakeFirstOrThrow();
    expect(row.status).toBe('failed');
    expect(row.error).toMatch(/no longer/);
  });

  it('records who asked for and fetched an export', async () => {
    const { id } = await exportCsv(admin, { type: 'vacancies' });
    const actions = (await ctx.adminDb.selectFrom('audit_events').select('action').where('entity_id', '=', id).execute()).map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(['export.requested', 'export.completed', 'export.download_link_issued', 'export.downloaded']));
  });

  it('turns away an expired export', async () => {
    const { id } = await exportCsv(admin, { type: 'vacancies' });
    await ctx.adminDb.updateTable('export_jobs').set({ expires_at: new Date(Date.now() - 1000) }).where('id', '=', id).execute();
    expect((await call(ctx, admin, 'POST', `/exports/${id}/download-link`)).statusCode).toBe(410);
  });
});
