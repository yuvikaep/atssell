import { useState, type CSSProperties } from 'react';

type Row = { label: string; value: number; note?: string };

/** Round axis maximum and 3–4 gridline steps, so bars read against clean numbers. */
function scale(max: number) {
  if (max <= 4) return { top: Math.max(1, max), ticks: Array.from({ length: Math.max(1, max) + 1 }, (_, i) => i) };
  const raw = max / 4;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= raw)!;
  const top = Math.ceil(max / step) * step;
  return { top, ticks: Array.from({ length: Math.round(top / step) + 1 }, (_, i) => +(i * step).toFixed(4)) };
}

/**
 * Horizontal bars: one series, one hue, the value labelled at each bar's end, and a hover card. A hidden table carries the same numbers for screen readers.
 */
export function Bars({ rows, suffix = '', title }: { rows: Row[]; suffix?: string; title?: string }) {
  const [hover, setHover] = useState<number | null>(null);
  if (rows.length === 0) return <p className="empty-inline" style={{ padding: '0 16px 12px' }}>Nothing to show yet.</p>;
  // Values are labelled on each bar, so there is no axis: the largest bar spans the track.
  const top = Math.max(...rows.map((r) => r.value), 0);
  return (
    <figure className="chart hbars" aria-label={title}>
      {rows.map((r, i) => (
        <div key={r.label} className="hbar-row" data-hover={hover === i} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
          <span className="hbar-label" title={r.label}>{r.label}</span>
          <span className="hbar-track">
            <span className="hbar-fill" style={{ '--r': top ? r.value / top : 0 } as CSSProperties} />
            <span className="hbar-value">{r.value.toLocaleString('en-IN')}{suffix}</span>
            {hover === i && <span className="chart-tip" role="tooltip"><strong>{r.label}</strong>{r.value.toLocaleString('en-IN')}{suffix}{r.note ? ` · ${r.note}` : ''}</span>}
          </span>
        </div>
      ))}
      <SrTable rows={rows} suffix={suffix} />
    </figure>
  );
}

/** Vertical columns for a short ordered set (e.g. pipeline steps). */
export function Columns({ rows, title, height = 180 }: { rows: Row[]; title?: string; height?: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const { top, ticks } = scale(Math.max(...rows.map((r) => r.value), 0));
  return (
    <figure className="chart cols" aria-label={title}>
      <div className="cols-plot" style={{ height }}>
        <div className="cols-grid" aria-hidden>{ticks.map((t) => <span key={t} style={{ bottom: `${(t / top) * 100}%` }}><em>{t.toLocaleString('en-IN')}</em></span>)}</div>
        {rows.map((r, i) => (
          <div key={r.label} className="col" onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} data-hover={hover === i}>
            <span className="col-value">{r.value.toLocaleString('en-IN')}</span>
            <span className="col-fill" style={{ height: `${top ? (r.value / top) * 100 : 0}%` }} />
            {hover === i && <span className="chart-tip" role="tooltip"><strong>{r.label}</strong>{r.value.toLocaleString('en-IN')}{r.note ? ` · ${r.note}` : ''}</span>}
          </div>
        ))}
      </div>
      <div className="cols-labels" aria-hidden>{rows.map((r) => <span key={r.label}>{r.label}</span>)}</div>
      <SrTable rows={rows} />
    </figure>
  );
}

function SrTable({ rows, suffix = '' }: { rows: Row[]; suffix?: string }) {
  return (
    <table className="sr-only"><tbody>{rows.map((r) => <tr key={r.label}><th>{r.label}</th><td>{r.value}{suffix}{r.note ? ` (${r.note})` : ''}</td></tr>)}</tbody></table>
  );
}
