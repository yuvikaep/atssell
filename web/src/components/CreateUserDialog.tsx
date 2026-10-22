import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { api } from '../api';
import { departmentsQuery, rolesQuery } from '../queries';
import { generatePassword } from './CreateLoginDialog';
import { Dialog, Field, fieldError, FormError } from './ui';

/** What each role sees after signing in, in plain words. */
const ROLE_HELP: Record<string, string> = {
  company_admin: 'Everything: jobs, candidates, agencies, reports, departments and users.',
  internal_recruiter: 'Sourcing, candidate status and interviews for the jobs assigned to them.',
  interviewer: 'Only their own interviews and feedback forms.',
  agency_admin: "Agency admin: the agency portal with open jobs, all of this agency's submissions, and its team.",
  agency_recruiter: 'Sub-recruiter: the agency portal with open jobs and only their own submissions.',
};
const AGENCY_ROLES = new Set(['agency_admin', 'agency_recruiter']);
const AGENCY_LABEL: Record<string, string> = { agency_admin: 'Agency admin', agency_recruiter: 'Sub-recruiter' };

/**
 * Create a user now, with a role and a first password, then hand them the sign-in details.
 * Team & roles creates company staff; an agency's page passes `agency` to create its members.
 */
export function CreateUserDialog({ onClose, agency }: { onClose: () => void; agency?: { id: string; name: string } }) {
  const queryClient = useQueryClient();
  const roles = useQuery(rolesQuery);
  const departments = useQuery(departmentsQuery('active'));
  const [roleCode, setRoleCode] = useState(agency ? 'agency_recruiter' : '');
  const isAgency = AGENCY_ROLES.has(roleCode);
  const roleOptions = (roles.data ?? []).filter((r) => (agency ? AGENCY_ROLES.has(r.code) : !AGENCY_ROLES.has(r.code)));
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [password, setPassword] = useState(generatePassword);
  const [copied, setCopied] = useState(false);

  const create = useMutation({
    mutationFn: () => api<{ data: { company: string } }>('POST', '/users', {
      full_name: fullName, email, password, role_code: roleCode,
      department_id: !isAgency && departmentId ? departmentId : null, agency_id: agency?.id ?? null,
    }),
    onSuccess: () => Promise.all(['users', 'invitations', 'agency-members', 'agencies'].map((k) => queryClient.invalidateQueries({ queryKey: [k] }))),
  });
  const submit = (e: FormEvent) => { e.preventDefault(); create.mutate(); };
  const err = (k: string) => fieldError(create.error, k);
  const roleName = roles.data?.find((r) => r.code === roleCode)?.name ?? roleCode;

  if (create.data) {
    const details = `Login: ${window.location.origin}/login\nCompany code: ${create.data.data.company}\nEmail: ${email}\nPassword: ${password}\nRole: ${roleName}\n(Change your password after signing in.)`;
    return (
      <Dialog open title="User created" onClose={onClose} footer={<button className="btn btn-primary" type="button" onClick={onClose}>Done</button>}>
        <p>{fullName} can sign in now as <strong>{roleName}</strong>. Send them these details privately.</p>
        <textarea readOnly rows={6} value={details} style={{ width: '100%' }} onFocus={(e) => e.target.select()} />
        <button className="btn" type="button" onClick={async () => { await navigator.clipboard?.writeText(details); setCopied(true); }}>{copied ? 'Copied' : 'Copy details'}</button>
      </Dialog>
    );
  }

  const ready = fullName.trim() && email.trim() && roleCode && password;
  return (
    <Dialog open title={agency ? `Add a member to ${agency.name}` : 'Create user'} onClose={onClose}
      footer={<>
        <button className="btn" type="button" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" type="submit" form="create-user" disabled={!ready || create.isPending}>{create.isPending ? 'Creating…' : 'Create user'}</button>
      </>}>
      <form id="create-user" onSubmit={submit} noValidate>
        <FormError error={create.error && !['full_name', 'email', 'password'].some((k) => err(k)) ? create.error : null} />
        <Field id="cu-name" label="Name" error={err('full_name')}><input id="cu-name" value={fullName} onChange={(e) => setFullName(e.target.value)} autoFocus /></Field>
        <Field id="cu-email" label="Email (they sign in with this)" error={err('email')}><input id="cu-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" /></Field>
        <Field id="cu-role" label="Role" hint={ROLE_HELP[roleCode] ?? 'The role decides what they see after signing in.'}>
          <select id="cu-role" value={roleCode} onChange={(e) => setRoleCode(e.target.value)}>
            <option value="" disabled>Choose a role</option>
            {roleOptions.map((r) => <option key={r.code} value={r.code}>{AGENCY_LABEL[r.code] ?? r.name}</option>)}
          </select>
        </Field>
        {!isAgency && roleCode && roleCode !== 'company_admin' && (
          <Field id="cu-dept" label="Department" hint="Company-wide gives access across all departments.">
            <select id="cu-dept" value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}>
              <option value="">Company-wide</option>
              {(departments.data ?? []).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </Field>
        )}
        <Field id="cu-password" label="First password" hint="At least 12 characters. They can change it after signing in." error={err('password')}>
          <div style={{ display: 'flex', gap: 8 }}>
            <input id="cu-password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off" style={{ flex: 1, minWidth: 0 }} />
            <button className="btn" type="button" onClick={() => setPassword(generatePassword())}>New</button>
          </div>
        </Field>
      </form>
    </Dialog>
  );
}
