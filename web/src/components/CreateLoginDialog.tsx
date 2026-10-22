import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { api } from '../api';
import { Dialog, Field, fieldError, FormError } from './ui';

/** A readable 14-character first password (no look-alike characters). */
export function generatePassword() {
  const chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(14));
  return Array.from(bytes, (b) => chars[b % chars.length]).join('');
}

/**
 * While email is off: the admin sets a first password for an invited person and shares the sign-in
 * details. The person can change the password after signing in.
 */
export function CreateLoginDialog({ invitation, onClose }: { invitation: { id: string; email: string }; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [fullName, setFullName] = useState('');
  const [password, setPassword] = useState(generatePassword);
  const [copied, setCopied] = useState(false);
  const create = useMutation({
    mutationFn: () => api<{ data: { company: string } }>('POST', `/users/invitations/${invitation.id}/create-login`, { full_name: fullName, password }),
    onSuccess: () => queryClient.invalidateQueries(),
  });
  const submit = (e: FormEvent) => { e.preventDefault(); create.mutate(); };

  if (create.data) {
    const details = `Login: ${window.location.origin}/login\nEmail: ${invitation.email}\nPassword: ${password}\n(Change your password after signing in.)`;
    return (
      <Dialog open title="Login created" onClose={onClose}
        footer={<button className="btn btn-primary" type="button" onClick={onClose}>Done</button>}>
        <p>Send these details to {fullName} privately. They can change the password after signing in.</p>
        <textarea readOnly rows={5} value={details} style={{ width: '100%' }} onFocus={(e) => e.target.select()} />
        <button className="btn" type="button" onClick={async () => { await navigator.clipboard?.writeText(details); setCopied(true); }}>{copied ? 'Copied' : 'Copy details'}</button>
      </Dialog>
    );
  }

  return (
    <Dialog open title={`Create login for ${invitation.email}`} onClose={onClose}
      footer={
        <>
          <button className="btn" type="button" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" type="submit" form="create-login" disabled={create.isPending || !fullName.trim() || !password}>Create login</button>
        </>
      }>
      <form id="create-login" onSubmit={submit} noValidate>
        <FormError error={create.error} />
        <Field id="cl_name" label="Their name" error={fieldError(create.error, 'full_name')}>
          <input id="cl_name" value={fullName} onChange={(e) => setFullName(e.target.value)} required />
        </Field>
        <Field id="cl_password" label="First password" hint="At least 12 characters. Generated for you; you can change it." error={fieldError(create.error, 'password')}>
          <div style={{ display: 'flex', gap: 8 }}>
            <input id="cl_password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off" style={{ flex: 1, minWidth: 0 }} />
            <button className="btn" type="button" onClick={() => setPassword(generatePassword())}>New</button>
          </div>
        </Field>
      </form>
    </Dialog>
  );
}
