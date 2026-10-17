import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api, ApiError, formatInZone, takeFragmentToken, type FeedbackBootstrap } from '../api';
import { FeedbackForm, type FeedbackValues } from '../components/FeedbackForm';

// The public page for interviewers who have no account. It shows no company navigation, loads no
// third-party scripts, and keeps the link's token only in memory: the address bar is cleared as soon as
// the page reads it, so it does not end up in browser history or screenshots.

type Problem = { title: string; text: string };

function describe(err: unknown): Problem {
  if (err instanceof ApiError) {
    if (err.status === 409) return { title: 'Feedback already sent', text: 'Feedback has already been submitted through this link. Thank you. If something needs changing, please tell the recruiter.' };
    if (err.status === 410) return { title: 'This link is no longer active', text: 'It has expired or was withdrawn. Please ask the recruiter to send you a new one.' };
    if (err.status === 401 || err.status === 400) return { title: 'This link is not valid', text: 'Please open the link from your email again. If it still does not work, ask the recruiter for a new one.' };
    if (err.status === 429) return { title: 'Too many attempts', text: 'Please wait a minute and try again.' };
  }
  return { title: 'Something went wrong', text: 'We could not load this page. Check your connection and try again.' };
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="public-page">
      <header className="public-header"><span className="brand-mark">J</span> Interview feedback</header>
      <main className="public-card">{children}</main>
      <footer className="public-footer">This page is private to you. Please do not share the link.</footer>
    </div>
  );
}

export function FeedbackPublicPage() {
  const [token] = useState(takeFragmentToken);
  const [sent, setSent] = useState(false);

  const info = useQuery({
    queryKey: ['public-feedback'],
    queryFn: () => api<{ data: FeedbackBootstrap }>('POST', '/public/feedback/validate', { token }).then((r) => r.data),
    enabled: !!token,
    retry: false,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });

  const submit = useMutation({
    mutationFn: (v: FeedbackValues) => api('POST', '/public/feedback/submit', { token, ...v, notes: v.notes }),
    onSuccess: () => setSent(true),
  });
  const resume = useMutation({
    mutationFn: () => api<{ data: { url: string } }>('POST', '/public/feedback/resume-url', { token }),
    onSuccess: (r) => window.location.assign(r.data.url),
  });

  if (!token) return <Shell><Problem p={{ title: 'This link is not valid', text: 'Please open the link from your email again.' }} /></Shell>;
  if (sent) {
    return (
      <Shell>
        <div className="state" role="status">
          <h2>Thank you</h2>
          <p>Your feedback has been sent. You can close this page.</p>
        </div>
      </Shell>
    );
  }
  if (info.isPending) return <Shell><div className="state" role="status"><div className="spinner" />Opening…</div></Shell>;
  if (info.isError) return <Shell><Problem p={describe(info.error)} /></Shell>;
  // Submitting can still fail because the link was just used or withdrawn; show that, not the form.
  if (submit.error instanceof ApiError && [401, 409, 410, 429].includes(submit.error.status)) return <Shell><Problem p={describe(submit.error)} /></Shell>;

  const d = info.data;
  return (
    <Shell>
      <section aria-label="About this interview">
        <h1>{d.candidate.full_name}</h1>
        <p className="muted" style={{ margin: '2px 0 12px' }}>
          {[d.candidate.current_title, d.candidate.total_experience_years != null ? `${d.candidate.total_experience_years} years` : null, d.candidate.city].filter(Boolean).join(' · ')}
        </p>
        <dl className="detail-grid">
          <div><dt>Role</dt><dd>{d.job.title}</dd></div>
          <div><dt>Round</dt><dd>{d.interview.round_name}</dd></div>
          <div><dt>When</dt><dd>{formatInZone(d.interview.scheduled_start, d.interview.timezone)}</dd></div>
          <div><dt>Type</dt><dd>{d.interview.mode_label}</dd></div>
        </dl>
        {d.candidate.skills.length > 0 && <p style={{ marginBottom: 6 }}>{d.candidate.skills.map((t) => <span key={t} className="tag">{t}</span>)}</p>}
        {d.candidate.summary && <p className="prose" style={{ fontSize: 13 }}>{d.candidate.summary}</p>}
        <details className="job-details">
          <summary>Job description</summary>
          <p className="prose" style={{ fontSize: 13 }}>{d.job.description}</p>
        </details>
        <div style={{ margin: '12px 0 4px' }}>
          <button className="btn btn-sm" type="button" onClick={() => resume.mutate()} disabled={resume.isPending}>Open resume</button>
          {resume.isError && <span className="muted" style={{ marginLeft: 8, fontSize: 12 }}>{resume.error instanceof ApiError && resume.error.status === 404 ? 'No resume on file.' : 'Could not open the resume.'}</span>}
        </div>
      </section>
      <hr className="public-rule" />
      <FeedbackForm
        scorecard={d.scorecard} modes={d.modes} defaultMode={d.interview.mode}
        submitting={submit.isPending} error={submit.error} onSubmit={(v) => submit.mutate(v)}
      />
    </Shell>
  );
}

function Problem({ p }: { p: Problem }) {
  return (
    <div className="state" role="alert">
      <h2>{p.title}</h2>
      <p>{p.text}</p>
    </div>
  );
}
