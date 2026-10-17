import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { api, takeFragmentToken } from '../api';
import { fieldError, FormError } from '../components/ui';
import { AuthLayout } from './AuthLayout';
import { PasswordFields, usePasswordPair } from './PasswordFields';

export function ResetPasswordPage() {
  const [token] = useState(takeFragmentToken);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const pw = usePasswordPair();

  const confirm = useMutation({
    mutationFn: () => api('POST', '/auth/password-reset/confirm', { token, password: pw.password }),
    onSuccess: async () => {
      queryClient.clear();
      await navigate({ to: '/' });
    },
  });

  if (!token) {
    return (
      <AuthLayout title="Link not valid">
        <p>Open the link from your email again, or request a new one.</p>
        <div className="auth-footer"><Link to="/forgot-password">Request a new link</Link></div>
      </AuthLayout>
    );
  }

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (pw.valid) confirm.mutate();
  };

  return (
    <AuthLayout title="Choose a password" subtitle="This also signs out your other sessions.">
      <form onSubmit={submit} noValidate>
        <FormError error={confirm.error && !fieldError(confirm.error, 'password') ? confirm.error : null} />
        <PasswordFields {...pw} serverError={fieldError(confirm.error, 'password')} />
        <button className="btn btn-primary btn-block" type="submit" disabled={confirm.isPending || !pw.valid}>
          Save password and sign in
        </button>
      </form>
      {confirm.error && (
        <div className="auth-footer"><Link to="/forgot-password">Request a new link</Link></div>
      )}
    </AuthLayout>
  );
}
