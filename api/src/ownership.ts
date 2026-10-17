// Candidate ownership: first submission wins, job by job.
//
// The first accepted submission of a candidate for a job (by the company's own recruiter or by an
// agency) owns that submission, permanently. A later attempt to submit the same candidate for the same
// job is refused and recorded in `duplicate_attempts`; it never replaces the owner. The same candidate
// submitted for a different job is a separate submission with its own owner.
import type { FastifyRequest } from 'fastify';
import { audit } from './audit.js';
import type { Principal } from './permissions.js';
import { sql } from 'kysely';
import type { OwnershipState } from './db-types.js';
import type { Tx } from './db.js';

export interface CandidateOwner {
  /** The agency credited with sourcing the candidate, or null when the company's own staff sourced them. */
  agencyId: string | null;
}

export async function recordOwnershipEvent(
  tx: Tx,
  e: { tenantId: string; submissionId: string; type: string; from: string | null; to: string | null; reason?: string | null; actorUserId?: string | null },
) {
  await tx
    .insertInto('ownership_events')
    .values({
      tenant_id: e.tenantId,
      submission_id: e.submissionId,
      event_type: e.type,
      previous_state: e.from,
      new_state: e.to,
      reason: e.reason ?? null,
      actor_user_id: e.actorUserId ?? null,
    })
    .execute();
}

/**
 * Serializes submissions that share an email or phone, so two sources submitting the same new
 * candidate at the same moment cannot both create it: one is credited, the other is a duplicate.
 * Locks are taken in sorted order to avoid deadlocks.
 */
export async function lockContacts(tx: Tx, tenantId: string, email: string | null, phone: string | null) {
  const keys = [email ? `e:${email.toLowerCase()}` : null, phone ? `p:${phone}` : null].filter((k): k is string => k !== null).sort();
  for (const key of keys) {
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${tenantId}:${key}`}, 0))`.execute(tx);
  }
}

/**
 * Who is credited with sourcing a candidate: whoever submitted them first. A candidate with no
 * recorded submission at all was added by the company's own staff (no application yet), so the
 * company holds the credit.
 */
export async function candidateOwner(tx: Tx, candidateId: string): Promise<CandidateOwner> {
  const first = await tx
    .selectFrom('submissions as s')
    .innerJoin('applications as a', 'a.id', 's.application_id')
    .select('s.agency_id')
    .where('a.candidate_id', '=', candidateId)
    .orderBy('s.submitted_at')
    .orderBy('s.id')
    .limit(1)
    .executeTakeFirst();
  return { agencyId: first?.agency_id ?? null };
}

/** What an agency is told about one of its submissions. Credit is never shared, so there is one state. */
export function agencyOwnershipView(state: OwnershipState): { label: string; detail: string | null } {
  if (state === 'rejected') {
    return { label: 'Rejected as duplicate', detail: 'This candidate was already in the company database, so the submission was not credited to your agency.' };
  }
  return { label: 'Credited', detail: 'You sourced this candidate first, so they are credited to your agency.' };
}

export interface JobSubmission {
  submissionId: string;
  applicationId: string;
  agencyId: string | null;
  agencyName: string | null;
  sourceUserId: string | null;
  sourceUserName: string | null;
  submittedAt: Date;
}

/**
 * The accepted owner of this candidate on this job, if the candidate already has an active application
 * for it. This is the one place the "first submission wins" check lives.
 */
export async function existingJobSubmission(tx: Tx, candidateId: string, vacancyId: string): Promise<JobSubmission | null> {
  const row = await tx
    .selectFrom('applications as a')
    .innerJoin('submissions as s', 's.application_id', 'a.id')
    .leftJoin('agencies as ag', 'ag.id', 's.agency_id')
    .leftJoin('users as u', 'u.id', 's.source_user_id')
    .select(['s.id as submission_id', 'a.id as application_id', 's.agency_id', 'ag.name as agency_name', 's.source_user_id', 'u.full_name as user_name', 's.submitted_at'])
    .where('a.candidate_id', '=', candidateId)
    .where('a.vacancy_id', '=', vacancyId)
    .where('a.status', '=', 'active')
    .where('s.ownership_state', '=', 'accepted')
    .orderBy('s.submitted_at')
    .limit(1)
    .executeTakeFirst();
  return row
    ? { submissionId: row.submission_id, applicationId: row.application_id, agencyId: row.agency_id, agencyName: row.agency_name, sourceUserId: row.source_user_id, sourceUserName: row.user_name, submittedAt: row.submitted_at }
    : null;
}

/** Serializes everyone submitting this candidate for this job, so the database picks one winner. */
export async function lockJobCandidate(tx: Tx, tenantId: string, vacancyId: string, candidateId: string) {
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${tenantId}:job:${vacancyId}:${candidateId}`}, 0))`.execute(tx);
}

/** Records a refused duplicate, apart from the accepted owner. Ids only: no personal details. */
export async function logDuplicateAttempt(
  tx: Tx, req: FastifyRequest | null, p: Principal,
  a: { vacancyId: string; candidateId: string; originalSubmissionId: string | null; agencyId: string | null },
) {
  await tx.insertInto('duplicate_attempts').values({
    tenant_id: p.tenantId, vacancy_id: a.vacancyId, candidate_id: a.candidateId, original_submission_id: a.originalSubmissionId,
    attempted_by: p.userId, attempted_agency_id: a.agencyId,
  }).execute();
  await audit(tx, req, {
    tenantId: p.tenantId, actorUserId: p.userId, action: 'submission.duplicate_attempt', entityType: 'vacancy', entityId: a.vacancyId,
    metadata: { candidate_id: a.candidateId, original_submission_id: a.originalSubmissionId, agency_id: a.agencyId },
  });
}
