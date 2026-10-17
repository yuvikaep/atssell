import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useDeferredValue, useState, type FormEvent } from 'react';
import { CreateLoginDialog } from '../components/CreateLoginDialog';
import { api, canAll, type Invitation, type UserRow } from '../api';
import { useMe } from '../components/AppShell';
import { Dialog, EmptyState, ErrorState, Field, fieldError, Forbidden, formatDate, FormError, Loading, StatusBadge, InviteLinkNotice } from '../components/ui';
import { departmentsQuery, invitationsQuery, rolesQuery, usersQuery } from '../queries';
import { useSessionState } from '../session-storage';

const STATUSES = ['all', 'active', 'inactive'] as const;
const TABS = ['users', 'invitations'] as const;

export function UsersPage() {
  const me = useMe();
  const allowed = canAll(me, 'users.manage');
  const [tab, setTab] = useSessionState('jm.users.tab', 'users', TABS);
  const [inviting, setInviting] = useState(false);
  const [inviteLink, setInviteLink] = useState<{ link?: string | null; email: string } | null>(null);
  const invitations = useQuery({ ...invitationsQuery, enabled: allowed });

  if (!allowed) return <Forbidden />;

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Team & roles</h1>
          <p>Invite people and control what they can see and do.</p>
        </div>
        <button className="btn btn-primary" onClick={() => setInviting(true)}>Invite user</button>
      </div>

      <div className="card">
        <div className="tabs" role="tablist">
          <button className="tab" role="tab" aria-selected={tab === 'users'} onClick={() => setTab('users')}>Users</button>
          <button className="tab" role="tab" aria-selected={tab === 'invitations'} onClick={() => setTab('invitations')}>
            Pending invitations
            {invitations.data && invitations.data.length > 0 && <span className="count">{invitations.data.length}</span>}
          </button>
        </div>
        {tab === 'users' ? <UsersTab /> : <InvitationsTab query={invitations} onInvite={() => setInviting(true)} />}
      </div>

      {inviting && <InviteDialog onClose={() => setInviting(false)} onSent={(l) => { setInviteLink(l); setTab('invitations'); }} />}
      <InviteLinkNotice link={inviteLink?.link} email={inviteLink?.email} />
    </>
  );
}

function RoleBadges({ roles }: { roles: UserRow['roles'] }) {
  if (roles.length === 0) return <span className="muted">No role</span>;
  return (
    <>
      {roles.map((r) => (
        <span key={`${r.code}:${r.department_id ?? ''}`} className="badge badge-role">
          {r.name}{r.department_name ? ` · ${r.department_name}` : ''}
        </span>
      ))}
    </>
  );
}

