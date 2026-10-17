import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { useState } from 'react';
import { api, ApiError, formatInr, JOINING_STATUS_LABEL, OFFER_STATUS_LABEL, type OfferDetail } from '../api';
import { BackLink, Badge, Dialog, ErrorState, Field, fieldError, FormError, formatDate, Loading } from '../components/ui';
import { offerApproversQuery, offerQuery } from '../queries';
import { JoiningActions, OFFER_TONE } from './Offers';

const day = (d: string | null) => (d ? new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { dateStyle: 'long' }) : '—');

function useRefresh(id: string) {
  const queryClient = useQueryClient();
  return () => Promise.all(['offers', 'joining', 'tasks', 'applications', 'pipeline', 'unread-count', 'analytics'].map((k) => queryClient.invalidateQueries({ queryKey: [k] })).concat(queryClient.invalidateQueries({ queryKey: ['offer', id] })));
}

export function OfferDetailPage() {
  const { id } = useParams({ from: '/app/offers/$id' });
  const query = useQuery(offerQuery(id));
  const [dialog, setDialog] = useState<null | 'edit' | 'submit' | 'decide' | 'respond' | 'withdraw'>(null);
  const refresh = useRefresh(id);
  const release = useMutation({ mutationFn: () => api('POST', `/offers/${id}/release`), onSuccess: refresh });

  if (query.isPending) return <Loading />;
  if (query.isError) {
    return query.error instanceof ApiError && query.error.status === 404
      ? <div className="state"><h2>Offer not found</h2><p>It may have been removed, or you may not have access to it.</p></div>
      : <ErrorState error={query.error} onRetry={() => query.refetch()} />;
  }
  const o = query.data;
  const rounds = [...new Set(o.approvals.map((a) => a.round))];
  return (
    <>
      <BackLink to="/offers">Offers</BackLink>
      <div className="page-header">
        <div>
          <div className="title-row"><h1>{o.candidate.full_name}</h1><Badge tone={OFFER_TONE[o.status]}>{OFFER_STATUS_LABEL[o.status]}</Badge></div>
          <p>{o.vacancy.title} · {o.vacancy.code} · drafted by {o.created_by_name}</p>
        </div>
        <div className="actions-row">
          {o.can.edit && <button className="btn" onClick={() => setDialog('edit')}>Edit</button>}
          {o.can.submit && <button className="btn btn-primary" onClick={() => setDialog('submit')}>Send for approval</button>}
          {o.can.decide && <button className="btn btn-primary" onClick={() => setDialog('decide')}>Review</button>}
          {o.can.release && <button className="btn btn-primary" disabled={release.isPending} onClick={() => release.mutate()}>Release to candidate</button>}
          {o.can.respond && <button className="btn btn-primary" onClick={() => setDialog('respond')}>Record response</button>}
          {o.can.withdraw && <button className="btn btn-danger" onClick={() => setDialog('withdraw')}>Withdraw</button>}
        </div>
      </div>
      <FormError error={release.error} />
      <div className="detail-layout">
        <div className="card"><div className="section">
          <h2>Offer</h2>
          <dl className="detail-grid">
            <dt>Offered CTC</dt><dd><strong>{o.offered_ctc === null ? '—' : formatInr(o.offered_ctc)}</strong> per year</dd>
            <dt>Proposed joining</dt><dd>{day(o.proposed_joining_date)}</dd>
            <dt>Pipeline stage</dt><dd>{o.application.stage_name} · <Link className="row-link" to="/candidates/$id" params={{ id: o.candidate.id }}>candidate profile</Link></dd>
            {o.released_at && <><dt>Released</dt><dd>{formatDate(o.released_at)}</dd></>}
            {o.responded_at && <><dt>Candidate responded</dt><dd>{formatDate(o.responded_at)}</dd></>}
            {o.decline_reason && <><dt>Declined because</dt><dd>{o.decline_reason}</dd></>}
            {o.withdrawn_reason && <><dt>Withdrawn because</dt><dd>{o.withdrawn_reason}</dd></>}
          </dl>
          {o.notes && <p className="prose">{o.notes}</p>}
        </div></div>
        <div className="stack">
          {o.joining && (
            <div className="card"><div className="section">
              <h2>Joining</h2>
              <p style={{ margin: '0 0 8px' }}><Badge tone={o.joining.status === 'joined' ? 'success' : o.joining.status === 'backed_out' ? 'danger' : o.joining.status === 'delayed' ? 'warning' : 'info'}>{JOINING_STATUS_LABEL[o.joining.status]}</Badge> · {day(o.joining.joining_date)}</p>
              {o.joining.reason && <p className="cell-sub">{o.joining.reason}</p>}
              {o.can.respond === false && o.joining && <JoiningActions j={o.joining} />}
            </div></div>
          )}
          <div className="card"><div className="section">
            <h2>Approval</h2>
            {rounds.length === 0 ? <p className="empty-inline">Not sent for approval yet.</p> : rounds.map((round) => (
              <div key={round}>
                {rounds.length > 1 && <div className="cell-sub" style={{ margin: '6px 0' }}>Round {round}</div>}
                <ol style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                  {o.approvals.filter((a) => a.round === round).map((a) => (
                    <li key={a.id} className="note">
                      <strong>{a.approver_name}</strong>{' '}
                      <Badge tone={a.decision === 'approved' ? 'success' : a.decision === 'rejected' ? 'danger' : a.decision === 'skipped' ? 'muted' : 'warning'}>
                        {a.decision === 'pending' && a.approver_user_id === o.current_approver_id ? 'Waiting' : a.decision === 'pending' ? 'Queued' : a.decision}
                      </Badge>
                      {a.reason && <div className="cell-sub">{a.reason}</div>}
                    </li>
                  ))}
                </ol>
              </div>
            ))}
          </div></div>
        </div>
      </div>
      {dialog === 'edit' && <EditDialog o={o} onClose={() => setDialog(null)} />}
      {dialog === 'submit' && <SubmitDialog o={o} onClose={() => setDialog(null)} />}
      {dialog === 'decide' && <DecideDialog o={o} onClose={() => setDialog(null)} />}
      {dialog === 'respond' && <RespondDialog o={o} onClose={() => setDialog(null)} />}
      {dialog === 'withdraw' && <WithdrawDialog o={o} onClose={() => setDialog(null)} />}
    </>
  );
}

