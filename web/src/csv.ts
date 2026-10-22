// CSV downloads for the lists (opens in Excel). Cells starting with = + - @ are neutralised so a
// spreadsheet never runs them as formulas.
const cell = (v: unknown) => {
  let t = v === null || v === undefined ? '' : Array.isArray(v) ? v.join('; ') : String(v);
  if (typeof v !== 'number' && /^[=+\-@\t\r]/.test(t)) t = `'${t}`;
  return /[",\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
};

export function downloadCsv(name: string, head: string[], rows: unknown[][]) {
  const blob = new Blob([`﻿${[head, ...rows].map((l) => l.map(cell).join(',')).join('\r\n')}\r\n`], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${name}-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}
