import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useDeferredValue, useState } from 'react';
import { useSearch } from '@tanstack/react-router';
import { formatInZone, RECOMMENDATION_LABEL, type CandidateStatusRow, type Recommendation } from '../api';
import { ScheduleDialog } from '../components/ScheduleDialog';
import { SetTimeDialog } from '../components/SetTimeDialog';
import { Badge, EmptyState, ErrorState, Loading } from '../components/ui';
import { candidateStatusQuery, hiringHomeQuery } from '../queries';

/** One list, one status per candidate, and what the interviewers said. The only action is booking the interview. */
export function CandidateStatusPage() {
  const search = useSearch({ strict: false }) as { job?: string };
  const [job, setJob] = useState(search.job ?? '');
  const [text, setText] = useState('');
  const q = useDeferredValue(text.trim());
  const jobs = useQuery(hiringHomeQuery);
  const list = useQuery(candidateStatusQuery(job, q));
  const queryClient = useQueryClient();
  const [booking, setBooking] = useState<CandidateStatusRow | null>(null);
  const refresh = () => Promise.all(['candidate-status', 'interviews', 'tasks', 'hiring-home'].map((k) => queryClient.invalidateQueries({ queryKey: [k] })));

  return (
    <>
      <div className="page-header"><div><h1>Candidate status</h1><p>Where each candidate stands, and what the interviewers said.</p></div></div>
      <div className="card">
        <div className="toolbar">
          <input className="grow" type="search" placeholder="Search by name" aria-label="Search candidates" value={text} onChange={(e) => setText(e.target.value)} />
          <select aria-label="Job" value={job} onChange={(e) => setJob(e.target.value)}>
            <option value="">All my jobs</option>
            {(jobs.data?.vacancies ?? []).map((v) => <option key={v.id} value={v.id}>{v.title}</option>)}
          </select>
        </div>
        {list.isPending ? <Loading /> : list.isError ? <ErrorState error={list.error} onRetry={() => list.refetch()} /> : list.data.length === 0 ? (
          <EmptyState title="No candidates yet">Use Sourcing to add candidates to one of your jobs.</EmptyState>
        ) : (
          <div className="table-wrap"><table className="status-table">
            <thead><tr><th>Candidate</th><th>Job</th><th>Status</th><th>Feedback</th><th /></tr></thead>
            <tbody>{list.data.map((r) => (
              <tr key={r.application_id}>
                <td><strong>{r.candidate_name}</strong>{r.headline && <div className="cell-sub">{r.headline}</div>}</td>
                <td>{r.vacancy_title}</td>
                <td>
                  <Badge tone={r.tone}>{r.label}</Badge>
                  {r.scheduled_start ? <div className="cell-sub">{formatInZone(r.scheduled_start, 'Asia/Kolkata')}</div> : r.detail && <div className="cell-sub">{r.detail}</div>}
                </td>
                <td><Feedback r={r} /></td>
                <td className="actions">
                  {r.action && <button className="btn btn-sm btn-primary" onClick={() => setBooking(r)}>{r.action.kind === 'set_time' ? 'Set interview time' : 'Schedule interview'}</button>}
                </td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </div>
      {booking?.action?.kind === 'schedule' && <ScheduleDialog applicationId={booking.application_id} vacancyId={booking.vacancy_id} onClose={() => { setBooking(null); refresh(); }} />}
      {booking?.action?.kind === 'set_time' && <SetTimeDialog interviewId={booking.action.interview_id} onClose={() => { setBooking(null); refresh(); }} />}
    </>
  );
}

function Feedback({ r }: { r: CandidateStatusRow }) {
  if (!r.feedback && !r.remark) return <span className="muted">—</span>;
  const counts = (r.feedback?.recommendations ?? []).reduce<Record<string, number>>((m, x) => ({ ...m, [x]: (m[x] ?? 0) + 1 }), {});
  return (
    <div className="fb-cell">
      {r.feedback && (
        <div className="hm-feedback">
          <span className="hm-score">{r.feedback.avg_rating.toFixed(1)}<small>/5</small></span>
          {Object.entries(counts).map(([k, n]) => <span key={k} className={`hm-chip hm-rec-${k}`}>{n > 1 ? `${n}× ` : ''}{RECOMMENDATION_LABEL[k as Recommendation] ?? k}</span>)}
        </div>
      )}
      {r.remark && <div className="decision-remark">“{r.remark}”</div>}
    </div>
  );
}
