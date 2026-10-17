// The agency portal. Agency users reach nothing else: their roles hold no internal permissions,
// and every query here is scoped to the caller's own agency. Agencies see only what they submitted
// (from a stored copy of their submission) and never the canonical candidate record, which may
// hold details from other sources.
import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { sql } from 'kysely';
import { z } from 'zod';
import { principal } from '../app.js';
import { audit } from '../audit.js';
import { pgConstraint, pgErrorCode, withTenant, type Tx } from '../db.js';
import { AppError, forbidden, notFound } from '../errors.js';
import { agencyOwnershipView, existingJobSubmission, lockContacts, lockJobCandidate, logDuplicateAttempt, recordOwnershipEvent } from '../ownership.js';
import { requirePermission, type Principal } from '../permissions.js';
import { resumeLimit } from '../limits.js';
import { notifyUser } from '../notifications.js';
import { detectResumeType, signFileToken } from '../storage.js';
import { pageQuery } from './common.js';
import { phoneSchema } from '../phone.js';

const DECLARATIONS = {
  agency_database: "Found in the agency's own database or search",
  candidate_applied: 'The candidate applied to the agency directly',
  referral: 'Referred to the agency',
  job_board: 'Found on a job board',
  other: 'Other',
} as const;

const Payload = z
  .object({
    full_name: z.string().trim().min(2).max(200),
    email: z.email().trim().toLowerCase().nullable().default(null),
    phone: phoneSchema.nullable().default(null),
    current_title: z.string().trim().max(200).nullable().default(null),
    city: z.string().trim().max(120).nullable().default(null),
    total_experience_years: z.number().min(0).max(60).nullable().default(null),
    notice_period_days: z.number().int().min(0).max(365).nullable().default(null),
    skills: z.array(z.string().trim().min(1).max(60)).max(50).default([]),
    profile_summary: z.string().trim().max(5000).nullable().default(null),
    source_declaration: z.enum(Object.keys(DECLARATIONS) as [keyof typeof DECLARATIONS, ...(keyof typeof DECLARATIONS)[]]),
    notes: z.string().trim().max(2000).nullable().default(null),
    consent_confirmed: z.literal(true, { error: 'Confirm that the candidate agreed to be submitted.' }),
  })
  .refine((b) => b.email || b.phone, { path: ['email'], message: 'Add an email or a phone number.' });

const IdParams = z.object({ id: z.uuid() });
const ListQuery = pageQuery.extend({ vacancy_id: z.uuid().optional() });

interface AgencyContext {
  agencyId: string;
  agencyName: string;
  role: 'admin' | 'recruiter';
}

/** The caller's agency. Refuses non-agency users and members of inactive agencies. */
async function agencyContext(tx: Tx, p: Principal): Promise<AgencyContext> {
  requirePermission(p, 'agency_portal.use');
  const m = await tx
    .selectFrom('agency_members as m')
    .innerJoin('agencies as a', 'a.id', 'm.agency_id')
    .select(['m.agency_id', 'm.agency_role', 'a.name', 'a.status'])
    .where('m.user_id', '=', p.userId)
    .executeTakeFirst();
  if (!m) throw forbidden();
  if (m.status !== 'active') throw new AppError(403, 'AGENCY_INACTIVE', 'Your agency account is not active. Contact the hiring team.');
  return { agencyId: m.agency_id, agencyName: m.name, role: m.agency_role };
}

/** Assigned vacancies, still open to the agency. Another agency's vacancy is simply not found. */
function assignedVacancies(tx: Tx, agencyId: string) {
  return tx
    .selectFrom('vacancy_agencies as va')
    .innerJoin('vacancies as v', 'v.id', 'va.vacancy_id')
    .innerJoin('requisitions as rq', 'rq.id', 'v.requisition_id')
    .where('va.agency_id', '=', agencyId)
    .where('va.status', '=', 'active')
    .where('v.status', 'in', ['open', 'on_hold']);
}

/** An agency recruiter sees their own submissions; an agency admin sees the whole agency's. */
function ownSubmissions(tx: Tx, p: Principal, ctx: AgencyContext) {
  let q = tx
    .selectFrom('submissions as s')
    .innerJoin('applications as a', 'a.id', 's.application_id')
    .innerJoin('vacancies as v', 'v.id', 'a.vacancy_id')
    .innerJoin('pipeline_stages as st', 'st.id', 'a.stage_id')
    .where('s.agency_id', '=', ctx.agencyId)
    .where('s.source_type', '=', 'agency');
  if (ctx.role === 'recruiter') q = q.where('s.source_user_id', '=', p.userId);
  return q;
}

