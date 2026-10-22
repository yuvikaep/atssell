import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { z } from 'zod';
import { hasAny, vacancyVisible, interviewedApplication, isOnAnyPanel } from '../access.js';
import { principal } from '../app.js';
import { audit } from '../audit.js';
import type { EvaluationTemplate } from '../db-types.js';
import { pgConstraint, pgErrorCode, withTenant, type Tx } from '../db.js';
import { AppError, forbidden, notFound } from '../errors.js';
import {
  canReadInterviews, competenciesSchema, DEFAULT_COMPETENCIES, feedbackDueAt, interviewBase, isValidTimezone, linkState, loadInterview,
  MODES, recordInterviewEvent, toTemplate,
} from '../interviews.js';
import { createTask, notify, notifyUser } from '../notifications.js';
import { can, requirePermission, type Principal } from '../permissions.js';
import { idParams, pageQuery } from './common.js';

const isoDateTime = z.iso.datetime({ offset: true }).transform((v) => new Date(v));

const PanelMember = z
  .object({ user_id: z.uuid().optional(), name: z.string().trim().min(1).max(200).optional(), email: z.email().trim().toLowerCase().optional() })
  .refine((m) => !!m.user_id || (!!m.name && !!m.email), 'Choose a colleague, or give an external interviewer a name and email.');

const InterviewFields = {
  round_name: z.string().trim().min(1).max(120),
  mode: z.enum(MODES),
  scheduled_start: isoDateTime.nullable(),
  scheduled_end: isoDateTime.nullable(),
  timezone: z.string().refine(isValidTimezone, 'Unknown time zone.'),
  meeting_url: z.url({ protocol: /^https?$/ }).max(500).nullable(),
  location_instructions: z.string().trim().max(1000).nullable(),
};

const NextRoundBody = z.object({
  round_name: z.string().trim().min(1, 'Name the round.').max(120).default('Next round'),
  mode: z.enum(MODES).default('google_meet'),
  interviewer_user_ids: z.array(z.uuid()).min(1, 'Choose who should interview.').max(6),
  remark: z.string().trim().min(1, 'Add a remark for the recruiter and interviewers.').max(2000),
});

const CreateBody = z
  .object({
    interview_plan_id: z.uuid().nullish(),
    round_name: InterviewFields.round_name.optional(),
    mode: InterviewFields.mode,
    scheduled_start: InterviewFields.scheduled_start.default(null),
    scheduled_end: InterviewFields.scheduled_end.default(null),
    timezone: InterviewFields.timezone.default('Asia/Kolkata'),
    meeting_url: InterviewFields.meeting_url.default(null),
    location_instructions: InterviewFields.location_instructions.default(null),
    competencies: competenciesSchema.optional(),
    panel: z.array(PanelMember).max(12).default([]),
  })
  .superRefine((b, ctx) => {
    if (!b.interview_plan_id && !b.round_name) ctx.addIssue({ code: 'custom', path: ['round_name'], message: 'Name the round, or pick one from the plan.' });
    if ((b.scheduled_start === null) !== (b.scheduled_end === null)) ctx.addIssue({ code: 'custom', path: ['scheduled_end'], message: 'Give both a start and an end time.' });
    if (b.scheduled_start && b.scheduled_end && b.scheduled_end <= b.scheduled_start) ctx.addIssue({ code: 'custom', path: ['scheduled_end'], message: 'The end must be after the start.' });
  });

const UpdateBody = z
  .object({
    round_name: InterviewFields.round_name,
    mode: InterviewFields.mode,
    scheduled_start: isoDateTime,
    scheduled_end: isoDateTime,
    timezone: InterviewFields.timezone,
    meeting_url: InterviewFields.meeting_url,
    location_instructions: InterviewFields.location_instructions,
    reason: z.string().trim().max(1000),
  })
  .partial()
  .refine((b) => Object.keys(b).length > 0, 'Provide at least one field to update.');

const ReasonBody = z.object({ reason: z.string().trim().min(1, 'Give a reason.').max(1000) });
const OptionalReason = z.object({ reason: z.string().trim().max(1000).optional() });

const PlanBody = z.object({ name: z.string().trim().min(1).max(120), competencies: competenciesSchema });
const PlanUpdate = z
  .object({ name: z.string().trim().min(1).max(120), competencies: competenciesSchema, is_active: z.boolean() })
  .partial()
  .refine((b) => Object.keys(b).length > 0, 'Provide at least one field to update.');

const ListQuery = pageQuery.extend({
  from: isoDateTime.optional(),
  to: isoDateTime.optional(),
  status: z.enum(['draft', 'scheduled', 'confirmed', 'completed', 'cancelled', 'no_show']).optional(),
  mode: z.enum(MODES).optional(),
  vacancy_id: z.uuid().optional(),
  candidate_id: z.uuid().optional(),
  interviewer_id: z.uuid().optional(),
  feedback: z.enum(['pending', 'submitted', 'overdue']).optional(),
  page_size: z.coerce.number().int().min(1).max(200).default(50),
});

const PanelParams = z.object({ id: z.uuid(), interviewerId: z.uuid() });

