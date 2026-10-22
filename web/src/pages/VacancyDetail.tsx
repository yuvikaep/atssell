import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { useState } from 'react';
import { api, ApiError, can, canAll, EMPLOYMENT_TYPES, formatCtcRange, formatDay, VACANCY_STATUS_LABEL, type VacancyDetail, type VacancyStatus } from '../api';
import { useMe } from '../components/AppShell';
import { InterviewRounds } from '../components/InterviewRounds';
import { JobCandidates } from '../components/JobCandidates';
import { EditJobDialog } from '../components/EditJobDialog';
import { BackLink, Badge, DetailGrid, Dialog, ErrorState, Field, fieldError, FormError, Loading, Tags } from '../components/ui';
import { agenciesQuery, usersQuery, vacancyQuery } from '../queries';
import { useSessionState } from '../session-storage';
import { VACANCY_TONE } from './Vacancies';

const TABS = ['candidates', 'overview'] as const;
const NEXT: Record<VacancyStatus, { to: VacancyStatus; label: string; reason?: boolean; danger?: boolean }[]> = {
  open: [{ to: 'on_hold', label: 'Put on hold', reason: true }, { to: 'closed', label: 'Close' }, { to: 'cancelled', label: 'Cancel vacancy', reason: true, danger: true }],
  on_hold: [{ to: 'open', label: 'Reopen' }, { to: 'closed', label: 'Close' }, { to: 'cancelled', label: 'Cancel vacancy', reason: true, danger: true }],
  closed: [{ to: 'open', label: 'Reopen' }],
  cancelled: [],
};

export function VacancyDetailPage() {
  const { id } = useParams({ from: '/app/vacancies/$id' });
  const [tab, setTab] = useSessionState('jm.vacancy.tab', 'candidates', TABS);
  const [change, setChange] = useState<(typeof NEXT)[VacancyStatus][number] | null>(null);
  const [closing, setClosing] = useState(false);
  const [editing, setEditing] = useState(false);
  const query = useQuery(vacancyQuery(id));
  const me = useMe();

  if (query.isPending) return <Loading />;
  if (query.isError) {
    return query.error instanceof ApiError && query.error.status === 404 ? (
      <div className="state"><h2>Vacancy not found</h2><p>It may not exist, or you may not have access to it.</p></div>
    ) : <ErrorState error={query.error} onRetry={() => query.refetch()} />;
  }
  const v = query.data;

  return (
    <>
      <BackLink to="/vacancies">Jobs</BackLink>
      <div className="page-header">
        <div>
          <div className="title-row">
            <h1>{v.title}</h1>
            <Badge tone={VACANCY_TONE[v.status]}>{VACANCY_STATUS_LABEL[v.status]}</Badge>
          </div>
          <p>{v.vacancy_code} · {v.department_name} · {v.location} · {v.headcount} {v.headcount === 1 ? 'opening' : 'openings'} · open for {v.age_days} {v.age_days === 1 ? 'day' : 'days'}</p>
        </div>
        {v.can.manage && (
          <div className="actions-row">
            {(v.status === 'open' || v.status === 'on_hold') && <button className="btn" onClick={() => setEditing(true)}>Edit job</button>}
            {can(me, 'employment.manage') && (v.status === 'open' || v.status === 'on_hold') && <button className="btn btn-primary" onClick={() => setClosing(true)}>Close job</button>}
            {NEXT[v.status].filter((n) => !(n.to === 'closed' && can(me, 'employment.manage'))).map((n) => (
              <button key={n.to} className={`btn ${n.danger ? 'btn-danger' : ''}`} onClick={() => setChange(n)}>{n.label}</button>
            ))}
          </div>
        )}
      </div>
      {editing && <EditJobDialog v={v} onClose={() => setEditing(false)} />}
      {v.status_reason && (v.status === 'on_hold' || v.status === 'cancelled') && (
        <div className="alert alert-error" role="status">{VACANCY_STATUS_LABEL[v.status]}: {v.status_reason}</div>
      )}

      <div className="card">
        <div className="tabs" role="tablist">
          <button className="tab" role="tab" aria-selected={tab === 'candidates'} onClick={() => setTab('candidates')}>
            Candidates<span className="count">{v.stage_counts.reduce((n, s) => n + s.count, 0)}</span>
          </button>
          <button className="tab" role="tab" aria-selected={tab === 'overview'} onClick={() => setTab('overview')}>Overview &amp; assignments</button>
        </div>
        {tab === 'candidates' ? (
          <JobCandidates vacancyId={v.id} canAdd={v.can.add_candidates} />
        ) : (
          <Overview v={v} />
        )}
      </div>
      {change && <StatusDialog v={v} change={change} onClose={() => setChange(null)} />}
      {closing && <CloseJobDialog id={v.id} onClose={() => setClosing(false)} />}
    </>
  );
}

