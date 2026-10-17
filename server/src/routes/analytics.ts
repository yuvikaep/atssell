// Reports and the dashboard. Every number is computed from the rows the caller may already see
// (vacancyVisible), so a hiring manager's funnel covers their department and a company-wide role's
// covers everything. Each response carries the metric's definition and the date range it covers, so a
// number is never shown without saying what it means.
import type { FastifyInstance } from 'fastify';
import { sql, type ExpressionBuilder, type Expression, type SqlBool } from 'kysely';
import { z } from 'zod';
import { hasAny, vacancyVisible } from '../access.js';
import { principal } from '../app.js';
import { withTenant, type Tx } from '../db.js';
import { forbidden } from '../errors.js';
import type { Principal } from '../permissions.js';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.');

export const AnalyticsQuery = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
  department_id: z.uuid().optional(),
  location: z.string().trim().max(200).optional(),
  recruiter_id: z.uuid().optional(),
  agency_id: z.uuid().optional(),
});
export type AnalyticsFilters = z.infer<typeof AnalyticsQuery>;

const DAY_MS = 86_400_000;

/** The date range a report covers: defaults to the last 90 days. `to` is inclusive. */
export function resolveRange(f: Pick<AnalyticsFilters, 'from' | 'to'>, now = new Date()) {
  const to = f.to ? new Date(`${f.to}T00:00:00Z`) : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const from = f.from ? new Date(`${f.from}T00:00:00Z`) : new Date(to.getTime() - 90 * DAY_MS);
  const toExclusive = new Date(to.getTime() + DAY_MS);
  return { from, toExclusive, label: { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) } };
}

/** Vacancy-level filters shared by every report. `v` and `rq` are the vacancy and requisition aliases. */
function vacancyFilters(f: AnalyticsFilters) {
  return (eb: ExpressionBuilder<any, any>): Expression<SqlBool> => {
    const parts: Expression<SqlBool>[] = [];
    if (f.department_id) parts.push(eb('rq.department_id', '=', f.department_id));
    if (f.location) parts.push(eb('v.location', 'ilike', `%${f.location.replace(/[\\%_]/g, (c) => `\\${c}`)}%`));
    if (f.recruiter_id) {
      parts.push(eb.exists(eb.selectFrom('vacancy_recruiters as fr').select('fr.id').whereRef('fr.vacancy_id', '=', 'v.id').where('fr.recruiter_user_id', '=', f.recruiter_id).where('fr.unassigned_at', 'is', null)));
    }
    if (f.agency_id) {
      parts.push(eb.exists(eb.selectFrom('vacancy_agencies as fa').select('fa.id').whereRef('fa.vacancy_id', '=', 'v.id').where('fa.agency_id', '=', f.agency_id).where('fa.status', '=', 'active')));
    }
    return parts.length ? eb.and(parts) : sql<SqlBool>`true`;
  };
}

function requireAnalytics(p: Principal) {
  if (!hasAny(p, 'analytics.view')) throw forbidden();
}

/** Applications in range that the caller may see, with vacancy filters applied. */
function scopedApplications(tx: Tx, p: Principal, f: AnalyticsFilters, range: ReturnType<typeof resolveRange>) {
  return tx
    .selectFrom('applications as a')
    .innerJoin('vacancies as v', 'v.id', 'a.vacancy_id')
    .innerJoin('requisitions as rq', 'rq.id', 'v.requisition_id')
    .where(vacancyVisible(p, null))
    .where(vacancyFilters(f))
    .where('a.created_at', '>=', range.from)
    .where('a.created_at', '<', range.toExclusive);
}

const pct = (n: number, d: number) => (d === 0 ? null : Math.round((n / d) * 1000) / 10);
const round1 = (n: number | null) => (n === null ? null : Math.round(n * 10) / 10);

// ---------------------------------------------------------------------------
// Report functions. Each takes a transaction already scoped to the tenant, so the same code serves
// the API, the dashboard and the CSV exports.
// ---------------------------------------------------------------------------

