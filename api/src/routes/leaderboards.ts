// Performance: the HR Lead's two leaderboards (company recruiters and agencies), and each recruiter's
// and agency's own numbers. Ranking is by actual joins first; raw submissions and valid owned submissions
// are shown apart so duplicates and low-quality volume cannot inflate a position.
import type { FastifyInstance } from 'fastify';
import { sql, type RawBuilder } from 'kysely';
import { z } from 'zod';
import { principal } from '../app.js';
import { type Tx, withTenant } from '../db.js';
import { AppError, forbidden } from '../errors.js';
import { can, type Principal } from '../permissions.js';
import { termsEffectiveOn } from '../agency-terms.js';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.');
const Filters = z.object({
  from: isoDate.optional(), to: isoDate.optional(), department_id: z.uuid().optional(), vacancy_id: z.uuid().optional(),
  recruiter_id: z.uuid().optional(), agency_id: z.uuid().optional(), employment_status: z.enum(['active', 'exited']).optional(),
});
type F = z.infer<typeof Filters>;
const DAY = 86_400_000;

function range(f: F) {
  const to = f.to ? new Date(`${f.to}T00:00:00Z`) : new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()));
  const from = f.from ? new Date(`${f.from}T00:00:00Z`) : new Date(to.getTime() - 365 * DAY);
  return { from, toExclusive: new Date(to.getTime() + DAY), label: { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) } };
}

