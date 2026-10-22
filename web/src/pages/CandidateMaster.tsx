import { canExport } from '../components/ExportButton';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useDeferredValue, useState } from 'react';
import { JoinDialog } from '../components/JoinDialog';
import { StatusCounts } from '../components/StatusCounts';
import { agenciesQuery, usersQuery } from '../queries';
import { MultiPick } from '../components/MultiPick';
import { api, can, formatDay } from '../api';
import { useMe } from '../components/AppShell';
import { ScheduleDialog } from '../components/ScheduleDialog';
import { Badge, Dialog, EmptyState, ErrorState, Field, fieldError, FormError, Loading, Pager, type Tone, IdTags } from '../components/ui';
import { CreateCandidateDialog } from './Candidates';

interface Row {
  simple_status: string | null;
  id: string; full_name: string; email?: string | null; phone?: string | null; city: string | null; current_title: string | null; total_experience_years: number | null;
  notice_period_days: number | null; skills: string[]; created_at: string; application_id: string | null; sourcing_code: string | null; temp_employee_code: string | null; app_status: string | null; vacancy_id: string | null; job_title: string | null; vacancy_code: string | null;
  stage_code: string | null; stage_name: string | null; source: string | null; applications: number; avg_rating: number | null; decision: string | null; decision_reason: string | null;
  offer_status: string | null; employment_status: string | null;
}
interface Page { data: Row[]; total: number; page: number; page_size: number; stages: { code: string; name: string }[]; settable_stages: string[] }

const SORTABLE: [string, string][] = [['name', 'Name'], ['job', 'Job'], ['status', 'Status'], ['city', 'City'], ['experience', 'Exp.'], ['notice', 'Notice'], ['added', 'Added']];

export const SIMPLE: Record<string, { label: string; tone: Tone }> = {
  sourced: { label: 'Sourced', tone: 'muted' }, interview: { label: 'Interview', tone: 'info' }, on_hold: { label: 'On hold', tone: 'warning' },
  rejected: { label: 'Rejected', tone: 'danger' }, selected: { label: 'Selected · yet to join', tone: 'success' }, joined: { label: 'Joined', tone: 'success' },
  backout: { label: 'Backout', tone: 'danger' }, exited: { label: 'Exited', tone: 'muted' },
};
/** One plain status per candidate, worked out by the server. */
export function statusOf(r: Pick<Row, 'simple_status'>): { label: string; tone: Tone } {
  return r.simple_status ? SIMPLE[r.simple_status] ?? { label: r.simple_status, tone: 'muted' } : { label: 'Not on a job', tone: 'muted' };
}

