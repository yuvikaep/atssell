import { canExport, ExportButton } from '../components/ExportButton';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useDeferredValue, useState } from 'react';
import { can, isRecruiter, VACANCY_STATUS_LABEL, type VacancyStatus } from '../api';
import { useMe } from '../components/AppShell';
import { Meter } from '../components/Stat';
import { Badge, EmptyState, ErrorState, Loading, Pager, type Tone } from '../components/ui';
import { NewJobDialog } from '../components/NewJobDialog';
import { departmentsQuery, hiringHomeQuery, vacanciesQuery } from '../queries';
import { useSessionState } from '../session-storage';

export const VACANCY_TONE: Record<VacancyStatus, Tone> = { open: 'success', on_hold: 'warning', closed: 'muted', cancelled: 'muted' };
const STATUSES = ['active', 'open', 'on_hold', 'closed', 'cancelled', 'all'] as const;
const STATUS_LABEL: Record<(typeof STATUSES)[number], string> = {
  active: 'Open and on hold', open: 'Open', on_hold: 'On hold', closed: 'Closed', cancelled: 'Cancelled', all: 'All',
};

/** Recruiters see only the jobs assigned to them, as simple cards with the two things they do. */
function RecruiterJobs() {
  const jobs = useQuery(hiringHomeQuery);
  return (
    <>
      <div className="page-header"><div><h1>Jobs</h1><p>The jobs assigned to you.</p></div></div>
      {jobs.isPending ? <Loading /> : jobs.isError ? <ErrorState error={jobs.error} onRetry={() => jobs.refetch()} /> : jobs.data.vacancies.length === 0 ? (
        <div className="card"><EmptyState title="No jobs assigned yet">When your admin assigns you a job it appears here.</EmptyState></div>
      ) : (
        <div className="hm-roles">
          {jobs.data.vacancies.map((v) => {
            const total = Object.values(v.funnel).reduce((a, b) => a + b, 0);
            return (
              <article key={v.id} className="hm-role">
                <header>
                  <div>
                    <div className="hm-role-title">{v.title}</div>
                    <div className="hm-sub">{v.department} · {v.location} · open {v.days_open === 0 ? 'today' : `${v.days_open} days`}</div>
                  </div>
                  <div className="hm-fill"><span className="hm-fill-text">{v.hired} of {v.headcount} filled</span></div>
                </header>
                <div className="hm-sub"><strong>{total}</strong> candidates in progress · <strong>{v.funnel.interview + v.funnel.offer}</strong> at interview or offer</div>
                <footer className="actions-row" style={{ justifyContent: 'flex-end' }}>
                  <Link className="btn btn-sm" to="/status" search={{ job: v.id } as never}>Candidate status</Link>
                  <Link className="btn btn-primary btn-sm" to="/sourcing" search={{ job: v.id } as never}>Source candidates</Link>
                </footer>
              </article>
            );
          })}
        </div>
      )}
    </>
  );
}

export function VacanciesPage() {
  const me = useMe();
  return isRecruiter(me) ? <RecruiterJobs /> : <AllJobsPage />;
}

function AllJobsPage() {
  const me = useMe();
  const [creating, setCreating] = useState(false);
  const [status, setStatus] = useSessionState('jm.vacancies.status', 'active', STATUSES);
  const [department, setDepartment] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const q = useDeferredValue(search.trim());
  const departments = useQuery(departmentsQuery('active'));
  const list = useQuery(vacanciesQuery({ status, q, department_id: department, page }));
  const filtered = status !== 'active' || q !== '' || department !== '';

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Jobs</h1>
          <p>Job openings with their hiring target and actual joins. Assign recruiters and agencies from a job.</p>
        </div>
        <div className="actions-row">
          {canExport(me) && <ExportButton name="jobs" disabled={!list.data?.data.length} head={['Code', 'Job', 'Department', 'Location', 'Openings', 'Joined', 'Status', 'Opened', 'Days open', 'Recruiters', 'Agencies']}
            rows={() => (list.data?.data ?? []).map((v) => [v.vacancy_code, v.title, v.department_name, v.location, v.headcount, v.joined ?? 0, v.status, v.opened_at.slice(0, 10), v.age_days, v.recruiters, v.agencies])} />}
          {can(me, 'requisitions.create') && can(me, 'vacancies.manage') && <button className="btn btn-primary" onClick={() => setCreating(true)}>New job</button>}
        </div>
      </div>

      <div className="card">
        <div className="toolbar">
          <input className="grow" type="search" placeholder="Search by title or code" aria-label="Search vacancies" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} />
          <select aria-label="Status" value={status} onChange={(e) => { setStatus(e.target.value as (typeof STATUSES)[number]); setPage(1); }}>
            {STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
          </select>
          <select aria-label="Department" value={department} onChange={(e) => { setDepartment(e.target.value); setPage(1); }}>
            <option value="">All departments</option>
            {(departments.data ?? []).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </div>
        {list.isPending ? (
          <Loading />
        ) : list.isError ? (
          <ErrorState error={list.error} onRetry={() => list.refetch()} />
        ) : list.data.data.length === 0 ? (
          <EmptyState title={filtered ? 'No vacancies match' : 'No vacancies to show'}>
            {filtered ? 'Try different filters.' : 'Vacancies appear here once a requisition is approved and a vacancy is opened, or when you are assigned to one.'}
          </EmptyState>
        ) : (
          <>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr><th>Job</th><th>Department</th><th>Recruiters</th><th>Agencies</th><th>Joined / target</th><th className="num">In pipeline</th><th>Status</th><th className="num">Age</th></tr>
                </thead>
                <tbody>
                  {list.data.data.map((v) => (
                    <tr key={v.id}>
                      <td>
                        <Link className="row-link" to="/vacancies/$id" params={{ id: v.id }}>{v.title}</Link>
                        <div className="cell-sub">{v.vacancy_code} · {v.location}</div>
                      </td>
                      <td>{v.department_name}</td>
                      <td>{v.recruiters.length ? v.recruiters.join(', ') : <span className="muted">None</span>}</td>
                      <td>{v.agencies.length ? v.agencies.join(', ') : <span className="muted">None</span>}</td>
                      <td><span className="num">{v.joined ?? 0} / {v.headcount}</span><Meter value={v.joined ?? 0} max={v.headcount} /></td>
                      <td className="num">{v.active_candidates}</td>
                      <td><Badge tone={VACANCY_TONE[v.status]}>{VACANCY_STATUS_LABEL[v.status]}</Badge></td>
                      <td className="num muted">{v.age_days}d</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pager page={page} pageSize={list.data.page_size} total={list.data.total} onPage={setPage} />
          </>
        )}
      </div>
      {creating && <NewJobDialog onClose={() => setCreating(false)} />}
    </>
  );
}