/** Counts per owner (a person or an agency). `kind` picks which owners and what counts as their own raw attempts. */
async function metrics(tx: Tx, kind: 'recruiter' | 'agency', f: F, only?: { userId?: string; agencyId?: string }) {
  const r = range(f);
  const conds: RawBuilder<unknown>[] = [sql`s.ownership_state = 'accepted'`, sql`s.submitted_at >= ${r.from}`, sql`s.submitted_at < ${r.toExclusive}`];
  const dupConds: RawBuilder<unknown>[] = [sql`d.attempted_at >= ${r.from}`, sql`d.attempted_at < ${r.toExclusive}`];
  if (kind === 'recruiter') { conds.push(sql`s.agency_id IS NULL`); dupConds.push(sql`d.attempted_agency_id IS NULL`); }
  else { conds.push(sql`s.agency_id IS NOT NULL`); dupConds.push(sql`d.attempted_agency_id IS NOT NULL`); }
  if (f.department_id) { conds.push(sql`rq.department_id = ${f.department_id}`); dupConds.push(sql`EXISTS (SELECT 1 FROM vacancies dv JOIN requisitions dr ON dr.id = dv.requisition_id WHERE dv.id = d.vacancy_id AND dr.department_id = ${f.department_id})`); }
  if (f.vacancy_id) { conds.push(sql`a.vacancy_id = ${f.vacancy_id}`); dupConds.push(sql`d.vacancy_id = ${f.vacancy_id}`); }
  if (f.recruiter_id) { conds.push(sql`s.source_user_id = ${f.recruiter_id}`); dupConds.push(sql`d.attempted_by = ${f.recruiter_id}`); }
  if (f.agency_id) { conds.push(sql`s.agency_id = ${f.agency_id}`); dupConds.push(sql`d.attempted_agency_id = ${f.agency_id}`); }
  if (only?.userId) { conds.push(sql`s.source_user_id = ${only.userId}`); dupConds.push(sql`d.attempted_by = ${only.userId}`); }
  if (only?.agencyId) { conds.push(sql`s.agency_id = ${only.agencyId}`); dupConds.push(sql`d.attempted_agency_id = ${only.agencyId}`); }
  const empStatus = f.employment_status ? sql`AND e.status = ${f.employment_status}` : sql``;
  const key = kind === 'recruiter' ? sql`s.source_user_id` : sql`s.agency_id`;
  const dupKey = kind === 'recruiter' ? sql`d.attempted_by` : sql`d.attempted_agency_id`;

  const valid = await sql<{ owner_id: string; valid: number; interviewed: number; selected: number; joined: number; active: number; exited: number; replacements_due: number; replaced: number; expired: number }>`
    SELECT ${key} AS owner_id,
      count(*)::int AS valid,
      count(*) FILTER (WHERE EXISTS (SELECT 1 FROM interviews i WHERE i.application_id = a.id AND i.status NOT IN ('cancelled', 'draft')))::int AS interviewed,
      count(*) FILTER (WHERE EXISTS (SELECT 1 FROM hiring_decisions h WHERE h.application_id = a.id AND h.decision = 'select') OR EXISTS (SELECT 1 FROM employment_records e WHERE e.application_id = a.id))::int AS selected,
      count(*) FILTER (WHERE EXISTS (SELECT 1 FROM employment_records e WHERE e.application_id = a.id ${empStatus}))::int AS joined,
      count(*) FILTER (WHERE EXISTS (SELECT 1 FROM employment_records e WHERE e.application_id = a.id AND e.status = 'active'))::int AS active,
      count(*) FILTER (WHERE EXISTS (SELECT 1 FROM employment_records e WHERE e.application_id = a.id AND e.status = 'exited'))::int AS exited,
      count(*) FILTER (WHERE EXISTS (SELECT 1 FROM employment_records e JOIN replacement_records rr ON rr.employment_id = e.id WHERE e.application_id = a.id AND rr.status = 'due'))::int AS replacements_due,
      count(*) FILTER (WHERE EXISTS (SELECT 1 FROM employment_records e JOIN replacement_records rr ON rr.employment_id = e.id WHERE e.application_id = a.id AND rr.status = 'replaced'))::int AS replaced,
      count(*) FILTER (WHERE EXISTS (SELECT 1 FROM employment_records e JOIN replacement_records rr ON rr.employment_id = e.id WHERE e.application_id = a.id AND rr.status = 'expired'))::int AS expired
    FROM submissions s
    JOIN applications a ON a.id = s.application_id
    JOIN vacancies v ON v.id = a.vacancy_id
    JOIN requisitions rq ON rq.id = v.requisition_id
    WHERE ${sql.join(conds, sql` AND `)}
    GROUP BY ${key}`.execute(tx);
  const dups = await sql<{ owner_id: string; n: number }>`
    SELECT ${dupKey} AS owner_id, count(*)::int AS n FROM duplicate_attempts d WHERE ${sql.join(dupConds, sql` AND `)} GROUP BY ${dupKey}`.execute(tx);

  const ids = new Set([...valid.rows.map((x) => x.owner_id), ...dups.rows.map((x) => x.owner_id)]);
  const names = kind === 'recruiter'
    ? await tx.selectFrom('users').select(['id', 'full_name as name']).where('id', 'in', [...ids].length ? [...ids] : ['00000000-0000-0000-0000-000000000000']).execute()
    : await tx.selectFrom('agencies').select(['id', 'name']).where('id', 'in', [...ids].length ? [...ids] : ['00000000-0000-0000-0000-000000000000']).execute();
  const rows = [...ids].filter((id) => id).map((id) => {
    const v = valid.rows.find((x) => x.owner_id === id);
    const dup = dups.rows.find((x) => x.owner_id === id)?.n ?? 0;
    const validN = v?.valid ?? 0;
    return {
      owner_id: id, name: names.find((x) => x.id === id)?.name ?? 'Unknown',
      raw_submissions: validN + dup, valid_submissions: validN, duplicate_attempts: dup,
      interviewed: v?.interviewed ?? 0, selected: v?.selected ?? 0, joined: v?.joined ?? 0, active: v?.active ?? 0, exited: v?.exited ?? 0,
      replacements_due: v?.replacements_due ?? 0, replaced: v?.replaced ?? 0, replacements_expired: v?.expired ?? 0,
      conversion_pct: validN ? Math.round(((v?.joined ?? 0) / validN) * 1000) / 10 : null,
    };
  });
  rows.sort((a, b) => b.joined - a.joined || b.selected - a.selected || b.interviewed - a.interviewed || b.valid_submissions - a.valid_submissions || a.name.localeCompare(b.name));
  return { rows: rows.map((x, i) => ({ rank: i + 1, ...x })), range: r.label };
}

const DEFINITIONS = {
  ranking: 'Ranked by actual joins, then selected candidates, interviewed candidates and valid submissions.',
  raw_submissions: 'Every submission attempt, including refused duplicates.',
  valid_submissions: 'Submissions that were accepted and owned (the first submission for that candidate and job).',
  interviewed: 'Owned candidates with at least one interview scheduled or held.',
  selected: 'Owned candidates who were selected or joined.',
  joined: 'Owned candidates marked joined by the HR Lead.',
  conversion_pct: 'Joined divided by valid submissions.',
};

export function canSeeLeaderboards(p: Principal) {
  return can(p, 'performance.view_all');
}

