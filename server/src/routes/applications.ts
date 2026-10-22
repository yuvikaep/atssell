import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { z } from 'zod';
import { assertJobRoleForVacancy } from './job-roles.js';
import { agencyIdOf, candidateVisible, hasAny, vacancyVisible } from '../access.js';
import { principal } from '../app.js';
import { audit } from '../audit.js';
import { pgConstraint, pgErrorCode, withTenant, type Tx } from '../db.js';
import { AppError, forbidden, notFound } from '../errors.js';
import { existingJobSubmission, lockJobCandidate, logDuplicateAttempt, recordOwnershipEvent } from '../ownership.js';
import { moveStage } from '../pipeline.js';
import { can, requirePermission, type Principal } from '../permissions.js';
import { idParams, pageQuery } from './common.js';

// Agency submissions (with ownership rules) are Sprint 3; this records internal sources.
const INTERNAL_SOURCES = ['internal_recruiter', 'referral', 'direct', 'job_board', 'other'] as const;

const CreateBody = z.object({
  candidate_id: z.uuid(),
  vacancy_id: z.uuid(),
  source_type: z.enum(INTERNAL_SOURCES).default('internal_recruiter'),
  source_reference: z.string().trim().max(200).nullable().default(null),
  // The department's job role this candidate is sourced for.
  job_role_id: z.uuid().nullish(),
});
const StageBody = z.object({ stage_id: z.uuid(), reason: z.string().trim().max(2000).optional() });
const ListQuery = pageQuery.extend({
  vacancy_id: z.uuid().optional(),
  candidate_id: z.uuid().optional(),
  stage_id: z.uuid().optional(),
  status: z.enum(['active', 'rejected', 'withdrawn', 'hired', 'archived', 'all']).default('active'),
  page_size: z.coerce.number().int().min(1).max(200).default(100),
});

async function loadApplication(tx: Tx, p: Principal, id: string, lock = false) {
  const agencyId = await agencyIdOf(tx, p.userId);
  let q = tx
    .selectFrom('applications as a')
    .innerJoin('vacancies as v', 'v.id', 'a.vacancy_id')
    .innerJoin('requisitions as rq', 'rq.id', 'v.requisition_id')
    .select(['a.id', 'a.status', 'a.stage_id', 'a.candidate_id', 'a.vacancy_id', 'v.status as vacancy_status', 'rq.department_id'])
    .where('a.id', '=', id)
    .where(vacancyVisible(p, agencyId));
  if (lock) q = q.forUpdate('a');
  const a = await q.executeTakeFirst();
  if (!a) throw notFound('Application');
  return a;
}

