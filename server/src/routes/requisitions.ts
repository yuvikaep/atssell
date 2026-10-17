import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { z } from 'zod';
import { canSeeRequisitionBudget, requisitionVisible, scopeOf } from '../access.js';
import { principal } from '../app.js';
import { audit } from '../audit.js';
import { withTenant, type Tx } from '../db.js';
import { AppError, forbidden, notFound } from '../errors.js';
import { createTask, notifyUser } from '../notifications.js';
import { can, requirePermission, type Principal } from '../permissions.js';
import { idParams, pageQuery } from './common.js';

export const EMPLOYMENT_TYPES = ['full_time', 'part_time', 'contract', 'internship', 'temporary'] as const;
const PRIORITIES = ['low', 'normal', 'high', 'critical'] as const;
const MAX_APPROVERS = 5;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.');

// No defaults here: a partial update must only touch the fields it sends (Zod applies defaults
// even inside .partial()). Create adds its defaults below.
const requisitionShape = {
  department_id: z.uuid(),
  title: z.string().trim().min(2).max(200),
  description: z.string().trim().min(10, 'Add a short job description.').max(20_000),
  headcount: z.number().int().min(1).max(1000),
  employment_type: z.enum(EMPLOYMENT_TYPES),
  location: z.string().trim().min(1).max(200),
  skills: z.array(z.string().trim().min(1).max(60)).max(50),
  min_experience_years: z.number().min(0).max(60).nullable(),
  max_experience_years: z.number().min(0).max(60).nullable(),
  min_ctc: z.number().min(0).max(1e11).nullable(),
  max_ctc: z.number().min(0).max(1e11).nullable(),
  priority: z.enum(PRIORITIES),
  target_date: isoDate.nullable(),
  hiring_manager_id: z.uuid().nullable(),
};

type Ranges = Partial<Record<'min_experience_years' | 'max_experience_years' | 'min_ctc' | 'max_ctc', number | null>>;

function checkRanges(b: Ranges) {
  const issues: { path: string; message: string }[] = [];
  if (b.min_experience_years != null && b.max_experience_years != null && b.max_experience_years < b.min_experience_years) {
    issues.push({ path: 'max_experience_years', message: 'Maximum experience must be at least the minimum.' });
  }
  if (b.min_ctc != null && b.max_ctc != null && b.max_ctc < b.min_ctc) {
    issues.push({ path: 'max_ctc', message: 'Maximum CTC must be at least the minimum.' });
  }
  if (issues.length) throw new AppError(400, 'VALIDATION_ERROR', 'Some fields are invalid.', issues);
}

const CreateBody = z.object({
  ...requisitionShape,
  skills: requisitionShape.skills.default([]),
  min_experience_years: requisitionShape.min_experience_years.default(null),
  max_experience_years: requisitionShape.max_experience_years.default(null),
  min_ctc: requisitionShape.min_ctc.default(null),
  max_ctc: requisitionShape.max_ctc.default(null),
  priority: requisitionShape.priority.default('normal'),
  target_date: requisitionShape.target_date.default(null),
  hiring_manager_id: requisitionShape.hiring_manager_id.default(null),
}).superRefine((b, ctx) => {
  if (b.target_date && b.target_date < new Date().toISOString().slice(0, 10)) {
    ctx.addIssue({ code: 'custom', path: ['target_date'], message: 'Target date cannot be in the past.' });
  }
});
const UpdateBody = z.object(requisitionShape).partial().superRefine((b, ctx) => {
  if (b.target_date && b.target_date < new Date().toISOString().slice(0, 10)) {
    ctx.addIssue({ code: 'custom', path: ['target_date'], message: 'Target date cannot be in the past.' });
  }
}).refine((b) => Object.keys(b).length > 0, 'Provide at least one field to update.');

const ListQuery = pageQuery.extend({
  status: z.enum(['draft', 'pending_approval', 'approved', 'rejected', 'cancelled', 'all']).default('all'),
  department_id: z.uuid().optional(),
  mine: z.enum(['true', 'false']).optional(),
  q: z.string().trim().max(200).optional(),
});

const SubmitBody = z.object({
  approver_user_ids: z.array(z.uuid()).min(1, 'Choose at least one approver.').max(MAX_APPROVERS),
});
const DecisionBody = z
  .object({ decision: z.enum(['approved', 'rejected']), reason: z.string().trim().max(2000).optional() })
  .refine((b) => b.decision !== 'rejected' || (b.reason && b.reason.length > 0), {
    path: ['reason'],
    message: 'Give a reason for rejecting.',
  });
