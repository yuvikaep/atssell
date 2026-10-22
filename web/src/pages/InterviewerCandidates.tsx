import { useMutation, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useDeferredValue, useState } from 'react';
import { api, viewFile } from '../api';
import { StatusCounts } from '../components/StatusCounts';
import { Badge, EmptyState, ErrorState, IdTags, Loading, formatDate } from '../components/ui';
import { SIMPLE, statusOf } from './CandidateMaster';

interface Row {
  application_id: string; simple_status: string; sourcing_code: string; temp_employee_code: string | null; created_at: string;
  candidate_id: string; full_name: string; current_title: string | null; city: string | null; total_experience_years: number | null;
  vacancy_id: string; job_title: string; source: string | null; resume_document_id: string | null; my_interview_id: string | null; remark: string | null;
}

/**
 * For an interviewer or department head: every candidate sourced for their jobs (by recruiters or
 * agencies), before or after an interview, with where each stands now. Selected ones show here too.
 */
export function InterviewerCandidatesPage() {
  const [status, setStatus] = useState('');
  const [text, setText] = useState('');
  const q = useDeferredValue(text.trim());
  const list = useQuery({
    queryKey: ['my-job-candidates', status, q],
    queryFn: () => api<{ data: Row[] }>('GET', `/my-job-candidates?${new URLSearchParams({ ...(status ? { status } : {}), ...(q ? { q } : {}) })}`).then((r) => r.data),
  });
  const resume = useMutation({ mutationFn: (id: string) => viewFile(() => api<{ data: { url: string } }>('POST', `/my-job-candidates/${id}/resume-url`).then((x) => x.data.url)) });
  return (
    <>
      <div className="page-header"><div><h1>Job candidates</h1><p>Everyone sourced for your jobs, by recruiters or agencies, and where they stand.</p></div></div>
      <StatusCounts active={status} onPick={setStatus} />
      <div className="card">
        <div className="toolbar">
          <input className="grow" type="search" placeholder="Search by name, sourcing ID or temp ID" aria-label="Search" value={text} onChange={(e) => setText(e.target.value)} />
          <select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All statuses</option>
            {Object.entries(SIMPLE).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
        </div>
        {list.isPending ? <Loading /> : list.isError ? <ErrorState error={list.error} onRetry={() => list.refetch()} /> : list.data.length === 0 ? (
          <EmptyState title="No candidates yet">Candidates sourced for the jobs you interview for appear here.</EmptyState>
        ) : (
          <div className="table-wrap"><table>
            <thead><tr><th>Candidate</th><th>Job</th><th>Status</th><th>Source</th><th>Added</th><th /></tr></thead>
            <tbody>{list.data.map((r) => {
              const st = statusOf(r);
              return (
                <tr key={r.application_id}>
                  <td><strong>{r.full_name}</strong><div className="cell-sub">{[r.current_title, r.city, r.total_experience_years != null ? `${r.total_experience_years} yrs` : null].filter(Boolean).join(' · ')}</div><IdTags sourcing={r.sourcing_code} temp={r.temp_employee_code} /></td>
                  <td>{r.job_title}</td>
                  <td><Badge tone={st.tone}>{st.label}</Badge>{r.remark && <div className="cell-sub decision-remark">“{r.remark}”</div>}</td>
                  <td className="cell-sub">{r.source ?? '—'}</td>
                  <td>{formatDate(r.created_at)}</td>
                  <td className="actions">
                    {r.resume_document_id && <button className="btn btn-sm" disabled={resume.isPending} onClick={() => resume.mutate(r.application_id)}>Resume</button>}
                    {r.my_interview_id && <Link className="btn btn-sm btn-primary" to="/my-interviews/$id" params={{ id: r.my_interview_id }}>My interview</Link>}
                  </td>
                </tr>
              );
            })}</tbody>
          </table></div>
        )}
      </div>
    </>
  );
}