function Overview({ v }: { v: VacancyDetail }) {
  const me = useMe();
  const sees = can(me, 'interviews.manage') || can(me, 'feedback.view') || can(me, 'decisions.record');
  return (
    <div className="detail-layout" style={{ padding: 16 }}>
      <div className="stack">
        <div>
          <h2 style={{ marginBottom: 12 }}>Role</h2>
          <DetailGrid items={[
            ['Positions', v.headcount],
            ['Salary & joining by', { admin: 'Admin', recruiter: 'Recruiter on this job', interviewer: 'Interviewer who selects' }[v.terms_owner] ?? 'Admin'],
            ['Employment type', EMPLOYMENT_TYPES[v.employment_type] ?? v.employment_type],
            ['Priority', <span style={{ textTransform: 'capitalize' }}>{v.priority}</span>],
            ['Experience', v.min_experience_years != null || v.max_experience_years != null ? `${v.min_experience_years ?? 0}–${v.max_experience_years ?? '+'} years` : '—'],
            ...(v.min_ctc !== undefined || v.max_ctc !== undefined ? [['Budget (CTC)', formatCtcRange(v.min_ctc, v.max_ctc)] as [string, string]] : []),
            ['Target date', formatDay(v.target_date)],
            ['Owner', v.owner_name],
            ['Hiring manager', v.hiring_manager_name],
          ]} />
        </div>
        <div><h2 style={{ marginBottom: 8 }}>Skills</h2><Tags items={v.skills} /></div>
        <div><h2 style={{ marginBottom: 8 }}>Job description (JD)</h2><p className="prose">{v.description}</p></div>
        <Link to="/requisitions/$id" params={{ id: v.requisition_id }}>View the requisition →</Link>
      </div>
      <div className="stack">
        <Recruiters v={v} />
        <Interviewers v={v} />
        <Agencies v={v} />
        {sees && <InterviewRounds vacancyId={v.id} canManage={can(me, 'interviews.manage')} />}
      </div>
    </div>
  );
}

function useVacancyRefresh(id: string) {
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['vacancy', id] }),
      queryClient.invalidateQueries({ queryKey: ['vacancies'] }),
      queryClient.invalidateQueries({ queryKey: ['requisition'] }),
    ]);
}

function Recruiters({ v }: { v: VacancyDetail }) {
  const me = useMe();
  const refresh = useVacancyRefresh(v.id);
  const [picking, setPicking] = useState('');
  const canListUsers = canAll(me, 'users.manage');
  const users = useQuery({ ...usersQuery('active', ''), enabled: v.can.manage && canListUsers });
  const assign = useMutation({
    mutationFn: (user_id: string) => api('POST', `/vacancies/${v.id}/assign-recruiter`, { user_id }),
    onSuccess: async () => { setPicking(''); await refresh(); },
  });
  const unassign = useMutation({
    mutationFn: (user_id: string) => api('POST', `/vacancies/${v.id}/unassign-recruiter`, { user_id }),
    onSuccess: refresh,
  });
  const assignedIds = new Set(v.recruiters.map((r) => r.id));
  const candidates = (users.data?.data ?? []).filter((u) => !assignedIds.has(u.id) && u.roles.some((r) => r.code === 'internal_recruiter'));

  return (
    <div className="card section">
      <h2>Recruiters</h2>
      <FormError error={assign.error ?? unassign.error} />
      {v.recruiters.length === 0 ? <p className="empty-inline">No recruiters assigned.</p> : (
        <ul className="chips" style={{ listStyle: 'none', padding: 0, margin: '0 0 10px' }}>
          {v.recruiters.map((r) => (
            <li className="chip" key={r.id}>{r.full_name}
              {v.can.manage && <button aria-label={`Unassign ${r.full_name}`} onClick={() => unassign.mutate(r.id)}>×</button>}
            </li>
          ))}
        </ul>
      )}
      {v.can.manage && canListUsers && (
        <Field id="add-recruiter" label="Assign a recruiter">
          <select id="add-recruiter" value={picking} disabled={assign.isPending} onChange={(e) => { setPicking(e.target.value); if (e.target.value) assign.mutate(e.target.value); }}>
            <option value="">Choose a person</option>
            {candidates.map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}
          </select>
        </Field>
      )}
    </div>
  );
}

