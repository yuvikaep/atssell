// Jobs for the HR Lead. A job is one screen in the product, but underneath it is still a hiring request
// plus a vacancy, so recruiters, agencies, candidates and interviews all keep working as before. Creating
// a job opens both in one step, already approved: there is no approval chain in this product.
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { z } from 'zod';
import { principal } from '../app.js';
import { audit } from '../audit.js';
import { withTenant, type Tx } from '../db.js';
import { AppError, forbidden, notFound } from '../errors.js';
import { can, requirePermission } from '../permissions.js';
import { idParams } from './common.js';
import { assertInternalActiveUser, nextVacancyCode, vacancyDetail } from './vacancies.js';

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
    // The job's interviewers, chosen when the job is created (only they and admins sit on its panels).
    interviewer_ids: z.array(z.uuid()).max(50).default([]),
  })
  .refine((b) => b.salary_min === null || b.salary_max === null || b.salary_max >= b.salary_min, { path: ['salary_max'], message: 'The maximum cannot be below the minimum.' });

const EditJob = z
  .object({
    title: z.string().trim().min(2, 'Give the job a title.').max(200),
    location: z.string().trim().min(1, 'Add a location.').max(200),
    openings: z.number().int().min(1).max(1000),
    terms_owner: z.enum(['recruiter', 'interviewer', 'admin']),
    salary_min: z.number().min(0).max(1_000_000_000).nullable(),
    salary_max: z.number().min(0).max(1_000_000_000).nullable(),
    description: z.string().trim().max(10_000),
    skills: z.array(z.string().trim().min(1).max(60)).max(30),
    min_experience_years: z.number().min(0).max(60).nullable(),
    max_experience_years: z.number().min(0).max(60).nullable(),
    interviewer_ids: z.array(z.uuid()).max(50),
  })
  .partial()
  .refine((b) => b.salary_min == null || b.salary_max == null || b.salary_max >= b.salary_min, { path: ['salary_max'], message: 'The maximum cannot be below the minimum.' })
  .refine((b) => b.min_experience_years == null || b.max_experience_years == null || b.max_experience_years >= b.min_experience_years, { path: ['max_experience_years'], message: 'The maximum cannot be below the minimum.' });

const CloseJob = z.object({ outcome: z.string().trim().min(1, 'Say how the job ended.').max(2000) });

/** Makes the job's interviewers exactly these people (company users, active). */
async function setInterviewers(tx: Tx, p: { tenantId: string; userId: string }, vacancyId: string, ids: string[]) {
  const wanted = [...new Set(ids)];
  for (const id of wanted) await assertInternalActiveUser(tx, id, 'Interviewer');
  const current = (await tx.selectFrom('vacancy_interviewers').select('user_id').where('vacancy_id', '=', vacancyId).execute()).map((r) => r.user_id);
  const remove = current.filter((u) => !wanted.includes(u));
  if (remove.length) await tx.deleteFrom('vacancy_interviewers').where('vacancy_id', '=', vacancyId).where('user_id', 'in', remove).execute();
  const add = wanted.filter((u) => !current.includes(u));
  if (add.length) await tx.insertInto('vacancy_interviewers').values(add.map((user_id) => ({ tenant_id: p.tenantId, vacancy_id: vacancyId, user_id, assigned_by: p.userId }))).execute();
}

export async function jobRoutes(app: FastifyInstance) {
  const { db } = app;

  // Edit an existing job: title, location, openings, salary range, JD, skills, experience and who settles salary.
  app.patch('/jobs/:id', async (req) => {
    const p = principal(req);
    const { id } = idParams.parse(req.params);
    const body = EditJob.parse(req.body);
    return { data: await withTenant(db, p.tenantId, async (tx) => {
      const v = await tx.selectFrom('vacancies as v').innerJoin('requisitions as rq', 'rq.id', 'v.requisition_id')
        .select(['v.id', 'v.status', 'v.requisition_id', 'rq.department_id', 'rq.min_ctc', 'rq.max_ctc', 'rq.min_experience_years', 'rq.max_experience_years'])
        .where('v.id', '=', id).forUpdate('v').executeTakeFirst();
      if (!v) throw notFound('Job');
      requirePermission(p, 'vacancies.manage', v.department_id);
      if (v.status === 'closed' || v.status === 'cancelled') throw new AppError(409, 'JOB_CLOSED', 'A closed or cancelled job cannot be edited.');
      const lo = body.salary_min !== undefined ? body.salary_min : v.min_ctc;
      const hi = body.salary_max !== undefined ? body.salary_max : v.max_ctc;
      if (lo != null && hi != null && Number(hi) < Number(lo)) throw new AppError(400, 'VALIDATION_ERROR', 'Some fields are invalid.', [{ path: 'salary_max', message: 'The maximum cannot be below the minimum.' }]);
      if (body.openings !== undefined) {
        const joined = (await tx.selectFrom('employment_records').select(sql<number>`count(*)::int`.as('n')).where('vacancy_id', '=', id).executeTakeFirstOrThrow()).n;
        if (body.openings < joined) throw new AppError(400, 'VALIDATION_ERROR', 'Some fields are invalid.', [{ path: 'openings', message: `${joined} people already joined this job.` }]);
      }
      const vac = { title: body.title, location: body.location, headcount: body.openings, terms_owner: body.terms_owner };
      const req2 = { title: body.title, location: body.location, headcount: body.openings, min_ctc: body.salary_min, max_ctc: body.salary_max, description: body.description || undefined, skills: body.skills, min_experience_years: body.min_experience_years, max_experience_years: body.max_experience_years };
      const clean = <T extends Record<string, unknown>>(o: T) => Object.fromEntries(Object.entries(o).filter(([, x]) => x !== undefined)) as Partial<T>;
      if (Object.keys(clean(vac)).length) await tx.updateTable('vacancies').set({ ...clean(vac), updated_at: sql`now()` }).where('id', '=', id).execute();
      if (Object.keys(clean(req2)).length) await tx.updateTable('requisitions').set({ ...clean(req2), updated_at: sql`now()` }).where('id', '=', v.requisition_id).execute();
      if (body.interviewer_ids) await setInterviewers(tx, p, id, body.interviewer_ids);
      await audit(tx, req, { tenantId: p.tenantId, actorUserId: p.userId, action: 'job.updated', entityType: 'vacancy', entityId: id, metadata: body });
      return vacancyDetail(tx, p, id);
    }) };
  });

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
      await setInterviewers(tx, p, vacancy.id, body.interviewer_ids);
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
