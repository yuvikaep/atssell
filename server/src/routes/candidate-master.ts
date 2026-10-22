// The Candidate Master: one spreadsheet row per candidate with their latest job and status, sortable and
// filterable, plus CSV import. Contact and pay follow the same visibility rules as everywhere else.
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { z } from 'zod';
import { agencyIdOf, candidateVisible, hasAny, vacancyVisible } from '../access.js';
import { principal } from '../app.js';
import { audit } from '../audit.js';
import { withTenant } from '../db.js';
import { AppError, forbidden } from '../errors.js';
import { existingJobSubmission, lockContacts, lockJobCandidate, logDuplicateAttempt, recordOwnershipEvent } from '../ownership.js';
import { can } from '../permissions.js';
import { normalizePhone } from '../phone.js';
import { pageQuery } from './common.js';

const escapeLike = (v: string) => v.replace(/[\\%_]/g, (c) => `\\${c}`);
const SORTS = { name: 'c.full_name', city: 'c.city', experience: 'c.total_experience_years', notice: 'c.notice_period_days', added: 'c.created_at', job: 'la.job_title', status: 'la.stage_sort' } as const;

const ListQuery = pageQuery.extend({
  q: z.string().trim().max(200).optional(),
  city: z.string().trim().max(100).optional(),
  stage: z.string().trim().max(40).optional(),
  vacancy_id: z.uuid().optional(),
  source: z.enum(['agency', 'internal']).optional(),
  agency_id: z.uuid().optional(),
  min_experience: z.coerce.number().min(0).optional(),
  sort: z.enum(['name', 'city', 'experience', 'notice', 'added', 'job', 'status']).default('added'),
  dir: z.enum(['asc', 'desc']).default('desc'),
  page_size: z.coerce.number().int().min(1).max(200).default(50),
});

/** Stages a role may set straight from the sheet. HR Lead: any open stage. Recruiter: only the early ones. */
export const RECRUITER_STAGES = ['screening', 'shortlisted'];

// ---- A small RFC 4180 CSV reader: quoted fields, doubled quotes, commas and line breaks inside quotes ----
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"') { if (src[i + 1] === '"') { field += '"'; i++; } else quoted = false; } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((c) => c.trim() !== '')) rows.push(row);
  return rows;
}

const HEADERS: Record<string, string> = {
  name: 'full_name', 'full name': 'full_name', full_name: 'full_name', email: 'email', 'email id': 'email', phone: 'phone', mobile: 'phone', 'phone number': 'phone',
  city: 'city', location: 'city', title: 'current_title', 'current title': 'current_title', designation: 'current_title', current_title: 'current_title',
  experience: 'total_experience_years', 'experience (years)': 'total_experience_years', total_experience_years: 'total_experience_years',
  notice: 'notice_period_days', 'notice period': 'notice_period_days', 'notice period (days)': 'notice_period_days', notice_period_days: 'notice_period_days',
  skills: 'skills', job: 'job_code', 'job code': 'job_code', job_code: 'job_code', source: 'source',
};
const SOURCES = new Set(['internal_recruiter', 'referral', 'direct', 'job_board', 'other']);
const MAX_ROWS = 500;