function EditDialog({ o, onClose }: { o: OfferDetail; onClose: () => void }) {
  const refresh = useRefresh(o.id);
  const [ctc, setCtc] = useState(String(o.offered_ctc ?? ''));
  const [date, setDate] = useState(o.proposed_joining_date ?? '');
  const [notes, setNotes] = useState(o.notes ?? '');
  const save = useMutation({
    mutationFn: () => api('PATCH', `/offers/${o.id}`, { offered_ctc: Number(ctc), proposed_joining_date: date, notes: notes.trim() || null }),
    onSuccess: async () => { await refresh(); onClose(); },
  });
  return (
    <Dialog open title="Edit offer" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={save.isPending} onClick={() => save.mutate()}>Save</button></>}>
      <OfferFields {...{ ctc, setCtc, date, setDate, notes, setNotes }} error={save.error} />
    </Dialog>
  );
}

export function OfferFields({ ctc, setCtc, date, setDate, notes, setNotes, error }: { ctc: string; setCtc: (v: string) => void; date: string; setDate: (v: string) => void; notes: string; setNotes: (v: string) => void; error: unknown }) {
  return (
    <>
      <FormError error={error && !fieldError(error, 'offered_ctc') && !fieldError(error, 'proposed_joining_date') ? error : null} />
      <Field id="offer-ctc" label="Offered CTC (per year, ₹)" error={fieldError(error, 'offered_ctc')}><input id="offer-ctc" inputMode="numeric" value={ctc} onChange={(e) => setCtc(e.target.value.replace(/[^\d.]/g, ''))} /></Field>
      <Field id="offer-date" label="Proposed joining date" error={fieldError(error, 'proposed_joining_date')}><input id="offer-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
      <Field id="offer-notes" label="Notes (optional)"><textarea id="offer-notes" rows={3} maxLength={4000} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
    </>
  );
}

