import type { ReactNode } from 'react';

/** A number with a label. The value is always text, so nothing depends on colour. */
export function Stat({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: ReactNode; tone?: 'good' | 'warn' | 'bad' }) {
  return (
    <div className="card stat">
      <div className="label">{label}</div>
      <div className="value" data-tone={tone}>{value}</div>
      {hint && <div className="foot">{hint}</div>}
    </div>
  );
}

export function Meter({ value, max }: { value: number; max: number }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return <span className="meter" role="img" aria-label={`${value} of ${max}`}><span style={{ width: `${pct}%` }} /></span>;
}

export const pctText = (n: number | null | undefined) => (n === null || n === undefined ? '–' : `${n}%`);
