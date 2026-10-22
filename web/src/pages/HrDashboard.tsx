import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { api, formatDay } from '../api';
import { Bars } from '../components/Bars';
import { Icon } from '../components/Icon';
import { PipelineChart } from '../components/PipelineChart';
import { Meter, Stat, pctText } from '../components/Stat';
import { Badge, EmptyState, ErrorState, Loading } from '../components/ui';

interface Board { rank: number; owner_id: string; name: string; valid_submissions: number; joined: number; conversion_pct: number | null }
interface Dash {
  totals: { open_jobs: number; on_hold_jobs: number; pipeline: number; interviews_scheduled: number; pending_feedback: number; joined: number; active_employees: number; exits: number };
  jobs: { id: string; title: string; vacancy_code: string; department: string; status: string; target: number; joined: number; pipeline: number; interviews: number }[];
  by_department: { department: string; jobs: number; target: number; joined: number; pipeline: number }[];
  recruiters: Board[]; agencies: Board[];
  agency_models: { agency_id: string; name: string; status: string; terms: { payment_model: string; fee_type: string; fee_value: number; lockin_days: number | null; replacement_days: number | null } | null }[];
  replacements_due: { id: string; candidate_name: string; agency_name: string; job_title: string; due_by: string; exit_date: string }[];
}

export const MODEL_LABEL: Record<string, string> = { payroll_management: 'Payroll management', one_time_fee: 'One-time hiring fee' };
export const termsText = (t: { payment_model: string; fee_type: string; fee_value: number } | null) =>
  t ? `${MODEL_LABEL[t.payment_model]} · ${t.fee_type === 'percent_of_ctc' ? `${t.fee_value}% of CTC` : `₹${t.fee_value.toLocaleString('en-IN')} fixed`}` : 'No terms set';

/** The HR Lead's one-page picture of hiring. */
export function HrDashboard({ name }: { name: string }) {
  const q = useQuery({ queryKey: ['hr-dashboard'], queryFn: () => api<{ data: Dash }>('GET', '/hr/dashboard').then((r) => r.data), refetchInterval: 120_000 });
  return (
    <>
      <div className="page-header">
        <div><h1>Welcome back, {name}</h1><p>Where hiring stands across jobs, recruiters and agencies.</p></div>
        <div className="actions-row">
          <Link className="btn btn-primary" to="/vacancies"><Icon name="plus" size={16} />New job</Link>
          <Link className="btn" to="/candidates">Candidates</Link>
        </div>
      </div>
      {q.isPending ? <Loading /> : q.isError ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : <Body d={q.data} />}
    </>
  );
}

