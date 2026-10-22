import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState, type FormEvent, type ReactNode } from 'react';
import { api } from '../api';
import { generatePassword } from '../components/CreateLoginDialog';
import { MultiPick } from '../components/MultiPick';
import { Field, fieldError, FormError } from '../components/ui';
import { agenciesQuery, departmentsQuery, usersQuery, vacanciesQuery } from '../queries';

const STEPS = ['Departments', 'Jobs', 'Recruiters', 'Agencies'] as const;

/**
 * First-time setup for a new company, in four short steps: departments, jobs, recruiters, agencies.
 * Each step can be skipped; everything can be added or changed later from its own page.
 */
export function OnboardingPage() {
  const [step, setStep] = useState(0);
  const done = step >= STEPS.length;
  return (
    <>
      <div className="page-header"><div><h1>Set up your company</h1><p>Four quick steps. Skip anything you are not ready for; you can add more later from each page.</p></div></div>
      <ol className="steps" aria-label="Setup steps">
        {STEPS.map((s, i) => (
          <li key={s} data-active={i === step} data-done={i < step}>
            <button type="button" className="step-btn" onClick={() => setStep(i)}><span>{i < step ? '✓' : i + 1}</span> {s}</button>
          </li>
        ))}
      </ol>
      {step === 0 && <DepartmentsStep />}
      {step === 1 && <JobsStep />}
      {step === 2 && <RecruitersStep />}
      {step === 3 && <AgenciesStep />}
      {done ? (
        <div className="card section sourcing-done" role="status">
          <h2>You are set up</h2>
          <p className="muted">Recruiters can now source candidates for their jobs. Add anything else whenever you need it.</p>
          <div className="actions-row">
            <Link className="btn btn-primary" to="/">Go to dashboard</Link>
            <Link className="btn" to="/vacancies">Jobs</Link>
            <Link className="btn" to="/users">Team &amp; roles</Link>
          </div>
        </div>
      ) : (
        <div className="actions-row" style={{ marginTop: 16, justifyContent: 'space-between' }}>
          <button className="btn" type="button" disabled={step === 0} onClick={() => setStep(step - 1)}>Back</button>
          <div className="actions-row">
            <button className="btn btn-link" type="button" onClick={() => setStep(step + 1)}>Skip</button>
            <button className="btn btn-primary" type="button" onClick={() => setStep(step + 1)}>{step === STEPS.length - 1 ? 'Finish' : 'Next'}</button>
          </div>
        </div>
      )}
    </>
  );
}

function StepCard({ title, help, added, children }: { title: string; help: string; added: ReactNode; children: ReactNode }) {
  return (
    <div className="onboard-grid">
      <div className="card section"><h2>{title}</h2><p className="muted" style={{ marginTop: 0 }}>{help}</p>{children}</div>
      <div className="card section"><h2>Added so far</h2>{added}</div>
    </div>
  );
}

const List = ({ items, empty }: { items: ReactNode[]; empty: string }) =>
  items.length ? <ul className="onboard-list">{items.map((x, i) => <li key={i}>{x}</li>)}</ul> : <p className="muted">{empty}</p>;

function useRefresh() {
  const queryClient = useQueryClient();
  return () => Promise.all(['departments', 'vacancies', 'users', 'agencies', 'hr-dashboard', 'hiring-home'].map((k) => queryClient.invalidateQueries({ queryKey: [k] })));
}

function DepartmentsStep() {
  const list = useQuery(departmentsQuery('active'));
  const refresh = useRefresh();
  const [name, setName] = useState('');
  const add = useMutation({ mutationFn: () => api('POST', '/departments', { name }), onSuccess: async () => { setName(''); await refresh(); } });
  const submit = (e: FormEvent) => { e.preventDefault(); add.mutate(); };
  return (
    <StepCard title="Departments" help="Teams you hire for, e.g. Sales, Operations, Tele Sales." added={<List items={(list.data ?? []).map((d) => d.name)} empty="No departments yet." />}>
      <form onSubmit={submit} noValidate>
        <FormError error={add.error && !fieldError(add.error, 'name') ? add.error : null} />
        <Field id="ob-dept" label="Department name" error={fieldError(add.error, 'name')}><input id="ob-dept" value={name} onChange={(e) => setName(e.target.value)} autoFocus /></Field>
        <button className="btn btn-primary" type="submit" disabled={!name.trim() || add.isPending}>Add department</button>
      </form>
    </StepCard>
  );
}

