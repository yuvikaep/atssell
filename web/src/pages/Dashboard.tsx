import { useQuery } from '@tanstack/react-query';
import { Link, Navigate } from '@tanstack/react-router';
import { can, formatInZone, isRecruiter, type Me } from '../api';
import { HrDashboard } from './HrDashboard';
import { MyPerformance } from './MyPerformance';
import { HiringHomePage } from './HiringHome';
import { Icon } from '../components/Icon';
import { Bars } from '../components/Bars';
import { ErrorState } from '../components/ui';
import { useMe } from '../components/AppShell';
import { analyticsQuery, departmentsQuery, invitationsQuery, usersQuery } from '../queries';

interface DashboardData {
  open_vacancies: number;
  active_candidates: number;
  candidates_by_stage: { stage: string; count: number }[];
  upcoming_interviews: { id: string; round_name: string; scheduled_start: string; timezone: string; candidate_name: string; vacancy_title: string }[];
  feedback: { pending: number; overdue: number } | null;
  vacancy_ageing: { average_age_days: number | null; buckets: { label: string; count: number }[] };
  offers: { waiting_on_me: number; open: number; upcoming_joiners: { id: string; candidate_name: string; vacancy_title: string; joining_date: string; status: string }[] } | null;
}

/** Decides hires, but has no recruiting, user or department admin rights. */
export function isHiringManager(me: Me) {
  return can(me, 'decisions.record') && !can(me, 'applications.manage') && !can(me, 'users.manage') && !can(me, 'departments.manage') && !can(me, 'vacancies.view_all');
}

type Step = { title: string; hint: string; done: boolean; to: '/departments' | '/users' | '/requisitions' | '/candidates'; cta: string };

/** A short checklist for a new company. It disappears once everything is done. */
function SetupSteps({ steps }: { steps: (Step | false)[] }) {
  const list = steps.filter((x): x is Step => !!x);
  if (list.length === 0 || list.every((x) => x.done)) return null;
  const done = list.filter((x) => x.done).length;
  return (
    <div className="card">
      <div className="toolbar"><h2>Get set up</h2><span className="muted">{done} of {list.length} done</span></div>
      <div className="table-wrap"><table><tbody>
        {list.map((x) => (
          <tr key={x.title}>
            <td style={{ width: 90 }}>{x.done ? <span className="badge badge-active">Done</span> : <span className="badge">To do</span>}</td>
            <td><strong>{x.title}</strong><div className="cell-sub">{x.hint}</div></td>
            <td className="actions"><Link className={`btn btn-sm ${x.done ? '' : 'btn-primary'}`} to={x.to}>{x.cta}</Link></td>
          </tr>
        ))}
      </tbody></table></div>
    </div>
  );
}

