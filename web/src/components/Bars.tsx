/** A plain horizontal bar list. Values are shown as text too, so nothing depends on colour or width. */
export function Bars({ rows, suffix = '' }: { rows: { label: string; value: number; note?: string }[]; suffix?: string }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <div className="bars">
      {rows.map((r) => (
        <div key={r.label} className="bar-row">
          <span className="bar-label">{r.label}</span>
          <span className="bar-track" aria-hidden><span className="bar-fill" style={{ width: `${(r.value / max) * 100}%` }} /></span>
          <span className="bar-value">{r.value}{suffix}{r.note && <span className="cell-sub"> {r.note}</span>}</span>
        </div>
      ))}
    </div>
  );
}