function SubmitDialog({ o, onClose }: { o: OfferDetail; onClose: () => void }) {
  const refresh = useRefresh(o.id);
  const approvers = useQuery(offerApproversQuery(o.department_id));
  const [chosen, setChosen] = useState<string[]>([]);
  const available = (approvers.data ?? []).filter((u) => !chosen.includes(u.id));
  const nameOf = (id: string) => approvers.data?.find((u) => u.id === id)?.full_name ?? id;
  const submit = useMutation({ mutationFn: () => api('POST', `/offers/${o.id}/submit-approval`, { approver_user_ids: chosen }), onSuccess: async () => { await refresh(); onClose(); } });
  return (
    <Dialog open title="Send for approval" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={submit.isPending || chosen.length === 0} onClick={() => submit.mutate()}>Send</button></>}>
      <FormError error={submit.error} />
      <p style={{ marginTop: 0 }}>Approvers decide in the order you pick them. A rejection sends the offer back to you as a draft.</p>
      {chosen.length > 0 && (
        <ol className="chips" style={{ listStyle: 'none', padding: 0, margin: '0 0 8px' }}>
          {chosen.map((id, i) => <li key={id} className="chip">{i + 1}. {nameOf(id)}<button aria-label={`Remove ${nameOf(id)}`} onClick={() => setChosen(chosen.filter((c) => c !== id))}>×</button></li>)}
        </ol>
      )}
      {approvers.isPending ? <Loading /> : approvers.isError ? <ErrorState error={approvers.error} /> : (
        <Field id="offer-approver" label={chosen.length ? 'Add another approver' : 'First approver'}>
          <select id="offer-approver" value="" onChange={(e) => e.target.value && setChosen([...chosen, e.target.value])} disabled={available.length === 0 || chosen.length >= 5}>
            <option value="">{available.length === 0 ? 'No more approvers available' : 'Choose an approver'}</option>
            {available.map((u) => <option key={u.id} value={u.id}>{u.full_name} ({u.email})</option>)}
          </select>
        </Field>
      )}
    </Dialog>
  );
}

function DecideDialog({ o, onClose }: { o: OfferDetail; onClose: () => void }) {
  const refresh = useRefresh(o.id);
  const [reason, setReason] = useState('');
  const decide = useMutation({ mutationFn: (decision: 'approved' | 'rejected') => api('POST', `/offers/${o.id}/approve`, { decision, reason: reason || undefined }), onSuccess: async () => { await refresh(); onClose(); } });
  return (
    <Dialog open title={`Review offer for ${o.candidate.full_name}`} onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Close</button><button className="btn btn-danger" disabled={decide.isPending} onClick={() => decide.mutate('rejected')}>Reject</button><button className="btn btn-primary" disabled={decide.isPending} onClick={() => decide.mutate('approved')}>Approve</button></>}>
      <FormError error={decide.error && !fieldError(decide.error, 'reason') ? decide.error : null} />
      <p style={{ marginTop: 0 }}><strong>{o.offered_ctc === null ? '—' : formatInr(o.offered_ctc)}</strong> per year · joining {day(o.proposed_joining_date)}</p>
      <Field id="decision-reason" label="Reason (required to reject)" error={fieldError(decide.error, 'reason')}><textarea id="decision-reason" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
    </Dialog>
  );
}

function RespondDialog({ o, onClose }: { o: OfferDetail; onClose: () => void }) {
  const refresh = useRefresh(o.id);
  const [reason, setReason] = useState('');
  const respond = useMutation({ mutationFn: (response: 'accepted' | 'declined') => api('POST', `/offers/${o.id}/respond`, { response, reason: reason || undefined }), onSuccess: async () => { await refresh(); onClose(); } });
  return (
    <Dialog open title="Record the candidate's response" onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Close</button><button className="btn btn-danger" disabled={respond.isPending} onClick={() => respond.mutate('declined')}>Declined</button><button className="btn btn-primary" disabled={respond.isPending} onClick={() => respond.mutate('accepted')}>Accepted</button></>}>
      <FormError error={respond.error && !fieldError(respond.error, 'reason') ? respond.error : null} />
      <p style={{ marginTop: 0 }}>Accepting creates a joining record and a follow-up to-do for {o.created_by_name}.</p>
      <Field id="respond-reason" label="Why did they decline? (required if declined)" error={fieldError(respond.error, 'reason')}><textarea id="respond-reason" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
    </Dialog>
  );
}

function WithdrawDialog({ o, onClose }: { o: OfferDetail; onClose: () => void }) {
  const refresh = useRefresh(o.id);
  const [reason, setReason] = useState('');
  const withdraw = useMutation({ mutationFn: () => api('POST', `/offers/${o.id}/withdraw`, { reason }), onSuccess: async () => { await refresh(); onClose(); } });
  return (
    <Dialog open title="Withdraw this offer" onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Keep offer</button><button className="btn btn-danger" disabled={withdraw.isPending || !reason.trim()} onClick={() => withdraw.mutate()}>Withdraw</button></>}>
      <FormError error={withdraw.error} />
      <Field id="withdraw-reason" label="Reason"><textarea id="withdraw-reason" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus /></Field>
    </Dialog>
  );
}
