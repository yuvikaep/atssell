// Agency isolation: an agency must see only its own vacancies and submissions, and nothing about the
// company's internals, other agencies, or other sources of the same candidate.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, setupApp, type TestContext } from './helpers.js';
import {
  addAgencyMember, agencyProfile, createAgency, PDF, setupCompany, submitAs, vacancyWithAgencies,
} from './hiring-helpers.js';

let ctx: TestContext;
let s: Awaited<ReturnType<typeof setupCompany>>;
let admin: string;
let recruiter: string;
let alpha: string;
let beta: string;
let alphaAdmin: { cookie: string; userId: string };
let alphaRec: { cookie: string; userId: string };
let betaAdmin: { cookie: string; userId: string };
let sharedVacancy: { id: string };
let alphaOnly: { id: string };
let betaOnly: { id: string };

beforeAll(async () => {
  ctx = await setupApp();
  s = await setupCompany(ctx, 'ap');
  [admin, recruiter] = await Promise.all([s.as('admin'), s.as('recruiter')]);
  alpha = await createAgency(ctx, admin, 'Alpha Staffing');
  beta = await createAgency(ctx, admin, 'Beta Talent');
  alphaAdmin = await addAgencyMember(ctx, admin, alpha, 'admin@alpha.test', 'admin');
  alphaRec = await addAgencyMember(ctx, admin, alpha, 'rec@alpha.test', 'recruiter');
  betaAdmin = await addAgencyMember(ctx, admin, beta, 'admin@beta.test', 'admin');
  sharedVacancy = await vacancyWithAgencies(ctx, s, [alpha, beta], { title: 'Shared Platform Engineer', headcount: 3 });
  alphaOnly = await vacancyWithAgencies(ctx, s, [alpha], { title: 'Alpha Exclusive Analyst' });
  betaOnly = await vacancyWithAgencies(ctx, s, [beta], { title: 'Beta Exclusive Designer' });
});
afterAll(() => ctx.close());

const text = (res: { body: string }) => res.body;

describe('what an agency can reach', () => {
  it('sees only vacancies assigned to its own agency', async () => {
    const mine = (await call(ctx, alphaAdmin.cookie, 'GET', '/agency/vacancies')).json().data;
    expect(mine.map((v: { id: string }) => v.id).sort()).toEqual([sharedVacancy.id, alphaOnly.id].sort());
    const theirs = (await call(ctx, betaAdmin.cookie, 'GET', '/agency/vacancies')).json().data;
    expect(theirs.map((v: { id: string }) => v.id)).not.toContain(alphaOnly.id);
  });

  it("another agency's vacancy does not exist as far as it is concerned", async () => {
    expect((await call(ctx, alphaAdmin.cookie, 'GET', `/agency/vacancies/${betaOnly.id}`)).statusCode).toBe(404);
    const submit = await submitAs(ctx, alphaAdmin.cookie, betaOnly.id, agencyProfile('sneaky'));
    expect(submit.statusCode).toBe(404);
  });

  it('a vacancy shows the job, not the company internals or other agencies', async () => {
    const res = await call(ctx, alphaAdmin.cookie, 'GET', `/agency/vacancies/${sharedVacancy.id}`);
    expect(res.statusCode).toBe(200);
    const v = res.json().data;
    expect(v).toMatchObject({ title: 'Shared Platform Engineer', can_submit: true });
    expect(v.submission_policy).toEqual({ notes: null });
    for (const forbidden of ['min_ctc', 'max_ctc', 'owner', 'recruiters', 'agencies', 'hiring_manager', 'requisition_id', 'requested_by', 'department']) {
      expect(Object.keys(v).join(','), forbidden).not.toContain(forbidden);
    }
    const body = text(res);
    expect(body).not.toContain('Beta Talent');
    expect(body).not.toContain('Admin User');
    expect(body).not.toContain('1800000');
  });

  it('every internal endpoint refuses or empties for an agency user', async () => {
    const c = alphaAdmin.cookie;
    const denied: [string, 'GET' | 'POST', string][] = [
      ['candidates', 'GET', '/candidates'],
      ['agencies', 'GET', '/agencies'],
      ['users', 'GET', '/users'],
      ['roles', 'GET', '/roles'],
      ['create candidate', 'POST', '/candidates'],
      ['create application', 'POST', '/applications'],
      ['agency members', 'GET', `/agencies/${alpha}/members`],
    ];
    for (const [label, method, url] of denied) {
      const res = await call(ctx, c, method, url, method === 'POST' ? {} : undefined);
      expect(res.statusCode, `${label}: ${res.statusCode}`).toBe(403);
    }
    // These return nothing rather than refusing, because visibility is row-based.
    expect((await call(ctx, c, 'GET', '/vacancies?status=all')).json().total).toBe(0);
    expect((await call(ctx, c, 'GET', '/requisitions')).json().total).toBe(0);
    expect((await call(ctx, c, 'GET', '/applications?status=all')).json().total).toBe(0);
    expect((await call(ctx, c, 'GET', `/vacancies/${sharedVacancy.id}`)).statusCode).toBe(404);
    expect((await call(ctx, c, 'GET', '/departments')).json().data).toHaveLength(0);
  });

  it('company users cannot use the agency portal', async () => {
    expect((await call(ctx, admin, 'GET', '/agency/home')).statusCode).toBe(403);
    expect((await call(ctx, recruiter, 'GET', '/agency/vacancies')).statusCode).toBe(403);
  });

  it('an agency user can only ever be an agency member', async () => {
    const perms = (await call(ctx, alphaAdmin.cookie, 'GET', '/me')).json().data.permissions;
    expect(Object.keys(perms).sort()).toEqual(['agency_portal.use', 'performance.view_own', 'submissions.create']);
  });
});

