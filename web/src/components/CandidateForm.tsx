import type { Dispatch, SetStateAction } from 'react';
import type { CandidateProfile } from '../api';
import { Field, fieldError } from './ui';

export interface CandidateForm {
  full_name: string; email: string; phone: string; city: string; current_title: string;
  total_experience_years: string; notice_period_days: string; skills: string; profile_summary: string;
  current_ctc: string; expected_ctc: string;
}

export const emptyCandidateForm: CandidateForm = {
  full_name: '', email: '', phone: '', city: '', current_title: '', total_experience_years: '',
  notice_period_days: '', skills: '', profile_summary: '', current_ctc: '', expected_ctc: '',
};

const s = (v: string | number | null | undefined) => (v == null ? '' : String(v));

export function formFromCandidate(c: CandidateProfile): CandidateForm {
  return {
    full_name: c.full_name, email: s(c.email), phone: s(c.phone), city: s(c.city), current_title: s(c.current_title),
    total_experience_years: s(c.total_experience_years), notice_period_days: s(c.notice_period_days),
    skills: c.skills.join(', '), profile_summary: s(c.profile_summary), current_ctc: s(c.current_ctc), expected_ctc: s(c.expected_ctc),
  };
}

const text = (v: string) => (v.trim() === '' ? null : v.trim());
const num = (v: string) => (v.trim() === '' ? null : Number(v));

/** Builds the API body. Fields the person may not see are left out entirely; the server refuses them. */
export function candidateBody(f: CandidateForm, ctc: boolean, contact = true) {
  return {
    full_name: f.full_name.trim(),
    ...(contact ? { email: text(f.email), phone: text(f.phone) } : {}),
    city: text(f.city),
    current_title: text(f.current_title),
    total_experience_years: num(f.total_experience_years),
    notice_period_days: num(f.notice_period_days),
    skills: f.skills.split(',').map((x) => x.trim()).filter(Boolean),
    profile_summary: text(f.profile_summary),
    ...(ctc ? { current_ctc: num(f.current_ctc), expected_ctc: num(f.expected_ctc) } : {}),
  };
}

export function CandidateFormFields({ form, setForm, error, canSeeCtc, canEditContact = true }: {
  form: CandidateForm; setForm: Dispatch<SetStateAction<CandidateForm>>; error: unknown; canSeeCtc: boolean; canEditContact?: boolean;
}) {
  const set = (k: keyof CandidateForm) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const err = (k: string) => fieldError(error, k);
  return (
    <div className="form-grid">
      <div className="span-2">
        <Field id="c-name" label="Full name" error={err('full_name')}><input id="c-name" value={form.full_name} onChange={set('full_name')} autoFocus maxLength={200} /></Field>
      </div>
      {canEditContact && (
        <>
          <Field id="c-email" label="Email" error={err('email')}><input id="c-email" type="email" value={form.email} onChange={set('email')} autoComplete="off" /></Field>
          <Field id="c-phone" label="Phone" hint="Indian numbers need no country code." error={err('phone')}><input id="c-phone" type="tel" value={form.phone} onChange={set('phone')} autoComplete="off" /></Field>
        </>
      )}
      <Field id="c-title" label="Current title"><input id="c-title" value={form.current_title} onChange={set('current_title')} /></Field>
      <Field id="c-city" label="City"><input id="c-city" value={form.city} onChange={set('city')} /></Field>
      <Field id="c-exp" label="Experience (years)" error={err('total_experience_years')}><input id="c-exp" type="number" min={0} step="0.5" value={form.total_experience_years} onChange={set('total_experience_years')} /></Field>
      <Field id="c-notice" label="Notice period (days)" error={err('notice_period_days')}><input id="c-notice" type="number" min={0} value={form.notice_period_days} onChange={set('notice_period_days')} /></Field>
      {canSeeCtc && (
        <>
          <Field id="c-cctc" label="Current CTC (₹ per year)" error={err('current_ctc')}><input id="c-cctc" type="number" min={0} value={form.current_ctc} onChange={set('current_ctc')} /></Field>
          <Field id="c-ectc" label="Expected CTC (₹ per year)" error={err('expected_ctc')}><input id="c-ectc" type="number" min={0} value={form.expected_ctc} onChange={set('expected_ctc')} /></Field>
        </>
      )}
      <div className="span-2"><Field id="c-skills" label="Skills" hint="Separate with commas."><input id="c-skills" value={form.skills} onChange={set('skills')} /></Field></div>
      <div className="span-2"><Field id="c-summary" label="Summary"><textarea id="c-summary" value={form.profile_summary} onChange={set('profile_summary')} maxLength={5000} /></Field></div>
    </div>
  );
}