export async function hiringFunnel(tx: Tx, p: Principal, f: AnalyticsFilters) {
  const range = resolveRange(f);
  const stages = await tx.selectFrom('pipeline_stages').select(['id', 'code', 'name', 'sort_order', 'terminal_status']).where('status', '=', 'active').orderBy('sort_order').execute();
  const apps = scopedApplications(tx, p, f, range);
  const total = (await apps.select(sql<number>`count(*)::int`.as('n')).executeTakeFirstOrThrow()).n;
  // "Reached" counts each application once per stage it ever entered, from its stage history.
  const reached = await apps
    .innerJoin('application_stage_events as e', 'e.application_id', 'a.id')
    .select(['e.to_stage_id as stage_id', sql<number>`count(distinct a.id)::int`.as('n')])
    .groupBy('e.to_stage_id')
    .execute();
  const current = await apps.select(['a.stage_id', sql<number>`count(*)::int`.as('n')]).groupBy('a.stage_id').execute();
  const reachedBy = new Map(reached.map((r) => [r.stage_id, r.n]));
  const currentBy = new Map(current.map((r) => [r.stage_id, r.n]));
  const open = stages.filter((s) => s.terminal_status === null);
  return {
    range: range.label,
    definition: 'Applications created in the range. "Reached" counts each application once for every stage it ever entered; "Now" counts where it sits today. Conversion is reached divided by applications created.',
    total_applications: total,
    stages: stages.map((s) => ({
      stage_id: s.id, code: s.code, name: s.name, terminal: s.terminal_status !== null,
      reached: reachedBy.get(s.id) ?? 0, now: currentBy.get(s.id) ?? 0, conversion_pct: pct(reachedBy.get(s.id) ?? 0, total),
    })),
    hired: reachedBy.get(stages.find((s) => s.code === 'hired')?.id ?? '') ?? 0,
    open_stage_count: open.length,
  };
}

export async function vacancyAgeing(tx: Tx, p: Principal, f: AnalyticsFilters, now = new Date()) {
  const rows = await tx
    .selectFrom('vacancies as v')
    .innerJoin('requisitions as rq', 'rq.id', 'v.requisition_id')
    .innerJoin('departments as d', 'd.id', 'rq.department_id')
    .select(['v.id', 'v.vacancy_code', 'v.title', 'v.opened_at', 'v.status', 'd.name as department_name', 'rq.priority'])
    .where('v.status', 'in', ['open', 'on_hold'])
    .where(vacancyVisible(p, null))
    .where(vacancyFilters(f))
    .orderBy('v.opened_at')
    .execute();
  const aged = rows.map((r) => ({ ...r, age_days: Math.floor((now.getTime() - r.opened_at.getTime()) / DAY_MS) }));
  const bucket = (lo: number, hi: number) => aged.filter((r) => r.age_days >= lo && r.age_days <= hi).length;
  return {
    definition: 'Open and on-hold vacancies by days since they were opened. Closed and cancelled vacancies are not counted.',
    total_open: aged.length,
    average_age_days: round1(aged.length ? aged.reduce((n, r) => n + r.age_days, 0) / aged.length : null),
    buckets: [
      { label: '0–30 days', count: bucket(0, 30) }, { label: '31–60 days', count: bucket(31, 60) },
      { label: '61–90 days', count: bucket(61, 90) }, { label: 'Over 90 days', count: bucket(91, Infinity) },
    ],
    oldest: aged.slice(0, 10).map((r) => ({ id: r.id, code: r.vacancy_code, title: r.title, department: r.department_name, status: r.status, age_days: r.age_days })),
  };
}

