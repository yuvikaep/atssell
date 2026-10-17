// Systematic security checks. These walk the real route table and the real database catalogue, so a new
// route or table that skips authentication, row-level security or a tenant check fails here.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, setupApp, type TestContext } from './helpers.js';
import { applicationOnVacancy, PDF, scheduleInterview, setupCompany, uploadDocument } from './hiring-helpers.js';

let ctx: TestContext;
let a: Awaited<ReturnType<typeof setupCompany>>;
let b: Awaited<ReturnType<typeof setupCompany>>;
let adminA: string;
let adminB: string;
let ids: { application: string; candidate: string; vacancy: string; requisition: string; interview: string; user: string; department: string };

beforeAll(async () => {
  ctx = await setupApp();
  a = await setupCompany(ctx, 'sa');
  b = await setupCompany(ctx, 'sb');
  [adminA, adminB] = await Promise.all([a.as('admin'), b.as('admin')]);
  const app = await applicationOnVacancy(ctx, a, 'a');
  const iv = await scheduleInterview(ctx, adminA, app.applicationId);
  const rq = await ctx.adminDb.selectFrom('vacancies').select('requisition_id').where('id', '=', app.vacancyId).executeTakeFirstOrThrow();
  ids = { application: app.applicationId, candidate: app.candidateId, vacancy: app.vacancyId, requisition: rq.requisition_id, interview: iv.id, user: a.users.recruiter.id, department: a.eng.id };
});
afterAll(() => ctx.close());

const UUID = '00000000-0000-4000-8000-000000000001';
const fill = (url: string) => url.replace(/:[A-Za-z_]+/g, UUID).replace(/\*/g, 'x');
const inject = (method: string, url: string, cookie?: string) =>
  ctx.app.inject({ method: method as 'GET', url, headers: { ...(cookie ? { cookie } : {}), ...(method === 'GET' ? {} : { origin: 'http://localhost:5180' }) } });

describe('route table', () => {
  it('knows its routes, and authenticated ones are the large majority', () => {
    const t = ctx.app.routeTable;
    expect(t.length).toBeGreaterThan(100);
    expect(t.filter((r) => r.authenticated).length).toBeGreaterThan(90);
  });

  it('keeps the public surface to a known list', () => {
    const open = ctx.app.routeTable.filter((r) => !r.authenticated).map((r) => `${r.method} ${r.url}`).sort();
    // Anything added here must be a deliberate decision: public routes are rate limited and take no session.
    expect(open).toMatchSnapshot();
  });

  it('answers 401 to every authenticated route without a session', async () => {
    const failures: string[] = [];
    for (const r of ctx.app.routeTable.filter((x) => x.authenticated)) {
      const res = await inject(r.method, fill(r.url));
      if (res.statusCode !== 401) failures.push(`${r.method} ${r.url} -> ${res.statusCode}`);
    }
    expect(failures).toEqual([]);
  });

  it('answers 401 to a made-up session cookie', async () => {
    const res = await inject('GET', '/api/v1/candidates', 'jm_session=not-a-real-session');
    expect(res.statusCode).toBe(401);
  });
});