describe('submitting candidates', () => {
  it('creates the candidate, application and a credited submission, and tells the agency so', async () => {
    const res = await submitAs(ctx, alphaAdmin.cookie, sharedVacancy.id, agencyProfile('first', { phone: '99000 11111', current_title: 'Java Developer', total_experience_years: 4 }));
    expect(res.statusCode).toBe(201);
    const d = res.json().data;
    expect(d.ownership.label).toBe('Credited');
    expect(d.message).toContain('credited to your agency');

    const sub = await ctx.adminDb.selectFrom('submissions').selectAll().where('id', '=', d.id).executeTakeFirstOrThrow();
    expect(sub).toMatchObject({ source_type: 'agency', agency_id: alpha, ownership_state: 'accepted', ownership_expires_at: null, consent_confirmed: true, source_declaration: "Found in the agency's own database or search" });

    const cand = await ctx.adminDb.selectFrom('candidates').select(['full_name', 'phone', 'privacy_notice_status']).where('email', '=', 'ac.first@mail.test').executeTakeFirstOrThrow();
    expect(cand).toMatchObject({ full_name: 'Agency Candidate first', phone: '+919900011111', privacy_notice_status: 'agency_declared_consent' });
  });

  it('the company sees the agency as the source on the candidate and in the pipeline', async () => {
    const list = (await call(ctx, admin, 'GET', `/applications?vacancy_id=${sharedVacancy.id}`)).json().data;
    const card = list.find((c: { candidate_name: string }) => c.candidate_name === 'Agency Candidate first');
    expect(card).toMatchObject({ agency_name: 'Alpha Staffing', source_type: 'agency', stage_code: 'submitted' });
    const cand = (await call(ctx, admin, 'GET', `/candidates?q=ac.first`)).json().data[0];
    const profile = (await call(ctx, admin, 'GET', `/candidates/${cand.id}`)).json().data;
    expect(profile.submissions[0]).toMatchObject({ agency_name: 'Alpha Staffing', source_type: 'agency' });
    expect(profile.documents).toHaveLength(1);
  });

  it('lists the submission for the agency, with their own data and no internals', async () => {
    const res = await call(ctx, alphaAdmin.cookie, 'GET', '/agency/submissions');
    const row = res.json().data.find((r: { candidate_name: string }) => r.candidate_name === 'Agency Candidate first');
    expect(row).toMatchObject({ current_title: 'Java Developer', email: 'ac.first@mail.test', stage: 'Submitted', has_resume: true });
    expect(row.vacancy).toMatchObject({ code: expect.stringMatching(/^VAC-/), title: 'Shared Platform Engineer' });
    expect(Object.keys(row)).not.toEqual(expect.arrayContaining(['candidate_id', 'application_id', 'agency_id', 'storage_key']));
  });

  it('needs a resume, consent, and a way to contact the candidate', async () => {
    const noResume = await submitAs(ctx, alphaAdmin.cookie, sharedVacancy.id, agencyProfile('noresume'), null);
    expect(noResume.statusCode).toBe(400);
    expect(noResume.json().error.code).toBe('RESUME_REQUIRED');
    const noConsent = await submitAs(ctx, alphaAdmin.cookie, sharedVacancy.id, agencyProfile('noconsent', { consent_confirmed: false }));
    expect(noConsent.statusCode).toBe(400);
    expect(noConsent.json().error.details.map((d: { path: string }) => d.path)).toContain('consent_confirmed');
    const noContact = await submitAs(ctx, alphaAdmin.cookie, sharedVacancy.id, agencyProfile('nocontact', { email: null, phone: null }));
    expect(noContact.statusCode).toBe(400);
    expect(await ctx.adminDb.selectFrom('candidates').select('id').where('full_name', 'in', ['Agency Candidate noresume', 'Agency Candidate noconsent', 'Agency Candidate nocontact']).execute()).toHaveLength(0);
  });

  it('checks the resume by content and by malware scan, and stores nothing when refused', async () => {
    const before = ctx.storage.files.size;
    const exe = await submitAs(ctx, alphaAdmin.cookie, sharedVacancy.id, agencyProfile('exe'), { name: 'cv.pdf', content: Buffer.from('MZ\x90\x00 not a pdf') });
    expect(exe.statusCode).toBe(415);
    const eicar = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';
    const bad = await submitAs(ctx, alphaAdmin.cookie, sharedVacancy.id, agencyProfile('virus'), { name: 'cv.pdf', content: Buffer.concat([PDF(), Buffer.from(eicar)]) });
    expect(bad.statusCode).toBe(422);
    expect(ctx.storage.files.size).toBe(before);
    expect(await ctx.adminDb.selectFrom('candidates').select('id').where('email', 'in', ['ac.exe@mail.test', 'ac.virus@mail.test']).execute()).toHaveLength(0);
  });

  it('only open vacancies accept submissions', async () => {
    const v = await vacancyWithAgencies(ctx, s, [alpha]);
    await call(ctx, admin, 'PATCH', `/vacancies/${v.id}`, { status: 'on_hold', status_reason: 'Budget review' });
    const res = await submitAs(ctx, alphaAdmin.cookie, v.id, agencyProfile('onhold'));
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('VACANCY_NOT_OPEN');
    expect((await call(ctx, alphaAdmin.cookie, 'GET', `/agency/vacancies/${v.id}`)).json().data.can_submit).toBe(false);
  });

  it('the same agency cannot submit the same candidate to the same vacancy twice', async () => {
    const again = await submitAs(ctx, alphaRec.cookie, sharedVacancy.id, agencyProfile('first'));
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('DUPLICATE_CANDIDATE');
  });

  it('the owning agency can submit its own candidate to another vacancy, reusing the profile', async () => {
    const res = await submitAs(ctx, alphaAdmin.cookie, alphaOnly.id, agencyProfile('first'));
    expect(res.statusCode).toBe(201);
    expect(res.json().data.ownership.label).toBe('Credited');
    expect(await ctx.adminDb.selectFrom('candidates').select('id').where('email', '=', 'ac.first@mail.test').execute()).toHaveLength(1);
  });

  it('a resume uploaded through an agency submission is attached to the submission', async () => {
    const res = await submitAs(ctx, alphaAdmin.cookie, sharedVacancy.id, agencyProfile('withcv'), { name: 'Arjun CV.pdf', content: PDF('arjun') });
    const sub = await ctx.adminDb.selectFrom('submissions as s').innerJoin('candidate_documents as d', 'd.id', 's.resume_document_id').select(['d.original_filename', 'd.uploaded_by', 'd.scan_status']).where('s.id', '=', res.json().data.id).executeTakeFirstOrThrow();
    expect(sub).toMatchObject({ original_filename: 'Arjun CV.pdf', uploaded_by: alphaAdmin.userId, scan_status: 'clean' });
  });
});