async function assertInternalActiveUser(tx: Tx, userId: string) {
  const u = await tx
    .selectFrom('users as u')
    .leftJoin('agency_members as am', 'am.user_id', 'u.id')
    .select(['u.status', 'am.id as agency_member_id'])
    .where('u.id', '=', userId)
    .executeTakeFirst();
  if (!u || u.status !== 'active') throw new AppError(422, 'INVALID_USER', 'That colleague was not found or is inactive.');
  if (u.agency_member_id) throw new AppError(422, 'AGENCY_USER', 'Agency members cannot be interviewers. Add them as an external interviewer.');
}

/** Adds one person to a panel. Returns the interviewer row. */
async function addPanelist(tx: Tx, tenantId: string, interviewId: string, m: z.infer<typeof PanelMember>) {
  if (m.user_id) await assertInternalActiveUser(tx, m.user_id);
  return tx
    .insertInto('interviewers')
    .values({
      tenant_id: tenantId,
      interview_id: interviewId,
      user_id: m.user_id ?? null,
      external_name: m.user_id ? null : m.name ?? null,
      external_email: m.user_id ? null : m.email ?? null,
    })
    .returning('id')
    .executeTakeFirstOrThrow()
    .catch((err: unknown) => {
      if (pgErrorCode(err) === '23505' && ['uq_interviewers_user', 'uq_interviewers_email'].includes(pgConstraint(err) ?? '')) {
        throw new AppError(409, 'DUPLICATE_PANELIST', 'This person is already on the panel.');
      }
      throw err;
    });
}

/** Revokes every active link of an interviewer, including ones that have expired but not been marked. */
export async function revokeActiveLinks(tx: Tx, interviewerIds: string[], actorUserId: string | null) {
  if (interviewerIds.length === 0) return 0;
  const res = await tx
    .updateTable('feedback_links')
    .set({ status: 'revoked', revoked_at: sql`now()`, revoked_by: actorUserId })
    .where('interviewer_id', 'in', interviewerIds)
    .where('status', '=', 'active')
    .executeTakeFirst();
  return Number(res.numUpdatedRows);
}

async function notifyPanel(
  tx: Tx, p: Principal, interviewId: string, what: { type: string; title: string; body: string },
) {
  const panel = await tx.selectFrom('interviewers').select(['id', 'user_id']).where('interview_id', '=', interviewId).where('user_id', 'is not', null).execute();
  const stamp = Date.now();
  for (const m of panel) {
    if (m.user_id === p.userId) continue;
    await notify(tx, {
      tenantId: p.tenantId, userId: m.user_id, eventType: what.type, dedupeKey: `${what.type}:${interviewId}:${m.id}:${stamp}`,
      title: what.title, body: what.body, link: `/my-interviews`, email_too: false,
    });
  }
}

/** The hiring manager's remark when this round was requested as a next round, if it was. */
export async function nextRoundRequest(tx: Tx, interviewId: string) {
  const e = await tx
    .selectFrom('interview_events as e')
    .leftJoin('users as u', 'u.id', 'e.actor_user_id')
    .select(['e.reason', 'e.created_at', 'u.full_name as by'])
    .where('e.interview_id', '=', interviewId).where('e.event_type', '=', 'next_round_requested')
    .orderBy('e.created_at', 'desc').limit(1).executeTakeFirst();
  return e ? { remark: e.reason, by: e.by, at: e.created_at } : null;
}