export async function feedbackSla(tx: Tx, p: Principal, f: AnalyticsFilters, now = new Date()) {
  const range = resolveRange(f, now);
  const base = tx
    .selectFrom('interviewers as m')
    .innerJoin('interviews as i', 'i.id', 'm.interview_id')
    .innerJoin('applications as a', 'a.id', 'i.application_id')
    .innerJoin('vacancies as v', 'v.id', 'a.vacancy_id')
    .innerJoin('requisitions as rq', 'rq.id', 'v.requisition_id')
    .where(vacancyVisible(p, null))
    .where(vacancyFilters(f))
    .where('i.status', 'not in', ['cancelled', 'no_show', 'draft'])
    .where('i.scheduled_end', '<', sql<Date>`now()`)
    .where('i.scheduled_end', '>=', range.from)
    .where('i.scheduled_end', '<', range.toExclusive)
    .where('m.feedback_status', '<>', 'waived');
  const submitted = await base
    .innerJoin('feedback as fb', 'fb.interviewer_id', 'm.id')
    .select([
      sql<number>`count(*)::int`.as('n'),
      sql<number>`count(*) filter (where fb.submitted_at <= i.feedback_due_at)::int`.as('on_time'),
      sql<number | null>`avg(extract(epoch from (fb.submitted_at - i.scheduled_end)) / 3600)`.as('avg_hours'),
    ])
    .executeTakeFirstOrThrow();
  const pending = await base
    .where('m.feedback_status', '=', 'pending')
    .select(['m.id', 'i.id as interview_id', 'i.round_name', 'i.feedback_due_at', 'm.external_name', 'm.user_id'])
    .select((eb) => [eb.selectFrom('candidates as c').select('c.full_name').whereRef('c.id', '=', 'a.candidate_id').as('candidate_name'), eb.selectFrom('users as u').select('u.full_name').whereRef('u.id', '=', 'm.user_id').as('user_name')])
    .execute();
  const overdue = pending.filter((r) => r.feedback_due_at !== null && r.feedback_due_at < now);
  return {
    range: range.label,
    definition: 'Interviews that ended in the range, excluding cancelled, no-show and waived feedback. "On time" means feedback arrived by the due time set when the interview was booked. Hours are measured from the end of the interview.',
    received: submitted.n,
    on_time_pct: pct(submitted.on_time, submitted.n),
    average_hours_to_feedback: round1(submitted.avg_hours === null ? null : Number(submitted.avg_hours)),
    pending: pending.length,
    overdue: overdue.length,
    overdue_list: overdue
      .sort((a, b) => a.feedback_due_at!.getTime() - b.feedback_due_at!.getTime())
      .slice(0, 15)
      .map((r) => ({ interview_id: r.interview_id, round_name: r.round_name, candidate: r.candidate_name, interviewer: r.user_name ?? r.external_name, due_at: r.feedback_due_at, hours_overdue: Math.round(((now.getTime() - r.feedback_due_at!.getTime()) / 3_600_000) * 10) / 10 })),
  };
}

