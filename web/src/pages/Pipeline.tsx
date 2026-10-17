import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { can } from '../api';
import { useMe } from '../components/AppShell';
import { PipelineBoard } from '../components/PipelineBoard';
import { EmptyState, ErrorState, Loading } from '../components/ui';
import { vacancyOptionsQuery } from '../queries';

const KEY = 'jm.pipeline.vacancy';
const remembered = () => { try { return sessionStorage.getItem(KEY) ?? ''; } catch { return ''; } };

export function PipelinePage() {
  const me = useMe();
  const vacancies = useQuery(vacancyOptionsQuery);
  const [chosen, setChosen] = useState(remembered);
  const options = vacancies.data?.data ?? [];
  const selected = options.find((v) => v.id === chosen) ?? options[0];

  const pick = (id: string) => {
    setChosen(id);
    try { sessionStorage.setItem(KEY, id); } catch { /* convenience only */ }
  };

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Candidate board</h1>
          <p>Move candidates through the hiring stages, one vacancy at a time.</p>
        </div>
      </div>
      {vacancies.isPending ? <Loading /> : vacancies.isError ? <ErrorState error={vacancies.error} onRetry={() => vacancies.refetch()} /> : options.length === 0 ? (
        <div className="card"><EmptyState title="No open vacancies">Open a vacancy from an approved requisition, or ask to be assigned to one.</EmptyState></div>
      ) : (
        <div className="card">
          <div className="toolbar">
            <div style={{ minWidth: 280 }}>
              <label htmlFor="pipeline-vacancy" className="muted" style={{ display: 'block', fontSize: 12, marginBottom: 4 }}>Vacancy</label>
              <select id="pipeline-vacancy" style={{ width: '100%' }} value={selected?.id} onChange={(e) => pick(e.target.value)}>
                {options.map((v) => <option key={v.id} value={v.id}>{v.vacancy_code} · {v.title} ({v.location})</option>)}
              </select>
            </div>
            {selected && <Link className="btn btn-sm" to="/vacancies/$id" params={{ id: selected.id }}>Vacancy details</Link>}
          </div>
          {selected && <PipelineBoard key={selected.id} vacancyId={selected.id} canMove={can(me, 'applications.manage')} canAdd={can(me, 'applications.manage')} canSchedule={can(me, 'interviews.manage')} canOffer={can(me, 'offers.manage')} />}
        </div>
      )}
    </>
  );
}
