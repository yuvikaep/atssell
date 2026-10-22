import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { useDeferredValue, useRef, useState, type FormEvent } from 'react';
import {
  api, ApiError, can, formatBytes, formatInr, formatInZone, INTERVIEW_STATUS_LABEL, SOURCE_LABEL, upload, type CandidateProfile, type CandidateRow, type Paged,
} from '../api';
import { useMe } from '../components/AppShell';
import { ScheduleDialog } from '../components/ScheduleDialog';
import { CandidateFormFields, candidateBody, formFromCandidate, type CandidateForm } from '../components/CandidateForm';
import { BackLink, Badge, DetailGrid, Dialog, ErrorState, Field, fieldError, FormError, formatDate, Loading, Tags, IdTags } from '../components/ui';
import { candidateQuery, candidatesQuery, interviewsQuery, vacancyOptionsQuery } from '../queries';

function useRefreshCandidate(id: string) {
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['candidate', id] }),
      queryClient.invalidateQueries({ queryKey: ['candidates'] }),
      queryClient.invalidateQueries({ queryKey: ['applications'] }),
      queryClient.invalidateQueries({ queryKey: ['vacancies'] }),
    ]);
}

export function CandidateDetailPage() {
  const { id } = useParams({ from: '/app/candidates/$id' });
  const query = useQuery(candidateQuery(id));
  const me = useMe();
  const navigate = useNavigate();
  // ?edit=1 (from Candidate status) opens the edit form straight away.
  const { edit } = useSearch({ strict: false }) as { edit?: string };
  const [dialog, setDialog] = useState<'edit' | 'vacancy' | 'merge' | null>(edit ? 'edit' : null);
  const [scheduling, setScheduling] = useState<{ applicationId: string; vacancyId: string } | null>(null);
  const seesInterviews = can(me, 'interviews.manage') || can(me, 'feedback.view') || can(me, 'decisions.record');
  const interviews = useQuery({ ...interviewsQuery({ candidate_id: id }), enabled: seesInterviews });

  if (query.isPending) return <Loading />;
  if (query.isError) {
    return query.error instanceof ApiError && query.error.status === 404 ? (
      <div className="state"><h2>Candidate not found</h2><p>They may not exist, or you may not have access to this profile.</p></div>
    ) : <ErrorState error={query.error} onRetry={() => query.refetch()} />;
  }
  const c = query.data;

  return (
    <>
      <BackLink to="/candidates">Candidates</BackLink>
      <div className="page-header">
        <div>
          <div className="title-row">
            <h1>{c.full_name}</h1>
            {c.status !== 'active' && <Badge tone="warning">{c.status === 'merged' ? 'Merged into another profile' : 'Archived'}</Badge>}
          </div>
          <p>{[c.current_title, c.city].filter(Boolean).join(' · ') || 'No title or location yet'}</p>
        </div>
        <div className="actions-row">
          {c.can.edit && <button className="btn" onClick={() => setDialog('edit')}>Edit</button>}
          {c.can.merge && <button className="btn" onClick={() => setDialog('merge')}>Merge duplicate</button>}
          {c.can.add_to_vacancy && <button className="btn btn-primary" onClick={() => setDialog('vacancy')}>Add to vacancy</button>}
        </div>
      </div>

      <div className="detail-layout">
        <div className="stack">
          <div className="card">
            <div className="section">
              <h2>Profile</h2>
              <DetailGrid items={[
                ['Sourced by', <span title="Credited to whoever sourced the candidate first. This cannot be changed.">{c.sourced_by.name}{c.sourced_by.kind === 'agency' && <> <Badge tone="info">Agency</Badge></>}</span>],
                ...(c.can.view_contact ? [['Email', c.email ?? '—'], ['Phone', c.phone ?? '—']] as [string, string][] : []),
                ['Experience', c.total_experience_years != null ? `${c.total_experience_years} years` : '—'],
                ['Notice period', c.notice_period_days != null ? `${c.notice_period_days} days` : '—'],
                ...(c.can.view_compensation ? [
                  ['Current CTC', c.current_ctc != null ? formatInr(c.current_ctc) : '—'],
                  ['Expected CTC', c.expected_ctc != null ? formatInr(c.expected_ctc) : '—'],
                ] as [string, string][] : []),
              ]} />
            </div>
            <div className="section"><h2>Skills</h2><Tags items={c.skills} /></div>
            {c.profile_summary && <div className="section"><h2>Summary</h2><p className="prose">{c.profile_summary}</p></div>}
          </div>

          <Resumes c={c} />

          {seesInterviews && (
            <div className="card">
              <div className="section">
                <h2>Interviews</h2>
                {!interviews.data || interviews.data.data.length === 0 ? <p className="empty-inline">No interviews yet.</p> : (
                  <div className="table-wrap">
                    <table>
                      <tbody>
                        {interviews.data.data.map((i) => (
                          <tr key={i.id}>
                            <td><Link className="row-link" to="/interviews/$id" params={{ id: i.id }}>{i.round_name}</Link><div className="cell-sub">{i.vacancy_code} · {i.vacancy_title}</div></td>
                            <td>{i.scheduled_start ? formatInZone(i.scheduled_start, i.timezone) : 'Time to be decided'}</td>
                            <td><Badge tone={i.status === 'cancelled' ? 'danger' : i.status === 'completed' ? 'success' : 'info'}>{INTERVIEW_STATUS_LABEL[i.status]}</Badge></td>
                            <td>{i.feedback_expected > 0 ? `${i.feedback_submitted} of ${i.feedback_expected} feedback` : ''}{i.feedback_overdue && <> <Badge tone="danger">Overdue</Badge></>}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          )}

          <div className="card">
            <div className="section">
              <h2>Applications</h2>
              {c.applications.length === 0 ? <p className="empty-inline">Not added to any vacancy yet.</p> : (
                <div className="table-wrap">
                  <table>
                    <thead><tr><th>Vacancy</th><th>Stage</th><th>Since</th><th /></tr></thead>
                    <tbody>
                      {c.applications.map((a) => (
                        <tr key={a.id}>
                          <td><Link className="row-link" to="/vacancies/$id" params={{ id: a.vacancy_id }}>{a.vacancy_title}</Link><div className="cell-sub">{a.vacancy_code}{a.job_role_name ? ` · ${a.job_role_name}` : ''}</div><IdTags sourcing={a.sourcing_code} temp={a.temp_employee_code} /></td>
                          <td>
                            <Badge tone={a.status === 'hired' ? 'success' : a.status === 'active' ? 'info' : 'muted'}>{a.stage_name}</Badge>
                            {a.disposition_reason && <div className="cell-sub">{a.disposition_reason}</div>}
                          </td>
                          <td className="muted">{formatDate(a.stage_changed_at)}</td>
                          <td className="actions">{a.status === 'active' && can(me, 'interviews.manage') && <button className="btn btn-sm" onClick={() => setScheduling({ applicationId: a.id, vacancyId: a.vacancy_id })}>Schedule interview</button>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="stack">
          <div className="card">
            <div className="section">
              <h2>Source history</h2>
              {c.submissions.length === 0 ? <p className="empty-inline">No source recorded.</p> : (
                <ul className="timeline">
                  {c.submissions.map((s) => (
                    <li key={s.id}>
                      <strong>{s.agency_name ?? SOURCE_LABEL[s.source_type] ?? s.source_type}</strong> for {s.vacancy_code}
                      {s.ownership_state === 'rejected' && <> <Badge tone="danger">Rejected duplicate</Badge></>}
                      <div className="cell-sub">{s.submitted_by_name ? `by ${s.submitted_by_name} · ` : ''}{formatDate(s.submitted_at)}</div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
          <Notes c={c} />
        </div>
      </div>

      {scheduling && <ScheduleDialog applicationId={scheduling.applicationId} vacancyId={scheduling.vacancyId} onClose={(saved) => { setScheduling(null); if (saved) navigate({ to: '/interviews/$id', params: { id: saved.id } }); }} />}
      {dialog === 'edit' && <EditDialog c={c} onClose={() => setDialog(null)} />}
      {dialog === 'vacancy' && <AddToVacancyDialog c={c} onClose={() => setDialog(null)} />}
      {dialog === 'merge' && <MergeDialog c={c} onClose={() => setDialog(null)} />}
    </>
  );
}

function Resumes({ c }: { c: CandidateProfile }) {
  const refresh = useRefreshCandidate(c.id);
  const input = useRef<HTMLInputElement>(null);
  const send = useMutation({
    mutationFn: (file: File) => upload(`/candidates/${c.id}/documents`, file, { document_type: 'resume' }),
    onSuccess: refresh,
  });
  const download = useMutation({
    mutationFn: (docId: string) => api<{ data: { url: string } }>('POST', `/candidates/${c.id}/documents/${docId}/download-url`),
    // The link is signed and expires in minutes; the response is an attachment, so the page stays put.
    onSuccess: (res) => window.location.assign(res.data.url),
  });

  return (
    <div className="card">
      <div className="section">
        <h2>
          Resumes
          {c.can.upload && (
            <>
              <button className="btn btn-sm" onClick={() => input.current?.click()} disabled={send.isPending}>{send.isPending ? 'Uploading…' : 'Upload resume'}</button>
              <input
                ref={input} type="file" hidden accept=".pdf,.doc,.docx"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) send.mutate(f); e.target.value = ''; }}
              />
            </>
          )}
        </h2>
        <FormError error={send.error ?? download.error} />
        {c.documents.length === 0 ? <p className="empty-inline">No resume uploaded.{c.can.upload ? ' PDF, DOC or DOCX, scanned before it is stored.' : ''}</p> : (
          <div className="table-wrap">
            <table>
              <tbody>
                {c.documents.map((d) => (
                  <tr key={d.id}>
                    <td><strong>{d.original_filename}</strong><div className="cell-sub">{formatBytes(d.size_bytes)} · {formatDate(d.created_at)}{d.uploaded_by_name ? ` · ${d.uploaded_by_name}` : ''}</div></td>
                    <td>{d.scan_status !== 'clean' && <Badge tone="warning">Scan {d.scan_status}</Badge>}</td>
                    <td className="actions">
                      <button className="btn btn-sm" disabled={d.scan_status !== 'clean' || download.isPending} onClick={() => download.mutate(d.id)}>Download</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function Notes({ c }: { c: CandidateProfile }) {
  const refresh = useRefreshCandidate(c.id);
  const [body, setBody] = useState('');
  const add = useMutation({
    mutationFn: () => api('POST', `/candidates/${c.id}/notes`, { body }),
    onSuccess: async () => { setBody(''); await refresh(); },
  });
  const submit = (e: FormEvent) => { e.preventDefault(); if (body.trim()) add.mutate(); };
  return (
    <div className="card">
      <div className="section">
        <h2>Notes</h2>
        <form onSubmit={submit}>
          <FormError error={add.error} />
          <Field id="note" label="Add a note">
            <textarea id="note" value={body} onChange={(e) => setBody(e.target.value)} maxLength={10000} style={{ minHeight: 70 }} />
          </Field>
          <button className="btn btn-sm btn-primary" type="submit" disabled={add.isPending || !body.trim()}>Add note</button>
        </form>
        <div style={{ marginTop: 14 }}>
          {c.notes.length === 0 ? <p className="empty-inline">No notes yet.</p> : c.notes.map((n) => (
            <div className="note" key={n.id}>
              <p className="prose">{n.body}</p>
              <div className="cell-sub">{n.created_by_name} · {formatDate(n.created_at)}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function EditDialog({ c, onClose }: { c: CandidateProfile; onClose: () => void }) {
  const refresh = useRefreshCandidate(c.id);
  const [form, setForm] = useState<CandidateForm>(() => formFromCandidate(c));
  const save = useMutation({
    mutationFn: () => api('PATCH', `/candidates/${c.id}`, candidateBody(form, c.can.view_compensation, c.can.view_contact)),
    onSuccess: async () => { await refresh(); onClose(); },
  });
  const dup = save.error instanceof ApiError && save.error.code === 'DUPLICATE_CANDIDATE';
  const submit = (e: FormEvent) => { e.preventDefault(); save.mutate(); };
  return (
    <Dialog
      open wide title={`Edit ${c.full_name}`} onClose={onClose}
      footer={
        <>
          <button className="btn" type="button" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" type="submit" form="edit-cand" disabled={save.isPending || !form.full_name.trim()}>Save changes</button>
        </>
      }
    >
      <form id="edit-cand" onSubmit={submit} noValidate>
        <FormError error={save.error && !(save.error instanceof ApiError && Array.isArray(save.error.details)) ? save.error : null} />
        {dup && <div className="dup-box block" role="alert">Another candidate already has this email or phone. If it is the same person, use “Merge duplicate”.</div>}
        <CandidateFormFields form={form} setForm={setForm} error={save.error} canSeeCtc={c.can.view_compensation} canEditContact={c.can.view_contact} />
      </form>
    </Dialog>
  );
}

function AddToVacancyDialog({ c, onClose }: { c: CandidateProfile; onClose: () => void }) {
  const refresh = useRefreshCandidate(c.id);
  const vacancies = useQuery(vacancyOptionsQuery);
  const already = new Set(c.applications.filter((a) => a.status === 'active').map((a) => a.vacancy_id));
  const options = (vacancies.data?.data ?? []).filter((v) => !already.has(v.id));
  const [vacancyId, setVacancyId] = useState('');
  const [source, setSource] = useState('internal_recruiter');
  const add = useMutation({
    mutationFn: () => api('POST', '/applications', { candidate_id: c.id, vacancy_id: vacancyId, source_type: source }),
    onSuccess: async () => { await refresh(); onClose(); },
  });
  return (
    <Dialog
      open title={`Add ${c.full_name} to a vacancy`} onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={() => add.mutate()} disabled={add.isPending || !vacancyId}>Add to vacancy</button>
        </>
      }
    >
      <FormError error={add.error} />
      {vacancies.isPending ? <Loading /> : vacancies.isError ? <ErrorState error={vacancies.error} /> : (
        <>
          <Field id="av-vacancy" label="Vacancy">
            <select id="av-vacancy" value={vacancyId} onChange={(e) => setVacancyId(e.target.value)}>
              <option value="" disabled>{options.length ? 'Choose a vacancy' : 'No open vacancies available'}</option>
              {options.map((v) => <option key={v.id} value={v.id}>{v.vacancy_code} · {v.title} ({v.location})</option>)}
            </select>
          </Field>
          <Field id="av-source" label="Source">
            <select id="av-source" value={source} onChange={(e) => setSource(e.target.value)}>
              {['internal_recruiter', 'referral', 'direct', 'job_board', 'other'].map((s) => <option key={s} value={s}>{SOURCE_LABEL[s]}</option>)}
            </select>
          </Field>
        </>
      )}
    </Dialog>
  );
}

/** Merges another profile into this one. Nothing is deleted: the other profile is kept as “merged”. */
function MergeDialog({ c, onClose }: { c: CandidateProfile; onClose: () => void }) {
  const me = useMe();
  const refresh = useRefreshCandidate(c.id);
  const [search, setSearch] = useState('');
  const q = useDeferredValue(search.trim());
  const results = useQuery({ ...candidatesQuery({ q, page: 1 }), enabled: q.length >= 2 });
  const [source, setSource] = useState<CandidateRow | null>(null);
  const [reason, setReason] = useState('');
  const merge = useMutation({
    mutationFn: () => api('POST', `/candidates/${c.id}/merge`, { source_candidate_id: source!.id, reason }),
    onSuccess: async () => { await refresh(); onClose(); },
  });
  const rows = ((results.data as Paged<CandidateRow> | undefined)?.data ?? []).filter((r) => r.id !== c.id);
  const showContact = can(me, 'candidates.view_contact');

  return (
    <Dialog
      open wide title={`Merge a duplicate into ${c.full_name}`} onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-danger" onClick={() => merge.mutate()} disabled={merge.isPending || !source || !reason.trim()}>Merge profiles</button>
        </>
      }
    >
      <FormError error={merge.error && !fieldError(merge.error, 'reason') ? merge.error : null} />
      <p style={{ marginTop: 0 }}>
        The duplicate's applications, resumes and notes move to this profile, and its missing details are filled in here. The duplicate is kept in the merge history, not deleted.
      </p>
      {source ? (
        <div className="chips"><span className="chip">{source.full_name}<button aria-label="Choose a different profile" onClick={() => setSource(null)}>×</button></span></div>
      ) : (
        <>
          <Field id="merge-search" label="Find the duplicate profile"><input id="merge-search" value={search} onChange={(e) => setSearch(e.target.value)} autoFocus /></Field>
          {q.length >= 2 && (results.isPending ? <Loading /> : rows.length === 0 ? <p className="empty-inline">No other candidates found.</p> : (
            <table>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td><strong>{r.full_name}</strong><div className="cell-sub">{[r.current_title, r.city, showContact ? r.email : null].filter(Boolean).join(' · ')}</div></td>
                    <td className="actions"><button className="btn btn-sm" onClick={() => setSource(r)}>Choose</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          ))}
        </>
      )}
      <Field id="merge-reason" label="Why are these the same person?" error={fieldError(merge.error, 'reason')}>
        <textarea id="merge-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} style={{ minHeight: 70 }} />
      </Field>
    </Dialog>
  );
}
