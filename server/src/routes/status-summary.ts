// The plain counts each person sees (sourced, interview, selected, rejected, joined, backout…) over the
// candidates they work with, and the one step after selection: the candidate backed out.
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { z } from 'zod';
import { agencyIdOf, hasAny, vacancyVisible } from '../access.js';
import { principal } from '../app.js';
import { audit } from '../audit.js';
import { withTenant } from '../db.js';
import { AppError, forbidden, notFound } from '../errors.js';
import { can } from '../permissions.js';
import { stageByCode } from '../pipeline.js';
import { SIMPLE_STATUSES, simpleStatusSql } from '../simple-status.js';
import { idParams } from './common.js';

export async function statusSummaryRoutes(app: FastifyInstance) {
  const { db } = app;

  app.get('/status-summary', async (req) => {
    const p = principal(req);
    const f = z.object({ vacancy_id: z.uuid().optional() }).parse(req.query);
    const counts = await withTenant(db, p.tenantId, async (tx) => {
      let q = tx.selectFrom('applications as a')
        .select([simpleStatusSql('a').as('s'), sql<number>`count(*)::int`.as('n')])
        .groupBy(sql`1`);
      if (hasAny(p, 'agency_portal.use')) {
        // An agency: what it submitted; a sub-recruiter: only their own.
        const agencyId = await agencyIdOf(tx, p.userId);
        const admin = !!(await tx.selectFrom('agency_members').select('id').where('user_id', '=', p.userId).where('agency_role', '=', 'admin').executeTakeFirst());
        q = q.where((eb) => eb.exists(eb.selectFrom('submissions as sb').select('sb.id').whereRef('sb.application_id', '=', 'a.id')
          .where('sb.agency_id', '=', agencyId).$if(!admin, (s) => s.where('sb.source_user_id', '=', p.userId))));
      } else if (hasAny(p, 'candidates.view')) {
        q = q.innerJoin('vacancies as v', 'v.id', 'a.vacancy_id').innerJoin('requisitions as rq', 'rq.id', 'v.requisition_id').where(vacancyVisible(p, null));
      } else {
        // An interviewer: the candidates they interviewed.
        q = q.where((eb) => eb.exists(eb.selectFrom('interviewers as m').innerJoin('interviews as i', 'i.id', 'm.interview_id').select('m.id')
          .whereRef('i.application_id', '=', 'a.id').where('m.user_id', '=', p.userId)));
      }
      if (f.vacancy_id) q = q.where('a.vacancy_id', '=', f.vacancy_id);
      const rows = await q.execute();
      if (!f.vacancy_id) return { rows, job: null };
      // For one job: openings filled and the turnaround time (TAT) to fill them all.
      const v = await tx.selectFrom('vacancies').select(['headcount', 'opened_at', 'closed_at']).where('id', '=', f.vacancy_id).executeTakeFirst();
      const joins = await tx.selectFrom('employment_records').select('joined_on').where('vacancy_id', '=', f.vacancy_id).orderBy('joined_on').execute();
      if (!v) return { rows, job: null };
      const filled = joins.length;
      const lastJoin = filled >= v.headcount ? joins[v.headcount - 1]!.joined_on : null;
      const end = lastJoin ? new Date(lastJoin) : (v.closed_at ?? new Date());
      const days = Math.max(0, Math.round((end.getTime() - new Date(v.opened_at).getTime()) / 86_400_000));
      return { rows, job: { openings: v.headcount, filled, all_filled: !!lastJoin, tat_days: days, opened_at: v.opened_at } };
    });
    const by = Object.fromEntries(SIMPLE_STATUSES.map((s) => [s, 0])) as Record<string, number>;
    for (const r of counts.rows) by[r.s] = r.n;
    return { data: { ...by, total: counts.rows.reduce((n, r) => n + r.n, 0), job: counts.job } };
  });

  // Selected, but the candidate did not join.
  app.post('/applications/:id/backout', async (req) => {
    const p = principal(req);
    if (!can(p, 'employment.manage') && !hasAny(p, 'applications.manage')) throw forbidden();
    const { id } = idParams.parse(req.params);
    const { reason } = z.object({ reason: z.string().trim().min(1, 'Give a reason.').max(2000) }).parse(req.body);
    return withTenant(db, p.tenantId, async (tx) => {
      const a = await tx.selectFrom('applications as a').innerJoin('vacancies as v', 'v.id', 'a.vacancy_id').innerJoin('requisitions as rq', 'rq.id', 'v.requisition_id')
        .select(['a.id', 'a.status', 'a.stage_id', 'a.temp_employee_code']).where('a.id', '=', id)
        .$if(!can(p, 'employment.manage'), (q) => q.where(vacancyVisible(p, null))).forUpdate('a').executeTakeFirst();
      if (!a) throw notFound('Application');
      if (!a.temp_employee_code || a.status !== 'active') throw new AppError(409, 'NOT_SELECTED', 'Only a selected candidate who has not joined can back out.');
      if (await tx.selectFrom('employment_records').select('id').where('application_id', '=', id).executeTakeFirst()) throw new AppError(409, 'ALREADY_JOINED', 'This candidate has already joined.');
      const withdrawn = await stageByCode(tx, 'withdrawn');
      await tx.updateTable('applications').set({ status: 'withdrawn', disposition_reason: reason, ...(withdrawn ? { stage_id: withdrawn.id, stage_changed_at: sql`now()` } : {}) }).where('id', '=', id).execute();
      if (withdrawn) await tx.insertInto('application_stage_events').values({ tenant_id: p.tenantId, application_id: id, from_stage_id: a.stage_id, to_stage_id: withdrawn.id, actor_user_id: p.userId, reason }).execute();
      await audit(tx, req, { tenantId: p.tenantId, actorUserId: p.userId, action: 'application.backout', entityType: 'application', entityId: id, metadata: { reason } });
      return { data: { status: 'backout' } };
    });
  });
}
