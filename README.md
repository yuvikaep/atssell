# JobsMato ATS

Multi-tenant applicant tracking system for companies, their internal recruiters, external agencies
and interviewers. Product spec: [`PRD/`](PRD/). Database design notes: [`PRD/schema_changes_v1.1.md`](PRD/schema_changes_v1.1.md).

**Status: the final MVP specification is built** (four roles, first submission wins, agency commercials, employment tracking, leaderboards). See [`docs/SPEC_COVERAGE.md`](docs/SPEC_COVERAGE.md) for every requirement and what is and is not done.

Nothing is committed to git yet; review the working tree first.

## Quick start

Needs Node 22+ and Homebrew `postgresql@16` (`brew install postgresql@16`).

```bash
npm install
cp .env.example .env
npm run db:init      # local Postgres in .pgdata/ on localhost:5433, plus the jm_app role
npm run db:migrate
npm run db:seed      # demo company, code "demo"
npm run seed:demo    # fills it with jobs, agencies and terms, candidates, interviews, joins, exits and replacements (API must be running)
npm run dev          # API on :3000, web on http://localhost:5180
```

Sign in at http://localhost:5180 with company code `demo` and password `demo-password-123`:

| Role | Logins |
|---|---|
| HR Lead | `admin@demo.test` |
| Company Recruiter | `recruiter@demo.test`, `recruiter2@demo.test` |
| Agency | `neha@northstar.test` (with sub-recruiter `nikhil@northstar.test`), `sam@summit.test`, `anil@apex.test` (the last three exist after `npm run seed:demo`) |
| Interviewer | `ishita@demo.test`, `karan@demo.test` |

In development, invitation and password-reset emails are printed to the API console (`[dev-mail]` lines).

| Command | What it does |
|---|---|
| `npm run dev` | API (watch mode) and web app together |
| `npm test` | API tests against a real Postgres test database (`jobsmato_test`, reset each run) |
| `npm run typecheck` | Type-check API and web |
| `npm run db:start` / `db:stop` | Start or stop the local Postgres |
| `npm run -w api load-test` | Seeds a throwaway company through the API and measures read latency under concurrent load (needs the API running) |
| `npm run -w api pilot:baseline -- --company demo` | Prints the pilot baseline numbers for a company |
| `npm run -w api retention:report -- --company demo` | Lists candidates past or near their retention date (changes nothing) |
| `bash scripts/backup.sh` / `bash scripts/restore-drill.sh` | Back up the database and files; prove the latest backup restores |
| `docker compose up --build` | Production-shaped stack: Postgres, S3 API, ClamAV, mail catcher, API, web on http://localhost:8080 |
| `npm run tenant:create -- --name "Acme" --slug acme --admin-email a@acme.test --admin-name "Asha Rao"` | Provision a company. Prints a one-time set-password link for its first admin |

## Layout

```
api/        Fastify + Kysely REST API (/api/v1)
  src/routes/     auth, invitations, signed file download (public); me, departments, users,
                  requisitions, vacancies, agencies, candidates, applications,
                  agency-members (company side) and agency-portal (agency side)
  src/access.ts   who can see which requisitions, vacancies and candidates (row visibility, field redaction)
  src/ownership.ts  first-come ownership: who is credited, and the lock that makes it race-proof
  src/routes/analytics.ts, exports.ts, offers.ts  reports and dashboard, CSV exports, offers and joining
  src/providers/  S3 storage, ClamAV scanner, SMTP mailer (chosen by config in providers/index.ts)
  src/worker.ts   reminders, email delivery with retry, export building
  src/storage.ts  private file storage, content-type checks, malware scan hook, signed download links
  src/services/   sessions, tenant provisioning
  test/           Vitest suites, run against Postgres as the restricted app role
web/        React + Vite + TanStack Router/Query
db/migrations/  Plain SQL, applied in order by api/src/migrate.ts
docs/       Security, threat model, runbook, data protection, pilot plan
scripts/    Database, backup and restore-drill scripts
docker-compose.yml, api/Dockerfile, web/Dockerfile   Production-shaped stack
PRD/        Product spec, schema v1.1, schema behaviour tests
```

## The four roles

