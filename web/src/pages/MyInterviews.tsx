import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { StatusCounts } from '../components/StatusCounts';
import { api, ApiError, type MyInterviewDetail, formatInZone, INTERVIEW_STATUS_LABEL, MODE_LABEL, RECOMMENDATION_LABEL, type MyInterviewRow, viewFile } from '../api';
import { FeedbackForm, type FeedbackValues } from '../components/FeedbackForm';
import { RemarkBanner } from '../components/RemarkBanner';
import { NextRoundDialog } from '../components/NextRoundDialog';
import { BackLink, Badge, EmptyState, ErrorState, fieldError, formatDate, Loading } from '../components/ui';
import { myInterviewQuery, myInterviewsQuery } from '../queries';
import { STATUS_TONE } from './InterviewDetail';

function Section({ title, rows, empty }: { title: string; rows: MyInterviewRow[]; empty: string }) {
  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="toolbar"><h2>{title}</h2><span className="muted">{rows.length}</span></div>
      {rows.length === 0 ? <p className="empty-inline" style={{ padding: '4px 16px 16px' }}>{empty}</p> : (
        <div className="table-wrap">
          <table>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>
                    <Link className="row-link" to="/my-interviews/$id" params={{ id: r.id }}>{r.candidate_name}</Link>
                    <div className="cell-sub">{r.vacancy_title} · {r.round_name}</div>
                  </td>
                  <td>{r.scheduled_start ? formatInZone(r.scheduled_start, r.timezone) : <span className="muted">Time to be decided</span>}<div className="cell-sub">{MODE_LABEL[r.mode]}</div></td>
                  <td><Badge tone={STATUS_TONE[r.status]}>{INTERVIEW_STATUS_LABEL[r.status]}</Badge></td>
                  <td>
                    {r.feedback_status === 'submitted' ? <Badge tone="success">Feedback sent</Badge>
                      : r.feedback_status === 'waived' ? <Badge tone="muted">Not needed</Badge>
                      : r.overdue ? <Badge tone="danger">Feedback overdue</Badge>
                      : r.can_submit ? <Badge tone="warning">Feedback due</Badge> : null}
                  </td>
                  <td className="actions">{r.can_submit && <Link className="btn btn-sm btn-primary" to="/my-interviews/$id" params={{ id: r.id }}>Give feedback</Link>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function MyInterviewsPage() {
  const list = useQuery(myInterviewsQuery);
  if (list.isPending) return <Loading />;
  if (list.isError) return <ErrorState error={list.error} onRetry={() => list.refetch()} />;
  const rows = list.data;
  const owing = rows.filter((r) => r.can_submit && r.scheduled_end && new Date(r.scheduled_end) <= new Date());
  const owingIds = new Set(owing.map((r) => r.id));
  const upcoming = rows.filter((r) => !owingIds.has(r.id) && ['scheduled', 'confirmed'].includes(r.status) && (!r.scheduled_end || new Date(r.scheduled_end) > new Date()));
  const rest = rows.filter((r) => !owingIds.has(r.id) && !upcoming.includes(r));
  return (
    <>
      <div className="page-header">
        <div>
          <h1>My interviews</h1>
          <p>Interviews you are on the panel for, and the feedback you owe.</p>
        </div>
      </div>
      <StatusCounts />
      {rows.length === 0 ? <div className="card"><EmptyState title="No interviews yet">When you are added to an interview panel it appears here.</EmptyState></div> : (
        <>
          <Section title="Feedback to give" rows={owing} empty="Nothing waiting on you." />
          <Section title="Upcoming" rows={upcoming} empty="No upcoming interviews." />
          <Section title="Earlier" rows={rest} empty="Nothing earlier." />
        </>
      )}
    </>
  );
}

export function MyInterviewDetailPage() {
  const { id } = useParams({ from: '/app/my-interviews/$id' });
  const query = useQuery(myInterviewQuery(id));
  const queryClient = useQueryClient();
  const submit = useMutation({
    mutationFn: (v: FeedbackValues) => api('POST', `/me/interviews/${id}/feedback`, v),
    onSuccess: async () => {
      await Promise.all(['my-interview', 'my-interviews', 'unread-count'].map((k) => queryClient.invalidateQueries({ queryKey: [k] })));
    },
  });

  if (query.isPending) return <Loading />;
  if (query.isError) {
    return query.error instanceof ApiError && query.error.status === 404
      ? <div className="state"><h2>Interview not found</h2><p>You are not on this interview's panel.</p></div>
      : <ErrorState error={query.error} onRetry={() => query.refetch()} />;
  }
  const d = query.data;
  return (
    <>
      <BackLink to="/my-interviews">My interviews</BackLink>
      <div className="page-header">
        <div>
          <div className="title-row"><h1>{d.candidate.full_name}</h1><Badge tone={STATUS_TONE[d.status]}>{INTERVIEW_STATUS_LABEL[d.status]}</Badge>{d.has_resume ? <ViewResume interviewId={d.id} /> : <span className="muted">No resume uploaded</span>}</div>
          <p>{d.job.title} · {d.interview.round_name} · {formatInZone(d.interview.scheduled_start, d.interview.timezone)}</p>
        </div>
      </div>
      <RemarkBanner request={d.request} />
      <div className="detail-layout">
        <div className="card">
          <div className="section">
            {d.my_feedback ? (
              <>
                <h2>Your feedback</h2>
                <div className="alert alert-success" role="status">Sent {formatDate(d.my_feedback.submitted_at)}. If something needs changing, ask the recruiter.</div>
                <p>Overall <strong>{d.my_feedback.overall_rating} of 5</strong> · {RECOMMENDATION_LABEL[d.my_feedback.recommendation]}</p>
                {d.my_feedback.notes && <p className="prose">{d.my_feedback.notes}</p>}
                <YourDecision d={d} />
              </>
            ) : !d.can_submit ? (
              <p className="empty-inline">Feedback is not expected for this interview.</p>
            ) : submit.isSuccess ? (
              <div className="alert alert-success" role="status">Thank you. Your feedback has been sent.</div>
            ) : (
              <>
                <h2>Give feedback</h2>
                <FeedbackForm scorecard={d.scorecard} modes={d.modes} defaultMode={d.interview.mode} submitting={submit.isPending} error={submit.error} onSubmit={(v) => submit.mutate(v)} />
              </>
            )}
          </div>
        </div>
        <div className="stack">
          <div className="card">
            <div className="section">
              <h2>Candidate</h2>
              <p style={{ margin: '0 0 6px' }}>{[d.candidate.current_title, d.candidate.total_experience_years != null ? `${d.candidate.total_experience_years} years` : null, d.candidate.city].filter(Boolean).join(' · ')}</p>
              {d.candidate.skills.length > 0 && <p>{d.candidate.skills.map((t) => <span key={t} className="tag">{t}</span>)}</p>}
              {d.candidate.summary && <p className="prose" style={{ fontSize: 13 }}>{d.candidate.summary}</p>}
            </div>
          </div>
          <div className="card">
            <div className="section">
              <h2>Role</h2>
              <p style={{ margin: '0 0 6px' }}><strong>{d.job.title}</strong> · {d.job.location}</p>
              <p className="prose" style={{ fontSize: 13 }}>{d.job.description}</p>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

const DECISION_LABEL: Record<string, string> = { select: 'Selected', hold: 'On hold', reject: 'Rejected', additional_round: 'Sent to next round', advance: 'Moved forward' };

/** After their feedback, the interviewer decides: select, hold, reject, or send to the next round. No admin confirmation. */
function YourDecision({ d }: { d: MyInterviewDetail }) {
  const queryClient = useQueryClient();
  const [asking, setAsking] = useState<null | 'hold' | 'reject'>(null);
  const [reason, setReason] = useState('');
  const [nextRound, setNextRound] = useState(false);
  const refresh = () => Promise.all(['my-interview', 'my-interviews', 'candidate-status', 'hiring-home'].map((k) => queryClient.invalidateQueries({ queryKey: [k] })));
  const decide = useMutation({
    mutationFn: (decision: string) => api('POST', `/applications/${d.application_id}/decisions`, { decision, ...(reason.trim() ? { reason: reason.trim() } : {}) }),
    onSuccess: async () => { setAsking(null); setReason(''); await refresh(); },
  });
  return (
    <div className="section" style={{ paddingLeft: 0, paddingRight: 0 }}>
      <h2>Your decision</h2>
      {d.last_decision && (
        <p>Current: <strong>{DECISION_LABEL[d.last_decision.decision] ?? d.last_decision.decision}</strong>{d.last_decision.reason ? ` · “${d.last_decision.reason}”` : ''}</p>
      )}
      {!d.can_decide ? <p className="muted">This candidate's application is closed.</p> : asking ? (
        <div className="actions-row">
          <input aria-label="Reason" autoFocus placeholder={asking === 'hold' ? 'Why on hold? (short note)' : 'Why rejected? (short note)'} value={reason} onChange={(e) => setReason(e.target.value)} style={{ flex: 1, minWidth: 200 }} />
          <button className="btn btn-primary" disabled={decide.isPending || !reason.trim()} onClick={() => decide.mutate(asking)}>Confirm</button>
          <button className="btn" onClick={() => { setAsking(null); setReason(''); }}>Cancel</button>
        </div>
      ) : (
        <div className="actions-row">
          <button className="btn btn-primary" disabled={decide.isPending} onClick={() => decide.mutate('select')}>Select</button>
          <button className="btn" onClick={() => setNextRound(true)}>Next round</button>
          <button className="btn" onClick={() => setAsking('hold')}>Hold</button>
          <button className="btn btn-danger" onClick={() => setAsking('reject')}>Reject</button>
        </div>
      )}
      {decide.error && <p className="field-error">{fieldError(decide.error, 'reason') ?? (decide.error as Error).message}</p>}
      {nextRound && <NextRoundDialog applicationId={d.application_id} candidateName={d.candidate.full_name} onClose={() => { setNextRound(false); refresh(); }} />}
    </div>
  );
}

/** The candidate's latest resume for this interviewer (a short-lived signed link). */
function ViewResume({ interviewId }: { interviewId: string }) {
  const open = useMutation({
    mutationFn: () => viewFile(() => api<{ data: { url: string } }>('POST', `/me/interviews/${interviewId}/resume-url`).then((x) => x.data.url)),
  });
  return <button className="btn btn-sm" disabled={open.isPending} onClick={() => open.mutate()}>{open.isPending ? 'Opening…' : 'View resume'}</button>;
}
