import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { api, ApiError, safeRedirect } from '../api';
import { Field, FormError } from '../components/ui';
import { AuthLayout } from './AuthLayout';


export function LoginPage() {
  const { redirect } = useSearch({ from: '/login' });
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  // Asked only when the same email and password belong to more than one company.
  const [company, setCompany] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const login = useMutation({
    mutationFn: () => api('POST', '/auth/login', { email, password, ...(company ? { company } : {}) }),
    onSuccess: async () => {
      queryClient.clear();
      await navigate({ to: safeRedirect(redirect) });
    },
  });

  const choices = login.error instanceof ApiError && login.error.code === 'CHOOSE_COMPANY' ? (login.error.details as { slug: string; name: string }[]) : null;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    login.mutate();
  };

  return (
    <AuthLayout title="Sign in" subtitle="Use the email and password you were given.">
      <form onSubmit={submit} noValidate>
        <FormError error={choices ? null : login.error} />
        <Field id="email" label="Work email">
          <input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" required />
        </Field>
        <Field id="password" label="Password">
          <input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
        </Field>
        {(choices || company) && (
          <Field id="company" label="Company" hint="Your email is used in more than one company.">
            <select id="company" value={company} onChange={(e) => setCompany(e.target.value)} required>
              <option value="">Choose the company</option>
              {(choices ?? []).map((c) => <option key={c.slug} value={c.slug}>{c.name}</option>)}
            </select>
          </Field>
        )}
        <button className="btn btn-primary btn-block" type="submit" disabled={login.isPending || !email || !password || (!!choices && !company)}>
          {login.isPending ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
      <div className="auth-footer">
        <Link to="/forgot-password">Forgot password?</Link>
        {' · '}
        <Link to="/signup">Create a new company</Link>
      </div>
    </AuthLayout>
  );
}
