# JobsMato ATS Development Handover Pack
Version 1.0 | 16 October 2026

## Contents
- `schema.sql`: PostgreSQL starter schema (requires engineering review before production).
- `api_contract.md`: REST API draft, feedback-link security rules, example payloads and status codes.
- `ui_spec.md`: Page-by-page UI specification including role-specific and public interviewer pages.
- `development_backlog.csv`: Prioritized implementation backlog with acceptance criteria and target sprints.
- `JobsMato_ATS_Development_Handover.docx`: Consolidated handover document.

## Important implementation decisions
1. Candidate, application and source submission are separate concepts.
2. Public interviewer feedback link is token-protected, not an unrestricted public candidate profile.
3. Do not consume token on GET/open because email/security scanners may prefetch links.
4. Use one transaction to validate token, save feedback, consume token and write audit event.
5. Store token hash only; never log raw token.
6. Enforce tenant and agency isolation server-side; consider PostgreSQL Row-Level Security.
7. Feedback corrections should preserve the original submission and an audit trail.
8. Validate all file uploads, use private object storage and short-lived signed URLs.
9. API endpoint names and schema are proposed drafts, not existing production assets.

## Suggested implementation order
Foundation/auth -> requisitions/vacancies -> candidate database/pipeline -> agency portal/ownership -> interviews -> one-time feedback links -> analytics -> pilot hardening.

## Before production
- Review schema and add composite tenant-aware foreign keys / RLS policies.
- Add migrations and seed data.
- Finalize authentication provider, storage, email/calendar providers and hosting.
- Complete privacy/legal review, threat model, load testing, backups and restore drills.
- Confirm SLA, retention and support procedures.
