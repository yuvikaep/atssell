import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { useState } from 'react';
import {
  api, ApiError, DECISION_LABEL, formatInZone, INTERVIEW_STATUS_LABEL, MODE_LABEL, RECOMMENDATION_LABEL,
  type FeedbackItem, type InterviewDetail, type InterviewStatus, type PanelMember, type Recommendation,
} from '../api';
import { RemarkBanner } from '../components/RemarkBanner';
import { RatingInput } from '../components/FeedbackForm';
import { PanelPicker, ScheduleDialog, type PanelDraft } from '../components/ScheduleDialog';
import { BackLink, Badge, Dialog, ErrorState, Field, fieldError, FormError, formatDate, Loading, type Tone } from '../components/ui';
import { applicationFeedbackQuery, decisionsQuery, interviewFeedbackQuery, interviewQuery } from '../queries';

export const STATUS_TONE: Record<InterviewStatus, Tone> = { draft: 'muted', scheduled: 'info', confirmed: 'success', completed: 'success', cancelled: 'danger', no_show: 'warning' };

const EVENT_LABEL: Record<string, string> = {
  next_round_requested: 'Sent to next round',
  created: 'Interview created', scheduled: 'Scheduled', rescheduled: 'Rescheduled', updated: 'Details changed', confirmed: 'Confirmed',
  completed: 'Marked completed', cancelled: 'Cancelled', no_show: 'Marked as a no-show', panel_added: 'Interviewer added', panel_removed: 'Interviewer removed',
  feedback_waived: 'Feedback waived', link_issued: 'Feedback link issued', link_regenerated: 'Feedback link replaced', link_revoked: 'Feedback link withdrawn',
  feedback_submitted: 'Feedback submitted', feedback_corrected: 'Feedback corrected',
};

function feedbackBadge(m: PanelMember) {
  if (m.feedback_status === 'submitted') return <Badge tone="success">Submitted</Badge>;
  if (m.feedback_status === 'waived') return <Badge tone="muted">Waived</Badge>;
  return m.overdue ? <Badge tone="danger">Overdue</Badge> : <Badge tone="warning">Pending</Badge>;
}

function linkText(m: PanelMember) {
  if (!m.link) return <span className="muted">No link sent</span>;
  const opened = m.link.open_count ? ` · opened ${m.link.open_count}×` : ' · not opened';
  const label = { active: 'Active', expired: 'Expired', consumed: 'Used', revoked: 'Withdrawn' }[m.link.state];
  return <span>{label}{m.link.state === 'active' ? opened : ''}<div className="cell-sub">{m.link.state === 'active' ? `until ${formatDate(m.link.expires_at)}` : ''}</div></span>;
}

