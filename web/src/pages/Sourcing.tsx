import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearch } from '@tanstack/react-router';
import { useDeferredValue, useState, type FormEvent } from 'react';
import { api, ApiError, SOURCE_LABEL, upload, type DuplicateMatch } from '../api';
import { AddCandidateDialog } from '../components/PipelineBoard';
import { candidateBody, CandidateFormFields, emptyCandidateForm, type CandidateForm } from '../components/CandidateForm';
import { ScheduleDialog } from '../components/ScheduleDialog';
import { EmptyState, ErrorState, Field, FormError, Loading } from '../components/ui';
import { hiringHomeQuery } from '../queries';

type Added = { applicationId: string; name: string };

/** Sourcing in two steps: first the job, then the candidate's details and resume. */
export function SourcingPage() {
  const search = useSearch({ strict: false }) as { job?: string };
  const jobs = useQuery(hiringHomeQuery);
  const [jobId, setJobId] = useState<string>(search.job ?? '');
  const [step, setStep] = useState<1 | 2>(search.job ? 2 : 1);
  const [added, setAdded] = useState<Added | null>(null);
  const job = jobs.data?.vacancies.find((v) => v.id === jobId);

  if (jobs.isPending) return <Loading />;
  if (jobs.isError) return <ErrorState error={jobs.error} onRetry={() => jobs.refetch()} />;
  if (jobs.data.vacancies.length === 0) {
    return <><div className="page-header"><div><h1>Sourcing</h1></div></div><div className="card"><EmptyState title="No jobs assigned yet">When your admin assigns you a job, you can start sourcing candidates for it here.</EmptyState></div></>;
  }

  return (
    <>
      <div className="page-header"><div><h1>Sourcing</h1><p>Pick the job, then add the candidate you found.</p></div></div>
      <ol className="steps" aria-label="Steps">
        <li data-active={step === 1} data-done={step === 2}><span>1</span> Choose the job</li>
        <li data-active={step === 2}><span>2</span> Candidate details</li>
      </ol>

      {step === 1 && (
        <div className="job-choices">
          {jobs.data.vacancies.map((v) => (
            <button key={v.id} className="job-choice" data-selected={v.id === jobId} onClick={() => { setJobId(v.id); setStep(2); setAdded(null); }}>
              <strong>{v.title}</strong>
              <span>{v.department} · {v.location}</span>
              <span className="job-count">{Object.values(v.funnel).reduce((a, b) => a + b, 0)} candidates so far</span>
            </button>
          ))}
        </div>
      )}

      {step === 2 && job && (added ? (
        <Done added={added} job={job.title} jobId={job.id} onAnother={() => setAdded(null)} onChange={() => { setStep(1); setAdded(null); }} />
      ) : (
        <CandidateStep jobId={job.id} jobTitle={job.title} onChangeJob={() => setStep(1)} onAdded={setAdded} />
      ))}
    </>
  );
}

function Done({ added, job, jobId, onAnother, onChange }: { added: Added; job: string; jobId: string; onAnother: () => void; onChange: () => void }) {
  const [scheduling, setScheduling] = useState(false);
  return (
    <div className="card section sourcing-done" role="status">
      <h2>{added.name} was added to {job}</h2>
      <p className="muted">Next, book an interview so the hiring team can meet them.</p>
      <div className="actions-row">
        <button className="btn btn-primary" onClick={() => setScheduling(true)}>Schedule interview</button>
        <button className="btn" onClick={onAnother}>Add another candidate</button>
        <button className="btn" onClick={onChange}>Choose a different job</button>
        <Link className="btn btn-link" to="/status" search={{ job: jobId } as never}>See candidate status</Link>
      </div>
      {scheduling && <ScheduleDialog applicationId={added.applicationId} vacancyId={jobId} onClose={() => setScheduling(false)} />}
    </div>
  );
}

