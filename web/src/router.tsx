import type { QueryClient } from '@tanstack/react-query';
import { createRootRouteWithContext, createRoute, createRouter, Outlet, redirect } from '@tanstack/react-router';
import { ApiError } from './api';
import { AppShell } from './components/AppShell';
import { AcceptInvitePage } from './pages/AcceptInvite';
import { AgenciesPage } from './pages/Agencies';
import { AgencyDetailPage } from './pages/AgencyDetail';
import { CandidateDetailPage } from './pages/CandidateDetail';
import { CandidatesPage } from './pages/Candidates';
import { DashboardPage } from './pages/Dashboard';
import { DepartmentsPage } from './pages/Departments';
import { InterviewDetailPage } from './pages/InterviewDetail';
import { InterviewsPage } from './pages/Interviews';
import { MyInterviewDetailPage, MyInterviewsPage } from './pages/MyInterviews';
import { OfferDetailPage } from './pages/OfferDetail';
import { OffersPage } from './pages/Offers';
import { CandidateStatusPage } from './pages/CandidateStatus';
import { SourcingPage } from './pages/Sourcing';
import { AgencyTeamPage, AgencyTermsPage } from './pages/AgencyTeam';
import { CandidateMasterPage } from './pages/CandidateMaster';
import { EmployeesPage } from './pages/Employees';
import { LeaderboardsPage } from './pages/Leaderboards';
import { AccountPage } from './pages/Account';
import { DecisionsPage } from './pages/Decisions';
import { ReportsPage } from './pages/Reports';
import { NotificationsPage } from './pages/Notifications';
import { FeedbackPublicPage } from './pages/FeedbackPublic';
import { ForgotPasswordPage } from './pages/ForgotPassword';
import { LoginPage } from './pages/Login';
import { AppErrorPage, NotFoundPage } from './pages/NotFound';
import { PipelinePage } from './pages/Pipeline';
import { PortalPage } from './pages/Portal';
import { PortalSubmissionsPage } from './pages/PortalSubmissions';
import { PortalVacancyPage } from './pages/PortalVacancy';
import { RequisitionDetailPage } from './pages/RequisitionDetail';
import { RequisitionsPage } from './pages/Requisitions';
import { ResetPasswordPage } from './pages/ResetPassword';
import { UsersPage } from './pages/Users';
import { VacanciesPage } from './pages/Vacancies';
import { SignupPage } from './pages/Signup';
import { SalaryJoiningPage } from './pages/SalaryJoining';
import { OnboardingPage } from './pages/Onboarding';
import { VacancyDetailPage } from './pages/VacancyDetail';
import { meQuery, queryClient } from './queries';

const rootRoute = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  component: Outlet,
  notFoundComponent: NotFoundPage,
  errorComponent: AppErrorPage,
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  validateSearch: (s: Record<string, unknown>) => ({ redirect: typeof s.redirect === 'string' ? s.redirect : undefined }),
  component: LoginPage,
});
const signupRoute = createRoute({ getParentRoute: () => rootRoute, path: '/signup', component: SignupPage });
const forgotRoute = createRoute({ getParentRoute: () => rootRoute, path: '/forgot-password', component: ForgotPasswordPage });
const resetRoute = createRoute({ getParentRoute: () => rootRoute, path: '/reset-password', component: ResetPasswordPage });
const inviteRoute = createRoute({ getParentRoute: () => rootRoute, path: '/invite', component: AcceptInvitePage });
// Public: interviewers open this from an emailed link, with no account.
const feedbackRoute = createRoute({ getParentRoute: () => rootRoute, path: '/feedback', component: FeedbackPublicPage });

// Everything under this layout requires a session; tenant data is never fetched before it.
const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'app',
  beforeLoad: async ({ context, location }) => {
    try {
      await context.queryClient.ensureQueryData(meQuery);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        throw redirect({ to: '/login', search: { redirect: location.href === '/' ? undefined : location.href } });
      }
      throw err;
    }
  },
  component: AppShell,
});

