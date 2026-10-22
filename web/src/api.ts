export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export async function api<T>(method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/v1${path}`, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 204) return undefined as T;
  // Anything but JSON did not come from the API: the hosting platform answered instead (a crashed
  // function, or /api routed to the static site).
  if (!res.headers.get('content-type')?.includes('application/json')) {
    throw new ApiError(res.status >= 400 ? res.status : 502, 'API_UNREACHABLE', `The API did not answer (HTTP ${res.status} from ${path}). The server may be down or /api is not routed to the API.`);
  }
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const e = json?.error;
    throw new ApiError(res.status, e?.code ?? 'UNKNOWN', e?.message ?? 'Something went wrong.', e?.details);
  }
  return json as T;
}

/** Field-level validation messages, when the API sent them (details is an array for validation errors). */
export function fieldIssues(err: unknown): { path: string; message: string }[] {
  return err instanceof ApiError && Array.isArray(err.details) ? (err.details as { path: string; message: string }[]) : [];
}

export type PermissionScope = 'all' | string[];

export interface Me {
  limits?: { resume_max_bytes: number };
  user: { id: string; email: string; full_name: string };
  tenant: { id: string; name: string; slug: string };
  roles: { code: string; name: string; department_id: string | null }[];
  permissions: Record<string, PermissionScope>;
}

export interface Department {
  id: string;
  name: string;
  status: 'active' | 'inactive' | 'archived';
  parent_department_id: string | null;
  parent_name: string | null;
  head_user_id: string | null;
  head_name: string | null;
  active_vacancies: number;
}

export interface UserRole {
  code: string;
  name: string;
  department_id: string | null;
  department_name: string | null;
}

export interface UserRow {
  id: string;
  email: string;
  full_name: string;
  status: 'active' | 'inactive' | 'archived';
  last_login_at: string | null;
  roles: UserRole[];
}

export interface Role {
  code: string;
  name: string;
  invitable: boolean;
  permissions: string[];
}

export interface Invitation {
  id: string;
  email: string;
  role_name: string;
  department_name: string | null;
  invited_by_name: string;
  expires_at: string;
  expired: boolean;
}

export function can(me: Me, permission: string): boolean {
  return me.permissions[permission] !== undefined;
}

export function canAll(me: Me, permission: string): boolean {
  return me.permissions[permission] === 'all';
}

let takenToken: { path: string; token: string } | null = null;

/**
 * Reads a one-time token from the URL fragment and removes it from the address bar and history.
 * The fragment is never sent to any server, so the token stays out of access logs. Cached per path
 * because React StrictMode runs state initializers twice in development.
 */
export function takeFragmentToken(): string | null {
  const token = window.location.hash.slice(1);
  if (token) {
    takenToken = { path: window.location.pathname, token };
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
    return token;
  }
  return takenToken?.path === window.location.pathname ? takenToken.token : null;
}

/** Only same-site relative paths, to prevent open redirects via ?redirect=. */
export function safeRedirect(target: string | undefined): string {
  return target && target.startsWith('/') && !target.startsWith('//') ? target : '/';
}

// ---- Sprint 2 ----

export interface Paged<T> {
  data: T[];
  page: number;
  page_size: number;
  total: number;
}

export type RequisitionStatus = 'draft' | 'pending_approval' | 'approved' | 'rejected' | 'cancelled';
export type VacancyStatus = 'open' | 'on_hold' | 'closed' | 'cancelled';

export interface RequisitionRow {
  id: string;
  title: string;
  status: RequisitionStatus;
  headcount: number;
  location: string;
  priority: 'low' | 'normal' | 'high' | 'critical';
  target_date: string | null;
  department_id: string;
  department_name: string;
  hiring_manager_name: string | null;
  pending_with: string | null;
  created_at: string;
}

export interface Approval {
  id: string;
  round: number;
  step_order: number;
  approver_user_id: string;
  approver_name: string;
  decision: 'pending' | 'approved' | 'rejected' | 'skipped';
  reason: string | null;
  decided_at: string | null;
}

export interface RequisitionDetail extends Omit<RequisitionRow, 'pending_with'> {
  description: string;
  employment_type: string;
  skills: string[];
  min_experience_years: number | null;
  max_experience_years: number | null;
  min_ctc?: number | null;
  max_ctc?: number | null;
  hiring_manager_id: string | null;
  requested_by: string;
  requested_by_name: string;
  approval_round: number;
  cancel_reason: string | null;
  approvals: Approval[];
  current_approver_id: string | null;
  vacancies: { id: string; vacancy_code: string; title: string; location: string; headcount: number; status: VacancyStatus }[];
  headcount_allocated: number;
  can: { edit: boolean; submit: boolean; decide: boolean; cancel: boolean; open_vacancy: boolean };
}

export interface VacancyRow {
  id: string;
  vacancy_code: string;
  title: string;
  location: string;
  headcount: number;
  status: VacancyStatus;
  opened_at: string;
  department_id: string;
  department_name: string;
  priority: string;
  target_date: string | null;
  owner_name: string | null;
  recruiters: string[];
  agencies: string[];
  active_candidates: number;
  joined?: number;
  age_days: number;
}

export interface VacancyDetail extends Omit<VacancyRow, 'recruiters' | 'agencies'>, VacancyPeople {
  requisition_id: string;
  status_reason: string | null;
  description: string;
  skills: string[];
  employment_type: string;
  min_experience_years: number | null;
  max_experience_years: number | null;
  min_ctc?: number | null;
  max_ctc?: number | null;
  hiring_manager_name: string | null;
  stage_counts: { stage_id: string; code: string; name: string; count: number }[];
  can: { manage: boolean; add_candidates: boolean };
}

export interface VacancyPeople {
  recruiters: { id: string; full_name: string; email: string }[];
  agencies: { id: string; name: string; ownership_policy?: { submission_notes?: string } }[];
}

export interface Agency {
  id: string;
  name: string;
  status: 'active' | 'inactive' | 'archived';
  primary_contact_name: string | null;
  primary_contact_email: string | null;
  assigned_vacancies: number;
  members: number;
}

export interface CandidateRow {
  id: string;
  full_name: string;
  email?: string | null;
  phone?: string | null;
  city: string | null;
  current_title: string | null;
  total_experience_years: number | null;
  notice_period_days: number | null;
  skills: string[];
  current_ctc?: number | null;
  expected_ctc?: number | null;
  active_applications: number;
}

export interface CandidateProfile extends CandidateRow {
  /** Credited automatically to whoever sourced the candidate first. Nobody can change it. */
  sourced_by: { kind: 'agency' | 'company'; id: string | null; name: string };
  profile_summary: string | null;
  status: 'active' | 'merged' | 'archived';
  documents: {
    id: string; document_type: string; original_filename: string; mime_type: string; size_bytes: number;
    scan_status: string; created_at: string; uploaded_by_name: string | null;
  }[];
  applications: {
    id: string; sourcing_code: string; temp_employee_code: string | null; job_role_name: string | null; status: string; stage_id: string; stage_name: string; stage_code: string; stage_changed_at: string;
    disposition_reason: string | null; vacancy_id: string; vacancy_code: string; vacancy_title: string; vacancy_status: string;
  }[];
  submissions: { id: string; source_type: string; submitted_at: string; ownership_state: string; vacancy_code: string; submitted_by_name: string | null; agency_name: string | null }[];
  notes: { id: string; body: string; created_at: string; created_by_name: string }[];
  can: { edit: boolean; view_contact: boolean; view_compensation: boolean; upload: boolean; add_to_vacancy: boolean; merge: boolean };
}

export interface DuplicateMatch {
  id: string | null;
  hidden?: boolean;
  full_name?: string;
  city?: string | null;
  current_title?: string | null;
  match_reason: 'same_email' | 'same_phone' | 'similar_name';
}

export interface Stage {
  id: string;
  code: string;
  name: string;
  is_initial: boolean;
  terminal_status: string | null;
  next: { stage_id: string; requires_reason: boolean }[];
}

export interface ApplicationCard {
  id: string;
  status: string;
  stage_id: string;
  stage_name: string;
  stage_code: string;
  stage_changed_at: string;
  candidate_id: string;
  candidate_name: string;
  current_title: string | null;
  city: string | null;
  vacancy_id: string;
  vacancy_code: string;
  vacancy_title: string;
  source_type: string | null;
  agency_name: string | null;
}

export const REQUISITION_STATUS_LABEL: Record<RequisitionStatus, string> = {
  draft: 'Draft', pending_approval: 'Pending approval', approved: 'Approved', rejected: 'Rejected', cancelled: 'Cancelled',
};
export const VACANCY_STATUS_LABEL: Record<VacancyStatus, string> = {
  open: 'Open', on_hold: 'On hold', closed: 'Closed', cancelled: 'Cancelled',
};
export const EMPLOYMENT_TYPES: Record<string, string> = {
  full_time: 'Full time', part_time: 'Part time', contract: 'Contract', internship: 'Internship', temporary: 'Temporary',
};
export const SOURCE_LABEL: Record<string, string> = {
  internal_recruiter: 'Recruiter', agency: 'Agency', referral: 'Referral', direct: 'Direct', job_board: 'Job board', other: 'Other',
};

const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });
export const formatInr = (n: number) => inr.format(n);

export function formatCtcRange(min?: number | null, max?: number | null) {
  if (min == null && max == null) return '—';
  if (min != null && max != null) return `${formatInr(min)} – ${formatInr(max)}`;
  return min != null ? `from ${formatInr(min)}` : `up to ${formatInr(max!)}`;
}

export function formatDay(value: string | null) {
  if (!value) return '—';
  const [y, m, d] = value.slice(0, 10).split('-').map(Number);
  return new Date(y!, m! - 1, d).toLocaleDateString(undefined, { dateStyle: 'medium' });
}

export function formatBytes(n: number) {
  return n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Multipart upload; the browser sets the boundary header. */
export async function upload<T>(path: string, file: File, fields: Record<string, string> = {}): Promise<T> {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  form.append('file', file);
  const res = await fetch(`/api/v1${path}`, { method: 'POST', credentials: 'same-origin', body: form });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, json?.error?.code ?? 'UNKNOWN', json?.error?.message ?? 'Upload failed.', json?.error?.details);
  return json as T;
}

// ---- Sprint 3: agencies and ownership ----

export interface OwnershipView {
  label: 'Credited' | 'Rejected as duplicate';
  detail: string | null;
}

export interface PortalSubmission {
  id: string;
  sourcing_code: string; temp_employee_code: string | null;
  submitted_at: string;
  candidate_name: string | null;
  current_title: string | null;
  city: string | null;
  email: string | null;
  phone: string | null;
  vacancy: { id: string; code: string; title: string };
  stage: string | null;
  application_status: string | null;
  ownership: OwnershipView;
  has_resume: boolean;
  submitted_by?: string | null;
}

export interface PortalHome {
  agency: { name: string; role: 'admin' | 'recruiter' };
  open_vacancies: number;
  submissions: { total: number; credited: number; rejected_duplicates: number };
  in_pipeline: number;
  recent: PortalSubmission[];
}

export interface PortalVacancyRow {
  id: string;
  vacancy_code: string;
  title: string;
  location: string;
  headcount: number;
  status: VacancyStatus;
  employment_type: string;
  priority: string;
  my_submissions: number;
}

export interface PortalVacancy extends PortalVacancyRow {
  description: string;
  skills: string[];
  min_experience_years: number | null;
  max_experience_years: number | null;
  submission_policy: { notes: string | null };
  can_submit: boolean;
}

export interface SubmissionResult {
  id: string;
  ownership: OwnershipView;
  message: string;
}

export interface AgencyMembers {
  agency: { id: string; name: string; status: string };
  members: { user_id: string; full_name: string; email: string; status: 'active' | 'inactive' | 'archived'; agency_role: 'admin' | 'recruiter'; last_login_at: string | null }[];
  invitations: { id: string; email: string; expires_at: string; expired: boolean; agency_role: 'admin' | 'recruiter' }[];
}

export const DECLARATION_OPTIONS: Record<string, string> = {
  agency_database: "Found in the agency's own database or search",
  candidate_applied: 'The candidate applied to the agency directly',
  referral: 'Referred to the agency',
  job_board: 'Found on a job board',
  other: 'Other',
};

// ---- Sprint 4: interviews and feedback ----

export type InterviewMode = 'google_meet' | 'microsoft_teams' | 'telephonic' | 'face_to_face' | 'other';
export type InterviewStatus = 'draft' | 'scheduled' | 'confirmed' | 'completed' | 'cancelled' | 'no_show';
export type Recommendation = 'strong_yes' | 'yes' | 'hold' | 'no' | 'strong_no';

export const MODE_LABEL: Record<InterviewMode, string> = {
  google_meet: 'Google Meet', microsoft_teams: 'Microsoft Teams', telephonic: 'Telephonic', face_to_face: 'Face-to-face', other: 'Other',
};
export const INTERVIEW_STATUS_LABEL: Record<InterviewStatus, string> = {
  draft: 'Draft', scheduled: 'Scheduled', confirmed: 'Confirmed', completed: 'Completed', cancelled: 'Cancelled', no_show: 'No-show',
};
export const RECOMMENDATION_LABEL: Record<Recommendation, string> = {
  strong_yes: 'Strong yes', yes: 'Yes', hold: 'Hold', no: 'No', strong_no: 'Strong no',
};
export const DECISION_LABEL: Record<string, string> = {
  advance: 'Advance', hold: 'Hold', reject: 'Reject', additional_round: 'Another round', select: 'Select',
};

export interface Competency {
  code: string;
  label: string;
  required: boolean;
}

export interface InterviewPlan {
  id: string;
  name: string;
  round_order: number;
  is_active: boolean;
  competencies: Competency[];
}

export interface DirectoryUser {
  id: string;
  full_name: string;
  email: string;
}

export interface InterviewRow {
  id: string;
  round_name: string;
  mode: InterviewMode;
  scheduled_start: string | null;
  scheduled_end: string | null;
  timezone: string;
  status: InterviewStatus;
  feedback_due_at: string | null;
  candidate_id: string;
  candidate_name: string;
  vacancy_id: string;
  vacancy_code: string;
  vacancy_title: string;
  panel: string[];
  feedback_submitted: number;
  feedback_expected: number;
  feedback_pending: number;
  feedback_overdue: boolean;
}

export interface PanelMember {
  id: string;
  user_id: string | null;
  name: string;
  email: string | null;
  external: boolean;
  feedback_status: 'pending' | 'submitted' | 'waived';
  overdue: boolean;
  link: { id: string; state: 'active' | 'expired' | 'consumed' | 'revoked'; expires_at: string; open_count: number; last_opened_at: string | null } | null;
}

export interface NextRoundRequest { remark: string | null; by: string | null; at: string }
export interface InterviewDetail {
  request: NextRoundRequest | null;
  id: string;
  application_id: string;
  round_name: string;
  mode: InterviewMode;
  scheduled_start: string | null;
  scheduled_end: string | null;
  timezone: string;
  meeting_url: string | null;
  location_instructions: string | null;
  status: InterviewStatus;
  feedback_due_at: string | null;
  completed_at: string | null;
  cancelled_reason: string | null;
  created_by_name: string | null;
  template: { competencies: Competency[] };
  candidate: { id: string; full_name: string; current_title: string | null };
  vacancy: { id: string; code: string; title: string };
  panel: PanelMember[];
  events: { id: string; event_type: string; reason: string | null; metadata: Record<string, unknown>; created_at: string; actor_name: string | null }[];
  can: { manage: boolean; links: boolean; view_feedback: boolean; correct: boolean; decide: boolean };
}

export interface FeedbackValues {
  mode: InterviewMode;
  overall_rating: number;
  recommendation: Recommendation;
  competency_ratings: Record<string, number>;
  notes: string | null;
}

export interface FeedbackItem {
  id: string;
  interview_id: string;
  interviewer: { id: string; name: string };
  submitted_at: string;
  original: FeedbackValues;
  effective: FeedbackValues & { corrected: boolean; version: number };
  corrections: { version: number; reason: string; corrected_by: string | null; at: string; overall_rating: number; recommendation: Recommendation; notes: string | null }[];
}

export interface ApplicationFeedback {
  interviews: { id: string; round_name: string; status: InterviewStatus; scheduled_start: string | null; feedback: FeedbackItem[] }[];
  summary: { count: number; average_rating: number | null; recommendations: Record<string, number> };
}

export interface MyInterviewRow {
  id: string;
  round_name: string;
  mode: InterviewMode;
  scheduled_start: string | null;
  scheduled_end: string | null;
  timezone: string;
  status: InterviewStatus;
  feedback_due_at: string | null;
  feedback_status: 'pending' | 'submitted' | 'waived';
  candidate_name: string;
  vacancy_title: string;
  overdue: boolean;
  can_submit: boolean;
}

export interface FeedbackBootstrap {
  interview: { round_name: string; mode: InterviewMode; mode_label: string; scheduled_start: string | null; scheduled_end: string | null; timezone: string };
  job: { title: string; location: string; description: string; skills: string[] };
  candidate: { full_name: string; current_title: string | null; total_experience_years: number | null; skills: string[]; city: string | null; summary: string | null };
  interviewer: { name: string | null };
  scorecard: Competency[];
  modes: { value: InterviewMode; label: string }[];
  expires_at?: string;
}

export interface MyInterviewDetail extends FeedbackBootstrap {
  request: NextRoundRequest | null;
  application_id: string;
  can_decide: boolean;
  last_decision: { decision: string; reason: string | null; decided_at: string } | null;
  id: string;
  status: InterviewStatus;
  feedback_status: 'pending' | 'submitted' | 'waived';
  can_submit: boolean;
  my_feedback: { mode: InterviewMode; overall_rating: number; recommendation: Recommendation; competency_ratings: Record<string, number>; notes: string | null; submitted_at: string } | null;
}

export interface NotificationItem {
  id: string;
  type: string;
  title?: string;
  body?: string;
  link?: string | null;
  read: boolean;
  created_at: string;
}

export interface TaskItem {
  id: string;
  task_type: string;
  title: string;
  entity_type: string | null;
  entity_id: string | null;
  due_at: string | null;
  completed_at: string | null;
  overdue: boolean;
}

// ---- Time zones ----
// Interviews have an explicit time zone. The form edits wall-clock time in that zone, and the API
// stores an exact instant, so converting between the two must not depend on the browser's own zone.

function zoneOffsetMs(utcMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(utcMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')) - Math.floor(utcMs / 1000) * 1000;
}

/** 'YYYY-MM-DDTHH:mm' wall-clock time in `timeZone` to an exact UTC ISO instant. */
export function zonedToIso(local: string, timeZone: string): string {
  const [d, t] = local.split('T');
  const [y, mo, da] = d!.split('-').map(Number);
  const [h, mi] = t!.split(':').map(Number);
  const wall = Date.UTC(y!, mo! - 1, da!, h!, mi!);
  let guess = wall;
  for (let i = 0; i < 3; i++) guess = wall - zoneOffsetMs(guess, timeZone);
  return new Date(guess).toISOString();
}

/** An instant to 'YYYY-MM-DDTHH:mm' wall-clock time in `timeZone` (for datetime-local inputs). */
export function isoToZoned(iso: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(iso));
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`;
}

