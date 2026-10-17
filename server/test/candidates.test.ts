import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signFileToken } from '../src/storage.js';
import { normalizePhone } from '../src/phone.js';
import { addUser, call, login, setupApp, type TestContext } from './helpers.js';
import { approvedRequisition, openVacancy, PDF, setupCompany, uploadDocument } from './hiring-helpers.js';

let ctx: TestContext;
let s: Awaited<ReturnType<typeof setupCompany>>;
let admin: string;
let recruiter: string;
let engManager: string;
let hr: string;

const person = (n: string, extra: Record<string, unknown> = {}) => ({
  full_name: `Candidate ${n}`,
  email: `${n.toLowerCase().replace(/\s/g, '.')}@mail.test`,
  phone: null,
  city: 'Pune',
  skills: ['Node.js'],
  ...extra,
});
const create = (cookie: string, body: Record<string, unknown>) => call(ctx, cookie, 'POST', '/candidates', body);

beforeAll(async () => {
  ctx = await setupApp();
  s = await setupCompany(ctx, 'cand');
  [admin, recruiter, engManager, hr] = await Promise.all([s.as('admin'), s.as('recruiter'), s.as('engManager'), s.as('hr1')]);
});
afterAll(() => ctx.close());

describe('phone normalization', () => {
  it('normalizes to E.164 and defaults bare Indian numbers to +91', () => {
    expect(normalizePhone('98765 43210')).toBe('+919876543210');
    expect(normalizePhone('09876543210')).toBe('+919876543210');
    expect(normalizePhone('+91 98765-43210')).toBe('+919876543210');
    expect(normalizePhone('919876543210')).toBe('+919876543210');
    expect(normalizePhone('+1 (415) 555-0100')).toBe('+14155550100');
    expect(normalizePhone('12345')).toBeNull();
    expect(normalizePhone('abc')).toBeNull();
  });
});

describe('creating and editing candidates', () => {
  it('creates a candidate and stores the phone normalized', async () => {
    const res = await create(recruiter, person('Asha Rao', { phone: '98765 43210', total_experience_years: 5 }));
    expect(res.statusCode).toBe(201);
    expect(res.json().data).toMatchObject({ full_name: 'Candidate Asha Rao', phone: '+919876543210', status: 'active' });
    expect(res.json().data.can).toMatchObject({ edit: true, view_contact: true, view_compensation: false });
  });

  it('needs an email or phone, and a valid phone', async () => {
    const none = await create(recruiter, { full_name: 'No Contact' });
    expect(none.statusCode).toBe(400);
    const badPhone = await create(recruiter, person('Bad Phone', { phone: '12345' }));
    expect(badPhone.statusCode).toBe(400);
    expect(badPhone.json().error.details[0].path).toBe('phone');
  });

  it('only people who can see compensation can set it', async () => {
    const denied = await create(recruiter, person('Ctc Denied', { current_ctc: 100 }));
    expect(denied.statusCode).toBe(403);
    const ok = await create(hr, person('Ctc Allowed', { current_ctc: 1_200_000, expected_ctc: 1_800_000 }));
    expect(ok.statusCode).toBe(201);
  });

  it('a hiring manager cannot create candidates', async () => {
    expect((await create(engManager, person('Manager Made'))).statusCode).toBe(403);
  });

  it('edits fields, keeping at least one way to contact', async () => {
    const c = (await create(recruiter, person('Edit Me'))).json().data;
    const res = await call(ctx, recruiter, 'PATCH', `/candidates/${c.id}`, { current_title: 'Staff Engineer', skills: ['Go', 'Kafka'] });
    expect(res.json().data).toMatchObject({ current_title: 'Staff Engineer', skills: ['Go', 'Kafka'] });
    // Fields that were not sent stay as they were.
    expect(res.json().data).toMatchObject({ email: 'edit.me@mail.test', city: 'Pune' });
    const titleOnly = await call(ctx, recruiter, 'PATCH', `/candidates/${c.id}`, { city: 'Mumbai' });
    expect(titleOnly.json().data).toMatchObject({ current_title: 'Staff Engineer', skills: ['Go', 'Kafka'], city: 'Mumbai' });
    const stripped = await call(ctx, recruiter, 'PATCH', `/candidates/${c.id}`, { email: null });
    expect(stripped.statusCode).toBe(422);
    expect(stripped.json().error.code).toBe('CONTACT_REQUIRED');
  });
});

