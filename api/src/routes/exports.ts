// Export requests. Creating one queues a job; the worker builds the file; the requester then asks for
// a short-lived signed link. Only the requester can download their own export.
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { principal } from '../app.js';
import { audit } from '../audit.js';
import { withTenant } from '../db.js';
import { AppError, forbidden, notFound } from '../errors.js';
import { allowedFields, canExport, EXPORT_FIELDS, EXPORT_TYPES, EXPORT_TTL_HOURS } from '../exports.js';
import { signFileToken } from '../storage.js';
import { idParams } from './common.js';

const CreateExport = z.object({
  type: z.enum(EXPORT_TYPES),
  fields: z.array(z.string().max(60)).max(30).optional(),
  filters: z.object({ status: z.string().max(40).optional(), department_id: z.uuid().optional() }).default({}),
});

export async function exportRoutes(app: FastifyInstance) {
  const { db, config } = app;

  app.get('/exports/options', async (req) => {
    const p = principal(req);
    return {
      data: EXPORT_TYPES.filter((t) => canExport(p, t)).map((t) => ({
        type: t,
        fields: allowedFields(p, t).map((k) => ({ key: k, label: EXPORT_FIELDS[t][k]!.label })),
      })),
    };
  });

  app.post('/exports', async (req, reply) => {
    const p = principal(req);
    const body = CreateExport.parse(req.body);
    if (!canExport(p, body.type)) throw forbidden();
    const allowed = allowedFields(p, body.type);
    const requested = body.fields?.length ? body.fields : allowed;
    const unknown = requested.filter((f) => !(f in EXPORT_FIELDS[body.type]));
    if (unknown.length) throw new AppError(400, 'VALIDATION_ERROR', `Unknown fields: ${unknown.join(', ')}.`);
    const denied = requested.filter((f) => !allowed.includes(f));
    if (denied.length) throw forbidden();
    const job = await withTenant(db, p.tenantId, async (tx) => {
      const row = await tx
        .insertInto('export_jobs')
        .values({ tenant_id: p.tenantId, export_type: body.type, filters: JSON.stringify(body.filters), fields: requested, requested_by: p.userId })
        .returning(['id', 'export_type', 'status', 'created_at'])
        .executeTakeFirstOrThrow();
      await audit(tx, req, { tenantId: p.tenantId, actorUserId: p.userId, action: 'export.requested', entityType: 'export_job', entityId: row.id, metadata: { type: body.type, fields: requested, filters: body.filters } });
      return row;
    });
    return reply.code(202).send({ data: job });
  });

  app.get('/exports', async (req) => {
    const p = principal(req);
    const rows = await withTenant(db, p.tenantId, (tx) =>
      tx.selectFrom('export_jobs').select(['id', 'export_type', 'status', 'row_count', 'filename', 'error', 'created_at', 'finished_at', 'expires_at'])
        .where('requested_by', '=', p.userId).orderBy('created_at', 'desc').limit(25).execute());
    return { data: rows.map((r) => ({ ...r, expired: r.expires_at !== null && r.expires_at < new Date() })) };
  });

  app.post('/exports/:id/download-link', async (req) => {
    const p = principal(req);
    const { id } = idParams.parse(req.params);
    const expiresAt = new Date(Date.now() + 5 * 60_000);
    await withTenant(db, p.tenantId, async (tx) => {
      const job = await tx.selectFrom('export_jobs').select(['id', 'status', 'expires_at']).where('id', '=', id).where('requested_by', '=', p.userId).executeTakeFirst();
      if (!job) throw notFound('Export');
      if (job.status !== 'succeeded') throw new AppError(409, 'EXPORT_NOT_READY', 'This export is not ready to download.');
      if (job.expires_at && job.expires_at < new Date()) throw new AppError(410, 'EXPORT_EXPIRED', `Exports are kept for ${EXPORT_TTL_HOURS} hours. Request a new one.`);
      await audit(tx, req, { tenantId: p.tenantId, actorUserId: p.userId, action: 'export.download_link_issued', entityType: 'export_job', entityId: id });
    });
    const token = signFileToken(config.FILE_URL_SECRET, { t: p.tenantId, d: id, e: Math.floor(expiresAt.getTime() / 1000), x: 'export' });
    return { data: { url: `/api/v1/files/${token}`, expires_at: expiresAt } };
  });
}

/** Serves an export for a valid signed link. The link is only ever issued to the requester. */
export async function sendExport(app: FastifyInstance, claims: { t: string; d: string }, reply: FastifyReply) {
  const gone = () => new AppError(410, 'LINK_INVALID', 'This download link is invalid or has expired.');
  const job = await withTenant(app.db, claims.t, async (tx) => {
    const j = await tx.selectFrom('export_jobs').select(['id', 'status', 'storage_key', 'filename', 'expires_at', 'requested_by']).where('id', '=', claims.d).executeTakeFirst();
    if (!j || j.status !== 'succeeded' || !j.storage_key || (j.expires_at && j.expires_at < new Date())) return null;
    await audit(tx, null, { tenantId: claims.t, actorUserId: j.requested_by, action: 'export.downloaded', entityType: 'export_job', entityId: j.id });
    return j;
  });
  if (!job) throw gone();
  const data = await app.storage.get(job.storage_key!);
  return reply
    .header('content-type', 'text/csv; charset=utf-8')
    .header('content-disposition', `attachment; filename="${(job.filename ?? 'export.csv').replace(/[^\w.-]/g, '_')}"`)
    .header('x-content-type-options', 'nosniff')
    .header('cache-control', 'private, no-store')
    .send(data);
}
