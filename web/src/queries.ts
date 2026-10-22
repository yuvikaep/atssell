import { QueryClient } from '@tanstack/react-query';
import type { JoiningRow, OfferDetail, OfferRow } from './api';
import { api, ApiError, type Department, type Invitation, type Me, type Role, type UserRow } from './api';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
    },
  },
});

export const meQuery = {
  queryKey: ['me'],
  queryFn: () => api<{ data: Me }>('GET', '/me').then((r) => r.data),
};

export const departmentsQuery = (status: 'active' | 'inactive' | 'all') => ({
  queryKey: ['departments', status],
  queryFn: () => api<{ data: Department[] }>('GET', `/departments?status=${status}`).then((r) => r.data),
});

export const usersQuery = (status: 'active' | 'inactive' | 'all', q: string) => ({
  queryKey: ['users', status, q],
  queryFn: () =>
    api<{ data: UserRow[]; total: number }>('GET', `/users?status=${status}&page_size=100${q ? `&q=${encodeURIComponent(q)}` : ''}`),
});

export const rolesQuery = {
  queryKey: ['roles'],
  queryFn: () => api<{ data: Role[] }>('GET', '/roles').then((r) => r.data),
  staleTime: 5 * 60_000,
};

export const invitationsQuery = {
  queryKey: ['invitations'],
  queryFn: () => api<{ data: Invitation[] }>('GET', '/users/invitations').then((r) => r.data),
};

// ---- Sprint 2 ----
import type {
  Agency, ApplicationCard, CandidateProfile, CandidateRow, Paged, RequisitionDetail, RequisitionRow, Stage,
  VacancyDetail, VacancyRow,
} from './api';

const qs = (params: Record<string, string | number | undefined | null>) => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') s.set(k, String(v));
  const str = s.toString();
  return str ? `?${str}` : '';
};

export const requisitionsQuery = (f: { status: string; q: string; mine: boolean; page: number }) => ({
  queryKey: ['requisitions', f],
  queryFn: () => api<Paged<RequisitionRow>>('GET', `/requisitions${qs({ status: f.status, q: f.q, mine: f.mine ? 'true' : undefined, page: f.page, page_size: 25 })}`),
});
export const requisitionQuery = (id: string) => ({
  queryKey: ['requisition', id],
  queryFn: () => api<{ data: RequisitionDetail }>('GET', `/requisitions/${id}`).then((r) => r.data),
});
export const approversQuery = (departmentId: string) => ({
  queryKey: ['approvers', departmentId],
  queryFn: () => api<{ data: { id: string; full_name: string; email: string }[] }>('GET', `/requisitions/approvers?department_id=${departmentId}`).then((r) => r.data),
});

export const vacanciesQuery = (f: { status: string; q: string; department_id: string; page: number }) => ({
  queryKey: ['vacancies', f],
  queryFn: () => api<Paged<VacancyRow>>('GET', `/vacancies${qs({ ...f, page_size: 25 })}`),
});
export const vacancyQuery = (id: string) => ({
  queryKey: ['vacancy', id],
  queryFn: () => api<{ data: VacancyDetail }>('GET', `/vacancies/${id}`).then((r) => r.data),
});
export const vacancyOptionsQuery = {
  queryKey: ['vacancy-options'],
  queryFn: () => api<Paged<VacancyRow>>('GET', '/vacancies?status=open&page_size=100'),
};

export const agenciesQuery = (status: 'active' | 'inactive' | 'all') => ({
  queryKey: ['agencies', status],
  queryFn: () => api<{ data: Agency[] }>('GET', `/agencies?status=${status}`).then((r) => r.data),
});

export const candidatesQuery = (f: Record<string, string | number | undefined>) => ({
  queryKey: ['candidates', f],
  queryFn: () => api<Paged<CandidateRow>>('GET', `/candidates${qs({ ...f, page_size: 25 })}`),
});
export const candidateQuery = (id: string) => ({
  queryKey: ['candidate', id],
  queryFn: () => api<{ data: CandidateProfile }>('GET', `/candidates/${id}`).then((r) => r.data),
});

export const stagesQuery = {
  queryKey: ['stages'],
  queryFn: () => api<{ data: Stage[] }>('GET', '/pipeline/stages').then((r) => r.data),
  staleTime: 5 * 60_000,
};
export const applicationsQuery = (f: { vacancy_id: string; status?: string }) => ({
  queryKey: ['applications', f],
  queryFn: () => api<Paged<ApplicationCard>>('GET', `/applications${qs({ vacancy_id: f.vacancy_id, status: f.status ?? 'active', page_size: 200 })}`),
});

