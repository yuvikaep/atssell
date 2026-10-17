import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { useRef, useState, type FormEvent } from 'react';
import { ApiError, DECLARATION_OPTIONS, EMPLOYMENT_TYPES, upload, type PortalVacancy, type SubmissionResult } from '../api';
import { CandidateFormFields, candidateBody, emptyCandidateForm, type CandidateForm } from '../components/CandidateForm';
import { Badge, DetailGrid, Dialog, ErrorState, Field, fieldError, FormError, Loading, Tags } from '../components/ui';
import { portalSubmissionsQuery, portalVacancyQuery } from '../queries';
import { OwnershipBadge } from './Portal';

export function PortalVacancyPage() {
  const { id } = useParams({ from: '/app/portal/vacancies/$id' });
  const query = useQuery(portalVacancyQuery(id));
  const mine = useQuery(portalSubmissionsQuery({ vacancy_id: id, page: 1 }));
  const [submitting, setSubmitting] = useState(false);

  if (query.isPending) return <Loading />;
  if (query.isError) {
    return query.error instanceof ApiError && query.error.status === 404 ? (
      <div className="state"><h2>Vacancy not found</h2><p>It may have been closed or is no longer assigned to your agency.</p></div>
    ) : <ErrorState error={query.error} onRetry={() => query.refetch()} />;
  }
  const v = query.data;

  return (
    <>
      <Link className="back-link" to="/portal">← My vacancies</Link>
      <div className="page-header">
        <div>
          <div className="title-row"><h1>{v.title}</h1><Badge tone={v.status === 'open' ? 'success' : 'warning'}>{v.status === 'open' ? 'Open' : 'On hold'}</Badge></div>
          <p>{v.vacancy_code} · {v.location}</p>
        </div>
        {v.can_submit
          ? <button className="btn btn-primary" onClick={() => setSubmitting(true)}>Submit a candidate</button>
          : <span className="muted">Not accepting submissions right now</span>}
      </div>

      <div className="detail-layout">
        <div className="stack">
          <div className="card">
            <div className="section">
              <h2>Requirements</h2>
              <DetailGrid items={[
                ['Openings', v.headcount],
                ['Employment type', EMPLOYMENT_TYPES[v.employment_type] ?? v.employment_type],
                ['Experience', v.min_experience_years != null || v.max_experience_years != null ? `${v.min_experience_years ?? 0}–${v.max_experience_years ?? '+'} years` : '—'],
                ['Priority', <span style={{ textTransform: 'capitalize' }}>{v.priority}</span>],
              ]} />
            </div>
            <div className="section"><h2>Skills</h2><Tags items={v.skills} /></div>
            <div className="section"><h2>Job description</h2><p className="prose">{v.description}</p></div>
          </div>
          <div className="card">
            <div className="section">
              <h2>Your submissions for this vacancy</h2>
              {mine.isPending ? <Loading /> : mine.isError ? <ErrorState error={mine.error} /> : mine.data.data.length === 0 ? <p className="empty-inline">None yet.</p> : (
                <div className="table-wrap">
                  <table>
                    <tbody>
                      {mine.data.data.map((s) => (
                        <tr key={s.id}>
                          <td><strong>{s.candidate_name}</strong><div className="cell-sub">{s.current_title}</div></td>
                          <td>{s.stage ?? <span className="muted">—</span>}</td>
                          <td><OwnershipBadge view={s.ownership} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="card">
          <div className="section">
            <h2>Submission policy</h2>
            <p style={{ marginTop: 0 }}>
              The first agency to source a candidate is <strong>credited automatically</strong>, and the credit does not expire.
              You can submit your own candidates to any vacancy assigned to you.
            </p>
            <p className="muted" style={{ fontSize: 13 }}>
              If a candidate is already in the company's database, whoever sourced them, a new submission is rejected as a duplicate.
            </p>
            {v.submission_policy.notes && (<><h2 style={{ fontSize: 14, margin: '14px 0 6px' }}>From the hiring team</h2><p className="prose">{v.submission_policy.notes}</p></>)}
          </div>
        </div>
      </div>

      {submitting && <SubmitDialog vacancy={v} onClose={() => setSubmitting(false)} />}
    </>
  );
}

function SubmitDialog({ vacancy, onClose }: { vacancy: PortalVacancy; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<CandidateForm>(emptyCandidateForm);
  const [declaration, setDeclaration] = useState('agency_database');
  const [notes, setNotes] = useState('');
  const [consent, setConsent] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [result, setResult] = useState<SubmissionResult | null>(null);

  const submit = useMutation({
    mutationFn: () => {
      const profile = candidateBody(form, false, true); // agencies do not supply compensation
      // The JSON goes first so the server has it before the file stream ends.
      return upload<{ data: SubmissionResult }>(`/agency/vacancies/${vacancy.id}/submissions`, file!, {
        payload: JSON.stringify({ ...profile, source_declaration: declaration, notes: notes.trim() || null, consent_confirmed: consent }),
      });
    },
    onSuccess: async (res) => {
      setResult(res.data);
      await Promise.all(['portal-home', 'portal-vacancies', 'portal-vacancy', 'portal-submissions'].map((k) => queryClient.invalidateQueries({ queryKey: [k] })));
    },
  });

  const again = () => { setForm(emptyCandidateForm); setNotes(''); setConsent(false); setFile(null); setResult(null); submit.reset(); };
  const onSubmit = (e: FormEvent) => { e.preventDefault(); if (file && consent) submit.mutate(); };
  const generic = submit.error && !(submit.error instanceof ApiError && Array.isArray(submit.error.details)) ? submit.error : null;

  if (result) {
    return (
      <Dialog
        open title="Submitted" onClose={onClose}
        footer={<><button className="btn" onClick={again}>Submit another</button><button className="btn btn-primary" onClick={onClose}>Done</button></>}
      >
        <div className="alert alert-success" role="status">{result.message}</div>
        <p style={{ margin: 0 }}>Status: <OwnershipBadge view={result.ownership} /></p>
      </Dialog>
    );
  }

  return (
    <Dialog
      open wide title={`Submit a candidate for ${vacancy.title}`} onClose={onClose}
      footer={
        <>
          <button className="btn" type="button" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" type="submit" form="submit-form" disabled={submit.isPending || !file || !consent || !form.full_name.trim() || (!form.email.trim() && !form.phone.trim())}>
            {submit.isPending ? 'Submitting…' : 'Submit candidate'}
          </button>
        </>
      }
    >
      <form id="submit-form" onSubmit={onSubmit} noValidate>
        <FormError error={generic} />
        <CandidateFormFields form={form} setForm={setForm} error={submit.error} canSeeCtc={false} />
        <div className="form-grid">
          <div className="span-2">
            <Field id="resume" label="Resume" hint="PDF, DOC or DOCX. It is scanned before it is stored." error={submit.error instanceof ApiError && ['RESUME_REQUIRED', 'UNSUPPORTED_FILE', 'FILE_REJECTED', 'FILE_TOO_LARGE'].includes(submit.error.code) ? submit.error.message : undefined}>
              <input id="resume" ref={fileInput} type="file" accept=".pdf,.doc,.docx" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            </Field>
          </div>
          <div className="span-2">
            <Field id="declaration" label="How did you find this candidate?">
              <select id="declaration" value={declaration} onChange={(e) => setDeclaration(e.target.value)}>
                {Object.entries(DECLARATION_OPTIONS).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
              </select>
            </Field>
          </div>
          <div className="span-2">
            <Field id="sub-notes" label="Notes for the hiring team" hint="Optional."><textarea id="sub-notes" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} style={{ minHeight: 70 }} /></Field>
          </div>
          <div className="span-2">
            <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 13 }}>
              <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} style={{ width: 'auto', height: 'auto', marginTop: 3 }} />
              <span>The candidate has agreed to be submitted to this company for this role, and I have their permission to share these details.</span>
            </label>
            {fieldError(submit.error, 'consent_confirmed') && <span className="field-error" style={{ color: 'var(--danger)', fontSize: 12 }}>{fieldError(submit.error, 'consent_confirmed')}</span>}
          </div>
        </div>
      </form>
    </Dialog>
  );
}

