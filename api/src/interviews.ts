// Shared interview logic: scorecard templates and validation, who can see an interview, and the
// activity log. The logged-in and the public (token) feedback paths both validate through here, so
// they cannot drift apart.
import { z } from 'zod';
import { vacancyVisible } from './access.js';
import type { Competency, EvaluationTemplate, InterviewMode, InterviewStatus } from './db-types.js';
import type { Tx } from './db.js';
import { AppError, notFound } from './errors.js';
import { hasAny } from './access.js';
import type { Principal } from './permissions.js';

export const MODES = ['google_meet', 'microsoft_teams', 'telephonic', 'face_to_face', 'other'] as const satisfies readonly InterviewMode[];
export const RECOMMENDATIONS = ['strong_yes', 'yes', 'hold', 'no', 'strong_no'] as const;
export const MODE_LABEL: Record<InterviewMode, string> = {
  google_meet: 'Google Meet', microsoft_teams: 'Microsoft Teams', telephonic: 'Telephonic', face_to_face: 'Face-to-face', other: 'Other',
};

export const DEFAULT_COMPETENCIES: Competency[] = [
  { code: 'role_skills', label: 'Role skills', required: true },
  { code: 'communication', label: 'Communication', required: true },
  { code: 'problem_solving', label: 'Problem solving', required: false },
];

export const competencySchema = z.object({
  code: z.string().trim().regex(/^[a-z][a-z0-9_]{1,39}$/, 'Use lowercase letters, digits and underscores.'),
  label: z.string().trim().min(1).max(80),
  required: z.boolean().default(true),
});

export const competenciesSchema = z
  .array(competencySchema)
  .max(12)
  .refine((list) => new Set(list.map((c) => c.code)).size === list.length, 'Each competency needs a different code.');

export function toTemplate(competencies: Competency[]): EvaluationTemplate {
  return { competencies };
}

/** The feedback an interviewer submits. Competency keys and required ones are checked against the template. */
export const feedbackBodySchema = z.object({
  mode: z.enum(MODES),
  overall_rating: z.number().int().min(1, 'Rate from 1 to 5.').max(5, 'Rate from 1 to 5.'),
  recommendation: z.enum(RECOMMENDATIONS),
  competency_ratings: z.record(z.string(), z.number().int().min(1).max(5)).default({}),
  notes: z.string().trim().max(5000).default(''),
});
export type FeedbackBody = z.infer<typeof feedbackBodySchema>;

/** Throws a validation error naming each problem field. */
export function validateScorecard(template: EvaluationTemplate, ratings: Record<string, number>) {
  const issues: { path: string; message: string }[] = [];
  const known = new Set(template.competencies.map((c) => c.code));
  for (const code of Object.keys(ratings)) {
    if (!known.has(code)) issues.push({ path: `competency_ratings.${code}`, message: 'This competency is not part of the scorecard.' });
  }
  for (const c of template.competencies) {
    if (c.required && ratings[c.code] === undefined) issues.push({ path: `competency_ratings.${c.code}`, message: `Rate ${c.label}.` });
  }
  if (issues.length) throw new AppError(400, 'VALIDATION_ERROR', 'Some fields are invalid.', issues);
}

/** Interviews are open to people who work with feedback or decisions, within the vacancies they can see. */
export function canReadInterviews(p: Principal) {
  return hasAny(p, 'interviews.manage') || hasAny(p, 'feedback.view') || hasAny(p, 'decisions.record');
}

export function interviewBase(tx: Tx, p: Principal, agencyId: string | null) {
  return tx
    .selectFrom('interviews as i')
    .innerJoin('applications as a', 'a.id', 'i.application_id')
    .innerJoin('vacancies as v', 'v.id', 'a.vacancy_id')
    .innerJoin('requisitions as rq', 'rq.id', 'v.requisition_id')
    .innerJoin('candidates as c', 'c.id', 'a.candidate_id')
    .where(vacancyVisible(p, agencyId));
}

export async function loadInterview(tx: Tx, p: Principal, id: string, opts: { lock?: boolean } = {}) {
  let q = interviewBase(tx, p, null)
    .select([
      'i.id', 'i.status', 'i.scheduled_start', 'i.scheduled_end', 'i.timezone', 'i.round_name', 'i.mode', 'i.created_by',
      'i.application_id', 'a.status as application_status', 'a.vacancy_id', 'rq.department_id', 'a.candidate_id',
    ])
    .where('i.id', '=', id);
  if (opts.lock) q = q.forUpdate('i');
  const row = await q.executeTakeFirst();
  if (!row) throw notFound('Interview');
  return row;
}

export async function recordInterviewEvent(
  tx: Tx,
  e: { tenantId: string; interviewId: string; type: string; reason?: string | null; metadata?: Record<string, unknown>; actorUserId?: string | null },
) {
  await tx
    .insertInto('interview_events')
    .values({
      tenant_id: e.tenantId,
      interview_id: e.interviewId,
      event_type: e.type,
      reason: e.reason ?? null,
      metadata: JSON.stringify(e.metadata ?? {}),
      actor_user_id: e.actorUserId ?? null,
    })
    .execute();
}

/** When the interviewers' feedback is due: a configurable number of hours after the interview ends. */
export async function feedbackDueAt(tx: Tx, scheduledEnd: Date | null): Promise<Date | null> {
  if (!scheduledEnd) return null;
  const s = await tx.selectFrom('tenant_settings').select('feedback_due_hours').executeTakeFirst();
  return new Date(scheduledEnd.getTime() + (s?.feedback_due_hours ?? 48) * 3_600_000);
}

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export const IN_PLAY: InterviewStatus[] = ['draft', 'scheduled', 'confirmed'];

/** A link's state as people see it: expiry is derived from the clock, never stored. */
export function linkState(l: { status: 'active' | 'consumed' | 'revoked'; expires_at: Date }, now = new Date()): 'active' | 'expired' | 'consumed' | 'revoked' {
  if (l.status === 'active' && l.expires_at <= now) return 'expired';
  return l.status;
}

/** The only candidate details an interviewer sees: no contact details, no compensation. */
export function candidateBrief(c: {
  full_name: string; current_title: string | null; total_experience_years: number | null; skills: string[]; profile_summary: string | null; city: string | null;
}) {
  return {
    full_name: c.full_name,
    current_title: c.current_title,
    total_experience_years: c.total_experience_years,
    skills: c.skills,
    city: c.city,
    summary: c.profile_summary,
  };
}
