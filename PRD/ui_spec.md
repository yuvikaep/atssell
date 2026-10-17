# JobsMato ATS — Page-by-Page UI Specification
Version 1.0

## Global application shell
- Left navigation varies by role.
- Top bar: tenant name, global search, notifications, profile menu.
- Every list supports loading, empty, error, and permission-denied states.
- Filters persist for the current session where practical.
- Use responsive layouts; public interview feedback page must be mobile-first.
- Do not expose hidden agency data or restricted salary fields in client-side payloads.

## 1. Login / onboarding
Fields: email, password or SSO option, MFA when enabled.
Actions: sign in, reset password, accept invitation.
States: invalid credentials, disabled user, invitation expired, MFA required.
Permissions: no tenant data until authentication succeeds.

## 2. Company dashboard
Widgets: open vacancies, candidates by stage, interviews upcoming, feedback pending/overdue, offers, joins, vacancy ageing.
Filters: date range, department, location, recruiter, agency.
Actions: open item details, export authorized report.
Empty state: guide user to create first requisition.

## 3. Department management
Columns: department, parent department, department head, active vacancies, status.
Actions: create, edit, deactivate, view hiring.
Validation: unique department name per tenant; no invalid parent hierarchy.

## 4. Requisition creation / detail
Sections: job basics, department/location, headcount, skills/experience, compensation, target date, hiring manager, approvals.
Actions: save draft, submit for approval, approve/reject (authorized approver), cancel.
Validation: required fields, headcount > 0, compensation range valid.
History: requester, approvers, timestamps and reasons.

## 5. Vacancy list / detail
List columns: vacancy code, title, department, owner, recruiters, agencies, status, age, target date.
Filters: status, department, recruiter, agency, location, priority.
Detail tabs: overview, candidates, assignments, interviews, activity, reports.
Actions: assign recruiter/agency, hold, reopen, close, edit.
Access: only assigned or authorized users.

## 6. Candidate database
Search: name, email, phone, skills, city, experience.
Filters: source, status, notice period, experience, application stage.
Actions: add candidate, upload resume, CSV import, open profile.
Duplicate flow: show possible matches; user reviews before merge.
Empty state: upload resume or create candidate.

## 7. Candidate profile
Header: name, current title, location, contact fields gated by permission.
Sections: resume preview/download, experience, skills, applications, source/submission history, activity, notes.
Actions: edit permitted fields, add to vacancy, create interview, add note.
Privacy: signed short-lived resume URL; never public permanent storage URL.

## 8. Recruitment pipeline
View: Kanban and table.
Cards: candidate, vacancy, current stage, source, owner, last activity, next action.
Actions: move stage, schedule interview, add follow-up, reject with reason.
Validation: allowed stage transitions and permissions enforced server-side.

## 9. Agency management
List: agency, users, assigned vacancies, status, performance.
Actions: invite, activate/deactivate, assign jobs, manage agency members.
Access: company admin/authorized TA roles.

## 10. Agency portal
Home: assigned vacancies, submission counts, status updates, interviews where permitted.
Job detail: job description, requirements, submission policy.
Submission form: candidate profile, resume, source declaration, optional notes.
Rules: only assigned active vacancies; no visibility into competing agencies.
Duplicate state: safe warning and submission review process, no disclosure of another agency's confidential details.

## 11. Interview calendar
Views: week/month/list.
Filters: interviewer, recruiter, department, mode, feedback status.
Actions: schedule, reschedule, cancel, mark completed/no-show.
Fields: candidate, vacancy, round, start/end/timezone, mode, meeting URL/location, panel, feedback due.
Rules: end time after start time; timezone explicit.

## 12. Interview detail
Sections: candidate brief, job description, schedule, panel, meeting info, feedback links, scorecards, activity.
Actions: edit/reschedule, generate link, copy link, revoke, regenerate, send reminder.
Statuses: scheduled/completed and feedback pending/submitted are separate.

## 13. Public one-time feedback page
No ATS login or application navigation.
Steps: validate token, display permitted candidate/job brief, fill scorecard, review, submit, confirmation.
Fields: interview mode (Google Meet, Microsoft Teams, Telephonic, Face-to-Face, Other), rating 1–5, recommendation, competency ratings, notes.
Security UX: never show raw token after initial request; avoid third-party trackers; no candidate details on expired/revoked/consumed pages.
Errors: invalid/expired/revoked/consumed link; generic wording.
After submit: confirmation and no second-submit action.

## 14. Feedback review
List: interviewer, round, mode, submitted at, rating, recommendation, status.
Actions: view feedback, record decision, request another round, audited correction workflow.
Visibility follows tenant and role policies.

## 15. Offers / joining
Offer list: candidate, vacancy, status, proposed CTC (permission-gated), joining date.
Actions: create, submit for approval, approve/release, record acceptance/decline.
Joining: expected/joined/delayed/backed out, date and reason.
Access: compensation fields restricted.

## 16. Analytics and reports
Reports: funnel, recruiter activity, agency performance, interview feedback SLA, time-to-hire, vacancy ageing.
Every metric shows date range and definition.
Export only permitted fields; record export event.

## 17. Notifications / task center
Groups: new submissions, interviews, overdue feedback, approvals, joining follow-ups.
Actions: open related item, mark read, configure preferences.
Notification delivery failure should not lose the underlying task.

## 18. Settings / audit
Settings: roles, permissions, stages, ownership rules, feedback expiry, reminders, integrations, retention.
Audit: actor, action, entity, timestamp, request ID; sensitive data redacted.