describe('duplicates', () => {
  it('blocks the same email, even with different case, and reports the match', async () => {
    await create(recruiter, person('Dup Email', { email: 'dup.email@mail.test' }));
    const res = await create(recruiter, person('Someone Else', { email: 'DUP.Email@mail.test' }));
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('DUPLICATE_CANDIDATE');
    expect(res.json().error.details.exact[0]).toMatchObject({ full_name: 'Candidate Dup Email', match_reason: 'same_email' });
  });

  it('blocks the same phone written in a different format', async () => {
    await create(recruiter, person('Dup Phone', { phone: '99887 76655', email: null }));
    const res = await create(recruiter, person('Phone Twin', { phone: '+91-9988776655', email: null }));
    expect(res.statusCode).toBe(409);
    expect(res.json().error.details.exact[0].match_reason).toBe('same_phone');
  });

  it('only warns for a similar name, and never merges silently', async () => {
    await create(recruiter, person('Priyanka Sharma', { full_name: 'Priyanka Sharma' }));
    const check = await call(ctx, recruiter, 'POST', '/candidates/duplicate-check', { full_name: 'Priyanka Sharmaa' });
    expect(check.json().data.exact).toHaveLength(0);
    expect(check.json().data.possible[0]).toMatchObject({ full_name: 'Priyanka Sharma', match_reason: 'similar_name' });
    const res = await create(recruiter, person('Priyanka Sharmaa', { full_name: 'Priyanka Sharmaa' }));
    expect(res.statusCode).toBe(201);
    const audit = await ctx.adminDb.selectFrom('audit_events').select('metadata').where('entity_id', '=', res.json().data.id).where('action', '=', 'candidate.created').executeTakeFirstOrThrow();
    expect((audit.metadata as { possible_duplicates: string[] }).possible_duplicates).toHaveLength(1);
  });

  it('does not let an edit collide with another candidate', async () => {
    await create(recruiter, person('Taken Email', { email: 'taken@mail.test' }));
    const other = (await create(recruiter, person('Wants It'))).json().data;
    const res = await call(ctx, recruiter, 'PATCH', `/candidates/${other.id}`, { email: 'taken@mail.test' });
    expect(res.statusCode).toBe(409);
  });
});

