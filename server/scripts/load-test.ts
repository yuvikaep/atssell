// Load test against a running API. Provisions its own throwaway company, seeds it with realistic volume
// through the API, then runs a mixed read workload at fixed concurrency and reports latency percentiles.
// Exits non-zero if p95 exceeds the target (default 2000 ms) or any request fails.
//
//   npm run -w server load-test -- --candidates 2000 --duration 30 --concurrency 20
//
// Needs the API running (API_URL, default http://localhost:3000) and DATABASE_URL_ADMIN for provisioning.
import { parseArgs } from 'node:util';
import { createDb } from '../src/db.js';
import { hashPassword } from '../src/security.js';
import { createTenant } from '../src/services/tenants.js';

const { values } = parseArgs({
  options: {
    candidates: { type: 'string', default: '2000' },
    vacancies: { type: 'string', default: '40' },
    duration: { type: 'string', default: '30' },
    concurrency: { type: 'string', default: '20' },
    'p95-ms': { type: 'string', default: '2000' },
  },
});
const N_CAND = Number(values.candidates);
const N_VAC = Number(values.vacancies);
const DURATION_S = Number(values.duration);
const CONCURRENCY = Number(values.concurrency);
const P95_TARGET = Number(values['p95-ms']);
const API = process.env.API_URL ?? 'http://localhost:3000';
const ORIGIN = process.env.WEB_ORIGIN ?? 'http://localhost:5180';
const PASSWORD = 'load-test-password-123';
const slug = `load${Date.now().toString(36)}`;

const adminUrl = process.env.DATABASE_URL_ADMIN;
if (!adminUrl) throw new Error('DATABASE_URL_ADMIN is not set');
const adminDb = createDb(adminUrl, 1);

async function provision() {
  const { tenant, admin } = await createTenant(adminDb, { name: `Load Test ${slug}`, slug, adminEmail: `admin@${slug}.test`, adminName: 'Load Admin' });
  const hash = await hashPassword(PASSWORD);
  await adminDb.updateTable('users').set({ password_hash: hash }).where('id', '=', admin.id).execute();
  const hr = await adminDb.insertInto('users').values({ tenant_id: tenant.id, email: `hr@${slug}.test`, full_name: 'Load HR', password_hash: hash }).returning('id').executeTakeFirstOrThrow();
  const role = await adminDb.selectFrom('roles').select('id').where('code', '=', 'hr_head').where('tenant_id', 'is', null).executeTakeFirstOrThrow();
  await adminDb.insertInto('user_role_assignments').values({ tenant_id: tenant.id, user_id: hr.id, role_id: role.id }).execute();
  const dept = await adminDb.insertInto('departments').values({ tenant_id: tenant.id, name: 'Engineering' }).returning('id').executeTakeFirstOrThrow();
  return { tenantId: tenant.id, departmentId: dept.id, hrId: hr.id, adminEmail: admin.email, hrEmail: `hr@${slug}.test` };
}

