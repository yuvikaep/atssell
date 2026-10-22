import { Link } from '@tanstack/react-router';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ApiError, fieldIssues } from '../api';

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="state" role="status">
      <div className="spinner" />
      {label}
    </div>
  );
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="state">
      <h2>{title}</h2>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  if (error instanceof ApiError && error.status === 403) return <Forbidden />;
  return (
    <div className="state" role="alert">
      <h2>Couldn't load this</h2>
      <p>{error instanceof Error ? error.message : 'Something went wrong.'}</p>
      {onRetry && <button className="btn" onClick={onRetry}>Try again</button>}
    </div>
  );
}

export function Forbidden() {
  return (
    <div className="state">
      <h2>You don't have access to this page</h2>
      <p>Ask your company admin if you need it.</p>
    </div>
  );
}

export function StatusBadge({ status }: { status: string }) {
  return <span className={`badge badge-${status}`}>{status === 'active' ? 'Active' : status === 'inactive' ? 'Inactive' : status}</span>;
}

export function FormError({ error }: { error: unknown }) {
  if (!error) return null;
  return <div className="alert alert-error" role="alert">{error instanceof Error ? error.message : 'Something went wrong.'}</div>;
}

/** Field-level message for a validation error from the API. */
export function fieldError(error: unknown, path: string): string | undefined {
  return fieldIssues(error).find((d) => d.path === path)?.message;
}

export function Field({ id, label, hint, error, children }: { id: string; label: string; hint?: string; error?: string; children: ReactNode }) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children}
      {error ? <span className="field-error">{error}</span> : hint ? <span className="hint">{hint}</span> : null}
    </div>
  );
}

/** Modal built on the native <dialog> element (focus trap, Esc to close). */
export function Dialog({ open, title, onClose, children, footer, wide }: {
  open: boolean;
  wide?: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) {
      el.showModal();
      // React's autoFocus runs before the dialog is shown, so focus the first field explicitly.
      el.querySelector<HTMLElement>('input:not([disabled]):not([type=hidden]), textarea, select')?.focus();
    }
    if (!open && el.open) el.close();
  }, [open]);
  return (
    <dialog ref={ref} className={wide ? 'wide' : undefined} onClose={onClose} aria-labelledby="dialog-title">
      {open && (
        <>
          <div className="dialog-head"><h2 id="dialog-title">{title}</h2></div>
          <div className="dialog-body">{children}</div>
          <div className="dialog-foot">{footer}</div>
        </>
      )}
    </dialog>
  );
}

export function formatDate(value: string | null) {
  if (!value) return '—';
  return new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

// ---- Sprint 2 ----

export type Tone = 'success' | 'warning' | 'danger' | 'info' | 'muted';

export function Badge({ tone = 'muted', children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`badge tone-${tone}`}>{children}</span>;
}

export function Pager({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (total <= pageSize) return <div className="pager muted">{total} {total === 1 ? 'result' : 'results'}</div>;
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  return (
    <div className="pager">
      <span className="muted">{from}–{to} of {total}</span>
      <div>
        <button className="btn btn-sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>Previous</button>
        <button className="btn btn-sm" disabled={page >= pages} onClick={() => onPage(page + 1)}>Next</button>
      </div>
    </div>
  );
}

export function DetailGrid({ items }: { items: [string, ReactNode][] }) {
  return (
    <dl className="detail-grid">
      {items.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{v ?? '—'}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Tags({ items }: { items: string[] }) {
  if (items.length === 0) return <span className="muted">—</span>;
  return <>{items.map((t) => <span key={t} className="tag">{t}</span>)}</>;
}

export function BackLink({ to, children }: { to: '/requisitions' | '/vacancies' | '/candidates' | '/pipeline' | '/interviews' | '/my-interviews' | '/offers'; children: ReactNode }) {
  return <Link className="back-link" to={to}>← {children}</Link>;
}

/** While email is off, the API returns the invitation link for the inviter to share themselves. */
export function InviteLinkNotice({ link, email }: { link?: string | null; email?: string }) {
  const [copied, setCopied] = useState(false);
  if (!link) return null;
  return (
    <div className="alert alert-success" role="status">
      <p style={{ margin: '0 0 8px' }}>Email is not set up, so send this sign-up link to {email ?? 'them'} yourself (WhatsApp, chat). They open it and choose their own password.</p>
      <div style={{ display: 'flex', gap: 8 }}>
        <input readOnly value={link} aria-label="Invitation link" onFocus={(e) => e.target.select()} style={{ flex: 1, minWidth: 0 }} />
        <button className="btn" type="button" onClick={async () => { await navigator.clipboard?.writeText(link); setCopied(true); }}>{copied ? 'Copied' : 'Copy'}</button>
      </div>
    </div>
  );
}

/** The sourcing ID (every sourced candidate) and, once selected, the temp employee ID. */
export function IdTags({ sourcing, temp }: { sourcing?: string | null; temp?: string | null }) {
  if (!sourcing && !temp) return null;
  return (
    <div className="id-tags">
      {sourcing && <span className="id-tag" title="Sourcing ID">{sourcing}</span>}
      {temp && <span className="id-tag id-tag-temp" title="Temp employee ID">{temp}</span>}
    </div>
  );
}