export async function leaderboardRoutes(app: FastifyInstance) {
  const { db } = app;

  app.get('/leaderboards/recruiters', async (req) => {
    const p = principal(req);
    if (!canSeeLeaderboards(p)) throw forbidden();
    const f = Filters.parse(req.query);
    return { data: await withTenant(db, p.tenantId, async (tx) => ({ ...(await metrics(tx, 'recruiter', f)), definitions: DEFINITIONS })) };
  });

  app.get('/leaderboards/agencies', async (req) => {
    const p = principal(req);
    if (!canSeeLeaderboards(p)) throw forbidden();
    const f = Filters.parse(req.query);
    return {
      data: await withTenant(db, p.tenantId, async (tx) => {
        const out = await metrics(tx, 'agency', f);
        const today = new Date().toISOString().slice(0, 10);
        const rows = [];
        for (const r of out.rows) {
          const t = await termsEffectiveOn(tx, r.owner_id, today);
          rows.push({ ...r, fee_model: t ? { payment_model: t.payment_model, fee_type: t.fee_type, fee_value: t.fee_value, lockin_days: t.lockin_days, replacement_days: t.replacement_days } : null });
        }
        return { ...out, rows, definitions: DEFINITIONS };
      }),
    };
  });

  // A company recruiter's own numbers.
  app.get('/me/performance', async (req) => {
    const p = principal(req);
    if (!can(p, 'performance.view_own')) throw forbidden();
    const f = Filters.pick({ from: true, to: true }).parse(req.query);
    return {
      data: await withTenant(db, p.tenantId, async (tx) => {
        if (await tx.selectFrom('agency_members').select('id').where('user_id', '=', p.userId).executeTakeFirst()) throw new AppError(403, 'FORBIDDEN', 'Agency users see their numbers from the agency pages.');
        const all = await metrics(tx, 'recruiter', f);
        const mine = (await metrics(tx, 'recruiter', f, { userId: p.userId })).rows[0] ?? null;
        return { range: all.range, me: mine && { ...mine, rank: all.rows.find((x) => x.owner_id === p.userId)?.rank ?? null }, recruiters_ranked: all.rows.length, definitions: DEFINITIONS };
      }),
    };
  });

  // An agency's own numbers: the agency admin sees the whole agency, a sub-recruiter sees their own.
  app.get('/agency/performance', async (req) => {
    const p = principal(req);
    if (!can(p, 'performance.view_own')) throw forbidden();
    const f = Filters.pick({ from: true, to: true }).parse(req.query);
    return {
      data: await withTenant(db, p.tenantId, async (tx) => {
        const m = await tx.selectFrom('agency_members').select(['agency_id', 'agency_role']).where('user_id', '=', p.userId).executeTakeFirst();
        if (!m) throw forbidden();
        const scope = m.agency_role === 'admin' ? { agencyId: m.agency_id } : { agencyId: m.agency_id, userId: p.userId };
        const own = (await metrics(tx, 'agency', f, scope)).rows[0] ?? null;
        const team = m.agency_role === 'admin'
          ? await Promise.all((await tx.selectFrom('agency_members').select('user_id').where('agency_id', '=', m.agency_id).execute()).map(async (x) => ({ user_id: x.user_id, ...((await metrics(tx, 'agency', f, { agencyId: m.agency_id, userId: x.user_id })).rows[0] ?? null) })))
          : [];
        const names = team.length ? await tx.selectFrom('users').select(['id', 'full_name']).where('id', 'in', team.map((t) => t.user_id)).execute() : [];
        return {
          range: range(f).label, scope: m.agency_role === 'admin' ? 'agency' : 'me', me: own,
          team: team.filter((t) => 'valid_submissions' in t).map((t) => ({ ...t, name: names.find((n) => n.id === t.user_id)?.full_name ?? '' })),
          definitions: DEFINITIONS,
        };
      }),
    };
  });

  // The HR Lead's one-page picture: jobs, pipeline, interviews, outcomes, rankings, agency models and replacements due.
  app.get('/hr/dashboard', async (req) => {
    const p = principal(req);
    if (!canSeeLeaderboards(p)) throw forbidden();
    const f = Filters.parse(req.query);
    return {
      data: await withTenant(db, p.tenantId, async (tx) => {
        const today = new Date().toISOString().slice(0, 10);
        const one = async <T,>(q: RawBuilder<T>) => (await q.execute(tx)).rows[0]!;
        const totals = await one(sql<{ open_jobs: number; on_hold_jobs: number; pipeline: number; interviews_scheduled: number; pending_feedback: number; joined: number; active_employees: number; exits: number }>`
          SELECT
            (SELECT count(*)::int FROM vacancies WHERE status = 'open') AS open_jobs,
            (SELECT count(*)::int FROM vacancies WHERE status = 'on_hold') AS on_hold_jobs,
            (SELECT count(*)::int FROM applications a JOIN vacancies v ON v.id = a.vacancy_id WHERE a.status = 'active' AND v.status IN ('open', 'on_hold')) AS pipeline,
            (SELECT count(*)::int FROM interviews WHERE status IN ('scheduled', 'confirmed') AND scheduled_start >= now()) AS interviews_scheduled,
            (SELECT count(*)::int FROM interviewers m JOIN interviews i ON i.id = m.interview_id WHERE m.feedback_status = 'pending' AND i.status NOT IN ('cancelled', 'no_show', 'draft') AND i.scheduled_end < now()) AS pending_feedback,
            (SELECT count(*)::int FROM employment_records) AS joined,
            (SELECT count(*)::int FROM employment_records WHERE status = 'active') AS active_employees,
            (SELECT count(*)::int FROM employment_records WHERE status = 'exited') AS exits`);
        const jobs = await sql<{ id: string; title: string; vacancy_code: string; department: string; department_id: string; status: string; target: number; joined: number; pipeline: number; interviews: number }>`
          SELECT v.id, v.title, v.vacancy_code, d.name AS department, rq.department_id, v.status::text AS status, v.headcount AS target,
            (SELECT count(*)::int FROM employment_records e WHERE e.vacancy_id = v.id) AS joined,
            (SELECT count(*)::int FROM applications a WHERE a.vacancy_id = v.id AND a.status = 'active') AS pipeline,
            (SELECT count(*)::int FROM interviews i JOIN applications a ON a.id = i.application_id WHERE a.vacancy_id = v.id AND i.status NOT IN ('cancelled', 'draft')) AS interviews
          FROM vacancies v JOIN requisitions rq ON rq.id = v.requisition_id JOIN departments d ON d.id = rq.department_id
          WHERE v.status IN ('open', 'on_hold') ${f.department_id ? sql`AND rq.department_id = ${f.department_id}` : sql``}
          ORDER BY v.opened_at DESC LIMIT 100`.execute(tx);
        const byDept = new Map<string, { department: string; jobs: number; target: number; joined: number; pipeline: number }>();
        for (const j of jobs.rows) {
          const d = byDept.get(j.department_id) ?? { department: j.department, jobs: 0, target: 0, joined: 0, pipeline: 0 };
          d.jobs += 1; d.target += j.target; d.joined += j.joined; d.pipeline += j.pipeline;
          byDept.set(j.department_id, d);
        }
        const recruiters = await metrics(tx, 'recruiter', f);
        const agencies = await metrics(tx, 'agency', f);
        const agencyModels = [];
        for (const a of await tx.selectFrom('agencies').select(['id', 'name', 'status']).orderBy('name').execute()) {
          const t = await termsEffectiveOn(tx, a.id, today);
          agencyModels.push({ agency_id: a.id, name: a.name, status: a.status, terms: t && { payment_model: t.payment_model, fee_type: t.fee_type, fee_value: t.fee_value, lockin_days: t.lockin_days, replacement_days: t.replacement_days } });
        }
        await tx.updateTable('replacement_records').set({ status: 'expired', updated_at: sql`now()` }).where('status', '=', 'due').where('due_by', '<', today).execute();
        const replacementDue = await sql<{ id: string; candidate_name: string; agency_name: string; job_title: string; due_by: string; exit_date: string }>`
          SELECT r.id, c.full_name AS candidate_name, ag.name AS agency_name, v.title AS job_title, r.due_by::text AS due_by, e.exit_date::text AS exit_date
          FROM replacement_records r JOIN employment_records e ON e.id = r.employment_id JOIN candidates c ON c.id = e.candidate_id
          JOIN agencies ag ON ag.id = r.agency_id JOIN vacancies v ON v.id = r.vacancy_id WHERE r.status = 'due' ORDER BY r.due_by LIMIT 20`.execute(tx);
        return {
          range: recruiters.range, totals, jobs: jobs.rows, by_department: [...byDept.values()],
          recruiters: recruiters.rows.slice(0, 5), agencies: agencies.rows.slice(0, 5), agency_models: agencyModels, replacements_due: replacementDue.rows,
        };
      }),
    };
  });
}
