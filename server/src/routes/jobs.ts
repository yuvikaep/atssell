// Jobs for the HR Lead. A job is one screen in the product, but underneath it is still a hiring request
// plus a vacancy, so recruiters, agencies, candidates and interviews all keep working as before. Creating
// a job opens both in one step, already approved: there is no approval chain in this product.
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { z } from 'zod';
import { principal } from '../app.js';
import { audit } from '../audit.js';
import { withTenant } from '../db.js';
import { AppError, forbidden, notFound } from '../errors.js';
import { can, requirePermission } from '../permissions.js';
import { idParams } from './common.js';
import { nextVacancyCode, vacancyDetail } from './vacancies.js';

const CreateJob = z
  .object({
    title: z.string().trim().min(2, 'Give the job a title.').max(200),
    department_id: z.uuid(),
    location: z.string().trim().min(1, 'Add a location.').max(200),
    openings: z.number().int().min(1).max(1000),
    // Who settles salary and joining for selected candidates.
    terms_owner: z.enum(['recruiter', 'interviewer', 'admin']).default('admin'),
    salary_min: z.number().min(0).max(1_000_000_000).nullable().default(null),
    salary_max: z.number().min(0).max(1_000_000_000).nullable().default(null),
    description: z.string().trim().max(10_000).default(''),
    skills: z.array(z.string().trim().min(1).max(60)).max(30).default([]),
  })
  .refine((b) => b.salary_min === null || b.salary_max === null || b.salary_max >= b.salary_min, { path: ['salary_max'], message: 'The maximum cannot be below the minimum.' });

const CloseJob = z.object({ outcome: z.string().trim().min(1, 'Say how the job ended.').max(2000) });

export async function jobRoutes(app: FastifyInstance) {
  const { db } = app;

  app.post('/jobs', async (req, reply) => {
    const p = principal(req);
    const body = CreateJob.parse(req.body);
    requirePermission(p, 'requisitions.create', body.department_id);
    requirePermission(p, 'vacancies.manage', body.department_id);
    const detail = await withTenant(db, p.tenantId, async (tx) => {
      const dept = await tx.selectFrom('departments').select('status').where('id', '=', body.department_id).executeTakeFirst();
      if (!dept || dept.status !== 'active') throw new AppError(422, 'INVALID_DEPARTMENT', 'Department was not found or is inactive.');
      const rq = await tx
        .insertInto('requisitions')
        .values({
          tenant_id: p.tenantId, department_id: body.department_id, title: body.title,
          description: body.description || body.title, headcount: body.openings, employment_type: 'full_time', location: body.location,
          skills: body.skills, min_ctc: body.salary_min, max_ctc: body.salary_max, requested_by: p.userId, status: 'approved',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      const vacancy = await tx
        .insertInto('vacancies')
        .values({ tenant_id: p.tenantId, requisition_id: rq.id, vacancy_code: await nextVacancyCode(tx, p.tenantId), title: body.title, location: body.location, headcount: body.openings, owner_user_id: p.userId, terms_owner: body.terms_owner })
        .returning(['id', 'vacancy_code'])
        .executeTakeFirstOrThrow();
      await audit(tx, req, { tenantId: p.tenantId, actorUserId: p.userId, action: 'job.created', entityType: 'vacancy', entityId: vacancy.id, metadata: { title: body.title, openings: body.openings, requisition_id: rq.id } });
      return vacancyDetail(tx, p, vacancy.id);
    });
    return reply.status(201).send({ data: detail });
  });

  // Closing records the outcome. Hiring target and actual joins are saved with it so the result is traceable later.
  app.post('/jobs/:id/close', async (req) => {
    const p = principal(req);
    const { id } = idParams.parse(req.params);
    const { outcome } = CloseJob.parse(req.body);
    return withTenant(db, p.tenantId, async (tx) => {
      const v = await tx
        .selectFrom('vacancies as v').innerJoin('requisitions as rq', 'rq.id', 'v.requisition_id')
        .select(['v.id', 'v.status', 'v.headcount', 'rq.department_id']).where('v.id', '=', id).forUpdate('v').executeTakeFirst();
      if (!v) throw notFound('Job');
      if (!can(p, 'employment.manage')) throw forbidden();
      if (v.status === 'closed' || v.status === 'cancelled') throw new AppError(409, 'ALREADY_CLOSED', 'This job is already closed.');
      const joined = (await tx.selectFrom('employment_records').select((eb) => eb.fn.countAll<number>().as('n')).where('vacancy_id', '=', id).executeTakeFirstOrThrow()).n;
      // Database time, like opened_at: the closed_at >= opened_at check must not depend on the API server's clock.
      await tx.updateTable('vacancies').set({ status: 'closed', status_reason: outcome, closed_at: sql`now()` }).where('id', '=', id).execute();
      await audit(tx, req, { tenantId: p.tenantId, actorUserId: p.userId, action: 'job.closed', entityType: 'vacancy', entityId: id, metadata: { outcome, target: v.headcount, joined: Number(joined) } });
      return { data: { id, status: 'closed', target: v.headcount, joined: Number(joined), outcome } };
    });
  });
}