export function DashboardPage() {
  const me = useMe();
  // Agency users have no company dashboard: their portal is their home.
  if (can(me, 'agency_portal.use')) return <MyPerformance kind="agency" name={me.user.full_name.split(' ')[0]!} />;
  // Each of the four roles has its own home.
  if (can(me, 'employment.manage')) return <HrDashboard name={me.user.full_name.split(' ')[0]!} />;
  if (isRecruiter(me)) return <MyPerformance kind="recruiter" name={me.user.full_name.split(' ')[0]!} />;
  if (Object.keys(me.permissions).length === 0) return <Navigate to="/my-interviews" replace />;
  // People who hire but do not run the process get a simpler home.
  if (isHiringManager(me)) return <HiringHomePage me={me} />;
  const canDepartments = can(me, 'departments.manage') || can(me, 'vacancies.view_all');
  const canUsers = can(me, 'users.manage');

  const departments = useQuery({ ...departmentsQuery('active'), enabled: canDepartments });
  const users = useQuery({ ...usersQuery('active', ''), enabled: canUsers });
  const invitations = useQuery({ ...invitationsQuery, enabled: canUsers });

  const canHiring = can(me, 'vacancies.view_all') || can(me, 'vacancies.view_assigned') || can(me, 'offers.approve');
  const hiring = useQuery(analyticsQuery<DashboardData>('dashboard', {}, canHiring));

  const firstName = me.user.full_name.split(' ')[0];
  const deptCount = departments.data?.length;
  const userCount = users.data?.total;
  const pendingInvites = invitations.data?.filter((i) => !i.expired).length;

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Welcome back, {firstName}</h1>
          <p>{me.tenant.name}</p>
        </div>
        <div className="actions-row">
          {can(me, 'requisitions.create') && <Link className="btn btn-primary" to="/requisitions"><Icon name="plus" size={16} />New hiring request</Link>}
          {can(me, 'candidates.manage') && <Link className="btn" to="/candidates">Add candidate</Link>}
          {can(me, 'users.manage') && <Link className="btn" to="/users">Invite team</Link>}
        </div>
      </div>

      {canHiring && (
        hiring.isError ? <ErrorState error={hiring.error} onRetry={() => hiring.refetch()} /> : (
          <>
            <div className="stats">
              <div className="card stat"><div className="label">Open jobs</div><div className="value">{hiring.data?.open_vacancies ?? '–'}</div>
                <div className="foot"><Link to="/vacancies">View jobs</Link></div></div>
              <div className="card stat"><div className="label">Candidates in progress</div><div className="value">{hiring.data?.active_candidates ?? '–'}</div>
                <div className="foot"><Link to="/pipeline">Open candidate board</Link></div></div>
              {hiring.data?.feedback && (
                <div className="card stat"><div className="label">Feedback pending</div><div className="value">{hiring.data.feedback.pending}</div>
                  <div className="foot">{hiring.data.feedback.overdue > 0 ? `${hiring.data.feedback.overdue} overdue` : 'None overdue'}</div></div>
              )}
              {hiring.data?.offers && (
                <div className="card stat"><div className="label">Offers in progress</div><div className="value">{hiring.data.offers.open}</div>
                  <div className="foot"><Link to="/offers">{hiring.data.offers.waiting_on_me > 0 ? `${hiring.data.offers.waiting_on_me} waiting for you` : 'View offers'}</Link></div></div>
              )}
              <div className="card stat"><div className="label">Average vacancy age</div><div className="value">{hiring.data?.vacancy_ageing.average_age_days ?? '–'}<span className="muted" style={{ fontSize: 13 }}> days</span></div>
                <div className="foot">{can(me, 'analytics.view') ? <Link to="/reports">Reports</Link> : 'Open and on hold'}</div></div>
            </div>
            <div className="report-grid">
              <div className="card">
                <div className="toolbar"><h2>Candidates by stage</h2></div>
                {hiring.data && hiring.data.candidates_by_stage.length === 0 ? <p className="empty-inline" style={{ padding: '0 16px 16px' }}>No active candidates yet.</p>
                  : <Bars rows={(hiring.data?.candidates_by_stage ?? []).map((x) => ({ label: x.stage, value: x.count }))} />}
              </div>
              {hiring.data?.offers && hiring.data.offers.upcoming_joiners.length > 0 && (
                <div className="card">
                  <div className="toolbar"><h2>Joining in the next 14 days</h2></div>
                  <div className="table-wrap"><table><tbody>
                    {hiring.data.offers.upcoming_joiners.map((j) => (
                      <tr key={j.id}><td>{j.candidate_name}<div className="cell-sub">{j.vacancy_title}</div></td><td>{new Date(`${j.joining_date}T00:00:00`).toLocaleDateString(undefined, { dateStyle: 'medium' })}</td></tr>
                    ))}
                  </tbody></table></div>
                </div>
              )}
              {hiring.data?.feedback && (
                <div className="card">
                  <div className="toolbar"><h2>Interviews in the next 7 days</h2></div>
                  {hiring.data.upcoming_interviews.length === 0 ? <p className="empty-inline" style={{ padding: '0 16px 16px' }}>Nothing scheduled.</p> : (
                    <div className="table-wrap"><table><tbody>
                      {hiring.data.upcoming_interviews.map((i) => (
                        <tr key={i.id}>
                          <td><Link className="row-link" to="/interviews/$id" params={{ id: i.id }}>{i.candidate_name}</Link><div className="cell-sub">{i.vacancy_title} · {i.round_name}</div></td>
                          <td>{formatInZone(i.scheduled_start, i.timezone)}</td>
                        </tr>
                      ))}
                    </tbody></table></div>
                  )}
                </div>
              )}
            </div>
          </>
        )
      )}

      {(canDepartments || canUsers) && (
        <div className="stats">
          {canDepartments && (
            <div className="card stat">
              <div className="label">Active departments</div>
              <div className="value">{deptCount ?? '–'}</div>
              <div className="foot"><Link to="/departments">Manage departments</Link></div>
            </div>
          )}
          {canUsers && (
            <div className="card stat">
              <div className="label">Active users</div>
              <div className="value">{userCount ?? '–'}</div>
              <div className="foot">{pendingInvites ? `${pendingInvites} invitation${pendingInvites === 1 ? '' : 's'} pending` : 'No pending invitations'}</div>
            </div>
          )}
        </div>
      )}

      <SetupSteps
        steps={[
          canDepartments && { title: 'Set up your departments', hint: 'Hiring requests and access are organised by department.', done: !!deptCount, to: '/departments' as const, cta: 'Departments' },
          canUsers && { title: 'Invite your team', hint: 'HR heads, recruiters, hiring managers and interviewers.', done: userCount !== undefined && userCount > 1, to: '/users' as const, cta: 'Team & roles' },
          can(me, 'requisitions.create') && { title: 'Raise your first hiring request', hint: 'Say how many people you need, get it approved, then open jobs.', done: (hiring.data?.open_vacancies ?? 0) > 0, to: '/requisitions' as const, cta: 'Hiring requests' },
          can(me, 'candidates.manage') && { title: 'Add candidates', hint: 'Upload resumes, then move people along the candidate board.', done: (hiring.data?.active_candidates ?? 0) > 0, to: '/candidates' as const, cta: 'Candidates' },
        ]}
      />
    </>
  );
}
