import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { api } from '../api';
import { meQuery } from '../queries';
import { useMe } from '../components/AppShell';
import { Field, fieldError, FormError } from '../components/ui';

/** Account settings for any signed-in person: who they are, and a way to change their own password. */
export function AccountPage() {
  const me = useMe();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [show, setShow] = useState(false);
  const mismatch = again !== '' && again !== next;
  const change = useMutation({
    mutationFn: () => api('POST', '/me/password', { current_password: current, new_password: next }),
    onSuccess: async () => {
      setCurrent(''); setNext(''); setAgain('');
      if (mustChange) {
        await queryClient.invalidateQueries({ queryKey: meQuery.queryKey });
        void navigate({ to: '/' });
      }
    },
  });
  const mustChange = !!me.user.must_change_password;
  const type = show ? 'text' : 'password';

  return (
    <>
      <div className="page-header"><div><h1>Account settings</h1><p>Your sign-in details and password.</p></div></div>
      <div className="account-grid">
        <div className="card section">
          <h2>Your details</h2>
          <dl className="detail-grid">
            <div><dt>Name</dt><dd>{me.user.full_name}</dd></div>
            <div><dt>Email</dt><dd>{me.user.email}</dd></div>
            <div><dt>Company</dt><dd>{me.tenant.name} <span className="muted">({me.tenant.slug})</span></dd></div>
            <div><dt>Role</dt><dd>{me.roles.map((r) => r.name).join(', ') || '—'}</dd></div>
          </dl>
          <p className="cell-sub" style={{ marginTop: 12 }}>To change your name, email or role, ask your company admin.</p>
        </div>

        <form className="card section" onSubmit={(e) => { e.preventDefault(); if (!mismatch) change.mutate(); }} autoComplete="off">
          <h2>Change password</h2>
          {mustChange && <div className="alert alert-error" role="alert">Your admin set this password for you. Choose your own to continue. Enter the password they gave you as the current password.</div>}
          {change.isSuccess && <div className="alert alert-success" role="status">Password changed. Your other devices have been signed out.</div>}
          <FormError error={change.error && !fieldError(change.error, 'current_password') && !fieldError(change.error, 'new_password') ? change.error : null} />
          <Field id="pw-current" label="Current password" error={fieldError(change.error, 'current_password')}>
            <input id="pw-current" type={type} autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
          </Field>
          <Field id="pw-new" label="New password" hint="At least 12 characters. A few random words work well." error={fieldError(change.error, 'new_password')}>
            <input id="pw-new" type={type} autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} required minLength={12} />
          </Field>
          <Field id="pw-again" label="Confirm new password" error={mismatch ? 'The passwords do not match.' : undefined}>
            <input id="pw-again" type={type} autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} required />
          </Field>
          <label className="check show-pw"><input type="checkbox" checked={show} onChange={(e) => setShow(e.target.checked)} /> Show passwords</label>
          <div className="actions-row" style={{ marginTop: 12 }}>
            <button className="btn btn-primary" type="submit" disabled={change.isPending || !current || next.length < 12 || mismatch || !again}>Update password</button>
          </div>
        </form>
      </div>
    </>
  );
}
