import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, formatDay } from '../api';
import { MODEL_LABEL } from '../pages/HrDashboard';
import { Badge, Dialog, ErrorState, Field, fieldError, FormError, Loading } from './ui';

export interface Terms {
  id: string; version: number; payment_model: 'payroll_management' | 'one_time_fee'; fee_type: 'percent_of_ctc' | 'fixed'; fee_value: number;
  lockin_days: number | null; replacement_days: number | null; effective_from: string; agreement_ref: string | null; notes: string | null; is_active: boolean; created_at: string;
}
export const feeText = (t: Pick<Terms, 'fee_type' | 'fee_value'>) => (t.fee_type === 'percent_of_ctc' ? `${t.fee_value}% of annual CTC` : `₹${t.fee_value.toLocaleString('en-IN')} fixed`);

/** Commercial terms and their history. The HR Lead can change them (which adds a version); the agency only reads. */
export function TermsPanel({ agencyId, readOnly }: { agencyId?: string; readOnly?: boolean }) {
  const path = readOnly ? '/agency/terms' : `/agencies/${agencyId}/terms`;
  const q = useQuery({ queryKey: ['terms', path], queryFn: () => api<{ data: { current: Terms | null; history: Terms[] } }>('GET', path).then((r) => r.data) });
  const [editing, setEditing] = useState(false);
  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="toolbar"><h2>Commercial terms</h2><span style={{ flex: 1 }} />{!readOnly && <button className="btn btn-primary btn-sm" onClick={() => setEditing(true)}>Change terms</button>}</div>
      {q.isPending ? <Loading /> : q.isError ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : (
        <>
          {q.data.current ? (
            <dl className="detail-grid section">
              <div><dt>Payment model</dt><dd>{MODEL_LABEL[q.data.current.payment_model]}</dd></div>
              <div><dt>Fee</dt><dd>{feeText(q.data.current)}</dd></div>
              <div><dt>Lock-in</dt><dd>{q.data.current.lockin_days === null ? '—' : `${q.data.current.lockin_days} days`}</dd></div>
              <div><dt>Replacement</dt><dd>{q.data.current.replacement_days === null ? '—' : `${q.data.current.replacement_days} days`}</dd></div>
              <div><dt>Effective from</dt><dd>{formatDay(q.data.current.effective_from)} <Badge tone="muted">Version {q.data.current.version}</Badge></dd></div>
              <div><dt>Agreement</dt><dd>{q.data.current.agreement_ref ?? '—'}</dd></div>
            </dl>
          ) : <p className="empty-inline" style={{ padding: '0 16px 16px' }}>{readOnly ? 'No commercial terms have been set for your agency yet.' : 'No terms yet. Set them before the first hire so the fee and replacement rules are on record.'}</p>}
          {q.data.history.length > 1 && (
            <div className="table-wrap"><table>
              <thead><tr><th>Version</th><th>Effective from</th><th>Model</th><th>Fee</th><th>Lock-in</th><th>Replacement</th><th>Agreement</th></tr></thead>
              <tbody>{q.data.history.map((t) => (
                <tr key={t.id}><td>{t.version}{!t.is_active && <> <Badge tone="muted">inactive</Badge></>}</td><td>{formatDay(t.effective_from)}</td><td>{MODEL_LABEL[t.payment_model]}</td><td>{feeText(t)}</td><td>{t.lockin_days ?? '—'}</td><td>{t.replacement_days ?? '—'}</td><td>{t.agreement_ref ?? '—'}</td></tr>
              ))}</tbody>
            </table></div>
          )}
          <p className="metric-def">Changing terms adds a new version. People who already joined keep the terms that applied when they joined.</p>
        </>
      )}
      {editing && agencyId && <TermsDialog agencyId={agencyId} base={q.data?.current ?? null} onClose={() => setEditing(false)} />}
    </div>
  );
}

function TermsDialog({ agencyId, base, onClose }: { agencyId: string; base: Terms | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [model, setModel] = useState<Terms['payment_model']>(base?.payment_model ?? 'one_time_fee');
  const [feeType, setFeeType] = useState<Terms['fee_type']>(base?.fee_type ?? 'percent_of_ctc');
  const [fee, setFee] = useState(base ? String(base.fee_value) : '');
  const [lockin, setLockin] = useState(base?.lockin_days != null ? String(base.lockin_days) : '');
  const [replacement, setReplacement] = useState(base?.replacement_days != null ? String(base.replacement_days) : '');
  const [from, setFrom] = useState(new Date().toISOString().slice(0, 10));
  const [ref, setRef] = useState(base?.agreement_ref ?? '');
  const [notes, setNotes] = useState('');
  const [active, setActive] = useState(true);
  const save = useMutation({
    mutationFn: () => api('POST', `/agencies/${agencyId}/terms`, {
      payment_model: model, fee_type: feeType, fee_value: Number(fee), lockin_days: lockin === '' ? null : Number(lockin), replacement_days: replacement === '' ? null : Number(replacement),
      effective_from: from, agreement_ref: ref.trim() || null, notes: notes.trim() || null, is_active: active,
    }),
    onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: ['terms'] }); await queryClient.invalidateQueries({ queryKey: ['hr-dashboard'] }); onClose(); },
  });
  return (
    <Dialog open wide title="Change commercial terms" onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={save.isPending || fee === ''} onClick={() => save.mutate()}>Save as new version</button></>}>
      <FormError error={save.error && !fieldError(save.error, 'fee_value') ? save.error : null} />
      <div className="form-grid">
        <Field id="t-model" label="Payment model"><select id="t-model" value={model} onChange={(e) => setModel(e.target.value as Terms['payment_model'])}><option value="one_time_fee">One-time hiring fee</option><option value="payroll_management">Payroll management</option></select></Field>
        <Field id="t-type" label="Fee type"><select id="t-type" value={feeType} onChange={(e) => setFeeType(e.target.value as Terms['fee_type'])}><option value="percent_of_ctc">Percentage of annual CTC</option><option value="fixed">Fixed amount</option></select></Field>
        <Field id="t-fee" label={feeType === 'percent_of_ctc' ? 'Percentage (%)' : 'Amount (₹)'} error={fieldError(save.error, 'fee_value')}><input id="t-fee" inputMode="decimal" value={fee} onChange={(e) => setFee(e.target.value.replace(/[^\d.]/g, ''))} /></Field>
        <Field id="t-from" label="Effective from"><input id="t-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field id="t-lock" label="Lock-in (days)" hint="Leaving within this period triggers a replacement."><input id="t-lock" inputMode="numeric" value={lockin} onChange={(e) => setLockin(e.target.value.replace(/\D/g, ''))} /></Field>
        <Field id="t-rep" label="Replacement within (days)" hint="How long the agency has to supply a replacement."><input id="t-rep" inputMode="numeric" value={replacement} onChange={(e) => setReplacement(e.target.value.replace(/\D/g, ''))} /></Field>
        <Field id="t-ref" label="Agreement reference"><input id="t-ref" value={ref} onChange={(e) => setRef(e.target.value)} maxLength={200} /></Field>
        <label className="check show-pw"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> Terms are active</label>
      </div>
      <Field id="t-notes" label="Notes"><textarea id="t-notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={4000} /></Field>
    </Dialog>
  );
}
