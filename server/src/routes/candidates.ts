import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { z } from 'zod';
import { agencyIdOf, candidateVisible, hasAny, redactCandidate, vacancyVisible, applicationSourcedBy, isRecruiterOnly } from '../access.js';
import { principal } from '../app.js';
import { audit } from '../audit.js';
import { withTenant, type Tx } from '../db.js';
import { AppError, forbidden, notFound } from '../errors.js';
import { candidateOwner, lockContacts } from '../ownership.js';
import { can, requirePermission, type Principal } from '../permissions.js';
import { resumeLimit } from '../limits.js';
import { sendExport } from './exports.js';
import { detectResumeType, signFileToken, verifyFileToken } from '../storage.js';
import { normalizePhone, phoneSchema } from '../phone.js';
import { pageQuery, publicRateLimit } from './common.js';

// Shape has no defaults, so a partial update only touches the fields it sends. (Zod applies
// defaults even inside .partial(), which would wipe fields on every PATCH.)
const candidateShape = {
  full_name: z.string().trim().min(2).max(200),
  email: z.email().trim().toLowerCase().nullable(),
  phone: phoneSchema.nullable(),
  city: z.string().trim().max(120).nullable(),
  current_title: z.string().trim().max(200).nullable(),
  total_experience_years: z.number().min(0).max(60).nullable(),
  current_ctc: z.number().min(0).max(1e11).nullable(),
  expected_ctc: z.number().min(0).max(1e11).nullable(),
  notice_period_days: z.number().int().min(0).max(365).nullable(),
  skills: z.array(z.string().trim().min(1).max(60)).max(50),
  profile_summary: z.string().trim().max(5000).nullable(),
};

const CreateBody = z
  .object({
    ...candidateShape,
    email: candidateShape.email.default(null),
    phone: candidateShape.phone.default(null),
    city: candidateShape.city.default(null),
    current_title: candidateShape.current_title.default(null),
    total_experience_years: candidateShape.total_experience_years.default(null),
    current_ctc: candidateShape.current_ctc.default(null),
    expected_ctc: candidateShape.expected_ctc.default(null),
    notice_period_days: candidateShape.notice_period_days.default(null),
    skills: candidateShape.skills.default([]),
    profile_summary: candidateShape.profile_summary.default(null),
  })
  .refine((b) => b.email || b.phone, {
    path: ['email'],
    message: 'Add an email or a phone number so duplicates can be detected.',
  });
const UpdateBody = z.object(candidateShape).partial().refine((b) => Object.keys(b).length > 0, 'Provide at least one field to update.');
const DuplicateCheckBody = z.object({
  full_name: z.string().trim().max(200).default(''),
  email: z.email().trim().toLowerCase().nullish(),
  phone: phoneSchema.nullish(),
});

const ListQuery = pageQuery.extend({
  q: z.string().trim().max(200).optional(),
  city: z.string().trim().max(120).optional(),
  skills: z.string().trim().max(500).optional(), // comma-separated, all must match
  min_experience: z.coerce.number().min(0).max(60).optional(),
  max_experience: z.coerce.number().min(0).max(60).optional(),
  max_notice_days: z.coerce.number().int().min(0).max(365).optional(),
  vacancy_id: z.uuid().optional(),
  stage_id: z.uuid().optional(),
});

const MergeBody = z.object({ source_candidate_id: z.uuid(), reason: z.string().trim().min(1).max(500) });
const NoteBody = z.object({ body: z.string().trim().min(1).max(10_000), application_id: z.uuid().nullish() });
const DocParams = z.object({ id: z.uuid(), docId: z.uuid() });
const IdParams = z.object({ id: z.uuid() });

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
const PUBLIC_FIELDS = ['c.id', 'c.full_name', 'c.city', 'c.current_title', 'c.total_experience_years', 'c.status'] as const;

/**
 * Exact matches (same email or E.164 phone) block creation; similar names are only a warning.
 * Matches the principal cannot see are reported without any details.
 */
