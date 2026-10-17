import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useDeferredValue, useState } from 'react';
import { api, can, formatDay } from '../api';
import { useMe } from '../components/AppShell';
import { ScheduleDialog } from '../components/ScheduleDialog';
import { Badge, Dialog, EmptyState, ErrorState, Field, fieldError, FormError, Loading, Pager, type Tone } from '../components/ui';
import { CreateCandidateDialog } from './Candidates';

interface Row {
  id: string; full_name: string; email?: string | null; phone?: string | null; city: string | null; current_title: string | null; total_experience_years: number | null;
  notice_period_days: number | null; skills: string[]; created_at: string; application_id: string | null; app_status: string | null; vacancy_id: string | null; job_title: string | null; vacancy_code: string | null;
  stage_code: string | null; stage_name: string | null; source: string | null; applications: number; avg_rating: number | null; decision: string | null; decision_reason: string | null;
  offer_status: string | null; employment_status: string | null;
}
interface Page { data: Row[]; total: number; page: number; page_size: number; stages: { code: string; name: string }[]; settable_stages: string[] }

const SORTABLE: [string, string][] = [['name', 'Name'], ['job', 'Job'], ['status', 'Status'], ['city', 'City'], ['experience', 'Exp.'], ['notice', 'Notice'], ['added', 'Added']];
const DECISION: Record<string, [string, Tone]> = { select: ['Selected', 'success'], hold: ['On hold', 'warning'], reject: ['Rejected', 'danger'], additional_round: ['Next round', 'info'], advance: ['Next round', 'info'] };

