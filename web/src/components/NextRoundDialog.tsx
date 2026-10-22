import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, type DirectoryUser } from '../api';
import { panelOptionsQuery } from '../queries';
import { Dialog, ErrorState, Field, fieldError, FormError, Loading } from './ui';

/** Send a candidate to the next round: pick who should interview and leave a remark the recruiter will see too. */
export function NextRoundDialog({ applicationId, candidateName, onClose }: { applicationId: string; candidateName: string; onClose: () => void }) {
  const queryClient = useQueryClient();
  const directory = useQuery(panelOptionsQuery(applicationId));
  const [round, setRound] = useState('Next round');
  const [chosen, setChosen] = useState<string[]>([]);
  const [remark, setRemark] = useState('');
  const send = useMutation({
    mutationFn: () => api('POST', `/applications/${applicationId}/next-round`, { round_name: round, interviewer_user_ids: chosen, remark }),
    onSuccess: async () => {
      await Promise.all(['hiring-home', 'interviews', 'decisions', 'applications', 'pipeline'].map((k) => queryClient.invalidateQueries({ queryKey: [k] })));
      onClose();
    },
  });
  const people = directory.data ?? [];
  const nameOf = (id: string) => people.find((u: DirectoryUser) => u.id === id)?.full_name ?? id;
  const available = people.filter((u: DirectoryUser) => !chosen.includes(u.id));

  return (
    <Dialog open title={`Send ${candidateName} to the next round`} onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={send.isPending || chosen.length === 0 || !remark.trim()} onClick={() => send.mutate()}>Send to next round</button></>}>
      <FormError error={send.error && !fieldError(send.error, 'remark') && !fieldError(send.error, 'interviewer_user_ids') ? send.error : null} />
      <Field id="nr-round" label="Round name"><input id="nr-round" value={round} onChange={(e) => setRound(e.target.value)} maxLength={120} /></Field>
      {directory.isPending ? <Loading /> : directory.isError ? <ErrorState error={directory.error} /> : (
        <Field id="nr-who" label="Who should interview?" error={fieldError(send.error, 'interviewer_user_ids')}>
          {chosen.length > 0 && (
            <ul className="chips" style={{ listStyle: 'none', padding: 0, margin: '0 0 6px' }}>
              {chosen.map((id) => <li key={id} className="chip">{nameOf(id)}<button type="button" aria-label={`Remove ${nameOf(id)}`} onClick={() => setChosen(chosen.filter((c) => c !== id))}>×</button></li>)}
            </ul>
          )}
          <select id="nr-who" value="" onChange={(e) => e.target.value && setChosen([...chosen, e.target.value])} disabled={available.length === 0 || chosen.length >= 6}>
            <option value="">{available.length === 0 ? 'No more colleagues' : 'Choose a colleague'}</option>
            {available.map((u: DirectoryUser) => <option key={u.id} value={u.id}>{u.full_name} ({u.email})</option>)}
          </select>
        </Field>
      )}
      <Field id="nr-remark" label="Remark" hint="The recruiter and the interviewers will see this." error={fieldError(send.error, 'remark')}>
        <textarea id="nr-remark" rows={4} maxLength={2000} placeholder="What went well, and what should the next interviewer look at?" value={remark} onChange={(e) => setRemark(e.target.value)} />
      </Field>
    </Dialog>
  );
}
