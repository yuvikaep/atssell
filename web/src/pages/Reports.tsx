import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, can } from '../api';
import { Bars } from '../components/Bars';
import { useMe } from '../components/AppShell';
import { Badge, ErrorState, formatDate, FormError, Loading } from '../components/ui';
import { analyticsQuery, departmentsQuery, exportOptionsQuery, exportsQuery, type AnalyticsFilters, type ExportJob } from '../queries';

interface Funnel { range: { from: string; to: string }; definition: string; total_applications: number; stages: { stage_id: string; name: string; reached: number; now: number; conversion_pct: number | null }[] }
interface Ageing { definition: string; total_open: number; average_age_days: number | null; buckets: { label: string; count: number }[]; oldest: { id: string; code: string; title: string; department: string; age_days: number }[] }
interface Sla { definition: string; received: number; on_time_pct: number | null; average_hours_to_feedback: number | null; pending: number; overdue: number; overdue_list: { interview_id: string; round_name: string; candidate: string | null; interviewer: string | null; hours_overdue: number }[] }
interface Activity { definition: string; recruiters: { user_id: string; name: string; candidates_added: number; stage_moves: number; interviews_scheduled: number }[] }
interface Tth { definition: string; hires: number; average_days: number | null; median_days: number | null; by_department: { department: string; hires: number; average_days: number | null }[] }
interface OffersReport { definition: string; created: number; by_status: { status: string; count: number }[]; acceptance_rate_pct: number | null; average_days_to_response: number | null; joined: number; awaiting_joining: number; backed_out: number; backed_out_pct: number | null }
interface AgencyPerf { definition: string; agencies: { agency_id: string; name: string; submitted: number; shortlisted: number; interviewed: number; hired: number; submission_to_hire_pct: number | null; rejected_duplicates: number }[] }

function Panel<T extends { definition: string }>({ title, q, children }: { title: string; q: { isPending: boolean; isError: boolean; error: unknown; data?: T; refetch: () => unknown }; children: (d: T) => React.ReactNode }) {
  return (
    <div className="card">
      <div className="toolbar"><h2>{title}</h2></div>
      {q.isPending ? <Loading /> : q.isError ? <ErrorState error={q.error as Error} onRetry={() => q.refetch()} /> : (
        <>
          {children(q.data!)}
          <p className="metric-def">{q.data!.definition}</p>
        </>
      )}
    </div>
  );
}

