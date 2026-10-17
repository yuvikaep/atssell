# JobsMato ATS — API Contract Draft
Version 1.0 | REST JSON | Prefix `/api/v1`

## Conventions
- Authenticated endpoints require a valid session/JWT and tenant-scoped authorization.
- IDs are UUIDs. Dates are ISO-8601 timestamps with timezone.
- Pagination: `?page=1&page_size=25`; default 25, max 100.
- Errors use `{ "error": { "code": "VALIDATION_ERROR", "message": "Human-readable message", "request_id": "..." } }`.
- Never trust `tenant_id`, role, or permissions supplied by the browser. Resolve them from the authenticated principal.
- Public feedback routes are token-protected and rate-limited; do not log raw tokens.

## Authentication / organization
- `GET /me` — current user and effective roles.
- `GET /departments` — list permitted departments.
- `POST /departments` — create department (Company Admin).
- `POST /users/invitations` — invite user and assign role.
- `PATCH /users/{userId}` — update user status/role (authorized admin).

## Requisitions / vacancies
- `POST /requisitions` — create requisition.
- `POST /requisitions/{id}/submit-approval` — request approval.
- `POST /requisitions/{id}/approve` — approve/reject with reason.
- `GET /vacancies` — list permitted vacancies with filters.
- `POST /vacancies/{id}/assign-recruiter` — assign recruiter.
- `POST /vacancies/{id}/assign-agency` — assign agency.
- `PATCH /vacancies/{id}` — update status or vacancy fields.

## Candidates / applications / submissions
- `POST /candidates` — create candidate.
- `POST /candidates/imports` — create CSV import job.
- `POST /candidates/{id}/documents` — upload resume/document.
- `GET /candidates` — search/filter permitted candidates.
- `GET /candidates/{id}` — retrieve permitted profile.
- `POST /applications` — link candidate to vacancy.
- `PATCH /applications/{id}/stage` — update stage and reason.
- `POST /applications/{id}/submissions` — create source/submission record.
- `GET /applications/{id}/history` — permitted activity and ownership history.
- `POST /submissions/{id}/resolve-ownership` — authorized dispute decision with reason.

## Interviews / feedback links
- `POST /applications/{id}/interviews` — create interview.
- `PATCH /interviews/{id}` — reschedule/update interview.
- `POST /interviews/{id}/cancel` — cancel with reason.
- `POST /interviews/{id}/feedback-links` — generate secure one-time link.
- `POST /feedback-links/{token}/validate` — validate token and return minimum page bootstrap data.
- `GET /feedback-links/{token}` — return only approved interview/candidate fields.
- `POST /feedback-links/{token}/submit` — validate and persist feedback exactly once.
- `POST /feedback-links/{id}/revoke` — authenticated recruiter/admin revokes link.
- `GET /interviews/{id}/feedback` — permitted feedback view.
- `POST /feedback/{id}/corrections` — create audited correction record, never silently overwrite.

## Offers / joining / analytics
- `POST /applications/{id}/offers` — create offer.
- `PATCH /offers/{id}` — update permitted offer status/fields.
- `POST /applications/{id}/joining-records` — create/update joining record.
- `GET /analytics/hiring-funnel` — role-scoped funnel.
- `GET /analytics/agency-performance` — authorized agency metrics.
- `GET /analytics/feedback-sla` — pending/overdue feedback.
- `POST /exports` — enqueue authorized export job.

## Feedback submission payload
{
  "mode": "google_meet",
  "overall_rating": 4,
  "recommendation": "yes",
  "competency_ratings": {
    "role_skills": 4,
    "communication": 4,
    "problem_solving": 3
  },
  "notes": ""
}

## Feedback link security requirements
1. Generate at least 256 bits of cryptographically secure randomness.
2. Store only a one-way hash of the token; compare in constant time where applicable.
3. Do not consume token on GET/open. Link scanners and previews may prefetch URLs.
4. Token must be active, unexpired, not revoked, and bound to the intended interviewer/interview.
5. Validate required fields and enum values server-side.
6. In one transaction: lock token row, verify active, insert feedback, mark token consumed, write audit event.
7. Add unique constraint on `(interview_id, interviewer_id)` to prevent duplicate feedback.
8. Revoke previous active token when regenerating; issue a new token hash.
9. Rate-limit invalid attempts and use generic errors that do not reveal candidate existence.
10. Avoid raw token in logs, analytics, referrer headers, and third-party scripts. Set `Referrer-Policy: no-referrer`.
11. Optional OTP/identity verification for sensitive roles.
12. After submission, show a confirmation page with no further candidate details.

## Suggested status codes
- 200 success
- 201 created
- 400 malformed/validation error
- 401 unauthenticated or invalid public token (generic response)
- 403 authenticated but unauthorized
- 404 resource not found or not visible
- 409 token already consumed / conflicting state
- 410 expired or revoked link (generic safe page)
- 422 semantically invalid payload
- 429 rate limit exceeded
