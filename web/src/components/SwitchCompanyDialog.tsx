import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { api, ApiError } from '../api';
import { Dialog, Field, FormError } from './ui';

/** Move to another company that has an account with this email, without signing out. Asks for the password. */
export function SwitchCompanyDialog({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const [password, setPassword] = useState('');
  const [company, setCompany] = useState('');
  const sw = useMutation({
    mutationFn: () => api('POST', '/me/switch-company', { password, ...(company ? { company } : {}) }),
    onSuccess: () => { queryClient.clear(); window.location.assign('/'); },
  });
  const choices = sw.error instanceof ApiError && sw.error.code === 'CHOOSE_COMPANY' ? (sw.error.details as { slug: string; name: string }[]) : null;
  const submit = (e: FormEvent) => { e.preventDefault(); sw.mutate(); };
  return (
    <Dialog open title="Switch company" onClose={onClose}
      footer={<><button className="btn" type="button" onClick={onClose}>Cancel</button><button className="btn btn-primary" type="submit" form="switch-co" disabled={sw.isPending || !password || (!!choices && !company)}>{sw.isPending ? 'Switching…' : 'Switch'}</button></>}>
      <form id="switch-co" onSubmit={submit} noValidate>
        <p className="muted" style={{ marginTop: 0 }}>Go to another company you work with, using the same email. Enter your password for that company.</p>
        <FormError error={choices ? null : sw.error} />
        <Field id="sw-pw" label="Password"><input id="sw-pw" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" autoFocus /></Field>
        {(choices || company) && (
          <Field id="sw-co" label="Company">
            <select id="sw-co" value={company} onChange={(e) => setCompany(e.target.value)}>
              <option value="">Choose the company</option>
              {(choices ?? []).map((c) => <option key={c.slug} value={c.slug}>{c.name}</option>)}
            </select>
          </Field>
        )}
      </form>
    </Dialog>
  );
}