export async function recruiterActivity(tx: Tx, p: Principal, f: AnalyticsFilters) {
  const range = resolveRange(f);
  const people = await tx
    .selectFrom('users as u')
    .leftJoin('agency_members as am', 'am.user_id', 'u.id')
    .select(['u.id', 'u.full_name'])
    .where('am.id', 'is', null)
    .where('u.status', '=', 'active')
    .execute();
  const added = await tx
    .selectFrom('submissions as s')
    .innerJoin('applications as a', 'a.id', 's.application_id')
    .innerJoin('vacancies as v', 'v.id', 'a.vacancy_id')
    .innerJoin('requisitions as rq', 'rq.id', 'v.requisition_id')
    .select(['s.source_user_id as user_id', sql<number>`count(*)::int`.as('n')])
    .where('s.agency_id', 'is', null).where('s.source_user_id', 'is not', null)
    .where('s.submitted_at', '>=', range.from).where('s.submitted_at', '<', range.toExclusive)
    .where(vacancyVisible(p, null)).where(vacancyFilters(f))
    .groupBy('s.source_user_id').execute();
  const moves = await tx
    .selectFrom('application_stage_events as e')
    .innerJoin('applications as a', 'a.id', 'e.application_id')
    .innerJoin('vacancies as v', 'v.id', 'a.vacancy_id')
    .innerJoin('requisitions as rq', 'rq.id', 'v.requisition_id')
    .select(['e.actor_user_id as user_id', sql<number>`count(*)::int`.as('n')])
    .where('e.from_stage_id', 'is not', null).where('e.actor_user_id', 'is not', null)
    .where('e.created_at', '>=', range.from).where('e.created_at', '<', range.toExclusive)
    .where(vacancyVisible(p, null)).where(vacancyFilters(f))
    .groupBy('e.actor_user_id').execute();
  const interviews = await tx
    .selectFrom('interviews as i')
    .innerJoin('applications as a', 'a.id', 'i.application_id')
    .innerJoin('vacancies as v', 'v.id', 'a.vacancy_id')
    .innerJoin('requisitions as rq', 'rq.id', 'v.requisition_id')
    .select(['i.created_by as user_id', sql<number>`count(*)::int`.as('n')])
    .where('i.created_at', '>=', range.from).where('i.created_at', '<', range.toExclusive)
    .where(vacancyVisible(p, null)).where(vacancyFilters(f))
    .groupBy('i.created_by').execute();
  const get = (rows: { user_id: string | null; n: number }[], id: string) => rows.find((r) => r.user_id === id)?.n ?? 0;
  const out = people
    .map((u) => ({ user_id: u.id, name: u.full_name, candidates_added: get(added, u.id), stage_moves: get(moves, u.id), interviews_scheduled: get(interviews, u.id) }))
    .filter((r) => r.candidates_added + r.stage_moves + r.interviews_scheduled > 0)
    .sort((a, b) => b.stage_moves + b.candidates_added - (a.stage_moves + a.candidates_added));
  return {
    range: range.label,
    definition: 'Per colleague, in the range: candidates they added as a source, pipeline stage moves they made, and interviews they scheduled. Only vacancies you can see are counted.',
    recruiters: out,
  };
}

export async function agencyPerformance(tx: Tx, p: Principal, f: AnalyticsFilters) {
  const range = resolveRange(f);
  const agencies = await tx.selectFrom('agencies').select(['id', 'name', 'status']).orderBy('name').execute();
  const subs = await tx
    .selectFrom('submissions as s')
    .innerJoin('applications as a', 'a.id', 's.application_id')
    .innerJoin('vacancies as v', 'v.id', 'a.vacancy_id')
    .innerJoin('requisitions as rq', 'rq.id', 'v.requisition_id')
    .select([
      's.agency_id',
      sql<number>`count(*)::int`.as('submitted'),
      sql<number>`count(*) filter (where exists (select 1 from interviews i where i.application_id = a.id and i.status not in ('cancelled','draft')))::int`.as('interviewed'),
      sql<number>`count(*) filter (where exists (select 1 from application_stage_events e join pipeline_stages st on st.id = e.to_stage_id where e.application_id = a.id and st.code = 'shortlisted'))::int`.as('shortlisted'),
      sql<number>`count(*) filter (where a.status = 'hired')::int`.as('hired'),
    ])
    .where('s.agency_id', 'is not', null)
    .where('s.submitted_at', '>=', range.from).where('s.submitted_at', '<', range.toExclusive)
    .where(vacancyVisible(p, null)).where(vacancyFilters(f))
    .groupBy('s.agency_id').execute();
  const dups = await tx
    .selectFrom('duplicate_attempts')
    .select(['attempted_agency_id as entity_id', sql<number>`count(*)::int`.as('n')])
    .where('attempted_agency_id', 'is not', null)
    .where('attempted_at', '>=', range.from).where('attempted_at', '<', range.toExclusive)
    .groupBy('attempted_agency_id').execute();
  return {
    range: range.label,
    definition: 'Per agency, for candidates submitted in the range. Shortlisted and interviewed count candidates that ever reached those points; hired counts candidates now hired. Submission-to-hire is hired divided by submitted. Rejected duplicates are attempts to submit a candidate who was already in the database.',
    agencies: agencies
      .map((a) => {
        const s = subs.find((x) => x.agency_id === a.id);
        const submitted = s?.submitted ?? 0;
        return {
          agency_id: a.id, name: a.name, status: a.status, submitted, shortlisted: s?.shortlisted ?? 0, interviewed: s?.interviewed ?? 0, hired: s?.hired ?? 0,
          submission_to_hire_pct: pct(s?.hired ?? 0, submitted), rejected_duplicates: dups.find((d) => d.entity_id === a.id)?.n ?? 0,
        };
      })
      .filter((a) => a.submitted > 0 || a.rejected_duplicates > 0),
  };
}