| Role | What they do |
|---|---|
| **HR Lead** | Creates jobs, assigns recruiters and agencies, sees every candidate, sets agency terms, schedules interviews, marks candidates joined and exited, tracks replacements, closes jobs, sees dashboards and both leaderboards. The only role that can correct ownership (audited). |
| **Company Recruiter** | Works only on jobs assigned to them: sources candidates, schedules interviews, sees interview and feedback status, and their own performance. Cannot raise jobs or assign agencies. |
| **Agency** (optionally with **sub-recruiters** it invites itself) | Sees assigned jobs, submits candidates, sees the status of its own submissions, its own performance and its commercial terms. Never sees other agencies or the company database. |
| **Interviewer** | Sees only interviews they are assigned to and gives feedback (account, or a one-time secure link for people outside the company). |

Earlier roles (HR head, hiring manager, recruitment manager, offer approver) still exist for people who already hold them, but cannot be given to anyone new.

## First submission wins

Per job: the first accepted submission of a candidate (by a recruiter or an agency) owns it permanently. A later attempt for the same candidate and job is refused and written to `duplicate_attempts`; it never changes the owner. The same candidate on another job is a separate submission. The database decides concurrent attempts (advisory lock, unique indexes on one accepted owner per application and one phone number per company). Candidates are matched by normalised phone, and by email; records are never merged automatically.

## Documentation

[`docs/SECURITY.md`](docs/SECURITY.md) · [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md) · [`docs/RUNBOOK.md`](docs/RUNBOOK.md) · [`docs/DATA_PROTECTION.md`](docs/DATA_PROTECTION.md) · [`docs/PILOT_PLAN.md`](docs/PILOT_PLAN.md)

## Using the hiring flow (Sprint 2)

With the demo company (`admin@demo.test`):

