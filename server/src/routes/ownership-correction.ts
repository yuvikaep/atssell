// The only way ownership of a submission changes: an exceptional, audited correction by the HR Lead.
// Normal submissions, including duplicates, can never overwrite an owner.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { principal } from '../app.js';
import { audit } from '../audit.js';
import { withTenant } from '../db.js';
import { AppError, forbidden, notFound } from '../errors.js';
import { recordOwnershipEvent } from '../ownership.js';
import { can } from '../permissions.js';
import { idParams } from './common.js';

const Body = z
  .object({ agency_id: z.uuid().optional(), user_id: z.uuid().optional(), reason: z.string().trim().min(5, 'Explain why ownership is being corrected.').max(2000) })
  .refine((b) => (b.agency_id === undefined) !== (b.user_id === undefined), { message: 'Choose either an agency or a company recruiter.', path: ['agency_id'] });

export async function ownershipCorrectionRoutes(app: FastifyInstance) {
  app.post('/submissions/:id/correct-ownership', async (req) => {
    const p = principal(req);
    if (!can(p, 'ownership.correct')) throw forbidden();
    const { id } = idParams.parse(req.params);
    const body = Body.parse(req.body);
    return withTenant(app.db, p.tenantId, async (tx) => {
      const s = await tx.selectFrom('submissions').select(['id', 'application_id', 'agency_id', 'source_user_id', 'source_type', 'ownership_state']).where('id', '=', id).forUpdate().executeTakeFirst();
      if (!s) throw notFound('Submission');
      if (s.ownership_state !== 'accepted') throw new AppError(409, 'NOT_OWNER', 'Only the accepted submission can be corrected.');
      if (await tx.selectFrom('employment_records').select('id').where('application_id', '=', s.application_id).executeTakeFirst()) {
        throw new AppError(409, 'ALREADY_JOINED', 'This candidate has already joined, so billing is based on the original owner and cannot be corrected here.');
      }
      if (body.agency_id) {
        const a = await tx.selectFrom('agencies').select('id').where('id', '=', body.agency_id).where('status', '=', 'active').executeTakeFirst();
        if (!a) throw new AppError(422, 'INVALID_AGENCY', 'That agency was not found or is inactive.');
        // Agency submissions are always tied to a person at the agency; use its admin as the responsible contact.
        const admin = await tx.selectFrom('agency_members as m').innerJoin('users as u', 'u.id', 'm.user_id').select('u.id').where('m.agency_id', '=', body.agency_id).where('m.agency_role', '=', 'admin').where('u.status', '=', 'active').limit(1).executeTakeFirst();
        if (!admin) throw new AppError(422, 'NO_AGENCY_ADMIN', 'That agency has no active admin to hold the submission.');
        await tx.updateTable('submissions').set({ source_type: 'agency', agency_id: body.agency_id, source_user_id: admin.id }).where('id', '=', id).execute();
      } else {
        const u = await tx.selectFrom('users as u').leftJoin('agency_members as m', 'm.user_id', 'u.id').select('u.id').where('u.id', '=', body.user_id!).where('u.status', '=', 'active').where('m.id', 'is', null).executeTakeFirst();
        if (!u) throw new AppError(422, 'INVALID_USER', 'That colleague was not found or is inactive.');
        await tx.updateTable('submissions').set({ source_type: 'internal_recruiter', agency_id: null, source_user_id: body.user_id! }).where('id', '=', id).execute();
      }
      await recordOwnershipEvent(tx, { tenantId: p.tenantId, submissionId: id, type: 'corrected', from: s.agency_id ? `agency:${s.agency_id}` : `user:${s.source_user_id}`, to: body.agency_id ? `agency:${body.agency_id}` : `user:${body.user_id}`, reason: body.reason, actorUserId: p.userId });
      await audit(tx, req, { tenantId: p.tenantId, actorUserId: p.userId, action: 'ownership.corrected', entityType: 'submission', entityId: id, metadata: { from: { agency_id: s.agency_id, user_id: s.source_user_id }, to: { agency_id: body.agency_id ?? null, user_id: body.user_id ?? null }, reason: body.reason } });
      return { data: { id, agency_id: body.agency_id ?? null, user_id: body.user_id ?? null } };
    });
  });
}