export async function timeToHire(tx: Tx, p: Principal, f: AnalyticsFilters) {
  const range = resolveRange(f);
  const rows = await tx
    .selectFrom('applications as a')
    .innerJoin('vacancies as v', 'v.id', 'a.vacancy_id')
    .innerJoin('requisitions as rq', 'rq.id', 'v.requisition_id')
    .innerJoin('departments as d', 'd.id', 'rq.department_id')
    .select(['d.name as department', sql<number>`extract(epoch from (a.stage_changed_at - a.created_at)) / 86400`.as('days')])
    .where('a.status', '=', 'hired')
    .where('a.stage_changed_at', '>=', range.from).where('a.stage_changed_at', '<', range.toExclusive)
    .where(vacancyVisible(p, null)).where(vacancyFilters(f))
    .execute();
  const days = rows.map((r) => Number(r.days)).sort((a, b) => a - b);
  const median = days.length ? (days.length % 2 ? days[(days.length - 1) / 2]! : (days[days.length / 2 - 1]! + days[days.length / 2]!) / 2) : null;
  const byDept = new Map<string, number[]>();
  for (const r of rows) byDept.set(r.department, [...(byDept.get(r.department) ?? []), Number(r.days)]);
  return {
    range: range.label,
    definition: 'Days from the application being created to the candidate being marked hired, for candidates hired in the range. Median is shown alongside the average because a few long searches can pull an average up.',
    hires: rows.length,
    average_days: round1(days.length ? days.reduce((a, b) => a + b, 0) / days.length : null),
    median_days: round1(median),
    by_department: [...byDept.entries()].map(([department, d]) => ({ department, hires: d.length, average_days: round1(d.reduce((a, b) => a + b, 0) / d.length) })).sort((a, b) => b.hires - a.hires),
  };
}

export async function offersReport(tx: Tx, p: Principal, f: AnalyticsFilters) {
  const range = resolveRange(f);
  const base = () =>
    tx
      .selectFrom('offers as o')
      .innerJoin('applications as a', 'a.id', 'o.application_id')
      .innerJoin('vacancies as v', 'v.id', 'a.vacancy_id')
      .innerJoin('requisitions as rq', 'rq.id', 'v.requisition_id')
      .where(vacancyVisible(p, null))
      .where(vacancyFilters(f))
      .where('o.created_at', '>=', range.from)
      .where('o.created_at', '<', range.toExclusive);
  const counts = await base().select(['o.status', sql<number>`count(*)::int`.as('n')]).groupBy('o.status').execute();
  const n = (s: string) => counts.find((c) => c.status === s)?.n ?? 0;
  const timing = await base()
    .where('o.responded_at', 'is not', null)
    .where('o.released_at', 'is not', null)
    .select(sql<number | null>`avg(extract(epoch from (o.responded_at - o.released_at)) / 86400)`.as('days'))
    .executeTakeFirstOrThrow();
  const joins = await base()
    .innerJoin('joining_records as j', 'j.offer_id', 'o.id')
    .select(['j.status', sql<number>`count(*)::int`.as('n')])
    .groupBy('j.status')
    .execute();
  const j = (s: string) => joins.find((x) => x.status === s)?.n ?? 0;
  const answered = n('accepted') + n('declined');
  const accepted = n('accepted');
  return {
    range: range.label,
    definition: 'Offers created in the range. Acceptance rate is accepted divided by accepted plus declined (offers still awaiting an answer are not counted). Joining outcomes are for offers that were accepted: joined, still expected or delayed, or backed out. Pay amounts are not included in reports.',
    created: counts.reduce((t, c) => t + c.n, 0),
    by_status: ['draft', 'pending_approval', 'approved', 'released', 'accepted', 'declined', 'withdrawn'].map((status) => ({ status, count: n(status) })),
    acceptance_rate_pct: pct(n('accepted'), answered),
    average_days_to_response: round1(timing.days === null ? null : Number(timing.days)),
    joined: j('joined'),
    awaiting_joining: j('expected') + j('delayed'),
    backed_out: j('backed_out'),
    backed_out_pct: pct(j('backed_out'), accepted),
  };
}

