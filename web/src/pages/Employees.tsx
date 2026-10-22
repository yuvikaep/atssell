import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { api, formatDay, formatInr } from '../api';
import { Badge, Dialog, EmptyState, ErrorState, Field, fieldError, FormError, Loading, type Tone, IdTags } from '../components/ui';
import { MODEL_LABEL } from './HrDashboard';
import { JoinDialog } from '../components/JoinDialog';

interface YetToJoin {
  application_id: string; sourcing_code: string; temp_employee_code: string; candidate_id: string; candidate_name: string; current_title: string | null;
  vacancy_id: string; job_title: string; agency_name: string | null; recruiter_name: string | null; selected_on: string | null;
}

interface Emp {
  id: string; sourcing_code: string; temp_employee_code: string | null; candidate_name: string; vacancy_id: string; job_title: string; joined_on: string; designation: string; annual_ctc: number; status: 'active' | 'exited';
  exit_date: string | null; exit_reason: string | null; invoice_status: string; invoice_reference: string | null; agency_name: string | null; source_agency_id: string | null; recruiter_name: string | null;
  terms_version: number | null; payment_model: string | null; fee_type: string | null; fee_value: number | null; fee_amount: number | null; replacement_status: string | null; replacement_due_by: string | null;
}
interface Rep { id: string; status: 'due' | 'replaced' | 'expired' | 'waived'; due_by: string; days_left: number | null; candidate_name: string; agency_id: string; agency_name: string; vacancy_id: string; job_title: string; employment_id: string; exit_date: string; exit_reason: string; notes: string | null }

const INVOICE: Record<string, string> = { not_invoiced: 'Not invoiced', invoiced: 'Invoiced', paid: 'Paid', credited: 'Credited' };
const REP_TONE: Record<string, Tone> = { due: 'warning', replaced: 'success', expired: 'danger', waived: 'muted' };

