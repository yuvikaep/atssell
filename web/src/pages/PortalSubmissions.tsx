import { useMutation, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { api } from '../api';
import { EmptyState, ErrorState, FormError, formatDate, Loading, Pager } from '../components/ui';
import { portalSubmissionsQuery } from '../queries';
import { OwnershipBadge } from './Portal';

export function PortalSubmissionsPage() {
  const [page, setPage] = useState(1);
  const list = useQuery(portalSubmissionsQuery({ page }));
  const download = useMutation({
    mutationFn: (id: string) => api<{ data: { url: string } }>('POST', `/agency/submissions/${id}/resume-url`),
    // A signed, short-lived link; the response is an attachment so the page stays put.
    onSuccess: (res) => window.location.assign(res.data.url),
  });

  return (
    <>
      <Link className="back-link" to="/portal">← My vacancies</Link>
      <div className="page-header">
        <div>
          <h1>Submissions</h1>
          <p>Candidates your agency has submitted, and where they stand.</p>
        </div>
      </div>
      <div className="card">
        {download.error && <div style={{ padding: '12px 12px 0' }}><FormError error={download.error} /></div>}
        {list.isPending ? <Loading /> : list.isError ? <ErrorState error={list.error} onRetry={() => list.refetch()} /> : list.data.data.length === 0 ? (
          <EmptyState title="Nothing submitted yet">Open a vacancy and submit a candidate to see them here.</EmptyState>
        ) : (
          <>
            <div className="table-wrap">
              <table>
                <thead><tr><th>Candidate</th><th>Vacancy</th><th>Stage</th><th>Ownership</th><th>Submitted</th><th /></tr></thead>
                <tbody>
                  {list.data.data.map((s) => (
                    <tr key={s.id}>
                      <td>
                        <strong>{s.candidate_name}</strong>
                        <div className="cell-sub">{[s.current_title, s.city].filter(Boolean).join(' · ')}</div>
                        <div className="cell-sub">{[s.email, s.phone].filter(Boolean).join(' · ')}</div>
                      </td>
                      <td><Link className="row-link" to="/portal/vacancies/$id" params={{ id: s.vacancy.id }}>{s.vacancy.title}</Link><div className="cell-sub">{s.vacancy.code}</div></td>
                      <td>{s.stage ?? <span className="muted">—</span>}{s.application_status && s.application_status !== 'active' && <div className="cell-sub" style={{ textTransform: 'capitalize' }}>{s.application_status}</div>}</td>
                      <td><OwnershipBadge view={s.ownership} />{s.ownership.detail && <div className="cell-sub" style={{ maxWidth: 240 }}>{s.ownership.detail}</div>}</td>
                      <td className="muted">{formatDate(s.submitted_at)}{s.submitted_by && <div className="cell-sub">{s.submitted_by}</div>}</td>
                      <td className="actions">{s.has_resume && <button className="btn btn-sm" disabled={download.isPending} onClick={() => download.mutate(s.id)}>Resume</button>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pager page={page} pageSize={list.data.page_size} total={list.data.total} onPage={setPage} />
          </>
        )}
      </div>
    </>
  );
}
