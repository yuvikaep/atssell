// Offers and joining. An offer is drafted, approved by one or more approvers in order, released, and then
// accepted or declined by the candidate (recorded by a recruiter). Acceptance creates a joining record;
// the joining outcome (joined, delayed, backed out) moves the application to hired or withdrawn.
//
// Compensation: offers, and the amount in them, are visible only to people who hold offers.manage or
// offers.approve (and, for others, only on vacancies they can see). The offer's own approvers can always
// open the offer they were asked to decide.
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { z } from 'zod';
import { hasAny, vacancyVisible } from '../access.js';
import { principal } from '../app.js';
import { audit } from '../audit.js';
import { withTenant, type Tx } from '../db.js';
import { AppError, forbidden, notFound } from '../errors.js';
import { createTask, notifyUser } from '../notifications.js';
import { can, type Principal } from '../permissions.js';
import { moveStage, stageByCode } from '../pipeline.js';
import { idParams, pageQuery } from './common.js';

const MAX_APPROVERS = 5;
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.');
const today = () => new Date().toISOString().slice(0, 10);

const OfferFields = {
  offered_ctc: z.number().positive('Enter the offered annual CTC.').max(1_000_000_000),
  proposed_joining_date: isoDate,
  notes: z.string().trim().max(4000).nullable(),
};
const CreateBody = z.object({ offered_ctc: OfferFields.offered_ctc, proposed_joining_date: OfferFields.proposed_joining_date, notes: OfferFields.notes.default(null) });
// No defaults here: a default would overwrite fields the caller did not send.
const UpdateBody = z.object({ offered_ctc: OfferFields.offered_ctc, proposed_joining_date: OfferFields.proposed_joining_date, notes: OfferFields.notes }).partial();
const SubmitBody = z.object({ approver_user_ids: z.array(z.uuid()).min(1, 'Choose at least one approver.').max(MAX_APPROVERS) });
const DecisionBody = z
  .object({ decision: z.enum(['approved', 'rejected']), reason: z.string().trim().max(2000).optional() })
  .refine((b) => b.decision !== 'rejected' || !!b.reason, { path: ['reason'], message: 'Give a reason for rejecting.' });
const RespondBody = z
  .object({ response: z.enum(['accepted', 'declined']), reason: z.string().trim().max(2000).optional() })
  .refine((b) => b.response !== 'declined' || !!b.reason, { path: ['reason'], message: 'Say why the candidate declined.' });
const ReasonBody = z.object({ reason: z.string().trim().min(1, 'Give a reason.').max(2000) });
const JoiningBody = z
  .object({ status: z.enum(['expected', 'joined', 'delayed', 'backed_out']), joining_date: isoDate.optional(), reason: z.string().trim().max(2000).optional() })
  .refine((b) => !['delayed', 'backed_out'].includes(b.status) || !!b.reason, { path: ['reason'], message: 'Give a reason.' });
const ListQuery = pageQuery.extend({
  status: z.enum(['draft', 'pending_approval', 'approved', 'released', 'accepted', 'declined', 'withdrawn', 'open', 'all']).default('open'),
  application_id: z.uuid().optional(),
  waiting_on_me: z.enum(['true', 'false']).optional(),
});

const OPEN_STATUSES = ['draft', 'pending_approval', 'approved', 'released'] as const;
const JOINING_NEXT: Record<string, string[]> = {
  expected: ['joined', 'delayed', 'backed_out'],
  delayed: ['expected', 'joined', 'backed_out'],
  joined: [],
  backed_out: [],
};

const canSeeOffers = (p: Principal) => hasAny(p, 'offers.manage') || hasAny(p, 'offers.approve');

/** Offers the caller may open: on vacancies they can see, or that they were asked to approve. */
function offerVisible(p: Principal) {
  return (eb: any) =>
    eb.or([
      vacancyVisible(p, null)(eb),
      eb.exists(eb.selectFrom('offer_approvals as oa').select('oa.id').whereRef('oa.offer_id', '=', 'o.id').where('oa.approver_user_id', '=', p.userId)),
    ]);
}

