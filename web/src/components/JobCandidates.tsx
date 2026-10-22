import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { api } from '../api';
import { statusOf, SIMPLE } from '../pages/CandidateMaster';
import { StatusCounts } from './StatusCounts';
import { Badge, EmptyState, ErrorState, IdTags, Loading, formatDate } from './ui';

interface JobRow {
  id: string; full_name: string; current_title: string | null; city: string | null; simple_status: string | null;
  sourcing_code: string | null; temp_employee_code: string | null; source: string | null; avg_rating: number | null; decision_reason: string | null; created_at: string;
}
interface Summary { job: { openings: number; filled: number; all_filled: boolean; tat_days: number } | null; selected: number }

/**
 * A job's candidates, read-only: the status comes from the interviewers' decisions and joining, so
 * nobody moves cards here. Counts on top, then openings filled and the time taken to fill them (TAT).
 */
export function JobCandidates({ vacancyId, canAdd }: { vacancyId: string; canAdd: boolean }) {
  const [status, setStatus] = useState('');
  const summary = useQuery({ queryKey: ['status-summary', vacancyId], queryFn: () => api<{ data: Summary }>('GET', `/status-summary?vacancy_id=${vacancyId}`).then((r) => r.data) });
  const params = new URLSearchParams({ vacancy_id: vacancyId, page_size: '200', sort: 'added', dir: 'desc', ...(status ? { status } : {}) });
  const list = useQuery({ queryKey: ['master', params.toString()], queryFn: () => api<{ data: JobRow[] }>('GET', `/candidate-master?${params}`).then((r) => r.data) });
  const job = summary.data?.job;

  return (
    <div className="section">
      {job && (
        <div className="stats" style={{ marginBottom: 12 }}>
          <div className="card stat"><div className="label">Openings</div><div className="value">{job.openings}</div></div>
          <div className="card stat"><div className="label">Joined</div><div className="value">{job.filled} / {job.openings}</div></div>
          <div className="card stat"><div className="label">Yet to join</div><div className="value">{summary.data?.selected ?? 0}</div></div>
          <div className="card stat"><div className="label">{job.all_filled ? 'TAT to close all openings' : 'Open for'}</div><div className="value">{job.tat_days} {job.tat_days === 1 ? 'day' : 'days'}</div>{!job.all_filled && <div className="foot">{job.openings - job.filled} still to fill</div>}</div>
        </div>
      )}
      <StatusCounts vacancyId={vacancyId} active={status} onPick={setStatus} />
      <div className="title-row" style={{ marginBottom: 8 }}>
        <select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All statuses</option>
          {Object.entries(SIMPLE).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
        </select>
        {canAdd && <Link className="btn btn-primary" to="/sourcing" search={{ job: vacancyId }}>Add candidate</Link>}
      </div>
      {list.isPending ? <Loading /> : list.isError ? <ErrorState error={list.error} onRetry={() => list.refetch()} /> : list.data.length === 0 ? (
        <EmptyState title="No candidates">{status ? 'Nobody with this status.' : 'Source candidates for this job to see them here.'}</EmptyState>
      ) : (
        <div className="table-wrap"><table>
          <thead><tr><th>Candidate</th><th>Status</th><th>Feedback</th><th>Source</th><th>Added</th></tr></thead>
          <tbody>{list.data.map((r) => {
            const st = statusOf(r);
            return (
              <tr key={r.id}>
                <td><Link className="row-link" to="/candidates/$id" params={{ id: r.id }} search={{}}>{r.full_name}</Link><div className="cell-sub">{[r.current_title, r.city].filter(Boolean).join(' · ')}</div><IdTags sourcing={r.sourcing_code} temp={r.temp_employee_code} /></td>
                <td><Badge tone={st.tone}>{st.label}</Badge></td>
                <td>{r.avg_rating !== null ? <strong>{r.avg_rating.toFixed(1)}<small className="muted">/5</small></strong> : <span className="muted">—</span>}{r.decision_reason && <div className="cell-sub decision-remark">“{r.decision_reason}”</div>}</td>
                <td className="cell-sub">{r.source ?? '—'}</td>
                <td>{formatDate(r.created_at)}</td>
              </tr>
            );
          })}</tbody>
        </table></div>
      )}
    </div>
  );
}