function Interviewers({ v }: { v: VacancyDetail }) {
  const me = useMe();
  const refresh = useVacancyRefresh(v.id);
  const [picking, setPicking] = useState('');
  const canListUsers = canAll(me, 'users.manage');
  const users = useQuery({ ...usersQuery('active', ''), enabled: v.can.manage && canListUsers });
  const assign = useMutation({
    mutationFn: (user_id: string) => api('POST', `/vacancies/${v.id}/assign-interviewer`, { user_id }),
    onSuccess: async () => { setPicking(''); await refresh(); },
  });
  const unassign = useMutation({
    mutationFn: (user_id: string) => api('POST', `/vacancies/${v.id}/unassign-interviewer`, { user_id }),
    onSuccess: refresh,
  });
  const assignedIds = new Set((v.interviewers ?? []).map((r) => r.id));
  const candidates = (users.data?.data ?? []).filter((u) => !assignedIds.has(u.id) && !u.roles.some((r) => r.code.startsWith('agency')));

  return (
    <div className="card section">
      <h2>Interviewers</h2>
      <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>Only these people (and company admins) can be put on this job's interview panels.</p>
      <FormError error={assign.error ?? unassign.error} />
      {(v.interviewers ?? []).length === 0 ? <p className="empty-inline">No interviewers assigned.</p> : (
        <ul className="chips" style={{ listStyle: 'none', padding: 0, margin: '0 0 10px' }}>
          {(v.interviewers ?? []).map((r) => (
            <li className="chip" key={r.id}>{r.full_name}
              {v.can.manage && <button aria-label={`Unassign ${r.full_name}`} onClick={() => unassign.mutate(r.id)}>×</button>}
            </li>
          ))}
        </ul>
      )}
      {v.can.manage && canListUsers && (
        <Field id="add-interviewer" label="Assign an interviewer">
          <select id="add-interviewer" value={picking} disabled={assign.isPending} onChange={(e) => { setPicking(e.target.value); if (e.target.value) assign.mutate(e.target.value); }}>
            <option value="">Choose a person</option>
            {candidates.map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}
          </select>
        </Field>
      )}
    </div>
  );
}

function Agencies({ v }: { v: VacancyDetail }) {
  const refresh = useVacancyRefresh(v.id);
  const [picking, setPicking] = useState('');
  const [policyFor, setPolicyFor] = useState<VacancyDetail['agencies'][number] | null>(null);
  const agencies = useQuery({ ...agenciesQuery('active'), enabled: v.can.manage });
  const assign = useMutation({
    mutationFn: (agency_id: string) => api('POST', `/vacancies/${v.id}/assign-agency`, { agency_id }),
    onSuccess: async () => { setPicking(''); await refresh(); },
  });
  const unassign = useMutation({
    mutationFn: (agency_id: string) => api('POST', `/vacancies/${v.id}/unassign-agency`, { agency_id }),
    onSuccess: refresh,
  });
  const assignedIds = new Set(v.agencies.map((a) => a.id));
  const options = (agencies.data ?? []).filter((a) => !assignedIds.has(a.id));
  if (!v.can.manage && v.agencies.length === 0) return null;

  return (
    <div className="card section">
      <h2>Agencies</h2>
      <FormError error={assign.error ?? unassign.error} />
      {v.agencies.length === 0 ? <p className="empty-inline">No agencies assigned.</p> : (
        <ul className="chips" style={{ listStyle: 'none', padding: 0, margin: '0 0 10px' }}>
          {v.agencies.map((a) => (
            <li className="chip" key={a.id}>{a.name}
              {v.can.manage && <button aria-label={`Notes for ${a.name}`} title="Notes for this agency" onClick={() => setPolicyFor(a)} style={{ fontSize: 12 }}>⚙</button>}
              {v.can.manage && <button aria-label={`Unassign ${a.name}`} onClick={() => unassign.mutate(a.id)}>×</button>}
            </li>
          ))}
        </ul>
      )}
      {v.can.manage && agencies.data && (
        options.length === 0 && v.agencies.length === 0 ? (
          <p className="muted" style={{ fontSize: 13 }}>No agencies yet. <Link to="/agencies">Add an agency</Link> first.</p>
        ) : (
          <Field id="add-agency" label="Assign an agency">
            <select id="add-agency" value={picking} disabled={assign.isPending || options.length === 0} onChange={(e) => { setPicking(e.target.value); if (e.target.value) assign.mutate(e.target.value); }}>
              <option value="">{options.length === 0 ? 'All agencies assigned' : 'Choose an agency'}</option>
              {options.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </Field>
        )
      )}
      {policyFor && <PolicyDialog vacancyId={v.id} agency={policyFor} onClose={() => setPolicyFor(null)} />}
    </div>
  );
}

/** The notes an assigned agency reads before submitting. (Ownership itself has no settings.) */
function PolicyDialog({ vacancyId, agency, onClose }: { vacancyId: string; agency: VacancyDetail['agencies'][number]; onClose: () => void }) {
  const refresh = useVacancyRefresh(vacancyId);
  const [notes, setNotes] = useState(agency.ownership_policy?.submission_notes ?? '');
  const save = useMutation({
    mutationFn: () => api('PATCH', `/vacancies/${vacancyId}/agencies/${agency.id}/policy`, { submission_notes: notes.trim() || null }),
    onSuccess: async () => { await refresh(); onClose(); },
  });
  return (
    <Dialog
      open title={`Notes for ${agency.name}`} onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" onClick={() => save.mutate()} disabled={save.isPending}>Save notes</button></>}
    >
      <FormError error={save.error} />
      <Field id="pol-notes" label="Notes shown to the agency" hint="For example: the notice period or location you will accept. Only this agency sees them.">
        <textarea id="pol-notes" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} autoFocus />
      </Field>
    </Dialog>
  );
}

