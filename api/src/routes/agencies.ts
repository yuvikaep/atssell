// Agency records, so vacancies can be assigned to agencies. Agency members, invitations and the
// agency portal arrive in Sprint 3.
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { z } from 'zod';
import { principal } from '../app.js';
import { audit } from '../audit.js';
import { pgConstraint, pgErrorCode, withTenant } from '../db.js';
import { AppError, notFound } from '../errors.js';
import { requirePermission } from '../permissions.js';
import { idParams } from './common.js';

// No defaults in the shape, so PATCH only changes the fields it sends (see candidates.ts).
const shape = {
  name: z.string().trim().min(2).max(200),
  primary_contact_name: z.string().trim().max(200).nullable(),
  primary_contact_email: z.email().trim().toLowerCase().nullable(),
};
const Fields = z.object({
  ...shape,
  primary_contact_name: shape.primary_contact_name.default(null),
  primary_contact_email: shape.primary_contact_email.default(null),
});
const UpdateBody = z
  .object({ ...shape, status: z.enum(['active', 'inactive']) })
  .partial()
  .refine((b) => Object.keys(b).length > 0, 'Provide at least one field to update.');

const nameTaken = (err: unknown) => {
  if (pgErrorCode(err) === '23505' && pgConstraint(err) === 'agencies_tenant_id_name_key') {
    throw new AppError(409, 'AGENCY_NAME_TAKEN', 'An agency with this name already exists.');
  }
  throw err;
};

export async function agencyRoutes(app: FastifyInstance) {
  const { db } = app;

  app.get('/agencies', async (req) => {
    const p = principal(req);
    requirePermission(p, 'agencies.manage');
    const { status } = z.object({ status: z.enum(['active', 'inactive', 'all']).default('active') }).parse(req.query);
    const rows = await withTenant(db, p.tenantId, (tx) => {
      let q = tx
        .selectFrom('agencies as a')
        .select((eb) => [
          'a.id', 'a.name', 'a.status', 'a.primary_contact_name', 'a.primary_contact_email', 'a.created_at',
          eb.selectFrom('vacancy_agencies as va').innerJoin('vacancies as v', 'v.id', 'va.vacancy_id')
            .select(sql<number>`count(*)::int`.as('n'))
            .whereRef('va.agency_id', '=', 'a.id').where('va.status', '=', 'active').where('v.status', 'in', ['open', 'on_hold'])
            .as('assigned_vacancies'),
          eb.selectFrom('agency_members as am').select(sql<number>`count(*)::int`.as('n'))
            .whereRef('am.agency_id', '=', 'a.id')
            .as('members'),
        ])
        .orderBy('a.name');
      if (status !== 'all') q = q.where('a.status', '=', status);
      return q.execute();
    });
    return { data: rows };
  });

  app.post('/agencies', async (req, reply) => {
    const p = principal(req);
    requirePermission(p, 'agencies.manage');
    const body = Fields.parse(req.body);
    const agency = await withTenant(db, p.tenantId, async (tx) => {
      const row = await tx
        .insertInto('agencies')
        .values({ tenant_id: p.tenantId, ...body })
        .returningAll()
        .executeTakeFirstOrThrow()
        .catch(nameTaken);
      await audit(tx, req, {
        tenantId: p.tenantId, actorUserId: p.userId, action: 'agency.created', entityType: 'agency', entityId: row.id,
        metadata: { name: body.name },
      });
      return row;
    });
    return reply.status(201).send({ data: agency });
  });

  app.patch('/agencies/:id', async (req) => {
    const p = principal(req);
    requirePermission(p, 'agencies.manage');
    const { id } = idParams.parse(req.params);
    const body = UpdateBody.parse(req.body);
    const agency = await withTenant(db, p.tenantId, async (tx) => {
      const row = await tx.updateTable('agencies').set(body).where('id', '=', id).returningAll().executeTakeFirst().catch(nameTaken);
      if (!row) throw notFound('Agency');
      await audit(tx, req, {
        tenantId: p.tenantId, actorUserId: p.userId, action: 'agency.updated', entityType: 'agency', entityId: id,
        metadata: { changes: body },
      });
      return row;
    });
    return { data: agency };
  });
}
