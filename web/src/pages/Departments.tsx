import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { api, can, canAll, type Department } from '../api';
import { useMe } from '../components/AppShell';
import { Dialog, EmptyState, ErrorState, Field, fieldError, Forbidden, FormError, Loading, StatusBadge } from '../components/ui';
import { departmentsQuery, usersQuery } from '../queries';
import { JobRolesDialog } from '../components/JobRolesDialog';
import { useSessionState } from '../session-storage';

const STATUSES = ['active', 'inactive', 'all'] as const;

type Editing = { mode: 'create' } | { mode: 'edit'; dept: Department } | null;

export function DepartmentsPage() {
  const me = useMe();
  const canManage = canAll(me, 'departments.manage');
  const [status, setStatus] = useSessionState('jm.departments.status', 'active', STATUSES);
  const [editing, setEditing] = useState<Editing>(null);
  const [toggling, setToggling] = useState<Department | null>(null);
  const [roles, setRoles] = useState<Department | null>(null);
  const list = useQuery({ ...departmentsQuery(status), enabled: can(me, 'departments.manage') || can(me, 'vacancies.view_all') });

  if (!can(me, 'departments.manage') && !can(me, 'vacancies.view_all')) return <Forbidden />;

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Departments</h1>
          <p>Requisitions, vacancies and department-scoped roles hang off these.</p>
        </div>
        {canManage && <button className="btn btn-primary" onClick={() => setEditing({ mode: 'create' })}>New department</button>}
      </div>

      <div className="card">
        <div className="toolbar">
          <label htmlFor="dept-status" className="muted">Status</label>
          <select id="dept-status" value={status} onChange={(e) => setStatus(e.target.value as (typeof STATUSES)[number])}>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
            <option value="all">All</option>
          </select>
        </div>
        {list.isPending ? (
          <Loading />
        ) : list.isError ? (
          <ErrorState error={list.error} onRetry={() => list.refetch()} />
        ) : list.data.length === 0 ? (
          <EmptyState
            title={status === 'active' ? 'No departments yet' : 'No departments match this filter'}
            action={canManage && status === 'active' ? <button className="btn btn-primary" onClick={() => setEditing({ mode: 'create' })}>Create the first department</button> : undefined}
          >
            {status === 'active' ? 'Create departments like Engineering or Sales to organize requisitions and access.' : undefined}
          </EmptyState>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Department</th>
                  <th>Parent</th>
                  <th>Head</th>
                  <th className="num">Open vacancies</th>
                  <th>Status</th>
                  {canManage && <th />}
                </tr>
              </thead>
              <tbody>
                {list.data.map((d) => (
                  <tr key={d.id}>
                    <td><strong>{d.name}</strong></td>
                    <td>{d.parent_name ?? <span className="muted">—</span>}</td>
                    <td>{d.head_name ?? <span className="muted">—</span>}</td>
                    <td className="num">{d.active_vacancies}</td>
                    <td><StatusBadge status={d.status} /></td>
                    {canManage && (
                      <td className="actions">
                        <button className="btn btn-sm" onClick={() => setRoles(d)}>Job roles</button>
                        <button className="btn btn-sm" onClick={() => setEditing({ mode: 'edit', dept: d })}>Edit</button>
                        <button className={`btn btn-sm ${d.status === 'active' ? 'btn-danger' : ''}`} onClick={() => setToggling(d)}>
                          {d.status === 'active' ? 'Deactivate' : 'Reactivate'}
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {editing && <DepartmentDialog editing={editing} onClose={() => setEditing(null)} />}
      {roles && <JobRolesDialog department={roles} onClose={() => setRoles(null)} />}
      {toggling && <ToggleStatusDialog dept={toggling} onClose={() => setToggling(null)} />}
    </>
  );
}

/** IDs of a department and everything under it; these cannot become its parent. */
function selfAndDescendants(all: Department[], id: string): Set<string> {
  const out = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const d of all) {
      if (d.parent_department_id && out.has(d.parent_department_id) && !out.has(d.id)) {
        out.add(d.id);
        grew = true;
      }
    }
  }
  return out;
}

function DepartmentDialog({ editing, onClose }: { editing: NonNullable<Editing>; onClose: () => void }) {
  const me = useMe();
  const queryClient = useQueryClient();
  const current = editing.mode === 'edit' ? editing.dept : null;
  const [name, setName] = useState(current?.name ?? '');
  const [parentId, setParentId] = useState(current?.parent_department_id ?? '');
  const [headId, setHeadId] = useState(current?.head_user_id ?? '');

  const departments = useQuery(departmentsQuery('active'));
  const canPickHead = canAll(me, 'users.manage');
  const users = useQuery({ ...usersQuery('active', ''), enabled: canPickHead });

  const excluded = current && departments.data ? selfAndDescendants(departments.data, current.id) : new Set<string>();
  const parentOptions = (departments.data ?? []).filter((d) => !excluded.has(d.id));

  const save = useMutation({
    mutationFn: () => {
      const body = {
        name,
        parent_department_id: parentId || null,
        ...(canPickHead ? { head_user_id: headId || null } : {}),
      };
      return current ? api('PATCH', `/departments/${current.id}`, body) : api('POST', '/departments', body);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['departments'] });
      onClose();
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };

  return (
    <Dialog
      open
      title={current ? `Edit ${current.name}` : 'New department'}
      onClose={onClose}
      footer={
        <>
          <button className="btn" type="button" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" type="submit" form="dept-form" disabled={save.isPending || !name.trim()}>
            {current ? 'Save changes' : 'Create department'}
          </button>
        </>
      }
    >
      <form id="dept-form" onSubmit={submit} noValidate>
        <FormError error={save.error && !fieldError(save.error, 'name') ? save.error : null} />
        <Field id="dept-name" label="Name" error={fieldError(save.error, 'name')}>
          <input id="dept-name" value={name} onChange={(e) => setName(e.target.value)} autoFocus maxLength={120} />
        </Field>
        <Field id="dept-parent" label="Parent department" hint="Optional. For sub-departments like Platform under Engineering.">
          <select id="dept-parent" value={parentId} onChange={(e) => setParentId(e.target.value)}>
            <option value="">None (top level)</option>
            {parentOptions.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </Field>
        {canPickHead && (
          <Field id="dept-head" label="Department head" hint="Optional.">
            <select id="dept-head" value={headId} onChange={(e) => setHeadId(e.target.value)}>
              <option value="">No head</option>
              {(users.data?.data ?? []).map((u) => <option key={u.id} value={u.id}>{u.full_name} ({u.email})</option>)}
            </select>
          </Field>
        )}
      </form>
    </Dialog>
  );
}

function ToggleStatusDialog({ dept, onClose }: { dept: Department; onClose: () => void }) {
  const queryClient = useQueryClient();
  const deactivate = dept.status === 'active';
  const mutation = useMutation({
    mutationFn: () => api('PATCH', `/departments/${dept.id}`, { status: deactivate ? 'inactive' : 'active' }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['departments'] });
      onClose();
    },
  });
  return (
    <Dialog
      open
      title={deactivate ? `Deactivate ${dept.name}?` : `Reactivate ${dept.name}?`}
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
          ? 'It will be hidden from pickers and no new requisitions can be raised for it. History is kept and you can reactivate it later.'
          : 'It will be available again for requisitions and role assignments.'}
      </p>
    </Dialog>
  );
}