describe('search', () => {
  beforeAll(async () => {
    await create(admin, person('Search Alpha', { full_name: 'Zebulon Quirk', city: 'Chennai', skills: ['Rust', 'Kafka'], total_experience_years: 9, notice_period_days: 30, phone: '90000 11111' }));
    await create(admin, person('Search Beta', { full_name: 'Yolanda Quirk', city: 'Pune', skills: ['Rust'], total_experience_years: 2, notice_period_days: 90 }));
  });

  const search = async (cookie: string, query: string) =>
    (await call(ctx, cookie, 'GET', `/candidates?${query}`)).json() as { data: { full_name: string }[]; total: number };

  it('finds by name, skill, city, experience and notice period', async () => {
    expect((await search(recruiter, 'q=quirk')).data.map((c) => c.full_name).sort()).toEqual(['Yolanda Quirk', 'Zebulon Quirk']);
    expect((await search(recruiter, 'q=quirk&skills=rust,kafka')).data.map((c) => c.full_name)).toEqual(['Zebulon Quirk']);
    expect((await search(recruiter, 'q=quirk&city=chennai')).data.map((c) => c.full_name)).toEqual(['Zebulon Quirk']);
    expect((await search(recruiter, 'q=quirk&min_experience=5')).data.map((c) => c.full_name)).toEqual(['Zebulon Quirk']);
    expect((await search(recruiter, 'q=quirk&max_experience=5')).data.map((c) => c.full_name)).toEqual(['Yolanda Quirk']);
    expect((await search(recruiter, 'q=quirk&max_notice_days=60')).data.map((c) => c.full_name)).toEqual(['Zebulon Quirk']);
  });

  it('finds by email and by phone in any format, for people who may see contact details', async () => {
    expect((await search(recruiter, 'q=search.alpha@mail')).total).toBe(1);
    expect((await search(recruiter, `q=${encodeURIComponent('+91 90000-11111')}`)).data.map((c) => c.full_name)).toEqual(['Zebulon Quirk']);
  });

  it('treats % and _ in a search as plain text', async () => {
    expect((await search(recruiter, 'q=%25')).total).toBe(0);
  });

  it('paginates', async () => {
    const page = await search(recruiter, 'page_size=2&page=1');
    expect(page.data).toHaveLength(2);
    expect(page.total).toBeGreaterThan(2);
  });
});

describe('who sees what', () => {
  let candidateId: string;
  beforeAll(async () => {
    const c = (await create(hr, person('Private Person', { phone: '91111 22222', current_ctc: 900_000, expected_ctc: 1_100_000 }))).json().data;
    candidateId = c.id;
    // Link to an Engineering vacancy so the Engineering manager may see the profile.
    const rq = await approvedRequisition(ctx, s);
    const v = await openVacancy(ctx, admin, rq);
    await call(ctx, admin, 'POST', '/applications', { candidate_id: candidateId, vacancy_id: v.id });
  });

  it('removes contact and compensation from payloads, not just the UI', async () => {
    const full = (await call(ctx, hr, 'GET', `/candidates/${candidateId}`)).json().data;
    expect(full).toMatchObject({ email: 'private.person@mail.test', phone: '+919111122222', current_ctc: 900_000 });

    const recruiterView = (await call(ctx, recruiter, 'GET', `/candidates/${candidateId}`)).json().data;
    expect(recruiterView.email).toBe('private.person@mail.test');
    expect(recruiterView).not.toHaveProperty('current_ctc');
    expect(recruiterView).not.toHaveProperty('expected_ctc');

    const manager = await call(ctx, engManager, 'GET', `/candidates/${candidateId}`);
    expect(manager.statusCode).toBe(200);
    const body = manager.json().data;
    for (const key of ['email', 'phone', 'current_ctc', 'expected_ctc']) expect(body).not.toHaveProperty(key);
    expect(manager.body).not.toContain('private.person@mail.test');
    expect(manager.body).not.toContain('9111122222');
  });

  it('list responses are redacted the same way', async () => {
    const res = await call(ctx, engManager, 'GET', '/candidates?q=private');
    expect(res.json().total).toBe(1);
    expect(res.body).not.toContain('private.person@mail.test');
    expect(res.body).not.toContain('current_ctc');
  });

  it('a department manager cannot find people by contact details they may not see', async () => {
    // Every test email shares this domain; it matches no names, titles or skills.
    expect((await call(ctx, engManager, 'GET', '/candidates?q=mail.test')).json().total).toBe(0);
    expect((await call(ctx, recruiter, 'GET', '/candidates?q=mail.test')).json().total).toBeGreaterThan(0);
  });

  it('a department manager only sees candidates linked to their department', async () => {
    const stranger = (await create(hr, person('Unlinked Stranger'))).json().data;
    expect((await call(ctx, engManager, 'GET', `/candidates/${stranger.id}`)).statusCode).toBe(404);
    expect((await call(ctx, await s.as('salesManager'), 'GET', `/candidates/${candidateId}`)).statusCode).toBe(404);
  });

  it('a role with no hiring permissions gets nothing', async () => {
    await addUser(ctx, s.co.tenant.id, { email: `interviewer@${s.co.slug}.test`, role: 'interviewer' });
    const cookie = await login(ctx, s.co.slug, `interviewer@${s.co.slug}.test`);
    expect((await call(ctx, cookie, 'GET', '/candidates')).statusCode).toBe(403);
    expect((await call(ctx, cookie, 'GET', `/candidates/${candidateId}`)).statusCode).toBe(403);
    expect((await call(ctx, cookie, 'GET', '/vacancies')).json().total).toBe(0);
    expect((await call(ctx, cookie, 'GET', '/requisitions')).json().total).toBe(0);
  });
});

