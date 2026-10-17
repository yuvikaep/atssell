import { TermsPanel } from '../components/TermsPanel';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { CreateLoginDialog } from '../components/CreateLoginDialog';
import { api, ApiError, can } from '../api';
import { useMe } from '../components/AppShell';
import { Badge, Dialog, EmptyState, ErrorState, Field, fieldError, Forbidden, FormError, formatDate, Loading, StatusBadge, InviteLinkNotice } from '../components/ui';
import { agencyMembersQuery } from '../queries';

const ROLE_LABEL = { admin: 'Agency admin', recruiter: 'Agency recruiter' } as const;

export function AgencyDetailPage() {
  const { id } = useParams({ from: '/app/agencies/$id' });
  const me = useMe();
  const allowed = can(me, 'agencies.manage');
  const query = useQuery({ ...agencyMembersQuery(id), enabled: allowed });
  const queryClient = useQueryClient();
  const [inviting, setInviting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [creatingLogin, setCreatingLogin] = useState<{ id: string; email: string } | null>(null);
  const [inviteLink, setInviteLink] = useState<{ link?: string | null; email: string } | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['agency-members', id] });

  const update = useMutation({
    mutationFn: ({ userId, body }: { userId: string; body: { agency_role?: 'admin' | 'recruiter'; status?: 'active' | 'inactive' } }) =>
      api('PATCH', `/agencies/${id}/members/${userId}`, body),
    onSuccess: refresh,
  });
  const inviteAction = useMutation({
    mutationFn: ({ invitationId, kind }: { invitationId: string; kind: 'resend' | 'revoke'; email: string }) => api<{ data: { invite_link?: string | null } } | undefined>('POST', `/users/invitations/${invitationId}/${kind}`),
    onSuccess: async (d, v) => { setInviteLink({ link: d?.data?.invite_link, email: v.email }); setNotice(v.kind === 'resend' ? `New invitation sent to ${v.email}.` : `Invitation for ${v.email} revoked.`); await refresh(); },
  });

  if (!allowed) return <Forbidden />;
  if (query.isPending) return <Loading />;
  if (query.isError) {
    return query.error instanceof ApiError && query.error.status === 404 ? (
      <div className="state"><h2>Agency not found</h2></div>
    ) : <ErrorState error={query.error} onRetry={() => query.refetch()} />;
  }
  const { agency, members, invitations } = query.data;

  return (
    <>
      <Link className="back-link" to="/agencies">← Agencies</Link>
      <div className="page-header">
        <div>
          <div className="title-row"><h1>{agency.name}</h1><StatusBadge status={agency.status} /></div>
          <p>People at this agency who can sign in to the agency portal.</p>
        </div>
        {agency.status === 'active' && <button className="btn btn-primary" onClick={() => { setNotice(null); setInviting(true); }}>Invite member</button>}
      </div>

      {(update.error || inviteAction.error) && <FormError error={update.error ?? inviteAction.error} />}
      {notice && <div className="alert alert-success" role="status">{notice}</div>}
      <InviteLinkNotice link={inviteLink?.link} email={inviteLink?.email} />
      {creatingLogin && <CreateLoginDialog invitation={creatingLogin} onClose={() => setCreatingLogin(null)} />}

      <TermsPanel agencyId={agency.id} />

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="toolbar"><h2>Members</h2></div>
        {members.length === 0 ? <EmptyState title="No members yet">Invite the agency's admin first. They can then see assigned vacancies and submit candidates.</EmptyState> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Member</th><th>Role</th><th>Status</th><th>Last sign-in</th><th /></tr></thead>
              <tbody>
                {members.map((m) => (
                  <tr key={m.user_id}>
                    <td><strong>{m.full_name}</strong><div className="cell-sub">{m.email}</div></td>
                    <td>
                      <select aria-label={`Role for ${m.full_name}`} value={m.agency_role} disabled={update.isPending || m.status !== 'active'} style={{ width: 'auto' }}
                        onChange={(e) => update.mutate({ userId: m.user_id, body: { agency_role: e.target.value as 'admin' | 'recruiter' } })}>
                        <option value="admin">{ROLE_LABEL.admin}</option><option value="recruiter">{ROLE_LABEL.recruiter}</option>
                      </select>
                    </td>
                    <td><StatusBadge status={m.status} /></td>
                    <td className="muted">{formatDate(m.last_login_at)}</td>
                    <td className="actions">
                      <button className={`btn btn-sm ${m.status === 'active' ? 'btn-danger' : ''}`} disabled={update.isPending}
                        onClick={() => update.mutate({ userId: m.user_id, body: { status: m.status === 'active' ? 'inactive' : 'active' } })}>
                        {m.status === 'active' ? 'Deactivate' : 'Reactivate'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {invitations.length > 0 && (
        <div className="card">
          <div className="toolbar"><h2>Pending invitations</h2></div>
          <div className="table-wrap">
            <table>
              <tbody>
                {invitations.map((i) => (
                  <tr key={i.id}>
                    <td><strong>{i.email}</strong></td>
                    <td>{ROLE_LABEL[i.agency_role]}</td>
                    <td>{i.expired ? <Badge tone="warning">Expired</Badge> : <span className="muted">Expires {formatDate(i.expires_at)}</span>}</td>
                    <td className="actions">
                      <button className="btn btn-sm" onClick={() => setCreatingLogin(i)}>Create login</button>
                      <button className="btn btn-sm" disabled={inviteAction.isPending} onClick={() => inviteAction.mutate({ invitationId: i.id, kind: 'resend', email: i.email })}>Resend</button>
                      <button className="btn btn-sm btn-danger" disabled={inviteAction.isPending} onClick={() => inviteAction.mutate({ invitationId: i.id, kind: 'revoke', email: i.email })}>Revoke</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {inviting && <InviteDialog agencyId={id} onClose={() => setInviting(false)} onSent={setInviteLink} />}
    </>
  );
}

function InviteDialog({ agencyId, onClose, onSent }: { agencyId: string; onClose: () => void; onSent: (l: { link?: string | null; email: string }) => void }) {
  const queryClient = useQueryClient();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'admin' | 'recruiter'>('admin');
  const invite = useMutation({
    mutationFn: () => api<{ data: { invite_link?: string | null } }>('POST', `/agencies/${agencyId}/invitations`, { email, agency_role: role }),
    onSuccess: async (r) => { onSent({ link: r.data.invite_link, email }); await queryClient.invalidateQueries({ queryKey: ['agency-members', agencyId] }); onClose(); },
  });
  const submit = (e: FormEvent) => { e.preventDefault(); invite.mutate(); };
  return (
    <Dialog
      open title="Invite an agency member" onClose={onClose}
      footer={
        <>
          <button className="btn" type="button" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" type="submit" form="agency-invite" disabled={invite.isPending || !email.trim()}>Send invitation</button>
        </>
      }
    >
      <form id="agency-invite" onSubmit={submit} noValidate>
        <FormError error={invite.error && !fieldError(invite.error, 'email') ? invite.error : null} />
        <Field id="ai-email" label="Work email" error={fieldError(invite.error, 'email')}><input id="ai-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus /></Field>
        <Field id="ai-role" label="Role" hint="Admins see every submission from the agency; recruiters see only their own.">
          <select id="ai-role" value={role} onChange={(e) => setRole(e.target.value as 'admin' | 'recruiter')}>
            <option value="admin">{ROLE_LABEL.admin}</option><option value="recruiter">{ROLE_LABEL.recruiter}</option>
          </select>
        </Field>
      </form>
    </Dialog>
  );
}
