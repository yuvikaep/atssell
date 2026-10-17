import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../api';
import { pctText } from '../components/Stat';
import { EmptyState, ErrorState, Loading } from '../components/ui';
import { departmentsQuery, vacanciesQuery } from '../queries';
import { termsText } from './HrDashboard';

interface Row {
  rank: number; owner_id: string; name: string; raw_submissions: number; valid_submissions: number; duplicate_attempts: number; interviewed: number; selected: number;
  joined: number; active: number; exited: number; replacements_due: number; replaced: number; replacements_expired: number; conversion_pct: number | null;
  fee_model?: { payment_model: string; fee_type: string; fee_value: number } | null;
}
interface Board { rows: Row[]; range: { from: string; to: string }; definitions: Record<string, string> }

/** Two separate leaderboards, ranked by actual joins. Raw and valid submissions are shown apart on purpose. */
export function LeaderboardsPage() {
  const [kind, setKind] = useState<'recruiters' | 'agencies'>('recruiters');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [department, setDepartment] = useState('');
  const [job, setJob] = useState('');
  const [employment, setEmployment] = useState('');
  const departments = useQuery(departmentsQuery('active'));
  const jobs = useQuery(vacanciesQuery({ status: 'all', q: '', department_id: '', page: 1 }));
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries({ from, to, department_id: department, vacancy_id: job, employment_status: employment })) if (v) params.set(k, v);
  const q = useQuery({ queryKey: ['leaderboard', kind, params.toString()], queryFn: () => api<{ data: Board }>('GET', `/leaderboards/${kind}${params.size ? `?${params}` : ''}`).then((r) => r.data) });
  const agencies = kind === 'agencies';

  return (
    <>
      <div className="page-header"><div><h1>Leaderboards</h1><p>Ranked by actual joins. Submissions are counted twice, as raw and as valid, so duplicates cannot inflate a position.</p></div></div>
      <div className="card">
        <div className="toolbar" role="tablist" aria-label="Leaderboard">
          {(['recruiters', 'agencies'] as const).map((k) => <button key={k} role="tab" aria-selected={kind === k} className={`btn btn-sm ${kind === k ? 'btn-primary' : ''}`} onClick={() => setKind(k)}>{k === 'recruiters' ? 'Company recruiters' : 'Agencies'}</button>)}
        </div>
        <div className="filters">
          <label>From<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
          <label>To<input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
          <label>Department<select value={department} onChange={(e) => setDepartment(e.target.value)}><option value="">All</option>{(departments.data ?? []).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label>
          <label>Job<select value={job} onChange={(e) => setJob(e.target.value)}><option value="">All</option>{((jobs.data as { data: { id: string; title: string }[] } | undefined)?.data ?? []).map((j) => <option key={j.id} value={j.id}>{j.title}</option>)}</select></label>
          <label>Employment<select value={employment} onChange={(e) => setEmployment(e.target.value)}><option value="">Any</option><option value="active">Active</option><option value="exited">Exited</option></select></label>
          <button className="btn btn-sm" onClick={() => { setFrom(''); setTo(''); setDepartment(''); setJob(''); setEmployment(''); }}>Clear</button>
        </div>
        {q.isPending ? <Loading /> : q.isError ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : q.data.rows.length === 0 ? (
          <EmptyState title="Nothing to rank yet">No submissions in {q.data.range.from} to {q.data.range.to} with these filters.</EmptyState>
        ) : (
          <div className="table-wrap"><table className="board-table">
            <thead><tr>
              <th>#</th><th>{agencies ? 'Agency' : 'Recruiter'}</th><th className="num" title={q.data.definitions.raw_submissions}>Raw</th><th className="num" title={q.data.definitions.valid_submissions}>Valid</th>
              <th className="num">Interviewed</th><th className="num">Selected</th><th className="num">Joined</th><th className="num">Active</th><th className="num">Exits</th>
              {agencies && <th className="num">Replacements</th>}<th className="num" title={q.data.definitions.conversion_pct}>Conversion</th>{agencies && <th>Fee model</th>}
            </tr></thead>
            <tbody>{q.data.rows.map((r) => (
              <tr key={r.owner_id}>
                <td><strong>{r.rank}</strong></td><td><strong>{r.name}</strong></td>
                <td className="num">{r.raw_submissions}{r.duplicate_attempts > 0 && <span className="cell-sub"> ({r.duplicate_attempts} duplicate)</span>}</td>
                <td className="num">{r.valid_submissions}</td><td className="num">{r.interviewed}</td><td className="num">{r.selected}</td><td className="num"><strong>{r.joined}</strong></td>
                <td className="num">{r.active}</td><td className="num">{r.exited}</td>
                {agencies && <td className="num">{r.replacements_due} due · {r.replaced} done{r.replacements_expired ? ` · ${r.replacements_expired} missed` : ''}</td>}
                <td className="num">{pctText(r.conversion_pct)}</td>
                {agencies && <td>{termsText(r.fee_model ? { ...r.fee_model } : null)}</td>}
              </tr>
            ))}</tbody>
          </table></div>
        )}
        {q.data && <p className="metric-def" style={{ padding: '12px 16px' }}>{q.data.definitions.ranking} Period: {q.data.range.from} to {q.data.range.to}.</p>}
      </div>
    </>
  );
}