async function findDuplicates(
  tx: Tx,
  p: Principal,
  input: { full_name?: string; email?: string | null; phone?: string | null },
  excludeId?: string,
) {
  const visibleToAll = p.permissions['candidates.view'] === 'all';
  const contactOrs = [];
  let exactQ = tx.selectFrom('candidates as c').select([...PUBLIC_FIELDS, 'c.email', 'c.phone']).where('c.status', '=', 'active');
  if (input.email) contactOrs.push('email');
  if (input.phone) contactOrs.push('phone');
  const exact = contactOrs.length
    ? await exactQ
        .where((eb) => eb.or([
          ...(input.email ? [eb('c.email', '=', input.email)] : []),
          ...(input.phone ? [eb('c.phone', '=', input.phone)] : []),
        ]))
        .$if(!!excludeId, (q) => q.where('c.id', '<>', excludeId!))
        .limit(5)
        .execute()
    : [];

  const exactIds = new Set(exact.map((e) => e.id));
  const possible = input.full_name && input.full_name.length >= 3
    ? (await tx
        .selectFrom('candidates as c')
        .select([...PUBLIC_FIELDS, sql<number>`similarity(c.full_name, ${input.full_name})`.as('score')])
        .where('c.status', '=', 'active')
        .where(sql<boolean>`similarity(c.full_name, ${input.full_name}) > 0.45`)
        .$if(!!excludeId, (q) => q.where('c.id', '<>', excludeId!))
        .orderBy('score', 'desc')
        .limit(5)
        .execute()).filter((c) => !exactIds.has(c.id))
    : [];

  const describe = (c: { id: string; full_name: string; city: string | null; current_title: string | null; total_experience_years: number | null }, reason: string) =>
    visibleToAll
      ? { id: c.id, full_name: c.full_name, city: c.city, current_title: c.current_title, total_experience_years: c.total_experience_years, match_reason: reason }
      : { id: null, hidden: true, match_reason: reason };

  return {
    exact: exact.map((c) => describe(c, input.email && c.email === input.email ? 'same_email' : 'same_phone')),
    possible: possible.map((c) => describe(c, 'similar_name')),
  };
}

async function loadVisibleCandidate(tx: Tx, p: Principal, id: string, agencyId: string | null) {
  const c = await tx.selectFrom('candidates as c').selectAll('c').where('c.id', '=', id).where(candidateVisible(p, agencyId)).executeTakeFirst();
  if (!c) throw notFound('Candidate');
  return c;
}

