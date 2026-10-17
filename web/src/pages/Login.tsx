import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { api, safeRedirect } from '../api';
import { Field, FormError } from '../components/ui';
import { AuthLayout } from './AuthLayout';

const COMPANY_KEY = 'jm.lastCompany';

function rememberedCompany() {
  try {
    return localStorage.getItem(COMPANY_KEY) ?? '';
  } catch {
    return '';
  }
}

export function LoginPage() {
  const { redirect } = useSearch({ from: '/login' });
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [company, setCompany] = useState(rememberedCompany);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const login = useMutation({
    mutationFn: () => api('POST', '/auth/login', { company, email, password }),
    onSuccess: async () => {
      try {
        localStorage.setItem(COMPANY_KEY, company.trim().toLowerCase());
      } catch {
        // Convenience only.
      }
      queryClient.clear();
      await navigate({ to: safeRedirect(redirect) });
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    login.mutate();
  };

  return (
    <AuthLayout title="Sign in" subtitle="Use the company code your admin gave you.">
      <form onSubmit={submit} noValidate>
        <FormError error={login.error} />
        <Field id="company" label="Company code">
          <input id="company" value={company} onChange={(e) => setCompany(e.target.value)} autoComplete="organization" autoCapitalize="none" required />
        </Field>
        <Field id="email" label="Work email">
          <input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" required />
        </Field>
        <Field id="password" label="Password">
          <input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
        </Field>
        <button className="btn btn-primary btn-block" type="submit" disabled={login.isPending || !company || !email || !password}>
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