export function formatInZone(iso: string | null, timeZone: string, opts: { dateOnly?: boolean; timeOnly?: boolean; noZone?: boolean } = {}): string {
  if (!iso) return 'Not scheduled';
  const o: Intl.DateTimeFormatOptions = { timeZone };
  if (!opts.timeOnly) { o.weekday = 'short'; o.day = 'numeric'; o.month = 'short'; if (!opts.dateOnly) o.year = 'numeric'; }
  if (!opts.dateOnly) { o.hour = 'numeric'; o.minute = '2-digit'; if (!opts.noZone) o.timeZoneName = 'short'; }
  return new Intl.DateTimeFormat(undefined, o).format(new Date(iso));
}

export const COMMON_TIMEZONES = [
  'Asia/Kolkata', 'UTC', 'Asia/Dubai', 'Asia/Singapore', 'Europe/London', 'Europe/Berlin', 'America/New_York', 'America/Chicago',
  'America/Los_Angeles', 'Australia/Sydney',
];

// ---- Sprint 6: offers and joining ----
export type OfferStatus = 'draft' | 'pending_approval' | 'approved' | 'released' | 'accepted' | 'declined' | 'withdrawn';
export const OFFER_STATUS_LABEL: Record<OfferStatus, string> = {
  draft: 'Draft', pending_approval: 'Awaiting approval', approved: 'Approved', released: 'Released to candidate',
  accepted: 'Accepted', declined: 'Declined', withdrawn: 'Withdrawn',
};
export type JoiningStatus = 'expected' | 'joined' | 'delayed' | 'backed_out';
export const JOINING_STATUS_LABEL: Record<JoiningStatus, string> = { expected: 'Expected', joined: 'Joined', delayed: 'Delayed', backed_out: 'Backed out' };