describe('duplicates are rejected, and never leak', () => {
  it('a second agency submitting the same candidate is rejected as a duplicate, with nothing stored', async () => {
    const first = await submitAs(ctx, alphaAdmin.cookie, sharedVacancy.id, agencyProfile('contested', { full_name: 'Arjun Kapoor', current_title: 'Staff Engineer' }));
    expect(first.statusCode).toBe(201);
    const files = ctx.storage.files.size;

    const second = await submitAs(ctx, betaAdmin.cookie, sharedVacancy.id, agencyProfile('contested', { full_name: 'A. Kapoor', current_title: 'Engineer' }));
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe('DUPLICATE_CANDIDATE');
    expect(second.json().error.message).toContain('already submitted for this job');
    // It must not reveal who sourced the candidate, or anything about them.
    for (const leak of ['Alpha', 'Arjun', 'Staff Engineer', first.json().data.id]) expect(second.body, leak).not.toContain(leak);

    expect(ctx.storage.files.size).toBe(files);
    const subs = await ctx.adminDb.selectFrom('submissions as s').innerJoin('applications as a', 'a.id', 's.application_id').innerJoin('candidates as c', 'c.id', 'a.candidate_id').select('s.agency_id').where('c.email', '=', 'ac.contested@mail.test').execute();
    expect(subs.map((x) => x.agency_id)).toEqual([alpha]);
    const list = (await call(ctx, betaAdmin.cookie, 'GET', '/agency/submissions')).json();
    expect(JSON.stringify(list)).not.toContain('Kapoor');
  });

  it('the canonical candidate is not changed by the rejected attempt', async () => {
    const c = await ctx.adminDb.selectFrom('candidates').select(['full_name', 'current_title']).where('email', '=', 'ac.contested@mail.test').execute();
    expect(c).toEqual([{ full_name: 'Arjun Kapoor', current_title: 'Staff Engineer' }]);
  });

  it('records the rejected attempt in the audit log, without personal details', async () => {
    const ev = await ctx.adminDb.selectFrom('audit_events').select(['actor_user_id', 'entity_id', 'metadata']).where('tenant_id', '=', s.co.tenant.id).where('action', '=', 'submission.duplicate_attempt').orderBy('created_at', 'desc').executeTakeFirstOrThrow();
    expect(ev).toMatchObject({ actor_user_id: betaAdmin.userId, entity_id: sharedVacancy.id });
    expect(ev.metadata).toMatchObject({ agency_id: beta });
    // The attempt is also kept in its own table, next to (never instead of) the accepted owner.
    const attempt = await ctx.adminDb.selectFrom('duplicate_attempts').select(['attempted_agency_id', 'original_submission_id']).where('vacancy_id', '=', sharedVacancy.id).where('attempted_by', '=', betaAdmin.userId).executeTakeFirstOrThrow();
    expect(attempt).toMatchObject({ attempted_agency_id: beta, original_submission_id: expect.any(String) });
    expect(JSON.stringify(ev.metadata)).not.toContain('contested');
    expect(JSON.stringify(ev.metadata)).not.toContain('Kapoor');
  });

  it('a candidate the company already holds is matched, not duplicated, and the agency learns nothing about the record', async () => {
    const created = await call(ctx, recruiter, 'POST', '/candidates', { full_name: 'Known Internally', email: 'known.internal@mail.test' });
    expect(created.statusCode).toBe(201);
    const res = await submitAs(ctx, betaAdmin.cookie, sharedVacancy.id, agencyProfile('x', { email: 'known.internal@mail.test', full_name: 'Known Internally' }));
    expect(res.statusCode, res.body).toBe(201);
    expect(res.body.toLowerCase()).not.toContain('internal');
    expect(await ctx.adminDb.selectFrom('candidates').select('id').where('email', '=', 'known.internal@mail.test').execute()).toHaveLength(1);
    const apps = await ctx.adminDb.selectFrom('applications').select('id').where('candidate_id', '=', created.json().data.id).execute();
    expect(apps).toHaveLength(1);
  });

  it('matches on email in any case, and on a phone number written differently', async () => {
    await submitAs(ctx, alphaAdmin.cookie, sharedVacancy.id, agencyProfile('formats', { email: 'Mixed.Case@mail.test', phone: '98111 22233' }));
    const byEmail = await submitAs(ctx, betaAdmin.cookie, sharedVacancy.id, agencyProfile('f2', { email: 'mixed.case@MAIL.test' }));
    expect(byEmail.statusCode).toBe(409);
    const byPhone = await submitAs(ctx, betaAdmin.cookie, sharedVacancy.id, agencyProfile('f3', { email: 'someone.else@mail.test', phone: '+91-98111-22233' }));
    expect(byPhone.statusCode).toBe(409);
  });

  it('a similar name alone is not a duplicate', async () => {
    const res = await submitAs(ctx, betaAdmin.cookie, sharedVacancy.id, agencyProfile('similar', { full_name: 'Agency Candidate first', email: 'completely.different@mail.test' }));
    expect(res.statusCode).toBe(201);
  });

  it('email and phone matching two different candidates is still a duplicate for a non-owner', async () => {
    await submitAs(ctx, alphaAdmin.cookie, sharedVacancy.id, agencyProfile('split1', { email: 'split.one@mail.test', phone: '98777 00001' }));
    await submitAs(ctx, alphaAdmin.cookie, sharedVacancy.id, agencyProfile('split2', { email: 'split.two@mail.test', phone: '98777 00002' }));
    const res = await submitAs(ctx, betaAdmin.cookie, sharedVacancy.id, agencyProfile('mix', { email: 'split.one@mail.test', phone: '98777 00002' }));
    expect(res.statusCode).toBe(409);
  });

  it('a duplicate on a vacancy that is not the agency\'s says nothing about candidates', async () => {
    const res = await submitAs(ctx, alphaAdmin.cookie, betaOnly.id, agencyProfile('contested'));
    expect(res.statusCode).toBe(404);
  });

  it('the same candidate in another company is not a duplicate', async () => {
    const other = await setupCompany(ctx, 'ap2');
    const otherAdmin = await other.as('admin');
    const otherAgency = await createAgency(ctx, otherAdmin, 'Elsewhere Staffing');
    const member = await addAgencyMember(ctx, otherAdmin, otherAgency, 'e@elsewhere.test', 'admin');
    const v = await vacancyWithAgencies(ctx, other, [otherAgency]);
    const res = await submitAs(ctx, member.cookie, v.id, agencyProfile('contested'));
    expect(res.statusCode).toBe(201);
    expect(res.json().data.ownership.label).toBe('Credited');
  });

  it('two agencies submitting the same new candidate at once: one is credited, the other is a duplicate', async () => {
    const profile = agencyProfile('race', { email: 'race.condition@mail.test' });
    const results = await Promise.all([
      submitAs(ctx, alphaAdmin.cookie, sharedVacancy.id, { ...profile, full_name: 'Race A' }),
      submitAs(ctx, betaAdmin.cookie, sharedVacancy.id, { ...profile, full_name: 'Race B' }),
    ]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409]);
    expect(await ctx.adminDb.selectFrom('candidates').select('id').where('email', '=', 'race.condition@mail.test').execute()).toHaveLength(1);
    const subs = await ctx.adminDb.selectFrom('submissions as s').innerJoin('applications as a', 'a.id', 's.application_id').innerJoin('candidates as c', 'c.id', 'a.candidate_id').select('s.agency_id').where('c.email', '=', 'race.condition@mail.test').execute();
    expect(subs).toHaveLength(1);
  });

  it('two people adding the same new candidate at once internally create only one', async () => {
    const results = await Promise.all(Array.from({ length: 5 }, (_, i) => call(ctx, recruiter, 'POST', '/candidates', { full_name: `Same Person ${i}`, email: 'same.person@mail.test' })));
    expect(results.filter((r) => r.statusCode === 201)).toHaveLength(1);
    expect(results.filter((r) => r.statusCode === 409)).toHaveLength(4);
  });
});