export async function interviewDetail(tx: Tx, p: Principal, id: string) {
  const row = await interviewBase(tx, p, null)
    .leftJoin('users as cb', 'cb.id', 'i.created_by')
    .select([
      'i.id', 'i.application_id', 'i.interview_plan_id', 'i.round_name', 'i.mode', 'i.scheduled_start', 'i.scheduled_end', 'i.timezone',
      'i.meeting_url', 'i.location_instructions', 'i.status', 'i.evaluation_template', 'i.feedback_due_at', 'i.completed_at',
      'i.cancelled_reason', 'i.created_at', 'cb.full_name as created_by_name',
      'c.id as candidate_id', 'c.full_name as candidate_name', 'c.current_title', 'v.id as vacancy_id', 'v.vacancy_code', 'v.title as vacancy_title',
      'rq.department_id',
    ])
    .where('i.id', '=', id)
    .executeTakeFirst();
  if (!row) throw notFound('Interview');

  const now = new Date();
  const panelRows = await tx
    .selectFrom('interviewers as m')
    .leftJoin('users as u', 'u.id', 'm.user_id')
    .select(['m.id', 'm.user_id', 'm.external_name', 'm.external_email', 'm.feedback_status', 'u.full_name', 'u.email'])
    .where('m.interview_id', '=', id)
    .orderBy('m.created_at')
    .orderBy('m.id')
    .execute();
  const links = panelRows.length
    ? await tx
        .selectFrom('feedback_links')
        .select(['id', 'interviewer_id', 'status', 'expires_at', 'created_at', 'open_count', 'last_opened_at'])
        .where('interview_id', '=', id)
        .orderBy('created_at', 'desc')
        .execute()
    : [];
  const overdueBase = row.feedback_due_at !== null && row.feedback_due_at < now && !['cancelled', 'no_show'].includes(row.status);

  const events = await tx
    .selectFrom('interview_events as e')
    .leftJoin('users as u', 'u.id', 'e.actor_user_id')
    .select(['e.id', 'e.event_type', 'e.reason', 'e.metadata', 'e.created_at', 'u.full_name as actor_name'])
    .where('e.interview_id', '=', id)
    .orderBy('e.created_at', 'desc')
    .execute();

  const { department_id, evaluation_template, ...rest } = row;
  return {
    ...rest,
    template: evaluation_template as EvaluationTemplate,
    candidate: { id: row.candidate_id, full_name: row.candidate_name, current_title: row.current_title },
    vacancy: { id: row.vacancy_id, code: row.vacancy_code, title: row.vacancy_title },
    panel: panelRows.map((m) => {
      const latest = links.find((l) => l.interviewer_id === m.id);
      return {
        id: m.id,
        user_id: m.user_id,
        name: m.full_name ?? m.external_name,
        email: m.email ?? m.external_email,
        external: m.user_id === null,
        feedback_status: m.feedback_status,
        overdue: m.feedback_status === 'pending' && overdueBase,
        link: latest
          ? { id: latest.id, state: linkState(latest, now), expires_at: latest.expires_at, open_count: latest.open_count, last_opened_at: latest.last_opened_at }
          : null,
      };
    }),
    events,
    request: await nextRoundRequest(tx, id),
    can: {
      manage: can(p, 'interviews.manage', department_id),
      links: can(p, 'feedback_links.manage', department_id),
      view_feedback: hasAny(p, 'feedback.view'),
      correct: can(p, 'feedback.correct', department_id) || can(p, 'feedback.correct'),
      decide: can(p, 'decisions.record', department_id),
    },
  };
}

