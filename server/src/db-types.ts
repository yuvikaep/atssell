// Kysely table types for the tables the API uses so far. Keep in sync with db/migrations.
import type { ColumnType, Generated, Selectable } from 'kysely';

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type NullableTimestamp = ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;

export type RecordStatus = 'active' | 'inactive' | 'archived';

export interface TenantsTable {
  id: Generated<string>;
  name: string;
  slug: string;
  timezone: Generated<string>;
  status: Generated<RecordStatus>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface TenantSettingsTable {
  tenant_id: string;
  feedback_link_expiry_hours: Generated<number>;
  feedback_due_hours: Generated<number>;
  mfa_required_for_admins: Generated<boolean>;
  default_ownership_policy: ColumnType<Record<string, unknown>, string | undefined, string>;
  feedback_reminder_hours: Generated<number[]>;
  resume_max_bytes: Generated<number>;
  updated_at: Generated<Date>;
}

export interface UsersTable {
  id: Generated<string>;
  tenant_id: string;
  email: string;
  full_name: string;
  status: Generated<RecordStatus>;
  auth_subject: string | null;
  password_hash: string | null;
  last_login_at: NullableTimestamp;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface DepartmentsTable {
  id: Generated<string>;
  tenant_id: string;
  parent_department_id: string | null;
  head_user_id: string | null;
  name: string;
  status: Generated<RecordStatus>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface RolesTable {
  is_assignable: Generated<boolean>;
  id: Generated<string>;
  tenant_id: string | null;
  code: string;
  name: string;
  is_system_role: Generated<boolean>;
}

export interface RolePermissionsTable {
  role_id: string;
  permission_code: string;
}

export interface UserRoleAssignmentsTable {
  id: Generated<string>;
  tenant_id: string;
  user_id: string;
  role_id: string;
  department_id: string | null;
  assigned_by: string | null;
  created_at: Generated<Date>;
}

export interface UserInvitationsTable {
  id: Generated<string>;
  tenant_id: string;
  email: string;
  role_id: string;
  department_id: string | null;
  agency_id: string | null;
  token_hash: string;
  expires_at: Timestamp;
  accepted_at: NullableTimestamp;
  revoked_at: NullableTimestamp;
  invited_by: string;
  created_at: Generated<Date>;
}

export interface SessionsTable {
  id: Generated<string>;
  tenant_id: string;
  user_id: string;
  token_hash: string;
  expires_at: Timestamp;
  revoked_at: NullableTimestamp;
  last_seen_at: Generated<Date>;
  ip_hash: string | null;
  user_agent: string | null;
  created_at: Generated<Date>;
}

export interface PasswordResetTokensTable {
  id: Generated<string>;
  tenant_id: string;
  user_id: string;
  token_hash: string;
  expires_at: Timestamp;
  used_at: NullableTimestamp;
  created_at: Generated<Date>;
}

export interface PipelineStagesTable {
  id: Generated<string>;
  tenant_id: string;
  code: string;
  name: string;
  sort_order: number;
  is_initial: Generated<boolean>;
  terminal_status: 'active' | 'rejected' | 'withdrawn' | 'hired' | 'archived' | null;
  status: Generated<RecordStatus>;
}

export interface PipelineStageTransitionsTable {
  tenant_id: string;
  from_stage_id: string;
  to_stage_id: string;
  requires_reason: Generated<boolean>;
}

export type RequisitionStatus = 'draft' | 'pending_approval' | 'approved' | 'rejected' | 'cancelled';
export type VacancyStatus = 'open' | 'on_hold' | 'closed' | 'cancelled';
export type ApplicationStatus = 'active' | 'rejected' | 'withdrawn' | 'hired' | 'archived';
export type ApprovalDecision = 'pending' | 'approved' | 'rejected' | 'skipped';
type Numeric = ColumnType<number | null, number | null | undefined, number | null>;

export interface RequisitionsTable {
  id: Generated<string>;
  tenant_id: string;
  department_id: string;
  title: string;
  description: string;
  headcount: number;
  employment_type: string;
  location: string;
  skills: Generated<string[]>;
  min_experience_years: Numeric;
  max_experience_years: Numeric;
  min_ctc: Numeric;
  max_ctc: Numeric;
  priority: Generated<'low' | 'normal' | 'high' | 'critical'>;
  target_date: ColumnType<string | null, string | null | undefined, string | null>;
  hiring_manager_id: string | null;
  requested_by: string;
  status: Generated<RequisitionStatus>;
  approval_round: Generated<number>;
  cancel_reason: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface RequisitionApprovalsTable {
  id: Generated<string>;
  tenant_id: string;
  requisition_id: string;
  round: number;
  step_order: number;
  approver_user_id: string;
  decision: Generated<ApprovalDecision>;
  reason: string | null;
  decided_at: NullableTimestamp;
  created_at: Generated<Date>;
}

export interface VacanciesTable {
  /** Who settles salary and joining for selected candidates. */
  terms_owner: Generated<'recruiter' | 'interviewer' | 'admin'>;
  id: Generated<string>;
  tenant_id: string;
  requisition_id: string;
  vacancy_code: string;
  title: string;
  location: string;
  headcount: Generated<number>;
  owner_user_id: string | null;
  status: Generated<VacancyStatus>;
  status_reason: string | null;
  opened_at: Generated<Date>;
  closed_at: NullableTimestamp;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface VacancyRecruitersTable {
  id: Generated<string>;
  tenant_id: string;
  vacancy_id: string;
  recruiter_user_id: string;
  assigned_by: string;
  assigned_at: Generated<Date>;
  unassigned_at: NullableTimestamp;
}

export interface VacancyAgenciesTable {
  id: Generated<string>;
  tenant_id: string;
  vacancy_id: string;
  agency_id: string;
  status: Generated<RecordStatus>;
  assigned_by: string;
  assigned_at: Generated<Date>;
  ownership_policy: ColumnType<Record<string, unknown>, string | undefined, string>;
}

export interface AgenciesTable {
  id: Generated<string>;
  tenant_id: string;
  name: string;
  status: Generated<RecordStatus>;
  primary_contact_name: string | null;
  primary_contact_email: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface AgencyMembersTable {
  id: Generated<string>;
  tenant_id: string;
  agency_id: string;
  user_id: string;
  agency_role: 'admin' | 'recruiter';
  created_at: Generated<Date>;
}

export interface CandidatesTable {
  id: Generated<string>;
  tenant_id: string;
  full_name: string;
  email: string | null;
  phone: string | null;
  city: string | null;
  current_title: string | null;
  total_experience_years: Numeric;
  current_ctc: Numeric;
  expected_ctc: Numeric;
  notice_period_days: number | null;
  skills: Generated<string[]>;
  profile_summary: string | null;
  privacy_notice_status: string | null;
  retention_until: ColumnType<string | null, string | null | undefined, string | null>;
  status: Generated<'active' | 'merged' | 'archived'>;
  merged_into_candidate_id: string | null;
  created_by: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface CandidateMergesTable {
  id: Generated<string>;
  tenant_id: string;
  source_candidate_id: string;
  target_candidate_id: string;
  match_reason: string;
  source_snapshot: ColumnType<Record<string, unknown>, string, string>;
  merged_by: string;
  merged_at: Generated<Date>;
}

export interface CandidateDocumentsTable {
  id: Generated<string>;
  tenant_id: string;
  candidate_id: string;
  document_type: 'resume' | 'cover_letter' | 'other';
  storage_key: string;
  original_filename: string;
  mime_type: string;
  size_bytes: number;
  sha256: string;
  scan_status: Generated<'pending' | 'clean' | 'infected' | 'failed'>;
  uploaded_by: string | null;
  created_at: Generated<Date>;
}

export interface CandidateNotesTable {
  id: Generated<string>;
  tenant_id: string;
  candidate_id: string;
  application_id: string | null;
  body: string;
  visibility: Generated<'internal' | 'agency_shared'>;
  created_by: string;
  created_at: Generated<Date>;
}

export interface ApplicationsTable {
  id: Generated<string>;
  /** Set by a trigger on insert. */
  sourcing_code: Generated<string>;
  /** The department's job role the candidate was sourced for. */
  job_role_id: Generated<string | null>;
  /** Set by a trigger once the candidate is selected or hired. */
  temp_employee_code: Generated<string | null>;
  tenant_id: string;
  candidate_id: string;
  vacancy_id: string;
  status: Generated<ApplicationStatus>;
  stage_id: string;
  stage_changed_at: Generated<Date>;
  disposition_reason: string | null;
  referred_by: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ApplicationStageEventsTable {
  id: Generated<string>;
  tenant_id: string;
  application_id: string;
  from_stage_id: string | null;
  to_stage_id: string;
  reason: string | null;
  actor_user_id: string | null;
  created_at: Generated<Date>;
}

export type SubmissionSourceType = 'internal_recruiter' | 'agency' | 'referral' | 'direct' | 'job_board' | 'other';

export interface SubmissionsTable {
  id: Generated<string>;
  tenant_id: string;
  application_id: string;
  source_type: SubmissionSourceType;
  source_user_id: string | null;
  agency_id: string | null;
  resume_document_id: string | null;
  submitted_at: Generated<Date>;
  source_reference: string | null;
  ownership_state: Generated<OwnershipState>;
  ownership_expires_at: NullableTimestamp;
  notes: string | null;
  submitted_profile: ColumnType<Record<string, unknown> | null, string | null | undefined, string | null>;
  source_declaration: string | null;
  consent_confirmed: Generated<boolean>;
  created_at: Generated<Date>;
}

export type OwnershipState = 'pending_review' | 'provisional' | 'accepted' | 'disputed' | 'rejected' | 'released';

export interface OwnershipEventsTable {
  id: Generated<string>;
  tenant_id: string;
  submission_id: string;
  event_type: string;
  previous_state: string | null;
  new_state: string | null;
  reason: string | null;
  actor_user_id: string | null;
  created_at: Generated<Date>;
}

export interface TenantCountersTable {
  tenant_id: string;
  name: string;
  value: Generated<number>;
}

export interface AuditEventsTable {
  id: Generated<string>;
  tenant_id: string;
  actor_user_id: string | null;
  actor_type: Generated<string>;
  actor_label: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  request_id: string | null;
  ip_hash: string | null;
  user_agent: string | null;
  metadata: ColumnType<Record<string, unknown>, string | undefined, string>;
  created_at: Generated<Date>;
}


// ---- Sprint 4: interviews and feedback ----

export type InterviewMode = 'google_meet' | 'microsoft_teams' | 'telephonic' | 'face_to_face' | 'other';
export type InterviewStatus = 'draft' | 'scheduled' | 'confirmed' | 'completed' | 'cancelled' | 'no_show';
export type FeedbackRecommendation = 'strong_yes' | 'yes' | 'hold' | 'no' | 'strong_no';

export interface Competency {
  code: string;
  label: string;
  required: boolean;
}
export interface EvaluationTemplate {
  competencies: Competency[];
}

export interface InterviewPlansTable {
  id: Generated<string>;
  tenant_id: string;
  vacancy_id: string;
  name: string;
  round_order: number;
  evaluation_template: ColumnType<EvaluationTemplate, string | undefined, string>;
  is_active: Generated<boolean>;
  created_at: Generated<Date>;
}

export interface InterviewsTable {
  id: Generated<string>;
  tenant_id: string;
  application_id: string;
  interview_plan_id: string | null;
  round_name: string;
  mode: InterviewMode;
  scheduled_start: NullableTimestamp;
  scheduled_end: NullableTimestamp;
  timezone: Generated<string>;
  meeting_url: string | null;
  location_instructions: string | null;
  status: Generated<InterviewStatus>;
  evaluation_template: ColumnType<EvaluationTemplate, string | undefined, string>;
  feedback_due_at: NullableTimestamp;
  completed_at: NullableTimestamp;
  cancelled_reason: string | null;
  created_by: string;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface InterviewersTable {
  id: Generated<string>;
  tenant_id: string;
  interview_id: string;
  user_id: string | null;
  external_name: string | null;
  external_email: string | null;
  identity_verification_required: Generated<boolean>;
  feedback_status: Generated<'pending' | 'submitted' | 'waived'>;
  created_at: Generated<Date>;
}

export interface FeedbackLinksTable {
  id: Generated<string>;
  tenant_id: string;
  interview_id: string;
  interviewer_id: string;
  token_hash: string;
  status: Generated<'active' | 'consumed' | 'revoked'>;
  expires_at: Timestamp;
  revoked_at: NullableTimestamp;
  revoked_by: string | null;
  consumed_at: NullableTimestamp;
  created_by: string;
  created_at: Generated<Date>;
  last_opened_at: NullableTimestamp;
  open_count: Generated<number>;
}

export interface FeedbackTable {
  id: Generated<string>;
  tenant_id: string;
  interview_id: string;
  application_id: string;
  interviewer_id: string;
  feedback_link_id: string | null;
  mode: InterviewMode;
  overall_rating: number;
  recommendation: FeedbackRecommendation;
  competency_ratings: ColumnType<Record<string, number>, string | undefined, string>;
  notes: string | null;
  submitted_at: Generated<Date>;
}

export interface FeedbackCorrectionsTable {
  id: Generated<string>;
  tenant_id: string;
  feedback_id: string;
  version: number;
  mode: InterviewMode;
  overall_rating: number;
  recommendation: FeedbackRecommendation;
  competency_ratings: ColumnType<Record<string, number>, string | undefined, string>;
  notes: string | null;
  reason: string;
  corrected_by: string;
  created_at: Generated<Date>;
}

export interface ExportJobsTable {
  id: Generated<string>;
  tenant_id: string;
  export_type: 'candidates' | 'applications' | 'vacancies';
  filters: ColumnType<Record<string, unknown>, string | undefined, string>;
  fields: string[];
  status: Generated<'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'>;
  storage_key: string | null;
  expires_at: Date | null;
  requested_by: string;
  created_at: Generated<Date>;
  finished_at: Date | null;
  filename: string | null;
  row_count: number | null;
  error: string | null;
  started_at: Date | null;
}

export interface OffersTable {
  id: Generated<string>;
  tenant_id: string;
  application_id: string;
  status: Generated<'draft' | 'pending_approval' | 'approved' | 'released' | 'accepted' | 'declined' | 'withdrawn'>;
  offered_ctc: Numeric;
  proposed_joining_date: ColumnType<string | null, string | null | undefined, string | null>;
  decline_reason: string | null;
  created_by: string;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  approval_round: Generated<number>;
  notes: string | null;
  released_at: NullableTimestamp;
  responded_at: NullableTimestamp;
  withdrawn_reason: string | null;
}

export interface OfferApprovalsTable {
  id: Generated<string>;
  tenant_id: string;
  offer_id: string;
  round: Generated<number>;
  step_order: number;
  approver_user_id: string;
  decision: Generated<'pending' | 'approved' | 'rejected' | 'skipped'>;
  reason: string | null;
  decided_at: NullableTimestamp;
  created_at: Generated<Date>;
}

export interface JoiningRecordsTable {
  id: Generated<string>;
  tenant_id: string;
  application_id: string;
  offer_id: string | null;
  joining_date: ColumnType<string | null, string | null | undefined, string | null>;
  status: 'expected' | 'joined' | 'delayed' | 'backed_out';
  reason: string | null;
  updated_by: string | null;
  updated_at: Generated<Date>;
  created_at: Generated<Date>;
}

export interface DuplicateAttemptsTable {
  id: Generated<string>;
  tenant_id: string;
  vacancy_id: string;
  candidate_id: string;
  original_submission_id: string | null;
  attempted_by: string | null;
  attempted_agency_id: string | null;
  attempted_at: Generated<Date>;
}

export interface AgencyTermsTable {
  id: Generated<string>;
  tenant_id: string;
  agency_id: string;
  version: number;
  payment_model: 'payroll_management' | 'one_time_fee';
  fee_type: 'percent_of_ctc' | 'fixed';
  fee_value: number;
  lockin_days: number | null;
  replacement_days: number | null;
  effective_from: ColumnType<string, string, string>;
  agreement_ref: string | null;
  notes: string | null;
  is_active: Generated<boolean>;
  created_by: string;
  created_at: Generated<Date>;
}

export interface EmploymentRecordsTable {
  id: Generated<string>;
  tenant_id: string;
  application_id: string;
  candidate_id: string;
  vacancy_id: string;
  source_user_id: string | null;
  source_agency_id: string | null;
  agency_terms_id: string | null;
  joined_on: ColumnType<string, string, string>;
  designation: string;
  annual_ctc: number;
  status: Generated<'active' | 'exited'>;
  exit_date: ColumnType<string | null, string | null | undefined, string | null>;
  exit_reason: string | null;
  marked_joined_by: string;
  marked_exited_by: string | null;
  invoice_status: Generated<'not_invoiced' | 'invoiced' | 'paid' | 'credited'>;
  invoice_reference: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ReplacementRecordsTable {
  id: Generated<string>;
  tenant_id: string;
  employment_id: string;
  agency_id: string;
  vacancy_id: string;
  lockin_days: number;
  replacement_days: number;
  due_by: ColumnType<string, string, string>;
  status: Generated<'due' | 'replaced' | 'expired' | 'waived'>;
  replacement_employment_id: string | null;
  notes: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface InterviewEventsTable {
  id: Generated<string>;
  tenant_id: string;
  interview_id: string;
  event_type: string;
  reason: string | null;
  metadata: ColumnType<Record<string, unknown>, string | undefined, string>;
  actor_user_id: string | null;
  created_at: Generated<Date>;
}

export type HiringDecision = 'advance' | 'hold' | 'reject' | 'additional_round' | 'select';

export interface HiringDecisionsTable {
  id: Generated<string>;
  tenant_id: string;
  application_id: string;
  decision: HiringDecision;
  reason: string | null;
  decided_by: string;
  decided_at: Generated<Date>;
}

export interface NotificationsTable {
  id: Generated<string>;
  tenant_id: string;
  recipient_user_id: string | null;
  recipient_email: string | null;
  event_type: string;
  dedupe_key: string;
  payload: ColumnType<Record<string, unknown>, string | undefined, string>;
  delivery_channel: 'in_app' | 'email' | 'whatsapp' | 'webhook';
  status: Generated<'queued' | 'sent' | 'failed' | 'cancelled'>;
  attempts: Generated<number>;
  last_error: string | null;
  next_attempt_at: NullableTimestamp;
  sent_at: NullableTimestamp;
  read_at: NullableTimestamp;
  created_at: Generated<Date>;
}

export interface TasksTable {
  id: Generated<string>;
  tenant_id: string;
  assignee_user_id: string;
  task_type: string;
  title: string;
  entity_type: string | null;
  entity_id: string | null;
  due_at: NullableTimestamp;
  completed_at: NullableTimestamp;
  created_by: string | null;
  created_at: Generated<Date>;
}

export interface Database {
  tenants: TenantsTable;
  tenant_settings: TenantSettingsTable;
  users: UsersTable;
  departments: DepartmentsTable;
  roles: RolesTable;
  role_permissions: RolePermissionsTable;
  user_role_assignments: UserRoleAssignmentsTable;
  user_invitations: UserInvitationsTable;
  sessions: SessionsTable;
  password_reset_tokens: PasswordResetTokensTable;
  pipeline_stages: PipelineStagesTable;
  pipeline_stage_transitions: PipelineStageTransitionsTable;
  requisitions: RequisitionsTable;
  requisition_approvals: RequisitionApprovalsTable;
  vacancies: VacanciesTable;
  vacancy_recruiters: VacancyRecruitersTable;
  vacancy_agencies: VacancyAgenciesTable;
  agencies: AgenciesTable;
  agency_members: AgencyMembersTable;
  candidates: CandidatesTable;
  candidate_merges: CandidateMergesTable;
  candidate_documents: CandidateDocumentsTable;
  candidate_notes: CandidateNotesTable;
  applications: ApplicationsTable;
  application_stage_events: ApplicationStageEventsTable;
  submissions: SubmissionsTable;
  ownership_events: OwnershipEventsTable;
  tenant_counters: TenantCountersTable;
  job_roles: JobRolesTable;
  joining_terms: JoiningTermsTable;
  interview_plans: InterviewPlansTable;
  interviews: InterviewsTable;
  interviewers: InterviewersTable;
  feedback_links: FeedbackLinksTable;
  feedback: FeedbackTable;
  feedback_corrections: FeedbackCorrectionsTable;
  interview_events: InterviewEventsTable;
  export_jobs: ExportJobsTable;
  duplicate_attempts: DuplicateAttemptsTable;
  agency_terms: AgencyTermsTable;
  employment_records: EmploymentRecordsTable;
  replacement_records: ReplacementRecordsTable;
  offers: OffersTable;
  offer_approvals: OfferApprovalsTable;
  joining_records: JoiningRecordsTable;
  hiring_decisions: HiringDecisionsTable;
  notifications: NotificationsTable;
  tasks: TasksTable;
  audit_events: AuditEventsTable;
}

export type User = Selectable<UsersTable>;
export type Department = Selectable<DepartmentsTable>;

export interface JobRolesTable {
  id: Generated<string>;
  tenant_id: string;
  department_id: string;
  name: string;
  status: Generated<RecordStatus>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface JoiningTermsTable {
  application_id: string;
  tenant_id: string;
  annual_ctc: Numeric;
  joining_date: Date | string;
  status: Generated<'proposed' | 'approved'>;
  proposed_by: string;
  proposed_at: Generated<Date>;
  approved_by: string | null;
  approved_at: Date | null;
}
