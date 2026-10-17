import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { api, formatInZone, MODE_LABEL, RECOMMENDATION_LABEL, type Me, type Recommendation } from '../api';
import { NextRoundDialog } from '../components/NextRoundDialog';
import { ScheduleDialog } from '../components/ScheduleDialog';
import { ErrorState, fieldError, Loading } from '../components/ui';
import { hiringHomeQuery, type HiringHome } from '../queries';

const greeting = () => {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
};
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** A calm, plain-language home for people who hire but do not run the process. */
export function HiringHomePage({ me, mode = 'manager' }: { me: Me; mode?: 'manager' | 'recruiter' }) {
  const recruiter = mode === 'recruiter';
  const q = useQuery(hiringHomeQuery);
  if (q.isPending) return <Loading />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const d = q.data;
  const waiting = d.waiting_for_decision.filter((w) => w.can_decide || !recruiter);
  const todo = d.feedback_owed.length + d.approvals.length + waiting.length;
  const inProgress = d.vacancies.reduce((n, v) => n + Object.values(v.funnel).reduce((a, b) => a + b, 0), 0);
  const first = me.user.full_name.split(' ')[0];

  return (
    <div className="hm">
      <div className="hm-hero">
        <div>
          <h1>{greeting()}, {first}</h1>
          <p>{todo === 0 ? 'You are all caught up. Nothing needs you right now.' : `${plural(todo, 'thing')} ${todo === 1 ? 'needs' : 'need'} you today.`}</p>
        </div>
        <div className="hm-tiles" aria-label="Summary">
          <Tile n={todo} label="Need you" tone={todo > 0 ? 'attn' : 'ok'} />
          {recruiter
            ? <Tile n={inProgress} label="Candidates in progress" />
            : <Tile n={d.vacancies.length} label={d.vacancies.length === 1 ? 'Open role' : 'Open roles'} />}
          <Tile n={d.upcoming_interviews.length} label="Interviews this week" />
        </div>
      </div>

      {todo > 0 && (
        <section className="hm-section" aria-labelledby="hm-attn">
          <h2 id="hm-attn">Needs your attention</h2>
          <div className="hm-stack">
            {waiting.map((w) => <DecisionCard key={w.id} w={w} />)}
            {d.feedback_owed.map((f) => (
              <div key={f.interview_id} className="hm-row">
                <span className="hm-icon" aria-hidden>✎</span>
                <div className="hm-main">
                  <strong>Share your feedback on {f.candidate_name}</strong>
                  <span className="hm-sub">{f.round_name}{f.overdue ? ' · overdue' : ''}</span>
                </div>
                <Link className="btn btn-primary" to="/my-interviews/$id" params={{ id: f.interview_id }}>Give feedback</Link>
              </div>
            ))}
            {d.approvals.map((a) => (
              <div key={a.id} className="hm-row">
                <span className="hm-icon" aria-hidden>✓</span>
                <div className="hm-main"><strong>Approve a hiring request: {a.title}</strong><span className="hm-sub">{plural(a.headcount, 'position')}</span></div>
                <Link className="btn btn-primary" to="/requisitions/$id" params={{ id: a.id }}>Review</Link>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="hm-section" aria-labelledby="hm-roles">
        <div className="hm-head"><h2 id="hm-roles">{recruiter ? 'Jobs assigned to you' : 'Your open roles'}</h2>{recruiter && <Link to="/candidates" className="btn btn-primary btn-sm">Add a candidate</Link>}</div>
        {d.vacancies.length === 0 ? <div className="hm-empty">{recruiter ? 'No jobs are assigned to you yet. When your admin assigns one, it shows up here.' : 'No open roles yet. HR opens roles for your team and they will appear here.'}</div> : (
          <div className="hm-roles">{d.vacancies.map((v) => <RoleCard key={v.id} v={v} recruiter={recruiter} />)}</div>
        )}
      </section>

      <section className="hm-section" aria-labelledby="hm-week">
        <h2 id="hm-week">Interviews this week</h2>
        {d.upcoming_interviews.length === 0 ? <div className="hm-empty">No interviews scheduled for the next 7 days.</div> : (
          <div className="hm-stack">
            {d.upcoming_interviews.map((i) => (
              <div key={i.id} className="hm-row">
                <div className="hm-date" aria-hidden>
                  <span>{new Date(i.scheduled_start).toLocaleDateString(undefined, { weekday: 'short' })}</span>
                  <strong>{new Date(i.scheduled_start).getDate()}</strong>
                </div>
                <div className="hm-main">
                  <strong>{i.candidate_name}</strong>
                  <span className="hm-sub">{i.vacancy_title} · {i.round_name} · {formatInZone(i.scheduled_start, i.timezone, { timeOnly: true })} · {MODE_LABEL[i.mode as keyof typeof MODE_LABEL] ?? i.mode}</span>
                </div>
                {i.is_mine && <span className="hm-chip">You are interviewing</span>}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function Tile({ n, label, tone }: { n: number; label: string; tone?: 'attn' | 'ok' }) {
  return <div className={`hm-tile ${tone ? `hm-tile-${tone}` : ''}`}><strong>{n}</strong><span>{label}</span></div>;
}

function DecisionCard({ w }: { w: HiringHome['waiting_for_decision'][number] }) {
  const queryClient = useQueryClient();
  const [asking, setAsking] = useState<null | 'hold' | 'reject'>(null);
  const [scheduling, setScheduling] = useState(false);
  const [nextRound, setNextRound] = useState(false);
  const [reason, setReason] = useState('');
  const decide = useMutation({
    mutationFn: (decision: string) => api('POST', `/applications/${w.id}/decisions`, { decision, ...(reason.trim() ? { reason: reason.trim() } : {}) }),
    onSuccess: () => Promise.all(['hiring-home', 'applications', 'pipeline', 'decisions'].map((k) => queryClient.invalidateQueries({ queryKey: [k] }))),
  });
  const tally = w.recommendations.reduce<Record<string, number>>((m, r) => ({ ...m, [r]: (m[r] ?? 0) + 1 }), {});
  return (
    <div className="hm-row hm-decision">
      <span className="hm-avatar" aria-hidden>{w.candidate_name.split(' ').map((p) => p[0]).slice(0, 2).join('')}</span>
      <div className="hm-main">
        <strong>{w.candidate_name} is ready for your decision</strong>
        <span className="hm-sub">For {w.vacancy_title}{w.current_title && w.current_title !== w.vacancy_title ? ` · currently ${w.current_title}` : ''}</span>
        <span className="hm-feedback">
          {w.avg_rating !== null && <span className="hm-score">{w.avg_rating.toFixed(1)}<small>/5</small></span>}
          {Object.entries(tally).map(([r, n]) => <span key={r} className={`hm-chip hm-rec-${r}`}>{n > 1 ? `${n}× ` : ''}{RECOMMENDATION_LABEL[r as Recommendation] ?? r}</span>)}
          <span className="hm-sub">from {plural(w.feedback_count, 'interviewer')}</span>
        </span>
        {asking && (
          <span className="hm-why">
            <input aria-label="Reason" autoFocus placeholder={asking === 'hold' ? 'Why are you holding? (short note)' : 'Why are you passing? (short note)'} value={reason} onChange={(e) => setReason(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && reason.trim() && decide.mutate(asking)} />
            <button className="btn btn-primary btn-sm" disabled={decide.isPending || !reason.trim()} onClick={() => decide.mutate(asking)}>Confirm</button>
            <button className="btn btn-sm" onClick={() => { setAsking(null); setReason(''); }}>Cancel</button>
          </span>
        )}
        {decide.error && <span className="field-error">{fieldError(decide.error, 'reason') ?? (decide.error as Error).message}</span>}
        {w.can_decide && !asking && <button className="btn btn-link btn-sm" style={{ justifySelf: 'start', padding: 0 }} onClick={() => setScheduling(true)}>Request another interview</button>}
        {nextRound && <NextRoundDialog applicationId={w.id} candidateName={w.candidate_name} onClose={() => setNextRound(false)} />}
        {scheduling && <ScheduleDialog applicationId={w.id} vacancyId={w.vacancy_id} onClose={() => { setScheduling(false); queryClient.invalidateQueries({ queryKey: ['hiring-home'] }); }} />}
      </div>
      {!asking && (
        <div className="hm-actions">
          {w.can_decide ? (
            <>
              <button className="btn btn-primary" disabled={decide.isPending} onClick={() => decide.mutate('select')}>Select</button>
              <button className="btn" onClick={() => setNextRound(true)}>Next round</button>
              <button className="btn" onClick={() => setAsking('hold')}>Hold</button>
              <button className="btn btn-danger" onClick={() => setAsking('reject')}>Pass</button>
            </>
          ) : <Link className="btn" to="/vacancies/$id" params={{ id: w.vacancy_id }}>View</Link>}
        </div>
      )}
    </div>
  );
}

function RoleCard({ v, recruiter }: { v: HiringHome['vacancies'][number]; recruiter: boolean }) {
  const steps: { key: keyof typeof v.funnel; label: string }[] = [
    { key: 'new', label: 'New' }, { key: 'screening', label: 'Screening' }, { key: 'shortlisted', label: 'Shortlisted' }, { key: 'interview', label: 'Interview' }, { key: 'offer', label: 'Offer' },
  ];
  const total = Object.values(v.funnel).reduce((a, b) => a + b, 0);
  const pct = Math.min(100, Math.round((v.hired / Math.max(1, v.headcount)) * 100));
  return (
    <article className="hm-role">
      <header>
        <div>
          <Link to="/vacancies/$id" params={{ id: v.id }} className="hm-role-title">{v.title}</Link>
          <div className="hm-sub">{v.department} · {v.location} · open {v.days_open === 0 ? 'today' : `${v.days_open} days`}{v.status === 'on_hold' ? ' · on hold' : ''}</div>
        </div>
        <div className="hm-fill" title={`${v.hired} of ${v.headcount} hired`}>
          <span className="hm-fill-text">{v.hired} of {v.headcount} filled</span>
          <span className="hm-fill-bar"><span style={{ width: `${pct}%` }} /></span>
        </div>
      </header>
      <ol className="hm-funnel" aria-label={`${total} candidates in progress`}>
        {steps.map((s) => (
          <li key={s.key} data-empty={v.funnel[s.key] === 0}>
            <strong>{v.funnel[s.key]}</strong><span>{s.label}</span>
          </li>
        ))}
      </ol>
      <footer><Link className="btn btn-sm" to="/vacancies/$id" params={{ id: v.id }}>{recruiter ? 'Source candidates' : 'See candidates'}</Link></footer>
    </article>
  );
}