const CancelBody = z.object({ reason: z.string().trim().min(1, 'Give a reason for cancelling.').max(2000) });

/** Active users who hold requisitions.approve for the department (company-wide or for that department). */
export async function eligibleApprovers(tx: Tx, departmentId: string) {
  return tx
    .selectFrom('users as u')
    .innerJoin('user_role_assignments as ura', 'ura.user_id', 'u.id')
    .innerJoin('role_permissions as rp', 'rp.role_id', 'ura.role_id')
    .select(['u.id', 'u.full_name', 'u.email'])
    .distinct()
    .where('rp.permission_code', '=', 'requisitions.approve')
    .where('u.status', '=', 'active')
    .where((eb) => eb.or([eb('ura.department_id', 'is', null), eb('ura.department_id', '=', departmentId)]))
    .orderBy('u.full_name')
    .execute();
}

/** Tells the approver whose turn it is, with a to-do that clears when they decide. */
async function askApprover(tx: Tx, p: Principal, rq: { id: string; title: string }, round: number, step: number, approverId: string) {
  await notifyUser(tx, {
    tenantId: p.tenantId, userId: approverId, eventType: 'requisition.approval_requested', dedupeKey: `requisition_approval:${rq.id}:${round}:${step}`,
    title: 'Requisition awaiting your approval', body: rq.title, link: `/requisitions/${rq.id}`,
  });
  await createTask(tx, { tenantId: p.tenantId, assigneeUserId: approverId, taskType: 'requisition_approval', title: `Approve requisition: ${rq.title}`, entityType: 'requisition', entityId: rq.id, createdBy: p.userId });
}

async function assertActiveDepartment(tx: Tx, id: string) {
  const d = await tx.selectFrom('departments').select('status').where('id', '=', id).executeTakeFirst();
  if (!d || d.status !== 'active') throw new AppError(422, 'INVALID_DEPARTMENT', 'Department was not found or is inactive.');
}

async function assertActiveUser(tx: Tx, id: string, what: string) {
  const u = await tx.selectFrom('users').select('status').where('id', '=', id).executeTakeFirst();
  if (!u || u.status !== 'active') throw new AppError(422, 'INVALID_USER', `${what} was not found or is inactive.`);
}

async function loadForUpdate(tx: Tx, p: Principal, id: string) {
  const rq = await tx
    .selectFrom('requisitions as rq')
    .selectAll('rq')
    .where('rq.id', '=', id)
    .where(requisitionVisible(p))
    .forUpdate()
    .executeTakeFirst();
  if (!rq) throw notFound('Requisition');
  return rq;
}

function canEdit(p: Principal, rq: { requested_by: string; department_id: string }) {
  return rq.requested_by === p.userId || can(p, 'requisitions.create', rq.department_id);
}

async function currentStep(tx: Tx, requisitionId: string, round: number) {
  return tx
    .selectFrom('requisition_approvals')
    .selectAll()
    .where('requisition_id', '=', requisitionId)
    .where('round', '=', round)
    .where('decision', '=', 'pending')
    .orderBy('step_order')
    .limit(1)
    .executeTakeFirst();
}