/** The company dashboard: one call, every widget, scoped to what the caller can see. */
export async function dashboard(tx: Tx, p: Principal, f: AnalyticsFilters, now = new Date()) {
  const visibleVacancies = () => tx.selectFrom('vacancies as v').innerJoin('requisitions as rq', 'rq.id', 'v.requisition_id').where(vacancyVisible(p, null)).where(vacancyFilters(f));
  const open = await visibleVacancies().select(sql<number>`count(*)::int`.as('n')).where('v.status', '=', 'open').executeTakeFirstOrThrow();
  const byStage = await tx
    .selectFrom('applications as a')
    .innerJoin('vacancies as v', 'v.id', 'a.vacancy_id')
    .innerJoin('requisitions as rq', 'rq.id', 'v.requisition_id')
    .innerJoin('pipeline_stages as st', 'st.id', 'a.stage_id')
    .select(['st.name', 'st.sort_order', sql<number>`count(*)::int`.as('n')])
    .where('a.status', '=', 'active').where(vacancyVisible(p, null)).where(vacancyFilters(f))
    .groupBy(['st.name', 'st.sort_order']).orderBy('st.sort_order').execute();

  const canSeeInterviews = hasAny(p, 'interviews.manage') || hasAny(p, 'feedback.view') || hasAny(p, 'decisions.record');
  const upcoming = canSeeInterviews
    ? await tx
        .selectFrom('interviews as i')
        .innerJoin('applications as a', 'a.id', 'i.application_id')
        .innerJoin('vacancies as v', 'v.id', 'a.vacancy_id')
        .innerJoin('requisitions as rq', 'rq.id', 'v.requisition_id')
        .innerJoin('candidates as c', 'c.id', 'a.candidate_id')
        .select(['i.id', 'i.round_name', 'i.scheduled_start', 'i.timezone', 'c.full_name as candidate_name', 'v.title as vacancy_title'])
        .where('i.status', 'in', ['scheduled', 'confirmed'])
        .where('i.scheduled_start', '>=', now).where('i.scheduled_start', '<', new Date(now.getTime() + 7 * DAY_MS))
        .where(vacancyVisible(p, null)).where(vacancyFilters(f))
        .orderBy('i.scheduled_start').limit(8).execute()
    : [];
  const sla = canSeeInterviews ? await feedbackSla(tx, p, { ...f, from: undefined, to: undefined }, now) : null;
  const ageing = await vacancyAgeing(tx, p, f, now);
  const canOffers = hasAny(p, 'offers.manage') || hasAny(p, 'offers.approve');
  let offers: { waiting_on_me: number; open: number; upcoming_joiners: { id: string; candidate_name: string; vacancy_title: string; joining_date: string; status: string }[] } | null = null;
  if (canOffers) {
    const mine = await tx.selectFrom('offer_approvals as oa').innerJoin('offers as o', 'o.id', 'oa.offer_id').select(sql<number>`count(*)::int`.as('n'))
      .where('oa.approver_user_id', '=', p.userId).where('oa.decision', '=', 'pending').where('o.status', '=', 'pending_approval').whereRef('oa.round', '=', 'o.approval_round')
      .where((eb) => eb.not(eb.exists(eb.selectFrom('offer_approvals as earlier').select('earlier.id').whereRef('earlier.offer_id', '=', 'oa.offer_id').whereRef('earlier.round', '=', 'oa.round').where('earlier.decision', '=', 'pending').whereRef('earlier.step_order', '<', 'oa.step_order'))))
      .executeTakeFirstOrThrow();
    const open = await tx.selectFrom('offers as o').innerJoin('applications as a', 'a.id', 'o.application_id').innerJoin('vacancies as v', 'v.id', 'a.vacancy_id').innerJoin('requisitions as rq', 'rq.id', 'v.requisition_id')
      .select(sql<number>`count(*)::int`.as('n')).where('o.status', 'in', ['draft', 'pending_approval', 'approved', 'released']).where(vacancyVisible(p, null)).where(vacancyFilters(f)).executeTakeFirstOrThrow();
    const joiners = await tx.selectFrom('joining_records as j').innerJoin('applications as a', 'a.id', 'j.application_id').innerJoin('vacancies as v', 'v.id', 'a.vacancy_id').innerJoin('requisitions as rq', 'rq.id', 'v.requisition_id').innerJoin('candidates as c', 'c.id', 'a.candidate_id')
      .select(['j.id', 'c.full_name as candidate_name', 'v.title as vacancy_title', 'j.joining_date', 'j.status'])
      .where('j.status', 'in', ['expected', 'delayed']).where('j.joining_date', 'is not', null)
      .where('j.joining_date', '<=', new Date(now.getTime() + 14 * DAY_MS).toISOString().slice(0, 10))
      .where(vacancyVisible(p, null)).where(vacancyFilters(f)).orderBy('j.joining_date').limit(8).execute();
    offers = { waiting_on_me: mine.n, open: open.n, upcoming_joiners: joiners.map((x) => ({ ...x, joining_date: x.joining_date! })) };
  }
  return {
    open_vacancies: open.n,
    candidates_by_stage: byStage.map((s) => ({ stage: s.name, count: s.n })),
    active_candidates: byStage.reduce((n, s) => n + s.n, 0),
    upcoming_interviews: upcoming,
    feedback: sla ? { pending: sla.pending, overdue: sla.overdue } : null,
    vacancy_ageing: { average_age_days: ageing.average_age_days, buckets: ageing.buckets },
    offers,
    generated_at: now,
  };
}