export async function candidateMasterRoutes(app: FastifyInstance) {
  const { db } = app;

  app.get('/candidate-master', async (req) => {
    const p = principal(req);
    if (!hasAny(p, 'candidates.view')) throw forbidden();
    const f = ListQuery.parse(req.query);
    return withTenant(db, p.tenantId, async (tx) => {
      const agencyId = await agencyIdOf(tx, p.userId);
      if (agencyId) throw forbidden();
      const contact = hasAny(p, 'candidates.view_contact');
      let base = tx
        .selectFrom('candidates as c')
        .leftJoinLateral(
          (eb) => eb
            .selectFrom('applications as a')
            .innerJoin('vacancies as v', 'v.id', 'a.vacancy_id')
            .innerJoin('requisitions as rq', 'rq.id', 'v.requisition_id')
            .innerJoin('pipeline_stages as st', 'st.id', 'a.stage_id')
            .leftJoin('submissions as sb', (j) => j.onRef('sb.application_id', '=', 'a.id').on('sb.ownership_state', '=', 'accepted'))
            .leftJoin('agencies as ag', 'ag.id', 'sb.agency_id')
            .leftJoin('users as su', 'su.id', 'sb.source_user_id')
            .select(['a.id as application_id', 'a.sourcing_code', 'a.temp_employee_code', 'a.status as app_status', 'v.id as vacancy_id', 'v.title as job_title', 'v.vacancy_code', 'st.code as stage_code', 'st.name as stage_name', 'st.sort_order as stage_sort', 'ag.name as agency_name', 'su.full_name as recruiter_name', 'sb.agency_id as owner_agency_id'])
            .whereRef('a.candidate_id', '=', 'c.id')
            .$if(!!f.vacancy_id, (q) => q.where('a.vacancy_id', '=', f.vacancy_id!))
            .where(vacancyVisible(p, null))
            .orderBy('a.created_at', 'desc')
            .limit(1)
            .as('la'),
          (join) => join.onTrue(),
        )
        .where('c.status', '=', 'active')
        .where(candidateVisible(p, null));
      if (f.q) {
        const like = `%${escapeLike(f.q)}%`;
        const phone = contact ? normalizePhone(f.q) : null;
        base = base.where((eb) => eb.or([
          eb('c.full_name', 'ilike', like), eb('c.current_title', 'ilike', like), eb('c.city', 'ilike', like),
          // A sourcing ID (SRC-…) or temp employee ID (TEMP-…) on any of the candidate's applications.
          sql<boolean>`EXISTS (SELECT 1 FROM applications ax WHERE ax.candidate_id = c.id AND (ax.sourcing_code ILIKE ${like} OR ax.temp_employee_code ILIKE ${like}))`,
          sql<boolean>`EXISTS (SELECT 1 FROM unnest(c.skills) sk WHERE sk ILIKE ${like})`,
          ...(contact ? [eb('c.email', 'ilike', like)] : []), ...(phone ? [eb('c.phone', '=', phone)] : []),
        ]));
      }
      if (f.city) base = base.where(sql`lower(c.city)`, '=', f.city.toLowerCase());
      if (f.stage) base = base.where('la.stage_code', '=', f.stage);
      if (f.vacancy_id) base = base.where('la.vacancy_id', 'is not', null);
      if (f.source === 'agency') base = base.where('la.owner_agency_id', 'is not', null);
      if (f.source === 'internal') base = base.where('la.application_id', 'is not', null).where('la.owner_agency_id', 'is', null);
      if (f.agency_id) base = base.where('la.owner_agency_id', '=', f.agency_id);
      if (f.min_experience !== undefined) base = base.where('c.total_experience_years', '>=', f.min_experience);

      const { total } = await base.select(sql<number>`count(*)::int`.as('total')).executeTakeFirstOrThrow();
      const sortExpr = sql.raw(SORTS[f.sort]);
      const rows = await base
        .select(['c.id', 'c.full_name', 'c.email', 'c.phone', 'c.city', 'c.current_title', 'c.total_experience_years', 'c.notice_period_days', 'c.skills', 'c.created_at',
          'la.application_id', 'la.sourcing_code', 'la.temp_employee_code', 'la.app_status', 'la.vacancy_id', 'la.job_title', 'la.vacancy_code', 'la.stage_code', 'la.stage_name', 'la.agency_name', 'la.recruiter_name',
          sql<number>`(SELECT count(*)::int FROM applications x WHERE x.candidate_id = c.id)`.as('applications'),
          sql<string | null>`(SELECT d.decision FROM hiring_decisions d WHERE d.application_id = la.application_id ORDER BY d.decided_at DESC LIMIT 1)`.as('decision'),
          sql<string | null>`(SELECT d.reason FROM hiring_decisions d WHERE d.application_id = la.application_id ORDER BY d.decided_at DESC LIMIT 1)`.as('decision_reason'),
          sql<string | null>`(SELECT o.status FROM offers o WHERE o.application_id = la.application_id ORDER BY o.created_at DESC LIMIT 1)`.as('offer_status'),
          sql<string | null>`(SELECT e.status FROM employment_records e WHERE e.application_id = la.application_id)`.as('employment_status'),
          sql<number | null>`(SELECT round(avg(fb.overall_rating)::numeric, 1)::float FROM feedback fb JOIN applications x ON x.id = fb.application_id WHERE x.candidate_id = c.id)`.as('avg_rating')])
        .orderBy(sql`${sortExpr} ${sql.raw(f.dir)} NULLS LAST`)
        .orderBy('c.id')
        .limit(f.page_size).offset((f.page - 1) * f.page_size)
        .execute();

      const stages = await tx.selectFrom('pipeline_stages').select(['code', 'name', 'terminal_status', 'sort_order']).where('status', '=', 'active').orderBy('sort_order').execute();
      // Which statuses this person may set straight from the sheet.
      const settable = can(p, 'employment.manage')
        ? stages.filter((s) => s.code !== 'hired').map((s) => s.code)
        : hasAny(p, 'applications.manage') ? RECRUITER_STAGES : [];
      return {
        data: rows.map((r) => ({
          ...r, email: contact ? r.email : undefined, phone: contact ? r.phone : undefined,
          source: r.agency_name ? `Agency: ${r.agency_name}` : r.recruiter_name ? `Recruiter: ${r.recruiter_name}` : null,
        })),
        page: f.page, page_size: f.page_size, total,
        stages: stages.map((s) => ({ code: s.code, name: s.name })), settable_stages: settable,
      };
    });
  });

  // CSV import: validates each row, matches people already in the database by phone or email, and can
  // submit each person to a job by its code. A duplicate for a job is refused and recorded, as everywhere else.
  app.post('/candidates/import', async (req) => {
    const p = principal(req);
    if (!hasAny(p, 'candidates.manage')) throw forbidden();
    const body = z.object({ csv: z.string().min(1).max(2_000_000), dry_run: z.boolean().default(false), default_source: z.enum(['internal_recruiter', 'referral', 'direct', 'job_board', 'other']).default('internal_recruiter') }).parse(req.body);
    const table = parseCsv(body.csv);
    if (table.length < 2) throw new AppError(400, 'EMPTY_FILE', 'The file has no candidate rows. The first row must be the column names.');
    if (table.length - 1 > MAX_ROWS) throw new AppError(413, 'TOO_MANY_ROWS', `Import up to ${MAX_ROWS} rows at a time.`);
    const cols = table[0]!.map((h) => HEADERS[h.trim().toLowerCase()] ?? null);
    if (!cols.includes('full_name') || (!cols.includes('email') && !cols.includes('phone'))) {
      throw new AppError(400, 'MISSING_COLUMNS', 'The file needs a Name column and an Email or Phone column.');
    }

    type Outcome = { row: number; status: 'created' | 'existing' | 'failed'; submission?: 'submitted' | 'duplicate' | 'not_submitted'; error?: string };
    const results: Outcome[] = [];
    for (let i = 1; i < table.length; i++) {
      const rec: Record<string, string> = {};
      cols.forEach((c, j) => { if (c) rec[c] = (table[i]![j] ?? '').trim(); });
      const rowNo = i + 1;
      const fail = (error: string) => results.push({ row: rowNo, status: 'failed', error });
      if (!rec.full_name) { fail('Name is missing.'); continue; }
      const email = rec.email ? rec.email.toLowerCase() : null;
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { fail('Email is not valid.'); continue; }
      const phone = rec.phone ? normalizePhone(rec.phone) : null;
      if (rec.phone && !phone) { fail('Phone is not valid.'); continue; }
      if (!email && !phone) { fail('Email or phone is needed.'); continue; }
      const exp = rec.total_experience_years ? Number(rec.total_experience_years) : null;
      const notice = rec.notice_period_days ? Number(rec.notice_period_days) : null;
      if ((exp !== null && (!Number.isFinite(exp) || exp < 0 || exp > 60)) || (notice !== null && (!Number.isInteger(notice) || notice < 0 || notice > 365))) { fail('Experience or notice period is not a valid number.'); continue; }
      const source = rec.source && SOURCES.has(rec.source) ? (rec.source as typeof body.default_source) : body.default_source;

      try {
        const outcome = await withTenant(db, p.tenantId, async (tx): Promise<Outcome> => {
          await lockContacts(tx, p.tenantId, email, phone);
          const found = await tx.selectFrom('candidates').select('id').where('status', '=', 'active')
            .where((eb) => eb.or([...(email ? [eb('email', '=', email)] : []), ...(phone ? [eb('phone', '=', phone)] : [])])).limit(1).executeTakeFirst();
          let vacancy: { id: string } | undefined;
          if (rec.job_code) {
            vacancy = await tx.selectFrom('vacancies as v').innerJoin('requisitions as rq', 'rq.id', 'v.requisition_id').select('v.id').where('v.vacancy_code', '=', rec.job_code.toUpperCase()).where('v.status', '=', 'open').where(vacancyVisible(p, null)).executeTakeFirst();
            if (!vacancy) throw new AppError(422, 'UNKNOWN_JOB', `Job ${rec.job_code} was not found, is not open, or is not assigned to you.`);
          }
          if (body.dry_run) return { row: rowNo, status: found ? 'existing' : 'created', submission: vacancy ? 'not_submitted' : undefined };
          let candidateId = found?.id;
          if (!candidateId) {
            const created = await tx.insertInto('candidates').values({
              tenant_id: p.tenantId, full_name: rec.full_name!, email, phone, city: rec.city || null, current_title: rec.current_title || null,
              total_experience_years: exp, notice_period_days: notice, skills: rec.skills ? rec.skills.split(/[;|,]/).map((x) => x.trim()).filter(Boolean) : [], created_by: p.userId,
            }).returning('id').executeTakeFirstOrThrow();
            candidateId = created.id;
          }
          const out: Outcome = { row: rowNo, status: found ? 'existing' : 'created' };
          if (vacancy) {
            await lockJobCandidate(tx, p.tenantId, vacancy.id, candidateId);
            const owner = await existingJobSubmission(tx, candidateId, vacancy.id);
            if (owner) {
              await logDuplicateAttempt(tx, req, p, { vacancyId: vacancy.id, candidateId, originalSubmissionId: owner.submissionId, agencyId: null });
              out.submission = 'duplicate';
            } else {
              const stage = await tx.selectFrom('pipeline_stages').select('id').where('is_initial', '=', true).executeTakeFirstOrThrow();
              const application = await tx.insertInto('applications').values({ tenant_id: p.tenantId, candidate_id: candidateId, vacancy_id: vacancy.id, stage_id: stage.id }).returning('id').executeTakeFirstOrThrow();
              await tx.insertInto('application_stage_events').values({ tenant_id: p.tenantId, application_id: application.id, from_stage_id: null, to_stage_id: stage.id, actor_user_id: p.userId }).execute();
              const sub = await tx.insertInto('submissions').values({ tenant_id: p.tenantId, application_id: application.id, source_type: source, source_user_id: p.userId, ownership_state: 'accepted' }).returning('id').executeTakeFirstOrThrow();
              await recordOwnershipEvent(tx, { tenantId: p.tenantId, submissionId: sub.id, type: 'credited', from: null, to: 'accepted', actorUserId: p.userId, reason: 'First submission for this job (import)' });
              out.submission = 'submitted';
            }
          }
          return out;
        });
        results.push(outcome);
      } catch (err) {
        fail(err instanceof AppError ? err.message : 'This row could not be saved.');
      }
    }
    const summary = {
      dry_run: body.dry_run, total: results.length,
      created: results.filter((r) => r.status === 'created').length, existing: results.filter((r) => r.status === 'existing').length, failed: results.filter((r) => r.status === 'failed').length,
      submitted: results.filter((r) => r.submission === 'submitted').length, duplicates: results.filter((r) => r.submission === 'duplicate').length,
    };
    if (!body.dry_run) {
      await withTenant(db, p.tenantId, (tx) => audit(tx, req, { tenantId: p.tenantId, actorUserId: p.userId, action: 'candidates.imported', entityType: 'candidate', metadata: summary }));
    }
    return { data: { summary, rows: results.filter((r) => r.status === 'failed' || r.submission === 'duplicate' || results.length <= 100) } };
  });
}
