import { useQuery } from '@tanstack/react-query';
import { api } from '../api';

const ITEMS: [string, string][] = [
  ['total', 'Sourced'], ['interview', 'Interview'], ['on_hold', 'On hold'], ['selected', 'Selected · yet to join'],
  ['rejected', 'Rejected'], ['joined', 'Joined'], ['backout', 'Backout'], ['exited', 'Exited'],
];

/**
 * How many of the candidates I work with are at each step. "Sourced" counts everyone sourced;
 * the rest are where they are now. Clicking a tile filters, when the page offers it.
 */
export function StatusCounts({ active, onPick, vacancyId }: { active?: string; onPick?: (status: string) => void; vacancyId?: string }) {
  const q = useQuery({ queryKey: ['status-summary', vacancyId ?? ''], queryFn: () => api<{ data: Record<string, number> }>('GET', `/status-summary${vacancyId ? `?vacancy_id=${vacancyId}` : ''}`).then((r) => r.data) });
  if (!q.data) return null;
  return (
    <div className="status-counts" role="list">
      {ITEMS.map(([k, label]) => {
        const key = k === 'total' ? '' : k;
        const n = Number(q.data[k] ?? 0);
        return onPick ? (
          <button key={k} role="listitem" className="status-count" data-active={active === key} onClick={() => onPick(key)}><strong>{n}</strong><span>{label}</span></button>
        ) : (
          <div key={k} role="listitem" className="status-count"><strong>{n}</strong><span>{label}</span></div>
        );
      })}
    </div>
  );
}