function StatusDialog({ v, change, onClose }: { v: VacancyDetail; change: (typeof NEXT)[VacancyStatus][number]; onClose: () => void }) {
  const refresh = useVacancyRefresh(v.id);
  const [reason, setReason] = useState('');
  const update = useMutation({
    mutationFn: () => api('PATCH', `/vacancies/${v.id}`, { status: change.to, ...(change.reason ? { status_reason: reason } : {}) }),
    onSuccess: async () => { await refresh(); onClose(); },
  });
  return (
    <Dialog
      open title={`${change.label}?`} onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Back</button>
          <button className={`btn ${change.danger ? 'btn-danger' : 'btn-primary'}`} onClick={() => update.mutate()} disabled={update.isPending || (!!change.reason && !reason.trim())}>
            {change.label}
          </button>
        </>
      }
    >
      <FormError error={update.error && !fieldError(update.error, 'status_reason') ? update.error : null} />
      {change.to === 'closed' && <p style={{ marginTop: 0 }}>Closing stops new candidates being added. You can reopen it later.</p>}
      {change.to === 'cancelled' && <p style={{ marginTop: 0 }}>A cancelled vacancy cannot be reopened.</p>}
      {change.reason && (
        <Field id="status-reason" label="Reason" error={fieldError(update.error, 'status_reason')}>
          <textarea id="status-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={2000} autoFocus />
        </Field>
      )}
    </Dialog>
  );
}

/** Closing a job records how it ended; the hiring target and actual joins are saved with it. */
function CloseJobDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [outcome, setOutcome] = useState('');
  const close = useMutation({
    mutationFn: () => api('POST', `/jobs/${id}/close`, { outcome }),
    onSuccess: async () => { await Promise.all(['vacancy', 'vacancies', 'hr-dashboard'].map((k) => queryClient.invalidateQueries({ queryKey: [k] }))); onClose(); },
  });
  return (
    <Dialog open title="Close this job" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Keep open</button><button className="btn btn-primary" disabled={close.isPending || !outcome.trim()} onClick={() => close.mutate()}>Close job</button></>}>
      <FormError error={close.error && !fieldError(close.error, 'outcome') ? close.error : null} />
      <p className="muted" style={{ marginTop: 0 }}>The hiring target and the people who actually joined are saved with this outcome.</p>
      <Field id="close-outcome" label="How did this job end?" error={fieldError(close.error, 'outcome')}><textarea id="close-outcome" rows={3} value={outcome} onChange={(e) => setOutcome(e.target.value)} placeholder="For example: both positions filled, or role no longer needed" /></Field>
    </Dialog>
  );
}
