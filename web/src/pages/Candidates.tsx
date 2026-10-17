import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useDeferredValue, useState, type FormEvent } from 'react';
import { api, ApiError, can, formatInr, type DuplicateMatch } from '../api';
import { useMe } from '../components/AppShell';
import { CandidateFormFields, candidateBody, emptyCandidateForm, type CandidateForm } from '../components/CandidateForm';
import { Dialog, EmptyState, ErrorState, FormError, Loading, Pager, Tags } from '../components/ui';
import { candidatesQuery } from '../queries';

export function CandidatesPage() {
  const me = useMe();
  const [search, setSearch] = useState('');
  const [city, setCity] = useState('');
  const [skills, setSkills] = useState('');
  const [minExp, setMinExp] = useState('');
  const [maxNotice, setMaxNotice] = useState('');
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const [q, deferredCity, deferredSkills] = [useDeferredValue(search.trim()), useDeferredValue(city.trim()), useDeferredValue(skills.trim())];
  const list = useQuery(candidatesQuery({ q, city: deferredCity, skills: deferredSkills, min_experience: minExp, max_notice_days: maxNotice, page }));
  const showContact = can(me, 'candidates.view_contact');
  const showCtc = can(me, 'candidates.view_compensation');
  const filtered = !!(q || deferredCity || deferredSkills || minExp || maxNotice);
  const reset = () => setPage(1);

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Candidates</h1>
          <p>Everyone you have sourced, in one searchable database.</p>
        </div>
        {can(me, 'candidates.manage') && <button className="btn btn-primary" onClick={() => setCreating(true)}>Add candidate</button>}
      </div>

      <div className="card">
        <div className="toolbar">
          <input className="grow" type="search" placeholder={showContact ? 'Search name, title, skill or email' : 'Search name, title or skill'} aria-label="Search candidates" value={search} onChange={(e) => { setSearch(e.target.value); reset(); }} />
          <input type="text" placeholder="City" aria-label="City" style={{ width: 130 }} value={city} onChange={(e) => { setCity(e.target.value); reset(); }} />
          <input type="text" placeholder="Skills (comma separated)" aria-label="Skills" style={{ width: 190 }} value={skills} onChange={(e) => { setSkills(e.target.value); reset(); }} />
          <input type="number" min={0} placeholder="Min yrs" aria-label="Minimum years of experience" style={{ width: 100 }} value={minExp} onChange={(e) => { setMinExp(e.target.value); reset(); }} />
          <input type="number" min={0} placeholder="Max notice (days)" aria-label="Maximum notice period in days" style={{ width: 150 }} value={maxNotice} onChange={(e) => { setMaxNotice(e.target.value); reset(); }} />
        </div>
        {list.isPending ? (
          <Loading />
        ) : list.isError ? (
          <ErrorState error={list.error} onRetry={() => list.refetch()} />
        ) : list.data.data.length === 0 ? (
          <EmptyState
            title={filtered ? 'No candidates match' : 'No candidates yet'}
            action={!filtered && can(me, 'candidates.manage') ? <button className="btn btn-primary" onClick={() => setCreating(true)}>Add the first candidate</button> : undefined}
          >
            {filtered ? 'Try fewer filters or a different spelling.' : 'Add candidates and attach their resumes to start building your database.'}
          </EmptyState>
        ) : (
          <>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Candidate</th>{showContact && <th>Contact</th>}<th>Skills</th><th className="num">Experience</th><th className="num">Notice</th>
                    {showCtc && <th className="num">Expected CTC</th>}<th className="num">Active applications</th>
                  </tr>
                </thead>
                <tbody>
                  {list.data.data.map((c) => (
                    <tr key={c.id}>
                      <td>
                        <Link className="row-link" to="/candidates/$id" params={{ id: c.id }}>{c.full_name}</Link>
                        <div className="cell-sub">{[c.current_title, c.city].filter(Boolean).join(' · ')}</div>
                      </td>
                      {showContact && <td>{c.email ?? <span className="muted">—</span>}<div className="cell-sub">{c.phone}</div></td>}
                      <td><Tags items={c.skills.slice(0, 4)} />{c.skills.length > 4 && <span className="muted"> +{c.skills.length - 4}</span>}</td>
                      <td className="num">{c.total_experience_years != null ? `${c.total_experience_years} yrs` : '—'}</td>
                      <td className="num">{c.notice_period_days != null ? `${c.notice_period_days} d` : '—'}</td>
                      {showCtc && <td className="num">{c.expected_ctc != null ? formatInr(c.expected_ctc) : '—'}</td>}
                      <td className="num">{c.active_applications}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pager page={page} pageSize={list.data.page_size} total={list.data.total} onPage={setPage} />
          </>
        )}
      </div>
      {creating && <CreateCandidateDialog onClose={() => setCreating(false)} />}
    </>
  );
}

function MatchList({ matches }: { matches: DuplicateMatch[] }) {
  return (
    <ul>
      {matches.map((m, i) => (
        <li key={m.id ?? i}>
          {m.hidden ? 'A candidate you do not have access to' : <Link to="/candidates/$id" params={{ id: m.id! }}>{m.full_name}</Link>}
          {!m.hidden && (m.current_title || m.city) ? ` (${[m.current_title, m.city].filter(Boolean).join(', ')})` : ''}
          {' — '}{m.match_reason === 'same_email' ? 'same email' : m.match_reason === 'same_phone' ? 'same phone' : 'similar name'}
        </li>
      ))}
    </ul>
  );
}

export function CreateCandidateDialog({ onClose }: { onClose: () => void }) {
  const me = useMe();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [form, setForm] = useState<CandidateForm>(emptyCandidateForm);
  const deferred = useDeferredValue({ name: form.full_name.trim(), email: form.email.trim(), phone: form.phone.trim() });

  // Live duplicate check as the recruiter types. Exact matches block saving; similar names only warn.
  const check = useQuery({
    queryKey: ['duplicate-check', deferred],
    queryFn: () => api<{ data: { exact: DuplicateMatch[]; possible: DuplicateMatch[] } }>('POST', '/candidates/duplicate-check', {
      full_name: deferred.name, email: deferred.email || null, phone: deferred.phone || null,
    }).then((r) => r.data),
    enabled: deferred.name.length >= 3 || !!deferred.email || deferred.phone.length >= 8,
    retry: false,
  });

  const save = useMutation({
    mutationFn: () => api<{ data: { id: string } }>('POST', '/candidates', candidateBody(form, can(me, 'candidates.view_compensation'))),
    onSuccess: async (res) => {
      await queryClient.invalidateQueries({ queryKey: ['candidates'] });
      onClose();
      await navigate({ to: '/candidates/$id', params: { id: res.data.id } });
    },
  });
  const serverExact = save.error instanceof ApiError && save.error.code === 'DUPLICATE_CANDIDATE'
    ? ((save.error.details as { exact?: DuplicateMatch[] } | undefined)?.exact ?? []) : [];
  const exact = check.data?.exact.length ? check.data.exact : serverExact;
  const submit = (e: FormEvent) => { e.preventDefault(); if (exact.length === 0) save.mutate(); };

  return (
    <Dialog
      open wide title="Add candidate" onClose={onClose}
      footer={
        <>
          <button className="btn" type="button" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" type="submit" form="cand-form" disabled={save.isPending || !form.full_name.trim() || (!form.email.trim() && !form.phone.trim()) || exact.length > 0}>Add candidate</button>
        </>
      }
    >
      <form id="cand-form" onSubmit={submit} noValidate>
        {exact.length > 0 && (
          <div className="dup-box block" role="alert">
            <strong>This person is already in your database.</strong> Open the existing profile instead of creating another.
            <MatchList matches={exact} />
          </div>
        )}
        {exact.length === 0 && (check.data?.possible.length ?? 0) > 0 && (
          <div className="dup-box" role="status">
            <strong>Possible duplicate.</strong> Check these before adding:
            <MatchList matches={check.data!.possible} />
          </div>
        )}
        <FormError error={save.error && !(save.error instanceof ApiError && (save.error.details || save.error.code === 'DUPLICATE_CANDIDATE')) ? save.error : null} />
        <CandidateFormFields form={form} setForm={setForm} error={save.error} canSeeCtc={can(me, 'candidates.view_compensation')} />
      </form>
    </Dialog>
  );
}
