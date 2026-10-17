// Feedback links and feedback review.
//
// A link is a 256-bit random token for ONE interviewer on ONE interview. Only its SHA-256 is stored.
// Opening a link never consumes it (email scanners prefetch links); only a successful submission does,
// inside one database transaction (see submit_feedback in migration 0001). The token travels in the URL
// fragment and in request bodies, never in a path, so it stays out of access logs.
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { z } from 'zod';
import { hasAny, vacancyVisible } from '../access.js';
import { principal } from '../app.js';
import { audit } from '../audit.js';
import type { EvaluationTemplate, FeedbackRecommendation, InterviewMode } from '../db-types.js';
import { setTenant, setTokenHash, withTenant, type Tx } from '../db.js';
import { AppError, forbidden, notFound } from '../errors.js';
import {
  candidateBrief, canReadInterviews, feedbackBodySchema, linkState, loadInterview, MODE_LABEL, recordInterviewEvent, validateScorecard,
  type FeedbackBody,
} from '../interviews.js';
import { notifyUser } from '../notifications.js';
import { can, requirePermission, type Principal } from '../permissions.js';
import { hashIp, randomToken, sha256Hex } from '../security.js';
import { signFileToken } from '../storage.js';
import { idParams, publicRateLimit, tokenSchema } from './common.js';
import { nextRoundRequest, revokeActiveLinks } from './interviews.js';

const invalidLink = () => new AppError(401, 'INVALID_LINK', 'This feedback link is not valid.');
const expiredLink = () => new AppError(410, 'LINK_EXPIRED', 'This feedback link has expired or was withdrawn.');
const usedLink = () => new AppError(409, 'ALREADY_SUBMITTED', 'Feedback has already been submitted through this link.');

const IssueBody = z.object({
  interviewer_id: z.uuid(),
  expires_in_hours: z.number().int().min(1).max(2160).optional(),
  send_email: z.boolean().default(true),
});
const TokenBody = z.object({ token: tokenSchema });
const SubmitBody = feedbackBodySchema.extend({ token: tokenSchema });
const CorrectionBody = feedbackBodySchema.extend({ reason: z.string().trim().min(1, 'Say why this is being corrected.').max(1000) });
const DecisionBody = z.object({
  decision: z.enum(['advance', 'hold', 'reject', 'additional_round', 'select']),
  reason: z.string().trim().max(2000).optional(),
});

/** The feedback that counts: the latest correction, or the original if nobody corrected it. */
export function effectiveFeedback<O extends { overall_rating: number; recommendation: FeedbackRecommendation; competency_ratings: Record<string, number>; notes: string | null; mode: InterviewMode }>(
  original: O,
  corrections: { version: number; overall_rating: number; recommendation: FeedbackRecommendation; competency_ratings: Record<string, number>; notes: string | null; mode: InterviewMode }[],
) {
  const latest = [...corrections].sort((a, b) => b.version - a.version)[0];
  const src = latest ?? original;
  return {
    mode: src.mode, overall_rating: src.overall_rating, recommendation: src.recommendation,
    competency_ratings: src.competency_ratings, notes: src.notes, corrected: !!latest, version: latest?.version ?? 0,
  };
}

async function interviewContext(tx: Tx, interviewId: string, interviewerId: string) {
  const row = await tx
    .selectFrom('interviews as i')
    .innerJoin('applications as a', 'a.id', 'i.application_id')
    .innerJoin('vacancies as v', 'v.id', 'a.vacancy_id')
    .innerJoin('requisitions as rq', 'rq.id', 'v.requisition_id')
    .innerJoin('candidates as c', 'c.id', 'a.candidate_id')
    .innerJoin('interviewers as m', 'm.interview_id', 'i.id')
    .leftJoin('users as u', 'u.id', 'm.user_id')
    .select([
      'i.id', 'i.status', 'i.round_name', 'i.mode', 'i.scheduled_start', 'i.scheduled_end', 'i.timezone', 'i.evaluation_template', 'i.created_by',
      'v.id as vacancy_id', 'v.title as vacancy_title', 'v.location as vacancy_location', 'rq.description', 'rq.skills as job_skills',
      'c.id as candidate_id', 'c.full_name', 'c.current_title', 'c.total_experience_years', 'c.skills', 'c.profile_summary', 'c.city',
      'm.id as interviewer_id', 'm.feedback_status', 'm.external_name', 'm.external_email', 'u.full_name as user_name', 'u.email as user_email',
    ])
    .where('i.id', '=', interviewId)
    .where('m.id', '=', interviewerId)
    .executeTakeFirst();
  if (!row) throw invalidLink();
  return row;
}