export async function requisitionDetail(tx: Tx, p: Principal, id: string) {
  const rq = await tx
    .selectFrom('requisitions as rq')
    .innerJoin('departments as d', 'd.id', 'rq.department_id')
    .innerJoin('users as req', 'req.id', 'rq.requested_by')
    .leftJoin('users as hm', 'hm.id', 'rq.hiring_manager_id')
    .selectAll('rq')
    .select(['d.name as department_name', 'req.full_name as requested_by_name', 'hm.full_name as hiring_manager_name'])
    .where('rq.id', '=', id)
    .where(requisitionVisible(p))
    .executeTakeFirst();
  if (!rq) throw notFound('Requisition');

  const approvals = await tx
    .selectFrom('requisition_approvals as ra')
    .innerJoin('users as u', 'u.id', 'ra.approver_user_id')
    .select(['ra.id', 'ra.round', 'ra.step_order', 'ra.approver_user_id', 'u.full_name as approver_name', 'ra.decision', 'ra.reason', 'ra.decided_at'])
    .where('ra.requisition_id', '=', id)
    .orderBy('ra.round', 'desc')
    .orderBy('ra.step_order')
    .execute();

  const vacancies = await tx
    .selectFrom('vacancies')
    .select(['id', 'vacancy_code', 'title', 'location', 'headcount', 'status', 'opened_at'])
    .where('requisition_id', '=', id)
    .orderBy('opened_at')
    .execute();

  const step = rq.status === 'pending_approval' ? await currentStep(tx, id, rq.approval_round) : undefined;
  const allocated = vacancies.filter((v) => v.status !== 'cancelled').reduce((n, v) => n + v.headcount, 0);
  const budgetVisible = canSeeRequisitionBudget(p, rq.department_id, rq.requested_by);
  const editable = canEdit(p, rq);

  const { min_ctc, max_ctc, ...rest } = rq;
  return {
    ...rest,
    ...(budgetVisible ? { min_ctc, max_ctc } : {}),
    approvals,
    current_approver_id: step?.approver_user_id ?? null,
    vacancies,
    headcount_allocated: allocated,
    can: {
      edit: editable && (rq.status === 'draft' || rq.status === 'rejected'),
      submit: editable && (rq.status === 'draft' || rq.status === 'rejected'),
      decide: step?.approver_user_id === p.userId && can(p, 'requisitions.approve', rq.department_id),
      cancel: editable && rq.status !== 'cancelled',
      open_vacancy: rq.status === 'approved' && can(p, 'vacancies.manage', rq.department_id) && allocated < rq.headcount,
    },
  };
}

