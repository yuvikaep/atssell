import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useDeferredValue, useState } from 'react';
import { Link, useSearch } from '@tanstack/react-router';
import { api, formatInZone, RECOMMENDATION_LABEL, type CandidateStatusRow, type Recommendation } from '../api';
import { ScheduleDialog } from '../components/ScheduleDialog';
import { SetTimeDialog } from '../components/SetTimeDialog';
import { Badge, Dialog, IdTags, EmptyState, ErrorState, Field, FormError, Loading } from '../components/ui';
import { candidateStatusQuery, hiringHomeQuery, jobRolesQuery } from '../queries';

/** One list, one status per candidate, and what the interviewers said. Each row can be opened, edited, sourced for another job, or booked. */
export function CandidateStatusPage() {
  const search = useSearch({ strict: false }) as { job?: string };
  const [job, setJob] = useState(search.job ?? '');
  const [text, setText] = useState('');
  const [selected, setSelected] = useState('');
  const [jobRole, setJobRole] = useState('');
  const roles = useQuery(jobRolesQuery(undefined, 'all'));
  const q = useDeferredValue(text.trim());
  const jobs = useQuery(hiringHomeQuery);
  const list = useQuery(candidateStatusQuery(job, q, selected, jobRole));
  const queryClient = useQueryClient();
  const [booking, setBooking] = useState<CandidateStatusRow | null>(null);
  const [another, setAnother] = useState<CandidateStatusRow | null>(null);
  const refresh = () => Promise.all(['candidate-status', 'interviews', 'tasks', 'hiring-home'].map((k) => queryClient.invalidateQueries({ queryKey: [k] })));

  return (
    <>
      <div className="page-header"><div><h1>Candidate status</h1><p>Where each candidate stands, and what the interviewers said.</p></div></div>
      <div className="card">
        <div className="toolbar">
          <input className="grow" type="search" placeholder="Search by name, sourcing ID or temp ID" aria-label="Search candidates" value={text} onChange={(e) => setText(e.target.value)} />
          <select aria-label="Job" value={job} onChange={(e) => setJob(e.target.value)}>
            <option value="">All my jobs</option>
            {(jobs.data?.vacancies ?? []).map((v) => <option key={v.id} value={v.id}>{v.title}</option>)}
          </select>
          <select aria-label="Job role" value={jobRole} onChange={(e) => setJobRole(e.target.value)}>
            <option value="">All roles</option>
            {(roles.data ?? []).map((r) => <option key={r.id} value={r.id}>{r.name} ({r.department_name})</option>)}
          </select>
          <select aria-label="Selected" value={selected} onChange={(e) => setSelected(e.target.value)}>
            <option value="">Everyone</option>
            <option value="yes">Selected (has temp ID)</option>
            <option value="no">Not selected yet</option>
          </select>
        </div>
        {list.isPending ? <Loading /> : list.isError ? <ErrorState error={list.error} onRetry={() => list.refetch()} /> : list.data.length === 0 ? (
          <EmptyState title="No candidates yet">Use Sourcing to add candidates to one of your jobs.</EmptyState>
        ) : (
          <div className="table-wrap"><table className="status-table">
            <thead><tr><th>Candidate</th><th>Job</th><th>Status</th><th>Feedback</th><th /></tr></thead>
            <tbody>{list.data.map((r) => (
              <tr key={r.application_id}>
                <td><strong>{r.candidate_name}</strong>{r.headline && <div className="cell-sub">{r.headline}</div>}<IdTags sourcing={r.sourcing_code} temp={r.temp_employee_code} /></td>
                <td>{r.vacancy_title}{r.job_role_name && <div className="cell-sub">Role: {r.job_role_name}</div>}</td>
                <td>
                  <Badge tone={r.tone}>{r.label}</Badge>
                  {r.scheduled_start ? <div className="cell-sub">{formatInZone(r.scheduled_start, 'Asia/Kolkata')}</div> : r.detail && <div className="cell-sub">{r.detail}</div>}
                </td>
                <td><Feedback r={r} /></td>
                <td className="actions">
                  {r.action && <button className="btn btn-sm btn-primary" onClick={() => setBooking(r)}>{r.action.kind === 'set_time' ? 'Set interview time' : 'Schedule interview'}</button>}
                  <Link className="btn btn-sm" to="/candidates/$id" params={{ id: r.candidate_id }} search={{}}>View</Link>
                  <Link className="btn btn-sm" to="/candidates/$id" params={{ id: r.candidate_id }} search={{ edit: '1' }}>Edit</Link>
                  <button className="btn btn-sm" onClick={() => setAnother(r)}>Another job</button>
                </td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </div>
      {another && <AnotherJobDialog row={another} jobs={(jobs.data?.vacancies ?? []).filter((v) => v.id !== another.vacancy_id)} onClose={() => { setAnother(null); refresh(); }} />}
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

/** Source the same person for one more of the recruiter's jobs; the profile is reused, not copied. */
function AnotherJobDialog({ row, jobs, onClose }: { row: CandidateStatusRow; jobs: { id: string; title: string; department_id: string }[]; onClose: () => void }) {
  const [jobId, setJobId] = useState('');
  const [jobRoleId, setJobRoleId] = useState('');
  const deptId = jobs.find((j) => j.id === jobId)?.department_id;
  const roles = useQuery({ ...jobRolesQuery(deptId), enabled: !!deptId });
  const add = useMutation({
    mutationFn: () => api('POST', '/applications', { candidate_id: row.candidate_id, vacancy_id: jobId, source_type: 'internal_recruiter', job_role_id: jobRoleId || null }),
  });
  return (
    <Dialog open title={`Source ${row.candidate_name} for another job`} onClose={onClose}
      footer={add.isSuccess
        ? <button className="btn btn-primary" type="button" onClick={onClose}>Done</button>
        : <>
            <button className="btn" type="button" onClick={onClose}>Cancel</button>
            <button className="btn btn-primary" type="button" disabled={!jobId || (!!roles.data?.length && !jobRoleId) || add.isPending} onClick={() => add.mutate()}>{add.isPending ? 'Adding…' : 'Add to this job'}</button>
          </>}>
      {add.isSuccess ? (
        <div className="alert alert-success" role="status">{row.candidate_name} was added to {jobs.find((j) => j.id === jobId)?.title}.</div>
      ) : jobs.length === 0 ? (
        <p className="muted">You have no other jobs to source for.</p>
      ) : (
        <>
          <FormError error={add.error} />
          <Field id="another-job" label="Job">
            <select id="another-job" value={jobId} onChange={(e) => { setJobId(e.target.value); setJobRoleId(''); }}>
              <option value="">Choose a job</option>
              {jobs.map((j) => <option key={j.id} value={j.id}>{j.title}</option>)}
            </select>
          </Field>
          {!!roles.data?.length && (
            <Field id="another-role" label="Job role">
              <select id="another-role" value={jobRoleId} onChange={(e) => setJobRoleId(e.target.value)}>
                <option value="">Choose the role</option>
                {roles.data.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
            </Field>
          )}
        </>
      )}
    </Dialog>
  );
}
