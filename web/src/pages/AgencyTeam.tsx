import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { api } from '../api';
import { Badge, EmptyState, ErrorState, Field, FormError, Loading, StatusBadge, InviteLinkNotice } from '../components/ui';
import { TermsPanel } from '../components/TermsPanel';

interface Team { members: { user_id: string; full_name: string; email: string; status: 'active' | 'inactive'; agency_role: 'admin' | 'recruiter' }[]; invitations: { id: string; email: string; expired: boolean }[] }

/** The agency admin's optional sub-recruiters. */
export function AgencyTeamPage() {
  const q = useQuery({ queryKey: ['agency-team'], queryFn: () => api<{ data: Team }>('GET', '/agency/team').then((r) => r.data) });
  const queryClient = useQueryClient();
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const invite = useMutation({
    mutationFn: () => api<{ data: { invite_link?: string | null } }>('POST', '/agency/team/invitations', { email }),
    onSuccess: async (r) => { setSent(email); setLink(r.data.invite_link ?? null); setEmail(''); await queryClient.invalidateQueries({ queryKey: ['agency-team'] }); },
  });
  const toggle = useMutation({
    mutationFn: (m: { user_id: string; status: string }) => api('PATCH', `/agency/team/${m.user_id}`, { status: m.status === 'active' ? 'inactive' : 'active' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['agency-team'] }),
  });
  const submit = (e: FormEvent) => { e.preventDefault(); setSent(null); invite.mutate(); };
  return (
    <>
      <div className="page-header"><div><h1>My team</h1><p>Add sub-recruiters if you want them to submit candidates for your agency. This is optional.</p></div></div>
      <form className="card section" onSubmit={submit} style={{ marginBottom: 16 }}>
        <h2>Invite a sub-recruiter</h2>
        <FormError error={invite.error} />
        {sent && (link ? <InviteLinkNotice link={link} email={sent} /> : <div className="alert alert-success" role="status">Invitation sent to {sent}.</div>)}
        <div className="filters" style={{ padding: 0 }}>
          <Field id="team-email" label="Work email"><input id="team-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></Field>
          <button className="btn btn-primary" type="submit" disabled={invite.isPending || !email}>Send invitation</button>
        </div>
      </form>
      <div className="card">
        <div className="toolbar"><h2>People</h2></div>
        {q.isPending ? <Loading /> : q.isError ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : q.data.members.length === 0 ? <EmptyState title="Just you so far">Invite a sub-recruiter above.</EmptyState> : (
          <div className="table-wrap"><table>
            <thead><tr><th>Name</th><th>Role</th><th>Status</th><th /></tr></thead>
            <tbody>{q.data.members.map((m) => (
              <tr key={m.user_id}><td><strong>{m.full_name}</strong><div className="cell-sub">{m.email}</div></td><td>{m.agency_role === 'admin' ? 'Agency' : 'Sub-recruiter'}</td><td><StatusBadge status={m.status} /></td>
                <td className="actions">{m.agency_role === 'recruiter' && <button className="btn btn-sm" disabled={toggle.isPending} onClick={() => toggle.mutate(m)}>{m.status === 'active' ? 'Deactivate' : 'Reactivate'}</button>}</td></tr>
            ))}</tbody>
          </table></div>
        )}
        {q.data && q.data.invitations.length > 0 && <div className="section"><strong>Pending invitations</strong><div>{q.data.invitations.map((i) => <div key={i.id} className="cell-sub">{i.email} {i.expired && <Badge tone="warning">expired</Badge>}</div>)}</div></div>}
      </div>
    </>
  );
}

export function AgencyTermsPage() {
  return (
    <>
      <div className="page-header"><div><h1>Commercial terms</h1><p>The terms agreed with the company. Only the company's HR Lead can change them.</p></div></div>
      <TermsPanel readOnly />
    </>
  );
}