function CandidateStep({ jobId, jobTitle, onChangeJob, onAdded }: { jobId: string; jobTitle: string; onChangeJob: () => void; onAdded: (a: Added) => void }) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<CandidateForm>(emptyCandidateForm);
  const [file, setFile] = useState<File | null>(null);
  const [source, setSource] = useState('internal_recruiter');
  const [finding, setFinding] = useState(false);
  const deferred = useDeferredValue({ name: form.full_name.trim(), email: form.email.trim(), phone: form.phone.trim() });
  const refresh = () => Promise.all(['candidate-status', 'hiring-home', 'candidates', 'applications', 'pipeline'].map((k) => queryClient.invalidateQueries({ queryKey: [k] })));

  const check = useQuery({
    queryKey: ['duplicate-check', deferred],
    queryFn: () => api<{ data: { exact: DuplicateMatch[]; possible: DuplicateMatch[] } }>('POST', '/candidates/duplicate-check', { full_name: deferred.name, email: deferred.email || null, phone: deferred.phone || null }).then((r) => r.data),
    enabled: deferred.name.length >= 3 || !!deferred.email || deferred.phone.length >= 8,
    retry: false,
  });

  const apply = (candidateId: string) => api<{ data: { id: string } }>('POST', '/applications', { candidate_id: candidateId, vacancy_id: jobId, source_type: source });
  const save = useMutation({
    mutationFn: async () => {
      const c = await api<{ data: { id: string } }>('POST', '/candidates', candidateBody(form, false));
      if (file) await upload(`/candidates/${c.data.id}/documents`, file, { document_type: 'resume' });
      const a = await apply(c.data.id);
      return { applicationId: a.data.id, name: form.full_name.trim() };
    },
    onSuccess: async (r) => { await refresh(); setForm(emptyCandidateForm); setFile(null); onAdded(r); },
  });
  // Someone already in the database: add the existing profile to this job instead of creating a second one.
  const existing = useMutation({
    mutationFn: async (m: DuplicateMatch) => ({ applicationId: (await apply(m.id!)).data.id, name: m.full_name ?? form.full_name }),
    onSuccess: async (r) => { await refresh(); setForm(emptyCandidateForm); onAdded(r); },
  });
  const serverExact = save.error instanceof ApiError && save.error.code === 'DUPLICATE_CANDIDATE' ? ((save.error.details as { exact?: DuplicateMatch[] } | undefined)?.exact ?? []) : [];
  const exact = check.data?.exact.length ? check.data.exact : serverExact;
  const submit = (e: FormEvent) => { e.preventDefault(); if (exact.length === 0) save.mutate(); };

  return (
    <form className="card section" onSubmit={submit} noValidate>
      <div className="title-row" style={{ marginBottom: 14 }}>
        <h2 style={{ margin: 0 }}>Sourcing for {jobTitle}</h2>
        <button type="button" className="btn btn-link" onClick={onChangeJob}>Change job</button>
      </div>
      {exact.length > 0 && (
        <div className="dup-box block" role="alert">
          <strong>This person is already in the database.</strong> Add the existing profile to this job instead.
          <ul>{exact.map((m, i) => (
            <li key={m.id ?? i}>
              {m.hidden ? 'A candidate you do not have access to' : m.full_name}{!m.hidden && (m.current_title || m.city) ? ` (${[m.current_title, m.city].filter(Boolean).join(', ')})` : ''}
              {!m.hidden && m.id && <> <button type="button" className="btn btn-sm" disabled={existing.isPending} onClick={() => existing.mutate(m)}>Add to this job</button></>}
            </li>
          ))}</ul>
        </div>
      )}
      <FormError error={existing.error ?? (save.error && !(save.error instanceof ApiError && (save.error.details || save.error.code === 'DUPLICATE_CANDIDATE')) ? save.error : null)} />
      <CandidateFormFields form={form} setForm={setForm} error={save.error} canSeeCtc={false} />
      <div className="form-grid">
        <Field id="src-source" label="Where did you find them?">
          <select id="src-source" value={source} onChange={(e) => setSource(e.target.value)}>
            {['internal_recruiter', 'referral', 'direct', 'job_board', 'other'].map((s) => <option key={s} value={s}>{SOURCE_LABEL[s]}</option>)}
          </select>
        </Field>
        <Field id="src-resume" label="Resume" hint="PDF, DOC or DOCX, up to 25 MB.">
          <input id="src-resume" type="file" accept=".pdf,.doc,.docx" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </Field>
      </div>
      <div className="actions-row" style={{ marginTop: 8 }}>
        <button className="btn btn-primary" type="submit" disabled={save.isPending || !form.full_name.trim() || (!form.email.trim() && !form.phone.trim()) || exact.length > 0}>{save.isPending ? 'Adding…' : 'Add to this job'}</button>
        <button className="btn" type="button" onClick={() => setFinding(true)}>Find someone already in the database</button>
      </div>
      {finding && <AddCandidateDialog vacancyId={jobId} onClose={() => { setFinding(false); refresh(); }} />}
    </form>
  );
}
