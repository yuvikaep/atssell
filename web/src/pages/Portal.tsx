import { StatusCounts } from '../components/StatusCounts';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { EMPLOYMENT_TYPES, VACANCY_STATUS_LABEL, type OwnershipView } from '../api';
import { Badge, EmptyState, ErrorState, formatDate, Loading, type Tone, IdTags } from '../components/ui';
import { portalHomeQuery, portalVacanciesQuery } from '../queries';

export const OWNERSHIP_TONE: Record<OwnershipView['label'], Tone> = { Credited: 'success', 'Rejected as duplicate': 'danger' };

export function OwnershipBadge({ view }: { view: OwnershipView }) {
  return <span title={view.detail ?? undefined}><Badge tone={OWNERSHIP_TONE[view.label]}>{view.label}</Badge></span>;
}

export function PortalPage() {
  const home = useQuery(portalHomeQuery);
  const vacancies = useQuery(portalVacanciesQuery);

  if (home.isPending) return <Loading />;
  if (home.isError) return <ErrorState error={home.error} onRetry={() => home.refetch()} />;
  const h = home.data;

  return (
    <>
      <div className="page-header">
        <div>
          <h1>{h.agency.name}</h1>
          <p>Vacancies assigned to your agency, and the candidates you have submitted.</p>
        </div>
        <Link className="btn" to="/portal/submissions">All submissions</Link>
      </div>

      <StatusCounts />
      <div className="stats">
        <div className="card stat"><div className="label">Open vacancies</div><div className="value">{h.open_vacancies}</div></div>
        <div className="card stat"><div className="label">Candidates credited to you</div><div className="value">{h.submissions.credited}</div><div className="foot">{h.in_pipeline} still in the pipeline</div></div>
        <div className="card stat"><div className="label">Rejected as duplicates</div><div className="value">{h.submissions.rejected_duplicates}</div><div className="foot">Already in the company database</div></div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="toolbar"><h2>Vacancies you can submit to</h2></div>
        {vacancies.isPending ? <Loading /> : vacancies.isError ? <ErrorState error={vacancies.error} onRetry={() => vacancies.refetch()} /> : vacancies.data.length === 0 ? (
          <EmptyState title="No vacancies assigned yet">When the hiring team assigns a vacancy to your agency it appears here.</EmptyState>
        ) : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Vacancy</th><th>Type</th><th className="num">Openings</th><th className="num">Your submissions</th><th>Status</th><th /></tr></thead>
              <tbody>
                {vacancies.data.map((v) => (
                  <tr key={v.id}>
                    <td><Link className="row-link" to="/portal/vacancies/$id" params={{ id: v.id }}>{v.title}</Link><div className="cell-sub">{v.vacancy_code} · {v.location}</div></td>
                    <td>{EMPLOYMENT_TYPES[v.employment_type] ?? v.employment_type}</td>
                    <td className="num">{v.headcount}</td>
                    <td className="num">{v.my_submissions}</td>
                    <td><Badge tone={v.status === 'open' ? 'success' : 'warning'}>{VACANCY_STATUS_LABEL[v.status]}</Badge></td>
                    <td className="actions"><Link className="btn btn-sm" to="/portal/vacancies/$id" params={{ id: v.id }}>{v.status === 'open' ? 'View and submit' : 'View'}</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <div className="toolbar"><h2>Recent submissions</h2></div>
        {h.recent.length === 0 ? <EmptyState title="Nothing submitted yet">Open a vacancy to submit your first candidate.</EmptyState> : (
          <div className="table-wrap">
            <table>
              <tbody>
                {h.recent.map((s) => (
                  <tr key={s.id}>
                    <td><strong>{s.candidate_name}</strong><div className="cell-sub">{s.vacancy.code} · {s.vacancy.title}</div><IdTags sourcing={s.sourcing_code} temp={s.temp_employee_code} /></td>
                    <td>{s.stage ?? <span className="muted">—</span>}</td>
                    <td><OwnershipBadge view={s.ownership} /></td>
                    <td className="muted">{formatDate(s.submitted_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
