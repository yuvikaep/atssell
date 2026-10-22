// Job roles inside departments (e.g. Sales → "Sales Executive"). Recruiters pick one when sourcing.
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { z } from 'zod';
import { hasAny } from '../access.js';
import { principal } from '../app.js';
import { audit } from '../audit.js';
import { pgErrorCode, withTenant, type Tx } from '../db.js';
import { AppError, forbidden, notFound } from '../errors.js';
import { requirePermission } from '../permissions.js';
import { idParams } from './common.js';

const ListQuery = z.object({ department_id: z.uuid().optional(), status: z.enum(['active', 'inactive', 'all']).default('active') });
const CreateBody = z.object({ department_id: z.uuid(), name: z.string().trim().min(1, 'Enter the role name.').max(120) });
const UpdateBody = z.object({ name: z.string().trim().min(1).max(120), status: z.enum(['active', 'inactive']) }).partial();

const taken = () => new AppError(409, 'JOB_ROLE_EXISTS', 'This department already has a role with that name.');

function list(tx: Tx) {
  return tx.selectFrom('job_roles as r').innerJoin('departments as d', 'd.id', 'r.department_id')
    .select(['r.id', 'r.name', 'r.status', 'r.department_id', 'd.name as department_name',
      (eb) => eb.selectFrom('applications as a').select(sql<number>`count(*)::int`.as('n')).whereRef('a.job_role_id', '=', 'r.id').as('sourced')]);
}

/** Checks a job role chosen while sourcing: active, and in the job's department. */
export async function assertJobRoleForVacancy(tx: Tx, jobRoleId: string, vacancyId: string) {
  const ok = await tx.selectFrom('job_roles as r')
    .innerJoin('requisitions as rq', 'rq.department_id', 'r.department_id')
    .innerJoin('vacancies as v', 'v.requisition_id', 'rq.id')
    .select('r.id').where('r.id', '=', jobRoleId).where('v.id', '=', vacancyId).where('r.status', '=', 'active')
    .executeTakeFirst();
  if (!ok) throw new AppError(400, 'VALIDATION_ERROR', 'Some fields are invalid.', [{ path: 'job_role_id', message: "Choose a role from this job's department." }]);
}

export async function jobRoleRoutes(app: FastifyInstance) {
  const { db } = app;

  app.get('/job-roles', async (req) => {
    const p = principal(req);
    if (!hasAny(p, 'candidates.view') && !hasAny(p, 'departments.manage') && !hasAny(p, 'agency_portal.use')) throw forbidden();
    const f = ListQuery.parse(req.query);
    const rows = await withTenant(db, p.tenantId, (tx) => {
      let q = list(tx).orderBy('d.name').orderBy('r.name');
      if (f.department_id) q = q.where('r.department_id', '=', f.department_id);
      if (f.status !== 'all') q = q.where('r.status', '=', f.status);
      return q.execute();
    });
    return { data: rows };
  });

  app.post('/job-roles', async (req, reply) => {
    const p = principal(req);
    requirePermission(p, 'departments.manage');
    const body = CreateBody.parse(req.body);
    const row = await withTenant(db, p.tenantId, async (tx) => {
      const dept = await tx.selectFrom('departments').select('status').where('id', '=', body.department_id).executeTakeFirst();
      if (!dept || dept.status !== 'active') throw notFound('Department');
      const r = await tx.insertInto('job_roles').values({ tenant_id: p.tenantId, department_id: body.department_id, name: body.name })
        .returning('id').executeTakeFirstOrThrow()
        .catch((err: unknown) => { throw pgErrorCode(err) === '23505' ? taken() : err; });
      await audit(tx, req, { tenantId: p.tenantId, actorUserId: p.userId, action: 'job_role.created', entityType: 'job_role', entityId: r.id, metadata: { name: body.name, department_id: body.department_id } });
      return list(tx).where('r.id', '=', r.id).executeTakeFirstOrThrow();
    });
    return reply.status(201).send({ data: row });
  });

  app.patch('/job-roles/:id', async (req) => {
    const p = principal(req);
    requirePermission(p, 'departments.manage');
    const { id } = idParams.parse(req.params);
    const body = UpdateBody.parse(req.body);
    const row = await withTenant(db, p.tenantId, async (tx) => {
      const r = await tx.updateTable('job_roles').set({ ...body, updated_at: sql`now()` }).where('id', '=', id).returning('id').executeTakeFirst()
        .catch((err: unknown) => { throw pgErrorCode(err) === '23505' ? taken() : err; });
      if (!r) throw notFound('Job role');
      await audit(tx, req, { tenantId: p.tenantId, actorUserId: p.userId, action: 'job_role.updated', entityType: 'job_role', entityId: id, metadata: body });
      return list(tx).where('r.id', '=', id).executeTakeFirstOrThrow();
    });
    return { data: row };
  });
}