async function candidateProfile(tx: Tx, p: Principal, id: string) {
  const agencyId = await agencyIdOf(tx, p.userId);
  const c = await loadVisibleCandidate(tx, p, id, agencyId);

  const documents = await tx
    .selectFrom('candidate_documents as d')
    .leftJoin('users as u', 'u.id', 'd.uploaded_by')
    .select(['d.id', 'd.document_type', 'd.original_filename', 'd.mime_type', 'd.size_bytes', 'd.scan_status', 'd.created_at', 'u.full_name as uploaded_by_name'])
    .where('d.candidate_id', '=', id)
    .orderBy('d.created_at', 'desc')
    .execute();

  // Only applications to vacancies this principal can see.
  const applications = await tx
    .selectFrom('applications as a')
    .innerJoin('vacancies as v', 'v.id', 'a.vacancy_id')
    .innerJoin('requisitions as rq', 'rq.id', 'v.requisition_id')
    .innerJoin('pipeline_stages as s', 's.id', 'a.stage_id')
    .leftJoin('job_roles as jr', 'jr.id', 'a.job_role_id')
    .select([
      'jr.name as job_role_name', 'a.id', 'a.sourcing_code', 'a.temp_employee_code', 'a.status', 'a.stage_id', 's.name as stage_name', 's.code as stage_code', 'a.stage_changed_at',
      'a.disposition_reason', 'a.created_at', 'v.id as vacancy_id', 'v.vacancy_code', 'v.title as vacancy_title', 'v.status as vacancy_status',
    ])
    .where('a.candidate_id', '=', id)
    .where(vacancyVisible(p, agencyId))
    .where(applicationSourcedBy(p))
    .orderBy('a.created_at', 'desc')
    .execute();

  const submissions = await tx
    .selectFrom('submissions as s')
    .innerJoin('applications as a', 'a.id', 's.application_id')
    .innerJoin('vacancies as v', 'v.id', 'a.vacancy_id')
    .innerJoin('requisitions as rq', 'rq.id', 'v.requisition_id')
    .leftJoin('users as su', 'su.id', 's.source_user_id')
    .leftJoin('agencies as ag', 'ag.id', 's.agency_id')
    .select([
      's.id', 's.source_type', 's.submitted_at', 's.ownership_state', 's.source_reference', 'v.vacancy_code',
      'su.full_name as submitted_by_name', 'ag.name as agency_name', 's.agency_id',
    ])
    .where('a.candidate_id', '=', id)
    .where(vacancyVisible(p, agencyId))
    .where(applicationSourcedBy(p))
    .$if(!!agencyId, (q) => q.where('s.agency_id', '=', agencyId!))
    .orderBy('s.submitted_at', 'desc')
    .execute();

  const notes = agencyId
    ? []
    : await tx
        .selectFrom('candidate_notes as n')
        .innerJoin('users as u', 'u.id', 'n.created_by')
        .select(['n.id', 'n.body', 'n.application_id', 'n.created_at', 'u.full_name as created_by_name'])
        .where('n.candidate_id', '=', id)
        .orderBy('n.created_at', 'desc')
        .execute();

  // Credit for sourcing goes to whoever submitted the candidate first, automatically and for good.
  const owner = await candidateOwner(tx, id);
  const ownerAgency = owner.agencyId
    ? await tx.selectFrom('agencies').select(['id', 'name']).where('id', '=', owner.agencyId).executeTakeFirst()
    : null;

  return {
    ...redactCandidate(p, c, agencyId),
    sourced_by: ownerAgency ? { kind: 'agency' as const, id: ownerAgency.id, name: ownerAgency.name } : { kind: 'company' as const, id: null, name: 'Company (internal)' },
    documents,
    applications,
    submissions,
    notes,
    can: {
      edit: can(p, 'candidates.manage') && c.status === 'active',
      view_contact: hasAny(p, 'candidates.view_contact') || !!agencyId,
      view_compensation: hasAny(p, 'candidates.view_compensation'),
      // Resumes come in at sourcing; on the profile only the recruiter who added the candidate may add one.
      upload: can(p, 'candidates.manage') && c.status === 'active' && isRecruiterOnly(p),
      add_to_vacancy: hasAny(p, 'applications.manage') && c.status === 'active',
      merge: can(p, 'candidates.manage') && c.status === 'active',
    },
  };
}