export interface OfferRow {
  id: string; status: OfferStatus; offered_ctc: number | null; proposed_joining_date: string | null; created_at: string;
  candidate_id: string; candidate_name: string; vacancy_id: string; vacancy_title: string;
}
export interface OfferDetail {
  id: string; status: OfferStatus; offered_ctc: number | null; proposed_joining_date: string | null; notes: string | null;
  decline_reason: string | null; withdrawn_reason: string | null; created_at: string; released_at: string | null; responded_at: string | null;
  created_by_name: string; approval_round: number; department_id: string;
  candidate: { id: string; full_name: string };
  vacancy: { id: string; title: string; code: string };
  application: { id: string; status: string; stage_name: string };
  approvals: { id: string; round: number; step_order: number; approver_user_id: string; approver_name: string; decision: 'pending' | 'approved' | 'rejected' | 'skipped'; reason: string | null; decided_at: string | null }[];
  current_approver_id: string | null;
  joining: { id: string; status: JoiningStatus; joining_date: string | null; reason: string | null } | null;
  can: { edit: boolean; submit: boolean; decide: boolean; release: boolean; respond: boolean; withdraw: boolean };
}
export interface JoiningRow { id: string; status: JoiningStatus; joining_date: string | null; reason: string | null; offer_id: string | null; candidate_id: string; candidate_name: string; vacancy_title: string; overdue: boolean }

export type DecisionKind = 'select' | 'hold' | 'reject' | 'additional_round' | 'advance';
export interface DecisionRow { id: string; decision: DecisionKind; reason: string | null; decided_at: string; decided_by_name: string; application_id: string; application_status: string; candidate_name: string; vacancy_id: string; vacancy_title: string }

// ---- Recruiter workspace ----
/** Works only on jobs assigned to them: no company-wide view, no admin rights. */
export function isRecruiter(me: Me) {
  return can(me, 'applications.manage') && can(me, 'vacancies.view_assigned') && !can(me, 'vacancies.view_all') && !can(me, 'users.manage');
}
export interface CandidateStatusRow {
  application_id: string; job_role_id: string | null; job_role_name: string | null; sourcing_code: string; temp_employee_code: string | null; candidate_id: string; candidate_name: string; headline: string | null;
  vacancy_id: string; vacancy_title: string; label: string; tone: 'muted' | 'info' | 'warning' | 'success' | 'danger'; detail: string | null;
  scheduled_start: string | null;
  feedback: { count: number; avg_rating: number; recommendations: string[] } | null;
  remark: string | null;
  action: { kind: 'schedule' } | { kind: 'set_time'; interview_id: string } | null;
}