function presentSubmission(r: {
  id: string; submitted_at: Date; ownership_state: Parameters<typeof agencyOwnershipView>[0];
  submitted_profile: Record<string, unknown> | null; vacancy_id: string; vacancy_code: string; vacancy_title: string;
  stage_name: string; app_status: string; resume_document_id: string | null; submitted_by_name?: string | null;
}) {
  const profile = (r.submitted_profile ?? {}) as Record<string, unknown>;
  return {
    id: r.id,
    submitted_at: r.submitted_at,
    candidate_name: profile.full_name ?? null,
    current_title: profile.current_title ?? null,
    city: profile.city ?? null,
    email: profile.email ?? null,
    phone: profile.phone ?? null,
    vacancy: { id: r.vacancy_id, code: r.vacancy_code, title: r.vacancy_title },
    // A rejected duplicate shares its application with whoever sourced the candidate first, so the
    // stage is theirs to see, not this agency's.
    stage: r.ownership_state === 'rejected' ? null : r.stage_name,
    application_status: r.ownership_state === 'rejected' ? null : r.app_status,
    ownership: agencyOwnershipView(r.ownership_state),
    has_resume: r.resume_document_id !== null,
    ...(r.submitted_by_name !== undefined ? { submitted_by: r.submitted_by_name } : {}),
  };
}

const SUBMISSION_COLUMNS = [
  's.id', 's.submitted_at', 's.ownership_state', 's.submitted_profile', 's.resume_document_id',
  'a.id as application_id', 'a.vacancy_id', 'v.vacancy_code', 'v.title as vacancy_title', 'st.name as stage_name', 'a.status as app_status',
] as const;

/**
 * What an agency may know about how its candidates are doing: the interview's state and whether feedback
 * is in (never the ratings or notes), and whether the person joined or left. Only for its own submissions.
 */
async function progressOf(tx: Tx, rows: { application_id: string; ownership_state: string }[]) {
  const ids = rows.filter((r) => r.ownership_state !== 'rejected').map((r) => r.application_id);
  const out = new Map<string, { interview: string | null; interview_at: Date | null; feedback: 'Pending' | 'Submitted' | null; employment: 'Joined' | 'Exited' | null }>();
  if (ids.length === 0) return out;
  const interviews = await tx.selectFrom('interviews').select(['id', 'application_id', 'status', 'scheduled_start', 'created_at']).where('application_id', 'in', ids).where('status', '<>', 'cancelled').orderBy('created_at', 'desc').execute();
  const members = interviews.length ? await tx.selectFrom('interviewers').select(['interview_id', 'feedback_status']).where('interview_id', 'in', interviews.map((i) => i.id)).execute() : [];
  const jobs = await tx.selectFrom('employment_records').select(['application_id', 'status']).where('application_id', 'in', ids).execute();
  for (const id of ids) {
    const iv = interviews.find((i) => i.application_id === id);
    const mine = iv ? members.filter((m) => m.interview_id === iv.id && m.feedback_status !== 'waived') : [];
    const label = !iv ? null : iv.status === 'draft' ? 'To be scheduled' : iv.status === 'completed' ? 'Completed' : iv.scheduled_start && iv.scheduled_start < new Date() ? 'Held' : 'Scheduled';
    const emp = jobs.find((j) => j.application_id === id);
    out.set(id, {
      interview: label, interview_at: iv && iv.status !== 'draft' ? iv.scheduled_start : null,
      feedback: iv && iv.status !== 'draft' && mine.length ? (mine.every((m) => m.feedback_status === 'submitted') ? 'Submitted' : 'Pending') : null,
      employment: emp ? (emp.status === 'active' ? 'Joined' : 'Exited') : null,
    });
  }
  return out;
}

const DUPLICATE_MESSAGE = 'This candidate was already submitted for this job, so the original submission keeps ownership. Your attempt has been recorded.';