function JobsStep() {
  const departments = useQuery(departmentsQuery('active'));
  const jobs = useQuery(vacanciesQuery({ status: 'open', q: '', department_id: '', page: 1 }));
  const refresh = useRefresh();
  const empty = { title: '', department_id: '', location: '', openings: '1', terms_owner: 'admin' };
  const [f, setF] = useState(empty);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const add = useMutation({
    mutationFn: () => api('POST', '/jobs', { title: f.title, department_id: f.department_id, location: f.location, openings: Number(f.openings), terms_owner: f.terms_owner, salary_min: null, salary_max: null, description: '' }),
    onSuccess: async () => { setF((x) => ({ ...empty, department_id: x.department_id })); await refresh(); },
  });
  const submit = (e: FormEvent) => { e.preventDefault(); add.mutate(); };
  return (
    <StepCard title="Jobs" help="Open positions. Salary range and description can be added later from the job."
      added={<List items={(jobs.data?.data ?? []).map((j) => `${j.title} · ${j.department_name} · ${j.headcount} opening${j.headcount === 1 ? '' : 's'}`)} empty="No jobs yet." />}>
      {departments.data?.length === 0 ? <p className="muted">Add a department first (step 1).</p> : (
        <form onSubmit={submit} noValidate>
          <FormError error={add.error && !(add.error as { details?: unknown }).details ? add.error : null} />
          <Field id="ob-title" label="Job title" error={fieldError(add.error, 'title')}><input id="ob-title" value={f.title} onChange={set('title')} autoFocus /></Field>
          <div className="form-grid">
            <Field id="ob-jd" label="Department"><select id="ob-jd" value={f.department_id} onChange={set('department_id')}><option value="">Choose…</option>{(departments.data ?? []).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></Field>
            <Field id="ob-loc" label="Location" error={fieldError(add.error, 'location')}><input id="ob-loc" value={f.location} onChange={set('location')} /></Field>
            <Field id="ob-open" label="Openings"><input id="ob-open" type="number" min={1} value={f.openings} onChange={set('openings')} /></Field>
            <Field id="ob-terms" label="Who finalises salary & joining?">
              <select id="ob-terms" value={f.terms_owner} onChange={set('terms_owner')}><option value="admin">Admin</option><option value="recruiter">Recruiter on this job</option><option value="interviewer">Interviewer who selects</option></select>
            </Field>
          </div>
          <button className="btn btn-primary" type="submit" disabled={add.isPending || !f.title.trim() || !f.department_id || !f.location.trim() || !f.openings}>Add job</button>
        </form>
      )}
    </StepCard>
  );
}

/** Sign-in details to hand over (no email needed). */
function Credentials({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="alert alert-success" role="status" style={{ marginTop: 12 }}>
      <p style={{ margin: '0 0 6px' }}>Created. Send these sign-in details privately:</p>
      <textarea readOnly rows={4} value={text} style={{ width: '100%' }} onFocus={(e) => e.target.select()} />
      <button className="btn btn-sm" type="button" onClick={async () => { await navigator.clipboard?.writeText(text); setCopied(true); }}>{copied ? 'Copied' : 'Copy details'}</button>
    </div>
  );
}

function RecruitersStep() {
  const users = useQuery(usersQuery('active', ''));
  const jobs = useQuery(vacanciesQuery({ status: 'open', q: '', department_id: '', page: 1 }));
  const refresh = useRefresh();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [jobIds, setJobIds] = useState<string[]>([]);
  const [created, setCreated] = useState<string | null>(null);
  const add = useMutation({
    mutationFn: async () => {
      const password = generatePassword();
      const r = await api<{ data: { user_id: string } }>('POST', '/users', { full_name: name, email, password, role_code: 'internal_recruiter' });
      for (const id of jobIds) await api('POST', `/vacancies/${id}/assign-recruiter`, { user_id: r.data.user_id });
      return `Login: ${window.location.origin}/login\nEmail: ${email}\nPassword: ${password}\n(Change your password after signing in.)`;
    },
    onSuccess: async (text) => { setCreated(text); setName(''); setEmail(''); setJobIds([]); await refresh(); },
  });
  const submit = (e: FormEvent) => { e.preventDefault(); setCreated(null); add.mutate(); };
  const recruiters = (users.data?.data ?? []).filter((u) => u.roles.some((r) => r.code === 'internal_recruiter'));
  return (
    <StepCard title="Recruiters" help="Your company's recruiters. Pick the jobs each one works on; they see only those."
      added={<List items={recruiters.map((u) => `${u.full_name} · ${u.email}`)} empty="No recruiters yet." />}>
      <form onSubmit={submit} noValidate>
        <FormError error={add.error && !fieldError(add.error, 'email') ? add.error : null} />
        <Field id="ob-rn" label="Name"><input id="ob-rn" value={name} onChange={(e) => setName(e.target.value)} autoFocus /></Field>
        <Field id="ob-re" label="Email (they sign in with this)" error={fieldError(add.error, 'email')}><input id="ob-re" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" /></Field>
        <Field id="ob-rj" label="Jobs they work on">
          <MultiPick label="Jobs" value={jobIds} onChange={setJobIds} options={(jobs.data?.data ?? []).map((j) => ({ id: j.id, name: j.title }))} />
        </Field>
        <button className="btn btn-primary" type="submit" disabled={add.isPending || !name.trim() || !email.trim()}>{add.isPending ? 'Adding…' : 'Add recruiter'}</button>
      </form>
      {created && <Credentials text={created} />}
    </StepCard>
  );
}

function AgenciesStep() {
  const agencies = useQuery(agenciesQuery('active'));
  const jobs = useQuery(vacanciesQuery({ status: 'open', q: '', department_id: '', page: 1 }));
  const refresh = useRefresh();
  const [name, setName] = useState('');
  const [contact, setContact] = useState('');
  const [email, setEmail] = useState('');
  const [jobIds, setJobIds] = useState<string[]>([]);
  const [login, setLogin] = useState(true);
  const [created, setCreated] = useState<string | null>(null);
  const add = useMutation({
    mutationFn: async () => {
      const a = await api<{ data: { id: string } }>('POST', '/agencies', { name, primary_contact_name: contact || null, primary_contact_email: email || null });
      for (const id of jobIds) await api('POST', `/vacancies/${id}/assign-agency`, { agency_id: a.data.id });
      if (!login || !email) return null;
      const password = generatePassword();
      await api('POST', '/users', { full_name: contact || name, email, password, role_code: 'agency_admin', agency_id: a.data.id });
      return `Login: ${window.location.origin}/login\nEmail: ${email}\nPassword: ${password}\n(Change your password after signing in.)`;
    },
    onSuccess: async (text) => { setCreated(text); setName(''); setContact(''); setEmail(''); setJobIds([]); await refresh(); },
  });
  const submit = (e: FormEvent) => { e.preventDefault(); setCreated(null); add.mutate(); };
  return (
    <StepCard title="Agencies" help="Recruiting partners. Pick the jobs they may source for; the agency admin can add their own sub-recruiters."
      added={<List items={(agencies.data ?? []).map((a) => `${a.name}${a.assigned_vacancies ? ` · ${a.assigned_vacancies} job${a.assigned_vacancies === 1 ? '' : 's'}` : ''}`)} empty="No agencies yet." />}>
      <form onSubmit={submit} noValidate>
        <FormError error={add.error && !fieldError(add.error, 'name') ? add.error : null} />
        <Field id="ob-an" label="Agency name" error={fieldError(add.error, 'name')}><input id="ob-an" value={name} onChange={(e) => setName(e.target.value)} autoFocus /></Field>
        <div className="form-grid">
          <Field id="ob-ac" label="Contact person"><input id="ob-ac" value={contact} onChange={(e) => setContact(e.target.value)} /></Field>
          <Field id="ob-ae" label="Contact email" error={fieldError(add.error, 'primary_contact_email')}><input id="ob-ae" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" /></Field>
        </div>
        <Field id="ob-aj" label="Jobs they can source for">
          <MultiPick label="Jobs" value={jobIds} onChange={setJobIds} options={(jobs.data?.data ?? []).map((j) => ({ id: j.id, name: j.title }))} />
        </Field>
        <label className="multi-pick-item" style={{ paddingLeft: 0 }}><input type="checkbox" checked={login} onChange={(e) => setLogin(e.target.checked)} /> Create a login for the contact (agency admin)</label>
        <button className="btn btn-primary" type="submit" disabled={add.isPending || name.trim().length < 2 || (login && !email.trim())} style={{ marginTop: 8 }}>{add.isPending ? 'Adding…' : 'Add agency'}</button>
      </form>
      {created && <Credentials text={created} />}
    </StepCard>
  );
}
