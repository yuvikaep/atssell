// The hiring manager's home: one call that answers "what needs me today?" in plain terms, using only
// the vacancies the person can see. Decisions use the same rules as the rest of the app.
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { hasAny, vacancyVisible } from '../access.js';
import { principal } from '../app.js';
import { withTenant } from '../db.js';
import { forbidden } from '../errors.js';
import { can } from '../permissions.js';

const DAY = 86_400_000;

export async function hiringHomeRoutes(app: FastifyInstance) {
  const { db } = app;

  app.get('/hiring-home', async (req) => {
    const p = principal(req);
    if (!hasAny(p, 'vacancies.view_all') && !hasAny(p, 'vacancies.view_assigned')) throw forbidden();
    const now = new Date();
    return {
      data: await withTenant(db, p.tenantId, async (tx) => {
        const visibleApps = () =>
          tx.selectFrom('applications as a')
            .innerJoin('vacancies as v', 'v.id', 'a.vacancy_id')
            .innerJoin('requisitions as rq', 'rq.id', 'v.requisition_id')
            .innerJoin('candidates as c', 'c.id', 'a.candidate_id')
            .where(vacancyVisible(p, null));

        // 1. Feedback I owe: interviews I was on the panel for that have ended.
        const feedbackOwed = await tx
          .selectFrom('interviewers as m')
          .innerJoin('interviews as i', 'i.id', 'm.interview_id')
          .innerJoin('applications as a', 'a.id', 'i.application_id')
          .innerJoin('candidates as c', 'c.id', 'a.candidate_id')
          .select(['i.id as interview_id', 'i.round_name', 'i.scheduled_end', 'i.feedback_due_at', 'c.full_name as candidate_name'])
          .where('m.user_id', '=', p.userId).where('m.feedback_status', '=', 'pending')
          .where('i.status', 'not in', ['cancelled', 'no_show', 'draft']).where('i.scheduled_end', '<', now)
          .orderBy('i.scheduled_end').limit(10).execute();

        // 2. Requisitions waiting for my approval (only when it is my turn).
        const approvals = await tx
          .selectFrom('requisition_approvals as ra')
          .innerJoin('requisitions as rq', 'rq.id', 'ra.requisition_id')
          .select(['rq.id', 'rq.title', 'rq.headcount'])
          .where('ra.approver_user_id', '=', p.userId).where('ra.decision', '=', 'pending')
          .where('rq.status', '=', 'pending_approval').whereRef('ra.round', '=', 'rq.approval_round')
          .where((eb) => eb.not(eb.exists(eb.selectFrom('requisition_approvals as e').select('e.id').whereRef('e.requisition_id', '=', 'ra.requisition_id').whereRef('e.round', '=', 'ra.round').where('e.decision', '=', 'pending').whereRef('e.step_order', '<', 'ra.step_order'))))
          .limit(10).execute();

        // 3. Candidates with interview feedback in and no decision since: waiting for a call.
        const waiting = await visibleApps()
          .select(['a.id', 'a.stage_id', 'c.full_name as candidate_name', 'c.current_title', 'v.id as vacancy_id', 'v.title as vacancy_title', 'rq.department_id',
            sql<number>`(select count(*)::int from feedback f where f.application_id = a.id)`.as('feedback_count'),
            sql<number | null>`(select round(avg(f.overall_rating)::numeric, 1)::float from feedback f where f.application_id = a.id)`.as('avg_rating'),
            sql<string[]>`coalesce((select array_agg(f.recommendation::text) from feedback f where f.application_id = a.id), '{}')`.as('recommendations')])
          .where('a.status', '=', 'active')
          .where(sql<boolean>`exists (select 1 from feedback f where f.application_id = a.id)`)
          .where(sql<boolean>`not exists (select 1 from hiring_decisions d where d.application_id = a.id and d.decided_at > (select max(f.submitted_at) from feedback f where f.application_id = a.id))`)
          .orderBy('a.stage_changed_at', 'desc').limit(12).execute();

        // 4. My vacancies, each with where its candidates are.
        const vacancies = await tx
          .selectFrom('vacancies as v')
          .innerJoin('requisitions as rq', 'rq.id', 'v.requisition_id')
          .innerJoin('departments as d', 'd.id', 'rq.department_id')
          .select(['v.id', 'v.title', 'v.vacancy_code', 'v.location', 'v.headcount', 'v.status', 'v.opened_at', 'd.name as department'])
          .where('v.status', 'in', ['open', 'on_hold']).where(vacancyVisible(p, null))
          .orderBy('v.opened_at').limit(20).execute();
        const counts = vacancies.length === 0 ? [] : await tx
          .selectFrom('applications as a').innerJoin('pipeline_stages as st', 'st.id', 'a.stage_id')
          .select(['a.vacancy_id', 'st.code', sql<number>`count(*)::int`.as('n')])
          .where('a.status', '=', 'active').where('a.vacancy_id', 'in', vacancies.map((v) => v.id))
          .groupBy(['a.vacancy_id', 'st.code']).execute();
        const hired = vacancies.length === 0 ? [] : await tx
          .selectFrom('applications as a').select(['a.vacancy_id', sql<number>`count(*)::int`.as('n')])
          .where('a.status', '=', 'hired').where('a.vacancy_id', 'in', vacancies.map((v) => v.id)).groupBy('a.vacancy_id').execute();

        // 5. Interviews coming up this week on my vacancies or where I am on the panel.
        const upcoming = await tx
          .selectFrom('interviews as i')
          .innerJoin('applications as a', 'a.id', 'i.application_id')
          .innerJoin('vacancies as v', 'v.id', 'a.vacancy_id')
          .innerJoin('requisitions as rq', 'rq.id', 'v.requisition_id')
          .innerJoin('candidates as c', 'c.id', 'a.candidate_id')
          .select(['i.id', 'i.round_name', 'i.scheduled_start', 'i.timezone', 'i.mode', 'c.full_name as candidate_name', 'v.title as vacancy_title',
            sql<boolean>`exists (select 1 from interviewers m where m.interview_id = i.id and m.user_id = ${p.userId})`.as('is_mine')])
          .where('i.status', 'in', ['scheduled', 'confirmed']).where('i.scheduled_start', '>=', now).where('i.scheduled_start', '<', new Date(now.getTime() + 7 * DAY))
          .where(vacancyVisible(p, null)).orderBy('i.scheduled_start').limit(8).execute();

        const n = (vid: string, codes: string[]) => counts.filter((c) => c.vacancy_id === vid && codes.includes(c.code)).reduce((t, c) => t + c.n, 0);
        const canDecide = (dept: string) => can(p, 'decisions.record', dept);
        return {
          feedback_owed: feedbackOwed.map((f) => ({ ...f, overdue: f.feedback_due_at !== null && f.feedback_due_at < now })),
          approvals,
          waiting_for_decision: waiting.map((w) => ({
            id: w.id, candidate_name: w.candidate_name, current_title: w.current_title, vacancy_id: w.vacancy_id, vacancy_title: w.vacancy_title,
            feedback_count: w.feedback_count, avg_rating: w.avg_rating, recommendations: w.recommendations, can_decide: canDecide(w.department_id),
          })),
          vacancies: vacancies.map((v) => ({
            id: v.id, title: v.title, code: v.vacancy_code, location: v.location, department: v.department, status: v.status, headcount: v.headcount,
            days_open: Math.floor((now.getTime() - v.opened_at.getTime()) / DAY),
            hired: hired.find((h) => h.vacancy_id === v.id)?.n ?? 0,
            funnel: { new: n(v.id, ['submitted']), screening: n(v.id, ['screening']), shortlisted: n(v.id, ['shortlisted']), interview: n(v.id, ['interview']), offer: n(v.id, ['offer']) },
          })),
          upcoming_interviews: upcoming,
        };
      }),
    };
  });
}