export async function interviewRoutes(app: FastifyInstance) {
  const { db } = app;

  // Colleagues who can be put on a panel. Open to people who schedule interviews or manage vacancies,
  // who cannot list users in general. Only name and work email: nothing about roles or access.
  app.get('/directory/users', async (req) => {
    const p = principal(req);
    const rows = await withTenant(db, p.tenantId, async (tx) => {
      // Interviewers may pick colleagues for a next round they request.
      if (!hasAny(p, 'interviews.manage') && !hasAny(p, 'vacancies.manage') && !hasAny(p, 'feedback_links.manage') && !(await isOnAnyPanel(tx, p.userId))) throw forbidden();
      return tx
        .selectFrom('users as u')
        .leftJoin('agency_members as am', 'am.user_id', 'u.id')
        .select(['u.id', 'u.full_name', 'u.email'])
        .where('u.status', '=', 'active')
        .where('am.id', 'is', null)
        .orderBy('u.full_name')
        .execute();
    });
    return { data: rows };
  });

  // ---- Scorecard plans (one per round of a vacancy) ------------------------

  async function loadVacancyForPlans(tx: Tx, p: Principal, vacancyId: string) {
    const v = await tx
      .selectFrom('vacancies as v')
      .innerJoin('requisitions as rq', 'rq.id', 'v.requisition_id')
      .select(['v.id', 'rq.department_id'])
      .where('v.id', '=', vacancyId)
      .where(vacancyVisible(p, null))
      .executeTakeFirst();
    if (!v) throw notFound('Vacancy');
    return v;
  }

  app.get('/vacancies/:id/interview-plans', async (req) => {
    const p = principal(req);
    if (!canReadInterviews(p)) throw forbidden();
    const { id } = idParams.parse(req.params);
    return withTenant(db, p.tenantId, async (tx) => {
      await loadVacancyForPlans(tx, p, id);
      const rows = await tx.selectFrom('interview_plans').select(['id', 'name', 'round_order', 'evaluation_template', 'is_active']).where('vacancy_id', '=', id).orderBy('round_order').execute();
      return { data: rows.map((r) => ({ id: r.id, name: r.name, round_order: r.round_order, is_active: r.is_active, competencies: (r.evaluation_template as EvaluationTemplate).competencies })) };
    });
  });

  app.post('/vacancies/:id/interview-plans', async (req, reply) => {
    const p = principal(req);
    const { id } = idParams.parse(req.params);
    const body = PlanBody.parse(req.body);
    const plan = await withTenant(db, p.tenantId, async (tx) => {
      const v = await loadVacancyForPlans(tx, p, id);
      requirePermission(p, 'interviews.manage', v.department_id);
      await tx.selectFrom('vacancies').select('id').where('id', '=', id).forUpdate().execute(); // serialize round numbering
      const last = await tx.selectFrom('interview_plans').select(sql<number>`coalesce(max(round_order), 0)::int`.as('n')).where('vacancy_id', '=', id).executeTakeFirstOrThrow();
      const row = await tx
        .insertInto('interview_plans')
        .values({ tenant_id: p.tenantId, vacancy_id: id, name: body.name, round_order: last.n + 1, evaluation_template: JSON.stringify(toTemplate(body.competencies)) })
        .returning(['id', 'name', 'round_order', 'is_active'])
        .executeTakeFirstOrThrow();
      await audit(tx, req, { tenantId: p.tenantId, actorUserId: p.userId, action: 'interview_plan.created', entityType: 'interview_plan', entityId: row.id, metadata: { vacancy_id: id, name: body.name } });
      return { ...row, competencies: body.competencies };
    });
    return reply.status(201).send({ data: plan });
  });

  app.patch('/interview-plans/:id', async (req) => {
    const p = principal(req);
    const { id } = idParams.parse(req.params);
    const body = PlanUpdate.parse(req.body);
    return withTenant(db, p.tenantId, async (tx) => {
      const plan = await tx
        .selectFrom('interview_plans as ip')
        .innerJoin('vacancies as v', 'v.id', 'ip.vacancy_id')
        .innerJoin('requisitions as rq', 'rq.id', 'v.requisition_id')
        .select(['ip.id', 'rq.department_id'])
        .where('ip.id', '=', id)
        .where(vacancyVisible(p, null))
        .forUpdate('ip')
        .executeTakeFirst();
      if (!plan) throw notFound('Interview plan');
      requirePermission(p, 'interviews.manage', plan.department_id);
      // Interviews already scheduled keep the scorecard they were created with.
      await tx
        .updateTable('interview_plans')
        .set({
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.is_active !== undefined ? { is_active: body.is_active } : {}),
          ...(body.competencies ? { evaluation_template: JSON.stringify(toTemplate(body.competencies)) } : {}),
        })
        .where('id', '=', id)
        .execute();
      await audit(tx, req, { tenantId: p.tenantId, actorUserId: p.userId, action: 'interview_plan.updated', entityType: 'interview_plan', entityId: id, metadata: { fields: Object.keys(body) } });
      const row = await tx.selectFrom('interview_plans').select(['id', 'name', 'round_order', 'is_active', 'evaluation_template']).where('id', '=', id).executeTakeFirstOrThrow();
      return { data: { id: row.id, name: row.name, round_order: row.round_order, is_active: row.is_active, competencies: (row.evaluation_template as EvaluationTemplate).competencies } };
    });
  });

  // ---- Interviews ------------------------------------------------------------

  app.get('/interviews', async (req) => {
    const p = principal(req);
    if (!canReadInterviews(p)) throw forbidden();
    const f = ListQuery.parse(req.query);
    return withTenant(db, p.tenantId, async (tx) => {
      let base = interviewBase(tx, p, null);
      if (f.from) base = base.where('i.scheduled_start', '>=', f.from);
      if (f.to) base = base.where('i.scheduled_start', '<', f.to);
      if (f.status) base = base.where('i.status', '=', f.status);
      if (f.mode) base = base.where('i.mode', '=', f.mode);
      if (f.vacancy_id) base = base.where('a.vacancy_id', '=', f.vacancy_id);
      if (f.candidate_id) base = base.where('a.candidate_id', '=', f.candidate_id);
      if (f.interviewer_id) {
        base = base.where((eb) => eb.exists(eb.selectFrom('interviewers as fm').select('fm.id').whereRef('fm.interview_id', '=', 'i.id').where('fm.user_id', '=', f.interviewer_id!)));
      }
      if (f.feedback === 'pending') {
        base = base.where((eb) => eb.exists(eb.selectFrom('interviewers as fm').select('fm.id').whereRef('fm.interview_id', '=', 'i.id').where('fm.feedback_status', '=', 'pending')));
        base = base.where('i.status', 'not in', ['cancelled', 'no_show']);
      } else if (f.feedback === 'submitted') {
        base = base.where((eb) => eb.exists(eb.selectFrom('interviewers as fm').select('fm.id').whereRef('fm.interview_id', '=', 'i.id').where('fm.feedback_status', '=', 'submitted')));
      } else if (f.feedback === 'overdue') {
        base = base
          .where('i.feedback_due_at', '<', sql<Date>`now()`)
          .where('i.status', 'not in', ['cancelled', 'no_show'])
          .where((eb) => eb.exists(eb.selectFrom('interviewers as fm').select('fm.id').whereRef('fm.interview_id', '=', 'i.id').where('fm.feedback_status', '=', 'pending')));
      }
      const { total } = await base.select(sql<number>`count(*)::int`.as('total')).executeTakeFirstOrThrow();
      const rows = await base
        .select((eb) => [
          'i.id', 'i.round_name', 'i.mode', 'i.scheduled_start', 'i.scheduled_end', 'i.timezone', 'i.status', 'i.feedback_due_at',
          'c.id as candidate_id', 'c.full_name as candidate_name', 'v.id as vacancy_id', 'v.vacancy_code', 'v.title as vacancy_title',
          eb.selectFrom('interviewers as m').leftJoin('users as u', 'u.id', 'm.user_id')
            .select(sql<string[]>`coalesce(array_agg(coalesce(u.full_name, m.external_name) order by m.created_at), '{}')`.as('n'))
            .whereRef('m.interview_id', '=', 'i.id').as('panel'),
          eb.selectFrom('interviewers as m').select(sql<number>`count(*) filter (where m.feedback_status = 'submitted')::int`.as('n')).whereRef('m.interview_id', '=', 'i.id').as('feedback_submitted'),
          eb.selectFrom('interviewers as m').select(sql<number>`count(*) filter (where m.feedback_status <> 'waived')::int`.as('n')).whereRef('m.interview_id', '=', 'i.id').as('feedback_expected'),
          eb.selectFrom('interviewers as m').select(sql<number>`count(*) filter (where m.feedback_status = 'pending')::int`.as('n')).whereRef('m.interview_id', '=', 'i.id').as('feedback_pending'),
        ])
        .orderBy(sql`i.scheduled_start asc nulls last`)
        .orderBy('i.created_at', 'desc')
        .limit(f.page_size)
        .offset((f.page - 1) * f.page_size)
        .execute();
      const now = Date.now();
      return {
        data: rows.map((r) => ({
          ...r,
          feedback_overdue: !!r.feedback_pending && r.feedback_due_at !== null && r.feedback_due_at.getTime() < now && !['cancelled', 'no_show'].includes(r.status),
        })),
        page: f.page, page_size: f.page_size, total,
      };
    });
  });

  app.get('/interviews/:id', async (req) => {
    const p = principal(req);
    if (!canReadInterviews(p)) throw forbidden();
    const { id } = idParams.parse(req.params);
    return { data: await withTenant(db, p.tenantId, (tx) => interviewDetail(tx, p, id)) };
  });

  app.post('/applications/:id/interviews', async (req, reply) => {
    const p = principal(req);
    const { id: applicationId } = idParams.parse(req.params);
    const body = CreateBody.parse(req.body);

    const created = await withTenant(db, p.tenantId, async (tx) => {
      const app = await tx
        .selectFrom('applications as a')
        .innerJoin('vacancies as v', 'v.id', 'a.vacancy_id')
        .innerJoin('requisitions as rq', 'rq.id', 'v.requisition_id')
        .select(['a.id', 'a.status', 'a.vacancy_id', 'rq.department_id'])
        .where('a.id', '=', applicationId)
        .where(vacancyVisible(p, null))
        .executeTakeFirst();
      if (!app) throw notFound('Application');
      requirePermission(p, 'interviews.manage', app.department_id);
      if (app.status !== 'active') throw new AppError(409, 'APPLICATION_CLOSED', 'This application is closed. Interviews can only be scheduled for active ones.');

      let template: EvaluationTemplate;
      let roundName = body.round_name;
      if (body.interview_plan_id) {
        const plan = await tx.selectFrom('interview_plans').select(['name', 'evaluation_template', 'is_active']).where('id', '=', body.interview_plan_id).where('vacancy_id', '=', app.vacancy_id).executeTakeFirst();
        if (!plan || !plan.is_active) throw new AppError(422, 'INVALID_PLAN', 'That round is not part of this vacancy, or is switched off.');
        template = plan.evaluation_template as EvaluationTemplate;
        roundName ??= plan.name;
      } else {
        template = toTemplate(body.competencies ?? DEFAULT_COMPETENCIES);
      }

      const scheduled = body.scheduled_start !== null;
      const interview = await tx
        .insertInto('interviews')
        .values({
          tenant_id: p.tenantId, application_id: applicationId, interview_plan_id: body.interview_plan_id ?? null,
          round_name: roundName!, mode: body.mode, scheduled_start: body.scheduled_start, scheduled_end: body.scheduled_end,
          timezone: body.timezone, meeting_url: body.meeting_url, location_instructions: body.location_instructions,
          status: scheduled ? 'scheduled' : 'draft', evaluation_template: JSON.stringify(template),
          feedback_due_at: await feedbackDueAt(tx, body.scheduled_end), created_by: p.userId,
        })
        .returning('id')
        .executeTakeFirstOrThrow();

      for (const m of body.panel) await addPanelist(tx, p.tenantId, interview.id, m);
      await recordInterviewEvent(tx, {
        tenantId: p.tenantId, interviewId: interview.id, type: scheduled ? 'scheduled' : 'created', actorUserId: p.userId,
        metadata: { start: body.scheduled_start, end: body.scheduled_end, mode: body.mode, panel_size: body.panel.length },
      });
      await audit(tx, req, { tenantId: p.tenantId, actorUserId: p.userId, action: 'interview.created', entityType: 'interview', entityId: interview.id, metadata: { application_id: applicationId, round: roundName } });
      if (scheduled) await notifyPanel(tx, p, interview.id, { type: 'interview.scheduled', title: 'Interview scheduled', body: `${roundName} is scheduled. Feedback is expected afterwards.` });
      return interviewDetail(tx, p, interview.id);
    });
    return reply.status(201).send({ data: created });
  });

  // The hiring manager sends a candidate to the next round with a remark and the people who should
  // interview. It creates an unscheduled round for the recruiters to book, records the decision, and the
  // same remark reaches the recruiters (notice + to-do) and the chosen interviewers.
  app.post('/applications/:id/next-round', async (req, reply) => {
    const p = principal(req);
    const { id: applicationId } = idParams.parse(req.params);
    const body = NextRoundBody.parse(req.body);
    const created = await withTenant(db, p.tenantId, async (tx) => {
      // An interviewer of this candidate can send them to the next round themselves.
      const interviewed = await interviewedApplication(tx, p.userId, applicationId);
      const app0 = await tx
        .selectFrom('applications as a')
        .innerJoin('vacancies as v', 'v.id', 'a.vacancy_id')
        .innerJoin('requisitions as rq', 'rq.id', 'v.requisition_id')
        .innerJoin('candidates as c', 'c.id', 'a.candidate_id')
        .select(['a.id', 'a.status', 'a.vacancy_id', 'v.title as vacancy_title', 'v.owner_user_id', 'rq.department_id', 'c.full_name as candidate_name'])
        .where('a.id', '=', applicationId)
        .$if(!interviewed, (q) => q.where(vacancyVisible(p, null))).forUpdate('a').executeTakeFirst();
      if (!app0) throw notFound('Application');
      if (!interviewed) {
        requirePermission(p, 'decisions.record', app0.department_id);
        requirePermission(p, 'interviews.manage', app0.department_id);
      }
      if (app0.status !== 'active') throw new AppError(409, 'APPLICATION_CLOSED', 'This application is closed.');
      const people = [...new Set(body.interviewer_user_ids)];

      const interview = await tx.insertInto('interviews').values({
        tenant_id: p.tenantId, application_id: applicationId, round_name: body.round_name, mode: body.mode, status: 'draft',
        scheduled_start: null, scheduled_end: null, timezone: 'Asia/Kolkata', evaluation_template: JSON.stringify(toTemplate(DEFAULT_COMPETENCIES)), created_by: p.userId,
      }).returning('id').executeTakeFirstOrThrow();
      for (const user_id of people) await addPanelist(tx, p.tenantId, interview.id, { user_id });
      await recordInterviewEvent(tx, { tenantId: p.tenantId, interviewId: interview.id, type: 'next_round_requested', reason: body.remark, actorUserId: p.userId, metadata: { panel_size: people.length } });
      await tx.insertInto('hiring_decisions').values({ tenant_id: p.tenantId, application_id: applicationId, decision: 'additional_round', reason: body.remark, decided_by: p.userId }).execute();
      await audit(tx, req, { tenantId: p.tenantId, actorUserId: p.userId, action: 'interview.next_round_requested', entityType: 'interview', entityId: interview.id, metadata: { application_id: applicationId, round: body.round_name, interviewers: people.length } });

      // Recruiters on this job (and its owner) book the round; they see the remark in the notice, the to-do and the interview.
      const recruiters = await tx.selectFrom('vacancy_recruiters').select('recruiter_user_id').where('vacancy_id', '=', app0.vacancy_id).where('unassigned_at', 'is', null).execute();
      const audience = new Set([app0.owner_user_id, ...recruiters.map((r) => r.recruiter_user_id)].filter((u): u is string => !!u && u !== p.userId));
      for (const userId of audience) {
        await notifyUser(tx, { tenantId: p.tenantId, userId, eventType: 'interview.next_round_requested', dedupeKey: `next_round:${interview.id}:${userId}`, title: `Next round requested: ${app0.candidate_name}`, body: `${p.fullName}: "${body.remark}"`, link: `/interviews/${interview.id}` });
        await createTask(tx, { tenantId: p.tenantId, assigneeUserId: userId, taskType: 'schedule_interview', title: `Schedule ${body.round_name} for ${app0.candidate_name}`, entityType: 'interview', entityId: interview.id, createdBy: p.userId });
      }
      for (const userId of people) {
        await notifyUser(tx, { tenantId: p.tenantId, userId, eventType: 'interview.next_round_requested', dedupeKey: `next_round_panel:${interview.id}:${userId}`, title: `You will interview ${app0.candidate_name}`, body: `${p.fullName}: "${body.remark}" Time to be confirmed by the recruiter.`, link: '/my-interviews' });
      }
      return interviewed && !hasAny(p, 'interviews.manage') ? { id: interview.id } : interviewDetail(tx, p, interview.id);
    });
    return reply.status(201).send({ data: created });
  });

  app.patch('/interviews/:id', async (req) => {
    const p = principal(req);
    const { id } = idParams.parse(req.params);
    const body = UpdateBody.parse(req.body);

    return withTenant(db, p.tenantId, async (tx) => {
      const iv = await loadInterview(tx, p, id, { lock: true });
      requirePermission(p, 'interviews.manage', iv.department_id);
      if (!['draft', 'scheduled', 'confirmed'].includes(iv.status)) {
        throw new AppError(409, 'NOT_EDITABLE', `A ${iv.status.replace('_', ' ')} interview cannot be changed.`);
      }
      const start = body.scheduled_start ?? iv.scheduled_start;
      const end = body.scheduled_end ?? iv.scheduled_end;
      if ((start === null) !== (end === null)) throw new AppError(400, 'VALIDATION_ERROR', 'Some fields are invalid.', [{ path: 'scheduled_end', message: 'Give both a start and an end time.' }]);
      if (start && end && end <= start) throw new AppError(400, 'VALIDATION_ERROR', 'Some fields are invalid.', [{ path: 'scheduled_end', message: 'The end must be after the start.' }]);

      const timeChanged = (body.scheduled_start !== undefined && body.scheduled_start.getTime() !== iv.scheduled_start?.getTime())
        || (body.scheduled_end !== undefined && body.scheduled_end.getTime() !== iv.scheduled_end?.getTime());
      const wasScheduled = iv.status !== 'draft';
      if (timeChanged && wasScheduled && !body.reason) {
        throw new AppError(400, 'VALIDATION_ERROR', 'Some fields are invalid.', [{ path: 'reason', message: 'Give a reason for rescheduling.' }]);
      }

      const { reason, ...fields } = body;
      const nextStatus = start && end && (iv.status === 'draft' || (timeChanged && iv.status === 'confirmed')) ? 'scheduled' : iv.status;
      await tx
        .updateTable('interviews')
        .set({ ...fields, status: nextStatus, ...(timeChanged ? { feedback_due_at: await feedbackDueAt(tx, end) } : {}) })
        .where('id', '=', id)
        .execute();
      await recordInterviewEvent(tx, {
        tenantId: p.tenantId, interviewId: id, actorUserId: p.userId, reason: reason ?? null,
        type: timeChanged ? (wasScheduled ? 'rescheduled' : 'scheduled') : 'updated',
        metadata: { from: { start: iv.scheduled_start, end: iv.scheduled_end }, to: { start, end }, fields: Object.keys(fields) },
      });
      await audit(tx, req, { tenantId: p.tenantId, actorUserId: p.userId, action: timeChanged ? 'interview.rescheduled' : 'interview.updated', entityType: 'interview', entityId: id, metadata: { reason: reason ?? null, fields: Object.keys(fields) } });
      if (timeChanged) await notifyPanel(tx, p, id, { type: 'interview.rescheduled', title: 'Interview rescheduled', body: `${iv.round_name} has a new time.${reason ? ` Reason: ${reason}` : ''}` });
      return { data: await interviewDetail(tx, p, id) };
    });
  });

  app.post('/interviews/:id/confirm', async (req) => {
    const p = principal(req);
    const { id } = idParams.parse(req.params);
    return withTenant(db, p.tenantId, async (tx) => {
      const iv = await loadInterview(tx, p, id, { lock: true });
      requirePermission(p, 'interviews.manage', iv.department_id);
      if (iv.status !== 'scheduled') throw new AppError(409, 'INVALID_STATE', 'Only a scheduled interview can be confirmed.');
      await tx.updateTable('interviews').set({ status: 'confirmed' }).where('id', '=', id).execute();
      await recordInterviewEvent(tx, { tenantId: p.tenantId, interviewId: id, type: 'confirmed', actorUserId: p.userId });
      return { data: await interviewDetail(tx, p, id) };
    });
  });

  app.post('/interviews/:id/cancel', async (req) => {
    const p = principal(req);
    const { id } = idParams.parse(req.params);
    const { reason } = ReasonBody.parse(req.body);
    return withTenant(db, p.tenantId, async (tx) => {
      const iv = await loadInterview(tx, p, id, { lock: true });
      requirePermission(p, 'interviews.manage', iv.department_id);
      if (!['draft', 'scheduled', 'confirmed'].includes(iv.status)) throw new AppError(409, 'INVALID_STATE', `A ${iv.status.replace('_', ' ')} interview cannot be cancelled.`);
      await tx.updateTable('interviews').set({ status: 'cancelled', cancelled_reason: reason }).where('id', '=', id).execute();
      const panel = await tx.selectFrom('interviewers').select('id').where('interview_id', '=', id).execute();
      const revoked = await revokeActiveLinks(tx, panel.map((m) => m.id), p.userId);
      await recordInterviewEvent(tx, { tenantId: p.tenantId, interviewId: id, type: 'cancelled', reason, actorUserId: p.userId, metadata: { links_revoked: revoked } });
      await audit(tx, req, { tenantId: p.tenantId, actorUserId: p.userId, action: 'interview.cancelled', entityType: 'interview', entityId: id, metadata: { reason, links_revoked: revoked } });
      await notifyPanel(tx, p, id, { type: 'interview.cancelled', title: 'Interview cancelled', body: `${iv.round_name} was cancelled. Reason: ${reason}` });
      return { data: await interviewDetail(tx, p, id) };
    });
  });

  app.post('/interviews/:id/complete', async (req) => {
    const p = principal(req);
    const { id } = idParams.parse(req.params);
    return withTenant(db, p.tenantId, async (tx) => {
      const iv = await loadInterview(tx, p, id, { lock: true });
      requirePermission(p, 'interviews.manage', iv.department_id);
      if (!['scheduled', 'confirmed'].includes(iv.status)) throw new AppError(409, 'INVALID_STATE', 'Only a scheduled interview can be marked completed.');
      await tx.updateTable('interviews').set({ status: 'completed', completed_at: sql`now()` }).where('id', '=', id).execute();
      await recordInterviewEvent(tx, { tenantId: p.tenantId, interviewId: id, type: 'completed', actorUserId: p.userId });
      await audit(tx, req, { tenantId: p.tenantId, actorUserId: p.userId, action: 'interview.completed', entityType: 'interview', entityId: id });
      return { data: await interviewDetail(tx, p, id) };
    });
  });

  // The candidate did not attend: nothing to give feedback on, so feedback is waived and links are revoked.
  app.post('/interviews/:id/no-show', async (req) => {
    const p = principal(req);
    const { id } = idParams.parse(req.params);
    const { reason } = OptionalReason.parse(req.body ?? {});
    return withTenant(db, p.tenantId, async (tx) => {
      const iv = await loadInterview(tx, p, id, { lock: true });
      requirePermission(p, 'interviews.manage', iv.department_id);
      if (!['scheduled', 'confirmed'].includes(iv.status)) throw new AppError(409, 'INVALID_STATE', 'Only a scheduled interview can be marked as a no-show.');
      await tx.updateTable('interviews').set({ status: 'no_show' }).where('id', '=', id).execute();
      const panel = await tx.selectFrom('interviewers').select('id').where('interview_id', '=', id).execute();
      await tx.updateTable('interviewers').set({ feedback_status: 'waived' }).where('interview_id', '=', id).where('feedback_status', '=', 'pending').execute();
      const revoked = await revokeActiveLinks(tx, panel.map((m) => m.id), p.userId);
      await recordInterviewEvent(tx, { tenantId: p.tenantId, interviewId: id, type: 'no_show', reason: reason ?? null, actorUserId: p.userId, metadata: { links_revoked: revoked } });
      await audit(tx, req, { tenantId: p.tenantId, actorUserId: p.userId, action: 'interview.no_show', entityType: 'interview', entityId: id, metadata: { reason: reason ?? null } });
      return { data: await interviewDetail(tx, p, id) };
    });
  });

  // ---- Panel -----------------------------------------------------------------

  app.post('/interviews/:id/interviewers', async (req, reply) => {
    const p = principal(req);
    const { id } = idParams.parse(req.params);
    const member = PanelMember.parse(req.body);
    const data = await withTenant(db, p.tenantId, async (tx) => {
      const iv = await loadInterview(tx, p, id, { lock: true });
      requirePermission(p, 'interviews.manage', iv.department_id);
      if (['cancelled', 'no_show'].includes(iv.status)) throw new AppError(409, 'INVALID_STATE', 'This interview is no longer happening.');
      const m = await addPanelist(tx, p.tenantId, id, member);
      await recordInterviewEvent(tx, { tenantId: p.tenantId, interviewId: id, type: 'panel_added', actorUserId: p.userId, metadata: { interviewer_id: m.id } });
      await audit(tx, req, { tenantId: p.tenantId, actorUserId: p.userId, action: 'interview.panel_added', entityType: 'interview', entityId: id, metadata: { interviewer_id: m.id } });
      return interviewDetail(tx, p, id);
    });
    return reply.status(201).send({ data });
  });

  app.delete('/interviews/:id/interviewers/:interviewerId', async (req) => {
    const p = principal(req);
    const { id, interviewerId } = PanelParams.parse(req.params);
    return withTenant(db, p.tenantId, async (tx) => {
      const iv = await loadInterview(tx, p, id, { lock: true });
      requirePermission(p, 'interviews.manage', iv.department_id);
      const m = await tx.selectFrom('interviewers').select(['id', 'feedback_status']).where('id', '=', interviewerId).where('interview_id', '=', id).forUpdate().executeTakeFirst();
      if (!m) throw notFound('Interviewer');
      if (m.feedback_status === 'submitted') throw new AppError(409, 'FEEDBACK_SUBMITTED', 'This interviewer has already given feedback, so they cannot be removed from the record.');
      await revokeActiveLinks(tx, [m.id], p.userId);
      // Link history is evidence, so someone who was ever sent a link is waived rather than erased.
      const hadLink = await tx.selectFrom('feedback_links').select('id').where('interviewer_id', '=', m.id).limit(1).executeTakeFirst();
      if (hadLink) {
        await tx.updateTable('interviewers').set({ feedback_status: 'waived' }).where('id', '=', m.id).execute();
      } else {
        await tx.deleteFrom('interviewers').where('id', '=', m.id).execute();
      }
      await recordInterviewEvent(tx, { tenantId: p.tenantId, interviewId: id, type: hadLink ? 'feedback_waived' : 'panel_removed', actorUserId: p.userId, metadata: { interviewer_id: m.id } });
      await audit(tx, req, { tenantId: p.tenantId, actorUserId: p.userId, action: hadLink ? 'interview.feedback_waived' : 'interview.panel_removed', entityType: 'interview', entityId: id, metadata: { interviewer_id: m.id } });
      return { data: await interviewDetail(tx, p, id) };
    });
  });
}