describe('notes', () => {
  it('adds notes with the author, newest first, and validates the application link', async () => {
    const c = (await create(recruiter, person('Noted Person'))).json().data;
    const n1 = await call(ctx, recruiter, 'POST', `/candidates/${c.id}/notes`, { body: 'Strong on systems design.' });
    expect(n1.statusCode).toBe(201);
    await call(ctx, recruiter, 'POST', `/candidates/${c.id}/notes`, { body: 'Available from next month.' });
    const profile = (await call(ctx, recruiter, 'GET', `/candidates/${c.id}`)).json().data;
    expect(profile.notes.map((n: { body: string }) => n.body)).toEqual(['Available from next month.', 'Strong on systems design.']);
    expect(profile.notes[0].created_by_name).toBe('rec');
    const bad = await call(ctx, recruiter, 'POST', `/candidates/${c.id}/notes`, { body: 'x', application_id: '00000000-0000-4000-8000-000000000000' });
    expect(bad.statusCode).toBe(422);
  });
});

describe('resumes', () => {
  let candidateId: string;
  beforeAll(async () => {
    candidateId = (await create(recruiter, person('Resume Holder'))).json().data.id;
  });

  it('accepts a PDF, records its hash, and stores it privately under the tenant', async () => {
    const res = await uploadDocument(ctx, recruiter, candidateId, 'My CV (final).pdf', PDF('ok'));
    expect(res.statusCode).toBe(201);
    expect(res.json().data).toMatchObject({ document_type: 'resume', mime_type: 'application/pdf', scan_status: 'clean', original_filename: 'My CV (final).pdf' });
    const row = await ctx.adminDb.selectFrom('candidate_documents').selectAll().where('id', '=', res.json().data.id).executeTakeFirstOrThrow();
    expect(row.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(row.storage_key.startsWith(`${s.co.tenant.id}/candidates/${candidateId}/`)).toBe(true);
    expect(ctx.storage.files.has(row.storage_key)).toBe(true);
    // The storage key is never in API responses.
    const profile = await call(ctx, recruiter, 'GET', `/candidates/${candidateId}`);
    expect(profile.body).not.toContain(row.storage_key);
  });

  it('checks file content, not just the extension', async () => {
    const wrongContent = await uploadDocument(ctx, recruiter, candidateId, 'resume.pdf', Buffer.from('MZ\x90\x00 this is an executable'));
    expect(wrongContent.statusCode).toBe(415);
    const wrongExt = await uploadDocument(ctx, recruiter, candidateId, 'resume.exe', PDF());
    expect(wrongExt.statusCode).toBe(415);
    const docx = await uploadDocument(ctx, recruiter, candidateId, 'resume.docx', Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('word/document.xml')]));
    expect(docx.statusCode).toBe(201);
  });

  it('rejects files that fail the malware scan and stores nothing', async () => {
    const before = ctx.storage.files.size;
    const eicar = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';
    const res = await uploadDocument(ctx, recruiter, candidateId, 'evil.pdf', Buffer.concat([PDF(), Buffer.from(eicar)]));
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('FILE_REJECTED');
    expect(ctx.storage.files.size).toBe(before);
  });

  it('enforces the tenant size limit', async () => {
    await ctx.adminDb.updateTable('tenant_settings').set({ resume_max_bytes: 200 }).where('tenant_id', '=', s.co.tenant.id).execute();
    const res = await uploadDocument(ctx, recruiter, candidateId, 'big.pdf', Buffer.concat([PDF(), Buffer.alloc(500, 0x20)]));
    expect(res.statusCode).toBe(413);
    expect(res.json().error.code).toBe('FILE_TOO_LARGE');
    await ctx.adminDb.updateTable('tenant_settings').set({ resume_max_bytes: 10 * 1024 * 1024 }).where('tenant_id', '=', s.co.tenant.id).execute();
  });

  it('issues short-lived signed links that work without a session', async () => {
    const doc = (await uploadDocument(ctx, recruiter, candidateId, 'linked.pdf', PDF('link'))).json().data;
    const issued = await call(ctx, recruiter, 'POST', `/candidates/${candidateId}/documents/${doc.id}/download-url`);
    expect(issued.statusCode).toBe(200);
    const { url, expires_at } = issued.json().data;
    expect(url).toMatch(/^\/api\/v1\/files\//);
    expect(new Date(expires_at).getTime()).toBeGreaterThan(Date.now());

    const file = await ctx.app.inject({ method: 'GET', url });
    expect(file.statusCode).toBe(200);
    expect(file.rawPayload.toString()).toContain('%PDF-1.4');
    expect(file.headers['content-type']).toBe('application/pdf');
    expect(file.headers['content-disposition']).toContain('attachment');
    expect(file.headers['x-content-type-options']).toBe('nosniff');
  });

  it('rejects expired, tampered and forged links', async () => {
    const doc = (await uploadDocument(ctx, recruiter, candidateId, 'secret.pdf', PDF('x'))).json().data;
    const secret = ctx.app.config.FILE_URL_SECRET;
    const expired = signFileToken(secret, { t: s.co.tenant.id, d: doc.id, e: Math.floor(Date.now() / 1000) - 5 });
    expect((await ctx.app.inject({ method: 'GET', url: `/api/v1/files/${expired}` })).statusCode).toBe(410);

    const valid = signFileToken(secret, { t: s.co.tenant.id, d: doc.id, e: Math.floor(Date.now() / 1000) + 60 });
    const [payload, sig] = valid.split('.');
    const swapped = Buffer.from(JSON.stringify({ t: s.co.tenant.id, d: doc.id, e: 99999999999 })).toString('base64url');
    expect((await ctx.app.inject({ method: 'GET', url: `/api/v1/files/${swapped}.${sig}` })).statusCode).toBe(410);
    expect((await ctx.app.inject({ method: 'GET', url: `/api/v1/files/${payload}.AAAA` })).statusCode).toBe(410);
    const forged = signFileToken('some-other-secret-value-1234', { t: s.co.tenant.id, d: doc.id, e: Math.floor(Date.now() / 1000) + 60 });
    expect((await ctx.app.inject({ method: 'GET', url: `/api/v1/files/${forged}` })).statusCode).toBe(410);
  });

  it('refuses links for documents that are not clean', async () => {
    const doc = (await uploadDocument(ctx, recruiter, candidateId, 'pending.pdf', PDF('p'))).json().data;
    await ctx.adminDb.updateTable('candidate_documents').set({ scan_status: 'pending' }).where('id', '=', doc.id).execute();
    const issued = await call(ctx, recruiter, 'POST', `/candidates/${candidateId}/documents/${doc.id}/download-url`);
    expect(issued.statusCode).toBe(409);
    const token = signFileToken(ctx.app.config.FILE_URL_SECRET, { t: s.co.tenant.id, d: doc.id, e: Math.floor(Date.now() / 1000) + 60 });
    expect((await ctx.app.inject({ method: 'GET', url: `/api/v1/files/${token}` })).statusCode).toBe(410);
  });

  it('audits uploads and link issuing', async () => {
    const actions = (await ctx.adminDb.selectFrom('audit_events').select('action').where('entity_id', '=', candidateId).execute()).map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['candidate.document_uploaded', 'candidate.document_rejected', 'candidate.document_link_issued']));
  });
});

