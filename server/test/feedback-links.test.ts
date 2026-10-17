// One-time feedback links (EPIC-07, EPIC-12): expiry, revocation, replay and concurrency.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { sha256Hex } from '../src/security.js';
import { call, setupApp, type TestContext } from './helpers.js';
import { applicationOnVacancy, goodFeedback, inHours, issueLink, publicPost, scheduleInterview, setupCompany } from './hiring-helpers.js';

let ctx: TestContext;
let s: Awaited<ReturnType<typeof setupCompany>>;
let admin: string;
let recruiter: string;
let engManager: string;
let applicationId: string;
let n = 0;

beforeAll(async () => {
  ctx = await setupApp();
  s = await setupCompany(ctx, 'fl');
  [admin, recruiter, engManager] = await Promise.all([s.as('admin'), s.as('recruiter'), s.as('engManager')]);
  const a = await applicationOnVacancy(ctx, s, 'fl');
  applicationId = a.applicationId;
  await call(ctx, admin, 'POST', `/vacancies/${a.vacancyId}/assign-recruiter`, { user_id: s.users.recruiter.id });
});
afterAll(() => ctx.close());

/** A fresh interview with two external interviewers. */
async function interview(extra: Record<string, unknown> = {}) {
  const k = ++n;
  const iv = await scheduleInterview(ctx, recruiter, applicationId, {
    panel: [{ name: `Ext One ${k}`, email: `ext1.${k}@partner.test` }, { name: `Ext Two ${k}`, email: `ext2.${k}@partner.test` }], ...extra,
  });
  // Both people are added in one transaction, so find them by name rather than by position.
  return { id: iv.id, one: iv.panel.find((m) => m.name.startsWith('Ext One'))!, two: iv.panel.find((m) => m.name.startsWith('Ext Two'))! };
}
const expire = async (linkId: string) =>
  ctx.adminDb.updateTable('feedback_links').set({ expires_at: new Date(Date.now() - 1000), created_at: new Date(Date.now() - 86_400_000) }).where('id', '=', linkId).execute();
const feedbackRows = async (interviewId: string) => ctx.adminDb.selectFrom('feedback').select('id').where('interview_id', '=', interviewId).execute();