// ---- Sprint 3 ----
import type { AgencyMembers, PortalHome, PortalSubmission, PortalVacancy, PortalVacancyRow } from './api';

export const portalHomeQuery = {
  queryKey: ['portal-home'],
  queryFn: () => api<{ data: PortalHome }>('GET', '/agency/home').then((r) => r.data),
};
export const portalVacanciesQuery = {
  queryKey: ['portal-vacancies'],
  queryFn: () => api<{ data: PortalVacancyRow[] }>('GET', '/agency/vacancies').then((r) => r.data),
};
export const portalVacancyQuery = (id: string) => ({
  queryKey: ['portal-vacancy', id],
  queryFn: () => api<{ data: PortalVacancy }>('GET', `/agency/vacancies/${id}`).then((r) => r.data),
});
export const portalSubmissionsQuery = (f: { vacancy_id?: string; page: number }) => ({
  queryKey: ['portal-submissions', f],
  queryFn: () => api<Paged<PortalSubmission>>('GET', `/agency/submissions${qs({ vacancy_id: f.vacancy_id, page: f.page, page_size: 25 })}`),
});

export const agencyMembersQuery = (id: string) => ({
  queryKey: ['agency-members', id],
  queryFn: () => api<{ data: AgencyMembers }>('GET', `/agencies/${id}/members`).then((r) => r.data),
});

// ---- Sprint 4 ----
import type {
  ApplicationFeedback, DirectoryUser, FeedbackItem, InterviewDetail, InterviewPlan, InterviewRow, MyInterviewDetail, MyInterviewRow,
  NotificationItem, TaskItem,
} from './api';

export const interviewsQuery = (f: Record<string, string | number | undefined>) => ({
  queryKey: ['interviews', f],
  queryFn: () => api<Paged<InterviewRow>>('GET', `/interviews${qs({ ...f, page_size: 200 })}`),
});
export const interviewQuery = (id: string) => ({
  queryKey: ['interview', id],
  queryFn: () => api<{ data: InterviewDetail }>('GET', `/interviews/${id}`).then((r) => r.data),
});
export const interviewFeedbackQuery = (id: string, enabled = true) => ({
  queryKey: ['interview-feedback', id],
  queryFn: () => api<{ data: FeedbackItem[] }>('GET', `/interviews/${id}/feedback`).then((r) => r.data),
  enabled,
});
export const applicationFeedbackQuery = (id: string, enabled = true) => ({
  queryKey: ['application-feedback', id],
  queryFn: () => api<{ data: ApplicationFeedback }>('GET', `/applications/${id}/feedback`).then((r) => r.data),
  enabled,
});
export const decisionsQuery = (applicationId: string) => ({
  queryKey: ['decisions', applicationId],
  queryFn: () => api<{ data: { id: string; decision: string; reason: string | null; decided_at: string; decided_by_name: string }[] }>('GET', `/applications/${applicationId}/decisions`).then((r) => r.data),
});
export const plansQuery = (vacancyId: string) => ({
  queryKey: ['plans', vacancyId],
  queryFn: () => api<{ data: InterviewPlan[] }>('GET', `/vacancies/${vacancyId}/interview-plans`).then((r) => r.data),
});
export const directoryQuery = {
  queryKey: ['directory'],
  queryFn: () => api<{ data: DirectoryUser[] }>('GET', '/directory/users').then((r) => r.data),
  staleTime: 5 * 60_000,
};
export const myInterviewsQuery = {
  queryKey: ['my-interviews'],
  queryFn: () => api<{ data: MyInterviewRow[] }>('GET', '/me/interviews').then((r) => r.data),
};
export const myInterviewQuery = (id: string) => ({
  queryKey: ['my-interview', id],
  queryFn: () => api<{ data: MyInterviewDetail }>('GET', `/me/interviews/${id}`).then((r) => r.data),
});
export const notificationsQuery = (unread: boolean) => ({
  queryKey: ['notifications', unread],
  queryFn: () => api<Paged<NotificationItem>>('GET', `/notifications${qs({ unread: unread ? 'true' : undefined, page_size: 50 })}`),
});
export const unreadCountQuery = {
  queryKey: ['unread-count'],
  queryFn: () => api<{ data: { unread: number } }>('GET', '/notifications/unread-count').then((r) => r.data.unread),
  refetchInterval: 60_000,
};
export const tasksQuery = (status: 'open' | 'done') => ({
  queryKey: ['tasks', status],
  queryFn: () => api<{ data: TaskItem[] }>('GET', `/tasks?status=${status}`).then((r) => r.data),
});

