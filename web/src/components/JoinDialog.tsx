import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../api';
import { Dialog, Field, FormError } from './ui';

/** Records the actual date of joining and the agreed CTC; for agency hires it fixes today's commercial terms. */
export function JoinDialog({ applicationId, name, title, ctc: agreedCtc, date, onClose }: { applicationId: string; name: string; title?: string | null; ctc?: number | string | null; date?: string | null; onClose: () => void }) {
  // Starts from the approved salary and joining date, when there are any.
  const [on, setOn] = useState(date?.slice(0, 10) ?? new Date().toISOString().slice(0, 10));
  const [designation, setDesignation] = useState(title ?? '');
  const [ctc, setCtc] = useState(agreedCtc != null ? String(Number(agreedCtc)) : '');
  const save = useMutation({ mutationFn: () => api('POST', `/applications/${applicationId}/join`, { joined_on: on, designation, annual_ctc: Number(ctc) }), onSuccess: onClose });
  return (
    <Dialog open title={`Mark ${name} as joined`} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={save.isPending || !designation.trim() || !ctc} onClick={() => save.mutate()}>Mark joined</button></>}>
      <FormError error={save.error} />
      <p className="muted" style={{ marginTop: 0 }}>This records the actual date of joining and the agreed CTC. For agency hires it fixes the commercial terms that apply today.</p>
      <Field id="j-on" label="Date of joining"><input id="j-on" type="date" value={on} onChange={(e) => setOn(e.target.value)} /></Field>
      <Field id="j-des" label="Designation"><input id="j-des" value={designation} onChange={(e) => setDesignation(e.target.value)} /></Field>
      <Field id="j-ctc" label="Agreed annual CTC (₹)"><input id="j-ctc" inputMode="numeric" value={ctc} onChange={(e) => setCtc(e.target.value.replace(/[^\d.]/g, ''))} /></Field>
    </Dialog>
  );
}