// A cell that starts with = + - @ is read as a formula by spreadsheets: neutralise it.
const cell = (v: unknown) => {
  let t = v === null || v === undefined ? '' : Array.isArray(v) ? v.join('; ') : String(v);
  if (typeof v !== 'number' && /^[=+\-@\t\r]/.test(t)) t = `'${t}`;
  return /[",\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
};

/** The spreadsheet-style master list: search, sort, filter, update status in place, import and export. */
export function CandidateMasterPage() {
  const me = useMe();
  const hr = can(me, 'employment.manage');
  const queryClient = useQueryClient();
  const [text, setText] = useState('');
  const q = useDeferredValue(text.trim());
  const [status, setStatus] = useState('');
  const [source, setSource] = useState('');
  const [recruiterIds, setRecruiterIds] = useState<string[]>([]);
  const [agencyIds, setAgencyIds] = useState<string[]>([]);
  const recruiters = useQuery({ ...usersQuery('all', ''), enabled: source === 'internal' && can(me, 'users.manage') });
  const agencies = useQuery({ ...agenciesQuery('all'), enabled: source === 'agency' });
  const [city, setCity] = useState('');
  const [sort, setSort] = useState('added');
  const [dir, setDir] = useState<'asc' | 'desc'>('desc');
  const [page, setPage] = useState(1);
  const [dialog, setDialog] = useState<null | { kind: 'add' | 'import' } | { kind: 'schedule' | 'join' | 'backout'; row: Row }>(null);

  const params = new URLSearchParams({ sort, dir, page: String(page), page_size: '50' });
  for (const [k, v] of Object.entries({ q, status, source, city, recruiter_ids: recruiterIds.join(','), agency_ids: agencyIds.join(',') })) if (v) params.set(k, v);
  const list = useQuery({ queryKey: ['master', params.toString()], queryFn: () => api<Page>('GET', `/candidate-master?${params}`) });
  const refresh = () => Promise.all(['master', 'hr-dashboard', 'candidate-status', 'candidates', 'status-summary', 'employment'].map((k) => queryClient.invalidateQueries({ queryKey: [k] })));
  const counts = useQuery({ queryKey: ['status-summary'], queryFn: () => api<{ data: Record<string, number> }>('GET', '/status-summary').then((r) => r.data) });

  const sortBy = (key: string) => { if (sort === key) setDir(dir === 'asc' ? 'desc' : 'asc'); else { setSort(key); setDir(key === 'added' ? 'desc' : 'asc'); } setPage(1); };
  const exportCsv = async () => {
    const all = await api<Page>('GET', `/candidate-master?${new URLSearchParams({ ...Object.fromEntries(params), page: '1', page_size: '200' })}`);
    const head = ['Sourcing ID', 'Temp ID', 'Name', 'Email', 'Phone', 'City', 'Title', 'Experience', 'Notice (days)', 'Job', 'Status', 'Source', 'Feedback avg'];
    const lines = [head, ...all.data.map((r) => [r.sourcing_code, r.temp_employee_code, r.full_name, r.email, r.phone, r.city, r.current_title, r.total_experience_years, r.notice_period_days, r.job_title, statusOf(r).label, r.source, r.avg_rating])];
    const blob = new Blob([`﻿${lines.map((l) => l.map(cell).join(',')).join('\r\n')}\r\n`], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = `candidates-${new Date().toISOString().slice(0, 10)}.csv`; a.click(); URL.revokeObjectURL(a.href);
  };

  const data = list.data;
  return (
    <>
      <div className="page-header">
        <div><h1>Candidates</h1><p>Every candidate on one sheet. Update a status in place, or open the row menu for interviews, offers, decisions and joining.</p></div>
        <div className="actions-row">
          <button className="btn" onClick={() => setDialog({ kind: 'import' })}>Import CSV</button>
          {canExport(me) && <button className="btn" onClick={exportCsv} disabled={!data || data.total === 0}>Export CSV</button>}
          {can(me, 'candidates.manage') && <button className="btn btn-primary" onClick={() => setDialog({ kind: 'add' })}>Add candidate</button>}
        </div>
      </div>
      <StatusCounts active={status} onPick={(k) => { setStatus(k); setPage(1); }} />
      <div className="card sheet">
        <div className="toolbar">
          <input className="grow" type="search" placeholder="Search name, title, city, skill, email or ID (SRC-, TEMP-)" aria-label="Search candidates" value={text} onChange={(e) => { setText(e.target.value); setPage(1); }} />
          <select aria-label="Status" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
            <option value="">All statuses</option>
            {Object.entries(SIMPLE).map(([k, v]) => <option key={k} value={k}>{v.label}{counts.data ? ` (${counts.data[k] ?? 0})` : ''}</option>)}
          </select>
          <select aria-label="Source" value={source} onChange={(e) => { setSource(e.target.value); setRecruiterIds([]); setAgencyIds([]); setPage(1); }}>
            <option value="">Any source</option><option value="internal">Company recruiter</option><option value="agency">Agency</option>
          </select>
          {source === 'internal' && (
            <MultiPick label="Recruiters" value={recruiterIds} onChange={(ids) => { setRecruiterIds(ids); setPage(1); }}
              options={(recruiters.data?.data ?? []).filter((u) => u.roles.some((r) => r.code === 'internal_recruiter')).map((u) => ({ id: u.id, name: u.full_name }))} />
          )}
          {source === 'agency' && (
            <MultiPick label="Agencies" value={agencyIds} onChange={(ids) => { setAgencyIds(ids); setPage(1); }}
              options={(agencies.data ?? []).map((a) => ({ id: a.id, name: a.name }))} />
          )}
          <input type="search" placeholder="City" aria-label="City" value={city} onChange={(e) => { setCity(e.target.value); setPage(1); }} style={{ width: 120 }} />
        </div>
        {list.isPending ? <Loading /> : list.isError ? <ErrorState error={list.error} onRetry={() => list.refetch()} /> : data!.data.length === 0 ? (
          <EmptyState title="No candidates match">Try fewer filters, or add or import candidates.</EmptyState>
        ) : (
          <>
            <div className="table-wrap"><table className="sheet-table">
              <thead><tr>
                {SORTABLE.slice(0, 3).map(([k, l]) => <th key={k} aria-sort={sort === k ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}><button className="th-btn" onClick={() => sortBy(k)}>{l}{sort === k ? (dir === 'asc' ? ' ▲' : ' ▼') : ''}</button></th>)}
                <th>Feedback</th><th>Source</th>
                {SORTABLE.slice(3).map(([k, l]) => <th key={k} aria-sort={sort === k ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}><button className="th-btn" onClick={() => sortBy(k)}>{l}{sort === k ? (dir === 'asc' ? ' ▲' : ' ▼') : ''}</button></th>)}
                <th />
              </tr></thead>
              <tbody>{data!.data.map((r) => {
                const st = statusOf(r);
                return (
                  <tr key={r.id}>
                    <td><Link className="row-link" to="/candidates/$id" params={{ id: r.id }}>{r.full_name}</Link><div className="cell-sub">{[r.current_title, r.email].filter(Boolean).join(' · ')}</div><IdTags sourcing={r.sourcing_code} temp={r.temp_employee_code} /></td>
                    <td>{r.job_title ? <Link to="/vacancies/$id" params={{ id: r.vacancy_id! }} className="row-link">{r.job_title}</Link> : <span className="muted">—</span>}{r.applications > 1 && <div className="cell-sub">+{r.applications - 1} more</div>}</td>
                    <td>
                      <Badge tone={st.tone}>{st.label}</Badge>
                    </td>
                    <td>{r.avg_rating !== null ? <strong>{r.avg_rating.toFixed(1)}<small className="muted">/5</small></strong> : <span className="muted">—</span>}{r.decision_reason && <div className="cell-sub decision-remark">“{r.decision_reason}”</div>}</td>
                    <td className="cell-sub">{r.source ?? '—'}</td>
                    <td>{r.city ?? '—'}</td><td className="num">{r.total_experience_years ?? '—'}</td><td className="num">{r.notice_period_days ?? '—'}</td><td>{formatDay(r.created_at)}</td>
                    <td className="actions">
                      {r.simple_status === 'selected' && hr ? (
                        // After selection only joining is left: joined, or the candidate backed out.
                        <span className="actions-row">
                          <button className="btn btn-sm btn-primary" onClick={() => setDialog({ kind: 'join', row: r })}>Mark joined</button>
                          <button className="btn btn-sm" onClick={() => setDialog({ kind: 'backout', row: r })}>Backout</button>
                        </span>
                      ) : r.application_id && ['sourced', 'interview'].includes(r.simple_status ?? '') && (
                        <button className="btn btn-sm" onClick={() => setDialog({ kind: 'schedule', row: r })}>Schedule interview</button>
                      )}
                    </td>
                  </tr>
                );
              })}</tbody>
            </table></div>
            <Pager page={data!.page} pageSize={data!.page_size} total={data!.total} onPage={setPage} />
          </>
        )}
      </div>
      {dialog?.kind === 'add' && <CreateCandidateDialog onClose={() => { setDialog(null); refresh(); }} />}
      {dialog?.kind === 'import' && <ImportDialog onClose={() => { setDialog(null); refresh(); }} />}
      {dialog && 'row' in dialog && dialog.kind === 'schedule' && <ScheduleDialog applicationId={dialog.row.application_id!} vacancyId={dialog.row.vacancy_id!} onClose={() => { setDialog(null); refresh(); }} />}
      {dialog && 'row' in dialog && dialog.kind === 'backout' && <BackoutDialog row={dialog.row} onClose={() => { setDialog(null); refresh(); }} />}
      {dialog && 'row' in dialog && dialog.kind === 'join' && <JoinDialog applicationId={dialog.row.application_id!} name={dialog.row.full_name} title={dialog.row.current_title} onClose={() => { setDialog(null); refresh(); }} />}
    </>
  );
}



interface ImportResult { summary: { dry_run: boolean; total: number; created: number; existing: number; failed: number; submitted: number; duplicates: number }; rows: { row: number; status: string; submission?: string; error?: string }[] }

function ImportDialog({ onClose }: { onClose: () => void }) {
  const [csv, setCsv] = useState('');
  const [name, setName] = useState('');
  const [result, setResult] = useState<ImportResult | null>(null);
  const run = useMutation({ mutationFn: (dry: boolean) => api<{ data: ImportResult }>('POST', '/candidates/import', { csv, dry_run: dry }).then((r) => r.data), onSuccess: setResult });
  const read = async (f: File | undefined) => { if (!f) return; setName(f.name); setCsv(await f.text()); setResult(null); };
  const s = result?.summary;
  return (
    <Dialog open wide title="Import candidates from CSV" onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>{s && !s.dry_run ? 'Done' : 'Cancel'}</button>
      <button className="btn" disabled={!csv || run.isPending} onClick={() => run.mutate(true)}>Check file</button>
      <button className="btn btn-primary" disabled={!csv || run.isPending || (s?.dry_run === false)} onClick={() => run.mutate(false)}>Import</button></>}>
      <FormError error={run.error} />
      <p style={{ marginTop: 0 }} className="muted">First row: column names. Needed: <strong>Name</strong> and <strong>Email</strong> or <strong>Phone</strong>. Optional: City, Title, Experience, Notice period, Skills, and <strong>Job</strong> (a job code like VAC-0001) to submit each person to that job. In Excel, use Save as CSV.</p>
      <Field id="imp-file" label="CSV file"><input id="imp-file" type="file" accept=".csv,text/csv" onChange={(e) => read(e.target.files?.[0])} /></Field>
      {name && <p className="cell-sub">{name}</p>}
      {s && (
        <div className={`alert ${s.failed && !s.created && !s.existing ? 'alert-error' : 'alert-success'}`} role="status">
          {s.dry_run ? 'Checked, nothing saved yet. ' : 'Imported. '}{s.created} new, {s.existing} already in the database{s.submitted ? `, ${s.submitted} submitted to jobs` : ''}{s.duplicates ? `, ${s.duplicates} duplicate submissions refused` : ''}, {s.failed} need fixing.
        </div>
      )}
      {result && result.rows.filter((r) => r.status === 'failed' || r.submission === 'duplicate').length > 0 && (
        <div className="table-wrap" style={{ maxHeight: 220, overflow: 'auto' }}><table><tbody>
          {result.rows.filter((r) => r.status === 'failed' || r.submission === 'duplicate').map((r) => <tr key={r.row}><td>Row {r.row}</td><td>{r.error ?? 'Already submitted for this job. The original submission keeps ownership.'}</td></tr>)}
        </tbody></table></div>
      )}
    </Dialog>
  );
}

function BackoutDialog({ row, onClose }: { row: Row; onClose: () => void }) {
  const [reason, setReason] = useState('');
  const save = useMutation({ mutationFn: () => api('POST', `/applications/${row.application_id}/backout`, { reason }), onSuccess: onClose });
  return (
    <Dialog open title={`${row.full_name} did not join`} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-danger" disabled={save.isPending || !reason.trim()} onClick={() => save.mutate()}>Mark backout</button></>}>
      <FormError error={save.error} />
      <Field id="bo-reason" label="Reason" hint="For example: took another offer, not reachable."><input id="bo-reason" value={reason} onChange={(e) => setReason(e.target.value)} autoFocus /></Field>
    </Dialog>
  );
}
