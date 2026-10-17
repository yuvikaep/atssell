import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { api, takeFragmentToken } from '../api';
import { Field, fieldError, FormError, Loading } from '../components/ui';
import { AuthLayout } from './AuthLayout';
import { PasswordFields, usePasswordPair } from './PasswordFields';

interface InvitationInfo {
  email: string;
  company_name: string;
  role_name: string;
  expires_at: string;
}

export function AcceptInvitePage() {
  const [token] = useState(takeFragmentToken);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [fullName, setFullName] = useState('');
  const pw = usePasswordPair();

  // POST, not GET: the token never appears in a URL the server sees.
  const info = useQuery({
    queryKey: ['invitation', token],
    queryFn: () => api<{ data: InvitationInfo }>('POST', '/invitations/lookup', { token }).then((r) => r.data),
    enabled: !!token,
    retry: false,
    staleTime: Infinity,
  });

  const accept = useMutation({
    mutationFn: () => api('POST', '/invitations/accept', { token, full_name: fullName, password: pw.password }),
    onSuccess: async () => {
      queryClient.clear();
      await navigate({ to: '/' });
    },
  });

  if (!token || info.isError) {
    return (
      <AuthLayout title="Invitation not valid">
        <p>This invitation link is invalid, has expired, or was already used. Ask your company admin to send a new one.</p>
        <div className="auth-footer"><Link to="/login" search={{ redirect: undefined }}>Go to sign in</Link></div>
      </AuthLayout>
    );
  }
  if (!info.data) return <AuthLayout title="Checking invitation…"><Loading label="" /></AuthLayout>;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (pw.valid && fullName.trim()) accept.mutate();
  };

  return (
    <AuthLayout
      title={`Join ${info.data.company_name}`}
      subtitle={`You've been invited as ${info.data.role_name}.`}
    >
      <form onSubmit={submit} noValidate>
        <FormError error={accept.error && !fieldError(accept.error, 'password') ? accept.error : null} />
        <Field id="email" label="Email">
          <input id="email" value={info.data.email} disabled autoComplete="username" />
        </Field>
        <Field id="full-name" label="Full name" error={fieldError(accept.error, 'full_name')}>
          <input id="full-name" value={fullName} onChange={(e) => setFullName(e.target.value)} autoComplete="name" />
        </Field>
        <PasswordFields {...pw} serverError={fieldError(accept.error, 'password')} />
        <button className="btn btn-primary btn-block" type="submit" disabled={accept.isPending || !pw.valid || !fullName.trim()}>
          Create account
        </button>
      </form>
    </AuthLayout>
  );
}