export async function candidateRoutes(app: FastifyInstance) {
  const { db, config } = app;

  app.get('/candidates', async (req) => {
    const p = principal(req);
    if (!hasAny(p, 'candidates.view')) throw forbidden();
    const f = ListQuery.parse(req.query);
    return withTenant(db, p.tenantId, async (tx) => {
      const agencyId = await agencyIdOf(tx, p.userId);
      let base = tx.selectFrom('candidates as c').where('c.status', '=', 'active').where(candidateVisible(p, agencyId));
      if (f.q) {
        const like = `%${escapeLike(f.q)}%`;
        const contact = hasAny(p, 'candidates.view_contact');
        const phone = contact ? normalizePhone(f.q) : null;
        base = base.where((eb) => eb.or([
          eb('c.full_name', 'ilike', like),
          sql<boolean>`similarity(c.full_name, ${f.q}) > 0.3`,
          eb('c.current_title', 'ilike', like),
          sql<boolean>`EXISTS (SELECT 1 FROM unnest(c.skills) sk WHERE sk ILIKE ${like})`,
          ...(contact ? [eb('c.email', 'ilike', like)] : []),
          ...(phone ? [eb('c.phone', '=', phone)] : []),
        ]));
      }
      if (f.city) base = base.where(sql`lower(c.city)`, '=', f.city.toLowerCase());
      if (f.skills) {
        const skills = f.skills.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
        for (const skill of skills) {
          base = base.where(sql<boolean>`EXISTS (SELECT 1 FROM unnest(c.skills) sk WHERE lower(sk) = ${skill})`);
        }
      }
      if (f.min_experience !== undefined) base = base.where('c.total_experience_years', '>=', f.min_experience);
      if (f.max_experience !== undefined) base = base.where('c.total_experience_years', '<=', f.max_experience);
      if (f.max_notice_days !== undefined) base = base.where('c.notice_period_days', '<=', f.max_notice_days);
      if (f.vacancy_id || f.stage_id) {
        base = base.where((eb) => eb.exists(
          eb.selectFrom('applications as fa').select('fa.id').whereRef('fa.candidate_id', '=', 'c.id')
            .$if(!!f.vacancy_id, (q) => q.where('fa.vacancy_id', '=', f.vacancy_id!))
            .$if(!!f.stage_id, (q) => q.where('fa.stage_id', '=', f.stage_id!)),
        ));
      }

      const { total } = await base.select(sql<number>`count(*)::int`.as('total')).executeTakeFirstOrThrow();
      const rows = await base
        .select((eb) => [
          'c.id', 'c.full_name', 'c.email', 'c.phone', 'c.city', 'c.current_title', 'c.total_experience_years',
          'c.notice_period_days', 'c.skills', 'c.current_ctc', 'c.expected_ctc', 'c.created_at',
          eb.selectFrom('applications as a').select(sql<number>`count(*)::int`.as('n'))
            .whereRef('a.candidate_id', '=', 'c.id').where('a.status', '=', 'active').as('active_applications'),
        ])
        .$if(!!f.q, (q) => q.orderBy(sql`similarity(c.full_name, ${f.q!})`, 'desc'))
        .orderBy('c.created_at', 'desc')
        .limit(f.page_size)
        .offset((f.page - 1) * f.page_size)
        .execute();
      return { data: rows.map((r) => redactCandidate(p, r, agencyId)), page: f.page, page_size: f.page_size, total };
    });
  });

  app.post('/candidates/duplicate-check', async (req) => {
    const p = principal(req);
    requirePermission(p, 'candidates.manage');
    const body = DuplicateCheckBody.parse(req.body);
    return { data: await withTenant(db, p.tenantId, (tx) => findDuplicates(tx, p, body)) };
  });

  app.post('/candidates', async (req, reply) => {
    const p = principal(req);
    requirePermission(p, 'candidates.manage');
    const body = CreateBody.parse(req.body);
    if ((body.current_ctc != null || body.expected_ctc != null) && !hasAny(p, 'candidates.view_compensation')) {
      throw new AppError(403, 'FORBIDDEN', 'You cannot set compensation fields.');
    }

    const profile = await withTenant(db, p.tenantId, async (tx) => {
      // Two people adding the same email or phone at once must not both succeed.
      await lockContacts(tx, p.tenantId, body.email, body.phone);
      const dups = await findDuplicates(tx, p, body);
      if (dups.exact.length > 0) {
        throw new AppError(409, 'DUPLICATE_CANDIDATE', 'A candidate with this email or phone already exists.', dups);
      }
      const c = await tx
        .insertInto('candidates')
        .values({ ...body, tenant_id: p.tenantId, created_by: p.userId })
        .returning('id')
        .executeTakeFirstOrThrow();
      await audit(tx, req, {
        tenantId: p.tenantId, actorUserId: p.userId, action: 'candidate.created', entityType: 'candidate', entityId: c.id,
        metadata: { possible_duplicates: dups.possible.map((d) => d.id).filter(Boolean) },
      });
      return candidateProfile(tx, p, c.id);
    });
    return reply.status(201).send({ data: profile });
  });

  app.get('/candidates/:id', async (req) => {
    const p = principal(req);
    if (!hasAny(p, 'candidates.view')) throw forbidden();
    const { id } = IdParams.parse(req.params);
    return { data: await withTenant(db, p.tenantId, (tx) => candidateProfile(tx, p, id)) };
  });

  app.patch('/candidates/:id', async (req) => {
    const p = principal(req);
    requirePermission(p, 'candidates.manage');
    const { id } = IdParams.parse(req.params);
    const body = UpdateBody.parse(req.body);
    if (('email' in body || 'phone' in body) && !hasAny(p, 'candidates.view_contact')) throw forbidden();
    if (('current_ctc' in body || 'expected_ctc' in body) && !hasAny(p, 'candidates.view_compensation')) throw forbidden();

    const profile = await withTenant(db, p.tenantId, async (tx) => {
      const agencyId = await agencyIdOf(tx, p.userId);
      const current = await loadVisibleCandidate(tx, p, id, agencyId);
      if (current.status !== 'active') throw new AppError(409, 'NOT_EDITABLE', 'Merged or archived candidates cannot be edited.');
      if ((body.email && body.email !== current.email) || (body.phone && body.phone !== current.phone)) {
        const dups = await findDuplicates(tx, p, { email: body.email, phone: body.phone }, id);
        if (dups.exact.length > 0) {
          throw new AppError(409, 'DUPLICATE_CANDIDATE', 'Another candidate already has this email or phone.', dups);
        }
      }
      const email = body.email !== undefined ? body.email : current.email;
      const phone = body.phone !== undefined ? body.phone : current.phone;
      if (!email && !phone) throw new AppError(422, 'CONTACT_REQUIRED', 'Keep at least an email or a phone number.');
      await tx.updateTable('candidates').set(body).where('id', '=', id).execute();
      await audit(tx, req, {
        tenantId: p.tenantId, actorUserId: p.userId, action: 'candidate.updated', entityType: 'candidate', entityId: id,
        metadata: { fields: Object.keys(body) },
      });
      return candidateProfile(tx, p, id);
    });
    return { data: profile };
  });

  app.post('/candidates/:id/notes', async (req, reply) => {
    const p = principal(req);
    if (!hasAny(p, 'candidates.view')) throw forbidden();
    const { id } = IdParams.parse(req.params);
    const body = NoteBody.parse(req.body);
    const note = await withTenant(db, p.tenantId, async (tx) => {
      const agencyId = await agencyIdOf(tx, p.userId);
      if (agencyId) throw forbidden(); // Internal notes are not shared with agencies.
      await loadVisibleCandidate(tx, p, id, agencyId);
      if (body.application_id) {
        const app = await tx.selectFrom('applications').select('id').where('id', '=', body.application_id).where('candidate_id', '=', id).executeTakeFirst();
        if (!app) throw new AppError(422, 'INVALID_APPLICATION', 'That application does not belong to this candidate.');
      }
      const row = await tx
        .insertInto('candidate_notes')
        .values({ tenant_id: p.tenantId, candidate_id: id, application_id: body.application_id ?? null, body: body.body, created_by: p.userId })
        .returning(['id', 'body', 'application_id', 'created_at'])
        .executeTakeFirstOrThrow();
      await audit(tx, req, {
        tenantId: p.tenantId, actorUserId: p.userId, action: 'candidate.note_added', entityType: 'candidate', entityId: id,
        metadata: { note_id: row.id },
      });
      return { ...row, created_by_name: p.fullName };
    });
    return reply.status(201).send({ data: note });
  });

  // ---- Documents ----------------------------------------------------------

  app.post('/candidates/:id/documents', async (req, reply) => {
    const p = principal(req);
    requirePermission(p, 'candidates.manage');
    const { id } = IdParams.parse(req.params);

    const maxBytes = await withTenant(db, p.tenantId, async (tx) => {
      await loadVisibleCandidate(tx, p, id, await agencyIdOf(tx, p.userId));
      const s = await tx.selectFrom('tenant_settings').select('resume_max_bytes').executeTakeFirst();
      return resumeLimit(s?.resume_max_bytes);
    });

    const part = await req.file({ limits: { fileSize: maxBytes, files: 1 } });
    if (!part) throw new AppError(400, 'FILE_REQUIRED', 'Attach a file.');
    const data = await part.toBuffer().catch((err: { code?: string }) => {
      if (err.code === 'FST_REQ_FILE_TOO_LARGE') {
        throw new AppError(413, 'FILE_TOO_LARGE', `Files can be up to ${Math.round(maxBytes / 1024 / 1024)} MB.`);
      }
      throw err;
    });
    const docTypeField = part.fields.document_type;
    const docTypeValue = docTypeField && 'value' in docTypeField ? String(docTypeField.value) : 'resume';
    const documentType = z.enum(['resume', 'cover_letter', 'other']).parse(docTypeValue);
    const filename = part.filename.replace(/[^\w.\- ()]/g, '_').slice(-150) || 'document';

    const type = detectResumeType(filename, data);
    if (!type) throw new AppError(415, 'UNSUPPORTED_FILE', 'Upload a PDF, DOC or DOCX file.');
    if (data.length === 0) throw new AppError(400, 'FILE_REQUIRED', 'The file is empty.');

    const verdict = await app.scanner.scan(data);
    if (verdict !== 'clean') {
      await withTenant(db, p.tenantId, (tx) =>
        audit(tx, req, {
          tenantId: p.tenantId, actorUserId: p.userId, action: 'candidate.document_rejected', entityType: 'candidate', entityId: id,
          metadata: { filename, verdict },
        }));
      throw new AppError(422, 'FILE_REJECTED', verdict === 'infected' ? 'This file failed the security scan and was not saved.' : 'The file could not be scanned. Try again.');
    }

    const storageKey = `${p.tenantId}/candidates/${id}/${randomUUID()}`;
    await app.storage.put(storageKey, data, type.mime);
    const doc = await withTenant(db, p.tenantId, async (tx) => {
      const row = await tx
        .insertInto('candidate_documents')
        .values({
          tenant_id: p.tenantId,
          candidate_id: id,
          document_type: documentType,
          storage_key: storageKey,
          original_filename: filename,
          mime_type: type.mime,
          size_bytes: data.length,
          sha256: createHash('sha256').update(data).digest('hex'),
          scan_status: 'clean',
          uploaded_by: p.userId,
        })
        .returning(['id', 'document_type', 'original_filename', 'mime_type', 'size_bytes', 'scan_status', 'created_at'])
        .executeTakeFirstOrThrow();
      await audit(tx, req, {
        tenantId: p.tenantId, actorUserId: p.userId, action: 'candidate.document_uploaded', entityType: 'candidate', entityId: id,
        metadata: { document_id: row.id, filename, size_bytes: data.length },
      });
      return row;
    });
    return reply.status(201).send({ data: doc });
  });

  // Issues a short-lived signed link. The storage key is never exposed.
  app.post('/candidates/:id/documents/:docId/download-url', async (req) => {
    const p = principal(req);
    if (!hasAny(p, 'candidates.view')) throw forbidden();
    const { id, docId } = DocParams.parse(req.params);
    const expiresAt = new Date(Date.now() + config.FILE_URL_TTL_SECONDS * 1000);
    await withTenant(db, p.tenantId, async (tx) => {
      await loadVisibleCandidate(tx, p, id, await agencyIdOf(tx, p.userId));
      const doc = await tx.selectFrom('candidate_documents').select('scan_status').where('id', '=', docId).where('candidate_id', '=', id).executeTakeFirst();
      if (!doc) throw notFound('Document');
      if (doc.scan_status !== 'clean') throw new AppError(409, 'NOT_AVAILABLE', 'This file is not available for download.');
      await audit(tx, req, {
        tenantId: p.tenantId, actorUserId: p.userId, action: 'candidate.document_link_issued', entityType: 'candidate', entityId: id,
        metadata: { document_id: docId },
      });
    });
    const token = signFileToken(config.FILE_URL_SECRET, { t: p.tenantId, d: docId, e: Math.floor(expiresAt.getTime() / 1000) });
    return { data: { url: `/api/v1/files/${token}`, expires_at: expiresAt } };
  });

  // ---- Merge ---------------------------------------------------------------

  // Merges source into :id (the target). The source is kept as 'merged' with a snapshot.
  app.post('/candidates/:id/merge', async (req) => {
    const p = principal(req);
    requirePermission(p, 'candidates.manage');
    requirePermission(p, 'candidates.view');
    const { id } = IdParams.parse(req.params);
    const { source_candidate_id: sourceId, reason } = MergeBody.parse(req.body);
    if (sourceId === id) throw new AppError(422, 'SAME_CANDIDATE', 'Choose a different candidate to merge.');

    const profile = await withTenant(db, p.tenantId, async (tx) => {
      const rows = await tx.selectFrom('candidates').selectAll().where('id', 'in', [id, sourceId]).orderBy('id').forUpdate().execute();
      const target = rows.find((r) => r.id === id);
      const source = rows.find((r) => r.id === sourceId);
      if (!target || !source) throw notFound('Candidate');
      if (target.status !== 'active' || source.status !== 'active') {
        throw new AppError(409, 'NOT_ACTIVE', 'Both candidates must be active to merge.');
      }
      const conflict = await tx
        .selectFrom('applications as s')
        .innerJoin('applications as t', (j) => j.onRef('t.vacancy_id', '=', 's.vacancy_id'))
        .select('s.vacancy_id')
        .where('s.candidate_id', '=', sourceId)
        .where('t.candidate_id', '=', id)
        .where('s.status', '=', 'active')
        .where('t.status', '=', 'active')
        .executeTakeFirst();
      if (conflict) {
        throw new AppError(409, 'MERGE_CONFLICT', 'Both candidates have an active application to the same vacancy. Close one first.');
      }

      await tx.updateTable('applications').set({ candidate_id: id }).where('candidate_id', '=', sourceId).execute();
      await tx.updateTable('candidate_documents').set({ candidate_id: id }).where('candidate_id', '=', sourceId).execute();
      await tx.updateTable('candidate_notes').set({ candidate_id: id }).where('candidate_id', '=', sourceId).execute();
      // Fill gaps on the target from the source; never overwrite the target's own values.
      const fill: Record<string, unknown> = {};
      for (const key of ['email', 'phone', 'city', 'current_title', 'total_experience_years', 'current_ctc', 'expected_ctc', 'notice_period_days', 'profile_summary'] as const) {
        if (target[key] == null && source[key] != null) fill[key] = source[key];
      }
      const skills = [...new Set([...target.skills, ...source.skills])];
      // Clear the source's contact first: the target may take them over.
      await tx.updateTable('candidates').set({ status: 'merged', merged_into_candidate_id: id }).where('id', '=', sourceId).execute();
      await tx.updateTable('candidates').set({ ...fill, skills }).where('id', '=', id).execute();
      await tx
        .insertInto('candidate_merges')
        .values({
          tenant_id: p.tenantId,
          source_candidate_id: sourceId,
          target_candidate_id: id,
          match_reason: reason,
          source_snapshot: JSON.stringify(source),
          merged_by: p.userId,
        })
        .execute();
      await audit(tx, req, {
        tenantId: p.tenantId, actorUserId: p.userId, action: 'candidate.merged', entityType: 'candidate', entityId: id,
        metadata: { source_candidate_id: sourceId, reason, filled: Object.keys(fill) },
      });
      return candidateProfile(tx, p, id);
    });
    return { data: profile };
  });
}

