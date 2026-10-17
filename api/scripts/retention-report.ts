// Retention report: who is past their retention date or has none. Report only; nothing is deleted.
// Deletion of personal data is a deliberate, reviewed act (see docs/DATA_PROTECTION.md).
// Usage: npm run -w api retention:report -- --company demo
import { parseArgs } from 'node:util';
import { sql } from 'kysely';
import { createDb } from '../src/db.js';

const { values } = parseArgs({ options: { company: { type: 'string' } } });
if (!values.company) { console.error('Usage: retention:report -- --company <company code>'); process.exit(1); }
const adminUrl = process.env.DATABASE_URL_ADMIN;
if (!adminUrl) throw new Error('DATABASE_URL_ADMIN is not set');
const db = createDb(adminUrl, 1);

try {
  const t = await db.selectFrom('tenants').select(['id', 'name']).where('slug', '=', values.company).executeTakeFirst();
  if (!t) throw new Error(`No company with code "${values.company}"`);
  const r = (await sql<{ total: number; past_due: number; due_30: number; no_date: number; no_notice: number }>`
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE retention_until < current_date)::int AS past_due,
           count(*) FILTER (WHERE retention_until >= current_date AND retention_until < current_date + 30)::int AS due_30,
           count(*) FILTER (WHERE retention_until IS NULL)::int AS no_date,
           count(*) FILTER (WHERE privacy_notice_status IS NULL OR privacy_notice_status = 'unknown')::int AS no_notice
    FROM candidates WHERE tenant_id=${t.id} AND status='active'`.execute(db)).rows[0]!;
  console.log(`${t.name}: ${r.total} active candidates`);
  console.log(`  past retention date:        ${r.past_due}  (review for deletion or renewal)`);
  console.log(`  due within 30 days:         ${r.due_30}`);
  console.log(`  no retention date set:      ${r.no_date}`);
  console.log(`  privacy notice not recorded: ${r.no_notice}`);
} finally {
  await db.destroy();
}