describe('who sees which submissions', () => {
  it('an agency recruiter sees only their own; the agency admin sees the whole agency; another agency sees none of them', async () => {
    const fresh = await createAgency(ctx, admin, 'Visibility Staffing');
    const boss = await addAgencyMember(ctx, admin, fresh, 'boss@vis.test', 'admin');
    const r1 = await addAgencyMember(ctx, admin, fresh, 'r1@vis.test', 'recruiter');
    const r2 = await addAgencyMember(ctx, admin, fresh, 'r2@vis.test', 'recruiter');
    const v = await vacancyWithAgencies(ctx, s, [fresh]);
    await submitAs(ctx, r1.cookie, v.id, agencyProfile('vis one'));
    await submitAs(ctx, r2.cookie, v.id, agencyProfile('vis two'));
    const names = async (cookie: string) => (await call(ctx, cookie, 'GET', '/agency/submissions')).json().data.map((x: { candidate_name: string }) => x.candidate_name).sort();
    expect(await names(r1.cookie)).toEqual(['Agency Candidate vis one']);
    expect(await names(r2.cookie)).toEqual(['Agency Candidate vis two']);
    expect(await names(boss.cookie)).toEqual(['Agency Candidate vis one', 'Agency Candidate vis two']);
    expect((await names(betaAdmin.cookie)).filter((n: string) => n.includes('vis'))).toEqual([]);
  });

  it('filters by vacancy, and the home page counts only the agency\'s own', async () => {
    const byVacancy = (await call(ctx, alphaAdmin.cookie, 'GET', `/agency/submissions?vacancy_id=${alphaOnly.id}`)).json();
    expect(byVacancy.data.every((r: { vacancy: { id: string } }) => r.vacancy.id === alphaOnly.id)).toBe(true);
    const home = (await call(ctx, betaAdmin.cookie, 'GET', '/agency/home')).json().data;
    expect(home.agency).toMatchObject({ name: 'Beta Talent', role: 'admin' });
    expect(home.open_vacancies).toBe(2);
    expect(home.submissions.total).toBeGreaterThan(0);
    expect(home.submissions).toMatchObject({ credited: expect.any(Number), rejected_duplicates: expect.any(Number) });
    expect(JSON.stringify(home)).not.toContain('Alpha');
  });

  it('after being unassigned from a vacancy the agency can no longer submit but still sees its history', async () => {
    const v = await vacancyWithAgencies(ctx, s, [alpha, beta]);
    await submitAs(ctx, alphaAdmin.cookie, v.id, agencyProfile('history'));
    await call(ctx, admin, 'POST', `/vacancies/${v.id}/unassign-agency`, { agency_id: alpha });
    expect((await call(ctx, alphaAdmin.cookie, 'GET', `/agency/vacancies/${v.id}`)).statusCode).toBe(404);
    expect((await submitAs(ctx, alphaAdmin.cookie, v.id, agencyProfile('late'))).statusCode).toBe(404);
    const subs = (await call(ctx, alphaAdmin.cookie, 'GET', `/agency/submissions?vacancy_id=${v.id}`)).json();
    expect(subs.total).toBe(1);
  });
});