function baseOffers(tx: Tx, p: Principal) {
  return tx
    .selectFrom('offers as o')
    .innerJoin('applications as a', 'a.id', 'o.application_id')
    .innerJoin('vacancies as v', 'v.id', 'a.vacancy_id')
    .innerJoin('requisitions as rq', 'rq.id', 'v.requisition_id')
    .innerJoin('candidates as c', 'c.id', 'a.candidate_id')
    .where(offerVisible(p));
}

async function loadOffer(tx: Tx, p: Principal, id: string, lock = false) {
  let q = baseOffers(tx, p)
    .select(['o.id', 'o.status', 'o.approval_round', 'o.created_by', 'o.application_id', 'o.offered_ctc', 'o.proposed_joining_date', 'a.status as application_status', 'a.stage_id', 'a.candidate_id', 'c.full_name as candidate_name', 'v.title as vacancy_title', 'rq.department_id'])
    .where('o.id', '=', id);
  if (lock) q = q.forUpdate('o');
  const o = await q.executeTakeFirst();
  if (!o) throw notFound('Offer');
  return o;
}

async function currentStep(tx: Tx, offerId: string, round: number) {
  return tx.selectFrom('offer_approvals').selectAll().where('offer_id', '=', offerId).where('round', '=', round).where('decision', '=', 'pending').orderBy('step_order').limit(1).executeTakeFirst();
}

/** Active users who hold offers.approve for the department (company-wide or that department). */
async function eligibleApprovers(tx: Tx, departmentId: string) {
  return tx
    .selectFrom('users as u')
    .innerJoin('user_role_assignments as ura', 'ura.user_id', 'u.id')
    .innerJoin('role_permissions as rp', 'rp.role_id', 'ura.role_id')
    .select(['u.id', 'u.full_name', 'u.email'])
    .distinct()
    .where('rp.permission_code', '=', 'offers.approve')
    .where('u.status', '=', 'active')
    .where((eb) => eb.or([eb('ura.department_id', 'is', null), eb('ura.department_id', '=', departmentId)]))
    .orderBy('u.full_name')
    .execute();
}

async function offerDetail(tx: Tx, p: Principal, id: string) {
  const o = await baseOffers(tx, p)
    .innerJoin('users as cb', 'cb.id', 'o.created_by')
    .innerJoin('pipeline_stages as st', 'st.id', 'a.stage_id')
    .selectAll('o')
    .select(['a.id as app_id', 'a.status as application_status', 'st.name as stage_name', 'c.id as candidate_id', 'c.full_name as candidate_name', 'v.id as vacancy_id', 'v.title as vacancy_title', 'v.vacancy_code', 'rq.department_id', 'cb.full_name as created_by_name'])
    .where('o.id', '=', id)
    .executeTakeFirst();
  if (!o) throw notFound('Offer');
  const approvals = await tx
    .selectFrom('offer_approvals as oa')
    .innerJoin('users as u', 'u.id', 'oa.approver_user_id')
    .select(['oa.id', 'oa.round', 'oa.step_order', 'oa.approver_user_id', 'u.full_name as approver_name', 'oa.decision', 'oa.reason', 'oa.decided_at'])
    .where('oa.offer_id', '=', id)
    .orderBy('oa.round', 'desc')
    .orderBy('oa.step_order')
    .execute();
  const step = o.status === 'pending_approval' ? await currentStep(tx, id, o.approval_round) : undefined;
  const joining = await tx.selectFrom('joining_records').select(['id', 'status', 'joining_date', 'reason', 'updated_at']).where('application_id', '=', o.application_id).where('offer_id', '=', id).executeTakeFirst();
  const manage = can(p, 'offers.manage', o.department_id);
  return {
    id: o.id, status: o.status, offered_ctc: o.offered_ctc, proposed_joining_date: o.proposed_joining_date, notes: o.notes,
    decline_reason: o.decline_reason, withdrawn_reason: o.withdrawn_reason, created_at: o.created_at, released_at: o.released_at, responded_at: o.responded_at,
    created_by: o.created_by, created_by_name: o.created_by_name, approval_round: o.approval_round, department_id: o.department_id,
    candidate: { id: o.candidate_id, full_name: o.candidate_name },
    vacancy: { id: o.vacancy_id, title: o.vacancy_title, code: o.vacancy_code },
    application: { id: o.app_id, status: o.application_status, stage_name: o.stage_name },
    approvals, current_approver_id: step?.approver_user_id ?? null, joining: joining ?? null,
    can: {
      edit: manage && o.status === 'draft',
      submit: manage && o.status === 'draft',
      decide: o.status === 'pending_approval' && step?.approver_user_id === p.userId && can(p, 'offers.approve', o.department_id),
      release: manage && o.status === 'approved',
      respond: manage && o.status === 'released',
      withdraw: manage && ['draft', 'pending_approval', 'approved', 'released'].includes(o.status),
    },
  };
}