export async function applicationRoutes(app: FastifyInstance) {
  const { db } = app;

  app.get('/pipeline/stages', async (req) => {
    const p = principal(req);
    const rows = await withTenant(db, p.tenantId, async (tx) => {
      const stages = await tx
        .selectFrom('pipeline_stages')
        .select(['id', 'code', 'name', 'sort_order', 'is_initial', 'terminal_status'])
        .where('status', '=', 'active')
        .orderBy('sort_order')
        .execute();
      const transitions = await tx
        .selectFrom('pipeline_stage_transitions')
        .select(['from_stage_id', 'to_stage_id', 'requires_reason'])
        .execute();
      return stages.map((s) => ({
        ...s,
        next: transitions.filter((t) => t.from_stage_id === s.id).map((t) => ({ stage_id: t.to_stage_id, requires_reason: t.requires_reason })),
      }));
    });
    return { data: rows };
  });

  app.get('/applications', async (req) => {
    const p = principal(req);
    const f = ListQuery.parse(req.query);
    return withTenant(db, p.tenantId, async (tx) => {
      const agencyId = await agencyIdOf(tx, p.userId);
      let base = tx
        .selectFrom('applications as a')
        .innerJoin('candidates as c', 'c.id', 'a.candidate_id')
        .innerJoin('vacancies as v', 'v.id', 'a.vacancy_id')
        .innerJoin('requisitions as rq', 'rq.id', 'v.requisition_id')
        .innerJoin('pipeline_stages as s', 's.id', 'a.stage_id')
        .where(vacancyVisible(p, agencyId))
        .where(candidateVisible(p, agencyId));
      if (f.status !== 'all') base = base.where('a.status', '=', f.status);
      if (f.vacancy_id) base = base.where('a.vacancy_id', '=', f.vacancy_id);
      if (f.candidate_id) base = base.where('a.candidate_id', '=', f.candidate_id);
      if (f.stage_id) base = base.where('a.stage_id', '=', f.stage_id);

      const { total } = await base.select(sql<number>`count(*)::int`.as('total')).executeTakeFirstOrThrow();
      const rows = await base
        .select((eb) => [
          'a.id', 'a.status', 'a.stage_id', 's.name as stage_name', 's.code as stage_code', 'a.stage_changed_at', 'a.created_at',
          'a.candidate_id', 'c.full_name as candidate_name', 'c.current_title', 'c.city',
          'a.vacancy_id', 'v.vacancy_code', 'v.title as vacancy_title',
          eb.selectFrom('submissions as sub').select('sub.source_type').whereRef('sub.application_id', '=', 'a.id')
            .orderBy('sub.submitted_at').limit(1).as('source_type'),
          eb.selectFrom('submissions as sub').leftJoin('agencies as ag', 'ag.id', 'sub.agency_id')
            .select('ag.name').whereRef('sub.application_id', '=', 'a.id').orderBy('sub.submitted_at').limit(1).as('agency_name'),
        ])
        .orderBy('a.stage_changed_at', 'desc')
        .limit(f.page_size)
        .offset((f.page - 1) * f.page_size)
        .execute();
      // Agency users do not see other sources' details; they only see their own submissions' agency.
      return { data: rows, page: f.page, page_size: f.page_size, total };
    });
  });

  app.post('/applications', async (req, reply) => {
    const p = principal(req);
    requirePermission(p, 'applications.manage');
    const body = CreateBody.parse(req.body);

    const created = await withTenant(db, p.tenantId, async (tx) => {
      const agencyId = await agencyIdOf(tx, p.userId);
      if (agencyId) throw forbidden(); // Agencies submit through the agency portal.

      const vacancy = await tx
        .selectFrom('vacancies as v')
        .innerJoin('requisitions as rq', 'rq.id', 'v.requisition_id')
        .select(['v.id', 'v.status'])
        .where('v.id', '=', body.vacancy_id)
        .where(vacancyVisible(p, agencyId))
        .executeTakeFirst();
      if (!vacancy) throw notFound('Vacancy');
      if (vacancy.status !== 'open') throw new AppError(409, 'VACANCY_NOT_OPEN', 'Candidates can only be added to open vacancies.');

      const candidate = await tx
        .selectFrom('candidates as c')
        .select(['c.id', 'c.status'])
        .where('c.id', '=', body.candidate_id)
        .where(candidateVisible(p, agencyId))
        .executeTakeFirst();
      if (!candidate) throw notFound('Candidate');
      if (candidate.status !== 'active') throw new AppError(409, 'CANDIDATE_NOT_ACTIVE', 'This candidate profile was merged or archived.');

      const initial = await tx.selectFrom('pipeline_stages').select('id').where('is_initial', '=', true).executeTakeFirst();
      if (!initial) throw new AppError(500, 'NO_INITIAL_STAGE', 'The pipeline has no starting stage configured.');
      if (body.job_role_id) await assertJobRoleForVacancy(tx, body.job_role_id, body.vacancy_id);

      // First submission wins for this job. The lock lets the database pick one winner when two people
      // submit the same candidate at nearly the same moment.
      await lockJobCandidate(tx, p.tenantId, body.vacancy_id, body.candidate_id);
      const owner = await existingJobSubmission(tx, body.candidate_id, body.vacancy_id);
      if (owner) {
        await logDuplicateAttempt(tx, req, p, { vacancyId: body.vacancy_id, candidateId: body.candidate_id, originalSubmissionId: owner.submissionId, agencyId: null });
        return { duplicate: owner } as const;
      }

      const application = await tx
        .insertInto('applications')
        .values({ tenant_id: p.tenantId, candidate_id: body.candidate_id, vacancy_id: body.vacancy_id, stage_id: initial.id, job_role_id: body.job_role_id ?? null })
        .returning('id')
        .executeTakeFirstOrThrow();
      await tx
        .insertInto('application_stage_events')
        .values({ tenant_id: p.tenantId, application_id: application.id, from_stage_id: null, to_stage_id: initial.id, actor_user_id: p.userId })
        .execute();
      const submission = await tx
        .insertInto('submissions')
        .values({
          tenant_id: p.tenantId, application_id: application.id, source_type: body.source_type,
          source_user_id: p.userId, source_reference: body.source_reference, ownership_state: 'accepted',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await recordOwnershipEvent(tx, { tenantId: p.tenantId, submissionId: submission.id, type: 'credited', from: null, to: 'accepted', actorUserId: p.userId, reason: 'First submission for this job' });
      await audit(tx, req, {
        tenantId: p.tenantId, actorUserId: p.userId, action: 'application.created', entityType: 'application', entityId: application.id,
        metadata: { candidate_id: body.candidate_id, vacancy_id: body.vacancy_id, source_type: body.source_type },
      });
      return application;
    });
    if ('duplicate' in created) {
      const o = created.duplicate;
      throw new AppError(409, 'ALREADY_APPLIED', 'This candidate was already submitted for this job. The original submission keeps ownership; your attempt has been recorded.', {
        owner: o.agencyName ?? o.sourceUserName ?? 'Company recruiter', submitted_at: o.submittedAt, application_id: o.applicationId,
      });
    }
    return reply.status(201).send({ data: created });
  });

  app.patch('/applications/:id/stage', async (req) => {
    const p = principal(req);
    requirePermission(p, 'applications.manage');
    const { id } = idParams.parse(req.params);
    const body = StageBody.parse(req.body);

    const result = await withTenant(db, p.tenantId, async (tx) => {
      const a = await loadApplication(tx, p, id, true);
      // Company recruiters move candidates only through the early stages; selection, offer and joined are HR Lead outcomes.
      if (!can(p, 'employment.manage')) {
        const target = await tx.selectFrom('pipeline_stages').select('code').where('id', '=', body.stage_id).executeTakeFirst();
        if (!target || !['screening', 'shortlisted', 'withdrawn'].includes(target.code)) throw new AppError(403, 'FORBIDDEN', 'Only the HR Lead can set this status.');
      }
      await moveStage(tx, req, p, a, body.stage_id, body.reason);
      return tx
        .selectFrom('applications as a')
        .innerJoin('pipeline_stages as s', 's.id', 'a.stage_id')
        .select(['a.id', 'a.status', 'a.stage_id', 's.name as stage_name', 'a.stage_changed_at', 'a.disposition_reason'])
        .where('a.id', '=', id)
        .executeTakeFirstOrThrow();
    });
    return { data: result };
  });

  app.get('/applications/:id/history', async (req) => {
    const p = principal(req);
    const { id } = idParams.parse(req.params);
    if (!hasAny(p, 'candidates.view') && !hasAny(p, 'vacancies.view_assigned') && !hasAny(p, 'vacancies.view_all')) throw forbidden();
    return withTenant(db, p.tenantId, async (tx) => {
      await loadApplication(tx, p, id);
      const events = await tx
        .selectFrom('application_stage_events as e')
        .leftJoin('pipeline_stages as f', 'f.id', 'e.from_stage_id')
        .innerJoin('pipeline_stages as t', 't.id', 'e.to_stage_id')
        .leftJoin('users as u', 'u.id', 'e.actor_user_id')
        .select(['e.id', 'f.name as from_stage', 't.name as to_stage', 'e.reason', 'e.created_at', 'u.full_name as actor_name'])
        .where('e.application_id', '=', id)
        .orderBy('e.created_at', 'desc')
        .execute();
      return { data: events };
    });
  });
}
