import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { api, COMMON_TIMEZONES, isoToZoned, MODE_LABEL, zonedToIso, type DirectoryUser, type InterviewDetail, type InterviewMode } from '../api';
import { panelOptionsQuery, plansQuery } from '../queries';
import { Dialog, Field, fieldError, FormError } from './ui';

export interface PanelDraft {
  key: string;
  label: string;
  user_id?: string;
  name?: string;
  email?: string;
}

const browserZone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return 'UTC'; } };
const defaultStart = (tz: string) => {
  const t = isoToZoned(new Date(Date.now() + 86_400_000).toISOString(), tz);
  return `${t.slice(0, 11)}${t.slice(11, 13)}:00`;
};
const addHour = (local: string, tz: string, hours: number) => isoToZoned(new Date(new Date(zonedToIso(local, tz)).getTime() + hours * 3_600_000).toISOString(), tz);

/** Panel chips plus the controls to add a colleague or an external interviewer. */
export function PanelPicker({ panel, onChange, exclude = [], applicationId }: { panel: PanelDraft[]; onChange: (p: PanelDraft[]) => void; exclude?: string[]; applicationId: string }) {
  // Only the job's interviewers and the company admins can be put on the panel.
  const directory = useQuery(panelOptionsQuery(applicationId));
  const [colleague, setColleague] = useState('');
  const [ext, setExt] = useState({ name: '', email: '' });
  const taken = new Set([...panel.map((p) => p.user_id).filter(Boolean), ...exclude]);
  const options = (directory.data ?? []).filter((u) => !taken.has(u.id));
  const noInterviewers = !!directory.data && !directory.data.some((u) => u.kind === 'interviewer');

  return (
    <div>
      {panel.length > 0 && (
        <ul className="chips" style={{ listStyle: 'none', padding: 0, margin: '0 0 8px' }}>
          {panel.map((m) => (
            <li className="chip" key={m.key}>{m.label}<button type="button" aria-label={`Remove ${m.label}`} onClick={() => onChange(panel.filter((x) => x.key !== m.key))}>×</button></li>
          ))}
        </ul>
      )}
      <div className="form-grid">
        <Field id="panel-colleague" label="Add a colleague">
          <select id="panel-colleague" value={colleague} onChange={(e) => {
            const u = options.find((o) => o.id === e.target.value);
            if (u) { onChange([...panel, { key: `u:${u.id}`, label: u.full_name, user_id: u.id }]); setColleague(''); }
          }}>
            <option value="">{directory.isPending ? 'Loading…' : 'Choose a colleague'}</option>
            {options.map((u) => <option key={u.id} value={u.id}>{u.full_name}{u.kind === 'admin' ? ' (admin)' : ''}</option>)}
          </select>
          {noInterviewers && <span className="hint">No interviewers are assigned to this job yet. The admin adds them on the job page (Overview &amp; assignments).</span>}
        </Field>
        <div>
          <label className="muted" style={{ fontSize: 13, fontWeight: 550 }}>Or an external interviewer</label>
          <div style={{ display: 'grid', gap: 6, marginTop: 6 }}>
            <input aria-label="External interviewer name" placeholder="Name" value={ext.name} onChange={(e) => setExt({ ...ext, name: e.target.value })} />
            <input aria-label="External interviewer email" type="email" placeholder="Email" value={ext.email} onChange={(e) => setExt({ ...ext, email: e.target.value })} />
            <button className="btn btn-sm" type="button" disabled={!ext.name.trim() || !ext.email.trim()}
              onClick={() => { onChange([...panel, { key: `e:${ext.email.toLowerCase()}`, label: `${ext.name.trim()} (external)`, name: ext.name.trim(), email: ext.email.trim() }]); setExt({ name: '', email: '' }); }}>
              Add external interviewer
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Schedule a new interview (pass `applicationId`) or change an existing one (pass `interview`).
 * Times are typed as wall-clock time in the interview's own time zone, then sent as exact instants.
 */
export function ScheduleDialog({ applicationId, vacancyId, interview, onClose }: {
  applicationId?: string;
  vacancyId?: string;
  interview?: InterviewDetail;
  onClose: (saved?: { id: string }) => void;
}) {
  const queryClient = useQueryClient();
  const editing = !!interview;
  const plans = useQuery({ ...plansQuery(vacancyId ?? ''), enabled: !!vacancyId && !editing });
  const activePlans = (plans.data ?? []).filter((p) => p.is_active);

  const tz0 = interview?.timezone ?? 'Asia/Kolkata';
  const [tz, setTz] = useState(tz0);
  const [planId, setPlanId] = useState('');
  const [round, setRound] = useState(interview?.round_name ?? '');
  const [mode, setMode] = useState<InterviewMode>(interview?.mode ?? 'google_meet');
  const [start, setStart] = useState(interview?.scheduled_start ? isoToZoned(interview.scheduled_start, tz0) : defaultStart(tz0));
  const [end, setEnd] = useState(interview?.scheduled_end ? isoToZoned(interview.scheduled_end, tz0) : addHour(defaultStart(tz0), tz0, 1));
  const [url, setUrl] = useState(interview?.meeting_url ?? '');
  const [where, setWhere] = useState(interview?.location_instructions ?? '');
  const [reason, setReason] = useState('');
  const [panel, setPanel] = useState<PanelDraft[]>([]);
  const [unscheduled, setUnscheduled] = useState(false);

  const originalStart = interview?.scheduled_start ? zonedToIso(isoToZoned(interview.scheduled_start, tz0), tz0) : null;
  const timeChanged = editing && !!interview?.scheduled_start && (zonedToIso(start, tz) !== originalStart || zonedToIso(end, tz) !== (interview.scheduled_end ? new Date(interview.scheduled_end).toISOString() : null));
  const needsReason = editing && interview!.status !== 'draft' && timeChanged;

  const changeStart = (v: string) => {
    // Keep the interview's length when the start moves.
    const minutes = (new Date(zonedToIso(end, tz)).getTime() - new Date(zonedToIso(start, tz)).getTime()) / 60_000;
    setStart(v);
    if (v && minutes > 0) setEnd(isoToZoned(new Date(new Date(zonedToIso(v, tz)).getTime() + minutes * 60_000).toISOString(), tz));
  };
  const changeZone = (next: string) => {
    // The wall-clock time the person typed stays; only the zone it is read in changes.
    setTz(next);
  };

  const save = useMutation({
    mutationFn: () => {
      const times = unscheduled ? { scheduled_start: null, scheduled_end: null } : { scheduled_start: zonedToIso(start, tz), scheduled_end: zonedToIso(end, tz) };
      if (editing) {
        return api<{ data: InterviewDetail }>('PATCH', `/interviews/${interview!.id}`, {
          round_name: round, mode, timezone: tz, meeting_url: url.trim() || null, location_instructions: where.trim() || null,
          ...(unscheduled ? {} : times), ...(needsReason ? { reason } : {}),
        });
      }
      return api<{ data: InterviewDetail }>('POST', `/applications/${applicationId}/interviews`, {
        ...(planId ? { interview_plan_id: planId, round_name: round || undefined } : { round_name: round }),
        mode, timezone: tz, ...times, meeting_url: url.trim() || null, location_instructions: where.trim() || null,
        panel: panel.map(({ user_id, name, email }) => (user_id ? { user_id } : { name, email })),
      });
    },
    onSuccess: async (res) => {
      await Promise.all(['interviews', 'interview', 'candidate', 'my-interviews'].map((k) => queryClient.invalidateQueries({ queryKey: [k] })));
      onClose(res.data);
    },
  });

  const submit = (e: FormEvent) => { e.preventDefault(); save.mutate(); };
  const generic = save.error && !(save.error as { details?: unknown }).details ? save.error : null;
  const canSave = !!round.trim() && (unscheduled || (!!start && !!end)) && (!needsReason || !!reason.trim());

  return (
    <Dialog
      open wide title={editing ? `Change ${interview!.round_name}` : 'Schedule an interview'} onClose={() => onClose()}
      footer={
        <>
          <button className="btn" type="button" onClick={() => onClose()}>Cancel</button>
          <button className="btn btn-primary" type="submit" form="schedule-form" disabled={save.isPending || !canSave}>{editing ? 'Save changes' : 'Schedule interview'}</button>
        </>
      }
    >
      <form id="schedule-form" onSubmit={submit} noValidate>
        <FormError error={generic} />
        <div className="form-grid">
          {!editing && activePlans.length > 0 && (
            <div className="span-2">
              <Field id="sch-plan" label="Round from this vacancy's plan" hint="The scorecard comes with the round. Leave empty for a custom round.">
                <select id="sch-plan" value={planId} onChange={(e) => { setPlanId(e.target.value); const pl = activePlans.find((p) => p.id === e.target.value); if (pl) setRound(pl.name); }}>
                  <option value="">Custom round</option>
                  {activePlans.map((p) => <option key={p.id} value={p.id}>{p.round_order}. {p.name}</option>)}
                </select>
              </Field>
            </div>
          )}
          <Field id="sch-round" label="Round name" error={fieldError(save.error, 'round_name')}>
            <input id="sch-round" value={round} onChange={(e) => setRound(e.target.value)} maxLength={120} autoFocus={editing || activePlans.length === 0} />
          </Field>
          <Field id="sch-mode" label="Interview type">
            <select id="sch-mode" value={mode} onChange={(e) => setMode(e.target.value as InterviewMode)}>
              {Object.entries(MODE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </Field>
          <Field id="sch-tz" label="Time zone" hint="Times below are in this zone.">
            <select id="sch-tz" value={tz} onChange={(e) => changeZone(e.target.value)}>
              {[...new Set([tz, browserZone(), ...COMMON_TIMEZONES])].map((z) => <option key={z} value={z}>{z}</option>)}
            </select>
          </Field>
          <div>
            <label className="check" style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, marginTop: 28 }}>
              <input type="checkbox" checked={unscheduled} onChange={(e) => setUnscheduled(e.target.checked)} style={{ width: 'auto', height: 'auto' }} disabled={editing && interview!.status !== 'draft'} />
              Save as a draft, time to be decided
            </label>
          </div>
          {!unscheduled && (
            <>
              <Field id="sch-start" label="Starts" error={fieldError(save.error, 'scheduled_start')}><input id="sch-start" type="datetime-local" value={start} onChange={(e) => changeStart(e.target.value)} /></Field>
              <Field id="sch-end" label="Ends" error={fieldError(save.error, 'scheduled_end')}><input id="sch-end" type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} /></Field>
            </>
          )}
          <Field id="sch-url" label="Meeting link" hint="Optional." error={fieldError(save.error, 'meeting_url')}><input id="sch-url" type="url" placeholder="https://" value={url} onChange={(e) => setUrl(e.target.value)} /></Field>
          <Field id="sch-where" label="Location or instructions" hint="Optional."><input id="sch-where" value={where} onChange={(e) => setWhere(e.target.value)} maxLength={1000} /></Field>
          {needsReason && (
            <div className="span-2">
              <Field id="sch-reason" label="Reason for rescheduling" error={fieldError(save.error, 'reason')}>
                <textarea id="sch-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} style={{ minHeight: 60 }} />
              </Field>
            </div>
          )}
        </div>
        {!editing && (
          <>
            <h2 style={{ fontSize: 14, margin: '8px 0 10px' }}>Panel</h2>
            <PanelPicker panel={panel} onChange={setPanel} applicationId={applicationId!} />
            {fieldError(save.error, 'panel') && <span className="field-error" style={{ color: 'var(--danger)' }}>{fieldError(save.error, 'panel')}</span>}
          </>
        )}
      </form>
    </Dialog>
  );
}
