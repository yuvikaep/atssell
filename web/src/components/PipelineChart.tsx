import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { Columns } from './Bars';

const STEPS: [string, string][] = [
  ['sourced', 'Sourced'], ['interview', 'Interview'], ['on_hold', 'On hold'], ['selected', 'Yet to join'],
  ['joined', 'Joined'], ['rejected', 'Rejected'], ['backout', 'Backout'], ['exited', 'Exited'],
];

/** Where my candidates are now, as columns (the counts are for the candidates this person works with). */
export function PipelineChart({ vacancyId }: { vacancyId?: string }) {
  const q = useQuery({ queryKey: ['status-summary', vacancyId ?? ''], queryFn: () => api<{ data: Record<string, number> }>('GET', `/status-summary${vacancyId ? `?vacancy_id=${vacancyId}` : ''}`).then((r) => r.data) });
  if (!q.data) return null;
  const total = Number(q.data.total ?? 0);
  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="toolbar"><h2>Candidates by status</h2><span style={{ flex: 1 }} /><span className="muted">{total.toLocaleString('en-IN')} sourced in all</span></div>
      <Columns title="Candidates by status" rows={STEPS.map(([k, label]) => ({ label, value: Number(q.data[k] ?? 0), note: total ? `${Math.round((Number(q.data[k] ?? 0) / total) * 100)}% of sourced` : undefined }))} />
    </div>
  );
}