/** After the offer: who joined, who is still here, who left, and the replacements agencies owe. */
export function EmployeesPage() {
  const [tab, setTab] = useState<'people' | 'replacements'>('people');
  const [status, setStatus] = useState<'all' | 'yet_to_join' | 'active' | 'exited'>('all');
  const [joining, setJoining] = useState<YetToJoin | null>(null);
  const [search, setSearch] = useState('');
  const queryClient = useQueryClient();
  const [exiting, setExiting] = useState<Emp | null>(null);
  const q = search ? `&q=${encodeURIComponent(search)}` : '';
  const people = useQuery({ queryKey: ['employment', status, search], enabled: status !== 'yet_to_join', queryFn: () => api<{ data: Emp[] }>('GET', `/employment?status=${status}${q}`).then((r) => r.data) });
  const yet = useQuery({ queryKey: ['employment', 'yet-to-join', search], enabled: status === 'all' || status === 'yet_to_join', queryFn: () => api<{ data: YetToJoin[] }>('GET', `/employment/yet-to-join?${q.slice(1)}`).then((r) => r.data) });
  const reps = useQuery({ queryKey: ['replacements'], queryFn: () => api<{ data: Rep[] }>('GET', '/replacements').then((r) => r.data) });
  const invoice = useMutation({
    mutationFn: (v: { id: string; invoice_status: string }) => api('PATCH', `/employment/${v.id}/invoice`, { invoice_status: v.invoice_status }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['employment'] }),
  });
  const due = reps.data?.filter((r) => r.status === 'due').length ?? 0;
  return (
    <>
      <div className="page-header"><div><h1>Employees</h1><p>Joining, employment status, exits, and replacements agencies owe. Selected candidates wait under Yet to join until you mark them joined.</p></div></div>
      <div className="card">
        <div className="toolbar" role="tablist" aria-label="View">
          <button role="tab" aria-selected={tab === 'people'} className={`btn btn-sm ${tab === 'people' ? 'btn-primary' : ''}`} onClick={() => setTab('people')}>People</button>
          <button role="tab" aria-selected={tab === 'replacements'} className={`btn btn-sm ${tab === 'replacements' ? 'btn-primary' : ''}`} onClick={() => setTab('replacements')}>Replacements{due > 0 ? ` (${due} due)` : ''}</button>
          {tab === 'people' && (<><span style={{ flex: 1 }} /><input type="search" placeholder="Name, sourcing or temp ID" aria-label="Search" value={search} onChange={(e) => setSearch(e.target.value)} style={{ width: 220 }} />
            <select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value as typeof status)}><option value="all">All</option><option value="yet_to_join">Yet to join</option><option value="active">Active</option><option value="exited">Exited</option></select></>)}
        </div>
        {tab === 'people' && (status === 'all' || status === 'yet_to_join') && <YetToJoinTable q={yet} onJoin={setJoining} />}
        {tab === 'people' && status === 'yet_to_join' ? null : tab === 'people' ? (people.isPending ? <Loading /> : people.isError ? <ErrorState error={people.error} onRetry={() => people.refetch()} /> : people.data.length === 0 ? (
          <EmptyState title="Nobody has joined yet">Selected candidates appear under Yet to join; choose Mark joined when they start.</EmptyState>
        ) : (
          <div className="table-wrap"><table className="board-table">
            <thead><tr><th>Employee</th><th>Job</th><th>Source</th><th>Joined</th><th className="num">CTC</th><th>Status</th><th>Terms and fee</th><th>Invoice</th><th /></tr></thead>
            <tbody>{people.data.map((e) => (
              <tr key={e.id}>
                <td><strong>{e.candidate_name}</strong><div className="cell-sub">{e.designation}</div><IdTags sourcing={e.sourcing_code} temp={e.temp_employee_code} /></td>
                <td><Link className="row-link" to="/vacancies/$id" params={{ id: e.vacancy_id }}>{e.job_title}</Link></td>
                <td>{e.agency_name ?? e.recruiter_name ?? '—'}</td>
                <td>{formatDay(e.joined_on)}</td><td className="num">{formatInr(e.annual_ctc)}</td>
                <td>{e.status === 'active' ? <Badge tone="success">Active</Badge> : <Badge tone="danger">Exited</Badge>}{e.exit_date && <div className="cell-sub">{formatDay(e.exit_date)} · {e.exit_reason}</div>}
                  {e.replacement_status && <div><Badge tone={REP_TONE[e.replacement_status]!}>Replacement {e.replacement_status}</Badge></div>}</td>
                <td>{e.payment_model ? <>{MODEL_LABEL[e.payment_model]}<div className="cell-sub">v{e.terms_version} · {e.fee_type === 'percent_of_ctc' ? `${e.fee_value}%` : 'fixed'}{e.fee_amount !== null ? ` · ${formatInr(e.fee_amount)}` : ''}</div></> : <span className="muted">{e.source_agency_id ? 'No terms at joining' : '—'}</span>}</td>
                <td>{e.source_agency_id ? (
                  <select aria-label={`Invoice for ${e.candidate_name}`} value={e.invoice_status} disabled={invoice.isPending} onChange={(ev) => invoice.mutate({ id: e.id, invoice_status: ev.target.value })} style={{ width: 'auto' }}>
                    {Object.entries(INVOICE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                  </select>) : <span className="muted">—</span>}</td>
                <td className="actions">{e.status === 'active' && <button className="btn btn-sm btn-danger" onClick={() => setExiting(e)}>Mark exited</button>}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )) : <Replacements reps={reps} people={people.data ?? []} />}
        {invoice.error && <div style={{ padding: 12 }}><FormError error={invoice.error} /></div>}
      </div>
      {exiting && <ExitDialog e={exiting} onClose={() => setExiting(null)} />}
      {joining && <JoinDialog applicationId={joining.application_id} name={joining.candidate_name} title={joining.current_title} onClose={() => { setJoining(null); queryClient.invalidateQueries({ queryKey: ['employment'] }); }} />}
    </>
  );
}

function ExitDialog({ e, onClose }: { e: Emp; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [reason, setReason] = useState('');
  const save = useMutation({
    mutationFn: () => api<{ data: { replacement_due: { due_by: string } | null } }>('POST', `/employment/${e.id}/exit`, { exit_date: date, exit_reason: reason }),
    onSuccess: async () => { await Promise.all(['employment', 'replacements', 'hr-dashboard', 'leaderboard'].map((k) => queryClient.invalidateQueries({ queryKey: [k] }))); onClose(); },
  });
  return (
    <Dialog open title={`Mark ${e.candidate_name} as exited`} onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-danger" disabled={save.isPending || !reason.trim()} onClick={() => save.mutate()}>Mark exited</button></>}>
      <FormError error={save.error && !fieldError(save.error, 'exit_date') ? save.error : null} />
      <p style={{ marginTop: 0 }} className="muted">Joined {formatDay(e.joined_on)}.{e.source_agency_id ? ' If this is inside the agency\'s lock-in period a replacement is created automatically.' : ''}</p>
      <Field id="exit-date" label="Last working day" error={fieldError(save.error, 'exit_date')}><input id="exit-date" type="date" value={date} onChange={(ev) => setDate(ev.target.value)} /></Field>
      <Field id="exit-reason" label="Exit reason"><textarea id="exit-reason" rows={3} value={reason} onChange={(ev) => setReason(ev.target.value)} maxLength={2000} /></Field>
    </Dialog>
  );
}

function Replacements({ reps, people }: { reps: { isPending: boolean; isError: boolean; error: unknown; data?: Rep[]; refetch: () => unknown }; people: Emp[] }) {
  const queryClient = useQueryClient();
  const [linking, setLinking] = useState<Rep | null>(null);
  const [waiving, setWaiving] = useState<Rep | null>(null);
  if (reps.isPending) return <Loading />;
  if (reps.isError) return <ErrorState error={reps.error as Error} onRetry={() => reps.refetch()} />;
  if (!reps.data || reps.data.length === 0) return <EmptyState title="No replacements">When an agency hire leaves inside the lock-in period, the replacement owed shows up here with its deadline.</EmptyState>;
  const refresh = () => Promise.all(['replacements', 'employment', 'hr-dashboard'].map((k) => queryClient.invalidateQueries({ queryKey: [k] })));
  return (
    <>
      <div className="table-wrap"><table>
        <thead><tr><th>Left</th><th>Agency</th><th>Job</th><th>Replacement due</th><th>Status</th><th /></tr></thead>
        <tbody>{reps.data.map((r) => (
          <tr key={r.id}>
            <td><strong>{r.candidate_name}</strong><div className="cell-sub">{formatDay(r.exit_date)} · {r.exit_reason}</div></td>
            <td>{r.agency_name}</td><td>{r.job_title}</td>
            <td>{formatDay(r.due_by)}{r.days_left !== null && <div className="cell-sub">{r.days_left >= 0 ? `${r.days_left} days left` : `${-r.days_left} days late`}</div>}</td>
            <td><Badge tone={REP_TONE[r.status]!}>{r.status}</Badge>{r.notes && <div className="cell-sub">{r.notes}</div>}</td>
            <td className="actions">{r.status === 'due' && <><button className="btn btn-sm btn-primary" onClick={() => setLinking(r)}>Link replacement</button><button className="btn btn-sm" onClick={() => setWaiving(r)}>Waive</button></>}</td>
          </tr>
        ))}</tbody>
      </table></div>
      {linking && <LinkDialog rep={linking} candidates={people.filter((p) => p.source_agency_id === linking.agency_id && p.vacancy_id === linking.vacancy_id && p.id !== linking.employment_id)} onClose={() => { setLinking(null); refresh(); }} />}
      {waiving && <WaiveDialog rep={waiving} onClose={() => { setWaiving(null); refresh(); }} />}
    </>
  );
}

function LinkDialog({ rep, candidates, onClose }: { rep: Rep; candidates: Emp[]; onClose: () => void }) {
  const [id, setId] = useState('');
  const save = useMutation({ mutationFn: () => api('POST', `/replacements/${rep.id}/link`, { replacement_employment_id: id }), onSuccess: onClose });
  return (
    <Dialog open title={`Replacement for ${rep.candidate_name}`} onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={!id || save.isPending} onClick={() => save.mutate()}>Link</button></>}>
      <FormError error={save.error} />
      <p style={{ marginTop: 0 }} className="muted">Choose the person {rep.agency_name} placed for {rep.job_title} instead. They must already be marked joined.</p>
      <Field id="rep-pick" label="Replacement hire">
        <select id="rep-pick" value={id} onChange={(e) => setId(e.target.value)}>
          <option value="">{candidates.length ? 'Choose a hire' : 'No other joined hire from this agency for this job'}</option>
          {candidates.map((c) => <option key={c.id} value={c.id}>{c.candidate_name} · joined {formatDay(c.joined_on)}</option>)}
        </select>
      </Field>
    </Dialog>
  );
}

function WaiveDialog({ rep, onClose }: { rep: Rep; onClose: () => void }) {
  const [notes, setNotes] = useState('');
  const save = useMutation({ mutationFn: () => api('POST', `/replacements/${rep.id}/waive`, { notes }), onSuccess: onClose });
  return (
    <Dialog open title="Waive this replacement" onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={!notes.trim() || save.isPending} onClick={() => save.mutate()}>Waive</button></>}>
      <FormError error={save.error} />
      <Field id="waive-notes" label="Why is it waived?"><textarea id="waive-notes" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
    </Dialog>
  );
}

/** Selected candidates (with a temp employee ID) who have not joined yet. */
function YetToJoinTable({ q, onJoin }: { q: { isPending: boolean; isError: boolean; error: unknown; data?: YetToJoin[]; refetch: () => unknown }; onJoin: (r: YetToJoin) => void }) {
  if (q.isPending) return <Loading />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  if (!q.data?.length) return null;
  return (
    <div className="section" style={{ paddingBottom: 0 }}>
      <h2 style={{ marginBottom: 8 }}>Yet to join <span className="count">{q.data.length}</span></h2>
      <div className="table-wrap"><table className="board-table">
        <thead><tr><th>Candidate</th><th>Job</th><th>Source</th><th>Selected on</th><th>Status</th><th /></tr></thead>
        <tbody>{q.data.map((r) => (
          <tr key={r.application_id}>
            <td><Link className="row-link" to="/candidates/$id" params={{ id: r.candidate_id }} search={{}}>{r.candidate_name}</Link>{r.current_title && <div className="cell-sub">{r.current_title}</div>}<IdTags sourcing={r.sourcing_code} temp={r.temp_employee_code} /></td>
            <td><Link className="row-link" to="/vacancies/$id" params={{ id: r.vacancy_id }}>{r.job_title}</Link></td>
            <td>{r.agency_name ?? r.recruiter_name ?? '—'}</td>
            <td>{r.selected_on ? formatDay(r.selected_on) : '—'}</td>
            <td><Badge tone="warning">Yet to join</Badge></td>
            <td className="actions"><button className="btn btn-sm btn-primary" onClick={() => onJoin(r)}>Mark joined</button></td>
          </tr>
        ))}</tbody>
      </table></div>
    </div>
  );
}