export async function analyticsRoutes(app: FastifyInstance) {
  const { db } = app;

  const report = <T>(path: string, fn: (tx: Tx, p: Principal, f: AnalyticsFilters) => Promise<T>, extra?: (p: Principal) => void) =>
    app.get(path, async (req) => {
      const p = principal(req);
      requireAnalytics(p);
      extra?.(p);
      const f = AnalyticsQuery.parse(req.query);
      return { data: await withTenant(db, p.tenantId, (tx) => fn(tx, p, f)) };
    });

  report('/analytics/hiring-funnel', hiringFunnel);
  report('/analytics/vacancy-ageing', (tx, p, f) => vacancyAgeing(tx, p, f));
  report('/analytics/feedback-sla', (tx, p, f) => feedbackSla(tx, p, f));
  report('/analytics/recruiter-activity', recruiterActivity);
  report('/analytics/time-to-hire', timeToHire);
  report('/analytics/offers', offersReport);
  // Agency figures name agencies and their results, so they need agency management as well.
  report('/analytics/agency-performance', agencyPerformance, (p) => {
    if (!hasAny(p, 'agencies.manage')) throw forbidden();
  });

  // The dashboard is open to anyone who can see any vacancies, not only report readers.
  app.get('/analytics/dashboard', async (req) => {
    const p = principal(req);
    if (!['analytics.view', 'vacancies.view_all', 'vacancies.view_assigned', 'offers.approve'].some((perm) => hasAny(p, perm))) throw forbidden();
    const f = AnalyticsQuery.parse(req.query);
    return { data: await withTenant(db, p.tenantId, (tx) => dashboard(tx, p, f)) };
  });
}
