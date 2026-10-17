import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { api } from '../api';
import { Icon } from '../components/Icon';
import { Stat, pctText } from '../components/Stat';
import { ErrorState, Loading } from '../components/ui';

interface Me { rank?: number | null; raw_submissions: number; valid_submissions: number; duplicate_attempts: number; interviewed: number; selected: number; joined: number; active: number; exited: number; replacements_due?: number; conversion_pct: number | null }
interface Perf { range: { from: string; to: string }; me: Me | null; recruiters_ranked?: number; scope?: 'agency' | 'me'; team?: (Me & { user_id: string; name: string })[]; definitions: Record<string, string> }

const RANGES = [{ days: 30, label: 'Last 30 days' }, { days: 90, label: 'Last 90 days' }, { days: 365, label: 'Last 12 months' }];

/** A recruiter's or an agency's own numbers: what they submitted, what counted, and what turned into joins. */
export function MyPerformance({ kind, name }: { kind: 'recruiter' | 'agency'; name: string }) {
  const [days, setDays] = useState(90);
  const from = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  const path = kind === 'recruiter' ? '/me/performance' : '/agency/performance';
  const q = useQuery({ queryKey: ['performance', kind, days], queryFn: () => api<{ data: Perf }>('GET', `${path}?from=${from}`).then((r) => r.data) });
  const m = q.data?.me;
  return (
    <>
      <div className="page-header">
        <div><h1>Hello, {name}</h1><p>{kind === 'agency' && q.data?.scope === 'me' ? 'Your own performance.' : kind === 'agency' ? 'Your agency\'s performance.' : 'Your performance.'}</p></div>
        <div className="actions-row">
          {kind === 'recruiter' && <Link className="btn btn-primary" to="/sourcing" search={{ job: undefined }}><Icon name="plus" size={16} />Source a candidate</Link>}
          {kind === 'agency' && <Link className="btn btn-primary" to="/portal"><Icon name="plus" size={16} />Submit a candidate</Link>}
          <select aria-label="Period" value={days} onChange={(e) => setDays(Number(e.target.value))} style={{ width: 'auto' }}>{RANGES.map((r) => <option key={r.days} value={r.days}>{r.label}</option>)}</select>
        </div>
      </div>
      {q.isPending ? <Loading /> : q.isError ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : !m ? (
        <div className="card section"><h2>No submissions yet</h2><p className="muted">Once you submit candidates, your numbers appear here.</p></div>
      ) : (
        <>
          <div className="stats">
            {m.rank && q.data.recruiters_ranked ? <Stat label="Your rank" value={`#${m.rank}`} hint={`of ${q.data.recruiters_ranked} recruiters`} /> : null}
            <Stat label="Valid submissions" value={m.valid_submissions} hint={`${m.raw_submissions} attempted${m.duplicate_attempts ? `, ${m.duplicate_attempts} duplicate` : ''}`} />
            <Stat label="Interviewed" value={m.interviewed} />
            <Stat label="Selected" value={m.selected} />
            <Stat label="Joined" value={m.joined} hint={`${m.active} active · ${m.exited} exited`} />
            <Stat label="Conversion" value={pctText(m.conversion_pct)} hint="Joined ÷ valid submissions" />
          </div>
          {q.data.team && q.data.team.length > 0 && (
            <div className="card">
              <div className="toolbar"><h2>Your team</h2></div>
              <div className="table-wrap"><table>
                <thead><tr><th>Name</th><th className="num">Valid</th><th className="num">Interviewed</th><th className="num">Selected</th><th className="num">Joined</th></tr></thead>
                <tbody>{q.data.team.map((t) => <tr key={t.user_id}><td>{t.name}</td><td className="num">{t.valid_submissions}</td><td className="num">{t.interviewed}</td><td className="num">{t.selected}</td><td className="num">{t.joined}</td></tr>)}</tbody>
              </table></div>
            </div>
          )}
          <p className="metric-def" style={{ padding: '12px 0' }}>{q.data.definitions.valid_submissions} {q.data.definitions.joined} Period: {q.data.range.from} to {q.data.range.to}.</p>
        </>
      )}
    </>
  );
}