describe('resumes', () => {
  it('an agency can download its own submitted resume through a short-lived link', async () => {
    const sub = (await submitAs(ctx, alphaAdmin.cookie, sharedVacancy.id, agencyProfile('dl'), { name: 'dl.pdf', content: PDF('download me') })).json().data;
    const link = await call(ctx, alphaAdmin.cookie, 'POST', `/agency/submissions/${sub.id}/resume-url`);
    expect(link.statusCode).toBe(200);
    const file = await ctx.app.inject({ method: 'GET', url: link.json().data.url });
    expect(file.statusCode).toBe(200);
    expect(file.rawPayload.toString()).toContain('download me');
  });

  it("an agency cannot get another agency's resume, or one from a recruiter's colleague", async () => {
    const sub = (await submitAs(ctx, alphaAdmin.cookie, sharedVacancy.id, agencyProfile('private'), { name: 'p.pdf', content: PDF('secret') })).json().data;
    expect((await call(ctx, betaAdmin.cookie, 'POST', `/agency/submissions/${sub.id}/resume-url`)).statusCode).toBe(404);
    // Alpha's recruiter did not submit it, so only Alpha's admin may fetch it.
    expect((await call(ctx, alphaRec.cookie, 'POST', `/agency/submissions/${sub.id}/resume-url`)).statusCode).toBe(404);
    expect((await call(ctx, alphaAdmin.cookie, 'POST', `/agency/submissions/${sub.id}/resume-url`)).statusCode).toBe(200);
  });
});