export function InterviewDetailPage() {
  const { id } = useParams({ from: '/app/interviews/$id' });
  const query = useQuery(interviewQuery(id));
  const [dialog, setDialog] = useState<'edit' | 'cancel' | 'noshow' | 'addPanel' | null>(null);
  const [linkFor, setLinkFor] = useState<PanelMember | null>(null);
  const queryClient = useQueryClient();
  const refresh = () => Promise.all(['interview', 'interview-feedback', 'interviews', 'application-feedback'].map((k) => queryClient.invalidateQueries({ queryKey: [k] })));
  const action = useMutation({
    mutationFn: ({ path, body }: { path: string; body?: object }) => api('POST', `/interviews/${id}/${path}`, body),
    onSuccess: refresh,
  });
  const revoke = useMutation({ mutationFn: (linkId: string) => api('POST', `/feedback-links/${linkId}/revoke`), onSuccess: refresh });
  const removePanelist = useMutation({ mutationFn: (mid: string) => api('DELETE', `/interviews/${id}/interviewers/${mid}`), onSuccess: refresh });
  const feedback = useQuery(interviewFeedbackQuery(id, !!query.data?.can.view_feedback));

  if (query.isPending) return <Loading />;
  if (query.isError) {
    return query.error instanceof ApiError && query.error.status === 404
      ? <div className="state"><h2>Interview not found</h2><p>It may not exist, or you may not have access to it.</p></div>
      : <ErrorState error={query.error} onRetry={() => query.refetch()} />;
  }
  const iv = query.data;
  const open = iv.status === 'draft' || iv.status === 'scheduled' || iv.status === 'confirmed';
  const live = open || iv.status === 'completed';

  return (
    <>
      <BackLink to="/interviews">Interviews</BackLink>
      <RemarkBanner request={iv.request} />
      <div className="page-header">
        <div>
          <div className="title-row"><h1>{iv.round_name}</h1><Badge tone={STATUS_TONE[iv.status]}>{INTERVIEW_STATUS_LABEL[iv.status]}</Badge></div>
          <p>
            <Link to="/candidates/$id" params={{ id: iv.candidate.id }}>{iv.candidate.full_name}</Link> · <Link to="/vacancies/$id" params={{ id: iv.vacancy.id }}>{iv.vacancy.title}</Link> ({iv.vacancy.code})
          </p>
        </div>
        {iv.can.manage && (
          <div className="actions-row">
            {open && <button className="btn" onClick={() => setDialog('edit')}>{iv.status === 'draft' ? 'Set time' : 'Reschedule or edit'}</button>}
            {iv.status === 'scheduled' && <button className="btn" onClick={() => action.mutate({ path: 'confirm' })} disabled={action.isPending}>Confirm</button>}
            {(iv.status === 'scheduled' || iv.status === 'confirmed') && <button className="btn btn-primary" onClick={() => action.mutate({ path: 'complete' })} disabled={action.isPending}>Mark completed</button>}
            {(iv.status === 'scheduled' || iv.status === 'confirmed') && <button className="btn" onClick={() => setDialog('noshow')}>No-show</button>}
            {open && <button className="btn btn-danger" onClick={() => setDialog('cancel')}>Cancel</button>}
          </div>
        )}
      </div>
      {iv.status === 'cancelled' && <div className="alert alert-error" role="status">Cancelled: {iv.cancelled_reason}</div>}
      <FormError error={action.error ?? revoke.error ?? removePanelist.error} />

      <div className="detail-layout">
        <div className="stack">
          <div className="card">
            <div className="section">
              <h2>Schedule</h2>
              <dl className="detail-grid">
                <div><dt>When</dt><dd>{iv.scheduled_start ? formatInZone(iv.scheduled_start, iv.timezone) : 'Time to be decided'}</dd></div>
                <div><dt>Until</dt><dd>{iv.scheduled_end ? formatInZone(iv.scheduled_end, iv.timezone, { timeOnly: true }) : '—'}</dd></div>
                <div><dt>Time zone</dt><dd>{iv.timezone}</dd></div>
                <div><dt>Type</dt><dd>{MODE_LABEL[iv.mode]}</dd></div>
                <div><dt>Meeting link</dt><dd>{iv.meeting_url ? <a href={iv.meeting_url} target="_blank" rel="noreferrer noopener">Open</a> : '—'}</dd></div>
                <div><dt>Location or notes</dt><dd>{iv.location_instructions ?? '—'}</dd></div>
                <div><dt>Feedback due</dt><dd>{iv.feedback_due_at ? formatDate(iv.feedback_due_at) : '—'}</dd></div>
                <div><dt>Set up by</dt><dd>{iv.created_by_name ?? '—'}</dd></div>
              </dl>
            </div>
          </div>

          <div className="card">
            <div className="section">
              <h2>Panel and feedback {iv.can.manage && iv.status !== 'cancelled' && iv.status !== 'no_show' && <button className="btn btn-sm" onClick={() => setDialog('addPanel')}>Add interviewer</button>}</h2>
              {iv.panel.length === 0 ? <p className="empty-inline">No interviewers yet.</p> : (
                <div className="table-wrap">
                  <table>
                    <thead><tr><th>Interviewer</th><th>Feedback</th><th>Link</th><th /></tr></thead>
                    <tbody>
                      {iv.panel.map((m) => (
                        <tr key={m.id}>
                          <td><strong>{m.name}</strong>{m.external && <> <Badge tone="info">External</Badge></>}<div className="cell-sub">{m.email}</div></td>
                          <td>{feedbackBadge(m)}</td>
                          <td>{linkText(m)}</td>
                          <td><div className="actions-row" style={{ justifyContent: 'flex-end', minWidth: 130 }}>
                            {iv.can.links && m.feedback_status === 'pending' && live && (
                              <button className="btn btn-sm" onClick={() => setLinkFor(m)}>{m.link ? 'Send a new link' : 'Send link'}</button>
                            )}
                            {iv.can.links && m.link?.state === 'active' && <button className="btn btn-sm btn-danger" disabled={revoke.isPending} onClick={() => revoke.mutate(m.link!.id)}>Withdraw</button>}
                            {iv.can.manage && m.feedback_status !== 'submitted' && live && <button className="btn btn-sm" disabled={removePanelist.isPending} onClick={() => removePanelist.mutate(m.id)}>Remove</button>}
                          </div></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>

          {iv.can.view_feedback && <FeedbackSection iv={iv} items={feedback.data} loading={feedback.isPending} onChanged={refresh} />}
          {iv.can.decide && <DecisionSection iv={iv} />}
        </div>

        <div className="stack">
          <div className="card">
            <div className="section">
              <h2>Scorecard</h2>
              {iv.template.competencies.length === 0 ? <p className="empty-inline">Overall rating and recommendation only.</p> : (
                <ul className="review-list">{iv.template.competencies.map((c) => <li key={c.code}><span>{c.label}</span><span className="muted">{c.required ? 'Required' : 'Optional'}</span></li>)}</ul>
              )}
            </div>
          </div>
          <div className="card">
            <div className="section">
              <h2>Activity</h2>
              <ul className="timeline">
                {iv.events.map((e) => (
                  <li key={e.id}>
                    <strong>{EVENT_LABEL[e.event_type] ?? e.event_type}</strong>
                    {e.reason && <div className="cell-sub">“{e.reason}”</div>}
                    <div className="when">{e.actor_name ?? 'System'} · {formatDate(e.created_at)}</div>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </div>

      {dialog === 'edit' && <ScheduleDialog interview={iv} onClose={() => setDialog(null)} />}
      {dialog === 'cancel' && <ReasonDialog title="Cancel this interview?" confirm="Cancel interview" danger required onClose={() => setDialog(null)}
        onConfirm={(reason) => action.mutateAsync({ path: 'cancel', body: { reason } }).then(() => setDialog(null))} note="Any feedback links for this interview stop working." />}
      {dialog === 'noshow' && <ReasonDialog title="Mark as a no-show?" confirm="Mark no-show" onClose={() => setDialog(null)}
        onConfirm={(reason) => action.mutateAsync({ path: 'no-show', body: reason ? { reason } : {} }).then(() => setDialog(null))} note="Feedback is waived for the whole panel and links stop working." />}
      {dialog === 'addPanel' && <AddPanelDialog interview={iv} onClose={() => setDialog(null)} onAdded={refresh} />}
      {linkFor && <IssueLinkDialog interview={iv} member={linkFor} onClose={() => setLinkFor(null)} onIssued={refresh} />}
    </>
  );
}

function ReasonDialog({ title, confirm, note, required, danger, onClose, onConfirm }: {
  title: string; confirm: string; note?: string; required?: boolean; danger?: boolean; onClose: () => void; onConfirm: (reason: string) => Promise<unknown>;
}) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const go = async () => { setBusy(true); setError(null); try { await onConfirm(reason.trim()); } catch (e) { setError(e); setBusy(false); } };
  return (
    <Dialog open title={title} onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Back</button><button className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`} onClick={go} disabled={busy || (!!required && !reason.trim())}>{confirm}</button></>}>
      <FormError error={error} />
      {note && <p style={{ marginTop: 0 }}>{note}</p>}
      <Field id="reason-text" label={required ? 'Reason' : 'Reason (optional)'}><textarea id="reason-text" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} autoFocus /></Field>
    </Dialog>
  );
}

function AddPanelDialog({ interview, onClose, onAdded }: { interview: InterviewDetail; onClose: () => void; onAdded: () => Promise<unknown> }) {
  const [draft, setDraft] = useState<PanelDraft[]>([]);
  const add = useMutation({
    mutationFn: async () => {
      for (const m of draft) await api('POST', `/interviews/${interview.id}/interviewers`, m.user_id ? { user_id: m.user_id } : { name: m.name, email: m.email });
    },
    onSuccess: async () => { await onAdded(); onClose(); },
  });
  return (
    <Dialog open wide title="Add interviewers" onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" onClick={() => add.mutate()} disabled={add.isPending || draft.length === 0}>Add to panel</button></>}>
      <FormError error={add.error} />
      <PanelPicker panel={draft} onChange={setDraft} exclude={interview.panel.map((p) => p.user_id).filter((x): x is string => !!x)} />
    </Dialog>
  );
}

/** Issues a fresh link. The link is shown here once and cannot be shown again: only its hash is stored. */
function IssueLinkDialog({ interview, member, onClose, onIssued }: { interview: InterviewDetail; member: PanelMember; onClose: () => void; onIssued: () => Promise<unknown> }) {
  const [sendEmail, setSendEmail] = useState(true);
  const [hours, setHours] = useState('');
  const [copied, setCopied] = useState(false);
  const issue = useMutation({
    mutationFn: () => api<{ data: { url: string; expires_at: string; emailed: boolean } }>('POST', `/interviews/${interview.id}/feedback-links`, {
      interviewer_id: member.id, send_email: sendEmail && !!member.email, ...(hours ? { expires_in_hours: Number(hours) } : {}),
    }),
    onSuccess: onIssued,
  });
  const result = issue.data?.data;
  return (
    <Dialog open wide title={result ? 'Link ready' : `Feedback link for ${member.name}`} onClose={onClose}
      footer={result ? <button className="btn btn-primary" onClick={onClose}>Done</button> : (
        <><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" onClick={() => issue.mutate()} disabled={issue.isPending}>{member.link ? 'Replace and send' : 'Create link'}</button></>
      )}>
      <FormError error={issue.error} />
      {result ? (
        <>
          <p style={{ marginTop: 0 }}>{result.emailed ? `We emailed this link to ${member.email}. ` : ''}Copy it now if you need it: <strong>it cannot be shown again</strong>. It works once, and expires {formatDate(result.expires_at)}.</p>
          <div style={{ display: 'flex', gap: 8 }}>
            <input readOnly value={result.url} aria-label="Feedback link" onFocus={(e) => e.currentTarget.select()} />
            <button className="btn" onClick={async () => { await navigator.clipboard?.writeText(result.url); setCopied(true); }}>{copied ? 'Copied' : 'Copy'}</button>
          </div>
        </>
      ) : (
        <>
          {member.link && <div className="dup-box" role="status">This replaces their current link, which stops working.</div>}
          <p style={{ marginTop: 0 }}>A private link that lets {member.name} give feedback without an account. It can be used once.</p>
          <Field id="link-hours" label="Valid for (hours)" hint="Leave empty to use the company default."><input id="link-hours" type="number" min={1} max={2160} value={hours} onChange={(e) => setHours(e.target.value)} /></Field>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
            <input type="checkbox" checked={sendEmail} onChange={(e) => setSendEmail(e.target.checked)} disabled={!member.email} style={{ width: 'auto', height: 'auto' }} />
            Email it to {member.email ?? 'them (no address on file)'}
          </label>
        </>
      )}
    </Dialog>
  );
}

function FeedbackSection({ iv, items, loading, onChanged }: { iv: InterviewDetail; items: FeedbackItem[] | undefined; loading: boolean; onChanged: () => Promise<unknown> }) {
  const [correcting, setCorrecting] = useState<FeedbackItem | null>(null);
  return (
    <div className="card">
      <div className="section">
        <h2>Feedback received</h2>
        {loading ? <Loading /> : !items || items.length === 0 ? <p className="empty-inline">No feedback yet.</p> : items.map((f) => (
          <div key={f.id} className="note">
            <div className="title-row">
              <strong>{f.interviewer.name}</strong>
              <Badge tone="info">{f.effective.overall_rating} of 5</Badge>
              <Badge tone={f.effective.recommendation.includes('yes') ? 'success' : f.effective.recommendation === 'hold' ? 'warning' : 'danger'}>{RECOMMENDATION_LABEL[f.effective.recommendation]}</Badge>
              {f.effective.corrected && <Badge tone="warning">Corrected</Badge>}
              {iv.can.correct && <button className="btn btn-sm" style={{ marginLeft: 'auto' }} onClick={() => setCorrecting(f)}>Correct</button>}
            </div>
            <dl className="detail-grid" style={{ margin: '10px 0' }}>
              {iv.template.competencies.map((c) => <div key={c.code}><dt>{c.label}</dt><dd>{f.effective.competency_ratings[c.code] ? `${f.effective.competency_ratings[c.code]} of 5` : '—'}</dd></div>)}
            </dl>
            {f.effective.notes && <p className="prose">{f.effective.notes}</p>}
            <div className="cell-sub">Submitted {formatDate(f.submitted_at)} · {MODE_LABEL[f.effective.mode]}</div>
            {f.corrections.length > 0 && (
              <details style={{ marginTop: 6 }}>
                <summary className="muted" style={{ cursor: 'pointer', fontSize: 13 }}>Original and {f.corrections.length} correction{f.corrections.length === 1 ? '' : 's'}</summary>
                <p className="cell-sub" style={{ margin: '6px 0' }}>Original: {f.original.overall_rating} of 5, {RECOMMENDATION_LABEL[f.original.recommendation]}{f.original.notes ? ` — “${f.original.notes}”` : ''}</p>
                {f.corrections.map((c) => <p key={c.version} className="cell-sub" style={{ margin: '4px 0' }}>v{c.version} by {c.corrected_by} ({formatDate(c.at)}): {c.overall_rating} of 5, {RECOMMENDATION_LABEL[c.recommendation]}. Reason: {c.reason}</p>)}
              </details>
            )}
          </div>
        ))}
      </div>
      {correcting && <CorrectionDialog iv={iv} item={correcting} onClose={() => setCorrecting(null)} onSaved={onChanged} />}
    </div>
  );
}

/** A correction never edits the original: it adds a new version with a reason. */
function CorrectionDialog({ iv, item, onClose, onSaved }: { iv: InterviewDetail; item: FeedbackItem; onClose: () => void; onSaved: () => Promise<unknown> }) {
  const e = item.effective;
  const [overall, setOverall] = useState<number>(e.overall_rating);
  const [rec, setRec] = useState<Recommendation>(e.recommendation);
  const [ratings, setRatings] = useState<Record<string, number>>({ ...e.competency_ratings });
  const [notes, setNotes] = useState(e.notes ?? '');
  const [reason, setReason] = useState('');
  const save = useMutation({
    mutationFn: () => api('POST', `/feedback/${item.id}/corrections`, { mode: e.mode, overall_rating: overall, recommendation: rec, competency_ratings: ratings, notes, reason }),
    onSuccess: async () => { await onSaved(); onClose(); },
  });
  return (
    <Dialog open wide title={`Correct ${item.interviewer.name}'s feedback`} onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" onClick={() => save.mutate()} disabled={save.isPending || !reason.trim()}>Save correction</button></>}>
      <FormError error={save.error && !fieldError(save.error, 'reason') ? save.error : null} />
      <p style={{ marginTop: 0 }} className="muted">The original stays on record. This adds a new version, with your reason, that becomes the one that counts.</p>
      <RatingInput id="c-overall" label="Overall rating" value={overall} onChange={setOverall} />
      <div className="field">
        <label htmlFor="c-rec">Recommendation</label>
        <select id="c-rec" value={rec} onChange={(ev) => setRec(ev.target.value as Recommendation)}>
          {(Object.keys(RECOMMENDATION_LABEL) as Recommendation[]).map((r) => <option key={r} value={r}>{RECOMMENDATION_LABEL[r]}</option>)}
        </select>
      </div>
      {iv.template.competencies.map((c) => (
        <RatingInput key={c.code} id={`c-${c.code}`} label={c.label} value={ratings[c.code] ?? null} onChange={(n) => setRatings((r) => ({ ...r, [c.code]: n }))} error={fieldError(save.error, `competency_ratings.${c.code}`)} />
      ))}
      <Field id="c-notes" label="Notes"><textarea id="c-notes" value={notes} onChange={(ev) => setNotes(ev.target.value)} maxLength={5000} /></Field>
      <Field id="c-reason" label="Why is this being corrected?" error={fieldError(save.error, 'reason')}><textarea id="c-reason" value={reason} onChange={(ev) => setReason(ev.target.value)} maxLength={1000} style={{ minHeight: 60 }} /></Field>
    </Dialog>
  );
}

function DecisionSection({ iv }: { iv: InterviewDetail }) {
  const summary = useQuery(applicationFeedbackQuery(iv.application_id));
  const history = useQuery(decisionsQuery(iv.application_id));
  const [open, setOpen] = useState(false);
  const s = summary.data?.summary;
  return (
    <div className="card">
      <div className="section">
        <h2>Decision on {iv.candidate.full_name} <button className="btn btn-sm btn-primary" onClick={() => setOpen(true)}>Record decision</button></h2>
        {s && (
          <p style={{ marginTop: 0 }}>
            {s.count === 0 ? 'No feedback across rounds yet.' : <>Across {s.count} feedback record{s.count === 1 ? '' : 's'}: average <strong>{s.average_rating} of 5</strong>. {Object.entries(s.recommendations).map(([k, n]) => `${n} ${RECOMMENDATION_LABEL[k as Recommendation].toLowerCase()}`).join(', ')}.</>}
          </p>
        )}
        {history.data && history.data.length > 0 ? (
          <ul className="timeline">
            {history.data.map((d) => <li key={d.id}><strong>{DECISION_LABEL[d.decision] ?? d.decision}</strong>{d.reason && <div className="cell-sub">“{d.reason}”</div>}<div className="when">{d.decided_by_name} · {formatDate(d.decided_at)}</div></li>)}
          </ul>
        ) : <p className="empty-inline">No decision recorded.</p>}
      </div>
      {open && <DecisionDialog applicationId={iv.application_id} onClose={() => setOpen(false)} />}
    </div>
  );
}

function DecisionDialog({ applicationId, onClose }: { applicationId: string; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [decision, setDecision] = useState('advance');
  const [reason, setReason] = useState('');
  const save = useMutation({
    mutationFn: () => api('POST', `/applications/${applicationId}/decisions`, { decision, reason: reason.trim() || undefined }),
    onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: ['decisions', applicationId] }); onClose(); },
  });
  return (
    <Dialog open title="Record a decision" onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" onClick={() => save.mutate()} disabled={save.isPending}>Record</button></>}>
      <FormError error={save.error && !fieldError(save.error, 'reason') ? save.error : null} />
      <Field id="dec" label="Decision">
        <select id="dec" value={decision} onChange={(e) => setDecision(e.target.value)}>
          {Object.entries(DECISION_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </Field>
      <Field id="dec-reason" label={decision === 'hold' || decision === 'reject' ? 'Reason' : 'Reason (optional)'} error={fieldError(save.error, 'reason')}>
        <textarea id="dec-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={2000} />
      </Field>
      <p className="muted" style={{ fontSize: 12, margin: 0 }}>This records the decision. Move the candidate on the pipeline separately.</p>
    </Dialog>
  );
}
