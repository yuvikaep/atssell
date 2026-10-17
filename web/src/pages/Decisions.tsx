import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { DECISION_LABEL, type DecisionKind } from '../api';
import { Badge, EmptyState, ErrorState, formatDate, Loading, type Tone } from '../components/ui';
import { decisionListQuery } from '../queries';

const TABS: { key: string; label: string; hint: string; tone: Tone }[] = [
  { key: 'select', label: 'Selected', hint: 'Candidates you chose to hire.', tone: 'success' },
  { key: 'additional_round', label: 'Next round', hint: 'Candidates you sent to another round.', tone: 'info' },
  { key: 'hold', label: 'On hold', hint: 'Candidates you are keeping on hold.', tone: 'warning' },
  { key: 'reject', label: 'Rejected', hint: 'Candidates you passed on.', tone: 'danger' },
];

/** Where each candidate stands after the hiring manager's decision, with the remark that was left. */
export function DecisionsPage() {
  const [tab, setTab] = useState(TABS[0]!);
  const list = useQuery(decisionListQuery(tab.key));
  return (
    <>
      <div className="page-header">
        <div><h1>Decisions</h1><p>Candidates grouped by the decision you made, with your remark.</p></div>
      </div>
      <div className="card">
        <div className="toolbar" role="tablist" aria-label="Decision">
          {TABS.map((t) => <button key={t.key} role="tab" aria-selected={tab.key === t.key} className={`btn btn-sm ${tab.key === t.key ? 'btn-primary' : ''}`} onClick={() => setTab(t)}>{t.label}</button>)}
        </div>
        {list.isPending ? <Loading /> : list.isError ? <ErrorState error={list.error} onRetry={() => list.refetch()} /> : list.data.length === 0 ? (
          <EmptyState title={`No candidates ${tab.label.toLowerCase()}`}>{tab.hint}</EmptyState>
        ) : (
          <div className="table-wrap"><table>
            <thead><tr><th>Candidate</th><th>Job</th><th>Remark</th><th>Decided</th></tr></thead>
            <tbody>{list.data.map((r) => (
              <tr key={r.id}>
                <td><strong>{r.candidate_name}</strong><div><Badge tone={tab.tone}>{DECISION_LABEL[r.decision as DecisionKind] ?? r.decision}</Badge></div></td>
                <td><Link className="row-link" to="/vacancies/$id" params={{ id: r.vacancy_id }}>{r.vacancy_title}</Link></td>
                <td className="decision-remark">{r.reason ? `“${r.reason}”` : '—'}</td>
                <td>{formatDate(r.decided_at)}<div className="cell-sub">{r.decided_by_name}</div></td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </div>
    </>
  );
}
