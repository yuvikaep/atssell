// A plain "where is each candidate" list for recruiters: one row per candidate on the jobs they can see,
// with a single status in everyday words, what the interviewers said, and whether an interview still
// needs booking. It reads the same tables as everything else and never exposes contact or pay.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { hasAny, vacancyVisible } from '../access.js';
import { principal } from '../app.js';
import { withTenant } from '../db.js';
import { forbidden } from '../errors.js';

export type StatusTone = 'muted' | 'info' | 'warning' | 'success' | 'danger';

export async function candidateStatusRoutes(app: FastifyInstance) {
  const { db } = app;

  app.get('/candidate-status', async (req) => {
    const p = principal(req);
    if (!hasAny(p, 'candidates.view')) throw forbidden();
    const f = z.object({
      vacancy_id: z.uuid().optional(),
      // Name, sourcing ID (SRC-…) or temp employee ID (TEMP-…).
      q: z.string().trim().max(100).optional(),
      selected: z.enum(['yes', 'no']).optional(),
      job_role_id: z.uuid().optional(),
    }).parse(req.query);
    const now = new Date();

    const rows = await withTenant(db, p.tenantId, async (tx) => {
      let q = tx
        .selectFrom('applications as a')
        .innerJoin('vacancies as v', 'v.id', 'a.vacancy_id')
        .innerJoin('requisitions as rq', 'rq.id', 'v.requisition_id')
        .innerJoin('candidates as c', 'c.id', 'a.candidate_id')
        .leftJoin('job_roles as jr', 'jr.id', 'a.job_role_id')
        .select(['a.id', 'a.status', 'a.created_at', 'a.sourcing_code', 'a.temp_employee_code', 'a.job_role_id', 'jr.name as job_role_name',
          (eb) => eb.selectFrom('candidate_documents as cd').select('cd.id').whereRef('cd.candidate_id', '=', 'c.id').where('cd.document_type', '=', 'resume').where('cd.scan_status', '=', 'clean').orderBy('cd.created_at', 'desc').limit(1).as('resume_document_id'), 'c.id as candidate_id', 'c.full_name', 'c.current_title', 'c.city', 'v.id as vacancy_id', 'v.title as vacancy_title'])
        .where(vacancyVisible(p, null));
      if (f.vacancy_id) q = q.where('a.vacancy_id', '=', f.vacancy_id);
      if (f.q) {
        const like = `%${f.q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
        q = q.where((eb) => eb.or([eb('c.full_name', 'ilike', like), eb('a.sourcing_code', 'ilike', like), eb('a.temp_employee_code', 'ilike', like)]));
      }
      if (f.job_role_id) q = q.where('a.job_role_id', '=', f.job_role_id);
      if (f.selected === 'yes') q = q.where('a.temp_employee_code', 'is not', null);
      if (f.selected === 'no') q = q.where('a.temp_employee_code', 'is', null);
      const apps = await q.orderBy('a.created_at', 'desc').limit(300).execute();
      if (apps.length === 0) return [];
      const ids = apps.map((a) => a.id);

      const interviews = await tx.selectFrom('interviews').select(['id', 'application_id', 'round_name', 'status', 'scheduled_start', 'scheduled_end', 'created_at'])
        .where('application_id', 'in', ids).where('status', '<>', 'cancelled').orderBy('created_at', 'desc').execute();
      const pending = new Set((await tx.selectFrom('interviewers').select('interview_id').where('feedback_status', '=', 'pending').execute()).map((r) => r.interview_id));
      const feedback = await tx.selectFrom('feedback').select(['application_id', 'overall_rating', 'recommendation', 'submitted_at']).where('application_id', 'in', ids).execute();
      const decisions = await tx.selectFrom('hiring_decisions').select(['application_id', 'decision', 'reason', 'decided_at']).where('application_id', 'in', ids).orderBy('decided_at', 'desc').execute();
      const requests = await tx.selectFrom('interview_events as e').innerJoin('interviews as i', 'i.id', 'e.interview_id')
        .select(['i.application_id', 'e.reason']).where('e.event_type', '=', 'next_round_requested').where('i.application_id', 'in', ids).orderBy('e.created_at', 'desc').execute();

      return apps.map((a) => {
        const ivs = interviews.filter((i) => i.application_id === a.id);
        const fbs = feedback.filter((x) => x.application_id === a.id);
        const decision = decisions.find((d) => d.application_id === a.id);
        const lastFb = fbs.reduce<Date | null>((m, x) => (!m || x.submitted_at > m ? x.submitted_at : m), null);
        const decided = decision && (!lastFb || decision.decided_at > lastFb) ? decision : undefined;
        const draft = ivs.find((i) => i.status === 'draft');
        const upcoming = ivs.filter((i) => ['scheduled', 'confirmed'].includes(i.status) && i.scheduled_start && i.scheduled_start > now).sort((x, y) => x.scheduled_start!.getTime() - y.scheduled_start!.getTime())[0];
        const awaiting = ivs.find((i) => ['scheduled', 'confirmed', 'completed'].includes(i.status) && i.scheduled_end && i.scheduled_end <= now && pending.has(i.id));
        const remark = requests.find((r) => r.application_id === a.id)?.reason ?? decision?.reason ?? null;

        let label: string; let tone: StatusTone; let detail: string | null = null;
        if (a.status === 'hired') { label = 'Hired'; tone = 'success'; }
        else if (a.status === 'rejected') { label = 'Rejected'; tone = 'danger'; }
        else if (a.status === 'withdrawn') { label = 'Withdrew'; tone = 'muted'; }
        else if (draft) { label = 'Needs interview time'; tone = 'warning'; detail = draft.round_name; }
        else if (decided?.decision === 'select') { label = 'Selected'; tone = 'success'; }
        else if (decided?.decision === 'hold') { label = 'On hold'; tone = 'warning'; }
        else if (decided?.decision === 'reject') { label = 'Not selected'; tone = 'danger'; }
        else if (upcoming) { label = 'Interview scheduled'; tone = 'info'; detail = `${upcoming.round_name}`; }
        else if (awaiting) { label = 'Waiting for feedback'; tone = 'warning'; detail = awaiting.round_name; }
        else if (fbs.length > 0) { label = 'Feedback received'; tone = 'info'; }
        else { label = 'Sourced'; tone = 'muted'; detail = 'No interview yet'; }

        const open = !['hired', 'rejected', 'withdrawn'].includes(a.status);
        const finalDecision = !!decided && ['select', 'hold', 'reject'].includes(decided.decision);
        const sentOn = decided?.decision === 'additional_round' || decided?.decision === 'advance';
        const needsInterview = open && !upcoming && !awaiting && !finalDecision && (!!draft || fbs.length === 0 || sentOn);
        return {
          application_id: a.id, sourcing_code: a.sourcing_code, temp_employee_code: a.temp_employee_code, job_role_id: a.job_role_id, job_role_name: a.job_role_name, resume_document_id: a.resume_document_id, candidate_id: a.candidate_id, candidate_name: a.full_name, headline: [a.current_title, a.city].filter(Boolean).join(' · ') || null,
          vacancy_id: a.vacancy_id, vacancy_title: a.vacancy_title, label, tone, detail,
          scheduled_start: upcoming?.scheduled_start ?? null,
          feedback: fbs.length ? { count: fbs.length, avg_rating: Math.round((fbs.reduce((n, x) => n + x.overall_rating, 0) / fbs.length) * 10) / 10, recommendations: fbs.map((x) => x.recommendation) } : null,
          remark, action: needsInterview ? (draft ? { kind: 'set_time' as const, interview_id: draft.id } : { kind: 'schedule' as const }) : null,
        };
      });
    });
    return { data: rows };
  });
}