/** Public: serves a file for a valid signed link. No session; the signature is the authorization. */
export async function fileRoutes(app: FastifyInstance) {
  const { db, config } = app;
  app.get('/files/:token', { config: publicRateLimit(60) }, async (req, reply) => {
    const { token } = z.object({ token: z.string().max(1000) }).parse(req.params);
    const claims = verifyFileToken(config.FILE_URL_SECRET, token);
    if (!claims) throw new AppError(410, 'LINK_INVALID', 'This download link is invalid or has expired.');
    if (claims.x === 'export') return sendExport(app, claims, reply);
    const doc = await withTenant(db, claims.t, (tx) =>
      tx.selectFrom('candidate_documents').select(['storage_key', 'original_filename', 'mime_type', 'scan_status']).where('id', '=', claims.d).executeTakeFirst());
    if (!doc || doc.scan_status !== 'clean') throw new AppError(410, 'LINK_INVALID', 'This download link is invalid or has expired.');
    const data = await app.storage.get(doc.storage_key);
    const asciiName = doc.original_filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
    // ?view=1 opens a PDF in the browser's viewer instead of downloading it. Word files cannot be
    // shown by browsers, so they still download.
    const view = (req.query as { view?: string }).view === '1' && doc.mime_type === 'application/pdf';
    return reply
      .header('content-type', doc.mime_type)
      .header('content-disposition', `${view ? 'inline' : 'attachment'}; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(doc.original_filename)}`)
      .header('x-content-type-options', 'nosniff')
      .header('cache-control', 'private, no-store')
      .send(data);
  });
}