type Ctx = Awaited<ReturnType<typeof interviewContext>>;

/** What an interviewer is shown. No contact details, no compensation, nothing about other people. */
function bootstrap(ctx: Ctx) {
  return {
    interview: {
      round_name: ctx.round_name, mode: ctx.mode, mode_label: MODE_LABEL[ctx.mode], scheduled_start: ctx.scheduled_start,
      scheduled_end: ctx.scheduled_end, timezone: ctx.timezone,
    },
    job: { title: ctx.vacancy_title, location: ctx.vacancy_location, description: ctx.description.slice(0, 4000), skills: ctx.job_skills },
    candidate: candidateBrief({
      full_name: ctx.full_name, current_title: ctx.current_title, total_experience_years: ctx.total_experience_years,
      skills: ctx.skills, profile_summary: ctx.profile_summary, city: ctx.city,
    }),
    interviewer: { name: ctx.user_name ?? ctx.external_name },
    scorecard: (ctx.evaluation_template as EvaluationTemplate).competencies,
  };
}

async function notifyFeedbackSubmitted(tx: Tx, tenantId: string, ctx: Ctx, feedbackId: string, rating: number, recommendation: string) {
  await notifyUser(tx, {
    tenantId, userId: ctx.created_by, eventType: 'feedback.submitted', dedupeKey: `feedback_submitted:${feedbackId}`,
    title: 'Interview feedback received',
    body: `${ctx.user_name ?? ctx.external_name} rated ${ctx.full_name} ${rating}/5 (${recommendation.replace('_', ' ')}) for ${ctx.round_name}.`,
    link: `/interviews/${ctx.id}`, email_too: true,
  });
}

/** Finds the link behind a token and moves the transaction into its tenant. Opening never consumes it. */
async function resolveLink(tx: Tx, token: string) {
  const hash = sha256Hex(token);
  await setTokenHash(tx, 'app.feedback_token_hash', hash);
  const link = await tx
    .selectFrom('feedback_links')
    .select(['id', 'tenant_id', 'interview_id', 'interviewer_id', 'status', 'expires_at'])
    .where('token_hash', '=', hash)
    .executeTakeFirst();
  if (!link) throw invalidLink();
  await setTenant(tx, link.tenant_id);
  const state = linkState(link);
  if (state === 'consumed') throw usedLink();
  if (state !== 'active') throw expiredLink();
  const ctx = await interviewContext(tx, link.interview_id, link.interviewer_id);
  // Someone else's submission can land between the two reads above; that is still "already submitted".
  if (ctx.feedback_status === 'submitted') throw usedLink();
  if (['cancelled', 'no_show'].includes(ctx.status) || ctx.feedback_status !== 'pending') throw expiredLink();
  return { link, ctx, hash };
}