function UsersTab() {
  const me = useMe();
  const [status, setStatus] = useSessionState('jm.users.status', 'all', STATUSES);
  const [search, setSearch] = useState('');
  const q = useDeferredValue(search.trim());
  const list = useQuery(usersQuery(status, q));
  const [editingRoles, setEditingRoles] = useState<UserRow | null>(null);
  const [toggling, setToggling] = useState<UserRow | null>(null);

  return (
    <>
      <div className="toolbar">
        <input type="search" placeholder="Search name or email" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search users" />
        <select value={status} onChange={(e) => setStatus(e.target.value as (typeof STATUSES)[number])} aria-label="Status">
          <option value="all">All statuses</option>
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
        </select>
      </div>
      {list.isPending ? (
        <Loading />
      ) : list.isError ? (
        <ErrorState error={list.error} onRetry={() => list.refetch()} />
      ) : list.data.data.length === 0 ? (
        <EmptyState title="No users match">Try a different search or status.</EmptyState>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>User</th><th>Roles</th><th>Status</th><th>Last sign-in</th><th /></tr>
            </thead>
            <tbody>
              {list.data.data.map((u) => (
                <tr key={u.id}>
                  <td>
                    <strong>{u.full_name}</strong>{u.id === me.user.id && <span className="muted"> (you)</span>}
                    <div className="cell-sub">{u.email}</div>
                  </td>
                  <td><RoleBadges roles={u.roles} /></td>
                  <td><StatusBadge status={u.status} /></td>
                  <td className="muted">{formatDate(u.last_login_at)}</td>
                  <td className="actions">
                    <button className="btn btn-sm" onClick={() => setEditingRoles(u)}>Edit roles</button>
                    {u.id !== me.user.id && (
                      <button className={`btn btn-sm ${u.status === 'active' ? 'btn-danger' : ''}`} onClick={() => setToggling(u)}>
                        {u.status === 'active' ? 'Deactivate' : 'Reactivate'}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editingRoles && <RolesDialog user={editingRoles} onClose={() => setEditingRoles(null)} />}
      {toggling && <ToggleUserDialog user={toggling} onClose={() => setToggling(null)} />}
    </>
  );
}

function InvitationsTab({ query, onInvite }: { query: ReturnType<typeof useQuery<Invitation[]>>; onInvite: () => void }) {
  const queryClient = useQueryClient();
  const [notice, setNotice] = useState<string | null>(null);
  const [resendLink, setResendLink] = useState<{ link: string; email: string } | null>(null);
  const [creatingLogin, setCreatingLogin] = useState<{ id: string; email: string } | null>(null);
  const action = useMutation({
    mutationFn: ({ id, kind }: { id: string; kind: 'resend' | 'revoke'; email: string }) =>
      api<{ data: { invite_link?: string | null } } | undefined>('POST', `/users/invitations/${id}/${kind}`),
    onSuccess: async (d, v) => {
      setResendLink(d?.data?.invite_link ? { link: d.data.invite_link, email: v.email } : null);
      setNotice(v.kind === 'resend' ? `New invitation sent to ${v.email}.` : `Invitation for ${v.email} revoked.`);
      await queryClient.invalidateQueries({ queryKey: ['invitations'] });
    },
  });

  if (query.isPending) return <Loading />;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => query.refetch()} />;
  if (!query.data || query.data.length === 0) {
    return <EmptyState title="No pending invitations" action={<button className="btn" onClick={onInvite}>Invite user</button>} />;
  }
  return (
    <>
      {(notice || action.error) && (
        <div style={{ padding: '12px 12px 0' }}>
          {creatingLogin && <CreateLoginDialog invitation={creatingLogin} onClose={() => setCreatingLogin(null)} />}
          {action.error ? <FormError error={action.error} /> : resendLink ? <InviteLinkNotice link={resendLink.link} email={resendLink.email} /> : <div className="alert alert-success">{notice}</div>}
        </div>
      )}
      <div className="table-wrap">
        <table>
          <thead><tr><th>Email</th><th>Role</th><th>Invited by</th><th>Expires</th><th /></tr></thead>
          <tbody>
            {query.data.map((i) => (
              <tr key={i.id}>
                <td><strong>{i.email}</strong></td>
                <td>{i.role_name}{i.department_name && <div className="cell-sub">{i.department_name}</div>}</td>
                <td>{i.invited_by_name}</td>
                <td>{i.expired ? <span className="badge badge-warning">Expired</span> : <span className="muted">{formatDate(i.expires_at)}</span>}</td>
                <td className="actions">
                  <button className="btn btn-sm" onClick={() => setCreatingLogin(i)}>Create login</button>
                  <button className="btn btn-sm" disabled={action.isPending} onClick={() => action.mutate({ id: i.id, kind: 'resend', email: i.email })}>Resend</button>
                  <button className="btn btn-sm btn-danger" disabled={action.isPending} onClick={() => action.mutate({ id: i.id, kind: 'revoke', email: i.email })}>Revoke</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function RoleAndDepartmentOptions() {
  const roles = useQuery(rolesQuery);
  const departments = useQuery(departmentsQuery('active'));
  return { roles: (roles.data ?? []).filter((r) => r.invitable), departments: departments.data ?? [] };
}

function InviteDialog({ onClose, onSent }: { onClose: () => void; onSent: (l: { link?: string | null; email: string }) => void }) {
  const queryClient = useQueryClient();
  const { roles, departments } = RoleAndDepartmentOptions();
  const [email, setEmail] = useState('');
  const [roleCode, setRoleCode] = useState('');
  const [departmentId, setDepartmentId] = useState('');

  const invite = useMutation({
    mutationFn: () => api<{ data: { invite_link?: string | null } }>('POST', '/users/invitations', { email, role_code: roleCode, department_id: departmentId || null }),
    onSuccess: async (r) => {
      await queryClient.invalidateQueries({ queryKey: ['invitations'] });
      onSent({ link: r.data.invite_link, email });
      onClose();
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    invite.mutate();
  };

  return (
    <Dialog
      open
      title="Invite user"
      onClose={onClose}
      footer={
        <>
          <button className="btn" type="button" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" type="submit" form="invite-form" disabled={invite.isPending || !email || !roleCode}>Send invitation</button>
        </>
      }
    >
      <form id="invite-form" onSubmit={submit} noValidate>
        <FormError error={invite.error && !fieldError(invite.error, 'email') ? invite.error : null} />
        <Field id="invite-email" label="Work email" error={fieldError(invite.error, 'email')}>
          <input id="invite-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
        </Field>
        <Field id="invite-role" label="Role">
          <select id="invite-role" value={roleCode} onChange={(e) => setRoleCode(e.target.value)}>
            <option value="" disabled>Choose a role</option>
            {roles.map((r) => <option key={r.code} value={r.code}>{r.name}</option>)}
          </select>
        </Field>
        <Field id="invite-dept" label="Department" hint="Company-wide gives access across all departments.">
          <select id="invite-dept" value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}>
            <option value="">Company-wide</option>
            {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </Field>
        <p className="muted" style={{ fontSize: 12, margin: 0 }}>The link expires in 72 hours. Agency members are invited from Agency management.</p>
      </form>
    </Dialog>
  );
}

function RolesDialog({ user, onClose }: { user: UserRow; onClose: () => void }) {
  const queryClient = useQueryClient();
  const { roles, departments } = RoleAndDepartmentOptions();
  const [rows, setRows] = useState(user.roles.map((r) => ({ role_code: r.code, department_id: r.department_id ?? '' })));

  const save = useMutation({
    mutationFn: () =>
      api('PUT', `/users/${user.id}/roles`, {
        assignments: rows.filter((r) => r.role_code).map((r) => ({ role_code: r.role_code, department_id: r.department_id || null })),
      }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['users'] }),
        queryClient.invalidateQueries({ queryKey: ['me'] }),
      ]);
      onClose();
    },
  });

  const update = (i: number, patch: Partial<(typeof rows)[number]>) =>
    setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  return (
    <Dialog
      open
      title={`Roles for ${user.full_name}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={() => save.mutate()} disabled={save.isPending || rows.every((r) => !r.role_code)}>Save roles</button>
        </>
      }
    >
      <FormError error={save.error} />
      {rows.map((row, i) => (
        <div className="role-row" key={i}>
          <select aria-label="Role" value={row.role_code} onChange={(e) => update(i, { role_code: e.target.value })}>
            <option value="" disabled>Choose a role</option>
            {roles.map((r) => <option key={r.code} value={r.code}>{r.name}</option>)}
          </select>
          <select aria-label="Department" value={row.department_id} onChange={(e) => update(i, { department_id: e.target.value })}>
            <option value="">Company-wide</option>
            {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
          <button className="btn btn-sm" onClick={() => setRows(rows.filter((_, j) => j !== i))} disabled={rows.length === 1} aria-label="Remove role">
            Remove
          </button>
        </div>
      ))}
      <button className="btn btn-link" onClick={() => setRows([...rows, { role_code: '', department_id: '' }])}>+ Add another role</button>
      <p className="muted" style={{ fontSize: 12 }}>Changes apply on the user's next action, without signing in again.</p>
    </Dialog>
  );
}

function ToggleUserDialog({ user, onClose }: { user: UserRow; onClose: () => void }) {
  const queryClient = useQueryClient();
  const deactivate = user.status === 'active';
  const mutation = useMutation({
    mutationFn: () => api('PATCH', `/users/${user.id}`, { status: deactivate ? 'inactive' : 'active' }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['users'] });
      onClose();
    },
  });
  return (
    <Dialog
      open
      title={deactivate ? `Deactivate ${user.full_name}?` : `Reactivate ${user.full_name}?`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className={`btn ${deactivate ? 'btn-danger' : 'btn-primary'}`} onClick={() => mutation.mutate()} disabled={mutation.isPending}>
            {deactivate ? 'Deactivate' : 'Reactivate'}
          </button>
        </>
      }
    >
      <FormError error={mutation.error} />
      <p style={{ marginTop: 0 }}>
        {deactivate
          ? 'They are signed out everywhere immediately and can no longer sign in. Their history is kept.'
          : 'They can sign in again with their existing password and roles.'}
      </p>
    </Dialog>
  );
}
