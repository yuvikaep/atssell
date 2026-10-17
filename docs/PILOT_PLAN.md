# Pilot plan

## Scope
One company, one to three departments, 6–8 weeks. In scope: requisitions and approvals, vacancies, candidates and resumes, pipeline, agency submissions and first-come ownership, interview scheduling and feedback links, notifications, reports and exports, offers and joining.
Out of scope until separately built: calendar and email-inbox integration, AI resume parsing, job-board posting, candidate-facing portal, MFA/SSO.

## Before go-live (checklist)
- [ ] Production providers configured (S3, ClamAV, SMTP) and `loadConfig` starts in production mode
- [ ] TLS in front, `WEB_ORIGIN` correct, secrets generated (not the compose placeholders)
- [ ] Backup job scheduled; **restore drill run in the real environment**
- [ ] Company created, roles assigned, departments set, pipeline reviewed
- [ ] Retention period and candidate notice agreed (`docs/DATA_PROTECTION.md`)
- [ ] Load test rerun on production-like hardware
- [ ] Baseline captured: `npm run -w api pilot:baseline -- --company <code>`
- [ ] Support contact and incident owner named

## Success measures (agree targets with the customer; none are promised here)
Time to hire and vacancy age (Reports); feedback turnaround and share on time; share of interviews with feedback within the deadline; duplicate submissions rejected (agency hygiene); recruiter time saved (survey); weekly active users by role.
Capture the baseline before go-live, then weekly.

## Cadence
Weekly 30-minute review of the Reports page and open issues; fortnightly restore drill; end-of-pilot review against the baseline, with a go / extend / stop decision.

## Known limits to tell participants
No MFA; email and calendar are not integrated (interview times are entered, links are emailed); resumes are not parsed; notification preferences are fixed; agency admins cannot yet invite their own recruiters.
