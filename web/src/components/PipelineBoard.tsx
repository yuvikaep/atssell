import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useDeferredValue, useState } from 'react';
import { api, SOURCE_LABEL, type ApplicationCard, type CandidateRow, type Paged, type Stage } from '../api';
import { applicationsQuery, candidatesQuery, stagesQuery } from '../queries';
import { useSessionState } from '../session-storage';
import { ScheduleDialog } from './ScheduleDialog';
import { NewOfferDialog } from './NewOfferDialog';
import { Badge, Dialog, EmptyState, ErrorState, Field, fieldError, FormError, Loading, formatDate } from './ui';

const VIEWS = ['board', 'table'] as const;

function useInvalidatePipeline(vacancyId: string) {
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['applications'] }),
      queryClient.invalidateQueries({ queryKey: ['vacancy', vacancyId] }),
      queryClient.invalidateQueries({ queryKey: ['vacancies'] }),
      queryClient.invalidateQueries({ queryKey: ['candidate'] }),
    ]);
}

/** Kanban and table views of one vacancy's candidates. Moves are limited to the pipeline's allowed transitions. */
export function PipelineBoard({ vacancyId, canMove, canAdd, canSchedule = false, canOffer = false }: { vacancyId: string; canMove: boolean; canAdd: boolean; canSchedule?: boolean; canOffer?: boolean }) {
  const [view, setView] = useSessionState('jm.pipeline.view', 'board', VIEWS);
  const [includeClosed, setIncludeClosed] = useState(false);
  const [adding, setAdding] = useState(false);
  const [scheduling, setScheduling] = useState<ApplicationCard | null>(null);
  const [offering, setOffering] = useState<ApplicationCard | null>(null);
  const [pendingMove, setPendingMove] = useState<{ app: ApplicationCard; stage: Stage } | null>(null);
  const stages = useQuery(stagesQuery);
  const apps = useQuery(applicationsQuery({ vacancy_id: vacancyId, status: includeClosed ? 'all' : 'active' }));
  const invalidate = useInvalidatePipeline(vacancyId);
  const [moveError, setMoveError] = useState<string | null>(null);

  const move = useMutation({
    mutationFn: ({ id, stageId, reason }: { id: string; stageId: string; reason?: string }) =>
      api('PATCH', `/applications/${id}/stage`, { stage_id: stageId, reason }),
    onSuccess: async () => { setMoveError(null); setPendingMove(null); await invalidate(); },
    onError: (err) => { if (!pendingMove) setMoveError(err instanceof Error ? err.message : 'Could not move the candidate.'); },
  });

  if (stages.isPending || apps.isPending) return <Loading />;
  if (stages.isError) return <ErrorState error={stages.error} onRetry={() => stages.refetch()} />;
  if (apps.isError) return <ErrorState error={apps.error} onRetry={() => apps.refetch()} />;

  const stageList = stages.data.filter((s) => includeClosed || s.terminal_status === null);
  const stageById = new Map(stages.data.map((s) => [s.id, s]));
  const cards = apps.data.data;

  const requestMove = (app: ApplicationCard, stageId: string) => {
    const from = stageById.get(app.stage_id);
    const to = stageById.get(stageId);
    if (!from || !to) return;
    if (from.next.find((n) => n.stage_id === stageId)?.requires_reason) setPendingMove({ app, stage: to });
    else move.mutate({ id: app.id, stageId });
  };

  const MoveSelect = ({ app }: { app: ApplicationCard }) => {
    const options = (stageById.get(app.stage_id)?.next ?? []).map((n) => stageById.get(n.stage_id)).filter((s): s is Stage => !!s);
    if (!canMove || app.status !== 'active' || options.length === 0) return null;
    return (
      <select aria-label={`Move ${app.candidate_name}`} value="" disabled={move.isPending} onChange={(e) => e.target.value && requestMove(app, e.target.value)}>
        <option value="">Move to…</option>
        {options.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
      </select>
    );
  };

  return (
    <>
      <div className="toolbar">
        <div className="view-toggle" role="group" aria-label="View">
          <button aria-pressed={view === 'board'} onClick={() => setView('board')}>Board</button>
          <button aria-pressed={view === 'table'} onClick={() => setView('table')}>Table</button>
        </div>
        <label className="check"><input type="checkbox" checked={includeClosed} onChange={(e) => setIncludeClosed(e.target.checked)} /> Include rejected, withdrawn and hired</label>
        <span style={{ flex: 1 }} />
        {canAdd && <button className="btn btn-primary btn-sm" onClick={() => setAdding(true)}>Add candidate</button>}
      </div>
      {moveError && <div style={{ padding: '12px 12px 0' }}><div className="alert alert-error" role="alert">{moveError}</div></div>}

      {cards.length === 0 ? (
        <EmptyState title="No candidates yet" action={canAdd ? <button className="btn btn-primary" onClick={() => setAdding(true)}>Add the first candidate</button> : undefined}>
          Add candidates from your database to start moving them through the pipeline.
        </EmptyState>
      ) : view === 'board' ? (
        <div className="board">
          {stageList.map((stage) => {
            const inStage = cards.filter((c) => c.stage_id === stage.id);
            return (
              <section className="column" key={stage.id} aria-label={stage.name}>
                <h3><span>{stage.name}</span><span>{inStage.length}</span></h3>
                {inStage.length === 0 && <div className="drop-hint">None</div>}
                {inStage.map((c) => (
                  <article className="card-item" key={c.id}>
                    <Link className="name row-link" to="/candidates/$id" params={{ id: c.candidate_id }}>{c.candidate_name}</Link>
                    <div className="meta">
                      {[c.current_title, c.city].filter(Boolean).join(' · ') || '—'}
                      <br />
                      {c.agency_name ?? SOURCE_LABEL[c.source_type ?? ''] ?? '—'} · {formatDate(c.stage_changed_at)}
                    </div>
                    <MoveSelect app={c} />
                    {canSchedule && c.status === 'active' && <button className="btn btn-sm btn-link" style={{ marginTop: 6 }} onClick={() => setScheduling(c)}>Schedule interview</button>}
                    {canOffer && c.status === 'active' && <button className="btn btn-sm btn-link" style={{ marginTop: 6, marginLeft: 8 }} onClick={() => setOffering(c)}>Make offer</button>}
                  </article>
                ))}
              </section>
            );
          })}
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Candidate</th><th>Stage</th><th>Source</th><th>In stage since</th><th /></tr></thead>
            <tbody>
              {cards.map((c) => (
                <tr key={c.id}>
                  <td>
                    <Link className="row-link" to="/candidates/$id" params={{ id: c.candidate_id }}>{c.candidate_name}</Link>
                    <div className="cell-sub">{[c.current_title, c.city].filter(Boolean).join(' · ')}</div>
                  </td>
                  <td><Badge tone={c.status === 'hired' ? 'success' : c.status === 'active' ? 'info' : 'muted'}>{c.stage_name}</Badge></td>
                  <td>{c.agency_name ?? SOURCE_LABEL[c.source_type ?? ''] ?? '—'}</td>
                  <td className="muted">{formatDate(c.stage_changed_at)}</td>
                  <td className="actions"><MoveSelect app={c} />{canSchedule && c.status === 'active' && <button className="btn btn-sm" onClick={() => setScheduling(c)}>Schedule interview</button>}{canOffer && c.status === 'active' && <button className="btn btn-sm" onClick={() => setOffering(c)}>Make offer</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {pendingMove && (
        <ReasonDialog
          title={`Move ${pendingMove.app.candidate_name} to ${pendingMove.stage.name}`}
          error={move.error}
          pending={move.isPending}
          onClose={() => { setPendingMove(null); move.reset(); }}
          onConfirm={(reason) => move.mutate({ id: pendingMove.app.id, stageId: pendingMove.stage.id, reason })}
        />
      )}
      {adding && <AddCandidateDialog vacancyId={vacancyId} onClose={() => setAdding(false)} />}
      {offering && <NewOfferDialog applicationId={offering.id} candidateName={offering.candidate_name} onClose={() => setOffering(null)} />}
      {scheduling && <ScheduleDialog applicationId={scheduling.id} vacancyId={vacancyId} onClose={() => setScheduling(null)} />}
    </>
  );
}

function ReasonDialog({ title, error, pending, onClose, onConfirm }: {
  title: string; error: unknown; pending: boolean; onClose: () => void; onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = useState('');
  return (
    <Dialog
      open title={title} onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={() => onConfirm(reason.trim())} disabled={pending || !reason.trim()}>Confirm</button>
        </>
      }
    >
      <FormError error={error && !fieldError(error, 'reason') ? error : null} />
      <Field id="move-reason" label="Reason" hint="Kept in the candidate's history." error={fieldError(error, 'reason')}>
        <textarea id="move-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={2000} autoFocus />
      </Field>
    </Dialog>
  );
}

/** Pick an existing candidate to add to a vacancy. Creating new candidates happens on the Candidates page. */
export function AddCandidateDialog({ vacancyId, onClose }: { vacancyId: string; onClose: () => void }) {
  const invalidate = useInvalidatePipeline(vacancyId);
  const [search, setSearch] = useState('');
  const q = useDeferredValue(search.trim());
  const results = useQuery({ ...candidatesQuery({ q, page: 1 }), enabled: q.length >= 2 });
  const [source, setSource] = useState('internal_recruiter');
  const [added, setAdded] = useState<string[]>([]);

  const add = useMutation({
    mutationFn: (candidateId: string) => api('POST', '/applications', { candidate_id: candidateId, vacancy_id: vacancyId, source_type: source }),
    onSuccess: async (_d, candidateId) => { setAdded((a) => [...a, candidateId]); await invalidate(); },
  });
  const rows: CandidateRow[] = (results.data as Paged<CandidateRow> | undefined)?.data ?? [];

  return (
    <Dialog open wide title="Add candidate to vacancy" onClose={onClose} footer={<button className="btn" onClick={onClose}>Done</button>}>
      {add.error && <FormError error={add.error} />}
      <div className="form-grid">
        <Field id="cand-search" label="Find a candidate" hint="Search by name, skill, title or email.">
          <input id="cand-search" value={search} onChange={(e) => setSearch(e.target.value)} autoFocus />
        </Field>
        <Field id="cand-source" label="Source">
          <select id="cand-source" value={source} onChange={(e) => setSource(e.target.value)}>
            {['internal_recruiter', 'referral', 'direct', 'job_board', 'other'].map((s) => <option key={s} value={s}>{SOURCE_LABEL[s]}</option>)}
          </select>
        </Field>
      </div>
      {q.length < 2 ? null : results.isPending ? <Loading /> : results.isError ? (
        <ErrorState error={results.error} />
      ) : rows.length === 0 ? (
        <p className="empty-inline">No candidates found. Add them from the Candidates page first.</p>
      ) : (
        <table>
          <tbody>
            {rows.map((c) => (
              <tr key={c.id}>
                <td><strong>{c.full_name}</strong><div className="cell-sub">{[c.current_title, c.city].filter(Boolean).join(' · ')}</div></td>
                <td className="actions">
                  {added.includes(c.id) ? <Badge tone="success">Added</Badge> : (
                    <button className="btn btn-sm" disabled={add.isPending} onClick={() => add.mutate(c.id)}>Add</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Dialog>
  );
}