export async function feedbackRoutes(app: FastifyInstance) {
  const { db, config } = app;

  // ---- Company side: issue and revoke ----------------------------------------

  app.post('/interviews/:id/feedback-links', async (req, reply) => {
    const p = principal(req);
    const { id } = idParams.parse(req.params);
    const body = IssueBody.parse(req.body);

    const issued = await withTenant(db, p.tenantId, async (tx) => {
      const iv = await loadInterview(tx, p, id, { lock: true });
      requirePermission(p, 'feedback_links.manage', iv.department_id);
      if (['cancelled', 'no_show'].includes(iv.status)) throw new AppError(409, 'INVALID_STATE', 'This interview is no longer happening, so no feedback is expected.');
      const m = await tx.selectFrom('interviewers').select(['id', 'feedback_status']).where('id', '=', body.interviewer_id).where('interview_id', '=', id).forUpdate().executeTakeFirst();
      if (!m) throw notFound('Interviewer');
      if (m.feedback_status === 'submitted') throw new AppError(409, 'FEEDBACK_SUBMITTED', 'This interviewer has already given feedback. Use a correction to change it.');
      if (m.feedback_status === 'waived') throw new AppError(409, 'FEEDBACK_WAIVED', 'Feedback was waived for this interviewer.');

      const settings = await tx.selectFrom('tenant_settings').select('feedback_link_expiry_hours').executeTakeFirst();
      const hours = body.expires_in_hours ?? settings?.feedback_link_expiry_hours ?? 168;
      const token = randomToken();
      const expiresAt = new Date(Date.now() + hours * 3_600_000);

      // Regenerating revokes the previous link first, including one that expired without being marked.
      const revoked = await revokeActiveLinks(tx, [m.id], p.userId);
      const link = await tx
        .insertInto('feedback_links')
        .values({ tenant_id: p.tenantId, interview_id: id, interviewer_id: m.id, token_hash: sha256Hex(token), expires_at: expiresAt, created_by: p.userId })
        .returning(['id', 'expires_at'])
        .executeTakeFirstOrThrow();
      await recordInterviewEvent(tx, { tenantId: p.tenantId, interviewId: id, type: revoked ? 'link_regenerated' : 'link_issued', actorUserId: p.userId, metadata: { interviewer_id: m.id, link_id: link.id, previous_revoked: revoked } });
      await audit(tx, req, { tenantId: p.tenantId, actorUserId: p.userId, action: 'feedback_link.issued', entityType: 'feedback_link', entityId: link.id, metadata: { interview_id: id, interviewer_id: m.id, expires_at: expiresAt, previous_revoked: revoked } });

      const ctx = await interviewContext(tx, id, m.id);
      return { link, token, ctx };
    });

    const url = `${config.WEB_ORIGIN}/feedback#${issued.token}`;
    let emailed = false;
    const to = issued.ctx.user_email ?? issued.ctx.external_email;
    if (body.send_email && to) {
      try {
        await app.mailer.sendFeedbackRequest({
          to, interviewerName: issued.ctx.user_name ?? issued.ctx.external_name ?? 'there', candidateName: issued.ctx.full_name,
          jobTitle: issued.ctx.vacancy_title, roundName: issued.ctx.round_name, scheduledStart: issued.ctx.scheduled_start,
          link: url, expiresAt: issued.link.expires_at,
        });
        emailed = true;
      } catch (err) {
        // The link exists and is shown to the recruiter, who can copy it. Email is a convenience.
        req.log.warn({ err: (err as Error).message }, 'feedback request email failed');
      }
    }
    // The link is shown once, here. It cannot be shown again because only its hash is stored.
    return reply.status(201).send({ data: { id: issued.link.id, url, expires_at: issued.link.expires_at, emailed } });
  });

  app.post('/feedback-links/:id/revoke', async (req, reply) => {
    const p = principal(req);
    const { id } = idParams.parse(req.params);
    await withTenant(db, p.tenantId, async (tx) => {
      const link = await tx
        .selectFrom('feedback_links as l')
        .innerJoin('interviews as i', 'i.id', 'l.interview_id')
        .innerJoin('applications as a', 'a.id', 'i.application_id')
        .innerJoin('vacancies as v', 'v.id', 'a.vacancy_id')
        .innerJoin('requisitions as rq', 'rq.id', 'v.requisition_id')
        .select(['l.id', 'l.status', 'l.interview_id', 'l.interviewer_id', 'rq.department_id'])
        .where('l.id', '=', id)
        .where(vacancyVisible(p, null))
        .forUpdate('l')
        .executeTakeFirst();
      if (!link) throw notFound('Feedback link');
      requirePermission(p, 'feedback_links.manage', link.department_id);
      if (link.status !== 'active') throw new AppError(409, 'NOT_ACTIVE', 'This link is already used or withdrawn.');
      await tx.updateTable('feedback_links').set({ status: 'revoked', revoked_at: sql`now()`, revoked_by: p.userId }).where('id', '=', id).execute();
      await recordInterviewEvent(tx, { tenantId: p.tenantId, interviewId: link.interview_id, type: 'link_revoked', actorUserId: p.userId, metadata: { link_id: id, interviewer_id: link.interviewer_id } });
      await audit(tx, req, { tenantId: p.tenantId, actorUserId: p.userId, action: 'feedback_link.revoked', entityType: 'feedback_link', entityId: id, metadata: { interview_id: link.interview_id } });
    });
    return reply.status(204).send();
  });

  // ---- Interviewers with an account ---------------------------------------------

  async function myInterview(tx: Tx, p: Principal, interviewId: string) {
    const m = await tx.selectFrom('interviewers').select('id').where('interview_id', '=', interviewId).where('user_id', '=', p.userId).executeTakeFirst();
    if (!m) throw notFound('Interview');
    return interviewContext(tx, interviewId, m.id);
  }

  app.get('/me/interviews', async (req) => {
    const p = principal(req);
    const rows = await withTenant(db, p.tenantId, (tx) =>
      tx
        .selectFrom('interviewers as m')
        .innerJoin('interviews as i', 'i.id', 'm.interview_id')
        .innerJoin('applications as a', 'a.id', 'i.application_id')
        .innerJoin('vacancies as v', 'v.id', 'a.vacancy_id')
        .innerJoin('candidates as c', 'c.id', 'a.candidate_id')
        .select(['i.id', 'i.round_name', 'i.mode', 'i.scheduled_start', 'i.scheduled_end', 'i.timezone', 'i.status', 'i.feedback_due_at',
          'm.feedback_status', 'c.full_name as candidate_name', 'v.title as vacancy_title'])
        .where('m.user_id', '=', p.userId)
        .where('i.status', '<>', 'draft')
        .orderBy(sql`i.scheduled_start desc nulls last`)
        .limit(100)
        .execute());
    const now = Date.now();
    return {
      data: rows.map((r) => ({
        ...r,
        overdue: r.feedback_status === 'pending' && r.feedback_due_at !== null && r.feedback_due_at.getTime() < now && !['cancelled', 'no_show'].includes(r.status),
        can_submit: r.feedback_status === 'pending' && !['cancelled', 'no_show', 'draft'].includes(r.status),
      })),
    };
  });

  app.get('/me/interviews/:id', async (req) => {
    const p = principal(req);
    const { id } = idParams.parse(req.params);
    return withTenant(db, p.tenantId, async (tx) => {
      const ctx = await myInterview(tx, p, id);
      const mine = await tx.selectFrom('feedback').select(['id', 'mode', 'overall_rating', 'recommendation', 'competency_ratings', 'notes', 'submitted_at']).where('interview_id', '=', id).where('interviewer_id', '=', ctx.interviewer_id).executeTakeFirst();
      return {
        data: {
          id, status: ctx.status, feedback_status: ctx.feedback_status,
          can_submit: ctx.feedback_status === 'pending' && !['cancelled', 'no_show'].includes(ctx.status),
          ...bootstrap(ctx), my_feedback: mine ?? null, request: await nextRoundRequest(tx, id),
          modes: Object.entries(MODE_LABEL).map(([value, label]) => ({ value, label })),
        },
      };
    });
  });

  app.post('/me/interviews/:id/feedback', async (req, reply) => {
    const p = principal(req);
    const { id } = idParams.parse(req.params);
    const body = feedbackBodySchema.parse(req.body);
    await withTenant(db, p.tenantId, async (tx) => {
      const ctx = await myInterview(tx, p, id);
      const lockedM = await tx.selectFrom('interviewers').select('feedback_status').where('id', '=', ctx.interviewer_id).forUpdate().executeTakeFirstOrThrow();
      if (lockedM.feedback_status === 'submitted') throw usedLink();
      if (lockedM.feedback_status === 'waived' || ['cancelled', 'no_show'].includes(ctx.status)) throw new AppError(409, 'NOT_EXPECTED', 'Feedback is not expected for this interview.');
      validateScorecard(ctx.evaluation_template as EvaluationTemplate, body.competency_ratings);
      const app = await tx.selectFrom('interviews').select('application_id').where('id', '=', id).executeTakeFirstOrThrow();
      const fb = await tx
        .insertInto('feedback')
        .values({
          tenant_id: p.tenantId, interview_id: id, application_id: app.application_id, interviewer_id: ctx.interviewer_id, mode: body.mode,
          overall_rating: body.overall_rating, recommendation: body.recommendation, competency_ratings: JSON.stringify(body.competency_ratings), notes: body.notes || null,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await tx.updateTable('interviewers').set({ feedback_status: 'submitted' }).where('id', '=', ctx.interviewer_id).execute();
      await revokeActiveLinks(tx, [ctx.interviewer_id], p.userId); // an outstanding link must not allow a second submission
      await recordInterviewEvent(tx, { tenantId: p.tenantId, interviewId: id, type: 'feedback_submitted', actorUserId: p.userId, metadata: { interviewer_id: ctx.interviewer_id } });
      await audit(tx, req, { tenantId: p.tenantId, actorUserId: p.userId, action: 'feedback.submitted', entityType: 'feedback', entityId: fb.id, metadata: { interview_id: id, via: 'account' } });
      await notifyFeedbackSubmitted(tx, p.tenantId, ctx, fb.id, body.overall_rating, body.recommendation);
    });
    return reply.status(201).send({ data: { status: 'submitted' } });
  });

  // ---- Company side: review, corrections, decisions -------------------------------

  async function feedbackFor(tx: Tx, interviewIds: string[]) {
    if (interviewIds.length === 0) return [];
    const rows = await tx
      .selectFrom('feedback as f')
      .innerJoin('interviewers as m', 'm.id', 'f.interviewer_id')
      .leftJoin('users as u', 'u.id', 'm.user_id')
      .select(['f.id', 'f.interview_id', 'f.mode', 'f.overall_rating', 'f.recommendation', 'f.competency_ratings', 'f.notes', 'f.submitted_at',
        'm.id as interviewer_id', 'm.external_name', 'u.full_name as user_name'])
      .where('f.interview_id', 'in', interviewIds)
      .orderBy('f.submitted_at')
      .execute();
    const corrections = rows.length
      ? await tx
          .selectFrom('feedback_corrections as fc')
          .leftJoin('users as u', 'u.id', 'fc.corrected_by')
          .select(['fc.feedback_id', 'fc.version', 'fc.mode', 'fc.overall_rating', 'fc.recommendation', 'fc.competency_ratings', 'fc.notes', 'fc.reason', 'fc.created_at', 'u.full_name as corrected_by_name'])
          .where('fc.feedback_id', 'in', rows.map((r) => r.id))
          .orderBy('fc.version')
          .execute()
      : [];
    return rows.map((r) => {
      const mine = corrections.filter((c) => c.feedback_id === r.id);
      return {
        id: r.id, interview_id: r.interview_id, interviewer: { id: r.interviewer_id, name: r.user_name ?? r.external_name }, submitted_at: r.submitted_at,
        original: { mode: r.mode, overall_rating: r.overall_rating, recommendation: r.recommendation, competency_ratings: r.competency_ratings, notes: r.notes },
        effective: effectiveFeedback(r, mine),
        corrections: mine.map((c) => ({ version: c.version, reason: c.reason, corrected_by: c.corrected_by_name, at: c.created_at, overall_rating: c.overall_rating, recommendation: c.recommendation, notes: c.notes })),
      };
    });
  }

  app.get('/interviews/:id/feedback', async (req) => {
    const p = principal(req);
    if (!hasAny(p, 'feedback.view')) throw forbidden();
    const { id } = idParams.parse(req.params);
    return withTenant(db, p.tenantId, async (tx) => {
      await loadInterview(tx, p, id);
      return { data: await feedbackFor(tx, [id]) };
    });
  });

  // All feedback for one candidate on one vacancy, with the summary a hiring decision needs.
  app.get('/applications/:id/feedback', async (req) => {
    const p = principal(req);
    if (!hasAny(p, 'feedback.view')) throw forbidden();
    const { id } = idParams.parse(req.params);
    return withTenant(db, p.tenantId, async (tx) => {
      const app = await tx.selectFrom('applications as a').innerJoin('vacancies as v', 'v.id', 'a.vacancy_id').innerJoin('requisitions as rq', 'rq.id', 'v.requisition_id').select('a.id').where('a.id', '=', id).where(vacancyVisible(p, null)).executeTakeFirst();
      if (!app) throw notFound('Application');
      const interviews = await tx.selectFrom('interviews').select(['id', 'round_name', 'status', 'scheduled_start']).where('application_id', '=', id).orderBy(sql`scheduled_start asc nulls last`).execute();
      const feedback = await feedbackFor(tx, interviews.map((i) => i.id));
      const ratings = feedback.map((f) => f.effective.overall_rating);
      const recs: Record<string, number> = {};
      for (const f of feedback) recs[f.effective.recommendation] = (recs[f.effective.recommendation] ?? 0) + 1;
      return {
        data: {
          interviews: interviews.map((i) => ({ ...i, feedback: feedback.filter((f) => f.interview_id === i.id) })),
          summary: { count: feedback.length, average_rating: ratings.length ? Math.round((ratings.reduce((a, b) => a + b, 0) / ratings.length) * 10) / 10 : null, recommendations: recs },
        },
      };
    });
  });

  // Submitted feedback is never edited. A correction is a new, versioned record with a reason; the
  // original stays, and the audit log links the two.
  app.post('/feedback/:id/corrections', async (req, reply) => {
    const p = principal(req);
    const { id } = idParams.parse(req.params);
    const body = CorrectionBody.parse(req.body);
    return withTenant(db, p.tenantId, async (tx) => {
      const fb = await tx
        .selectFrom('feedback as f')
        .innerJoin('interviews as i', 'i.id', 'f.interview_id')
        .innerJoin('applications as a', 'a.id', 'i.application_id')
        .innerJoin('vacancies as v', 'v.id', 'a.vacancy_id')
        .innerJoin('requisitions as rq', 'rq.id', 'v.requisition_id')
        .select(['f.id', 'f.interview_id', 'i.evaluation_template', 'rq.department_id'])
        .where('f.id', '=', id)
        .where(vacancyVisible(p, null))
        // Feedback is append-only (no UPDATE right), so lock the interview to serialize corrections to it.
        .forUpdate('i')
        .executeTakeFirst();
      if (!fb) throw notFound('Feedback');
      if (!can(p, 'feedback.correct', fb.department_id)) throw forbidden();
      validateScorecard(fb.evaluation_template as EvaluationTemplate, body.competency_ratings);
      const last = await tx.selectFrom('feedback_corrections').select(sql<number>`coalesce(max(version), 0)::int`.as('v')).where('feedback_id', '=', id).executeTakeFirstOrThrow();
      const correction = await tx
        .insertInto('feedback_corrections')
        .values({
          tenant_id: p.tenantId, feedback_id: id, version: last.v + 1, mode: body.mode, overall_rating: body.overall_rating,
          recommendation: body.recommendation, competency_ratings: JSON.stringify(body.competency_ratings), notes: body.notes || null,
          reason: body.reason, corrected_by: p.userId,
        })
        .returning(['id', 'version'])
        .executeTakeFirstOrThrow();
      await recordInterviewEvent(tx, { tenantId: p.tenantId, interviewId: fb.interview_id, type: 'feedback_corrected', reason: body.reason, actorUserId: p.userId, metadata: { feedback_id: id, version: correction.version } });
      await audit(tx, req, { tenantId: p.tenantId, actorUserId: p.userId, action: 'feedback.corrected', entityType: 'feedback', entityId: id, metadata: { correction_id: correction.id, version: correction.version, reason: body.reason } });
      const [row] = await feedbackFor(tx, [fb.interview_id]).then((all) => all.filter((f) => f.id === id));
      return reply.status(201).send({ data: row });
    });
  });

  // Candidates by their latest decision (selected, on hold, rejected, sent to another round), with the
  // remark that was recorded. For hiring managers and interviewers who do not browse the candidate database.
  app.get('/decisions', async (req) => {
    const p = principal(req);
    if (!hasAny(p, 'decisions.record') && !hasAny(p, 'feedback.view')) throw forbidden();
    const f = z.object({ decision: z.enum(['select', 'hold', 'reject', 'additional_round', 'advance', 'all']).default('all') }).parse(req.query);
    const rows = await withTenant(db, p.tenantId, async (tx) => {
      let q = tx
        .selectFrom('hiring_decisions as d')
        .innerJoin('applications as a', 'a.id', 'd.application_id')
        .innerJoin('vacancies as v', 'v.id', 'a.vacancy_id')
        .innerJoin('requisitions as rq', 'rq.id', 'v.requisition_id')
        .innerJoin('candidates as c', 'c.id', 'a.candidate_id')
        .innerJoin('users as u', 'u.id', 'd.decided_by')
        .select(['d.id', 'd.decision', 'd.reason', 'd.decided_at', 'u.full_name as decided_by_name', 'a.id as application_id', 'a.status as application_status', 'c.full_name as candidate_name', 'v.id as vacancy_id', 'v.title as vacancy_title'])
        .where(vacancyVisible(p, null))
        // Only the latest decision for each application counts.
        .where(sql<boolean>`d.decided_at = (select max(d2.decided_at) from hiring_decisions d2 where d2.application_id = d.application_id)`);
      if (f.decision !== 'all') q = q.where('d.decision', '=', f.decision);
      return q.orderBy('d.decided_at', 'desc').limit(200).execute();
    });
    return { data: rows };
  });

  app.post('/applications/:id/decisions', async (req, reply) => {
    const p = principal(req);
    const { id } = idParams.parse(req.params);
    const body = DecisionBody.parse(req.body);
    return withTenant(db, p.tenantId, async (tx) => {
      const app = await tx.selectFrom('applications as a').innerJoin('vacancies as v', 'v.id', 'a.vacancy_id').innerJoin('requisitions as rq', 'rq.id', 'v.requisition_id').select(['a.id', 'a.status', 'rq.department_id']).where('a.id', '=', id).where(vacancyVisible(p, null)).executeTakeFirst();
      if (!app) throw notFound('Application');
      requirePermission(p, 'decisions.record', app.department_id);
      if (app.status !== 'active') throw new AppError(409, 'APPLICATION_CLOSED', 'This application is closed.');
      if (['reject', 'hold'].includes(body.decision) && !body.reason) throw new AppError(400, 'VALIDATION_ERROR', 'Some fields are invalid.', [{ path: 'reason', message: 'Give a reason for this decision.' }]);
      const row = await tx.insertInto('hiring_decisions').values({ tenant_id: p.tenantId, application_id: id, decision: body.decision, reason: body.reason ?? null, decided_by: p.userId }).returning(['id', 'decision', 'reason', 'decided_at']).executeTakeFirstOrThrow();
      await audit(tx, req, { tenantId: p.tenantId, actorUserId: p.userId, action: 'application.decision_recorded', entityType: 'application', entityId: id, metadata: { decision: body.decision, reason: body.reason ?? null } });
      return reply.status(201).send({ data: row });
    });
  });

  app.get('/applications/:id/decisions', async (req) => {
    const p = principal(req);
    if (!canReadInterviews(p)) throw forbidden();
    const { id } = idParams.parse(req.params);
    return withTenant(db, p.tenantId, async (tx) => {
      const app = await tx.selectFrom('applications as a').innerJoin('vacancies as v', 'v.id', 'a.vacancy_id').innerJoin('requisitions as rq', 'rq.id', 'v.requisition_id').select('a.id').where('a.id', '=', id).where(vacancyVisible(p, null)).executeTakeFirst();
      if (!app) throw notFound('Application');
      const rows = await tx.selectFrom('hiring_decisions as d').innerJoin('users as u', 'u.id', 'd.decided_by').select(['d.id', 'd.decision', 'd.reason', 'd.decided_at', 'u.full_name as decided_by_name']).where('d.application_id', '=', id).orderBy('d.decided_at', 'desc').execute();
      return { data: rows };
    });
  });

}

/** Public routes: no session. The token in the body is the only credential. */
export async function publicFeedbackRoutes(app: FastifyInstance) {
  const { db, config } = app;

  app.post('/public/feedback/validate', { config: publicRateLimit(30) }, async (req) => {
    const { token } = TokenBody.parse(req.body);
    return db.transaction().execute(async (tx) => {
      const { link, ctx } = await resolveLink(tx, token);
      await tx.updateTable('feedback_links').set({ last_opened_at: sql`now()`, open_count: sql`open_count + 1` }).where('id', '=', link.id).execute();
      return {
        data: {
          ...bootstrap(ctx),
          expires_at: link.expires_at,
          modes: Object.entries(MODE_LABEL).map(([value, label]) => ({ value, label })),
        },
      };
    });
  });

  // A short-lived signed link to the candidate's most recent resume. The token must still be live.
  app.post('/public/feedback/resume-url', { config: publicRateLimit(30) }, async (req) => {
    const { token } = TokenBody.parse(req.body);
    const expiresAt = new Date(Date.now() + config.FILE_URL_TTL_SECONDS * 1000);
    const doc = await db.transaction().execute(async (tx) => {
      const { link, ctx } = await resolveLink(tx, token);
      const d = await tx
        .selectFrom('candidate_documents')
        .select(['id'])
        .where('candidate_id', '=', ctx.candidate_id)
        .where('document_type', '=', 'resume')
        .where('scan_status', '=', 'clean')
        .orderBy('created_at', 'desc')
        .limit(1)
        .executeTakeFirst();
      if (!d) throw notFound('Resume');
      await audit(tx, req, {
        tenantId: link.tenant_id, actorUserId: null, actorType: 'external_interviewer', actorLabel: ctx.user_email ?? ctx.external_email ?? undefined,
        action: 'feedback_link.resume_link_issued', entityType: 'interview', entityId: ctx.id,
      });
      return { id: d.id, tenantId: link.tenant_id };
    });
    const signed = signFileToken(config.FILE_URL_SECRET, { t: doc.tenantId, d: doc.id, e: Math.floor(expiresAt.getTime() / 1000) });
    return { data: { url: `/api/v1/files/${signed}`, expires_at: expiresAt } };
  });

  app.post('/public/feedback/submit', { config: publicRateLimit(10) }, async (req) => {
    const { token, ...body } = SubmitBody.parse(req.body);
    return db.transaction().execute(async (tx) => {
      const { link, ctx, hash } = await resolveLink(tx, token);
      validateScorecard(ctx.evaluation_template as EvaluationTemplate, body.competency_ratings);

      // The database function locks the link row, checks its state again, inserts the feedback, consumes
      // the link, marks the interviewer submitted and writes the audit event, all in this transaction.
      let feedbackId: string;
      try {
        const res = await sql<{ id: string }>`
          SELECT submit_feedback(${hash}, ${body.mode}::interview_mode, ${body.overall_rating}::smallint,
                                 ${body.recommendation}::feedback_recommendation, ${JSON.stringify(body.competency_ratings)}::jsonb,
                                 ${body.notes}, ${req.id}, ${hashIp(req.ip, config.IP_HASH_SALT)}) AS id`.execute(tx);
        feedbackId = res.rows[0]!.id;
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === 'JMF01') throw invalidLink();
        if (code === 'JMF02' || code === 'JMF04') throw expiredLink();
        if (code === 'JMF03') throw usedLink();
        throw err;
      }
      await notifyFeedbackSubmitted(tx, link.tenant_id, ctx, feedbackId, body.overall_rating, body.recommendation);
      // Nothing about the candidate is returned: the page shows a plain confirmation.
      return { data: { status: 'submitted' } };
    });
  });
}
