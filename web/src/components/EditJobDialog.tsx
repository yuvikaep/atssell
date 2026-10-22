import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, type VacancyDetail } from '../api';
import { Dialog, Field, fieldError, FormError } from './ui';

const str = (v: number | string | null | undefined) => (v === null || v === undefined ? '' : String(Number(v)));
const num = (v: string) => (v.trim() === '' ? null : Number(v));

/** Edit an existing job: title, location, openings, salary range, job description (JD), skills, experience. */
export function EditJobDialog({ v, onClose }: { v: VacancyDetail; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [f, setF] = useState({
    title: v.title, location: v.location, openings: String(v.headcount), terms_owner: v.terms_owner,
    salary_min: str(v.min_ctc), salary_max: str(v.max_ctc), description: v.description ?? '', skills: (v.skills ?? []).join(', '),
    min_exp: str(v.min_experience_years), max_exp: str(v.max_experience_years),
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const save = useMutation({
    mutationFn: () => api('PATCH', `/jobs/${v.id}`, {
      title: f.title, location: f.location, openings: Number(f.openings), terms_owner: f.terms_owner,
      salary_min: num(f.salary_min), salary_max: num(f.salary_max), description: f.description,
      skills: f.skills.split(',').map((x) => x.trim()).filter(Boolean),
      min_experience_years: num(f.min_exp), max_experience_years: num(f.max_exp),
    }),
    onSuccess: async () => { await Promise.all(['vacancy', 'vacancies', 'hiring-home', 'hr-dashboard'].map((k) => queryClient.invalidateQueries({ queryKey: [k] }))); onClose(); },
  });
  const err = (k: string) => fieldError(save.error, k);
  return (
    <Dialog open wide title="Edit job" onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={save.isPending || !f.title.trim() || !f.location.trim() || !f.openings} onClick={() => save.mutate()}>{save.isPending ? 'Saving…' : 'Save changes'}</button></>}>
      <FormError error={save.error && !(save.error as { details?: unknown }).details ? save.error : null} />
      <div className="form-grid">
        <div className="span-2"><Field id="ej-title" label="Job title" error={err('title')}><input id="ej-title" value={f.title} onChange={set('title')} maxLength={200} /></Field></div>
        <Field id="ej-loc" label="Location" error={err('location')}><input id="ej-loc" value={f.location} onChange={set('location')} /></Field>
        <Field id="ej-open" label="Openings" error={err('openings')}><input id="ej-open" type="number" min={1} value={f.openings} onChange={set('openings')} /></Field>
        <Field id="ej-min" label="Salary from (₹ per year)" error={err('salary_min')}><input id="ej-min" type="number" min={0} value={f.salary_min} onChange={set('salary_min')} /></Field>
        <Field id="ej-max" label="Salary to (₹ per year)" error={err('salary_max')}><input id="ej-max" type="number" min={0} value={f.salary_max} onChange={set('salary_max')} /></Field>
        <Field id="ej-exmin" label="Experience from (years)"><input id="ej-exmin" type="number" min={0} step="0.5" value={f.min_exp} onChange={set('min_exp')} /></Field>
        <Field id="ej-exmax" label="Experience to (years)" error={err('max_experience_years')}><input id="ej-exmax" type="number" min={0} step="0.5" value={f.max_exp} onChange={set('max_exp')} /></Field>
        <Field id="ej-terms" label="Who finalises salary & joining?">
          <select id="ej-terms" value={f.terms_owner} onChange={set('terms_owner')}>
            <option value="admin">Admin</option><option value="recruiter">Recruiter on this job</option><option value="interviewer">Interviewer who selects</option>
          </select>
        </Field>
        <Field id="ej-skills" label="Skills" hint="Separate with commas."><input id="ej-skills" value={f.skills} onChange={set('skills')} /></Field>
        <div className="span-2"><Field id="ej-jd" label="Job description (JD)" hint="Responsibilities, requirements, shift, benefits. Recruiters and agencies see this." error={err('description')}>
          <textarea id="ej-jd" rows={8} value={f.description} onChange={set('description')} maxLength={10000} />
        </Field></div>
      </div>
    </Dialog>
  );
}
