# Data protection notes

Engineering notes, not legal advice. The customer and its counsel decide the lawful basis, notices and retention periods.

## What personal data is held
Candidates: name, email, phone, city, title, experience, current and expected pay, skills, resumes, interview feedback and decisions. Colleagues: name, email, role. External interviewers: name and email. Agencies: contact details of their staff.

## Controls in the product
- Access limited by role and department; agency users see only their own submissions.
- Contact details and pay hidden unless the role allows (also in exports).
- Every export is requested, built, downloaded and audited; files expire after 24 hours.
- Audit trail of ownership, approvals, exports and feedback corrections (append-only).
- Per-candidate `retention_until` and `privacy_notice_status` fields; tenant setting `candidate_retention_days`.
- One-time links are hash-only and never logged.

## Retention
`npm run -w api retention:report -- --company <code>` lists candidates past or near their retention date and those with no date or no recorded notice. It changes nothing. **No automatic deletion is built**: purging personal data is a reviewed act, and some tables are append-only by design (audit, feedback). A deletion/anonymisation procedure for append-only history has not been designed; decide it with counsel before the pilot ends.

## Requests from individuals
Access and deletion requests are handled manually today: locate the candidate, export their record, then anonymise on instruction. There is no self-service flow.

## Before the pilot
Confirm: lawful basis and candidate notice wording; retention period; where data is hosted (region); subprocessors (hosting, email provider, any later AI or calendar integration); who may request exports; backup retention (backups keep deleted data until they expire).
