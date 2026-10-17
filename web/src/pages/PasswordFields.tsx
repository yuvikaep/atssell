import { useState } from 'react';
import { Field } from '../components/ui';

const MIN = 12;

export function usePasswordPair() {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const tooShort = password.length > 0 && password.length < MIN;
  const mismatch = confirm.length > 0 && confirm !== password;
  return {
    password, setPassword, confirm, setConfirm, tooShort, mismatch,
    valid: password.length >= MIN && confirm === password,
  };
}

export function PasswordFields(p: ReturnType<typeof usePasswordPair> & { serverError?: string }) {
  return (
    <>
      <Field id="new-password" label="New password" hint={`At least ${MIN} characters.`} error={p.tooShort ? `Use at least ${MIN} characters.` : p.serverError}>
        <input id="new-password" type="password" value={p.password} onChange={(e) => p.setPassword(e.target.value)} autoComplete="new-password" aria-invalid={p.tooShort} />
      </Field>
      <Field id="confirm-password" label="Confirm password" error={p.mismatch ? "Passwords don't match." : undefined}>
        <input id="confirm-password" type="password" value={p.confirm} onChange={(e) => p.setConfirm(e.target.value)} autoComplete="new-password" aria-invalid={p.mismatch} />
      </Field>
    </>
  );
}
