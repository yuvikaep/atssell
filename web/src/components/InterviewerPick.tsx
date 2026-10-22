import { useQuery } from '@tanstack/react-query';
import { usersQuery } from '../queries';
import { MultiPick } from './MultiPick';
import { Field } from './ui';

/** Company people who can interview for a job (anyone in the company except agency members). */
export function InterviewerPick({ value, onChange, required }: { value: string[]; onChange: (ids: string[]) => void; required?: boolean }) {
  const users = useQuery(usersQuery('active', ''));
  const options = (users.data?.data ?? []).filter((u) => !u.roles.some((r) => r.code.startsWith('agency'))).map((u) => ({ id: u.id, name: u.full_name }));
  return (
    <Field id="job-interviewers" label={`Interviewers${required ? '' : ' (optional)'}`} hint="Only these people (and admins) can interview candidates for this job.">
      <MultiPick label="Interviewers" value={value} onChange={onChange} options={options} placeholder="Choose interviewers" />
    </Field>
  );
}
