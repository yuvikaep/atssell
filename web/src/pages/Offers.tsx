import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { api, formatInr, JOINING_STATUS_LABEL, OFFER_STATUS_LABEL, type JoiningRow, type OfferStatus } from '../api';
import { Badge, EmptyState, ErrorState, FormError, Loading, type Tone } from '../components/ui';
import { joiningQuery, offersQuery } from '../queries';

export const OFFER_TONE: Record<OfferStatus, Tone> = { draft: 'muted', pending_approval: 'warning', approved: 'info', released: 'info', accepted: 'success', declined: 'danger', withdrawn: 'muted' };
const TABS = [
  { key: 'open', label: 'In progress', status: 'open', mine: false },
  { key: 'mine', label: 'Waiting on me', status: 'pending_approval', mine: true },
  { key: 'accepted', label: 'Accepted', status: 'accepted', mine: false },
  { key: 'closed', label: 'Declined', status: 'declined', mine: false },
  { key: 'all', label: 'All', status: 'all', mine: false },
];
const day = (d: string | null) => (d ? new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { dateStyle: 'medium' }) : '—');

export function OffersPage() {
  const [tab, setTab] = useState(TABS[0]!);
  const offers = useQuery(offersQuery(tab.status, tab.mine));
  return (
    <>
      <div className="page-header">
        <div><h1>Offers</h1><p>Draft, approve and release offers, then follow each candidate to their first day. Amounts are visible only to people who manage or approve offers.</p></div>
      </div>
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="toolbar" role="tablist" aria-label="Offer filter">
          {TABS.map((t) => <button key={t.key} role="tab" aria-selected={tab.key === t.key} className={`btn btn-sm ${tab.key === t.key ? 'btn-primary' : ''}`} onClick={() => setTab(t)}>{t.label}</button>)}
        </div>
        {offers.isPending ? <Loading /> : offers.isError ? <ErrorState error={offers.error} onRetry={() => offers.refetch()} /> : offers.data.length === 0 ? (
          <EmptyState title="No offers here">Make an offer from a candidate's card on the pipeline.</EmptyState>
        ) : (
          <div className="table-wrap"><table>
            <thead><tr><th>Candidate</th><th>Vacancy</th><th>Offered CTC</th><th>Joining</th><th>Status</th></tr></thead>
            <tbody>{offers.data.map((o) => (
              <tr key={o.id}>
                <td><Link className="row-link" to="/offers/$id" params={{ id: o.id }}>{o.candidate_name}</Link></td>
                <td>{o.vacancy_title}</td>
                <td>{o.offered_ctc === null ? '—' : formatInr(o.offered_ctc)}</td>
                <td>{day(o.proposed_joining_date)}</td>
                <td><Badge tone={OFFER_TONE[o.status]}>{OFFER_STATUS_LABEL[o.status]}</Badge></td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </div>
      <JoiningSection />
    </>
  );
}

function JoiningSection() {
  const joining = useQuery(joiningQuery('pending'));
  return (
    <div className="card">
      <div className="toolbar"><h2>Joining</h2><span className="muted">{joining.data?.length ?? 0}</span></div>
      {joining.isPending ? <Loading /> : joining.isError ? <ErrorState error={joining.error} onRetry={() => joining.refetch()} /> : joining.data.length === 0 ? (
        <p className="empty-inline" style={{ padding: '0 16px 16px' }}>Nobody is waiting to join. Candidates appear here once they accept an offer.</p>
      ) : (
        <div className="table-wrap"><table><tbody>
          {joining.data.map((j) => <JoiningRowView key={j.id} j={j} />)}
        </tbody></table></div>
      )}
    </div>
  );
}

export function JoiningActions({ j, onDone }: { j: Pick<JoiningRow, 'id' | 'status' | 'joining_date'>; onDone?: () => void }) {
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<null | 'delayed' | 'backed_out'>(null);
  const [reason, setReason] = useState('');
  const [date, setDate] = useState(j.joining_date ?? '');
  const refresh = () => Promise.all(['joining', 'offers', 'offer', 'applications', 'pipeline'].map((k) => queryClient.invalidateQueries({ queryKey: [k] })));
  const update = useMutation({
    mutationFn: (body: object) => api('PATCH', `/joining/${j.id}`, body),
    onSuccess: async () => { setMode(null); setReason(''); await refresh(); onDone?.(); },
  });
  if (j.status === 'joined' || j.status === 'backed_out') return null;
  if (mode) {
    return (
      <div className="stack" style={{ gap: 6, minWidth: 220 }}>
        <input aria-label="Reason" placeholder={mode === 'delayed' ? 'Why is joining delayed?' : 'Why did they back out?'} value={reason} onChange={(e) => setReason(e.target.value)} />
        {mode === 'delayed' && <input aria-label="New joining date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />}
        <FormError error={update.error} />
        <span className="actions-row">
          <button className="btn btn-sm btn-primary" disabled={!reason.trim() || update.isPending} onClick={() => update.mutate({ status: mode, reason, ...(mode === 'delayed' && date ? { joining_date: date } : {}) })}>Save</button>
          <button className="btn btn-sm" onClick={() => setMode(null)}>Cancel</button>
        </span>
      </div>
    );
  }
  return (
    <span className="actions-row">
      <button className="btn btn-sm btn-primary" disabled={update.isPending} onClick={() => update.mutate({ status: 'joined' })}>Joined</button>
      <button className="btn btn-sm" onClick={() => setMode('delayed')}>Delayed</button>
      <button className="btn btn-sm" onClick={() => setMode('backed_out')}>Backed out</button>
      {update.error && <span className="field-error">{(update.error as Error).message}</span>}
    </span>
  );
}

function JoiningRowView({ j }: { j: JoiningRow }) {
  return (
    <tr>
      <td>{j.offer_id ? <Link className="row-link" to="/offers/$id" params={{ id: j.offer_id }}>{j.candidate_name}</Link> : j.candidate_name}<div className="cell-sub">{j.vacancy_title}</div></td>
      <td>{day(j.joining_date)}{j.overdue && <> <Badge tone="danger">Date passed</Badge></>}</td>
      <td><Badge tone={j.status === 'delayed' ? 'warning' : 'info'}>{JOINING_STATUS_LABEL[j.status]}</Badge>{j.reason && <div className="cell-sub">{j.reason}</div>}</td>
      <td className="actions"><JoiningActions j={j} /></td>
    </tr>
  );
}

