import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { useState } from 'react';
import {
  api, ApiError, EMPLOYMENT_TYPES, formatCtcRange, formatDay, REQUISITION_STATUS_LABEL, VACANCY_STATUS_LABEL,
  type Approval, type RequisitionDetail, type VacancyStatus,
} from '../api';
import { RequisitionFormDialog } from '../components/RequisitionForm';
import { BackLink, Badge, DetailGrid, Dialog, ErrorState, Field, fieldError, FormError, formatDate, Loading, Tags } from '../components/ui';
import { approversQuery, requisitionQuery } from '../queries';
import { REQUISITION_TONE } from './Requisitions';

const VACANCY_TONE: Record<VacancyStatus, 'success' | 'warning' | 'muted'> = { open: 'success', on_hold: 'warning', closed: 'muted', cancelled: 'muted' };

export function RequisitionDetailPage() {
  const { id } = useParams({ from: '/app/requisitions/$id' });
  const query = useQuery(requisitionQuery(id));
  const [dialog, setDialog] = useState<'edit' | 'submit' | 'decide' | 'cancel' | 'vacancy' | null>(null);

  if (query.isPending) return <Loading />;
  if (query.isError) {
    const notFound = query.error instanceof ApiError && query.error.status === 404;
    return notFound ? (
      <div className="state"><h2>Requisition not found</h2><p>It may not exist, or you may not have access to it.</p></div>
    ) : <ErrorState error={query.error} onRetry={() => query.refetch()} />;
  }
  const rq = query.data;
  const rounds = [...new Set(rq.approvals.map((a) => a.round))].sort((a, b) => b - a);
  const close = () => setDialog(null);

  return (
    <>
      <BackLink to="/requisitions">Hiring requests</BackLink>
      <div className="page-header">
        <div>
          <div className="title-row">
            <h1>{rq.title}</h1>
            <Badge tone={REQUISITION_TONE[rq.status]}>{REQUISITION_STATUS_LABEL[rq.status]}</Badge>
          </div>
          <p>{rq.department_name} · {rq.location} · requested by {rq.requested_by_name}</p>
        </div>
        <div className="actions-row">
          {rq.can.edit && <button className="btn" onClick={() => setDialog('edit')}>Edit</button>}
          {rq.can.submit && <button className="btn btn-primary" onClick={() => setDialog('submit')}>{rq.status === 'rejected' ? 'Resubmit for approval' : 'Submit for approval'}</button>}
          {rq.can.decide && <button className="btn btn-primary" onClick={() => setDialog('decide')}>Review</button>}
          {rq.can.open_vacancy && <button className="btn btn-primary" onClick={() => setDialog('vacancy')}>Open vacancy</button>}
          {rq.can.cancel && <button className="btn btn-danger" onClick={() => setDialog('cancel')}>Cancel requisition</button>}
        </div>
      </div>

      {rq.status === 'rejected' && (
        <div className="alert alert-error" role="status">
          Rejected: {rq.approvals.find((a) => a.decision === 'rejected')?.reason ?? 'no reason given'}. Edit and resubmit to start a new approval round.
        </div>
      )}
      {rq.status === 'cancelled' && <div className="alert alert-error" role="status">Cancelled: {rq.cancel_reason}</div>}

      <div className="detail-layout">
        <div className="stack">
          <div className="card">
            <div className="section">
              <h2>Role</h2>
              <DetailGrid items={[
                ['Positions', rq.headcount],
                ['Employment type', EMPLOYMENT_TYPES[rq.employment_type] ?? rq.employment_type],
                ['Priority', <span style={{ textTransform: 'capitalize' }}>{rq.priority}</span>],
                ['Experience', rq.min_experience_years != null || rq.max_experience_years != null ? `${rq.min_experience_years ?? 0}–${rq.max_experience_years ?? '+'} years` : '—'],
                ...(rq.min_ctc !== undefined || rq.max_ctc !== undefined ? [['Budget (CTC)', formatCtcRange(rq.min_ctc, rq.max_ctc)] as [string, string]] : []),
                ['Target date', formatDay(rq.target_date)],
                ['Hiring manager', rq.hiring_manager_name],
              ]} />
            </div>
            <div className="section">
              <h2>Skills</h2>
              <Tags items={rq.skills} />
            </div>
            <div className="section">
              <h2>Description</h2>
              <p className="prose">{rq.description}</p>
            </div>
          </div>

          <div className="card">
            <div className="section">
              <h2>
                Vacancies
                <span className="muted" style={{ fontWeight: 400, fontSize: 13 }}>{rq.headcount_allocated} of {rq.headcount} positions opened</span>
              </h2>
              {rq.vacancies.length === 0 ? (
                <p className="empty-inline">{rq.status === 'approved' ? 'No vacancies opened yet.' : 'Vacancies can be opened once the requisition is approved.'}</p>
              ) : (
                <div className="table-wrap">
                  <table>
                    <thead><tr><th>Code</th><th>Title</th><th>Location</th><th className="num">Positions</th><th>Status</th></tr></thead>
                    <tbody>
                      {rq.vacancies.map((v) => (
                        <tr key={v.id}>
                          <td><Link className="row-link" to="/vacancies/$id" params={{ id: v.id }}>{v.vacancy_code}</Link></td>
                          <td>{v.title}</td>
                          <td>{v.location}</td>
                          <td className="num">{v.headcount}</td>
                          <td><Badge tone={VACANCY_TONE[v.status]}>{VACANCY_STATUS_LABEL[v.status]}</Badge></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="card">
          <div className="section">
            <h2>Approval history</h2>
            {rounds.length === 0 ? (
              <p className="empty-inline">Not submitted yet.</p>
            ) : (
              rounds.map((round) => (
                <div key={round} style={{ marginBottom: 14 }}>
                  <p className="round-label">Round {round}{round === rq.approval_round ? ' (current)' : ''}</p>
                  <ol className="timeline">
                    {rq.approvals.filter((a) => a.round === round).map((a) => <Step key={a.id} a={a} current={a.approver_user_id === rq.current_approver_id && a.decision === 'pending'} />)}
                  </ol>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {dialog === 'edit' && <RequisitionFormDialog requisition={rq} onClose={close} />}
      {dialog === 'submit' && <SubmitDialog rq={rq} onClose={close} />}
      {dialog === 'decide' && <DecideDialog rq={rq} onClose={close} />}
      {dialog === 'cancel' && <CancelDialog rq={rq} onClose={close} />}
      {dialog === 'vacancy' && <OpenVacancyDialog rq={rq} onClose={close} />}
    </>
  );
}

function Step({ a, current }: { a: Approval; current: boolean }) {
  const tone = a.decision === 'approved' ? 't-approved' : a.decision === 'rejected' ? 't-rejected' : a.decision === 'pending' ? 't-pending' : '';
  return (
    <li className={tone}>
      <strong>{a.approver_name}</strong>
      <div>
        {a.decision === 'pending' ? (current ? 'Waiting for their decision' : 'Waiting for earlier steps') : a.decision === 'skipped' ? 'Skipped' : a.decision === 'approved' ? 'Approved' : 'Rejected'}
      </div>
      {a.reason && <div className="cell-sub">“{a.reason}”</div>}
      {a.decided_at && <div className="when">{formatDate(a.decided_at)}</div>}
    </li>
  );
}

function useRefresh(id: string) {
  const queryClient = useQueryClient();
  return async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['requisition', id] }),
      queryClient.invalidateQueries({ queryKey: ['requisitions'] }),
      queryClient.invalidateQueries({ queryKey: ['vacancies'] }),
    ]);
  };
}

function SubmitDialog({ rq, onClose }: { rq: RequisitionDetail; onClose: () => void }) {
  const refresh = useRefresh(rq.id);
  const approvers = useQuery(approversQuery(rq.department_id));
  const [chosen, setChosen] = useState<string[]>([]);
  const available = (approvers.data ?? []).filter((u) => !chosen.includes(u.id));
  const nameOf = (id: string) => approvers.data?.find((u) => u.id === id)?.full_name ?? id;

  const submit = useMutation({
    mutationFn: () => api('POST', `/requisitions/${rq.id}/submit-approval`, { approver_user_ids: chosen }),
    onSuccess: async () => { await refresh(); onClose(); },
  });

  return (
    <Dialog
      open title="Submit for approval" onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={() => submit.mutate()} disabled={submit.isPending || chosen.length === 0}>Submit</button>
        </>
      }
    >
      <FormError error={submit.error} />
      <p style={{ marginTop: 0 }}>Approvers decide in the order you pick them. A rejection at any step sends it back to you.</p>
      {chosen.length > 0 && (
        <ol className="chips" style={{ listStyle: 'none', padding: 0, margin: '0 0 8px' }}>
          {chosen.map((id, i) => (
            <li key={id} className="chip">{i + 1}. {nameOf(id)}<button aria-label={`Remove ${nameOf(id)}`} onClick={() => setChosen(chosen.filter((c) => c !== id))}>×</button></li>
          ))}
        </ol>
      )}
      {approvers.isPending ? <Loading /> : approvers.isError ? <ErrorState error={approvers.error} /> : (
        <Field id="approver" label={chosen.length ? 'Add another approver' : 'First approver'}>
          <select id="approver" value="" onChange={(e) => e.target.value && setChosen([...chosen, e.target.value])} disabled={available.length === 0 || chosen.length >= 5}>
            <option value="">{available.length === 0 ? 'No more approvers available' : 'Choose an approver'}</option>
            {available.map((u) => <option key={u.id} value={u.id}>{u.full_name} ({u.email})</option>)}
          </select>
        </Field>
      )}
    </Dialog>
  );
}

function DecideDialog({ rq, onClose }: { rq: RequisitionDetail; onClose: () => void }) {
  const refresh = useRefresh(rq.id);
  const [reason, setReason] = useState('');
  const decide = useMutation({
    mutationFn: (decision: 'approved' | 'rejected') => api('POST', `/requisitions/${rq.id}/approve`, { decision, reason: reason || undefined }),
    onSuccess: async () => { await refresh(); onClose(); },
  });
  return (
    <Dialog
      open title={`Review “${rq.title}”`} onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Close</button>
          <button className="btn btn-danger" onClick={() => decide.mutate('rejected')} disabled={decide.isPending}>Reject</button>
          <button className="btn btn-primary" onClick={() => decide.mutate('approved')} disabled={decide.isPending}>Approve</button>
        </>
      }
    >
      <FormError error={decide.error && !fieldError(decide.error, 'reason') ? decide.error : null} />
      <Field id="reason" label="Comment" hint="Required if you reject." error={fieldError(decide.error, 'reason')}>
        <textarea id="reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={2000} />
      </Field>
    </Dialog>
  );
}

function CancelDialog({ rq, onClose }: { rq: RequisitionDetail; onClose: () => void }) {
  const refresh = useRefresh(rq.id);
  const [reason, setReason] = useState('');
  const cancel = useMutation({
    mutationFn: () => api('POST', `/requisitions/${rq.id}/cancel`, { reason }),
    onSuccess: async () => { await refresh(); onClose(); },
  });
  return (
    <Dialog
      open title="Cancel this requisition?" onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Keep it</button>
          <button className="btn btn-danger" onClick={() => cancel.mutate()} disabled={cancel.isPending || !reason.trim()}>Cancel requisition</button>
        </>
      }
    >
      <FormError error={cancel.error} />
      <Field id="cancel-reason" label="Reason">
        <textarea id="cancel-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={2000} />
      </Field>
    </Dialog>
  );
}

function OpenVacancyDialog({ rq, onClose }: { rq: RequisitionDetail; onClose: () => void }) {
  const refresh = useRefresh(rq.id);
  const left = rq.headcount - rq.headcount_allocated;
  const [headcount, setHeadcount] = useState(String(left));
  const [location, setLocation] = useState(rq.location);
  const open = useMutation({
    mutationFn: () => api('POST', `/requisitions/${rq.id}/vacancies`, { headcount: Number(headcount), location }),
    onSuccess: async () => { await refresh(); onClose(); },
  });
  return (
    <Dialog
      open title="Open a vacancy" onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={() => open.mutate()} disabled={open.isPending || !headcount || !location.trim()}>Open vacancy</button>
        </>
      }
    >
      <FormError error={open.error} />
      <p style={{ marginTop: 0 }}>{left} of {rq.headcount} positions are not yet opened. Use separate vacancies for different locations or hiring waves.</p>
      <Field id="v-headcount" label="Positions in this vacancy"><input id="v-headcount" type="number" min={1} max={left} value={headcount} onChange={(e) => setHeadcount(e.target.value)} /></Field>
      <Field id="v-location" label="Location"><input id="v-location" value={location} onChange={(e) => setLocation(e.target.value)} /></Field>
    </Dialog>
  );
}
