// Pilot baseline: the numbers to record before and after a pilot, per company, straight from the database.
// Usage: npm run -w api pilot:baseline -- --company demo
import { parseArgs } from 'node:util';
import { sql } from 'kysely';
import { createDb } from '../src/db.js';

const { values } = parseArgs({ options: { company: { type: 'string' } } });
if (!values.company) { console.error('Usage: pilot:baseline -- --company <company code>'); process.exit(1); }
const adminUrl = process.env.DATABASE_URL_ADMIN;
if (!adminUrl) throw new Error('DATABASE_URL_ADMIN is not set');
const db = createDb(adminUrl, 1);

try {
  const t = await db.selectFrom('tenants').select(['id', 'name']).where('slug', '=', values.company).executeTakeFirst();
  if (!t) throw new Error(`No company with code "${values.company}"`);
  const q = async <R>(query: ReturnType<typeof sql<R>>) => (await query.execute(db)).rows[0] as R;
  const id = t.id;
  const people = await q(sql<{ users: number; agencies: number }>`SELECT (SELECT count(*)::int FROM users WHERE tenant_id=${id} AND status='active') AS users, (SELECT count(*)::int FROM agencies WHERE tenant_id=${id}) AS agencies`);
  const pipeline = await q(sql<{ candidates: number; open_vacancies: number; applications: number; hired: number; interviews: number }>`
    SELECT (SELECT count(*)::int FROM candidates WHERE tenant_id=${id} AND status='active') AS candidates,
           (SELECT count(*)::int FROM vacancies WHERE tenant_id=${id} AND status='open') AS open_vacancies,
           (SELECT count(*)::int FROM applications WHERE tenant_id=${id}) AS applications,
           (SELECT count(*)::int FROM applications WHERE tenant_id=${id} AND status='hired') AS hired,
           (SELECT count(*)::int FROM interviews WHERE tenant_id=${id} AND status NOT IN ('cancelled','draft')) AS interviews`);
  const tth = await q(sql<{ avg_days: number | null; median_days: number | null }>`
    SELECT round(avg(extract(epoch from (stage_changed_at - created_at))/86400)::numeric,1)::float AS avg_days,
           round((percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch from (stage_changed_at - created_at))/86400))::numeric,1)::float AS median_days
    FROM applications WHERE tenant_id=${id} AND status='hired'`);
  const fb = await q(sql<{ received: number; on_time_pct: number | null; avg_hours: number | null }>`
    SELECT count(*)::int AS received,
           round(100.0 * count(*) FILTER (WHERE f.submitted_at <= i.feedback_due_at) / NULLIF(count(*),0), 1)::float AS on_time_pct,
           round(avg(extract(epoch from (f.submitted_at - i.scheduled_end))/3600)::numeric,1)::float AS avg_hours
    FROM feedback f JOIN interviewers m ON m.id=f.interviewer_id JOIN interviews i ON i.id=m.interview_id WHERE f.tenant_id=${id}`);
  const dup = await q(sql<{ n: number }>`SELECT count(*)::int AS n FROM duplicate_attempts WHERE tenant_id=${id}`);
  console.log(JSON.stringify({ company: t.name, code: values.company, taken_at: new Date().toISOString(), ...people, ...pipeline, time_to_hire_days: tth, interviewer_feedback: fb, rejected_duplicate_submissions: dup.n }, null, 2));
} finally {
  await db.destroy();
}
