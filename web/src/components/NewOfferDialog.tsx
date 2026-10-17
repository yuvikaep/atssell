import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { api, type OfferDetail } from '../api';
import { OfferFields } from '../pages/OfferDetail';
import { Dialog } from './ui';

/** Drafts an offer for an application, then opens it so it can be sent for approval. */
export function NewOfferDialog({ applicationId, candidateName, onClose }: { applicationId: string; candidateName: string; onClose: () => void }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [ctc, setCtc] = useState('');
  const [date, setDate] = useState('');
  const [notes, setNotes] = useState('');
  const create = useMutation({
    mutationFn: () => api<{ data: OfferDetail }>('POST', `/applications/${applicationId}/offers`, { offered_ctc: Number(ctc), proposed_joining_date: date, notes: notes.trim() || null }),
    onSuccess: async (r) => {
      await queryClient.invalidateQueries({ queryKey: ['offers'] });
      onClose();
      await navigate({ to: '/offers/$id', params: { id: r.data.id } });
    },
  });
  return (
    <Dialog open title={`Make an offer to ${candidateName}`} onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={create.isPending || !ctc || !date} onClick={() => create.mutate()}>Create draft</button></>}>
      <OfferFields {...{ ctc, setCtc, date, setDate, notes, setNotes }} error={create.error} />
    </Dialog>
  );
}
