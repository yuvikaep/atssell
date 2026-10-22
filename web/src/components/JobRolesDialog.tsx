import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { api } from '../api';
import { jobRolesQuery } from '../queries';
import { Dialog, ErrorState, Field, fieldError, FormError, Loading, StatusBadge } from './ui';

/** The job roles of one department: add, rename, turn off. Recruiters pick from these while sourcing. */
export function JobRolesDialog({ department, onClose }: { department: { id: string; name: string }; onClose: () => void }) {
  const queryClient = useQueryClient();
  const list = useQuery(jobRolesQuery(department.id, 'all'));
  const [name, setName] = useState('');
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['job-roles'] });
  const add = useMutation({
    mutationFn: () => api('POST', '/job-roles', { department_id: department.id, name }),
    onSuccess: async () => { setName(''); await refresh(); },
  });
  const update = useMutation({
    mutationFn: (v: { id: string; name?: string; status?: 'active' | 'inactive' }) => api('PATCH', `/job-roles/${v.id}`, { name: v.name, status: v.status }),
    onSuccess: refresh,
  });
  const submit = (e: FormEvent) => { e.preventDefault(); add.mutate(); };

  return (
    <Dialog open wide title={`Job roles in ${department.name}`} onClose={onClose}
      footer={<button className="btn btn-primary" type="button" onClick={onClose}>Done</button>}>
      <form onSubmit={submit} noValidate style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
        <div style={{ flex: 1 }}>
          <Field id="jr-name" label="New role" hint="For example: Sales Executive, Backend Developer." error={fieldError(add.error, 'name')}>
            <input id="jr-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} autoFocus />
          </Field>
        </div>
        <button className="btn btn-primary" type="submit" disabled={!name.trim() || add.isPending} style={{ marginBottom: 18 }}>Add role</button>
      </form>
      <FormError error={add.error && !fieldError(add.error, 'name') ? add.error : update.error} />
      {list.isPending ? <Loading /> : list.isError ? <ErrorState error={list.error} onRetry={() => list.refetch()} /> : list.data.length === 0 ? (
        <p className="muted">No roles yet. Add the first one above.</p>
      ) : (
        <div className="table-wrap"><table>
          <thead><tr><th>Role</th><th className="num">Candidates sourced</th><th>Status</th><th /></tr></thead>
          <tbody>{list.data.map((r) => (
            <tr key={r.id}>
              <td><strong>{r.name}</strong></td>
              <td className="num">{r.sourced}</td>
              <td><StatusBadge status={r.status} /></td>
              <td className="actions">
                <button className="btn btn-sm" type="button" onClick={() => { const n = window.prompt('Rename role', r.name)?.trim(); if (n && n !== r.name) update.mutate({ id: r.id, name: n }); }}>Rename</button>
                <button className={`btn btn-sm ${r.status === 'active' ? 'btn-danger' : ''}`} type="button" disabled={update.isPending}
                  onClick={() => update.mutate({ id: r.id, status: r.status === 'active' ? 'inactive' : 'active' })}>{r.status === 'active' ? 'Turn off' : 'Turn on'}</button>
              </td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
    </Dialog>
  );
}
