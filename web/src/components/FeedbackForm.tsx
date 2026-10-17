import { useState } from 'react';
import { ApiError, fieldIssues, RECOMMENDATION_LABEL, type Competency, type InterviewMode, type Recommendation } from '../api';
import { FormError } from './ui';

const RATING_WORDS = ['Poor', 'Below expectations', 'Meets expectations', 'Good', 'Excellent'];
const RECOMMENDATIONS: Recommendation[] = ['strong_yes', 'yes', 'hold', 'no', 'strong_no'];

export interface FeedbackValues {
  mode: InterviewMode;
  overall_rating: number;
  recommendation: Recommendation;
  competency_ratings: Record<string, number>;
  notes: string;
}

/** A 1 to 5 rating as large, tappable buttons. */
export function RatingInput({ label, value, onChange, error, id }: { label: string; value: number | null; onChange: (n: number) => void; error?: string; id: string }) {
  return (
    <div className="rating" role="radiogroup" aria-labelledby={`${id}-label`}>
      <div id={`${id}-label`} className="rating-label">{label}</div>
      <div className="rating-buttons">
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n} type="button" role="radio" aria-checked={value === n} aria-label={`${n} of 5, ${RATING_WORDS[n - 1]}`}
            className="rating-btn" data-selected={value === n} onClick={() => onChange(n)}
          >
            {n}
          </button>
        ))}
      </div>
      {value ? <div className="rating-word">{RATING_WORDS[value - 1]}</div> : null}
      {error && <div className="field-error" style={{ color: 'var(--danger)', fontSize: 12 }}>{error}</div>}
    </div>
  );
}

/**
 * The scorecard, in two steps: fill in, then review before sending. The same form serves the public
 * link page and a colleague's logged-in page, so both are held to the same rules.
 */
export function FeedbackForm({ scorecard, modes, defaultMode, submitting, error, onSubmit }: {
  scorecard: Competency[];
  modes: { value: InterviewMode; label: string }[];
  defaultMode: InterviewMode;
  submitting: boolean;
  error: unknown;
  onSubmit: (v: FeedbackValues) => void;
}) {
  const [mode, setMode] = useState<InterviewMode>(defaultMode);
  const [overall, setOverall] = useState<number | null>(null);
  const [recommendation, setRecommendation] = useState<Recommendation | null>(null);
  const [ratings, setRatings] = useState<Record<string, number>>({});
  const [notes, setNotes] = useState('');
  const [reviewing, setReviewing] = useState(false);
  const [showMissing, setShowMissing] = useState(false);

  const missingCompetencies = scorecard.filter((c) => c.required && !ratings[c.code]);
  const complete = overall !== null && recommendation !== null && missingCompetencies.length === 0;
  const issue = (path: string) => fieldIssues(error).find((i) => i.path === path)?.message;
  const serverGeneric = error && !(error instanceof ApiError && Array.isArray(error.details)) ? error : null;

  const toReview = () => {
    if (!complete) { setShowMissing(true); return; }
    setReviewing(true);
    window.scrollTo({ top: 0 });
  };

  if (reviewing && overall !== null && recommendation !== null) {
    return (
      <div className="feedback-review">
        <h2>Check your feedback</h2>
        <p className="muted" style={{ marginTop: 0 }}>You can only send this once. After sending, changes go through the recruiter.</p>
        <FormError error={serverGeneric} />
        <dl className="detail-grid" style={{ marginBottom: 14 }}>
          <div><dt>Interview type</dt><dd>{modes.find((m) => m.value === mode)?.label}</dd></div>
          <div><dt>Overall rating</dt><dd>{overall} of 5 · {RATING_WORDS[overall - 1]}</dd></div>
          <div><dt>Recommendation</dt><dd>{RECOMMENDATION_LABEL[recommendation]}</dd></div>
        </dl>
        {scorecard.length > 0 && (
          <ul className="review-list">
            {scorecard.map((c) => (
              <li key={c.code}><span>{c.label}</span><strong>{ratings[c.code] ? `${ratings[c.code]} of 5` : 'Not rated'}</strong></li>
            ))}
          </ul>
        )}
        {notes && <><h3 style={{ fontSize: 13, margin: '14px 0 4px' }}>Notes</h3><p className="prose">{notes}</p></>}
        <div className="feedback-actions">
          <button className="btn" type="button" onClick={() => setReviewing(false)} disabled={submitting}>Back and edit</button>
          <button className="btn btn-primary" type="button" disabled={submitting}
            onClick={() => onSubmit({ mode, overall_rating: overall, recommendation, competency_ratings: ratings, notes })}>
            {submitting ? 'Sending…' : 'Send feedback'}
          </button>
        </div>
      </div>
    );
  }

  return (
    <form className="feedback-form" onSubmit={(e) => { e.preventDefault(); toReview(); }} noValidate>
      <FormError error={serverGeneric} />
      {showMissing && !complete && (
        <div className="alert alert-error" role="alert">Please complete the highlighted ratings before continuing.</div>
      )}

      <div className="field">
        <label htmlFor="fb-mode">How was the interview held?</label>
        <select id="fb-mode" value={mode} onChange={(e) => setMode(e.target.value as InterviewMode)}>
          {modes.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
        </select>
      </div>

      <RatingInput id="overall" label="Overall rating" value={overall} onChange={setOverall}
        error={(showMissing && overall === null ? 'Choose a rating from 1 to 5.' : undefined) ?? issue('overall_rating')} />

      <fieldset className="recommendation" aria-describedby="rec-error">
        <legend>Recommendation</legend>
        <div className="rec-options">
          {RECOMMENDATIONS.map((r) => (
            <label key={r} className="rec-option" data-selected={recommendation === r}>
              <input type="radio" name="recommendation" value={r} checked={recommendation === r} onChange={() => setRecommendation(r)} />
              {RECOMMENDATION_LABEL[r]}
            </label>
          ))}
        </div>
        <div id="rec-error" className="field-error" style={{ color: 'var(--danger)', fontSize: 12 }}>
          {showMissing && recommendation === null ? 'Choose a recommendation.' : issue('recommendation')}
        </div>
      </fieldset>

      {scorecard.length > 0 && (
        <div className="competencies">
          <h2>Scorecard</h2>
          {scorecard.map((c) => (
            <RatingInput
              key={c.code} id={`comp-${c.code}`} label={`${c.label}${c.required ? '' : ' (optional)'}`} value={ratings[c.code] ?? null}
              onChange={(n) => setRatings((r) => ({ ...r, [c.code]: n }))}
              error={(showMissing && c.required && !ratings[c.code] ? 'Rate this.' : undefined) ?? issue(`competency_ratings.${c.code}`)}
            />
          ))}
        </div>
      )}

      <div className="field">
        <label htmlFor="fb-notes">Notes <span className="muted">(optional, evidence helps)</span></label>
        <textarea id="fb-notes" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={5000} style={{ minHeight: 120 }} />
        <span className="hint">{notes.length} / 5000</span>
      </div>

      <div className="feedback-actions">
        <button className="btn btn-primary btn-block" type="submit">Review feedback</button>
      </div>
    </form>
  );
}
