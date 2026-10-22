import { canExport, ExportButton } from '../components/ExportButton';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { formatInZone, INTERVIEW_STATUS_LABEL, MODE_LABEL, type InterviewRow, type InterviewStatus } from '../api';
import { useMe } from '../components/AppShell';
import { Badge, EmptyState, ErrorState, Forbidden, Loading } from '../components/ui';
import { interviewsQuery } from '../queries';
import { useSessionState } from '../session-storage';
import { STATUS_TONE } from './InterviewDetail';

const VIEWS = ['list', 'week', 'month'] as const;
const RANGES = ['upcoming', 'past', 'all'] as const;
const RANGE_LABEL = { upcoming: 'Upcoming', past: 'Past', all: 'All' } as const;

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const mondayOf = (d: Date) => addDays(startOfDay(d), -((d.getDay() + 6) % 7));
const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

export function InterviewsPage() {
  const me = useMe();
  const allowed = ['interviews.manage', 'feedback.view', 'decisions.record'].some((p) => me.permissions[p] !== undefined);
  const [view, setView] = useSessionState('jm.interviews.view', 'list', VIEWS);
  const [range, setRange] = useSessionState('jm.interviews.range', 'upcoming', RANGES);
  const [cursor, setCursor] = useState(() => startOfDay(new Date()));
  const [status, setStatus] = useState('');
  const [mode, setMode] = useState('');
  const [feedback, setFeedback] = useState('');
  const [mine, setMine] = useState(false);

  // The calendar fetches exactly the days it draws; the list fetches by the chosen range.
  const span = useMemo(() => {
    if (view === 'week') { const from = mondayOf(cursor); return { from, to: addDays(from, 7) }; }
    if (view === 'month') {
      const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
      const from = mondayOf(first);
      return { from, to: addDays(from, 42) };
    }
    return null;
  }, [view, cursor]);
  // Fixed per visit and range: a fresh timestamp on every render would change the query key each time and never finish loading.
  const now = useMemo(() => new Date(), [range]); // eslint-disable-line react-hooks/exhaustive-deps
  const filters: Record<string, string | undefined> = {
    status: status || undefined, mode: mode || undefined, feedback: feedback || undefined, interviewer_id: mine ? me.user.id : undefined,
    ...(span ? { from: span.from.toISOString(), to: span.to.toISOString() } : range === 'upcoming' ? { from: now.toISOString() } : range === 'past' ? { to: now.toISOString() } : {}),
  };
  const list = useQuery({ ...interviewsQuery(filters), enabled: allowed });
  if (!allowed) return <Forbidden />;

  const step = (dir: number) => setCursor(view === 'week' ? addDays(cursor, 7 * dir) : new Date(cursor.getFullYear(), cursor.getMonth() + dir, 1));
  const title = view === 'week'
    ? `${mondayOf(cursor).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} – ${addDays(mondayOf(cursor), 6).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}`
    : cursor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  const rows = list.data?.data ?? [];

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Interviews</h1>
          <p>Schedule, track and collect feedback. Schedule from a candidate or the pipeline.</p>
        </div>
        {canExport(me) && <ExportButton name="interviews" disabled={!list.data?.data.length} head={['Candidate', 'Job', 'Round', 'Mode', 'Start', 'Status', 'Panel', 'Feedback']}
          rows={() => (list.data?.data ?? []).map((i) => [i.candidate_name, i.vacancy_title, i.round_name, i.mode, i.scheduled_start, i.status, i.panel, `${i.feedback_submitted}/${i.feedback_expected}`])} />}
      </div>
      <div className="card">
        <div className="toolbar">
          <div className="view-toggle" role="group" aria-label="View">
            {VIEWS.map((v) => <button key={v} aria-pressed={view === v} onClick={() => setView(v)}>{v[0]!.toUpperCase() + v.slice(1)}</button>)}
          </div>
          {view === 'list' ? (
            <select aria-label="Range" value={range} onChange={(e) => setRange(e.target.value as (typeof RANGES)[number])}>
              {RANGES.map((r) => <option key={r} value={r}>{RANGE_LABEL[r]}</option>)}
            </select>
          ) : (
            <div className="actions-row" style={{ alignItems: 'center' }}>
              <button className="btn btn-sm" aria-label="Previous" onClick={() => step(-1)}>‹</button>
              <button className="btn btn-sm" onClick={() => setCursor(startOfDay(new Date()))}>Today</button>
              <button className="btn btn-sm" aria-label="Next" onClick={() => step(1)}>›</button>
              <strong style={{ marginLeft: 6 }}>{title}</strong>
            </div>
          )}
          <span style={{ flex: 1 }} />
          <select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All statuses</option>
            {(Object.keys(INTERVIEW_STATUS_LABEL) as InterviewStatus[]).map((s) => <option key={s} value={s}>{INTERVIEW_STATUS_LABEL[s]}</option>)}
          </select>
          <select aria-label="Interview type" value={mode} onChange={(e) => setMode(e.target.value)}>
            <option value="">All types</option>
            {Object.entries(MODE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <select aria-label="Feedback" value={feedback} onChange={(e) => setFeedback(e.target.value)}>
            <option value="">Any feedback status</option>
            <option value="pending">Feedback pending</option>
            <option value="overdue">Feedback overdue</option>
            <option value="submitted">Feedback received</option>
          </select>
          <label className="check"><input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} /> I am on the panel</label>
        </div>

        {list.isPending ? <Loading /> : list.isError ? <ErrorState error={list.error} onRetry={() => list.refetch()} /> : view === 'list' ? (
          rows.length === 0 ? <EmptyState title="No interviews">Nothing matches these filters. Schedule one from a candidate's profile.</EmptyState> : <InterviewTable rows={rows} />
        ) : view === 'week' ? (
          <WeekGrid rows={rows} from={mondayOf(cursor)} />
        ) : (
          <MonthGrid rows={rows} cursor={cursor} onPickDay={(d) => { setCursor(d); setView('week'); }} />
        )}
        {list.data && view === 'list' && list.data.total > rows.length && <div className="pager muted">Showing {rows.length} of {list.data.total}. Narrow the filters to see the rest.</div>}
      </div>
    </>
  );
}