1. **Requisitions** → New requisition → Submit for approval (pick approvers in order). A different approver reviews it; the person who raised it cannot approve it.
2. Once approved, **Open vacancy** on the requisition. Positions can be split across several vacancies, never more than approved.
3. On the vacancy, assign recruiters and agencies. Recruiters only see vacancies assigned to them.
4. **Candidates** → Add candidate. Same email or phone as an existing candidate is blocked; a similar name only warns. Attach a PDF/DOC/DOCX resume.
5. **Pipeline** (or the vacancy's Candidates tab): add candidates, move them through the stages. Rejecting or withdrawing needs a reason.

### Agencies and ownership (Sprint 3)

1. **Agencies** → add an agency → its page → **Invite member** (admin or recruiter). The invitee gets a link, sets a password and lands in the **agency portal**.
2. On a vacancy's Overview tab, assign the agency. The gear next to it sets notes only that agency sees before submitting.
3. The agency sees only its assigned vacancies and submits candidates (profile, resume, how they found them, consent).
4. **Ownership is first come, first credited, and automatic.** Whoever sources a candidate first (an agency, or the company's own staff) is credited for good. Nobody at the company can decide or change it, and there is no review queue.
5. Anyone sourcing a candidate who is already in the database, from any source, is **rejected as a duplicate**: nothing is stored beyond an audit record. The one exception is the owner itself, which can submit its own candidate to another vacancy.
6. The candidate's profile shows **Sourced by** for the company. Agencies see only their own submissions.

New settings in `.env` (see `.env.example`): `STORAGE_DIR` (resume files, git-ignored `.storage/`),
`FILE_URL_SECRET` (signs download links), `FILE_URL_TTL_SECONDS`.

## Security model

- **Tenant isolation, three layers.**
  1. Every protected request resolves the tenant from the session, never from the request.
  2. Each request runs in a transaction that sets `app.tenant_id`. PostgreSQL Row-Level Security,
     forced on every tenant table, limits all reads and writes to that tenant.
  3. Composite `(tenant_id, id)` foreign keys stop one tenant's row from pointing at another tenant's row.

  The web server connects as `jm_app` (`NOBYPASSRLS`). Migrations, provisioning and seeds use the owner connection.
- **Sessions.** A random 256-bit cookie (`HttpOnly`, `SameSite=Lax`, `Secure` in production); only its
  SHA-256 is stored. Roles and permissions are reloaded on every request, so role changes and
  deactivation take effect immediately. Deactivating a user or resetting a password revokes their sessions.
- **One-time links** (invitation, password reset, and later feedback): 256-bit tokens, stored as hashes,
  sent in the URL fragment (`/invite#token`). Browsers never send the fragment to a server, so it stays
  out of access logs. The page removes it from the address bar and posts it in the request body.
- **CSRF.** Writes from another `Origin` are rejected. Public endpoints are rate limited per IP.
- **Passwords.** scrypt (N=2^15, r=8, p=3), at least 12 characters. Login checks a dummy hash when the
  user doesn't exist, so response timing doesn't reveal which emails have accounts.
- **Audit.** Sign-ins (including failures), invitations, role changes, user status changes and
  department changes are written to `audit_events` in the same transaction as the change. The app role
  can insert into the audit log but cannot update or delete it.
- **Who sees what (Sprint 2).** Department-scoped roles limit requisitions, vacancies and candidates to
  their department. Recruiters see only vacancies assigned to them. Email, phone and CTC are removed from
  API responses, search and duplicate checks for roles without `candidates.view_contact` or
  `candidates.view_compensation`; they are not just hidden in the UI.
- **Resumes.** Type is checked from file content, not the filename. Files are scanned before they are stored
  (the dev scanner only catches the EICAR test file; ClamAV replaces it before real data), kept under
  `<tenant>/candidates/<id>/<random>`, never exposed by key, and downloaded through a signed link that
  expires in 5 minutes. Downloads are refused unless the scan result is `clean`.
- **Agencies are walled off.** Agency roles hold no internal permission at all (only `agency_portal.use` and
  `submissions.create`), so every internal page and endpoint refuses them. They use `/agency/*` only, which is
  scoped to their own agency: assigned vacancies, a trimmed vacancy view (no budget, owner, recruiters or other
  agencies), and their own submissions. An agency recruiter sees only their own submissions; an agency admin
  sees the whole agency's. Agencies read a stored copy of what they submitted, never the canonical candidate
  record, so nothing about another source can leak into their view. A rejected duplicate says only that the
  candidate is already in the company database: never who sourced them or anything about them.
- **First come, first credited, race-proof.** Submissions that share an email or phone are serialized with a
  database lock, so two agencies submitting the same new candidate at once give exactly one credit and one
  duplicate rejection. The duplicate check runs before the resume is stored, so rejected attempts leave no files.
- **History is append-only.** Stage history, audit events, feedback and ownership events cannot be updated
  or deleted by the app role.
- Responses carry `Referrer-Policy: no-referrer`, `Cache-Control: no-store` and a restrictive CSP.

## Sprints 4–6 scope

| Area | What exists | Known gaps |
|---|---|---|
| Interviews (S4) | Scorecard rounds per vacancy, scheduling in an explicit time zone, panels, reschedule/cancel with reasons, hash-only one-time feedback links for external interviewers, "My interviews" for colleagues, corrections as versioned records, hiring decisions | No calendar or video-meeting integration: times and links are entered by hand |
| Notifications (S4) | In-app notices, to-dos and queued email with retry; feedback reminders and overdue chasers; also requisition approval requests and agency submissions | Fixed rules, no per-user preferences; reminder emails cannot contain the feedback link (only its hash is stored) |
| Reports (S5) | Hiring funnel, time to hire, vacancy ageing, feedback turnaround, recruiter activity, agency performance (needs agency management), offers and joining; each states its definition and range; everything scoped to the vacancies the viewer can see | No saved reports or scheduled delivery |
| Exports (S5) | CSV of candidates, pipeline and vacancies built by the worker; columns follow the requester's permissions; spreadsheet-formula safe; 24-hour expiry, requester-only signed link, audited | No Excel format; 50,000-row cap |
| Security checks (S5) | Route-table test (public surface is a snapshot; every other route must answer 401), RLS coverage, role attributes, append-only grants, cross-tenant matrix, injection and traversal probes, `npm audit` gate | MFA is not built; no external penetration test has been done |
| Providers (S5) | S3 storage, ClamAV (clamd) scanner and SMTP mailer behind config; production refuses the development ones. Verified: fakes in unit tests, and the real ClamAV, S3 API and SMTP in the Docker stack | Not run against real AWS S3 or a real mail provider; no AI resume parsing |
| Pilot readiness (S5) | Backup and restore drill (both run), load test, baseline and retention scripts, CI workflow, Dockerfiles and compose, runbook, pilot plan, data-protection notes | CI workflow has not run on GitHub; load test was one machine, read paths only; no automatic data deletion |
| Offers and joining (S6) | Draft → ordered approval rounds → release → candidate response → joining outcome (joined, delayed, backed out) moving the application to Hired or Withdrawn; follow-up to-dos; amounts only for offer managers and approvers | No offer letter generation or e-signature; no compensation bands or budget check |

## Sprint 3 scope vs. backlog

| Backlog item | Status |
|---|---|
| Invite agency and create agency workspace | Done: company invites admins and recruiters; agency sees only assigned vacancies and its own submissions |
| Submit candidates and preserve source history | Done: source, submitter, time, resume, declaration and consent recorded per submission |
| Ownership policy and dispute review | Replaced by a simpler rule at the product owner's request: first to source is credited automatically and permanently, later attempts are rejected as duplicates, and the company cannot change it. The PRD's configurable window and dispute review were removed. Cross-vacancy reuse works for the owning agency |

Known gaps: agency admins cannot yet invite their own recruiters (the company does it); duplicates are matched on
an exact email or phone only (a similar name is not a duplicate); there is no company-facing list of rejected
duplicate attempts yet (they are in the audit log as `agency.submission_rejected_duplicate`); an agency serving two
client companies still needs a login per company (open product question in `PRD/schema_changes_v1.1.md`).

Because credit can never be changed, a wrongly credited candidate cannot be corrected from the app. If that
turns out to matter in the pilot, a platform-admin-only correction with an audit trail is the safe way to add it.

## Sprint 2 scope vs. backlog

| Backlog item | Status |
|---|---|
| Requisition and approval workflow | Done: draft, submit, ordered approvers, approve/reject with reason, resubmit as a new round, cancel, audit |
| Vacancies; assign recruiters and agencies; restricted access | Done. Agency logins and the portal arrived in Sprint 3 |
| Candidate create, resume upload, signed downloads | Done, scan is a dev stub (see above) |
| Candidate search and filtering | Done: name, title, skills, city, experience, notice period, contact for permitted roles |
| Duplicate detection and review | Done: exact email/phone blocks, similar name warns, merge with history, no silent merge |
| Application and pipeline stages | Done: allowed transitions, reasons, history, board and table views |
| CSV import | Not done (endpoint `POST /candidates/imports` is in the API draft) |

Known gaps: resumes are stored on local disk (S3 before pilot); no resume parsing; candidates cannot yet be
exported.

## Sprint 1 scope vs. backlog

| Backlog item | Status |
|---|---|
| Tenant-aware shell; tenant resolved server-side; cross-tenant tests | Done (tenants provisioned by CLI; no platform-admin UI yet) |
| Login/invitation flow; permissions enforced on every protected endpoint | Done: login, logout, invitations, password reset, 9 built-in roles, 26 permissions |
| Create/edit/deactivate departments; assign scoped roles | Done: department-scoped roles, hierarchy, cycle and deactivation rules |

Not in Sprint 1, still to do:
- MFA (`tenant_settings.mfa_required_for_admins` exists, nothing enforces it)
- AWS SES email (the console mailer refuses to run in production)
- SSO
- Platform-admin UI
- Custom roles
- CI pipeline
- Deployment configuration

## Conventions

- Errors: `{ "error": { "code", "message", "request_id", "details?" } }`. Lists: `?page=&page_size=` (max 100).
- Never edit an applied migration. Add a new numbered file; the runner rejects changed checksums.
- New tenant tables need `tenant_id`, `UNIQUE (tenant_id, id)`, composite FKs, and the `tenant_isolation`
  RLS policy (see `0002_auth_and_system_roles.sql` for the pattern).
- Do database work inside `withTenant(db, principal.tenantId, tx => …)`. Code outside it sees no tenant data.
- **Zod 4 applies `.default()` even inside `.partial()`.** A PATCH built from a schema with defaults silently
  overwrites unsent fields with those defaults. Keep update schemas free of defaults (see `candidateShape`
  in `api/src/routes/candidates.ts`) and add a test that an edit leaves other fields alone.
- Signed download links are about 180 characters, so Fastify's `maxParamLength` is raised to 512.
- NUMERIC and BIGINT columns are returned as JS numbers and DATE columns as `YYYY-MM-DD` strings (see `api/src/db.ts`).
