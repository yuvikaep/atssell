# Schema v1.1 — Change Log
Revises `schema.sql` (v1.0). New file: `schema_v1.1.sql`. v1.0 is kept unchanged for reference.

Validated on PostgreSQL 16: the schema loads cleanly (42 tables, 41 RLS policies), and 19
behaviour tests pass when run as a non-superuser app role. Tests are in `schema_tests/`.

## 1. Tenant isolation (README "Before production" items)
- Every tenant-owned table has `UNIQUE (tenant_id, id)`. All FKs between tenant tables are now
  composite `(tenant_id, x_id)`, so a row cannot reference another tenant's row.
- Row-Level Security is enabled **and forced** on every tenant table. The app sets the tenant per
  transaction: `SELECT set_config('app.tenant_id', $1, true)`. With no tenant set, queries return nothing.
- The web app's DB role must not have `BYPASSRLS`. Background workers and platform-admin tooling use a
  separate role that does.
- Platform Super Admins moved to their own `platform_admins` table (no tenant).

## 2. Fixes to gaps found in v1.0
| # | Gap in v1.0 | v1.1 change |
|---|---|---|
| 1 | Feedback corrections broke `UNIQUE (interview_id, interviewer_id)` | `feedback` is the immutable original (UPDATE/DELETE blocked by trigger). New `feedback_corrections` table, versioned, `reason` required. Effective feedback = latest correction, else the original. |
| 2 | No stage history; stages hard-coded as text | New `pipeline_stages` (configurable per tenant), `pipeline_stage_transitions` (allowed moves), `application_stage_events` (append-only history). `applications.stage` → `stage_id`. |
| 3 | No permissions | New `permissions` catalogue (26 codes seeded) and `role_permissions`. System roles (`tenant_id` NULL) are shared and read-only to tenants. A trigger stops assigning another tenant's role. |
| 4 | Missing tables | Added `tenant_settings`, `user_invitations`, `candidate_merges`, `candidate_notes`, `tasks`, `import_jobs`, `export_jobs`, `requisition_approvals`, `offer_approvals`. |
| 5 | One active link per interviewer was only a comment | Partial unique index `uq_feedback_links_one_active`. |
| 6 | `feedback_links.interview_id` could disagree with the interviewer's interview | Composite FK `(tenant_id, interviewer_id, interview_id)` → `interviewers`. Same for `feedback`, which also gets an FK pinning `application_id` to the interview's application. |
| 7 | Stored `expired` / `overdue` states need a background job | Removed. A link is expired when `expires_at <= now()`. Feedback is overdue when `feedback_status = 'pending'` and the interview's `feedback_due_at < now()`. |
| 8 | `UNIQUE (candidate_id, vacancy_id)` blocked reapplying | Replaced with a partial unique index on active applications only. |
| 9 | Requisition headcount vs vacancies undefined | One requisition → one or more vacancies. Each vacancy has its own `title`, `location`, `headcount`, `owner_user_id`. The app keeps the vacancy headcount total ≤ the requisition headcount. |

## 3. Atomic feedback submission in the database
`submit_feedback(token_hash, mode, rating, recommendation, competency_ratings, notes, request_id, ip_hash)`
does everything in the caller's transaction: resolve the link through the token-only RLS policy,
lock the row, check state, insert feedback, consume the link, mark the interviewer submitted, and
write the audit event. It raises errors with stable codes that the API maps to responses:

| SQLSTATE | Meaning | HTTP |
|---|---|---|
| JMF01 | invalid token | 401 |
| JMF02 | expired or revoked | 410 |
| JMF03 | already submitted (incl. via a regenerated link) | 409 |
| JMF04 | interview cancelled | 410 |

Tested: 20 concurrent submissions of the same token → exactly 1 success, 19 `JMF03`.

## 4. Other hardening
- Department hierarchy cycles rejected by trigger.
- Append-only triggers on `audit_events`, `ownership_events`, `application_stage_events`,
  `feedback`, `feedback_corrections`. A retention purge can delete rows by setting
  `app.allow_purge = 'on'` for its own transaction.
- `candidate_documents`: `sha256` and `scan_status`. Downloads only when `scan_status = 'clean'`.
- `notifications.dedupe_key` + unique constraint, so a retried scheduler cannot send duplicate reminders.
- `vacancy_agencies.status` (the agency portal shows only active assignments). `vacancy_recruiters.unassigned_at` keeps assignment history.
- `submissions.resume_document_id` (the resume as each source submitted it) and `ownership_expires_at`.
- `interviews.evaluation_template` snapshot, so editing a template does not change past scorecards.
- CHECKs: experience and CTC ranges, rejection reasons required, a cancelled interview needs a reason, a scheduled interview needs times.
- `pg_trgm` index on candidate names for fuzzy duplicate warnings; GIN index on skills.

## 5. Rules the application must follow
1. **Regenerating a link must revoke the old link first, even if it has expired.** An expired link
   keeps `status = 'active'`, and the one-active-link index blocks a new link until the old one is revoked.
2. Store phone numbers in E.164 format so exact-match duplicate detection works.
3. Validate competency ratings against `interviews.evaluation_template` before calling `submit_feedback`.

## 6. API contract changes this implies
- **Raw token out of the URL path.** Links become `https://<host>/f#<token>`. The fragment is never
  sent to the server, so it never reaches access logs. The page posts the token in the request body:
  `POST /public/feedback/validate {token}` and `POST /public/feedback/submit {token, ...}`.
  This replaces `GET /feedback-links/{token}`, `POST /feedback-links/{token}/validate` and `/submit`.
- `PATCH /applications/{id}/stage` takes `stage_id` and is checked against `pipeline_stage_transitions`.

## 7. Open questions for product
1. **Agency accounts across clients.** Agency users are still per tenant: an agency serving two
   client companies on JobsMato has two separate logins. Is that acceptable for the MVP, or do agencies
   need one login that spans clients? The second option is a significant model change, best decided before Sprint 3.
2. **Expiry default.** `tenant_settings.feedback_link_expiry_hours` defaults to 168 (7 days), as in the PRD. Confirm.
3. **Ownership window.** `default_ownership_policy` defaults to `{"window_days": 90}`; the PRD gives no number. Confirm.
