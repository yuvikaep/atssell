# Security

What is enforced, where, and how it is checked. Anything not listed here is not claimed.

## Tenant isolation
- Every table carrying `tenant_id` has row-level security **enabled and forced**, with a policy tying rows to `app.tenant_id`.
- The API connects as `jm_app`: not a superuser, no `BYPASSRLS`. Each request opens a transaction and sets `app.tenant_id` (`withTenant`).
- Foreign keys between tenant tables are composite `(tenant_id, id)`, so a row cannot point at another company's row.
- Checked by `server/test/security.test.ts` (catalogue check of every tenant table, role attributes, no-tenant-set returns nothing, cross-tenant read/write matrix) and `tenancy*.test.ts`.

## Authentication and sessions
- Passwords: scrypt. Sessions: random 256-bit cookie token, only its SHA-256 stored; `HttpOnly`, `SameSite=Lax`.
- Cookie-authenticated writes must carry the web app's `Origin` (CSRF).
- Every signed-in user can change their own password (Account & password in the user menu): the current password is required, other sessions are ended, and success and failed attempts are audited without the password.
- Login, reset, invitation and feedback endpoints are rate limited. Responses do not reveal whether an account exists.
- One-time links (invite, reset, feedback) travel in the URL fragment, are stored hash-only, are never logged, and use `Referrer-Policy: no-referrer` and `Cache-Control: no-store`.
- **Not built:** MFA/OTP, SSO, password-breach checks, session list/revoke UI.

## Authorization
- Roles map to permissions; scopes are company-wide or per department. Vacancy, candidate and requisition visibility are central helpers (`access.ts`).
- Agency users have only `submissions.create` and `agency_portal.use`, and see only their own submissions' stored profile.
- Contact details and pay are removed server-side unless the role allows them, including in CSV exports.
- Every authenticated route sits behind one session hook. The route table is asserted in tests: the public surface is a snapshot (11 routes, listed in `server/test/__snapshots__/`), and every other route must answer 401 without a session. Adding a public route changes the snapshot and must be a deliberate decision.

## Data integrity
- Audit, ownership, stage-history, feedback, feedback-correction and interview-event tables are append-only (trigger + no UPDATE/DELETE grant). Tested.
- Candidate ownership is first-come and cannot be changed by the company; duplicate sourcing is rejected.

## Files and exports
- Uploads: type detected from content, size limited, scanned before they are served (dev scanner locally; ClamAV driver for production), stored under generated keys, served through short-lived signed links.
- Exports: fields fixed from the requester's permissions at request time and re-checked at build time; only the requester can fetch; links last 5 minutes; files expire after 24 hours; spreadsheet formulas are neutralised; request, completion and every download are audited.

## Dependencies
- `npm audit --omit=dev` is part of the test run and fails on high or critical findings.

## Known gaps
No MFA; no penetration test has been done; resumes are not parsed or malware-scanned beyond the scanner in use; backups and restore are scripted but must be rehearsed in your own environment (see `docs/RUNBOOK.md`).

## Reporting
Send security reports privately to the maintainers; do not open public issues for vulnerabilities.
