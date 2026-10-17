// What a vacancy tells an assigned agency before it submits. (Ownership itself has no settings: the
// first party to source a candidate is credited automatically, and nobody can change that.)
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { principal } from '../app.js';
import { audit } from '../audit.js';
import { withTenant } from '../db.js';
import { notFound } from '../errors.js';
import { requirePermission } from '../permissions.js';

const Params = z.object({ id: z.uuid(), agencyId: z.uuid() });
const Body = z.object({ submission_notes: z.string().trim().max(2000).nullable() });

export async function agencyPolicyRoutes(app: FastifyInstance) {
  const { db } = app;

  app.patch('/vacancies/:id/agencies/:agencyId/policy', async (req) => {
    const p = principal(req);
    const { id, agencyId } = Params.parse(req.params);
    const { submission_notes } = Body.parse(req.body);
    return withTenant(db, p.tenantId, async (tx) => {
      const row = await tx
        .selectFrom('vacancy_agencies as va')
        .innerJoin('vacancies as v', 'v.id', 'va.vacancy_id')
        .innerJoin('requisitions as rq', 'rq.id', 'v.requisition_id')
        .select(['va.id', 'va.ownership_policy', 'rq.department_id'])
        .where('va.vacancy_id', '=', id)
        .where('va.agency_id', '=', agencyId)
        .forUpdate('va')
        .executeTakeFirst();
      if (!row) throw notFound('Agency assignment');
      requirePermission(p, 'vacancies.manage', row.department_id);
      // Only the notes are kept; settings from the retired ownership-window policy are dropped.
      const next = submission_notes ? { submission_notes } : {};
      await tx.updateTable('vacancy_agencies').set({ ownership_policy: JSON.stringify(next) }).where('id', '=', row.id).execute();
      await audit(tx, req, { tenantId: p.tenantId, actorUserId: p.userId, action: 'vacancy.agency_notes_changed', entityType: 'vacancy', entityId: id, metadata: { agency_id: agencyId } });
      return { data: next };
    });
  });
}