// ---- Sprint 5: analytics and exports ----
export interface AnalyticsFilters { from?: string; to?: string; department_id?: string }
export const analyticsQuery = <T>(name: string, f: AnalyticsFilters = {}, enabled = true) => ({
  queryKey: ['analytics', name, f],
  queryFn: () => api<{ data: T }>('GET', `/analytics/${name}${qs({ ...f })}`).then((r) => r.data),
  enabled,
});
export interface ExportOption { type: 'candidates' | 'applications' | 'vacancies'; fields: { key: string; label: string }[] }
export interface ExportJob { id: string; export_type: string; status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'; row_count: number | null; filename: string | null; error: string | null; created_at: string; finished_at: string | null; expired: boolean }
export const exportOptionsQuery = { queryKey: ['export-options'], queryFn: () => api<{ data: ExportOption[] }>('GET', '/exports/options').then((r) => r.data) };
export const exportsQuery = {
  queryKey: ['exports'],
  queryFn: () => api<{ data: ExportJob[] }>('GET', '/exports').then((r) => r.data),
  refetchInterval: (q: { state: { data?: ExportJob[] } }) => (q.state.data?.some((j) => j.status === 'queued' || j.status === 'running') ? 3000 : false),
};

// ---- Sprint 6 ----
export const offersQuery = (status: string, waitingOnMe = false) => ({
  queryKey: ['offers', status, waitingOnMe],
  queryFn: () => api<{ data: OfferRow[] }>('GET', `/offers${qs({ status, waiting_on_me: waitingOnMe ? 'true' : undefined, page_size: 100 })}`).then((r) => r.data),
});
export const offerQuery = (id: string) => ({ queryKey: ['offer', id], queryFn: () => api<{ data: OfferDetail }>('GET', `/offers/${id}`).then((r) => r.data) });
export const joiningQuery = (status: string) => ({ queryKey: ['joining', status], queryFn: () => api<{ data: JoiningRow[] }>('GET', `/joining${qs({ status })}`).then((r) => r.data) });
export const offerApproversQuery = (departmentId: string) => ({
  queryKey: ['offer-approvers', departmentId],
  queryFn: () => api<{ data: { id: string; full_name: string; email: string }[] }>('GET', `/offers/approvers?department_id=${departmentId}`).then((r) => r.data),
});

// ---- Hiring manager home ----
export interface HiringHome {
  feedback_owed: { interview_id: string; round_name: string; scheduled_end: string; candidate_name: string; overdue: boolean }[];
  approvals: { id: string; title: string; headcount: number }[];
  waiting_for_decision: { id: string; candidate_name: string; current_title: string | null; vacancy_id: string; vacancy_title: string; feedback_count: number; avg_rating: number | null; recommendations: string[]; can_decide: boolean }[];
  vacancies: { id: string; title: string; code: string; location: string; department: string; department_id: string; status: string; headcount: number; days_open: number; hired: number; funnel: { new: number; screening: number; shortlisted: number; interview: number; offer: number } }[];
  upcoming_interviews: { id: string; round_name: string; scheduled_start: string; timezone: string; mode: string; candidate_name: string; vacancy_title: string; is_mine: boolean }[];
}
export interface JobRole { id: string; name: string; status: 'active' | 'inactive'; department_id: string; department_name: string; sourced: number }
export const jobRolesQuery = (departmentId?: string, status: 'active' | 'all' = 'active') => ({
  queryKey: ['job-roles', departmentId ?? '', status],
  queryFn: () => api<{ data: JobRole[] }>('GET', `/job-roles${qs({ department_id: departmentId, status })}`).then((r) => r.data),
});
export const hiringHomeQuery = { queryKey: ['hiring-home'], queryFn: () => api<{ data: HiringHome }>('GET', '/hiring-home').then((r) => r.data), refetchInterval: 60_000 };

export const decisionListQuery = (decision: string) => ({
  queryKey: ['decisions', 'list', decision],
  queryFn: () => api<{ data: import('./api').DecisionRow[] }>('GET', `/decisions${qs({ decision })}`).then((r) => r.data),
});

export const candidateStatusQuery = (vacancyId: string, q: string, selected = '', jobRoleId = '') => ({
  queryKey: ['candidate-status', vacancyId, q, selected, jobRoleId],
  queryFn: () => api<{ data: import('./api').CandidateStatusRow[] }>('GET', `/candidate-status${qs({ vacancy_id: vacancyId || undefined, q: q || undefined, selected: selected || undefined, job_role_id: jobRoleId || undefined })}`).then((r) => r.data),
});