describe('merging', () => {
  it('moves applications and documents, fills gaps, keeps the source with a snapshot', async () => {
    const target = (await create(recruiter, person('Merge Target', { city: null, phone: null }))).json().data;
    const source = (await create(recruiter, person('Merge Source', { full_name: 'Merge Target', phone: '97000 12345', city: 'Mumbai', skills: ['Java'] }))).json().data;
    const v = await openVacancy(ctx, admin, await approvedRequisition(ctx, s));
    await call(ctx, admin, 'POST', '/applications', { candidate_id: source.id, vacancy_id: v.id });
    await uploadDocument(ctx, recruiter, source.id, 'old.pdf', PDF('old'));

    // Admin merges and views the result: a recruiter only sees applications to vacancies assigned to them.
    const merged = await call(ctx, admin, 'POST', `/candidates/${target.id}/merge`, { source_candidate_id: source.id, reason: 'Same person, two profiles' });
    expect(merged.statusCode).toBe(200);
    const profile = merged.json().data;
    expect(profile).toMatchObject({ city: 'Mumbai', phone: '+919700012345', full_name: 'Candidate Merge Target' });
    expect(profile.skills.sort()).toEqual(['Java', 'Node.js']);
    expect(profile.applications).toHaveLength(1);
    expect(profile.documents).toHaveLength(1);

    const old = await ctx.adminDb.selectFrom('candidates').select(['status', 'merged_into_candidate_id']).where('id', '=', source.id).executeTakeFirstOrThrow();
    expect(old).toMatchObject({ status: 'merged', merged_into_candidate_id: target.id });
    const history = await ctx.adminDb.selectFrom('candidate_merges').selectAll().where('target_candidate_id', '=', target.id).execute();
    expect(history).toHaveLength(1);
    expect((history[0]!.source_snapshot as { email: string }).email).toBe('merge.source@mail.test');

    // The merged profile drops out of search, and cannot be merged or edited again.
    expect((await call(ctx, recruiter, 'GET', '/candidates?q=merge.source')).json().total).toBe(0);
    expect((await call(ctx, recruiter, 'PATCH', `/candidates/${source.id}`, { city: 'X' })).statusCode).toBe(409);
    expect((await call(ctx, recruiter, 'POST', `/candidates/${target.id}/merge`, { source_candidate_id: source.id, reason: 'again' })).statusCode).toBe(409);
  });

  it('refuses when both have an active application to the same vacancy', async () => {
    const a = (await create(recruiter, person('Conflict A'))).json().data;
    const b = (await create(recruiter, person('Conflict B'))).json().data;
    const v = await openVacancy(ctx, admin, await approvedRequisition(ctx, s));
    for (const c of [a, b]) await call(ctx, admin, 'POST', '/applications', { candidate_id: c.id, vacancy_id: v.id });
    const res = await call(ctx, recruiter, 'POST', `/candidates/${a.id}/merge`, { source_candidate_id: b.id, reason: 'Dup' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('MERGE_CONFLICT');
  });

  it('refuses to merge a candidate into itself, and needs a reason', async () => {
    const a = (await create(recruiter, person('Solo Merge'))).json().data;
    expect((await call(ctx, recruiter, 'POST', `/candidates/${a.id}/merge`, { source_candidate_id: a.id, reason: 'x' })).statusCode).toBe(422);
    expect((await call(ctx, recruiter, 'POST', `/candidates/${a.id}/merge`, { source_candidate_id: a.id })).statusCode).toBe(400);
  });
});
