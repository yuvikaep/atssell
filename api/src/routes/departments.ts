import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { z } from 'zod';
import { principal } from '../app.js';
import { audit } from '../audit.js';
import { pgConstraint, pgErrorCode, withTenant, type Tx } from '../db.js';
import { AppError, notFound } from '../errors.js';
import { can, requirePermission, type Principal } from '../permissions.js';
import { idParams } from './common.js';

const ListQuery = z.object({ status: z.enum(['active', 'inactive', 'all']).default('active') });

const CreateBody = z.object({
  name: z.string().trim().min(1).max(120),
  parent_department_id: z.uuid().nullish(),
  head_user_id: z.uuid().nullish(),
});

const UpdateBody = z
  .object({
    name: z.string().trim().min(1).max(120),
    parent_department_id: z.uuid().nullable(),
    head_user_id: z.uuid().nullable(),
    status: z.enum(['active', 'inactive']),
  })
  .partial()
  .refine((b) => Object.keys(b).length > 0, 'Provide at least one field to update.');

/**
 * Departments the principal may see: all of them with company-wide department or vacancy access,
 * otherwise only the departments their role assignments are scoped to.
 */
function visibleDepartmentIds(p: Principal): 'all' | string[] {
  if (can(p, 'departments.manage') || can(p, 'vacancies.view_all')) return 'all';
  return [...new Set(p.roles.map((r) => r.departmentId).filter((id): id is string => id !== null))];
}

function listQuery(tx: Tx) {
  return tx
    .selectFrom('departments as d')
    .leftJoin('departments as parent', 'parent.id', 'd.parent_department_id')
    .leftJoin('users as head', 'head.id', 'd.head_user_id')
    .select((eb) => [
      'd.id', 'd.name', 'd.status', 'd.parent_department_id', 'd.head_user_id', 'd.created_at', 'd.updated_at',
      'parent.name as parent_name',
      'head.full_name as head_name',
      eb
        .selectFrom('vacancies as v')
        .innerJoin('requisitions as rq', 'rq.id', 'v.requisition_id')
        .select(sql<number>`count(*)::int`.as('n'))
        .whereRef('rq.department_id', '=', 'd.id')
        .where('v.status', '=', 'open')
        .as('active_vacancies'),
    ]);
}

/** Maps database constraint errors to API errors. */
function mapDbError(err: unknown): never {
  const code = pgErrorCode(err);
  if (code === '23505' && pgConstraint(err) === 'departments_tenant_id_name_key') {
    throw new AppError(409, 'DEPARTMENT_NAME_TAKEN', 'A department with this name already exists.');
  }
  if (code === 'JMD01') {
    throw new AppError(422, 'DEPARTMENT_CYCLE', 'A department cannot be placed under itself or one of its sub-departments.');
  }
  if (code === '23503') {
    throw new AppError(422, 'INVALID_REFERENCE', 'Parent department or department head was not found.');
  }
  throw err;
}

async function assertActiveRefs(tx: Tx, parentId?: string | null, headUserId?: string | null) {
  if (parentId) {
    const parent = await tx.selectFrom('departments').select('status').where('id', '=', parentId).executeTakeFirst();
    if (!parent) throw new AppError(422, 'INVALID_REFERENCE', 'Parent department was not found.');
    if (parent.status !== 'active') throw new AppError(422, 'PARENT_INACTIVE', 'Parent department is inactive.');
  }
  if (headUserId) {
    const head = await tx.selectFrom('users').select('status').where('id', '=', headUserId).executeTakeFirst();
    if (!head) throw new AppError(422, 'INVALID_REFERENCE', 'Department head was not found.');
    if (head.status !== 'active') throw new AppError(422, 'HEAD_INACTIVE', 'Department head is not an active user.');
  }
}

export async function departmentRoutes(app: FastifyInstance) {
  const { db } = app;

  app.get('/departments', async (req) => {
    const p = principal(req);
    const { status } = ListQuery.parse(req.query);
    const visible = visibleDepartmentIds(p);
    if (visible !== 'all' && visible.length === 0) return { data: [] };

    const rows = await withTenant(db, p.tenantId, (tx) => {
      let q = listQuery(tx).orderBy('d.name');
      if (status !== 'all') q = q.where('d.status', '=', status);
      if (visible !== 'all') q = q.where('d.id', 'in', visible);
      return q.execute();
    });
    return { data: rows };
  });

  app.post('/departments', async (req, reply) => {
    const p = principal(req);
    requirePermission(p, 'departments.manage');
    const body = CreateBody.parse(req.body);

    const created = await withTenant(db, p.tenantId, async (tx) => {
      await assertActiveRefs(tx, body.parent_department_id, body.head_user_id);
      const dept = await tx
        .insertInto('departments')
        .values({
          tenant_id: p.tenantId,
          name: body.name,
          parent_department_id: body.parent_department_id ?? null,
          head_user_id: body.head_user_id ?? null,
        })
        .returning('id')
        .executeTakeFirstOrThrow()
        .catch(mapDbError);
      await audit(tx, req, {
        tenantId: p.tenantId,
        actorUserId: p.userId,
        action: 'department.created',
        entityType: 'department',
        entityId: dept.id,
        metadata: { name: body.name },
      });
      return listQuery(tx).where('d.id', '=', dept.id).executeTakeFirstOrThrow();
    });
    return reply.status(201).send({ data: created });
  });

  app.patch('/departments/:id', async (req) => {
    const p = principal(req);
    requirePermission(p, 'departments.manage');
    const { id } = idParams.parse(req.params);
    const body = UpdateBody.parse(req.body);

    const updated = await withTenant(db, p.tenantId, async (tx) => {
      const current = await tx.selectFrom('departments').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
      if (!current) throw notFound('Department');

      await assertActiveRefs(
        tx,
        body.parent_department_id !== current.parent_department_id ? body.parent_department_id : undefined,
        body.head_user_id !== current.head_user_id ? body.head_user_id : undefined,
      );

      if (body.status === 'inactive' && current.status === 'active') {
        const child = await tx
          .selectFrom('departments')
          .select('id')
          .where('parent_department_id', '=', id)
          .where('status', '=', 'active')
          .executeTakeFirst();
        if (child) {
          throw new AppError(409, 'HAS_ACTIVE_CHILDREN', 'Deactivate or move its sub-departments first.');
        }
        const openVacancy = await tx
          .selectFrom('vacancies as v')
          .innerJoin('requisitions as rq', 'rq.id', 'v.requisition_id')
          .select('v.id')
          .where('rq.department_id', '=', id)
          .where('v.status', 'in', ['open', 'on_hold'])
          .executeTakeFirst();
        if (openVacancy) {
          throw new AppError(409, 'HAS_OPEN_VACANCIES', 'Close or move its open vacancies first.');
        }
      }

      await tx.updateTable('departments').set(body).where('id', '=', id).execute().catch(mapDbError);
      await audit(tx, req, {
        tenantId: p.tenantId,
        actorUserId: p.userId,
        action: body.status && body.status !== current.status ? `department.${body.status === 'active' ? 'reactivated' : 'deactivated'}` : 'department.updated',
        entityType: 'department',
        entityId: id,
        metadata: {
          changes: Object.fromEntries(
            Object.entries(body).map(([k, v]) => [k, { from: current[k as keyof typeof current], to: v }]),
          ),
        },
      });
      return listQuery(tx).where('d.id', '=', id).executeTakeFirstOrThrow();
    });
    return { data: updated };
  });
}
