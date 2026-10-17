# Final MVP specification: what is built

Each line is a requirement from the specification, where it lives, and how it is checked. "Not built" means exactly that.

## Roles and access
| Requirement | Status |
|---|---|
| Four roles only | Done. HR Lead, Company Recruiter, Agency (+ optional sub-recruiters), Interviewer. Earlier roles can no longer be assigned. Tests: `permissions`, `invitations`, `policy`. |
| Company isolation | Done: forced row-level security on every table, including the new ones. Tests: `security`, `tenancy*`. |
| Agency sees only own submissions and authorised job information | Done. Agencies see interview state, whether feedback is in, and joined/exited for their own candidates, never ratings or notes. |
| Interviewer sees only assigned interviews; secure one-time feedback links | Done (account holders, or hash-only expiring links; opening a link does not consume it). |
| Agency sub-recruiters, optional | Done: the agency invites and deactivates its own (`/agency/team`). |

## Screens
| Screen | Status |
|---|---|
| HR dashboard (jobs, pipeline, interviews, pending feedback, joined/active/exits, rankings, department and job performance, agency models, replacements due) | Done: `/hr/dashboard`. |
| Jobs | Done: create in one step, assign recruiters and agencies, Open / On hold / Closed, target vs actual joins, close with outcome. Salary range is stored; recruiters and agencies do not see it. |
| Candidate master (spreadsheet) | Done: search, sort, filters, inline status where the role allows (HR: any open status; recruiter: Screening and Shortlisted), add form, resume upload, CSV import and CSV export. **Excel `.xlsx` files are not read or written**: save as CSV (Excel opens exported CSV directly). |
| Interview management | Done: schedule, panel, secure feedback links, pending / submitted tracking. |
| Agency commercials | Done: versioned terms (payment model, fee type and value, lock-in, replacement, effective date, agreement reference, active flag), history, hire-time snapshot, fee amount and invoice status per hire. Payroll processing, payslips and statutory calculations are out of scope, as specified. |

## First submission wins
Done and tested (`first-submission`, `ownership`, `agency-portal`): job-wise ownership, matching by normalised phone and email, warning for the second submitter, `duplicate_attempts` kept apart from the owner, no automatic merge, concurrent submissions decided in the database (advisory lock plus unique indexes), HR-Lead-only audited correction (blocked after the candidate has joined).
One difference from the wording: uniqueness is per **active application** (one candidate on one job at a time), so a candidate who was rejected on a job can be submitted again later by anyone.

## Lifecycle and HR actions
Sourced, Screening, Interview, Selected / Rejected / Hold (decisions), Offer (status and CTC, no approval chain), Joined, Active / Exited, Replacement, Closed. `Mark Joined`, `Mark Exited`, replacement tracking and `Close Job` are HR-Lead-only and audited (DOJ and exit date are in the audit log).
Replacement rule used: a hire sourced by an agency who exits within the agency's **lock-in** days creates a replacement due **replacement days** after the exit date. Missed deadlines show as expired; the HR Lead can link a replacement hire or waive with a reason.

## Ranking
Two leaderboards (company recruiters, agencies) ranked by actual joins, then selected, interviewed and valid submissions. Raw and valid submissions are shown separately. Filters: date range, department, job, recruiter, agency, employment status. Recruiters and agencies see only their own numbers.

## Not built
- Excel files (`.xlsx`) for import and export.
- Merge review screen for potential duplicates with different phone and email (such records stay separate and are never merged automatically).
- Billing beyond fee amount and invoice status (no invoice generation).
- Calendar and email-inbox integrations, AI resume parsing, MFA.
- Earlier pages (requisitions, offer approvals, hiring-manager home) still exist in the code for people who held those roles; they are not part of the four-role menus.