/** Plain-language status for a row. Joined and exited come from employment, the rest from the pipeline. */
export function statusOf(r: Pick<Row, 'stage_code' | 'stage_name' | 'app_status' | 'employment_status' | 'offer_status'>): { label: string; tone: Tone } {
  if (!r.stage_code) return { label: 'Not on a job', tone: 'muted' };
  if (r.employment_status === 'active') return { label: 'Joined', tone: 'success' };
  if (r.employment_status === 'exited') return { label: 'Exited', tone: 'danger' };
  if (r.app_status === 'rejected') return { label: 'Rejected', tone: 'danger' };
  if (r.app_status === 'withdrawn') return { label: 'Withdrew', tone: 'muted' };
  if (r.offer_status === 'accepted') return { label: 'Offer accepted', tone: 'success' };
  if (r.offer_status === 'declined') return { label: 'Offer declined', tone: 'danger' };
  if (r.offer_status === 'released') return { label: 'Offered', tone: 'info' };
  return { label: r.stage_code === 'submitted' ? 'Sourced' : r.stage_name ?? '', tone: r.stage_code === 'submitted' ? 'muted' : 'info' };
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
  const [stage, setStage] = useState('');
  const [source, setSource] = useState('');
  const [city, setCity] = useState('');
  const [sort, setSort] = useState('added');
  const [dir, setDir] = useState<'asc' | 'desc'>('desc');
  const [page, setPage] = useState(1);
  const [dialog, setDialog] = useState<null | { kind: 'add' | 'import' } | { kind: 'schedule' | 'offer' | 'join' | 'decision'; row: Row }>(null);

  const params = new URLSearchParams({ sort, dir, page: String(page), page_size: '50' });
  for (const [k, v] of Object.entries({ q, stage, source, city })) if (v) params.set(k, v);
  const list = useQuery({ queryKey: ['master', params.toString()], queryFn: () => api<Page>('GET', `/candidate-master?${params}`) });
  const stageIds = useQuery({ queryKey: ['stage-ids'], queryFn: () => api<{ data: { id: string; code: string }[] }>('GET', '/pipeline/stages').then((r) => Object.fromEntries(r.data.map((s) => [s.code, s.id]))) });
  const refresh = () => Promise.all(['master', 'hr-dashboard', 'candidate-status', 'candidates'].map((k) => queryClient.invalidateQueries({ queryKey: [k] })));
  const move = useMutation({
    mutationFn: (v: { applicationId: string; code: string }) => api('PATCH', `/applications/${v.applicationId}/stage`, { stage_id: stageIds.data![v.code], ...(v.code === 'rejected' || v.code === 'withdrawn' ? { reason: 'Set from the candidate sheet' } : {}) }),
    onSuccess: refresh,
  });

  const sortBy = (key: string) => { if (sort === key) setDir(dir === 'asc' ? 'desc' : 'asc'); else { setSort(key); setDir(key === 'added' ? 'desc' : 'asc'); } setPage(1); };
  const exportCsv = async () => {
    const all = await api<Page>('GET', `/candidate-master?${new URLSearchParams({ ...Object.fromEntries(params), page: '1', page_size: '200' })}`);
    const head = ['Name', 'Email', 'Phone', 'City', 'Title', 'Experience', 'Notice (days)', 'Job', 'Status', 'Source', 'Feedback avg'];
    const lines = [head, ...all.data.map((r) => [r.full_name, r.email, r.phone, r.city, r.current_title, r.total_experience_years, r.notice_period_days, r.job_title, statusOf(r).label, r.source, r.avg_rating])];
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
          <button className="btn" onClick={exportCsv} disabled={!data || data.total === 0}>Export CSV</button>
          {can(me, 'candidates.manage') && <button className="btn btn-primary" onClick={() => setDialog({ kind: 'add' })}>Add candidate</button>}
        </div>
      </div>
      <div className="card sheet">
        <div className="toolbar">
          <input className="grow" type="search" placeholder="Search name, title, city, skill or email" aria-label="Search candidates" value={text} onChange={(e) => { setText(e.target.value); setPage(1); }} />
          <select aria-label="Status" value={stage} onChange={(e) => { setStage(e.target.value); setPage(1); }}>
            <option value="">All statuses</option>{(data?.stages ?? []).map((s) => <option key={s.code} value={s.code}>{s.code === 'submitted' ? 'Sourced' : s.name}</option>)}
          </select>
          <select aria-label="Source" value={source} onChange={(e) => { setSource(e.target.value); setPage(1); }}>
            <option value="">Any source</option><option value="agency">Agencies</option><option value="internal">Company recruiters</option>
          </select>
          <input type="search" placeholder="City" aria-label="City" value={city} onChange={(e) => { setCity(e.target.value); setPage(1); }} style={{ width: 120 }} />
        </div>
        {move.error && <div style={{ padding: '12px 16px 0' }}><FormError error={move.error} /></div>}
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
                const canSet = r.application_id && r.app_status === 'active' && !r.employment_status && data!.settable_stages.length > 0;
                const d = r.decision ? DECISION[r.decision] : null;
                return (
                  <tr key={r.id}>
                    <td><Link className="row-link" to="/candidates/$id" params={{ id: r.id }}>{r.full_name}</Link><div className="cell-sub">{[r.current_title, r.email].filter(Boolean).join(' · ')}</div></td>
                    <td>{r.job_title ? <Link to="/vacancies/$id" params={{ id: r.vacancy_id! }} className="row-link">{r.job_title}</Link> : <span className="muted">—</span>}{r.applications > 1 && <div className="cell-sub">+{r.applications - 1} more</div>}</td>
                    <td>
                      {canSet ? (
                        <select aria-label={`Status for ${r.full_name}`} className="inline-status" value={data!.settable_stages.includes(r.stage_code!) ? r.stage_code! : ''} disabled={move.isPending}
                          onChange={(e) => e.target.value && move.mutate({ applicationId: r.application_id!, code: e.target.value })}>
                          {!data!.settable_stages.includes(r.stage_code!) && <option value="">{st.label}</option>}
                          {data!.stages.filter((s) => data!.settable_stages.includes(s.code)).map((s) => <option key={s.code} value={s.code}>{s.code === 'submitted' ? 'Sourced' : s.name}</option>)}
                        </select>
                      ) : <Badge tone={st.tone}>{st.label}</Badge>}
                      {d && <div><Badge tone={d[1]}>{d[0]}</Badge></div>}
                    </td>
                    <td>{r.avg_rating !== null ? <strong>{r.avg_rating.toFixed(1)}<small className="muted">/5</small></strong> : <span className="muted">—</span>}{r.decision_reason && <div className="cell-sub decision-remark">“{r.decision_reason}”</div>}</td>
                    <td className="cell-sub">{r.source ?? '—'}</td>
                    <td>{r.city ?? '—'}</td><td className="num">{r.total_experience_years ?? '—'}</td><td className="num">{r.notice_period_days ?? '—'}</td><td>{formatDay(r.created_at)}</td>
                    <td className="actions">
                      {r.application_id && r.app_status === 'active' && (
                        <select aria-label={`Actions for ${r.full_name}`} className="row-menu" value="" onChange={(e) => { const kind = e.target.value as 'schedule' | 'offer' | 'join' | 'decision'; if (kind) setDialog({ kind, row: r }); }}>
                          <option value="">Actions…</option>
                          <option value="schedule">Schedule interview</option>
                          {hr && <option value="decision">Record decision</option>}
                          {hr && <option value="offer">Record offer</option>}
                          {hr && !r.employment_status && <option value="join">Mark joined</option>}
                        </select>
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
      {dialog && 'row' in dialog && dialog.kind === 'decision' && <DecisionDialog row={dialog.row} onClose={() => { setDialog(null); refresh(); }} />}
      {dialog && 'row' in dialog && dialog.kind === 'offer' && <OfferDialog row={dialog.row} onClose={() => { setDialog(null); refresh(); }} />}
      {dialog && 'row' in dialog && dialog.kind === 'join' && <JoinDialog row={dialog.row} onClose={() => { setDialog(null); refresh(); }} />}
    </>
  );
}

function DecisionDialog({ row, onClose }: { row: Row; onClose: () => void }) {
  const [decision, setDecision] = useState('select');
  const [reason, setReason] = useState('');
  const save = useMutation({ mutationFn: () => api('POST', `/applications/${row.application_id}/decisions`, { decision, ...(reason.trim() ? { reason: reason.trim() } : {}) }), onSuccess: onClose });
  const needsReason = decision === 'hold' || decision === 'reject';
  return (
    <Dialog open title={`Decision for ${row.full_name}`} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={save.isPending || (needsReason && !reason.trim())} onClick={() => save.mutate()}>Save decision</button></>}>
      <FormError error={save.error && !fieldError(save.error, 'reason') ? save.error : null} />
      <Field id="dec-kind" label="Outcome"><select id="dec-kind" value={decision} onChange={(e) => setDecision(e.target.value)}><option value="select">Selected</option><option value="hold">Hold</option><option value="reject">Rejected</option><option value="additional_round">Another round</option></select></Field>
      <Field id="dec-reason" label={needsReason ? 'Reason (required)' : 'Remark (optional)'} error={fieldError(save.error, 'reason')}><textarea id="dec-reason" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
    </Dialog>
  );
}

function OfferDialog({ row, onClose }: { row: Row; onClose: () => void }) {
  const [ctc, setCtc] = useState('');
  const [status, setStatus] = useState<'offered' | 'accepted' | 'declined'>('offered');
  const [reason, setReason] = useState('');
  const save = useMutation({ mutationFn: () => api('POST', `/applications/${row.application_id}/offer`, { offered_ctc: Number(ctc), status, ...(status === 'declined' ? { decline_reason: reason } : {}) }), onSuccess: onClose });
  return (
    <Dialog open title={`Offer for ${row.full_name}`} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={save.isPending || !ctc || (status === 'declined' && !reason.trim())} onClick={() => save.mutate()}>Save offer</button></>}>
      <FormError error={save.error && !fieldError(save.error, 'offered_ctc') ? save.error : null} />
      <Field id="of-ctc" label="Offered CTC (₹ per year)" error={fieldError(save.error, 'offered_ctc')}><input id="of-ctc" inputMode="numeric" value={ctc} onChange={(e) => setCtc(e.target.value.replace(/[^\d.]/g, ''))} /></Field>
      <Field id="of-status" label="Offer status"><select id="of-status" value={status} onChange={(e) => setStatus(e.target.value as typeof status)}><option value="offered">Offered</option><option value="accepted">Accepted</option><option value="declined">Declined</option></select></Field>
      {status === 'declined' && <Field id="of-why" label="Why did they decline?"><textarea id="of-why" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>}
    </Dialog>
  );
}

function JoinDialog({ row, onClose }: { row: Row; onClose: () => void }) {
  const [on, setOn] = useState(new Date().toISOString().slice(0, 10));
  const [designation, setDesignation] = useState(row.current_title ?? '');
  const [ctc, setCtc] = useState('');
  const save = useMutation({ mutationFn: () => api('POST', `/applications/${row.application_id}/join`, { joined_on: on, designation, annual_ctc: Number(ctc) }), onSuccess: onClose });
  return (
    <Dialog open title={`Mark ${row.full_name} as joined`} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={save.isPending || !designation.trim() || !ctc} onClick={() => save.mutate()}>Mark joined</button></>}>
      <FormError error={save.error} />
      <p className="muted" style={{ marginTop: 0 }}>This records the actual date of joining and the agreed CTC. For agency hires it fixes the commercial terms that apply today.</p>
      <Field id="j-on" label="Date of joining"><input id="j-on" type="date" value={on} onChange={(e) => setOn(e.target.value)} /></Field>
      <Field id="j-des" label="Designation"><input id="j-des" value={designation} onChange={(e) => setDesignation(e.target.value)} /></Field>
      <Field id="j-ctc" label="Agreed annual CTC (₹)"><input id="j-ctc" inputMode="numeric" value={ctc} onChange={(e) => setCtc(e.target.value.replace(/[^\d.]/g, ''))} /></Field>
    </Dialog>
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
