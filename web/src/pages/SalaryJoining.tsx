import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { api, formatDay, formatInr } from '../api';
import { Badge, Dialog, EmptyState, ErrorState, Field, fieldError, FormError, IdTags, Loading } from '../components/ui';

interface TermsRow {
  id: string; sourcing_code: string; temp_employee_code: string; job_title: string; vacancy_id: string; terms_owner: 'recruiter' | 'interviewer' | 'admin';
  candidate_id: string; candidate_name: string; current_title: string | null;
  annual_ctc: number | string | null; joining_date: string | null; terms_status: 'proposed' | 'approved' | null;
  proposed_by_name: string | null; approved_by_name: string | null; can_edit: boolean; can_approve: boolean;
}

/**
 * Salary and joining for selected candidates. Whoever the job names (recruiter, interviewer or admin)
 * enters them; the admin approves or sets them directly. Once approved, only the admin can change them.
 */
export function SalaryJoiningPage() {
  const queryClient = useQueryClient();
  const list = useQuery({ queryKey: ['joining-terms'], queryFn: () => api<{ data: TermsRow[]; is_admin: boolean }>('GET', '/joining-terms') });
  const [editing, setEditing] = useState<TermsRow | null>(null);
  const refresh = () => Promise.all(['joining-terms', 'candidate-status', 'employment', 'master'].map((k) => queryClient.invalidateQueries({ queryKey: [k] })));
  const approve = useMutation({ mutationFn: (id: string) => api('POST', `/applications/${id}/joining-terms/approve`), onSuccess: refresh });
  const admin = list.data?.is_admin;

  return (
    <>
      <div className="page-header"><div><h1>Salary &amp; joining</h1>
        <p>{admin ? 'Approve the salary and joining date proposed for selected candidates, or enter them yourself.' : 'Enter the agreed salary and joining date for the selected candidates you handle. The admin approves them.'}</p></div></div>
      <div className="card">
        <FormError error={approve.error} />
        {list.isPending ? <Loading /> : list.isError ? <ErrorState error={list.error} onRetry={() => list.refetch()} /> : list.data.data.length === 0 ? (
          <EmptyState title="Nothing to settle">Selected candidates you handle appear here until they join.</EmptyState>
        ) : (
          <div className="table-wrap"><table>
            <thead><tr><th>Candidate</th><th>Job</th><th className="num">Salary (₹ per year)</th><th>Joining date</th><th>Status</th><th /></tr></thead>
            <tbody>{list.data.data.map((r) => (
              <tr key={r.id}>
                <td><Link className="row-link" to="/candidates/$id" params={{ id: r.candidate_id }} search={{}}>{r.candidate_name}</Link><IdTags sourcing={r.sourcing_code} temp={r.temp_employee_code} /></td>
                <td>{r.job_title}</td>
                <td className="num">{r.annual_ctc !== null ? formatInr(Number(r.annual_ctc)) : <span className="muted">—</span>}</td>
                <td>{r.joining_date ? formatDay(r.joining_date) : <span className="muted">—</span>}</td>
                <td>
                  {r.terms_status === 'approved' ? <Badge tone="success">Approved</Badge> : r.terms_status === 'proposed' ? <Badge tone="warning">Waiting for approval</Badge> : <Badge tone="muted">Not entered</Badge>}
                  {r.proposed_by_name && <div className="cell-sub">{r.terms_status === 'approved' && r.approved_by_name ? `Approved by ${r.approved_by_name}` : `By ${r.proposed_by_name}`}</div>}
                </td>
                <td className="actions">
                  {r.can_approve && <button className="btn btn-sm btn-primary" disabled={approve.isPending} onClick={() => approve.mutate(r.id)}>Approve</button>}
                  {r.can_edit && <button className="btn btn-sm" onClick={() => setEditing(r)}>{r.terms_status ? 'Change' : 'Enter'}</button>}
                </td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </div>
      {editing && <TermsDialog row={editing} admin={!!admin} onClose={() => { setEditing(null); refresh(); }} />}
    </>
  );
}

function TermsDialog({ row, admin, onClose }: { row: TermsRow; admin: boolean; onClose: () => void }) {
  const [ctc, setCtc] = useState(row.annual_ctc !== null ? String(Number(row.annual_ctc)) : '');
  const [date, setDate] = useState(row.joining_date?.slice(0, 10) ?? '');
  const save = useMutation({ mutationFn: () => api('POST', `/applications/${row.id}/joining-terms`, { annual_ctc: Number(ctc), joining_date: date }), onSuccess: onClose });
  return (
    <Dialog open title={`Salary and joining: ${row.candidate_name}`} onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={save.isPending || !ctc || !date} onClick={() => save.mutate()}>{admin ? 'Save and approve' : 'Send for approval'}</button></>}>
      <FormError error={save.error && !fieldError(save.error, 'annual_ctc') && !fieldError(save.error, 'joining_date') ? save.error : null} />
      <Field id="jt-ctc" label="Agreed salary (₹ per year)" error={fieldError(save.error, 'annual_ctc')}><input id="jt-ctc" inputMode="numeric" value={ctc} onChange={(e) => setCtc(e.target.value.replace(/[^\d.]/g, ''))} autoFocus /></Field>
      <Field id="jt-date" label="Joining date" error={fieldError(save.error, 'joining_date')}><input id="jt-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
    </Dialog>
  );
}