const dashboardRoute = createRoute({ getParentRoute: () => appRoute, path: '/', component: DashboardPage });
const departmentsRoute = createRoute({ getParentRoute: () => appRoute, path: '/departments', component: DepartmentsPage });
const usersRoute = createRoute({ getParentRoute: () => appRoute, path: '/users', component: UsersPage });
const requisitionsRoute = createRoute({ getParentRoute: () => appRoute, path: '/requisitions', component: RequisitionsPage });
const requisitionRoute = createRoute({ getParentRoute: () => appRoute, path: '/requisitions/$id', component: RequisitionDetailPage });
const vacanciesRoute = createRoute({ getParentRoute: () => appRoute, path: '/vacancies', component: VacanciesPage });
const vacancyRoute = createRoute({ getParentRoute: () => appRoute, path: '/vacancies/$id', component: VacancyDetailPage });
const candidatesRoute = createRoute({ getParentRoute: () => appRoute, path: '/candidates', component: CandidateMasterPage });
const candidateRoute = createRoute({ getParentRoute: () => appRoute, path: '/candidates/$id', component: CandidateDetailPage, validateSearch: (s: Record<string, unknown>): { edit?: string } => ({ edit: typeof s.edit === 'string' ? s.edit : undefined }) });
const pipelineRoute = createRoute({ getParentRoute: () => appRoute, path: '/pipeline', component: PipelinePage });
const agenciesRoute = createRoute({ getParentRoute: () => appRoute, path: '/agencies', component: AgenciesPage });
const interviewsRoute = createRoute({ getParentRoute: () => appRoute, path: '/interviews', component: InterviewsPage });
const interviewRoute = createRoute({ getParentRoute: () => appRoute, path: '/interviews/$id', component: InterviewDetailPage });
const myInterviewsRoute = createRoute({ getParentRoute: () => appRoute, path: '/my-interviews', component: MyInterviewsPage });
const myInterviewRoute = createRoute({ getParentRoute: () => appRoute, path: '/my-interviews/$id', component: MyInterviewDetailPage });
const offersRoute = createRoute({ getParentRoute: () => appRoute, path: '/offers', component: OffersPage });
const offerRoute = createRoute({ getParentRoute: () => appRoute, path: '/offers/$id', component: OfferDetailPage });
const decisionsRoute = createRoute({ getParentRoute: () => appRoute, path: '/decisions', component: DecisionsPage });
const accountRoute = createRoute({ getParentRoute: () => appRoute, path: '/account', component: AccountPage });
const sourcingRoute = createRoute({ getParentRoute: () => appRoute, path: '/sourcing', component: SourcingPage, validateSearch: (s: Record<string, unknown>) => ({ job: typeof s.job === 'string' ? s.job : undefined }) });
const onboardingRoute = createRoute({ getParentRoute: () => appRoute, path: '/setup', component: OnboardingPage });
const salaryJoiningRoute = createRoute({ getParentRoute: () => appRoute, path: '/salary-joining', component: SalaryJoiningPage });
const statusRoute = createRoute({ getParentRoute: () => appRoute, path: '/status', component: CandidateStatusPage, validateSearch: (s: Record<string, unknown>) => ({ job: typeof s.job === 'string' ? s.job : undefined }) });
const employeesRoute = createRoute({ getParentRoute: () => appRoute, path: '/employees', component: EmployeesPage });
const leaderboardsRoute = createRoute({ getParentRoute: () => appRoute, path: '/leaderboards', component: LeaderboardsPage });
const termsRoute = createRoute({ getParentRoute: () => appRoute, path: '/terms', component: AgencyTermsPage });
const teamRoute = createRoute({ getParentRoute: () => appRoute, path: '/team', component: AgencyTeamPage });
const reportsRoute = createRoute({ getParentRoute: () => appRoute, path: '/reports', component: ReportsPage });
const notificationsRoute = createRoute({ getParentRoute: () => appRoute, path: '/notifications', component: NotificationsPage });
const agencyRoute = createRoute({ getParentRoute: () => appRoute, path: '/agencies/$id', component: AgencyDetailPage });
const portalRoute = createRoute({ getParentRoute: () => appRoute, path: '/portal', component: PortalPage });
const portalVacancyRoute = createRoute({ getParentRoute: () => appRoute, path: '/portal/vacancies/$id', component: PortalVacancyPage });
const portalSubmissionsRoute = createRoute({ getParentRoute: () => appRoute, path: '/portal/submissions', component: PortalSubmissionsPage });

const routeTree = rootRoute.addChildren([
  loginRoute,
  signupRoute,
  forgotRoute,
  resetRoute,
  inviteRoute,
  feedbackRoute,
  appRoute.addChildren([
    dashboardRoute, departmentsRoute, usersRoute, requisitionsRoute, requisitionRoute, vacanciesRoute, vacancyRoute,
    candidatesRoute, candidateRoute, pipelineRoute, agenciesRoute, agencyRoute,
    portalRoute, portalVacancyRoute, portalSubmissionsRoute,
    interviewsRoute, interviewRoute, myInterviewsRoute, myInterviewRoute, notificationsRoute, reportsRoute, decisionsRoute, accountRoute, employeesRoute, leaderboardsRoute, termsRoute, teamRoute, sourcingRoute, statusRoute, salaryJoiningRoute, onboardingRoute, offersRoute, offerRoute,
  ]),
]);

export const router = createRouter({ routeTree, context: { queryClient }, defaultPreload: false });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
