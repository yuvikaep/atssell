import { useMutation } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { api } from '../api';
import { Field, FormError } from '../components/ui';
import { AuthLayout } from './AuthLayout';

export function ForgotPasswordPage() {
  const [company, setCompany] = useState('');
  const [email, setEmail] = useState('');
  const request = useMutation({ mutationFn: () => api('POST', '/auth/password-reset/request', { company, email }) });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    request.mutate();
  };

  if (request.isSuccess) {
    return (
      <AuthLayout title="Check your email">
        <p>If an account exists for <strong>{email}</strong>, we've sent a link to reset the password. It expires in 60 minutes.</p>
        <div className="auth-footer"><Link to="/login" search={{ redirect: undefined }}>Back to sign in</Link></div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title="Reset your password" subtitle="We'll email you a link to choose a new password.">
      <form onSubmit={submit} noValidate>
        <FormError error={request.error} />
        <Field id="company" label="Company code">
          <input id="company" value={company} onChange={(e) => setCompany(e.target.value)} autoCapitalize="none" required />
        </Field>
        <Field id="email" label="Work email">
          <input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" required />
        </Field>
        <button className="btn btn-primary btn-block" type="submit" disabled={request.isPending || !company || !email}>
          Send reset link
        </button>
      </form>
      <div className="auth-footer"><Link to="/login" search={{ redirect: undefined }}>Back to sign in</Link></div>
    </AuthLayout>
  );
}