async function login(email: string) {
  const res = await fetch(`${API}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ company: slug, email, password: PASSWORD }) });
  if (!res.ok) throw new Error(`login failed ${res.status}: ${await res.text()}`);
  return res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
}

async function post(cookie: string, path: string, body: unknown) {
  const res = await fetch(`${API}/api/v1${path}`, { method: 'POST', headers: { 'content-type': 'application/json', cookie, origin: ORIGIN }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`POST ${path} -> ${res.status} ${JSON.stringify(json)}`);
  return json.data;
}

/** Runs `n` jobs through a small worker pool, so seeding is quick without hammering the login rate limit. */
async function pool<T>(n: number, size: number, job: (i: number) => Promise<T>) {
  let next = 0;
  const out: T[] = [];
  await Promise.all(Array.from({ length: size }, async () => { for (;;) { const i = next++; if (i >= n) return; out[i] = await job(i); } }));
  return out;
}

const pct = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;

try {
  console.log(`Provisioning company ${slug}…`);
  const p = await provision();
  const admin = await login(p.adminEmail);
  const hr = await login(p.hrEmail);

  console.log(`Seeding ${N_VAC} vacancies and ${N_CAND} candidates…`);
  const vacancies = await pool(N_VAC, 4, async (i) => {
    const rq = await post(admin, '/requisitions', {
      department_id: p.departmentId, title: `Role ${i}`, description: 'Load test role description with enough detail.', headcount: 2, employment_type: 'full_time',
      location: ['Pune', 'Mumbai', 'Remote'][i % 3], skills: ['Node.js'], min_experience_years: 1, max_experience_years: 8, min_ctc: 1_000_000, max_ctc: 3_000_000, priority: 'normal', target_date: '2099-01-01',
    });
    await post(admin, `/requisitions/${rq.id}/submit-approval`, { approver_user_ids: [p.hrId] });
    await post(hr, `/requisitions/${rq.id}/approve`, { decision: 'approved' });
    return (await post(admin, `/requisitions/${rq.id}/vacancies`, {})).id as string;
  });
  const vacancyIds = vacancies;
  const candidateIds = await pool(N_CAND, 8, (i) =>
    post(admin, '/candidates', {
      full_name: `Candidate ${i}`, email: `cand${i}@${slug}.test`, phone: `98${String(10_000_000 + i)}`, current_title: 'Engineer',
      total_experience_years: i % 15, skills: ['Node.js', 'SQL'], city: ['Pune', 'Mumbai', 'Delhi'][i % 3],
    }).then((c) => c.id as string));
  await pool(Math.floor(N_CAND / 2), 8, (i) => post(admin, '/applications', { candidate_id: candidateIds[i], vacancy_id: vacancyIds[i % vacancyIds.length] }));

  const endpoints = [
    '/analytics/dashboard', '/candidates?page_size=25', '/candidates?q=Candidate%201', '/vacancies', '/requisitions',
    '/analytics/hiring-funnel', '/analytics/time-to-hire', '/analytics/vacancy-ageing', '/analytics/feedback-sla', '/notifications/unread-count', '/interviews',
  ];
  console.log(`Running ${CONCURRENCY} concurrent users for ${DURATION_S}s over ${endpoints.length} endpoints…`);
  const stats = new Map<string, number[]>();
  let errors = 0;
  const stopAt = Date.now() + DURATION_S * 1000;
  await Promise.all(Array.from({ length: CONCURRENCY }, async (_, w) => {
    for (let i = w; Date.now() < stopAt; i++) {
      const path = endpoints[i % endpoints.length]!;
      const t0 = performance.now();
      const res = await fetch(`${API}/api/v1${path}`, { headers: { cookie: admin } }).catch(() => null);
      const ms = performance.now() - t0;
      if (!res || !res.ok) { errors++; if (res) console.log(`  ${res.status} ${path}`); }
      await res?.arrayBuffer();
      stats.set(path, [...(stats.get(path) ?? []), ms]);
    }
  }));

  const all = [...stats.values()].flat().sort((a, b) => a - b);
  console.log(`\n${'endpoint'.padEnd(34)} ${'n'.padStart(6)} ${'p50'.padStart(7)} ${'p95'.padStart(7)} ${'p99'.padStart(7)}`);
  for (const [path, v] of [...stats.entries()].sort()) {
    const s = [...v].sort((a, b) => a - b);
    console.log(`${path.padEnd(34)} ${String(s.length).padStart(6)} ${pct(s, 50).toFixed(0).padStart(6)}ms ${pct(s, 95).toFixed(0).padStart(6)}ms ${pct(s, 99).toFixed(0).padStart(6)}ms`);
  }
  const p95 = pct(all, 95);
  console.log(`\nTotal ${all.length} requests, ${(all.length / DURATION_S).toFixed(0)} req/s, ${errors} errors. p50 ${pct(all, 50).toFixed(0)}ms  p95 ${p95.toFixed(0)}ms  p99 ${pct(all, 99).toFixed(0)}ms (target p95 < ${P95_TARGET}ms)`);
  console.log(`Test data stays in company code "${slug}". Run this only against development or staging databases.`);
  if (errors > 0 || p95 >= P95_TARGET) { console.log('FAILED'); process.exitCode = 1; } else console.log('PASSED');
} finally {
  await adminDb.destroy();
}
