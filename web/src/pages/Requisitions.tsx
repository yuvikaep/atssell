import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useDeferredValue, useState } from 'react';
import { can, formatDay, REQUISITION_STATUS_LABEL, type RequisitionStatus } from '../api';
import { useMe } from '../components/AppShell';
import { RequisitionFormDialog } from '../components/RequisitionForm';
import { Badge, EmptyState, ErrorState, Loading, Pager, type Tone } from '../components/ui';
import { requisitionsQuery } from '../queries';
import { useSessionState } from '../session-storage';

export const REQUISITION_TONE: Record<RequisitionStatus, Tone> = {
  draft: 'muted', pending_approval: 'warning', approved: 'success', rejected: 'danger', cancelled: 'muted',
};
const STATUS_OPTIONS = ['draft', 'pending_approval', 'approved', 'rejected', 'cancelled'] as const;
const STATUSES = ['all', ...STATUS_OPTIONS] as const;

export function RequisitionsPage() {
  const me = useMe();
  const [status, setStatus] = useSessionState('jm.requisitions.status', 'all', STATUSES);
  const [mine, setMine] = useState(false);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const q = useDeferredValue(search.trim());
  const list = useQuery(requisitionsQuery({ status, q, mine, page }));
  const canCreate = can(me, 'requisitions.create');

  const filtered = status !== 'all' || q !== '' || mine;
  return (
    <>
      <div className="page-header">
        <div>
          <h1>Hiring requests</h1>
          <p>Request headcount and track it through approval.</p>
        </div>
        {canCreate && <button className="btn btn-primary" onClick={() => setCreating(true)}>New hiring request</button>}
      </div>

      <div className="card">
        <div className="toolbar">
          <input className="grow" type="search" placeholder="Search by title" aria-label="Search requisitions" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} />
          <select aria-label="Status" value={status} onChange={(e) => { setStatus(e.target.value as (typeof STATUSES)[number]); setPage(1); }}>
            <option value="all">All statuses</option>
            {STATUS_OPTIONS.map((s) => <option key={s} value={s}>{REQUISITION_STATUS_LABEL[s]}</option>)}
          </select>
          <label className="check"><input type="checkbox" checked={mine} onChange={(e) => { setMine(e.target.checked); setPage(1); }} /> Mine only</label>
        </div>
        {list.isPending ? (
          <Loading />
        ) : list.isError ? (
          <ErrorState error={list.error} onRetry={() => list.refetch()} />
        ) : list.data.data.length === 0 ? (
          <EmptyState
            title={filtered ? 'No requisitions match' : 'No requisitions yet'}
            action={!filtered && canCreate ? <button className="btn btn-primary" onClick={() => setCreating(true)}>Create the first requisition</button> : undefined}
          >
            {filtered ? 'Try different filters.' : 'A requisition requests approval to hire. Once approved, you open vacancies from it.'}
          </EmptyState>
        ) : (
          <>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr><th>Title</th><th>Department</th><th className="num">Positions</th><th>Status</th><th>Waiting on</th><th>Target date</th></tr>
                </thead>
                <tbody>
                  {list.data.data.map((r) => (
                    <tr key={r.id}>
                      <td>
                        <Link className="row-link" to="/requisitions/$id" params={{ id: r.id }}>{r.title}</Link>
                        <div className="cell-sub">{r.location}{r.priority === 'high' || r.priority === 'critical' ? ` · ${r.priority} priority` : ''}</div>
                      </td>
                      <td>{r.department_name}</td>
                      <td className="num">{r.headcount}</td>
                      <td><Badge tone={REQUISITION_TONE[r.status]}>{REQUISITION_STATUS_LABEL[r.status]}</Badge></td>
                      <td>{r.status === 'pending_approval' ? r.pending_with ?? '—' : <span className="muted">—</span>}</td>
                      <td className="muted">{formatDay(r.target_date)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pager page={page} pageSize={list.data.page_size} total={list.data.total} onPage={setPage} />
          </>
        )}
      </div>
      {creating && <RequisitionFormDialog onClose={() => setCreating(false)} />}
    </>
  );
}
