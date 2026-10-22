// After the offer: joined, active, exited, and what the agency owes when someone leaves early.
// Only the HR Lead (employment.manage) records DOJ, exit and replacement outcomes; every step is audited.
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { z } from 'zod';
import { feeFor, termsEffectiveOn } from '../agency-terms.js';
import { principal } from '../app.js';
import { audit } from '../audit.js';
import { withTenant, type Tx } from '../db.js';
import { AppError, forbidden, notFound } from '../errors.js';
import { notifyUser } from '../notifications.js';
import { can, type Principal } from '../permissions.js';
import { forceTerminalStage, moveStage, stageByCode } from '../pipeline.js';
import { idParams, pageQuery } from './common.js';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.');
const today = () => new Date().toISOString().slice(0, 10);
const addDays = (d: string, n: number) => new Date(new Date(`${d}T00:00:00Z`).getTime() + n * 86_400_000).toISOString().slice(0, 10);
const daysBetween = (a: string, b: string) => Math.round((new Date(`${b}T00:00:00Z`).getTime() - new Date(`${a}T00:00:00Z`).getTime()) / 86_400_000);

const JoinBody = z.object({ joined_on: isoDate, designation: z.string().trim().min(1, 'Add the designation.').max(200), annual_ctc: z.number().min(0, 'Enter the agreed annual CTC.').max(1_000_000_000) });
const OfferBody = z
  .object({ offered_ctc: z.number().positive('Enter the offered annual CTC.').max(1_000_000_000), status: z.enum(['offered', 'accepted', 'declined']), decline_reason: z.string().trim().max(2000).optional() })
  .refine((b) => b.status !== 'declined' || !!b.decline_reason, { path: ['decline_reason'], message: 'Say why the candidate declined.' });
const ExitBody = z.object({ exit_date: isoDate, exit_reason: z.string().trim().min(1, 'Add the exit reason.').max(2000) });
const InvoiceBody = z.object({ invoice_status: z.enum(['not_invoiced', 'invoiced', 'paid', 'credited']), invoice_reference: z.string().trim().max(200).nullable().default(null) });
const ListQuery = pageQuery.extend({
  status: z.enum(['active', 'exited', 'all']).default('all'),
  agency_id: z.uuid().optional(), vacancy_id: z.uuid().optional(), q: z.string().trim().max(100).optional(),
  page_size: z.coerce.number().int().min(1).max(200).default(100),
});

function need(p: Principal) {
  if (!can(p, 'employment.manage')) throw forbidden();
}

function employmentBase(tx: Tx) {
  return tx
    .selectFrom('employment_records as e')
    .innerJoin('candidates as c', 'c.id', 'e.candidate_id')
    .innerJoin('vacancies as v', 'v.id', 'e.vacancy_id')
    .leftJoin('agencies as ag', 'ag.id', 'e.source_agency_id')
    .leftJoin('users as su', 'su.id', 'e.source_user_id')
    .leftJoin('agency_terms as t', 't.id', 'e.agency_terms_id')
    .leftJoin('replacement_records as r', 'r.employment_id', 'e.id')
    .innerJoin('applications as ap', 'ap.id', 'e.application_id');
}
const COLS = [
  'e.id', 'e.application_id', 'ap.sourcing_code', 'ap.temp_employee_code', 'e.candidate_id', 'c.full_name as candidate_name', 'e.vacancy_id', 'v.title as job_title', 'v.vacancy_code',
  'e.joined_on', 'e.designation', 'e.annual_ctc', 'e.status', 'e.exit_date', 'e.exit_reason', 'e.invoice_status', 'e.invoice_reference',
  'ag.name as agency_name', 'e.source_agency_id', 'su.full_name as recruiter_name',
  't.version as terms_version', 't.payment_model', 't.fee_type', 't.fee_value', 't.lockin_days', 't.replacement_days',
  'r.id as replacement_id', 'r.status as replacement_status', 'r.due_by as replacement_due_by',
] as const;

function present<R extends { annual_ctc: number; payment_model: 'payroll_management' | 'one_time_fee' | null; fee_type: 'percent_of_ctc' | 'fixed' | null; fee_value: number | null }>(r: R) {
  const fee = r.payment_model && r.fee_type && r.fee_value !== null ? feeFor({ payment_model: r.payment_model, fee_type: r.fee_type, fee_value: r.fee_value }, r.annual_ctc) : null;
  return { ...r, fee_amount: fee };
}