/** Active candidates already in the database with this email or phone. */
async function existingMatches(tx: Tx, body: { email: string | null; phone: string | null }) {
  return tx
    .selectFrom('candidates')
    .select(['id'])
    .where('status', '=', 'active')
    .where((eb) => eb.or([...(body.email ? [eb('email', '=', body.email)] : []), ...(body.phone ? [eb('phone', '=', body.phone)] : [])]))
    .orderBy((eb) => eb.case().when('email', '=', body.email ?? '').then(0).else(1).end())
    .orderBy('created_at')
    .execute();
}

/**
 * First submission wins, per job: a candidate who already has an active application on this job is a
 * duplicate, whoever submitted them first (including this agency). The same candidate on a different job
 * is a new submission. Returns the matched candidate and the owner it collided with.
 */
async function duplicateOnJob(tx: Tx, vacancyId: string, matches: { id: string }[]) {
  for (const m of matches) {
    const owner = await existingJobSubmission(tx, m.id, vacancyId);
    if (owner) return { candidateId: m.id, owner };
  }
  return null;
}

export async function agencyPortalRoutes(app: FastifyInstance) {
  const { db, config } = app;

  app.get('/agency/home', async (req) => {
    const p = principal(req);
    return withTenant(db, p.tenantId, async (tx) => {
      const ctx = await agencyContext(tx, p);
      const vacancies = await assignedVacancies(tx, ctx.agencyId).select(sql<number>`count(*)::int`.as('n')).executeTakeFirstOrThrow();
      const rows = await ownSubmissions(tx, p, ctx).select(SUBMISSION_COLUMNS).orderBy('s.submitted_at', 'desc').limit(500).execute();
      const progress = await progressOf(tx, rows);
      const attempts = await tx.selectFrom('duplicate_attempts').select(sql<number>`count(*)::int`.as('n')).where('attempted_agency_id', '=', ctx.agencyId).executeTakeFirstOrThrow();
      return {
        data: {
          agency: { name: ctx.agencyName, role: ctx.role },
          open_vacancies: vacancies.n,
          submissions: {
            total: rows.length,
            credited: rows.filter((r) => r.ownership_state !== 'rejected').length,
            rejected_duplicates: rows.filter((r) => r.ownership_state === 'rejected').length + attempts.n,
          },
          in_pipeline: rows.filter((r) => r.ownership_state !== 'rejected' && r.app_status === 'active').length,
          recent: rows.slice(0, 5).map((r) => presentSubmission(r)),
          joined: [...progress.values()].filter((x) => x.employment === 'Joined').length,
        },
      };
    });
  });

  app.get('/agency/vacancies', async (req) => {
    const p = principal(req);
    return withTenant(db, p.tenantId, async (tx) => {
      const ctx = await agencyContext(tx, p);
      const rows = await assignedVacancies(tx, ctx.agencyId)
        .select((eb) => [
          'v.id', 'v.vacancy_code', 'v.title', 'v.location', 'v.headcount', 'v.status', 'rq.employment_type', 'rq.priority',
          eb.selectFrom('submissions as s').innerJoin('applications as a', 'a.id', 's.application_id')
            .select(sql<number>`count(*)::int`.as('n'))
            .whereRef('a.vacancy_id', '=', 'v.id').where('s.agency_id', '=', ctx.agencyId).where('s.source_type', '=', 'agency')
            .as('my_submissions'),
        ])
        .orderBy('v.opened_at', 'desc')
        .execute();
      return { data: rows };
    });
  });

  app.get('/agency/vacancies/:id', async (req) => {
    const p = principal(req);
    const { id } = IdParams.parse(req.params);
    return withTenant(db, p.tenantId, async (tx) => {
      const ctx = await agencyContext(tx, p);
      const v = await assignedVacancies(tx, ctx.agencyId)
        .select([
          'v.id', 'v.vacancy_code', 'v.title', 'v.location', 'v.headcount', 'v.status', 'rq.employment_type', 'rq.description',
          'rq.skills', 'rq.min_experience_years', 'rq.max_experience_years', 'rq.priority', 'va.ownership_policy',
        ])
        .where('v.id', '=', id)
        .executeTakeFirst();
      if (!v) throw notFound('Vacancy');
      const policy = (v.ownership_policy ?? {}) as { submission_notes?: string };
      const { ownership_policy: _omit, ...vacancy } = v;
      return {
        data: {
          ...vacancy,
          submission_policy: { notes: policy.submission_notes ?? null },
          can_submit: v.status === 'open',
        },
      };
    });
  });

  app.get('/agency/submissions', async (req) => {
    const p = principal(req);
    const f = ListQuery.parse(req.query);
    return withTenant(db, p.tenantId, async (tx) => {
      const ctx = await agencyContext(tx, p);
      let base = ownSubmissions(tx, p, ctx);
      if (f.vacancy_id) base = base.where('a.vacancy_id', '=', f.vacancy_id);
      const { total } = await base.select(sql<number>`count(*)::int`.as('total')).executeTakeFirstOrThrow();
      const rows = await base
        .leftJoin('users as su', 'su.id', 's.source_user_id')
        .select([...SUBMISSION_COLUMNS, 'su.full_name as submitted_by_name'])
        .orderBy('s.submitted_at', 'desc')
        .limit(f.page_size)
        .offset((f.page - 1) * f.page_size)
        .execute();
      const progress = await progressOf(tx, rows);
      return { data: rows.map((r) => ({ ...presentSubmission(r), progress: progress.get(r.application_id) ?? null })), page: f.page, page_size: f.page_size, total };
    });
  });

  // Short-lived signed link to the resume this agency itself submitted. Nothing else is reachable.
  app.post('/agency/submissions/:id/resume-url', async (req) => {
    const p = principal(req);
    const { id } = IdParams.parse(req.params);
    const expiresAt = new Date(Date.now() + config.FILE_URL_TTL_SECONDS * 1000);
    const docId = await withTenant(db, p.tenantId, async (tx) => {
      const ctx = await agencyContext(tx, p);
      const row = await ownSubmissions(tx, p, ctx)
        .innerJoin('candidate_documents as d', 'd.id', 's.resume_document_id')
        .select(['d.id as doc_id', 'd.scan_status'])
        .where('s.id', '=', id)
        .executeTakeFirst();
      if (!row) throw notFound('Resume');
      if (row.scan_status !== 'clean') throw new AppError(409, 'NOT_AVAILABLE', 'This file is not available for download.');
      await audit(tx, req, { tenantId: p.tenantId, actorUserId: p.userId, action: 'agency.resume_link_issued', entityType: 'submission', entityId: id, metadata: { document_id: row.doc_id } });
      return row.doc_id;
    });
    const token = signFileToken(config.FILE_URL_SECRET, { t: p.tenantId, d: docId, e: Math.floor(expiresAt.getTime() / 1000) });
    return { data: { url: `/api/v1/files/${token}`, expires_at: expiresAt } };
  });

  // Submit a candidate. One multipart request: a JSON `payload` field first, then the resume file.
  app.post('/agency/vacancies/:id/submissions', async (req, reply) => {
    const p = principal(req);
    const { id: vacancyId } = IdParams.parse(req.params);

    const maxBytes = await withTenant(db, p.tenantId, async (tx) => {
      await agencyContext(tx, p);
      const s = await tx.selectFrom('tenant_settings').select('resume_max_bytes').executeTakeFirst();
      return resumeLimit(s?.resume_max_bytes);
    });

    const part = await req.file({ limits: { fileSize: maxBytes, files: 1 } });
    if (!part) throw new AppError(400, 'RESUME_REQUIRED', 'Attach the candidate\'s resume.');
    const data = await part.toBuffer().catch((err: { code?: string }) => {
      if (err.code === 'FST_REQ_FILE_TOO_LARGE') throw new AppError(413, 'FILE_TOO_LARGE', `Files can be up to ${Math.round(maxBytes / 1024 / 1024)} MB.`);
      throw err;
    });
    const raw = part.fields.payload && 'value' in part.fields.payload ? String(part.fields.payload.value) : '';
    let json: unknown;
    try { json = JSON.parse(raw); } catch { throw new AppError(400, 'BAD_REQUEST', 'The submission details are missing or unreadable.'); }
    const body = Payload.parse(json);

    const filename = part.filename.replace(/[^\w.\- ()]/g, '_').slice(-150) || 'resume';
    const type = detectResumeType(filename, data);
    if (!type || data.length === 0) throw new AppError(415, 'UNSUPPORTED_FILE', 'Upload a PDF, DOC or DOCX file.');
    const verdict = await app.scanner.scan(data);
    if (verdict !== 'clean') {
      throw new AppError(422, 'FILE_REJECTED', verdict === 'infected' ? 'This file failed the security scan and was not saved.' : 'The file could not be scanned. Try again.');
    }

    // Reject a duplicate before anything is stored. The vacancy checks come first, so an agency
    // never learns anything about candidates through a vacancy that is not theirs.
    const early = await withTenant(db, p.tenantId, async (tx) => {
      const ctx = await agencyContext(tx, p);
      const vacancy = await assignedVacancies(tx, ctx.agencyId).select(['v.id', 'v.status']).where('v.id', '=', vacancyId).executeTakeFirst();
      if (!vacancy) throw notFound('Vacancy');
      if (vacancy.status !== 'open') throw new AppError(409, 'VACANCY_NOT_OPEN', 'This vacancy is not accepting submissions right now.');
      const matches = await existingMatches(tx, body);
      const dup = matches.length > 0 ? await duplicateOnJob(tx, vacancyId, matches) : null;
      if (dup) {
        await logDuplicateAttempt(tx, req, p, { vacancyId, candidateId: dup.candidateId, originalSubmissionId: dup.owner.submissionId, agencyId: ctx.agencyId });
        return true;
      }
      return false;
    });
    if (early) throw new AppError(409, 'DUPLICATE_CANDIDATE', DUPLICATE_MESSAGE);

    // The object is stored before the main transaction; if the submission is then refused (for
    // example by a simultaneous duplicate), the unreferenced object is left for the retention job.
    const storageKey = `${p.tenantId}/agency-submissions/${randomUUID()}`;
    await app.storage.put(storageKey, data, type.mime);

    const result = await withTenant(db, p.tenantId, async (tx) => {
      const ctx = await agencyContext(tx, p);
      const vacancy = await assignedVacancies(tx, ctx.agencyId).select(['v.id', 'v.status']).where('v.id', '=', vacancyId).executeTakeFirst();
      if (!vacancy) throw notFound('Vacancy');
      if (vacancy.status !== 'open') throw new AppError(409, 'VACANCY_NOT_OPEN', 'This vacancy is not accepting submissions right now.');

      // Everything that shares this email or phone queues here, so whoever gets in first is credited.
      await lockContacts(tx, p.tenantId, body.email, body.phone);
      const matches = await existingMatches(tx, body);
      // The candidate may already be in the company's database, for this job or another. Whoever gets here
      // first for this exact job wins; the lock makes that decision in the database, not the client.
      for (const m of matches) await lockJobCandidate(tx, p.tenantId, vacancyId, m.id);
      const dup = matches.length > 0 ? await duplicateOnJob(tx, vacancyId, matches) : null;
      if (dup) {
        await logDuplicateAttempt(tx, req, p, { vacancyId, candidateId: dup.candidateId, originalSubmissionId: dup.owner.submissionId, agencyId: ctx.agencyId });
        return { duplicate: true as const };
      }
      const existing = matches[0] ?? null;

      const initialStage = await tx.selectFrom('pipeline_stages').select('id').where('is_initial', '=', true).executeTakeFirst();
      if (!initialStage) throw new AppError(500, 'NO_INITIAL_STAGE', 'The pipeline has no starting stage configured.');

      let candidateId: string;
      if (existing) {
        candidateId = existing.id;
      } else {
        const created = await tx
          .insertInto('candidates')
          .values({
            tenant_id: p.tenantId, full_name: body.full_name, email: body.email, phone: body.phone, city: body.city,
            current_title: body.current_title, total_experience_years: body.total_experience_years,
            notice_period_days: body.notice_period_days, skills: body.skills, profile_summary: body.profile_summary,
            privacy_notice_status: 'agency_declared_consent', created_by: p.userId,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        candidateId = created.id;
      }

      // Reuse the active application for this vacancy if one exists (only possible for the owner).
      const activeApp = await tx
        .selectFrom('applications')
        .select('id')
        .where('candidate_id', '=', candidateId)
        .where('vacancy_id', '=', vacancyId)
        .where('status', '=', 'active')
        .forUpdate()
        .executeTakeFirst();
      let applicationId: string;
      if (activeApp) {
        applicationId = activeApp.id;
        const mine = await tx.selectFrom('submissions').select('id').where('application_id', '=', applicationId).where('agency_id', '=', ctx.agencyId).where('source_type', '=', 'agency').executeTakeFirst();
        if (mine) throw new AppError(409, 'ALREADY_SUBMITTED', 'Your agency has already submitted this candidate for this vacancy.');
      } else {
        const application = await tx
          .insertInto('applications')
          .values({ tenant_id: p.tenantId, candidate_id: candidateId, vacancy_id: vacancyId, stage_id: initialStage.id })
          .returning('id')
          .executeTakeFirstOrThrow();
        applicationId = application.id;
        await tx.insertInto('application_stage_events').values({ tenant_id: p.tenantId, application_id: applicationId, from_stage_id: null, to_stage_id: initialStage.id, actor_user_id: p.userId }).execute();
      }

      const doc = await tx
        .insertInto('candidate_documents')
        .values({
          tenant_id: p.tenantId, candidate_id: candidateId, document_type: 'resume', storage_key: storageKey,
          original_filename: filename, mime_type: type.mime, size_bytes: data.length,
          sha256: createHash('sha256').update(data).digest('hex'), scan_status: 'clean', uploaded_by: p.userId,
        })
        .returning('id')
        .executeTakeFirstOrThrow();

      const profile = {
        full_name: body.full_name, email: body.email, phone: body.phone, current_title: body.current_title, city: body.city,
        total_experience_years: body.total_experience_years, notice_period_days: body.notice_period_days,
        skills: body.skills, profile_summary: body.profile_summary,
      };
      const submission = await tx
        .insertInto('submissions')
        .values({
          tenant_id: p.tenantId, application_id: applicationId, source_type: 'agency', source_user_id: p.userId,
          agency_id: ctx.agencyId, resume_document_id: doc.id, source_declaration: DECLARATIONS[body.source_declaration],
          source_reference: body.source_declaration, notes: body.notes, consent_confirmed: true,
          submitted_profile: JSON.stringify(profile), ownership_state: 'accepted',
        })
        .returning('id')
        .executeTakeFirstOrThrow()
        .catch((err: unknown) => {
          if (pgErrorCode(err) === '23505' && pgConstraint(err) === 'uq_submissions_agency_application') {
            throw new AppError(409, 'ALREADY_SUBMITTED', 'Your agency has already submitted this candidate for this vacancy.');
          }
          throw err;
        });

      await recordOwnershipEvent(tx, {
        tenantId: p.tenantId, submissionId: submission.id, type: 'credited', from: null, to: 'accepted', actorUserId: p.userId,
        reason: existing ? "Sourced earlier by this agency; submitted to another vacancy" : 'First to source this candidate',
      });
      await audit(tx, req, {
        tenantId: p.tenantId, actorUserId: p.userId, action: 'agency.submission_created', entityType: 'submission', entityId: submission.id,
        metadata: { agency_id: ctx.agencyId, vacancy_id: vacancyId, candidate_id: candidateId, existing_candidate: !!existing },
      });
      // Tell the people working the vacancy, so a new CV does not sit unnoticed.
      const vac = await tx.selectFrom('vacancies').select(['title', 'owner_user_id']).where('id', '=', vacancyId).executeTakeFirst();
      const agencyRow = await tx.selectFrom('agencies').select('name').where('id', '=', ctx.agencyId).executeTakeFirst();
      const recruiters = await tx.selectFrom('vacancy_recruiters').select('recruiter_user_id').where('vacancy_id', '=', vacancyId).where('unassigned_at', 'is', null).execute();
      const audience = new Set([vac?.owner_user_id, ...recruiters.map((r) => r.recruiter_user_id)].filter((u): u is string => !!u));
      for (const userId of audience) {
        await notifyUser(tx, {
          tenantId: p.tenantId, userId, eventType: 'submission.received', dedupeKey: `submission:${submission.id}:${userId}`, email_too: false,
          title: 'New agency submission', body: `${body.full_name} · ${vac?.title ?? 'vacancy'} · from ${agencyRow?.name ?? 'an agency'}`, link: '/pipeline',
        });
      }
      return { duplicate: false as const, id: submission.id };
    });

    // A simultaneous submission of the same person got in first.
    if (result.duplicate) throw new AppError(409, 'DUPLICATE_CANDIDATE', DUPLICATE_MESSAGE);

    return reply.status(201).send({
      data: {
        id: result.id,
        ownership: agencyOwnershipView('accepted'),
        message: 'Submission received. This candidate is credited to your agency.',
      },
    });
  });
}
