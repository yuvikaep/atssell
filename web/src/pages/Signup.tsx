import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { api } from '../api';
import { Field, fieldError, FormError } from '../components/ui';
import { AuthLayout } from './AuthLayout';


export function SignupPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [companyName, setCompanyName] = useState('');
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const signup = useMutation({
    mutationFn: () => api('POST', '/auth/signup', { company_name: companyName, full_name: fullName, email, password }),
    onSuccess: async () => {
      queryClient.clear();
      await navigate({ to: '/' });
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    signup.mutate();
  };

  return (
    <AuthLayout title="Create your company" subtitle="You become its admin and can invite your team.">
      <form onSubmit={submit} noValidate>
        <FormError error={signup.error} />
        <Field id="company_name" error={fieldError(signup.error, 'company_name')} label="Company name">
          <input id="company_name" value={companyName} autoComplete="organization" required
            onChange={(e) => { setCompanyName(e.target.value); }} />
        </Field>
        <Field id="full_name" error={fieldError(signup.error, 'full_name')} label="Your name">
          <input id="full_name" value={fullName} onChange={(e) => setFullName(e.target.value)} autoComplete="name" required />
        </Field>
        <Field id="email" error={fieldError(signup.error, 'email')} label="Work email">
          <input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" required />
        </Field>
        <Field id="password" error={fieldError(signup.error, 'password')} label="Password" hint="At least 12 characters.">
          <input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" required />
        </Field>
        <button className="btn btn-primary btn-block" type="submit"
          disabled={signup.isPending || !companyName || !fullName || !email || !password}>
          {signup.isPending ? 'Creating…' : 'Create company'}
        </button>
      </form>
      <div className="auth-footer">
        Already have an account? <Link to="/login" search={{ redirect: undefined }}>Sign in</Link>
      </div>
    </AuthLayout>
  );
}
