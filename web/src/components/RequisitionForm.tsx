import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { api, canAll, EMPLOYMENT_TYPES, type RequisitionDetail } from '../api';
import { departmentsQuery, usersQuery } from '../queries';
import { useMe } from './AppShell';
import { Dialog, Field, fieldError, FormError } from './ui';

const num = (v: string) => (v.trim() === '' ? null : Number(v));
const str = (n: number | null | undefined) => (n == null ? '' : String(n));

/** Create (no `requisition`) or edit a draft or rejected requisition. */
export function RequisitionFormDialog({ requisition, onClose }: { requisition?: RequisitionDetail; onClose: () => void }) {
  const me = useMe();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const departments = useQuery(departmentsQuery('active'));
  const canPickManager = canAll(me, 'users.manage');
  const users = useQuery({ ...usersQuery('active', ''), enabled: canPickManager });

  const [f, setF] = useState({
    department_id: requisition?.department_id ?? '',
    title: requisition?.title ?? '',
    headcount: str(requisition?.headcount ?? 1),
    employment_type: requisition?.employment_type ?? 'full_time',
    location: requisition?.location ?? '',
    description: requisition?.description ?? '',
    skills: (requisition?.skills ?? []).join(', '),
    min_experience_years: str(requisition?.min_experience_years),
    max_experience_years: str(requisition?.max_experience_years),
    min_ctc: str(requisition?.min_ctc),
    max_ctc: str(requisition?.max_ctc),
    priority: requisition?.priority ?? 'normal',
    target_date: requisition?.target_date?.slice(0, 10) ?? '',
    hiring_manager_id: requisition?.hiring_manager_id ?? '',
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  const save = useMutation({
    mutationFn: () => {
      const body = {
        department_id: f.department_id,
        title: f.title,
        headcount: Number(f.headcount),
        employment_type: f.employment_type,
        location: f.location,
        description: f.description,
        skills: f.skills.split(',').map((s) => s.trim()).filter(Boolean),
        min_experience_years: num(f.min_experience_years),
        max_experience_years: num(f.max_experience_years),
        min_ctc: num(f.min_ctc),
        max_ctc: num(f.max_ctc),
        priority: f.priority,
        target_date: f.target_date || null,
        ...(canPickManager ? { hiring_manager_id: f.hiring_manager_id || null } : {}),
      };
      return requisition
        ? api<{ data: RequisitionDetail }>('PATCH', `/requisitions/${requisition.id}`, body)
        : api<{ data: RequisitionDetail }>('POST', '/requisitions', body);
    },
    onSuccess: async (res) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['requisitions'] }),
        queryClient.invalidateQueries({ queryKey: ['requisition', res.data.id] }),
      ]);
      onClose();
      if (!requisition) await navigate({ to: '/requisitions/$id', params: { id: res.data.id } });
    },
  });

  const err = (path: string) => fieldError(save.error, path);
  const generic = save.error && !(save.error as { details?: unknown }).details ? save.error : null;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };

  return (
    <Dialog
      open
      wide
      title={requisition ? 'Edit hiring request' : 'New hiring request'}
      onClose={onClose}
      footer={
        <>
          <button className="btn" type="button" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" type="submit" form="rq-form" disabled={save.isPending || !f.department_id || !f.title.trim()}>
            {requisition ? 'Save changes' : 'Save draft'}
          </button>
        </>
      }
    >
      <form id="rq-form" onSubmit={submit} noValidate>
        <FormError error={generic} />
        <div className="form-grid">
          <Field id="rq-title" label="Job title" error={err('title')}>
            <input id="rq-title" value={f.title} onChange={set('title')} autoFocus maxLength={200} />
          </Field>
          <Field id="rq-dept" label="Department" error={err('department_id')}>
            <select id="rq-dept" value={f.department_id} onChange={set('department_id')}>
              <option value="" disabled>Choose a department</option>
              {(departments.data ?? []).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </Field>
          <Field id="rq-headcount" label="Positions" error={err('headcount')}>
            <input id="rq-headcount" type="number" min={1} value={f.headcount} onChange={set('headcount')} />
          </Field>
          <Field id="rq-type" label="Employment type">
            <select id="rq-type" value={f.employment_type} onChange={set('employment_type')}>
              {Object.entries(EMPLOYMENT_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </Field>
          <Field id="rq-location" label="Location" error={err('location')}>
            <input id="rq-location" value={f.location} onChange={set('location')} />
          </Field>
          <Field id="rq-priority" label="Priority">
            <select id="rq-priority" value={f.priority} onChange={set('priority')}>
              <option value="low">Low</option><option value="normal">Normal</option>
              <option value="high">High</option><option value="critical">Critical</option>
            </select>
          </Field>
          <div className="span-2">
            <Field id="rq-description" label="Job description" error={err('description')}>
              <textarea id="rq-description" value={f.description} onChange={set('description')} />
            </Field>
          </div>
          <div className="span-2">
            <Field id="rq-skills" label="Skills" hint="Separate with commas.">
              <input id="rq-skills" value={f.skills} onChange={set('skills')} />
            </Field>
          </div>
          <Field id="rq-minexp" label="Min experience (years)" error={err('min_experience_years')}>
            <input id="rq-minexp" type="number" min={0} step="0.5" value={f.min_experience_years} onChange={set('min_experience_years')} />
          </Field>
          <Field id="rq-maxexp" label="Max experience (years)" error={err('max_experience_years')}>
            <input id="rq-maxexp" type="number" min={0} step="0.5" value={f.max_experience_years} onChange={set('max_experience_years')} />
          </Field>
          <Field id="rq-minctc" label="Min CTC (₹ per year)" error={err('min_ctc')}>
            <input id="rq-minctc" type="number" min={0} value={f.min_ctc} onChange={set('min_ctc')} />
          </Field>
          <Field id="rq-maxctc" label="Max CTC (₹ per year)" error={err('max_ctc')}>
            <input id="rq-maxctc" type="number" min={0} value={f.max_ctc} onChange={set('max_ctc')} />
          </Field>
          <Field id="rq-target" label="Target start date" error={err('target_date')}>
            <input id="rq-target" type="date" value={f.target_date} onChange={set('target_date')} />
          </Field>
          {canPickManager && (
            <Field id="rq-manager" label="Hiring manager">
              <select id="rq-manager" value={f.hiring_manager_id} onChange={set('hiring_manager_id')}>
                <option value="">Not set</option>
                {(users.data?.data ?? []).map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}
              </select>
            </Field>
          )}
        </div>
      </form>
    </Dialog>
  );
}