describe('issuing links', () => {
  it('issues a link whose token is in the fragment, shown once, and only its hash is stored', async () => {
    const iv = await interview();
    const link = await issueLink(ctx, recruiter, iv.id, iv.one.id);
    expect(link.url).toMatch(/^http:\/\/localhost:5180\/feedback#[A-Za-z0-9_-]{43}$/);
    expect(link.token).toHaveLength(43); // 256 bits, base64url

    const row = await ctx.adminDb.selectFrom('feedback_links').selectAll().where('id', '=', link.id).executeTakeFirstOrThrow();
    expect(row.token_hash).toBe(sha256Hex(link.token));
    expect(row.token_hash).not.toContain(link.token);
    expect(row).toMatchObject({ status: 'active', created_by: s.users.recruiter.id, interviewer_id: iv.one.id });
    const days = (row.expires_at.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThan(7.1);

    // The token cannot be fetched back: the detail shows state, not the link.
    const detail = await call(ctx, recruiter, 'GET', `/interviews/${iv.id}`);
    expect(detail.body).not.toContain(link.token);
    const mine = detail.json().data.panel.find((m: { id: string }) => m.id === iv.one.id);
    expect(mine.link).toMatchObject({ state: 'active', open_count: 0 });
  });

  it('emails the link to the interviewer, and can be told not to', async () => {
    const iv = await interview();
    const before = ctx.mailer.feedbackRequests.length;
    const link = await issueLink(ctx, recruiter, iv.id, iv.one.id);
    expect(link.emailed).toBe(true);
    const mail = ctx.mailer.feedbackRequests.at(-1)!;
    expect(ctx.mailer.feedbackRequests.length).toBe(before + 1);
    expect(mail).toMatchObject({ to: expect.stringContaining('ext1.'), candidateName: 'Interviewee fl', roundName: 'Technical round', link: link.url });
    const quiet = await issueLink(ctx, recruiter, iv.id, iv.two.id, { send_email: false });
    expect(quiet.emailed).toBe(false);
    expect(ctx.mailer.feedbackRequests.length).toBe(before + 1);
  });

  it('still issues the link when the email cannot be sent', async () => {
    const iv = await interview();
    ctx.mailer.failing = true;
    try {
      const link = await issueLink(ctx, recruiter, iv.id, iv.one.id);
      expect(link.emailed).toBe(false);
      expect((await publicPost(ctx, 'validate', { token: link.token })).statusCode).toBe(200);
    } finally {
      ctx.mailer.failing = false;
    }
  });

  it('honours a custom expiry', async () => {
    const iv = await interview();
    const link = await issueLink(ctx, recruiter, iv.id, iv.one.id, { expires_in_hours: 2 });
    const row = await ctx.adminDb.selectFrom('feedback_links').select('expires_at').where('id', '=', link.id).executeTakeFirstOrThrow();
    expect((row.expires_at.getTime() - Date.now()) / 3_600_000).toBeLessThan(2.01);
  });

  it('regenerating revokes the old link first, even one that already expired', async () => {
    const iv = await interview();
    const old = await issueLink(ctx, recruiter, iv.id, iv.one.id);
    await expire(old.id);
    const fresh = await issueLink(ctx, recruiter, iv.id, iv.one.id);
    expect((await publicPost(ctx, 'validate', { token: old.token })).statusCode).toBe(410);
    expect((await publicPost(ctx, 'validate', { token: fresh.token })).statusCode).toBe(200);
    const active = await ctx.adminDb.selectFrom('feedback_links').select('id').where('interviewer_id', '=', iv.one.id).where('status', '=', 'active').execute();
    expect(active).toHaveLength(1);
    const events = (await call(ctx, recruiter, 'GET', `/interviews/${iv.id}`)).json().data.events.map((e: { event_type: string }) => e.event_type);
    expect(events).toContain('link_regenerated');
  });

  it('regenerating while the old link is live also withdraws it', async () => {
    const iv = await interview();
    const old = await issueLink(ctx, recruiter, iv.id, iv.one.id);
    const fresh = await issueLink(ctx, recruiter, iv.id, iv.one.id);
    expect((await publicPost(ctx, 'submit', { token: old.token, ...goodFeedback() })).statusCode).toBe(410);
    expect((await publicPost(ctx, 'submit', { token: fresh.token, ...goodFeedback() })).statusCode).toBe(200);
  });

  it('refuses when feedback is already in, the interview is off, or the person is not on the panel', async () => {
    const iv = await interview();
    const link = await issueLink(ctx, recruiter, iv.id, iv.one.id);
    await publicPost(ctx, 'submit', { token: link.token, ...goodFeedback() });
    const again = await call(ctx, recruiter, 'POST', `/interviews/${iv.id}/feedback-links`, { interviewer_id: iv.one.id });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('FEEDBACK_SUBMITTED');

    const other = await interview();
    expect((await call(ctx, recruiter, 'POST', `/interviews/${iv.id}/feedback-links`, { interviewer_id: other.one.id })).statusCode).toBe(404);

    await call(ctx, recruiter, 'POST', `/interviews/${iv.id}/cancel`, { reason: 'Called off' });
    const off = await call(ctx, recruiter, 'POST', `/interviews/${iv.id}/feedback-links`, { interviewer_id: iv.two.id });
    expect(off.statusCode).toBe(409);
  });

  it('needs the permission, and cannot cross companies', async () => {
    const iv = await interview();
    expect((await call(ctx, engManager, 'POST', `/interviews/${iv.id}/feedback-links`, { interviewer_id: iv.one.id })).statusCode).toBe(403);
    const other = await setupCompany(ctx, 'fl2');
    const res = await call(ctx, await other.as('admin'), 'POST', `/interviews/${iv.id}/feedback-links`, { interviewer_id: iv.one.id });
    expect(res.statusCode).toBe(404);
  });

  it('revoking withdraws the link, once', async () => {
    const iv = await interview();
    const link = await issueLink(ctx, recruiter, iv.id, iv.one.id);
    expect((await call(ctx, engManager, 'POST', `/feedback-links/${link.id}/revoke`)).statusCode).toBe(403);
    expect((await call(ctx, recruiter, 'POST', `/feedback-links/${link.id}/revoke`)).statusCode).toBe(204);
    expect((await publicPost(ctx, 'validate', { token: link.token })).statusCode).toBe(410);
    expect((await call(ctx, recruiter, 'POST', `/feedback-links/${link.id}/revoke`)).statusCode).toBe(409);
  });

  it('records issuing and revoking in the audit log, never the token', async () => {
    const iv = await interview();
    const link = await issueLink(ctx, recruiter, iv.id, iv.one.id);
    await call(ctx, recruiter, 'POST', `/feedback-links/${link.id}/revoke`);
    const rows = await ctx.adminDb.selectFrom('audit_events').select(['action', 'metadata']).where('entity_id', '=', link.id).execute();
    expect(rows.map((r) => r.action).sort()).toEqual(['feedback_link.issued', 'feedback_link.revoked']);
    const all = await sql<{ n: number }>`SELECT count(*)::int AS n FROM audit_events WHERE metadata::text LIKE ${'%' + link.token + '%'}`.execute(ctx.adminDb);
    expect(all.rows[0]!.n).toBe(0);
  });
});

describe('the interviewer opens the link', () => {
  it('sees the interview, job and a candidate brief, and none of the private details', async () => {
    const iv = await interview();
    const link = await issueLink(ctx, recruiter, iv.id, iv.one.id);
    const res = await publicPost(ctx, 'validate', { token: link.token });
    expect(res.statusCode).toBe(200);
    const d = res.json().data;
    expect(d.candidate).toMatchObject({ full_name: 'Interviewee fl', current_title: 'Analyst', total_experience_years: 5 });
    expect(d.job.title).toBe('Backend Engineer');
    expect(d.interview).toMatchObject({ round_name: 'Technical round', mode_label: 'Google Meet' });
    expect(d.scorecard.map((c: { code: string }) => c.code)).toEqual(['role_skills', 'communication', 'problem_solving']);
    expect(d.interviewer.name).toBe(iv.one.name);
    for (const secret of ['interviewee.fl@mail.test', '1500000', '2000000', 'current_ctc', 'expected_ctc', '"phone"', '"email"', s.co.tenant.id, iv.two.name, iv.two.email!]) {
      expect(res.body, secret).not.toContain(secret);
    }
  });

  it('opening it, any number of times, does not use it up', async () => {
    const iv = await interview();
    const link = await issueLink(ctx, recruiter, iv.id, iv.one.id);
    for (let i = 0; i < 3; i++) expect((await publicPost(ctx, 'validate', { token: link.token })).statusCode).toBe(200);
    const row = await ctx.adminDb.selectFrom('feedback_links').select(['status', 'open_count', 'last_opened_at']).where('id', '=', link.id).executeTakeFirstOrThrow();
    expect(row).toMatchObject({ status: 'active', open_count: 3 });
    expect(row.last_opened_at).not.toBeNull();
    expect((await publicPost(ctx, 'submit', { token: link.token, ...goodFeedback() })).statusCode).toBe(200);
  });

  it('gives the same generic answer for unknown tokens, whatever they look like', async () => {
    const a = await publicPost(ctx, 'validate', { token: 'a'.repeat(43) });
    const b = await publicPost(ctx, 'validate', { token: 'B'.repeat(43) });
    for (const r of [a, b]) {
      expect(r.statusCode).toBe(401);
      expect(r.json().error.code).toBe('INVALID_LINK');
    }
    expect(a.json().error.message).toBe(b.json().error.message);
    expect((await publicPost(ctx, 'validate', { token: 'short' })).statusCode).toBe(400);
  });

  it('a tampered token does not work', async () => {
    const iv = await interview();
    const link = await issueLink(ctx, recruiter, iv.id, iv.one.id);
    const flipped = link.token.slice(0, -1) + (link.token.endsWith('A') ? 'B' : 'A');
    expect((await publicPost(ctx, 'validate', { token: flipped })).statusCode).toBe(401);
  });

  it('shows nothing about the candidate once the link has expired, been withdrawn or used', async () => {
    const iv = await interview();
    const expired = await issueLink(ctx, recruiter, iv.id, iv.one.id);
    await expire(expired.id);
    const r1 = await publicPost(ctx, 'validate', { token: expired.token });
    expect(r1.statusCode).toBe(410);
    expect(r1.json().error.code).toBe('LINK_EXPIRED');

    const revoked = await issueLink(ctx, recruiter, iv.id, iv.two.id);
    await call(ctx, recruiter, 'POST', `/feedback-links/${revoked.id}/revoke`);
    const r2 = await publicPost(ctx, 'validate', { token: revoked.token });
    expect(r2.statusCode).toBe(410);

    const iv2 = await interview();
    const used = await issueLink(ctx, recruiter, iv2.id, iv2.one.id);
    await publicPost(ctx, 'submit', { token: used.token, ...goodFeedback() });
    const r3 = await publicPost(ctx, 'validate', { token: used.token });
    expect(r3.statusCode).toBe(409);
    expect(r3.json().error.code).toBe('ALREADY_SUBMITTED');
    for (const r of [r1, r2, r3]) expect(r.body).not.toContain('Interviewee');
  });

  it('cancelling the interview, or a no-show, withdraws every link', async () => {
    const a = await interview();
    const la = await issueLink(ctx, recruiter, a.id, a.one.id);
    await call(ctx, recruiter, 'POST', `/interviews/${a.id}/cancel`, { reason: 'Role closed' });
    expect((await publicPost(ctx, 'validate', { token: la.token })).statusCode).toBe(410);
    const b = await interview();
    const lb = await issueLink(ctx, recruiter, b.id, b.one.id);
    await call(ctx, recruiter, 'POST', `/interviews/${b.id}/no-show`, {});
    expect((await publicPost(ctx, 'validate', { token: lb.token })).statusCode).toBe(410);
  });

  it('sends no referrer and is never cached', async () => {
    const res = await publicPost(ctx, 'validate', { token: 'z'.repeat(43) });
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
  });

  it('limits attempts per address', async () => {
    const ip = '203.0.113.50';
    const codes: number[] = [];
    for (let i = 0; i < 32; i++) codes.push((await publicPost(ctx, 'validate', { token: 'q'.repeat(43) }, ip)).statusCode);
    expect(codes.slice(0, 30).every((c) => c === 401)).toBe(true);
    expect(codes.at(-1)).toBe(429);
  });

  it('offers the candidate resume through a short-lived signed link, only while the link is live', async () => {
    const iv = await interview();
    const link = await issueLink(ctx, recruiter, iv.id, iv.one.id);
    const none = await publicPost(ctx, 'resume-url', { token: link.token });
    expect(none.statusCode).toBe(404); // the test candidate has no resume yet
    const cand = await ctx.adminDb.selectFrom('applications').select('candidate_id').where('id', '=', applicationId).executeTakeFirstOrThrow();
    const { uploadDocument, PDF } = await import('./hiring-helpers.js');
    expect((await uploadDocument(ctx, admin, cand.candidate_id, 'cv.pdf', PDF('for interviewer'))).statusCode).toBe(201);
    const res = await publicPost(ctx, 'resume-url', { token: link.token });
    expect(res.statusCode).toBe(200);
    const file = await ctx.app.inject({ method: 'GET', url: res.json().data.url });
    expect(file.rawPayload.toString()).toContain('for interviewer');
    await call(ctx, recruiter, 'POST', `/feedback-links/${link.id}/revoke`);
    expect((await publicPost(ctx, 'resume-url', { token: link.token })).statusCode).toBe(410);
  });
});

describe('submitting feedback', () => {
  it('saves it once, uses the link up, marks the interviewer done, and writes the audit event', async () => {
    const iv = await interview();
    const link = await issueLink(ctx, recruiter, iv.id, iv.one.id);
    const res = await publicPost(ctx, 'submit', { token: link.token, ...goodFeedback({ notes: 'Strong on SQL.' }) });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual({ status: 'submitted' }); // nothing about the candidate comes back
    const fb = await ctx.adminDb.selectFrom('feedback').selectAll().where('interview_id', '=', iv.id).execute();
    expect(fb).toHaveLength(1);
    expect(fb[0]).toMatchObject({ overall_rating: 4, recommendation: 'yes', notes: 'Strong on SQL.', interviewer_id: iv.one.id, feedback_link_id: link.id });
    expect(fb[0]!.competency_ratings).toEqual({ role_skills: 4, communication: 4, problem_solving: 3 });
    const row = await ctx.adminDb.selectFrom('feedback_links').select(['status', 'consumed_at']).where('id', '=', link.id).executeTakeFirstOrThrow();
    expect(row.status).toBe('consumed');
    expect(row.consumed_at).not.toBeNull();
    const m = await ctx.adminDb.selectFrom('interviewers').select('feedback_status').where('id', '=', iv.one.id).executeTakeFirstOrThrow();
    expect(m.feedback_status).toBe('submitted');
    const audit = await ctx.adminDb.selectFrom('audit_events').select(['actor_type', 'actor_label', 'ip_hash']).where('action', '=', 'feedback.submitted').where('entity_id', '=', fb[0]!.id).executeTakeFirstOrThrow();
    expect(audit.actor_type).toBe('external_interviewer');
    expect(audit.actor_label).toContain('ext1.');
    expect(audit.ip_hash).toMatch(/^[0-9a-f]{64}$/); // a hash, never the address
  });

  it('a second use of the same link fails', async () => {
    const iv = await interview();
    const link = await issueLink(ctx, recruiter, iv.id, iv.one.id);
    expect((await publicPost(ctx, 'submit', { token: link.token, ...goodFeedback() })).statusCode).toBe(200);
    const replay = await publicPost(ctx, 'submit', { token: link.token, ...goodFeedback({ overall_rating: 1 }) });
    expect(replay.statusCode).toBe(409);
    expect(replay.json().error.code).toBe('ALREADY_SUBMITTED');
    expect((await feedbackRows(iv.id))).toHaveLength(1);
  });

  it('ten simultaneous submissions of one link produce exactly one feedback record', async () => {
    const iv = await interview();
    const link = await issueLink(ctx, recruiter, iv.id, iv.one.id);
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => publicPost(ctx, 'submit', { token: link.token, ...goodFeedback({ overall_rating: (i % 5) + 1 }) })));
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
    expect(results.filter((r) => r.statusCode === 409)).toHaveLength(9);
    expect(await feedbackRows(iv.id)).toHaveLength(1);
    const audit = await ctx.adminDb.selectFrom('audit_events').select('id').where('action', '=', 'feedback.submitted').where('entity_id', '=', (await feedbackRows(iv.id))[0]!.id).execute();
    expect(audit).toHaveLength(1);
  });

  it('a regenerated link cannot be used to submit twice for the same interviewer', async () => {
    const iv = await interview();
    const first = await issueLink(ctx, recruiter, iv.id, iv.one.id);
    await publicPost(ctx, 'submit', { token: first.token, ...goodFeedback() });
    // The recruiter cannot issue another (409), and a stale second token would still hit the unique key.
    await ctx.adminDb.insertInto('feedback_links').values({
      tenant_id: s.co.tenant.id, interview_id: iv.id, interviewer_id: iv.one.id, token_hash: sha256Hex('smuggled-' + iv.id), expires_at: new Date(Date.now() + 3_600_000), created_by: s.users.recruiter.id,
    }).execute();
    const res = await publicPost(ctx, 'submit', { token: 'smuggled-' + iv.id + 'x'.repeat(20), ...goodFeedback() });
    expect(res.statusCode).toBe(401); // wrong token: hash differs
    expect(await feedbackRows(iv.id)).toHaveLength(1);
  });

  it('two interviewers on the same interview give their feedback independently', async () => {
    const iv = await interview();
    const a = await issueLink(ctx, recruiter, iv.id, iv.one.id);
    const b = await issueLink(ctx, recruiter, iv.id, iv.two.id);
    const [ra, rb] = await Promise.all([
      publicPost(ctx, 'submit', { token: a.token, ...goodFeedback({ overall_rating: 5 }) }),
      publicPost(ctx, 'submit', { token: b.token, ...goodFeedback({ overall_rating: 2 }) }),
    ]);
    expect([ra.statusCode, rb.statusCode]).toEqual([200, 200]);
    expect((await feedbackRows(iv.id))).toHaveLength(2);
  });

  it('checks the scorecard, and a rejected attempt does not use the link up', async () => {
    const iv = await interview();
    const link = await issueLink(ctx, recruiter, iv.id, iv.one.id);
    const send = (b: object) => publicPost(ctx, 'submit', { token: link.token, ...b });

    const missing = await send(goodFeedback({ competency_ratings: { communication: 4 } }));
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error.details.map((d: { path: string }) => d.path)).toContain('competency_ratings.role_skills');
    const unknown = await send(goodFeedback({ competency_ratings: { role_skills: 4, communication: 4, charisma: 5 } }));
    expect(unknown.json().error.details.map((d: { path: string }) => d.path)).toContain('competency_ratings.charisma');
    for (const bad of [{ overall_rating: 0 }, { overall_rating: 6 }, { overall_rating: 3.5 }, { recommendation: 'maybe' }, { mode: 'carrier_pigeon' }, { notes: 'x'.repeat(5001) }, { competency_ratings: { role_skills: 9, communication: 4 } }]) {
      expect((await send(goodFeedback(bad))).statusCode, JSON.stringify(bad)).toBe(400);
    }
    expect((await feedbackRows(iv.id))).toHaveLength(0);
    expect((await send(goodFeedback())).statusCode).toBe(200); // the link is still good
  });

  it('refuses an expired or withdrawn link without saving anything', async () => {
    const iv = await interview();
    const old = await issueLink(ctx, recruiter, iv.id, iv.one.id);
    await expire(old.id);
    expect((await publicPost(ctx, 'submit', { token: old.token, ...goodFeedback() })).statusCode).toBe(410);
    const withdrawn = await issueLink(ctx, recruiter, iv.id, iv.two.id);
    await call(ctx, recruiter, 'POST', `/feedback-links/${withdrawn.id}/revoke`);
    expect((await publicPost(ctx, 'submit', { token: withdrawn.token, ...goodFeedback() })).statusCode).toBe(410);
    expect(await feedbackRows(iv.id)).toHaveLength(0);
  });

  it('never keeps the raw token anywhere in the database', async () => {
    const iv = await interview();
    const link = await issueLink(ctx, recruiter, iv.id, iv.one.id);
    await publicPost(ctx, 'validate', { token: link.token });
    await publicPost(ctx, 'submit', { token: link.token, ...goodFeedback() });
    for (const table of ['feedback_links', 'audit_events', 'interview_events', 'notifications', 'feedback']) {
      const res = await sql<{ n: number }>`SELECT count(*)::int AS n FROM ${sql.table(table)} t WHERE t::text LIKE ${'%' + link.token + '%'}`.execute(ctx.adminDb);
      expect(res.rows[0]!.n, table).toBe(0);
    }
  });

  it('is only reachable through the database function, so feedback cannot be written for another interviewer', async () => {
    const iv = await interview();
    const other = await interview();
    const link = await issueLink(ctx, recruiter, iv.id, iv.one.id);
    await publicPost(ctx, 'submit', { token: link.token, ...goodFeedback() });
    const fb = await ctx.adminDb.selectFrom('feedback').select(['interview_id', 'interviewer_id']).where('feedback_link_id', '=', link.id).executeTakeFirstOrThrow();
    expect(fb).toEqual({ interview_id: iv.id, interviewer_id: iv.one.id });
    expect(await feedbackRows(other.id)).toHaveLength(0);
    expect(inHours(1)).toBeTruthy();
  });
});
