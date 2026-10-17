import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { api, can, type Agency } from '../api';
import { useMe } from '../components/AppShell';
import { Dialog, EmptyState, ErrorState, Field, fieldError, Forbidden, FormError, Loading, StatusBadge } from '../components/ui';
import { agenciesQuery } from '../queries';
import { useSessionState } from '../session-storage';

const STATUSES = ['active', 'inactive', 'all'] as const;

export function AgenciesPage() {
  const me = useMe();
  const allowed = can(me, 'agencies.manage');
  const [status, setStatus] = useSessionState('jm.agencies.status', 'active', STATUSES);
  const [editing, setEditing] = useState<Agency | 'new' | null>(null);
  const list = useQuery({ ...agenciesQuery(status), enabled: allowed });
  const queryClient = useQueryClient();
  const toggle = useMutation({
    mutationFn: (a: Agency) => api('PATCH', `/agencies/${a.id}`, { status: a.status === 'active' ? 'inactive' : 'active' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['agencies'] }),
  });
  if (!allowed) return <Forbidden />;

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Agencies</h1>
          <p>External recruiting partners. Invite their people, then assign the agency to vacancies. The first to source a candidate is credited automatically; later attempts are rejected as duplicates.</p>
        </div>
        <button className="btn btn-primary" onClick={() => setEditing('new')}>Add agency</button>
      </div>
      <div className="card">
        <div className="toolbar">
          <select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value as (typeof STATUSES)[number])}>
            <option value="active">Active</option><option value="inactive">Inactive</option><option value="all">All</option>
          </select>
        </div>
        {toggle.error && <div style={{ padding: '12px 12px 0' }}><FormError error={toggle.error} /></div>}
        {list.isPending ? <Loading /> : list.isError ? <ErrorState error={list.error} onRetry={() => list.refetch()} /> : list.data.length === 0 ? (
          <EmptyState title="No agencies" action={status === 'active' ? <button className="btn btn-primary" onClick={() => setEditing('new')}>Add the first agency</button> : undefined}>
            Add the agencies you work with, then assign them to vacancies.
          </EmptyState>
        ) : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Agency</th><th>Contact</th><th className="num">Open vacancies</th><th>Status</th><th /></tr></thead>
              <tbody>
                {list.data.map((a) => (
                  <tr key={a.id}>
                    <td><Link className="row-link" to="/agencies/$id" params={{ id: a.id }}>{a.name}</Link><div className="cell-sub">{a.members} {a.members === 1 ? 'member' : 'members'}</div></td>
                    <td>{a.primary_contact_name ?? <span className="muted">—</span>}<div className="cell-sub">{a.primary_contact_email}</div></td>
                    <td className="num">{a.assigned_vacancies}</td>
                    <td><StatusBadge status={a.status} /></td>
                    <td className="actions">
                      <Link className="btn btn-sm" to="/agencies/$id" params={{ id: a.id }}>Members</Link>
                      <button className="btn btn-sm" onClick={() => setEditing(a)}>Edit</button>
                      <button className={`btn btn-sm ${a.status === 'active' ? 'btn-danger' : ''}`} disabled={toggle.isPending} onClick={() => toggle.mutate(a)}>
                        {a.status === 'active' ? 'Deactivate' : 'Reactivate'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {editing && <AgencyDialog agency={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </>
  );
}

function AgencyDialog({ agency, onClose }: { agency: Agency | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(agency?.name ?? '');
  const [contact, setContact] = useState(agency?.primary_contact_name ?? '');
  const [email, setEmail] = useState(agency?.primary_contact_email ?? '');
  const save = useMutation({
    mutationFn: () => {
      const body = { name, primary_contact_name: contact.trim() || null, primary_contact_email: email.trim() || null };
      return agency ? api('PATCH', `/agencies/${agency.id}`, body) : api('POST', '/agencies', body);
    },
    onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: ['agencies'] }); onClose(); },
  });
  const submit = (e: FormEvent) => { e.preventDefault(); save.mutate(); };
  return (
    <Dialog
      open title={agency ? `Edit ${agency.name}` : 'Add agency'} onClose={onClose}
      footer={
        <>
          <button className="btn" type="button" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" type="submit" form="agency-form" disabled={save.isPending || !name.trim()}>{agency ? 'Save changes' : 'Add agency'}</button>
        </>
      }
    >
      <form id="agency-form" onSubmit={submit} noValidate>
        <FormError error={save.error && !fieldError(save.error, 'name') && !fieldError(save.error, 'primary_contact_email') ? save.error : null} />
        <Field id="agency-name" label="Agency name" error={fieldError(save.error, 'name')}><input id="agency-name" value={name} onChange={(e) => setName(e.target.value)} autoFocus /></Field>
        <Field id="agency-contact" label="Primary contact"><input id="agency-contact" value={contact} onChange={(e) => setContact(e.target.value)} /></Field>
        <Field id="agency-email" label="Contact email" error={fieldError(save.error, 'primary_contact_email')}><input id="agency-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
      </form>
    </Dialog>
  );
}
