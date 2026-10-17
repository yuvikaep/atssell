import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, type Competency, type InterviewPlan } from '../api';
import { plansQuery } from '../queries';
import { Badge, Dialog, ErrorState, Field, fieldError, FormError, Loading } from './ui';

const slug = (label: string) => label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 38);

/** Interview rounds for a vacancy, each with its own scorecard. Interviews keep the scorecard they were booked with. */
export function InterviewRounds({ vacancyId, canManage }: { vacancyId: string; canManage: boolean }) {
  const plans = useQuery(plansQuery(vacancyId));
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<InterviewPlan | 'new' | null>(null);
  const toggle = useMutation({
    mutationFn: (p: InterviewPlan) => api('PATCH', `/interview-plans/${p.id}`, { is_active: !p.is_active }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['plans', vacancyId] }),
  });

  return (
    <div className="card section">
      <h2>Interview rounds {canManage && <button className="btn btn-sm" onClick={() => setEditing('new')}>Add round</button>}</h2>
      {plans.isPending ? <Loading /> : plans.isError ? <ErrorState error={plans.error} onRetry={() => plans.refetch()} /> : plans.data.length === 0 ? (
        <p className="empty-inline">No rounds defined. Interviews can still be scheduled with a standard scorecard.</p>
      ) : (
        <ol style={{ margin: 0, padding: 0, listStyle: 'none' }}>
          {plans.data.map((p) => (
            <li key={p.id} className="note">
              <div className="title-row">
                <strong>{p.round_order}. {p.name}</strong>{!p.is_active && <Badge tone="muted">Off</Badge>}
                {canManage && (
                  <span style={{ marginLeft: 'auto' }} className="actions-row">
                    <button className="btn btn-sm" onClick={() => setEditing(p)}>Edit</button>
                    <button className="btn btn-sm" disabled={toggle.isPending} onClick={() => toggle.mutate(p)}>{p.is_active ? 'Turn off' : 'Turn on'}</button>
                  </span>
                )}
              </div>
              <div className="cell-sub">{p.competencies.length === 0 ? 'Overall rating only' : p.competencies.map((c) => c.label + (c.required ? '' : ' (optional)')).join(' · ')}</div>
            </li>
          ))}
        </ol>
      )}
      {editing && <RoundDialog vacancyId={vacancyId} plan={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function RoundDialog({ vacancyId, plan, onClose }: { vacancyId: string; plan: InterviewPlan | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(plan?.name ?? '');
  const [rows, setRows] = useState<Competency[]>(plan?.competencies ?? [
    { code: 'role_skills', label: 'Role skills', required: true },
    { code: 'communication', label: 'Communication', required: true },
  ]);
  const save = useMutation({
    mutationFn: () => {
      // Existing competencies keep their code, so earlier feedback still lines up with the scorecard.
      const used = new Set<string>();
      const competencies = rows.filter((r) => r.label.trim()).map((r) => {
        let code = r.code || slug(r.label) || 'competency';
        let n = 2;
        while (used.has(code)) code = `${slug(r.label) || 'competency'}_${n++}`;
        used.add(code);
        return { code, label: r.label.trim(), required: r.required };
      });
      const body = { name, competencies };
      return plan ? api('PATCH', `/interview-plans/${plan.id}`, body) : api('POST', `/vacancies/${vacancyId}/interview-plans`, body);
    },
    onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: ['plans', vacancyId] }); onClose(); },
  });
  const set = (i: number, patch: Partial<Competency>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  return (
    <Dialog open wide title={plan ? `Edit ${plan.name}` : 'Add an interview round'} onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" onClick={() => save.mutate()} disabled={save.isPending || !name.trim()}>{plan ? 'Save round' : 'Add round'}</button></>}>
      <FormError error={save.error && !fieldError(save.error, 'name') ? save.error : null} />
      <Field id="round-name" label="Round name" error={fieldError(save.error, 'name')}><input id="round-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} autoFocus /></Field>
      <h3 style={{ fontSize: 13, margin: '4px 0 8px' }}>Scorecard</h3>
      <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>Every interviewer also gives an overall rating and a recommendation. Add the competencies you want rated.</p>
      {rows.map((r, i) => (
        <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr auto auto', gap: 8, marginBottom: 8, alignItems: 'center' }}>
          <input aria-label={`Competency ${i + 1}`} placeholder="For example: System design" value={r.label} onChange={(e) => set(i, { label: e.target.value })} maxLength={80} />
          <label className="check" style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13 }}>
            <input type="checkbox" checked={r.required} onChange={(e) => set(i, { required: e.target.checked })} style={{ width: 'auto', height: 'auto' }} /> Required
          </label>
          <button className="btn btn-sm" type="button" onClick={() => setRows(rows.filter((_, j) => j !== i))} aria-label={`Remove competency ${i + 1}`}>Remove</button>
        </div>
      ))}
      {rows.length < 12 && <button className="btn btn-link" type="button" onClick={() => setRows([...rows, { code: '', label: '', required: true }])}>+ Add a competency</button>}
      {fieldError(save.error, 'competencies') && <span className="field-error" style={{ color: 'var(--danger)' }}>{fieldError(save.error, 'competencies')}</span>}
    </Dialog>
  );
}