export async function requisitionRoutes(app: FastifyInstance) {
  const { db } = app;

  app.get('/requisitions', async (req) => {
    const p = principal(req);
    const { page, page_size, status, department_id, mine, q } = ListQuery.parse(req.query);
    return withTenant(db, p.tenantId, async (tx) => {
      let base = tx
        .selectFrom('requisitions as rq')
        .innerJoin('departments as d', 'd.id', 'rq.department_id')
        .leftJoin('users as hm', 'hm.id', 'rq.hiring_manager_id')
        .where(requisitionVisible(p));
      if (status !== 'all') base = base.where('rq.status', '=', status);
      if (department_id) base = base.where('rq.department_id', '=', department_id);
      if (mine === 'true') {
        base = base.where((eb) => eb.or([eb('rq.requested_by', '=', p.userId), eb('rq.hiring_manager_id', '=', p.userId)]));
      }
      if (q) base = base.where('rq.title', 'ilike', `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);

      const { total } = await base.select(sql<number>`count(*)::int`.as('total')).executeTakeFirstOrThrow();
      const rows = await base
        .select((eb) => [
          'rq.id', 'rq.title', 'rq.status', 'rq.headcount', 'rq.location', 'rq.priority', 'rq.target_date',
          'rq.department_id', 'd.name as department_name', 'hm.full_name as hiring_manager_name', 'rq.created_at',
          eb.selectFrom('requisition_approvals as ra')
            .innerJoin('users as au', 'au.id', 'ra.approver_user_id')
            .select('au.full_name')
            .whereRef('ra.requisition_id', '=', 'rq.id')
            .whereRef('ra.round', '=', 'rq.approval_round')
            .where('ra.decision', '=', 'pending')
            .orderBy('ra.step_order')
            .limit(1)
            .as('pending_with'),
        ])
        .orderBy('rq.created_at', 'desc')
        .limit(page_size)
        .offset((page - 1) * page_size)
        .execute();
      return { data: rows, page, page_size, total };
    });
  });

  app.get('/requisitions/approvers', async (req) => {
    const p = principal(req);
    const { department_id } = z.object({ department_id: z.uuid() }).parse(req.query);
    if (!can(p, 'requisitions.create', department_id)) throw forbidden();
    const rows = await withTenant(db, p.tenantId, (tx) => eligibleApprovers(tx, department_id));
    return { data: rows.filter((u) => u.id !== p.userId) };
  });

  app.get('/requisitions/:id', async (req) => {
    const p = principal(req);
    const { id } = idParams.parse(req.params);
    return { data: await withTenant(db, p.tenantId, (tx) => requisitionDetail(tx, p, id)) };
  });

  app.post('/requisitions', async (req, reply) => {
    const p = principal(req);
    if (!scopeOf(p, ['requisitions.create'])) throw forbidden();
    const body = CreateBody.parse(req.body);
    checkRanges(body);
    requirePermission(p, 'requisitions.create', body.department_id);

    const detail = await withTenant(db, p.tenantId, async (tx) => {
      await assertActiveDepartment(tx, body.department_id);
      if (body.hiring_manager_id) await assertActiveUser(tx, body.hiring_manager_id, 'Hiring manager');
      const rq = await tx
        .insertInto('requisitions')
        .values({ ...body, tenant_id: p.tenantId, requested_by: p.userId })
        .returning('id')
        .executeTakeFirstOrThrow();
      await audit(tx, req, {
        tenantId: p.tenantId, actorUserId: p.userId, action: 'requisition.created', entityType: 'requisition', entityId: rq.id,
        metadata: { title: body.title, department_id: body.department_id, headcount: body.headcount },
      });
      return requisitionDetail(tx, p, rq.id);
    });
    return reply.status(201).send({ data: detail });
  });

  app.patch('/requisitions/:id', async (req) => {
    const p = principal(req);
    const { id } = idParams.parse(req.params);
    const body = UpdateBody.parse(req.body);

    const detail = await withTenant(db, p.tenantId, async (tx) => {
      const rq = await loadForUpdate(tx, p, id);
      if (!canEdit(p, rq)) throw forbidden();
      if (rq.status !== 'draft' && rq.status !== 'rejected') {
        throw new AppError(409, 'NOT_EDITABLE', 'Only draft or rejected requisitions can be edited.');
      }
      checkRanges({ ...rq, ...body });
      if (body.department_id && body.department_id !== rq.department_id) {
        requirePermission(p, 'requisitions.create', body.department_id);
        await assertActiveDepartment(tx, body.department_id);
      }
      if (body.hiring_manager_id && body.hiring_manager_id !== rq.hiring_manager_id) {
        await assertActiveUser(tx, body.hiring_manager_id, 'Hiring manager');
      }
      await tx.updateTable('requisitions').set(body).where('id', '=', id).execute();
      await audit(tx, req, {
        tenantId: p.tenantId, actorUserId: p.userId, action: 'requisition.updated', entityType: 'requisition', entityId: id,
        metadata: { fields: Object.keys(body) },
      });
      return requisitionDetail(tx, p, id);
    });
    return { data: detail };
  });

  app.post('/requisitions/:id/submit-approval', async (req) => {
    const p = principal(req);
    const { id } = idParams.parse(req.params);
    const { approver_user_ids } = SubmitBody.parse(req.body);
    if (new Set(approver_user_ids).size !== approver_user_ids.length) {
      throw new AppError(422, 'DUPLICATE_APPROVER', 'Each approver can appear only once.');
    }

    const detail = await withTenant(db, p.tenantId, async (tx) => {
      const rq = await loadForUpdate(tx, p, id);
      if (!canEdit(p, rq)) throw forbidden();
      if (rq.status !== 'draft' && rq.status !== 'rejected') {
        throw new AppError(409, 'INVALID_STATE', 'Only draft or rejected requisitions can be submitted.');
      }
      if (approver_user_ids.includes(rq.requested_by)) {
        throw new AppError(422, 'SELF_APPROVAL', 'The person who raised a requisition cannot approve it.');
      }
      const eligible = new Set((await eligibleApprovers(tx, rq.department_id)).map((u) => u.id));
      const invalid = approver_user_ids.filter((u) => !eligible.has(u));
      if (invalid.length) {
        throw new AppError(422, 'INVALID_APPROVER', 'Some approvers cannot approve requisitions for this department.', { invalid });
      }

      const round = rq.approval_round + 1;
      await tx
        .insertInto('requisition_approvals')
        .values(approver_user_ids.map((approver, i) => ({
          tenant_id: p.tenantId, requisition_id: id, round, step_order: i + 1, approver_user_id: approver,
        })))
        .execute();
      await tx.updateTable('requisitions').set({ status: 'pending_approval', approval_round: round }).where('id', '=', id).execute();
      await audit(tx, req, {
        tenantId: p.tenantId, actorUserId: p.userId, action: 'requisition.submitted', entityType: 'requisition', entityId: id,
        metadata: { round, approvers: approver_user_ids },
      });
      await askApprover(tx, p, { id, title: rq.title }, round, 1, approver_user_ids[0]!);
      return requisitionDetail(tx, p, id);
    });
    return { data: detail };
  });

  // Approve or reject the current step. Matches api_contract.md: POST /requisitions/{id}/approve.
  app.post('/requisitions/:id/approve', async (req) => {
    const p = principal(req);
    const { id } = idParams.parse(req.params);
    const body = DecisionBody.parse(req.body);

    const detail = await withTenant(db, p.tenantId, async (tx) => {
      const rq = await loadForUpdate(tx, p, id);
      if (rq.status !== 'pending_approval') throw new AppError(409, 'INVALID_STATE', 'This requisition is not awaiting approval.');
      const step = await currentStep(tx, id, rq.approval_round);
      if (!step || step.approver_user_id !== p.userId) {
        throw new AppError(403, 'NOT_CURRENT_APPROVER', 'This requisition is waiting on a different approver.');
      }
      requirePermission(p, 'requisitions.approve', rq.department_id);

      await tx
        .updateTable('requisition_approvals')
        .set({ decision: body.decision, reason: body.reason || null, decided_at: sql`now()` })
        .where('id', '=', step.id)
        .execute();

      let status: 'pending_approval' | 'approved' | 'rejected' = 'pending_approval';
      if (body.decision === 'rejected') {
        status = 'rejected';
        await tx
          .updateTable('requisition_approvals')
          .set({ decision: 'skipped', decided_at: sql`now()` })
          .where('requisition_id', '=', id)
          .where('round', '=', rq.approval_round)
          .where('decision', '=', 'pending')
          .execute();
      } else if (!(await currentStep(tx, id, rq.approval_round))) {
        status = 'approved';
      }
      if (status !== 'pending_approval') {
        await tx.updateTable('requisitions').set({ status }).where('id', '=', id).execute();
      }
      await tx.updateTable('tasks').set({ completed_at: sql`now()` }).where('task_type', '=', 'requisition_approval').where('entity_id', '=', id).where('assignee_user_id', '=', p.userId).where('completed_at', 'is', null).execute();
      if (status === 'pending_approval') {
        const next = await currentStep(tx, id, rq.approval_round);
        if (next) await askApprover(tx, p, { id, title: rq.title }, rq.approval_round, next.step_order, next.approver_user_id);
      } else {
        await notifyUser(tx, {
          tenantId: p.tenantId, userId: rq.requested_by, eventType: status === 'approved' ? 'requisition.approved' : 'requisition.rejected',
          dedupeKey: `requisition_decided:${id}:${rq.approval_round}`, title: status === 'approved' ? 'Requisition approved' : 'Requisition rejected',
          body: `${rq.title}${body.reason ? ` · ${body.reason}` : ''}`, link: `/requisitions/${id}`,
        });
      }
      await audit(tx, req, {
        tenantId: p.tenantId, actorUserId: p.userId,
        action: body.decision === 'rejected' ? 'requisition.rejected' : status === 'approved' ? 'requisition.approved' : 'requisition.step_approved',
        entityType: 'requisition', entityId: id,
        metadata: { round: rq.approval_round, step: step.step_order, reason: body.reason ?? null },
      });
      return requisitionDetail(tx, p, id);
    });
    return { data: detail };
  });

  app.post('/requisitions/:id/cancel', async (req) => {
    const p = principal(req);
    const { id } = idParams.parse(req.params);
    const { reason } = CancelBody.parse(req.body);

    const detail = await withTenant(db, p.tenantId, async (tx) => {
      const rq = await loadForUpdate(tx, p, id);
      if (!canEdit(p, rq)) throw forbidden();
      if (rq.status === 'cancelled') throw new AppError(409, 'INVALID_STATE', 'This requisition is already cancelled.');
      const open = await tx
        .selectFrom('vacancies')
        .select('id')
        .where('requisition_id', '=', id)
        .where('status', 'in', ['open', 'on_hold'])
        .executeTakeFirst();
      if (open) throw new AppError(409, 'HAS_OPEN_VACANCIES', 'Close or cancel its open vacancies first.');

      await tx
        .updateTable('requisition_approvals')
        .set({ decision: 'skipped', decided_at: sql`now()` })
        .where('requisition_id', '=', id)
        .where('decision', '=', 'pending')
        .execute();
      await tx.updateTable('requisitions').set({ status: 'cancelled', cancel_reason: reason }).where('id', '=', id).execute();
      await audit(tx, req, {
        tenantId: p.tenantId, actorUserId: p.userId, action: 'requisition.cancelled', entityType: 'requisition', entityId: id,
        metadata: { reason, previous_status: rq.status },
      });
      return requisitionDetail(tx, p, id);
    });
    return { data: detail };
  });
}