export async function employmentRoutes(app: FastifyInstance) {
  const { db } = app;

  // Mark Joined: DOJ, designation and the agreed CTC. Moves the application to Hired and freezes the agency terms.
  app.post('/applications/:id/join', async (req, reply) => {
    const p = principal(req);
    need(p);
    const { id } = idParams.parse(req.params);
    const body = JoinBody.parse(req.body);
    const created = await withTenant(db, p.tenantId, async (tx) => {
      const a = await tx
        .selectFrom('applications as a').select(['a.id', 'a.status', 'a.stage_id', 'a.candidate_id', 'a.vacancy_id']).where('a.id', '=', id).forUpdate('a').executeTakeFirst();
      if (!a) throw notFound('Application');
      if (await tx.selectFrom('employment_records').select('id').where('application_id', '=', id).executeTakeFirst()) throw new AppError(409, 'ALREADY_JOINED', 'This candidate is already marked as joined.');
      if (a.status !== 'active') throw new AppError(409, 'APPLICATION_CLOSED', 'Only candidates still in the pipeline can be marked joined.');
      const owner = await tx.selectFrom('submissions').select(['agency_id', 'source_user_id']).where('application_id', '=', id).where('ownership_state', '=', 'accepted').executeTakeFirst();
      const terms = owner?.agency_id ? await termsEffectiveOn(tx, owner.agency_id, body.joined_on) : null;
      const hired = await stageByCode(tx, 'hired');
      if (!hired) throw new AppError(422, 'NO_HIRED_STAGE', 'This company has no Hired stage.');
      await forceTerminalStage(tx, req, p, a, hired.id, 'Marked joined');
      const rec = await tx.insertInto('employment_records').values({
        tenant_id: p.tenantId, application_id: id, candidate_id: a.candidate_id, vacancy_id: a.vacancy_id, source_user_id: owner?.source_user_id ?? null,
        source_agency_id: owner?.agency_id ?? null, agency_terms_id: terms?.id ?? null, joined_on: body.joined_on, designation: body.designation, annual_ctc: body.annual_ctc, marked_joined_by: p.userId,
      }).returning('id').executeTakeFirstOrThrow();
      // Keep the offer follow-up in step, if there is one.
      await tx.updateTable('joining_records').set({ status: 'joined', updated_by: p.userId, updated_at: sql`now()` }).where('application_id', '=', id).where('status', 'in', ['expected', 'delayed']).execute();
      await audit(tx, req, { tenantId: p.tenantId, actorUserId: p.userId, action: 'employment.joined', entityType: 'employment', entityId: rec.id, metadata: { application_id: id, joined_on: body.joined_on, designation: body.designation, annual_ctc: body.annual_ctc, agency_id: owner?.agency_id ?? null, terms_version: terms?.version ?? null } });
      const joins = (await tx.selectFrom('employment_records').select((eb) => eb.fn.countAll<number>().as('n')).where('vacancy_id', '=', a.vacancy_id).executeTakeFirstOrThrow()).n;
      const v = await tx.selectFrom('vacancies').select(['title', 'headcount', 'owner_user_id']).where('id', '=', a.vacancy_id).executeTakeFirstOrThrow();
      const reached = Number(joins) >= v.headcount;
      if (reached && v.owner_user_id && v.owner_user_id !== p.userId) {
        await notifyUser(tx, { tenantId: p.tenantId, userId: v.owner_user_id, eventType: 'job.target_reached', dedupeKey: `target:${a.vacancy_id}`, title: 'Hiring target reached', body: `${v.title}: ${joins} of ${v.headcount} have joined. You can close the job.`, link: '/jobs' });
      }
      return { id: rec.id, joins: Number(joins), target: v.headcount, target_reached: reached, agency_terms_version: terms?.version ?? null };
    });
    return reply.status(201).send({ data: created });
  });

  // Record the offer: status and offered CTC, no approval chain. One live offer per candidate: recording again updates it.
  app.post('/applications/:id/offer', async (req, reply) => {
    const p = principal(req);
    if (!can(p, 'offers.manage')) throw forbidden();
    const { id } = idParams.parse(req.params);
    const body = OfferBody.parse(req.body);
    const status = body.status === 'offered' ? 'released' : body.status;
    return withTenant(db, p.tenantId, async (tx) => {
      const a = await tx.selectFrom('applications').select(['id', 'status', 'stage_id']).where('id', '=', id).forUpdate().executeTakeFirst();
      if (!a) throw notFound('Application');
      if (a.status !== 'active') throw new AppError(409, 'APPLICATION_CLOSED', 'Offers can only be recorded for candidates still in the pipeline.');
      const live = await tx.selectFrom('offers').select(['id', 'status']).where('application_id', '=', id).where('status', 'in', ['draft', 'pending_approval', 'approved', 'released']).executeTakeFirst();
      const stamps = { ...(status === 'released' ? { released_at: new Date() } : {}), ...(status === 'accepted' || status === 'declined' ? { responded_at: new Date() } : {}) };
      let offerId: string;
      if (live) {
        await tx.updateTable('offers').set({ status, offered_ctc: body.offered_ctc, decline_reason: body.decline_reason ?? null, updated_at: sql`now()`, ...stamps }).where('id', '=', live.id).execute();
        offerId = live.id;
      } else {
        const row = await tx.insertInto('offers').values({ tenant_id: p.tenantId, application_id: id, status, offered_ctc: body.offered_ctc, decline_reason: body.decline_reason ?? null, created_by: p.userId, ...stamps }).returning('id').executeTakeFirstOrThrow();
        offerId = row.id;
      }
      const offerStage = await stageByCode(tx, 'offer');
      if (offerStage && offerStage.id !== a.stage_id && body.status !== 'declined') {
        try { await moveStage(tx, req, p, a, offerStage.id); } catch (err) { if (!(err instanceof AppError) || err.code !== 'TRANSITION_NOT_ALLOWED') throw err; }
      }
      await audit(tx, req, { tenantId: p.tenantId, actorUserId: p.userId, action: 'offer.recorded', entityType: 'offer', entityId: offerId, metadata: { application_id: id, status: body.status, offered_ctc: body.offered_ctc } });
      return reply.status(201).send({ data: { id: offerId, status: body.status, offered_ctc: body.offered_ctc } });
    });
  });

  app.get('/employment', async (req) => {
    const p = principal(req);
    need(p);
    const f = ListQuery.parse(req.query);
    return withTenant(db, p.tenantId, async (tx) => {
      let q = employmentBase(tx);
      if (f.status !== 'all') q = q.where('e.status', '=', f.status);
      if (f.agency_id) q = q.where('e.source_agency_id', '=', f.agency_id);
      if (f.vacancy_id) q = q.where('e.vacancy_id', '=', f.vacancy_id);
      if (f.q) {
        const like = `%${f.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
        q = q.where((eb) => eb.or([eb('c.full_name', 'ilike', like), eb('ap.sourcing_code', 'ilike', like), eb('ap.temp_employee_code', 'ilike', like)]));
      }
      const { total } = await q.select(sql<number>`count(*)::int`.as('total')).executeTakeFirstOrThrow();
      const rows = await q.select([...COLS]).orderBy('e.joined_on', 'desc').limit(f.page_size).offset((f.page - 1) * f.page_size).execute();
      return { data: rows.map(present), page: f.page, page_size: f.page_size, total };
    });
  });

  // Selected (they have a temp employee ID) but not marked joined yet.
  app.get('/employment/yet-to-join', async (req) => {
    const p = principal(req);
    need(p);
    const f = z.object({ q: z.string().trim().max(200).optional(), vacancy_id: z.uuid().optional() }).parse(req.query);
    return withTenant(db, p.tenantId, async (tx) => {
      let q = tx.selectFrom('applications as a')
        .innerJoin('candidates as c', 'c.id', 'a.candidate_id')
        .innerJoin('vacancies as v', 'v.id', 'a.vacancy_id')
        .leftJoin('submissions as sb', (j) => j.onRef('sb.application_id', '=', 'a.id').on('sb.ownership_state', '=', 'accepted'))
        .leftJoin('agencies as ag', 'ag.id', 'sb.agency_id')
        .leftJoin('users as su', 'su.id', 'sb.source_user_id')
        .leftJoin('joining_terms as jt', (j) => j.onRef('jt.application_id', '=', 'a.id').on('jt.status', '=', 'approved'))
        .select(['jt.annual_ctc as agreed_salary', sql<string | null>`jt.joining_date::text`.as('joining_date'), 'a.id as application_id', 'a.sourcing_code', 'a.temp_employee_code', 'c.id as candidate_id', 'c.full_name as candidate_name', 'c.current_title',
          'v.id as vacancy_id', 'v.title as job_title', 'ag.name as agency_name', 'su.full_name as recruiter_name',
          (eb) => eb.selectFrom('hiring_decisions as d').select('d.decided_at').whereRef('d.application_id', '=', 'a.id').where('d.decision', '=', 'select').orderBy('d.decided_at', 'desc').limit(1).as('selected_on')])
        .where('a.temp_employee_code', 'is not', null)
        .where('a.status', '=', 'active')
        .where((eb) => eb.not(eb.exists(eb.selectFrom('employment_records as e').select('e.id').whereRef('e.application_id', '=', 'a.id'))));
      if (f.vacancy_id) q = q.where('a.vacancy_id', '=', f.vacancy_id);
      if (f.q) {
        const like = `%${f.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
        q = q.where((eb) => eb.or([eb('c.full_name', 'ilike', like), eb('a.sourcing_code', 'ilike', like), eb('a.temp_employee_code', 'ilike', like)]));
      }
      return { data: await q.orderBy('a.temp_employee_code').limit(500).execute() };
    });
  });

  app.post('/employment/:id/exit', async (req) => {
    const p = principal(req);
    need(p);
    const { id } = idParams.parse(req.params);
    const body = ExitBody.parse(req.body);
    return withTenant(db, p.tenantId, async (tx) => {
      const e = await tx.selectFrom('employment_records').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
      if (!e) throw notFound('Employment record');
      if (e.status === 'exited') throw new AppError(409, 'ALREADY_EXITED', 'This person is already marked as exited.');
      if (body.exit_date < e.joined_on) throw new AppError(400, 'VALIDATION_ERROR', 'Some fields are invalid.', [{ path: 'exit_date', message: 'The exit date cannot be before the joining date.' }]);
      await tx.updateTable('employment_records').set({ status: 'exited', exit_date: body.exit_date, exit_reason: body.exit_reason, marked_exited_by: p.userId, updated_at: sql`now()` }).where('id', '=', id).execute();

      // Replacement: an agency hire who leaves inside the lock-in period must be replaced within the agreed days.
      let replacement: { id: string; due_by: string } | null = null;
      if (e.source_agency_id && e.agency_terms_id) {
        const t = await tx.selectFrom('agency_terms').select(['lockin_days', 'replacement_days']).where('id', '=', e.agency_terms_id).executeTakeFirstOrThrow();
        const served = daysBetween(e.joined_on, body.exit_date);
        if (t.lockin_days !== null && t.replacement_days !== null && served <= t.lockin_days) {
          replacement = await tx.insertInto('replacement_records').values({
            tenant_id: p.tenantId, employment_id: id, agency_id: e.source_agency_id, vacancy_id: e.vacancy_id,
            lockin_days: t.lockin_days, replacement_days: t.replacement_days, due_by: addDays(body.exit_date, t.replacement_days),
          }).returning(['id', 'due_by']).executeTakeFirstOrThrow();
        }
      }
      await audit(tx, req, { tenantId: p.tenantId, actorUserId: p.userId, action: 'employment.exited', entityType: 'employment', entityId: id, metadata: { exit_date: body.exit_date, exit_reason: body.exit_reason, joined_on: e.joined_on, replacement_id: replacement?.id ?? null } });
      return { data: { id, status: 'exited', replacement_due: replacement ? { id: replacement.id, due_by: replacement.due_by } : null } };
    });
  });

  app.patch('/employment/:id/invoice', async (req) => {
    const p = principal(req);
    need(p);
    const { id } = idParams.parse(req.params);
    const body = InvoiceBody.parse(req.body);
    return withTenant(db, p.tenantId, async (tx) => {
      const e = await tx.selectFrom('employment_records').select(['id', 'source_agency_id', 'invoice_status']).where('id', '=', id).forUpdate().executeTakeFirst();
      if (!e) throw notFound('Employment record');
      if (!e.source_agency_id) throw new AppError(409, 'NOT_AGENCY_HIRE', 'Only agency hires have a hiring fee to invoice.');
      await tx.updateTable('employment_records').set({ invoice_status: body.invoice_status, invoice_reference: body.invoice_reference, updated_at: sql`now()` }).where('id', '=', id).execute();
      await audit(tx, req, { tenantId: p.tenantId, actorUserId: p.userId, action: 'employment.invoice_updated', entityType: 'employment', entityId: id, metadata: { from: e.invoice_status, to: body.invoice_status, reference: body.invoice_reference } });
      return { data: { id, invoice_status: body.invoice_status } };
    });
  });

  // ---- Replacements ----
  app.get('/replacements', async (req) => {
    const p = principal(req);
    need(p);
    const f = z.object({ status: z.enum(['due', 'replaced', 'expired', 'waived', 'all']).default('all') }).parse(req.query);
    return withTenant(db, p.tenantId, async (tx) => {
      // A replacement not supplied by its deadline is expired. Done when it is looked at, so the list is always current.
      await tx.updateTable('replacement_records').set({ status: 'expired', updated_at: sql`now()` }).where('status', '=', 'due').where('due_by', '<', today()).execute();
      let q = tx
        .selectFrom('replacement_records as r')
        .innerJoin('employment_records as e', 'e.id', 'r.employment_id')
        .innerJoin('candidates as c', 'c.id', 'e.candidate_id')
        .innerJoin('agencies as ag', 'ag.id', 'r.agency_id')
        .innerJoin('vacancies as v', 'v.id', 'r.vacancy_id');
      if (f.status !== 'all') q = q.where('r.status', '=', f.status);
      const rows = await q
        .select(['r.id', 'r.status', 'r.due_by', 'r.lockin_days', 'r.replacement_days', 'r.notes', 'r.replacement_employment_id', 'e.id as employment_id', 'e.joined_on', 'e.exit_date', 'e.exit_reason', 'c.full_name as candidate_name', 'ag.id as agency_id', 'ag.name as agency_name', 'v.id as vacancy_id', 'v.title as job_title'])
        .orderBy('r.due_by').execute();
      const t = today();
      return { data: rows.map((r) => ({ ...r, days_left: r.status === 'due' ? daysBetween(t, r.due_by) : null })) };
    });
  });

  app.post('/replacements/:id/link', async (req) => {
    const p = principal(req);
    need(p);
    const { id } = idParams.parse(req.params);
    const { replacement_employment_id } = z.object({ replacement_employment_id: z.uuid() }).parse(req.body);
    return withTenant(db, p.tenantId, async (tx) => {
      const r = await tx.selectFrom('replacement_records').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
      if (!r) throw notFound('Replacement');
      if (r.status !== 'due') throw new AppError(409, 'NOT_DUE', `This replacement is already ${r.status}.`);
      const next = await tx.selectFrom('employment_records').select(['id', 'source_agency_id', 'vacancy_id']).where('id', '=', replacement_employment_id).executeTakeFirst();
      if (!next) throw notFound('Replacement hire');
      if (next.id === r.employment_id || next.source_agency_id !== r.agency_id || next.vacancy_id !== r.vacancy_id) {
        throw new AppError(422, 'WRONG_REPLACEMENT', 'The replacement must be a different hire by the same agency for the same job.');
      }
      await tx.updateTable('replacement_records').set({ status: 'replaced', replacement_employment_id, updated_at: sql`now()` }).where('id', '=', id).execute();
      await audit(tx, req, { tenantId: p.tenantId, actorUserId: p.userId, action: 'replacement.fulfilled', entityType: 'replacement', entityId: id, metadata: { replacement_employment_id } });
      return { data: { id, status: 'replaced' } };
    });
  });

  app.post('/replacements/:id/waive', async (req) => {
    const p = principal(req);
    need(p);
    const { id } = idParams.parse(req.params);
    const { notes } = z.object({ notes: z.string().trim().min(1, 'Say why it is waived.').max(2000) }).parse(req.body);
    return withTenant(db, p.tenantId, async (tx) => {
      const r = await tx.selectFrom('replacement_records').select(['id', 'status']).where('id', '=', id).forUpdate().executeTakeFirst();
      if (!r) throw notFound('Replacement');
      if (r.status !== 'due') throw new AppError(409, 'NOT_DUE', `This replacement is already ${r.status}.`);
      await tx.updateTable('replacement_records').set({ status: 'waived', notes, updated_at: sql`now()` }).where('id', '=', id).execute();
      await audit(tx, req, { tenantId: p.tenantId, actorUserId: p.userId, action: 'replacement.waived', entityType: 'replacement', entityId: id, metadata: { notes } });
      return { data: { id, status: 'waived' } };
    });
  });
}