function FeedbackCell({ r }: { r: InterviewRow }) {
  if (r.feedback_expected === 0) return <span className="muted">—</span>;
  return (
    <span>
      {r.feedback_submitted} of {r.feedback_expected}
      {r.feedback_overdue && <> <Badge tone="danger">Overdue</Badge></>}
    </span>
  );
}

function InterviewTable({ rows }: { rows: InterviewRow[] }) {
  return (
    <div className="table-wrap">
      <table>
        <thead><tr><th>When</th><th>Candidate</th><th>Round</th><th>Panel</th><th>Feedback</th><th>Status</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>{r.scheduled_start ? formatInZone(r.scheduled_start, r.timezone) : <span className="muted">To be decided</span>}</td>
              <td><Link className="row-link" to="/interviews/$id" params={{ id: r.id }}>{r.candidate_name}</Link><div className="cell-sub">{r.vacancy_code} · {r.vacancy_title}</div></td>
              <td>{r.round_name}<div className="cell-sub">{MODE_LABEL[r.mode]}</div></td>
              <td>{r.panel.length ? r.panel.join(', ') : <span className="muted">None yet</span>}</td>
              <td><FeedbackCell r={r} /></td>
              <td><Badge tone={STATUS_TONE[r.status]}>{INTERVIEW_STATUS_LABEL[r.status]}</Badge></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Chip({ r }: { r: InterviewRow }) {
  const navigate = useNavigate();
  const time = r.scheduled_start ? formatInZone(r.scheduled_start, r.timezone, { timeOnly: true, noZone: true }) : '';
  return (
    <button className={`cal-chip tone-${STATUS_TONE[r.status]}`} title={`${r.candidate_name} · ${r.round_name} · ${INTERVIEW_STATUS_LABEL[r.status]}`}
      onClick={() => navigate({ to: '/interviews/$id', params: { id: r.id } })}>
      <span className="cal-time">{time}</span> {r.candidate_name}{r.feedback_overdue ? ' ⚠' : ''}
    </button>
  );
}

function groupByDay(rows: InterviewRow[]) {
  const map = new Map<string, InterviewRow[]>();
  for (const r of rows) {
    if (!r.scheduled_start) continue;
    const k = dayKey(new Date(r.scheduled_start));
    map.set(k, [...(map.get(k) ?? []), r]);
  }
  return map;
}

function WeekGrid({ rows, from }: { rows: InterviewRow[]; from: Date }) {
  const byDay = groupByDay(rows);
  const today = new Date();
  return (
    <div className="cal-week">
      {Array.from({ length: 7 }, (_, i) => addDays(from, i)).map((d) => (
        <div key={dayKey(d)} className="cal-day" data-today={sameDay(d, today)}>
          <div className="cal-day-head">{d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' })}</div>
          {(byDay.get(dayKey(d)) ?? []).map((r) => <Chip key={r.id} r={r} />)}
        </div>
      ))}
    </div>
  );
}

function MonthGrid({ rows, cursor, onPickDay }: { rows: InterviewRow[]; cursor: Date; onPickDay: (d: Date) => void }) {
  const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
  const start = mondayOf(first);
  const byDay = groupByDay(rows);
  const today = new Date();
  return (
    <div className="cal-month">
      {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((w) => <div key={w} className="cal-weekday">{w}</div>)}
      {Array.from({ length: 42 }, (_, i) => addDays(start, i)).map((d) => {
        const items = byDay.get(dayKey(d)) ?? [];
        return (
          <div key={dayKey(d)} className="cal-cell" data-other={d.getMonth() !== cursor.getMonth()} data-today={sameDay(d, today)}>
            <button className="cal-date" onClick={() => onPickDay(d)} aria-label={`Open the week of ${d.toDateString()}`}>{d.getDate()}</button>
            {items.slice(0, 3).map((r) => <Chip key={r.id} r={r} />)}
            {items.length > 3 && <button className="cal-more" onClick={() => onPickDay(d)}>+{items.length - 3} more</button>}
          </div>
        );
      })}
    </div>
  );
}