export function ReportsPage() {
  const me = useMe();
  const [filters, setFilters] = useState<AnalyticsFilters>({});
  const departments = useQuery(departmentsQuery('active'));
  const canAgencies = can(me, 'agencies.manage');
  const funnel = useQuery(analyticsQuery<Funnel>('hiring-funnel', filters));
  const ageing = useQuery(analyticsQuery<Ageing>('vacancy-ageing', filters));
  const sla = useQuery(analyticsQuery<Sla>('feedback-sla', filters));
  const activity = useQuery(analyticsQuery<Activity>('recruiter-activity', filters));
  const tth = useQuery(analyticsQuery<Tth>('time-to-hire', filters));
  const offers = useQuery(analyticsQuery<OffersReport>('offers', filters));
  const agencies = useQuery(analyticsQuery<AgencyPerf>('agency-performance', filters, canAgencies));
  const set = (patch: Partial<AnalyticsFilters>) => setFilters((f) => ({ ...f, ...patch }));

  return (
    <>
      <div className="page-header">
        <div><h1>Reports</h1><p>Figures cover only the vacancies you can see. Each report says how it is counted.</p></div>
      </div>
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="filters">
          <label>From<input type="date" value={filters.from ?? ''} onChange={(e) => set({ from: e.target.value || undefined })} /></label>
          <label>To<input type="date" value={filters.to ?? ''} onChange={(e) => set({ to: e.target.value || undefined })} /></label>
          <label>Department
            <select value={filters.department_id ?? ''} onChange={(e) => set({ department_id: e.target.value || undefined })}>
              <option value="">All departments</option>
              {departments.data?.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </label>
          <button className="btn btn-sm" onClick={() => setFilters({})} disabled={!filters.from && !filters.to && !filters.department_id}>Clear</button>
          <span className="muted" style={{ fontSize: 12 }}>{funnel.data ? `Showing ${funnel.data.range.from} to ${funnel.data.range.to}` : ''}</span>
        </div>
      </div>

      <div className="report-grid">
        <Panel title="Hiring funnel" q={funnel}>{(d) => (
          <Bars rows={d.stages.filter((s) => s.reached > 0 || s.now > 0).map((s) => ({ label: s.name, value: s.reached, note: s.conversion_pct !== null ? `(${s.conversion_pct}%)` : undefined }))} />
        )}</Panel>
        <Panel title="Time to hire" q={tth}>{(d) => d.hires === 0 ? <p className="empty-inline" style={{ padding: '0 16px 12px' }}>No hires in this period.</p> : (
          <div style={{ padding: '0 16px 8px' }}>
            <p style={{ margin: '0 0 8px' }}><strong>{d.median_days} days</strong> median · {d.average_days} days average · {d.hires} hire{d.hires === 1 ? '' : 's'}</p>
            <Bars rows={d.by_department.map((x) => ({ label: x.department, value: x.average_days ?? 0, note: `(${x.hires})` }))} suffix=" d" />
          </div>
        )}</Panel>
        <Panel title="Vacancy ageing" q={ageing}>{(d) => (
          <>
            <p style={{ margin: '0 16px 8px' }}>{d.total_open} open · average {d.average_age_days ?? '–'} days</p>
            <Bars rows={d.buckets.map((b) => ({ label: b.label, value: b.count }))} />
          </>
        )}</Panel>
        <Panel title="Feedback turnaround" q={sla}>{(d) => (
          <div style={{ padding: '0 16px 8px' }}>
            <p style={{ margin: '0 0 8px' }}>
              <strong>{d.on_time_pct === null ? '–' : `${d.on_time_pct}%`}</strong> on time · {d.average_hours_to_feedback ?? '–'} h average · {d.pending} pending
              {d.overdue > 0 && <> · <Badge tone="danger">{d.overdue} overdue</Badge></>}
            </p>
            {d.overdue_list.slice(0, 5).map((o) => <div key={o.interview_id} className="cell-sub">{o.candidate} · {o.round_name} · {o.interviewer} · {o.hours_overdue} h late</div>)}
          </div>
        )}</Panel>
        <Panel title="Offers and joining" q={offers}>{(d) => d.created === 0 ? <p className="empty-inline" style={{ padding: '0 16px 12px' }}>No offers in this period.</p> : (
          <div style={{ padding: '0 16px 8px' }}>
            <p style={{ margin: '0 0 8px' }}><strong>{d.acceptance_rate_pct === null ? '–' : `${d.acceptance_rate_pct}%`}</strong> accepted · {d.average_days_to_response ?? '–'} days to answer · {d.joined} joined · {d.awaiting_joining} awaiting joining · {d.backed_out} backed out</p>
            <Bars rows={d.by_status.filter((x) => x.count > 0).map((x) => ({ label: x.status.replace('_', ' '), value: x.count }))} />
          </div>
        )}</Panel>
        <Panel title="Recruiter activity" q={activity}>{(d) => d.recruiters.length === 0 ? <p className="empty-inline" style={{ padding: '0 16px 12px' }}>No activity in this period.</p> : (
          <div className="table-wrap"><table>
            <thead><tr><th>Name</th><th>Added</th><th>Moves</th><th>Interviews</th></tr></thead>
            <tbody>{d.recruiters.map((r) => <tr key={r.user_id}><td>{r.name}</td><td>{r.candidates_added}</td><td>{r.stage_moves}</td><td>{r.interviews_scheduled}</td></tr>)}</tbody>
          </table></div>
        )}</Panel>
        {canAgencies && (
          <Panel title="Agency performance" q={agencies}>{(d) => d.agencies.length === 0 ? <p className="empty-inline" style={{ padding: '0 16px 12px' }}>No agency submissions in this period.</p> : (
            <div className="table-wrap"><table>
              <thead><tr><th>Agency</th><th>Sent</th><th>Shortlisted</th><th>Interviewed</th><th>Hired</th><th>Duplicates</th></tr></thead>
              <tbody>{d.agencies.map((a) => <tr key={a.agency_id}><td>{a.name}</td><td>{a.submitted}</td><td>{a.shortlisted}</td><td>{a.interviewed}</td><td>{a.hired}{a.submission_to_hire_pct !== null && <span className="cell-sub"> ({a.submission_to_hire_pct}%)</span>}</td><td>{a.rejected_duplicates}</td></tr>)}</tbody>
            </table></div>
          )}</Panel>
        )}
      </div>

      <ExportPanel />
    </>
  );
}

function ExportPanel() {
  const options = useQuery(exportOptionsQuery);
  const jobs = useQuery(exportsQuery);
  const queryClient = useQueryClient();
  const [type, setType] = useState<string>('');
  const create = useMutation({
    mutationFn: () => api('POST', '/exports', { type }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['exports'] }),
  });
  const download = useMutation({
    mutationFn: async (id: string) => {
      const r = await api<{ data: { url: string } }>('POST', `/exports/${id}/download-link`);
      window.location.assign(r.data.url);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['exports'] }),
  });
  if (options.isPending || options.data?.length === 0) return null;
  const chosen = options.data?.find((o) => o.type === type);
  return (
    <div className="card">
      <div className="toolbar"><h2>Exports</h2></div>
      <div className="filters">
        <label>Data
          <select value={type} onChange={(e) => setType(e.target.value)}>
            <option value="">Choose…</option>
            {options.data?.map((o) => <option key={o.type} value={o.type}>{o.type === 'applications' ? 'Pipeline (applications)' : o.type[0]!.toUpperCase() + o.type.slice(1)}</option>)}
          </select>
        </label>
        <button className="btn btn-primary" disabled={!type || create.isPending} onClick={() => create.mutate()}>Request CSV</button>
      </div>
      {chosen && <p className="metric-def">Columns: {chosen.fields.map((f) => f.label).join(', ')}. Contact details and pay appear only if your role allows them. Files are kept for 24 hours and every download is recorded.</p>}
      <FormError error={create.error ?? download.error} />
      {jobs.data && jobs.data.length > 0 && (
        <div className="table-wrap"><table>
          <tbody>{jobs.data.map((j: ExportJob) => (
            <tr key={j.id}>
              <td>{j.export_type}<div className="cell-sub">{formatDate(j.created_at)}</div></td>
              <td>{j.status === 'succeeded' ? (j.expired ? <Badge tone="muted">Expired</Badge> : <Badge tone="success">{j.row_count} rows</Badge>) : j.status === 'failed' ? <Badge tone="danger">Failed</Badge> : <Badge tone="warning">Preparing</Badge>}{j.error && <div className="cell-sub">{j.error}</div>}</td>
              <td className="actions">{j.status === 'succeeded' && !j.expired && <button className="btn btn-sm" disabled={download.isPending} onClick={() => download.mutate(j.id)}>Download</button>}</td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
    </div>
  );
}