export async function offerRoutes(app: FastifyInstance) {
  const { db } = app;
  const need = (p: Principal) => { if (!canSeeOffers(p)) throw forbidden(); };

  app.get('/offers/approvers', async (req) => {
    const p = principal(req);
    const { department_id } = z.object({ department_id: z.uuid() }).parse(req.query);
    if (!can(p, 'offers.manage', department_id)) throw forbidden();
    const rows = await withTenant(db, p.tenantId, (tx) => eligibleApprovers(tx, department_id));
    return { data: rows.filter((u) => u.id !== p.userId) };
  });

  app.get('/offers', async (req) => {
    const p = principal(req);
    need(p);
    const f = ListQuery.parse(req.query);
    return withTenant(db, p.tenantId, async (tx) => {
      let q = baseOffers(tx, p);
      if (f.status === 'open') q = q.where('o.status', 'in', [...OPEN_STATUSES]);
      else if (f.status !== 'all') q = q.where('o.status', '=', f.status);
      if (f.application_id) q = q.where('o.application_id', '=', f.application_id);
      if (f.waiting_on_me === 'true') {
        q = q.where((eb) => eb.exists(eb.selectFrom('offer_approvals as oa').select('oa.id').whereRef('oa.offer_id', '=', 'o.id').whereRef('oa.round', '=', 'o.approval_round').where('oa.approver_user_id', '=', p.userId).where('oa.decision', '=', 'pending')).and('o.status', '=', 'pending_approval'));
      }
      const { total } = await q.select(sql<number>`count(*)::int`.as('total')).executeTakeFirstOrThrow();
      const rows = await q
        .select(['o.id', 'o.status', 'o.offered_ctc', 'o.proposed_joining_date', 'o.created_at', 'c.id as candidate_id', 'c.full_name as candidate_name', 'v.id as vacancy_id', 'v.title as vacancy_title'])
        .orderBy('o.created_at', 'desc')
        .limit(f.page_size).offset((f.page - 1) * f.page_size)
        .execute();
      return { data: rows, page: f.page, page_size: f.page_size, total };
    });
  });

  app.get('/offers/:id', async (req) => {
    const p = principal(req);
    need(p);
    const { id } = idParams.parse(req.params);
    return { data: await withTenant(db, p.tenantId, (tx) => offerDetail(tx, p, id)) };
  });

  app.post('/applications/:id/offers', async (req, reply) => {
    const p = principal(req);
    if (!hasAny(p, 'offers.manage')) throw forbidden();
    const { id } = idParams.parse(req.params);
    const body = CreateBody.parse(req.body);
    const detail = await withTenant(db, p.tenantId, async (tx) => {
      const a = await tx
        .selectFrom('applications as a')
        .innerJoin('vacancies as v', 'v.id', 'a.vacancy_id')
        .innerJoin('requisitions as rq', 'rq.id', 'v.requisition_id')
        .select(['a.id', 'a.status', 'rq.department_id'])
        .where('a.id', '=', id)
        .where(vacancyVisible(p, null))
        .forUpdate('a')
        .executeTakeFirst();
      if (!a) throw notFound('Application');
      if (!can(p, 'offers.manage', a.department_id)) throw forbidden();
      if (a.status !== 'active') throw new AppError(409, 'APPLICATION_CLOSED', 'Offers can only be made to candidates still in the pipeline.');
      const open = await tx.selectFrom('offers').select('id').where('application_id', '=', id).where('status', 'in', [...OPEN_STATUSES]).executeTakeFirst();
      if (open) throw new AppError(409, 'OFFER_EXISTS', 'This candidate already has a live offer. Withdraw it first to make a new one.');
      const o = await tx.insertInto('offers').values({ tenant_id: p.tenantId, application_id: id, offered_ctc: body.offered_ctc, proposed_joining_date: body.proposed_joining_date, notes: body.notes, created_by: p.userId }).returning('id').executeTakeFirstOrThrow();
      await audit(tx, req, { tenantId: p.tenantId, actorUserId: p.userId, action: 'offer.created', entityType: 'offer', entityId: o.id, metadata: { application_id: id } });
      return offerDetail(tx, p, o.id);
    });
    return reply.status(201).send({ data: detail });
  });

  app.patch('/offers/:id', async (req) => {
    const p = principal(req);
    const { id } = idParams.parse(req.params);
    const body = UpdateBody.parse(req.body);
    return {
      data: await withTenant(db, p.tenantId, async (tx) => {
        const o = await loadOffer(tx, p, id, true);
        if (!can(p, 'offers.manage', o.department_id)) throw forbidden();
        if (o.status !== 'draft') throw new AppError(409, 'INVALID_STATE', 'Only a draft offer can be edited. Withdraw it and make a new one.');
        await tx.updateTable('offers').set({ ...body, updated_at: sql`now()` }).where('id', '=', id).execute();
        await audit(tx, req, { tenantId: p.tenantId, actorUserId: p.userId, action: 'offer.updated', entityType: 'offer', entityId: id, metadata: { fields: Object.keys(body) } });
        return offerDetail(tx, p, id);
      }),
    };
  });

  app.post('/offers/:id/submit-approval', async (req) => {
    const p = principal(req);
    const { id } = idParams.parse(req.params);
    const { approver_user_ids } = SubmitBody.parse(req.body);
    return {
      data: await withTenant(db, p.tenantId, async (tx) => {
        const o = await loadOffer(tx, p, id, true);
        if (!can(p, 'offers.manage', o.department_id)) throw forbidden();
        if (o.status !== 'draft') throw new AppError(409, 'INVALID_STATE', 'Only a draft offer can be sent for approval.');
        if (o.offered_ctc === null || o.proposed_joining_date === null) throw new AppError(422, 'OFFER_INCOMPLETE', 'Add the offered CTC and a joining date first.');
        if (o.proposed_joining_date < today()) throw new AppError(422, 'JOINING_DATE_PAST', 'The proposed joining date is in the past.');
        if (new Set(approver_user_ids).size !== approver_user_ids.length) throw new AppError(422, 'DUPLICATE_APPROVER', 'Each approver can appear only once.');
        if (approver_user_ids.includes(o.created_by)) throw new AppError(422, 'SELF_APPROVAL', 'The person who drafted an offer cannot approve it.');
        const eligible = new Set((await eligibleApprovers(tx, o.department_id)).map((u) => u.id));
        const invalid = approver_user_ids.filter((u) => !eligible.has(u));
        if (invalid.length) throw new AppError(422, 'INVALID_APPROVER', 'Some approvers cannot approve offers for this department.', { invalid });
        const round = o.approval_round + 1;
        await tx.insertInto('offer_approvals').values(approver_user_ids.map((u, i) => ({ tenant_id: p.tenantId, offer_id: id, round, step_order: i + 1, approver_user_id: u }))).execute();
        await tx.updateTable('offers').set({ status: 'pending_approval', approval_round: round, updated_at: sql`now()` }).where('id', '=', id).execute();
        await audit(tx, req, { tenantId: p.tenantId, actorUserId: p.userId, action: 'offer.submitted', entityType: 'offer', entityId: id, metadata: { round, approvers: approver_user_ids } });
        await notifyUser(tx, { tenantId: p.tenantId, userId: approver_user_ids[0]!, eventType: 'offer.approval_requested', dedupeKey: `offer_approval:${id}:${round}:1`, title: 'Offer awaiting your approval', body: `${o.candidate_name} · ${o.vacancy_title}`, link: `/offers/${id}` });
        await createTask(tx, { tenantId: p.tenantId, assigneeUserId: approver_user_ids[0]!, taskType: 'offer_approval', title: `Approve offer for ${o.candidate_name}`, entityType: 'offer', entityId: id, createdBy: p.userId });
        return offerDetail(tx, p, id);
      }),
    };
  });

  app.post('/offers/:id/approve', async (req) => {
    const p = principal(req);
    const { id } = idParams.parse(req.params);
    const body = DecisionBody.parse(req.body);
    return {
      data: await withTenant(db, p.tenantId, async (tx) => {
        const o = await loadOffer(tx, p, id, true);
        if (o.status !== 'pending_approval') throw new AppError(409, 'INVALID_STATE', 'This offer is not awaiting approval.');
        const step = await currentStep(tx, id, o.approval_round);
        if (!step || step.approver_user_id !== p.userId) throw new AppError(403, 'NOT_CURRENT_APPROVER', 'This offer is waiting on a different approver.');
        if (!can(p, 'offers.approve', o.department_id)) throw forbidden();
        await tx.updateTable('offer_approvals').set({ decision: body.decision, reason: body.reason || null, decided_at: sql`now()` }).where('id', '=', step.id).execute();
        await tx.updateTable('tasks').set({ completed_at: sql`now()` }).where('task_type', '=', 'offer_approval').where('entity_id', '=', id).where('assignee_user_id', '=', p.userId).where('completed_at', 'is', null).execute();

        let status: 'pending_approval' | 'approved' | 'draft' = 'pending_approval';
        let next: typeof step | undefined;
        if (body.decision === 'rejected') {
          status = 'draft'; // back to the drafter to revise and resubmit
          await tx.updateTable('offer_approvals').set({ decision: 'skipped', decided_at: sql`now()` }).where('offer_id', '=', id).where('round', '=', o.approval_round).where('decision', '=', 'pending').execute();
        } else {
          next = await currentStep(tx, id, o.approval_round);
          if (!next) status = 'approved';
        }
        if (status !== 'pending_approval') await tx.updateTable('offers').set({ status, updated_at: sql`now()` }).where('id', '=', id).execute();
        await audit(tx, req, { tenantId: p.tenantId, actorUserId: p.userId, action: body.decision === 'rejected' ? 'offer.rejected' : status === 'approved' ? 'offer.approved' : 'offer.step_approved', entityType: 'offer', entityId: id, metadata: { round: o.approval_round, step: step.step_order, reason: body.reason ?? null } });
        if (next) {
          await notifyUser(tx, { tenantId: p.tenantId, userId: next.approver_user_id, eventType: 'offer.approval_requested', dedupeKey: `offer_approval:${id}:${o.approval_round}:${next.step_order}`, title: 'Offer awaiting your approval', body: `${o.candidate_name} · ${o.vacancy_title}`, link: `/offers/${id}` });
          await createTask(tx, { tenantId: p.tenantId, assigneeUserId: next.approver_user_id, taskType: 'offer_approval', title: `Approve offer for ${o.candidate_name}`, entityType: 'offer', entityId: id, createdBy: p.userId });
        } else {
          await notifyUser(tx, { tenantId: p.tenantId, userId: o.created_by, eventType: body.decision === 'rejected' ? 'offer.rejected' : 'offer.approved', dedupeKey: `offer_decided:${id}:${o.approval_round}`, title: body.decision === 'rejected' ? 'Offer sent back' : 'Offer approved', body: `${o.candidate_name} · ${o.vacancy_title}${body.reason ? ` · ${body.reason}` : ''}`, link: `/offers/${id}` });
        }
        return offerDetail(tx, p, id);
      }),
    };
  });

  app.post('/offers/:id/release', async (req) => {
    const p = principal(req);
    const { id } = idParams.parse(req.params);
    return {
      data: await withTenant(db, p.tenantId, async (tx) => {
        const o = await loadOffer(tx, p, id, true);
        if (!can(p, 'offers.manage', o.department_id)) throw forbidden();
        if (o.status !== 'approved') throw new AppError(409, 'INVALID_STATE', 'Only an approved offer can be released.');
        if (o.application_status !== 'active') throw new AppError(409, 'APPLICATION_CLOSED', 'The candidate is no longer in the pipeline.');
        await tx.updateTable('offers').set({ status: 'released', released_at: sql`now()`, updated_at: sql`now()` }).where('id', '=', id).execute();
        // Show the candidate as being at the offer stage when the company's pipeline allows that move.
        const offerStage = await stageByCode(tx, 'offer');
        if (offerStage && offerStage.id !== o.stage_id) {
          try { await moveStage(tx, req, p, { id: o.application_id, status: o.application_status, stage_id: o.stage_id }, offerStage.id); }
          catch (err) { if (!(err instanceof AppError) || err.code !== 'TRANSITION_NOT_ALLOWED') throw err; }
        }
        await audit(tx, req, { tenantId: p.tenantId, actorUserId: p.userId, action: 'offer.released', entityType: 'offer', entityId: id });
        return offerDetail(tx, p, id);
      }),
    };
  });

  app.post('/offers/:id/respond', async (req) => {
    const p = principal(req);
    const { id } = idParams.parse(req.params);
    const body = RespondBody.parse(req.body);
    return {
      data: await withTenant(db, p.tenantId, async (tx) => {
        const o = await loadOffer(tx, p, id, true);
        if (!can(p, 'offers.manage', o.department_id)) throw forbidden();
        if (o.status !== 'released') throw new AppError(409, 'INVALID_STATE', 'Only a released offer can be accepted or declined.');
        await tx.updateTable('offers').set({ status: body.response, decline_reason: body.response === 'declined' ? body.reason! : null, responded_at: sql`now()`, updated_at: sql`now()` }).where('id', '=', id).execute();
        if (body.response === 'accepted') {
          await tx.insertInto('joining_records').values({ tenant_id: p.tenantId, application_id: o.application_id, offer_id: id, joining_date: o.proposed_joining_date, status: 'expected', updated_by: p.userId })
            .onConflict((oc) => oc.column('application_id').doUpdateSet({ offer_id: id, joining_date: o.proposed_joining_date, status: 'expected', reason: null, updated_by: p.userId, updated_at: sql`now()` })).execute();
          const due = o.proposed_joining_date ? new Date(`${o.proposed_joining_date}T09:00:00Z`) : null;
          const reminder = due ? new Date(Math.max(Date.now(), due.getTime() - 7 * 86_400_000)) : null;
          await createTask(tx, { tenantId: p.tenantId, assigneeUserId: o.created_by, taskType: 'joining_followup', title: `Confirm joining details with ${o.candidate_name}`, entityType: 'offer', entityId: id, dueAt: reminder, createdBy: p.userId });
        }
        await audit(tx, req, { tenantId: p.tenantId, actorUserId: p.userId, action: `offer.${body.response}`, entityType: 'offer', entityId: id, metadata: { reason: body.reason ?? null } });
        if (o.created_by !== p.userId) {
          await notifyUser(tx, { tenantId: p.tenantId, userId: o.created_by, eventType: `offer.${body.response}`, dedupeKey: `offer_response:${id}`, title: body.response === 'accepted' ? 'Offer accepted' : 'Offer declined', body: `${o.candidate_name} · ${o.vacancy_title}`, link: `/offers/${id}` });
        }
        return offerDetail(tx, p, id);
      }),
    };
  });

  app.post('/offers/:id/withdraw', async (req) => {
    const p = principal(req);
    const { id } = idParams.parse(req.params);
    const { reason } = ReasonBody.parse(req.body);
    return {
      data: await withTenant(db, p.tenantId, async (tx) => {
        const o = await loadOffer(tx, p, id, true);
        if (!can(p, 'offers.manage', o.department_id)) throw forbidden();
        if (!(OPEN_STATUSES as readonly string[]).includes(o.status)) throw new AppError(409, 'INVALID_STATE', 'This offer can no longer be withdrawn. If the candidate accepted, record their joining outcome instead.');
        await tx.updateTable('offers').set({ status: 'withdrawn', withdrawn_reason: reason, updated_at: sql`now()` }).where('id', '=', id).execute();
        await tx.updateTable('offer_approvals').set({ decision: 'skipped', decided_at: sql`now()` }).where('offer_id', '=', id).where('decision', '=', 'pending').execute();
        await tx.updateTable('tasks').set({ completed_at: sql`now()` }).where('entity_id', '=', id).where('task_type', 'in', ['offer_approval', 'joining_followup']).where('completed_at', 'is', null).execute();
        await audit(tx, req, { tenantId: p.tenantId, actorUserId: p.userId, action: 'offer.withdrawn', entityType: 'offer', entityId: id, metadata: { reason } });
        return offerDetail(tx, p, id);
      }),
    };
  });

  // ---- Joining ----

  app.get('/joining', async (req) => {
    const p = principal(req);
    need(p);
    const f = z.object({ status: z.enum(['expected', 'joined', 'delayed', 'backed_out', 'pending', 'all']).default('pending') }).parse(req.query);
    const rows = await withTenant(db, p.tenantId, async (tx) => {
      let q = tx
        .selectFrom('joining_records as j')
        .innerJoin('applications as a', 'a.id', 'j.application_id')
        .innerJoin('vacancies as v', 'v.id', 'a.vacancy_id')
        .innerJoin('requisitions as rq', 'rq.id', 'v.requisition_id')
        .innerJoin('candidates as c', 'c.id', 'a.candidate_id')
        .where(vacancyVisible(p, null));
      if (f.status === 'pending') q = q.where('j.status', 'in', ['expected', 'delayed']);
      else if (f.status !== 'all') q = q.where('j.status', '=', f.status);
      return q
        .select(['j.id', 'j.status', 'j.joining_date', 'j.reason', 'j.offer_id', 'c.id as candidate_id', 'c.full_name as candidate_name', 'v.title as vacancy_title'])
        .orderBy(sql`j.joining_date nulls last`).orderBy('c.full_name').limit(200).execute();
    });
    return { data: rows.map((r) => ({ ...r, overdue: ['expected', 'delayed'].includes(r.status) && r.joining_date !== null && r.joining_date < today() })) };
  });

  app.patch('/joining/:id', async (req) => {
    const p = principal(req);
    if (!hasAny(p, 'offers.manage')) throw forbidden();
    const { id } = idParams.parse(req.params);
    const body = JoiningBody.parse(req.body);
    return {
      data: await withTenant(db, p.tenantId, async (tx) => {
        const j = await tx
          .selectFrom('joining_records as j')
          .innerJoin('applications as a', 'a.id', 'j.application_id')
          .innerJoin('vacancies as v', 'v.id', 'a.vacancy_id')
          .innerJoin('requisitions as rq', 'rq.id', 'v.requisition_id')
          .innerJoin('candidates as c', 'c.id', 'a.candidate_id')
          .select(['j.id', 'j.status', 'j.offer_id', 'j.application_id', 'a.status as application_status', 'a.stage_id', 'rq.department_id', 'c.full_name as candidate_name', 'v.title as vacancy_title'])
          .where('j.id', '=', id)
          .where(vacancyVisible(p, null))
          .forUpdate('j')
          .executeTakeFirst();
        if (!j) throw notFound('Joining record');
        if (!can(p, 'offers.manage', j.department_id)) throw forbidden();
        if (!JOINING_NEXT[j.status]!.includes(body.status)) throw new AppError(409, 'INVALID_STATE', `A joining marked "${j.status.replace('_', ' ')}" cannot be changed to "${body.status.replace('_', ' ')}".`);

        const app0 = { id: j.application_id, status: j.application_status, stage_id: j.stage_id };
        if (body.status === 'joined') {
          const hired = await stageByCode(tx, 'hired');
          if (!hired) throw new AppError(422, 'NO_HIRED_STAGE', 'This company has no Hired stage.');
          try { await moveStage(tx, req, p, app0, hired.id, null); }
          catch (err) {
            if (err instanceof AppError && err.code === 'TRANSITION_NOT_ALLOWED') throw new AppError(422, 'NOT_READY_TO_HIRE', 'The pipeline does not allow hiring from the candidate\'s current stage. Move them along the pipeline first (for example to Offer).');
            throw err;
          }
        } else if (body.status === 'backed_out') {
          const withdrawn = await stageByCode(tx, 'withdrawn');
          if (!withdrawn) throw new AppError(422, 'NO_WITHDRAWN_STAGE', 'This company has no Withdrawn stage.');
          await moveStage(tx, req, p, app0, withdrawn.id, `Backed out before joining: ${body.reason}`);
        }
        await tx.updateTable('joining_records').set({ status: body.status, ...(body.joining_date ? { joining_date: body.joining_date } : {}), reason: body.reason ?? null, updated_by: p.userId, updated_at: sql`now()` }).where('id', '=', id).execute();
        if (body.status === 'joined' || body.status === 'backed_out') {
          await tx.updateTable('tasks').set({ completed_at: sql`now()` }).where('task_type', '=', 'joining_followup').where('entity_id', '=', j.offer_id).where('completed_at', 'is', null).execute();
        }
        await audit(tx, req, { tenantId: p.tenantId, actorUserId: p.userId, action: `joining.${body.status}`, entityType: 'joining_record', entityId: id, metadata: { reason: body.reason ?? null, joining_date: body.joining_date ?? null } });
        if (j.offer_id && ['delayed', 'backed_out'].includes(body.status)) {
          const offer = await tx.selectFrom('offers').select('created_by').where('id', '=', j.offer_id).executeTakeFirst();
          if (offer && offer.created_by !== p.userId) {
            await notifyUser(tx, { tenantId: p.tenantId, userId: offer.created_by, eventType: `joining.${body.status}`, dedupeKey: `joining:${id}:${body.status}:${body.joining_date ?? ''}`, title: body.status === 'delayed' ? 'Joining delayed' : 'Candidate backed out', body: `${j.candidate_name} · ${j.vacancy_title} · ${body.reason}`, link: `/offers/${j.offer_id}` });
          }
        }
        return tx.selectFrom('joining_records').select(['id', 'status', 'joining_date', 'reason', 'offer_id', 'updated_at']).where('id', '=', id).executeTakeFirstOrThrow();
      }),
    };
  });
}
