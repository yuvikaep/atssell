import { useEffect, useRef } from 'react';

/** A dropdown of checkboxes: pick any number of people or agencies. */
export function MultiPick({ label, options, value, onChange }: { label: string; options: { id: string; name: string }[]; value: string[]; onChange: (ids: string[]) => void }) {
  // Closes when clicking anywhere outside, so it never covers the form below.
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => { if (ref.current?.open && !ref.current.contains(e.target as Node)) ref.current.open = false; };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);
  const toggle = (id: string) => onChange(value.includes(id) ? value.filter((v) => v !== id) : [...value, id]);
  const summary = value.length === 0 ? `All ${label.toLowerCase()}` : value.length === 1 ? options.find((o) => o.id === value[0])?.name ?? '1 selected' : `${value.length} ${label.toLowerCase()}`;
  return (
    <details className="multi-pick" ref={ref}>
      <summary aria-label={label}>{summary}</summary>
      <div className="multi-pick-menu" role="group" aria-label={label}>
        {options.length === 0 ? <p className="muted" style={{ margin: 8 }}>None yet.</p> : (
          <>
            <div className="multi-pick-tools">
              <button type="button" className="btn btn-link btn-sm" onClick={() => onChange(options.map((o) => o.id))}>Select all</button>
              <button type="button" className="btn btn-link btn-sm" onClick={() => onChange([])}>Clear</button>
            </div>
            {options.map((o) => (
              <label key={o.id} className="multi-pick-item"><input type="checkbox" checked={value.includes(o.id)} onChange={() => toggle(o.id)} /> {o.name}</label>
            ))}
          </>
        )}
      </div>
    </details>
  );
}
