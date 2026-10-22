import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { api } from '../api';
import { departmentsQuery } from '../queries';
import { Dialog, Field, fieldError, FormError } from './ui';

/** One form for a job: title, department, location, openings and salary range. The job opens straight away. */
export function NewJobDialog({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const departments = useQuery(departmentsQuery('active'));
  const [f, setF] = useState({ title: '', department_id: '', location: '', openings: '1', terms_owner: 'admin', salary_min: '', salary_max: '', description: '' });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const num = (v: string) => (v.trim() === '' ? null : Number(v));
  const create = useMutation({
    mutationFn: () => api<{ data: { id: string } }>('POST', '/jobs', {
      title: f.title, department_id: f.department_id, location: f.location, openings: Number(f.openings), terms_owner: f.terms_owner,
      salary_min: num(f.salary_min), salary_max: num(f.salary_max), description: f.description,
    }),
    onSuccess: async (r) => {
      await Promise.all(['vacancies', 'hr-dashboard'].map((k) => queryClient.invalidateQueries({ queryKey: [k] })));
      onClose();
      await navigate({ to: '/vacancies/$id', params: { id: r.data.id } });
    },
  });
  return (
    <Dialog open wide title="New job" onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={create.isPending || !f.title.trim() || !f.department_id || !f.location.trim() || !f.openings} onClick={() => create.mutate()}>Create job</button></>}>
      <FormError error={create.error && !(create.error as { details?: unknown }).details ? create.error : null} />
      <div className="form-grid">
        <div className="span-2"><Field id="job-title" label="Job title" error={fieldError(create.error, 'title')}><input id="job-title" value={f.title} onChange={set('title')} maxLength={200} autoFocus /></Field></div>
        <Field id="job-dept" label="Department"><select id="job-dept" value={f.department_id} onChange={set('department_id')}><option value="">Choose…</option>{(departments.data ?? []).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></Field>
        <Field id="job-loc" label="Location" error={fieldError(create.error, 'location')}><input id="job-loc" value={f.location} onChange={set('location')} /></Field>
        <Field id="job-open" label="Openings" error={fieldError(create.error, 'openings')}><input id="job-open" type="number" min={1} value={f.openings} onChange={set('openings')} /></Field>
        <Field id="job-terms" label="Who finalises salary & joining?" hint="They enter it after selection; the admin approves.">
          <select id="job-terms" value={f.terms_owner} onChange={set('terms_owner')}>
            <option value="admin">Admin</option>
            <option value="recruiter">Recruiter on this job</option>
            <option value="interviewer">Interviewer who selects</option>
          </select>
        </Field>
        <Field id="job-min" label="Salary from (₹ per year)"><input id="job-min" type="number" min={0} value={f.salary_min} onChange={set('salary_min')} /></Field>
        <Field id="job-max" label="Salary to (₹ per year)" error={fieldError(create.error, 'salary_max')}><input id="job-max" type="number" min={0} value={f.salary_max} onChange={set('salary_max')} /></Field>
        <div className="span-2"><Field id="job-desc" label="Job description (JD)" hint="Optional now; you can edit it later from the job."><textarea id="job-desc" rows={5} value={f.description} onChange={set('description')} /></Field></div>
      </div>
      <p className="cell-sub">After creating the job, assign recruiters and agencies from its page.</p>
    </Dialog>
  );
}