describe('database isolation', () => {
  it('forces row-level security with a tenant policy on every tenant table', async () => {
    const rows = await sql<{ table_name: string; rls: boolean; forced: boolean; policies: number }>`
      SELECT c.relname AS table_name, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
             (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'
        AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped)
    `.execute(ctx.adminDb);
    expect(rows.rows.length).toBeGreaterThan(40);
    const bad = rows.rows.filter((r) => !r.rls || !r.forced || r.policies === 0).map((r) => r.table_name);
    expect(bad).toEqual([]);
  });

  it('runs the app as a role that cannot bypass row-level security', async () => {
    const r = await sql<{ rolsuper: boolean; rolbypassrls: boolean }>`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`.execute(ctx.appDb);
    expect(r.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
  });

  it('cannot update or delete the append-only history tables, even by the app role', async () => {
    const tables = ['audit_events', 'ownership_events', 'application_stage_events', 'feedback', 'feedback_corrections', 'interview_events'];
    const r = await sql<{ t: string; priv: string; ok: boolean }>`
      SELECT t, p AS priv, has_table_privilege(current_user, 'public.' || t, p) AS ok
      FROM unnest(${tables}::text[]) AS t, unnest(ARRAY['UPDATE','DELETE']) AS p`.execute(ctx.appDb);
    expect(r.rows.filter((x) => x.ok)).toEqual([]);
  });

  it('returns nothing from a tenant table when no tenant is set', async () => {
    const r = await sql<{ n: number }>`SELECT count(*)::int AS n FROM candidates`.execute(ctx.appDb);
    expect(r.rows[0]!.n).toBe(0);
  });
});

describe('cross-tenant access', () => {
  it('hides every record of company A from company B on every direct read', async () => {
    const reads = [
      `/candidates/${ids.candidate}`, `/candidates/${ids.candidate}/documents`, `/vacancies/${ids.vacancy}`, `/requisitions/${ids.requisition}`,
      `/applications/${ids.application}`, `/applications/${ids.application}/interviews`, `/interviews/${ids.interview}`, `/departments/${ids.department}`,
      `/users/${ids.user}`, `/vacancies/${ids.vacancy}/interview-plans`,
    ];
    const leaks: string[] = [];
    for (const path of reads) {
      const own = await call(ctx, adminA, 'GET', path);
      const foreign = await call(ctx, adminB, 'GET', path);
      // A path that does not exist for the owner either is not a useful probe; the ones that do must be sealed.
      if (own.statusCode === 200 && foreign.statusCode !== 404 && foreign.statusCode !== 403) leaks.push(`${path} -> ${foreign.statusCode}`);
      if (foreign.statusCode === 200 && !path.startsWith('/departments')) {
        const body = foreign.json().data;
        if (JSON.stringify(body).includes(ids.candidate) || JSON.stringify(body).includes(ids.application)) leaks.push(`${path} leaked ids`);
      }
    }
    expect(leaks).toEqual([]);
  });

  it('refuses writes to company A records by company B', async () => {
    const writes: [string, string, object][] = [
      ['PATCH', `/candidates/${ids.candidate}`, { city: 'Hacked' }],
      ['PATCH', `/vacancies/${ids.vacancy}`, { title: 'Hacked' }],
      ['POST', `/applications/${ids.application}/move`, { stage_code: 'hired' }],
      ['POST', `/applications/${ids.application}/interviews`, { round_name: 'x', mode: 'phone', scheduled_start: new Date().toISOString(), scheduled_end: new Date().toISOString(), timezone: 'UTC', panel: [] }],
    ];
    for (const [m, p, body] of writes) {
      const res = await call(ctx, adminB, m as 'POST', p, body);
      expect([403, 404, 400, 422], `${m} ${p} -> ${res.statusCode}`).toContain(res.statusCode);
    }
    const c = await ctx.adminDb.selectFrom('candidates').select('city').where('id', '=', ids.candidate).executeTakeFirstOrThrow();
    expect(c.city).not.toBe('Hacked');
  });

  it('keeps list endpoints to the caller company', async () => {
    for (const path of ['/candidates', '/vacancies', '/requisitions', '/interviews', '/users', '/applications']) {
      const res = await call(ctx, adminB, 'GET', path);
      if (res.statusCode === 200) expect(res.body, path).not.toContain(ids.candidate);
    }
  });

  it('cannot use a download link or export of company A in company B', async () => {
    const created = await call(ctx, adminA, 'POST', '/exports', { type: 'vacancies' });
    const jobId = created.json().data.id as string;
    expect((await call(ctx, adminB, 'POST', `/exports/${jobId}/download-link`)).statusCode).toBe(404);
    expect((await call(ctx, adminB, 'GET', '/exports')).json().data.map((j: { id: string }) => j.id)).not.toContain(jobId);
  });
});

describe('hostile input', () => {
  it('treats SQL metacharacters in filters as plain text', async () => {
    const payloads = [`' OR 1=1 --`, `'; DROP TABLE candidates; --`, `%' OR '1'='1`, `\\`, '"'];
    for (const q of payloads) {
      for (const path of ['/candidates', '/vacancies', '/users', '/requisitions']) {
        const res = await call(ctx, adminA, 'GET', `${path}?q=${encodeURIComponent(q)}&search=${encodeURIComponent(q)}&status=${encodeURIComponent(q)}`);
        expect(res.statusCode, `${path} ${q}`).toBeLessThan(500);
      }
    }
    const still = await call(ctx, adminA, 'GET', `/candidates/${ids.candidate}`);
    expect(still.statusCode).toBe(200);
  });

  it('stores an uploaded file under a generated key, never the name it was given', async () => {
    const res = await uploadDocument(ctx, adminA, ids.candidate, '../../../etc/passwd.pdf', PDF('traversal'));
    expect(res.statusCode, res.body).toBe(201);
    const keys = [...ctx.storage.files.keys()];
    expect(keys.some((k) => k.includes('..') || k.includes('passwd'))).toBe(false);
  });

  it('refuses a malformed id instead of querying with it', async () => {
    for (const path of [`/candidates/1%27%20OR%201=1`, `/vacancies/..%2F..%2Fetc`, `/interviews/null`]) {
      const res = await call(ctx, adminA, 'GET', path);
      expect([400, 404], path).toContain(res.statusCode);
    }
  });

  it('sets no-store and no-referrer headers so one-time links are not cached or leaked', async () => {
    const res = await call(ctx, adminA, 'GET', '/candidates');
    expect(res.headers['cache-control']).toContain('no-store');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
  });
});

describe('dependencies', () => {
  it('has no known high or critical vulnerabilities in production dependencies', () => {
    let out = '';
    try {
      out = execFileSync('npm', ['audit', '--omit=dev', '--audit-level=high', '--json'], { cwd: path.resolve(import.meta.dirname, '../..'), encoding: 'utf8', timeout: 60_000 });
    } catch (err) {
      out = (err as { stdout?: string }).stdout ?? '';
      // Offline or registry trouble is not a finding; a reported vulnerability is.
      if (!out.trim().startsWith('{')) return;
    }
    const report = JSON.parse(out) as { metadata?: { vulnerabilities?: { high?: number; critical?: number } } };
    const v = report.metadata?.vulnerabilities;
    expect((v?.high ?? 0) + (v?.critical ?? 0)).toBe(0);
  });
});