function Body({ d }: { d: Dash }) {
  const t = d.totals;
  // A new company without jobs yet is pointed to the short setup.
  const needsSetup = d.jobs.length === 0 && t.open_jobs === 0 && t.pipeline === 0;
  return (
    <>
      {needsSetup && (
        <div className="card section setup-banner">
          <div><h2 style={{ margin: 0 }}>Finish setting up</h2><p className="muted" style={{ margin: '4px 0 0' }}>Add departments, jobs, recruiters and agencies in four quick steps.</p></div>
          <Link className="btn btn-primary" to="/setup">Start setup</Link>
        </div>
      )}
      <div className="stats">
        <Stat label="Open jobs" value={t.open_jobs} hint={t.on_hold_jobs ? `${t.on_hold_jobs} on hold` : undefined} />
        <Stat label="Candidates in pipeline" value={t.pipeline} />
        <Stat label="Interviews scheduled" value={t.interviews_scheduled} />
        <Stat label="Feedback pending" value={t.pending_feedback} tone={t.pending_feedback > 0 ? 'warn' : undefined} />
        <Stat label="Joined" value={t.joined} />
        <Stat label="Active employees" value={t.active_employees} />
        <Stat label="Exits" value={t.exits} tone={t.exits > 0 ? 'bad' : undefined} />
      </div>

      <div className="report-grid">
        <PipelineChart />
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="toolbar"><h2>Joined by job</h2><span style={{ flex: 1 }} /><span className="muted">joined of target</span></div>
          <Bars title="Joined by job" rows={d.jobs.slice(0, 8).map((j) => ({ label: j.title, value: j.joined, note: `of ${j.target} · ${j.pipeline} in pipeline` }))} />
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="toolbar"><h2>Jobs: target and actual joins</h2><span style={{ flex: 1 }} /><Link className="btn btn-sm" to="/vacancies">All jobs</Link></div>
        {d.jobs.length === 0 ? <EmptyState title="No open jobs">Create a job to start hiring.</EmptyState> : (
          <div className="table-wrap"><table>
            <thead><tr><th>Job</th><th>Department</th><th>Joined / target</th><th className="num">In pipeline</th><th className="num">Interviews</th><th>Status</th></tr></thead>
            <tbody>{d.jobs.map((j) => (
              <tr key={j.id}>
                <td><Link className="row-link" to="/vacancies/$id" params={{ id: j.id }}>{j.title}</Link><div className="cell-sub">{j.vacancy_code}</div></td>
                <td>{j.department}</td>
                <td><span className="num">{j.joined} / {j.target}</span> <Meter value={j.joined} max={j.target} /></td>
                <td className="num">{j.pipeline}</td><td className="num">{j.interviews}</td>
                <td><Badge tone={j.status === 'open' ? 'success' : 'warning'}>{j.status === 'open' ? 'Open' : 'On hold'}</Badge></td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </div>

      <div className="report-grid">
        <div className="card">
          <div className="toolbar"><h2>By department</h2></div>
          {d.by_department.length === 0 ? <p className="empty-inline" style={{ padding: '0 16px 16px' }}>No open jobs yet.</p> : (
            <Bars rows={d.by_department.map((x) => ({ label: x.department, value: x.joined, note: `of ${x.target} · ${x.pipeline} in pipeline` }))} />
          )}
        </div>
        <BoardCard title="Company recruiters" rows={d.recruiters} />
        <BoardCard title="Agencies" rows={d.agencies} />
        <div className="card">
          <div className="toolbar"><h2>Agency commercial models</h2><span style={{ flex: 1 }} /><Link className="btn btn-sm" to="/agencies">Manage</Link></div>
          {d.agency_models.length === 0 ? <p className="empty-inline" style={{ padding: '0 16px 16px' }}>No agencies yet.</p> : (
            <div className="table-wrap"><table><tbody>{d.agency_models.map((a) => (
              <tr key={a.agency_id}><td><Link className="row-link" to="/agencies/$id" params={{ id: a.agency_id }}>{a.name}</Link></td><td>{termsText(a.terms)}{a.terms && <div className="cell-sub">Lock-in {a.terms.lockin_days ?? '–'} days · replacement {a.terms.replacement_days ?? '–'} days</div>}</td></tr>
            ))}</tbody></table></div>
          )}
        </div>
        <div className="card">
          <div className="toolbar"><h2>Replacements due</h2><span style={{ flex: 1 }} /><Link className="btn btn-sm" to="/employees">Employees</Link></div>
          {d.replacements_due.length === 0 ? <p className="empty-inline" style={{ padding: '0 16px 16px' }}>Nothing is owed by any agency.</p> : (
            <div className="table-wrap"><table><tbody>{d.replacements_due.map((r) => (
              <tr key={r.id}><td><strong>{r.candidate_name}</strong><div className="cell-sub">{r.job_title} · left {formatDay(r.exit_date)}</div></td><td>{r.agency_name}</td><td><Badge tone="warning">Due {formatDay(r.due_by)}</Badge></td></tr>
            ))}</tbody></table></div>
          )}
        </div>
      </div>
    </>
  );
}

function BoardCard({ title, rows }: { title: string; rows: Board[] }) {
  return (
    <div className="card">
      <div className="toolbar"><h2>{title}</h2><span style={{ flex: 1 }} /><Link className="btn btn-sm" to="/leaderboards">Leaderboards</Link></div>
      {rows.length === 0 ? <p className="empty-inline" style={{ padding: '0 16px 16px' }}>No submissions in this period.</p> : (
        <div className="table-wrap"><table>
          <thead><tr><th>#</th><th>Name</th><th className="num">Valid</th><th className="num">Joined</th><th className="num">Conversion</th></tr></thead>
          <tbody>{rows.map((r) => <tr key={r.owner_id}><td>{r.rank}</td><td><strong>{r.name}</strong></td><td className="num">{r.valid_submissions}</td><td className="num">{r.joined}</td><td className="num">{pctText(r.conversion_pct)}</td></tr>)}</tbody>
        </table></div>
      )}
    </div>
  );
}
