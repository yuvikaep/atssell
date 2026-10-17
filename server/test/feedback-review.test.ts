import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addUser, call, login, setupApp, type TestContext } from './helpers.js';
import { applicationOnVacancy, goodFeedback, issueLink, publicPost, scheduleInterview, setupCompany } from './hiring-helpers.js';

let ctx: TestContext;
let s: Awaited<ReturnType<typeof setupCompany>>;
let admin: string;
let recruiter: string;
let engManager: string;
let salesManager: string;
let hr: string;
let applicationId: string;
let n = 0;

beforeAll(async () => {
  ctx = await setupApp();
  s = await setupCompany(ctx, 'fr');
  [admin, recruiter, engManager, salesManager, hr] = await Promise.all([s.as('admin'), s.as('recruiter'), s.as('engManager'), s.as('salesManager'), s.as('hr1')]);
  const a = await applicationOnVacancy(ctx, s, 'fr');
  applicationId = a.applicationId;
  await call(ctx, admin, 'POST', `/vacancies/${a.vacancyId}/assign-recruiter`, { user_id: s.users.recruiter.id });
});
afterAll(() => ctx.close());

async function interview(panel: object[] = []) {
  const k = ++n;
  const iv = await scheduleInterview(ctx, recruiter, applicationId, { panel: [{ name: `Ext ${k}`, email: `ext.${k}@partner.test` }, ...panel] });
  return { id: iv.id, ext: iv.panel.find((m) => m.user_id === null)!, panel: iv.panel };
}
/** Gets feedback in through a link and returns the feedback id. */
async function giveFeedback(interviewId: string, interviewerId: string, extra: Record<string, unknown> = {}) {
  const link = await issueLink(ctx, recruiter, interviewId, interviewerId);
  const res = await publicPost(ctx, 'submit', { token: link.token, ...goodFeedback(extra) });
  expect(res.statusCode).toBe(200);
  return (await ctx.adminDb.selectFrom('feedback').select('id').where('interview_id', '=', interviewId).where('interviewer_id', '=', interviewerId).executeTakeFirstOrThrow()).id;
}

describe('reviewing feedback', () => {
  it('people who work with feedback see it, with the original as the effective answer', async () => {
    const iv = await interview();
    const fid = await giveFeedback(iv.id, iv.ext.id, { overall_rating: 4, notes: 'Good communicator.' });
    for (const cookie of [recruiter, engManager, hr, admin]) {
      const res = await call(ctx, cookie, 'GET', `/interviews/${iv.id}/feedback`);
      expect(res.statusCode).toBe(200);
      const f = res.json().data[0];
      expect(f).toMatchObject({ id: fid, interviewer: { name: iv.ext.name } });
      expect(f.effective).toMatchObject({ overall_rating: 4, recommendation: 'yes', corrected: false, version: 0, notes: 'Good communicator.' });
    }
  });

  it('is refused to people with no part in it, and hidden from other departments', async () => {
    const iv = await interview();
    await giveFeedback(iv.id, iv.ext.id);
    await addUser(ctx, s.co.tenant.id, { email: `plain@${s.co.slug}.test`, role: 'interviewer' });
    const plain = await login(ctx, s.co.slug, `plain@${s.co.slug}.test`);
    expect((await call(ctx, plain, 'GET', `/interviews/${iv.id}/feedback`)).statusCode).toBe(403);
    expect((await call(ctx, salesManager, 'GET', `/interviews/${iv.id}/feedback`)).statusCode).toBe(404);
  });
});

describe('corrections', () => {
  it('create a new version with a reason, leave the original alone, and become the effective answer', async () => {
    const iv = await interview();
    const fid = await giveFeedback(iv.id, iv.ext.id, { overall_rating: 2, recommendation: 'no', notes: 'Misread the form.' });
    const res = await call(ctx, hr, 'POST', `/feedback/${fid}/corrections`, goodFeedback({ overall_rating: 4, recommendation: 'yes', reason: 'Interviewer emailed that the ratings were entered the wrong way round', notes: 'Corrected.' }));
    expect(res.statusCode).toBe(201);
    const f = res.json().data;
    expect(f.original).toMatchObject({ overall_rating: 2, recommendation: 'no', notes: 'Misread the form.' });
    expect(f.effective).toMatchObject({ overall_rating: 4, recommendation: 'yes', corrected: true, version: 1 });
    expect(f.corrections[0]).toMatchObject({ version: 1, reason: expect.stringContaining('wrong way round'), corrected_by: 'hr1' });

    const row = await ctx.adminDb.selectFrom('feedback').select(['overall_rating', 'recommendation']).where('id', '=', fid).executeTakeFirstOrThrow();
    expect(row).toEqual({ overall_rating: 2, recommendation: 'no' }); // the stored original never changes
  });

  it('later corrections stack as new versions', async () => {
    const iv = await interview();
    const fid = await giveFeedback(iv.id, iv.ext.id);
    await call(ctx, hr, 'POST', `/feedback/${fid}/corrections`, goodFeedback({ overall_rating: 3, reason: 'First fix' }));
    const second = await call(ctx, hr, 'POST', `/feedback/${fid}/corrections`, goodFeedback({ overall_rating: 5, reason: 'Second fix' }));
    expect(second.json().data.effective).toMatchObject({ overall_rating: 5, version: 2 });
    expect(second.json().data.corrections.map((c: { version: number }) => c.version)).toEqual([1, 2]);
  });

  it('need a reason, a valid scorecard, and the permission', async () => {
    const iv = await interview();
    const fid = await giveFeedback(iv.id, iv.ext.id);
    const noReason = await call(ctx, hr, 'POST', `/feedback/${fid}/corrections`, goodFeedback());
    expect(noReason.statusCode).toBe(400);
    expect(noReason.json().error.details.map((d: { path: string }) => d.path)).toContain('reason');
    const badCard = await call(ctx, hr, 'POST', `/feedback/${fid}/corrections`, goodFeedback({ competency_ratings: { communication: 3 }, reason: 'x' }));
    expect(badCard.statusCode).toBe(400);
    expect((await call(ctx, engManager, 'POST', `/feedback/${fid}/corrections`, goodFeedback({ reason: 'x' }))).statusCode).toBe(403);
    expect((await call(ctx, recruiter, 'POST', `/feedback/${fid}/corrections`, goodFeedback({ reason: 'x' }))).statusCode).toBe(403);
  });

  it('are audited and cannot be edited or deleted', async () => {
    const iv = await interview();
    const fid = await giveFeedback(iv.id, iv.ext.id);
    await call(ctx, hr, 'POST', `/feedback/${fid}/corrections`, goodFeedback({ reason: 'Audit me' }));
    const audit = await ctx.adminDb.selectFrom('audit_events').select(['actor_user_id', 'metadata']).where('action', '=', 'feedback.corrected').where('entity_id', '=', fid).executeTakeFirstOrThrow();
    expect(audit.actor_user_id).toBe(s.users.hr1.id);
    expect(audit.metadata).toMatchObject({ version: 1, reason: 'Audit me' });
    await expect(ctx.adminDb.deleteFrom('feedback_corrections').where('feedback_id', '=', fid).execute()).rejects.toThrow(/append-only/);
    await expect(ctx.adminDb.updateTable('feedback').set({ overall_rating: 1 }).where('id', '=', fid).execute()).rejects.toThrow(/append-only/);
  });

  it('cannot reach another companys feedback', async () => {
    const iv = await interview();
    const fid = await giveFeedback(iv.id, iv.ext.id);
    const other = await setupCompany(ctx, 'fr2');
    const res = await call(ctx, await other.as('hr1'), 'POST', `/feedback/${fid}/corrections`, goodFeedback({ reason: 'x' }));
    expect(res.statusCode).toBe(404);
  });
});

describe('deciding on a candidate', () => {
  it('summarizes every interview, using the corrected answers', async () => {
    const appl = await applicationOnVacancy(ctx, s, 'summary');
    await call(ctx, admin, 'POST', `/vacancies/${appl.vacancyId}/assign-recruiter`, { user_id: s.users.recruiter.id });
    const mk = async (label: string) => {
      const iv = await scheduleInterview(ctx, recruiter, appl.applicationId, { round_name: label, panel: [{ name: `P ${label}`, email: `p.${label.replace(/\W+/g, '').toLowerCase()}@partner.test` }] });
      return { id: iv.id, interviewerId: iv.panel[0]!.id };
    };
    const a = await mk('Round A');
    const b = await mk('Round B');
    const fa = await giveFeedbackFor(a, 5, 'strong_yes');
    await giveFeedbackFor(b, 3, 'hold');
    let sum = (await call(ctx, engManager, 'GET', `/applications/${appl.applicationId}/feedback`)).json().data;
    expect(sum.summary).toMatchObject({ count: 2, average_rating: 4, recommendations: { strong_yes: 1, hold: 1 } });
    await call(ctx, hr, 'POST', `/feedback/${fa}/corrections`, goodFeedback({ overall_rating: 1, recommendation: 'strong_no', reason: 'Wrong candidate rated' }));
    sum = (await call(ctx, engManager, 'GET', `/applications/${appl.applicationId}/feedback`)).json().data;
    expect(sum.summary).toMatchObject({ average_rating: 2, recommendations: { strong_no: 1, hold: 1 } });
    expect(sum.interviews.map((i: { round_name: string }) => i.round_name).sort()).toEqual(['Round A', 'Round B']);

    async function giveFeedbackFor(x: { id: string; interviewerId: string }, rating: number, rec: string) {
      return giveFeedback(x.id, x.interviewerId, { overall_rating: rating, recommendation: rec });
    }
  });

  it('a hiring manager records decisions; holds and rejections need a reason; others cannot decide', async () => {
    const appl = await applicationOnVacancy(ctx, s, 'decide');
    await call(ctx, admin, 'POST', `/vacancies/${appl.vacancyId}/assign-recruiter`, { user_id: s.users.recruiter.id });
    const post = (cookie: string, body: object) => call(ctx, cookie, 'POST', `/applications/${appl.applicationId}/decisions`, body);
    expect((await post(engManager, { decision: 'hold' })).statusCode).toBe(400);
    expect((await post(engManager, { decision: 'hold', reason: 'Waiting on a second opinion' })).statusCode).toBe(201);
    expect((await post(engManager, { decision: 'additional_round' })).statusCode).toBe(201);
    expect((await post(engManager, { decision: 'select' })).statusCode).toBe(201);
    expect((await post(recruiter, { decision: 'advance' })).statusCode).toBe(403);
    expect((await post(salesManager, { decision: 'advance' })).statusCode).toBe(404);
    const history = (await call(ctx, engManager, 'GET', `/applications/${appl.applicationId}/decisions`)).json().data;
    expect(history.map((d: { decision: string }) => d.decision)).toEqual(['select', 'additional_round', 'hold']);
    expect(history[0].decided_by_name).toBe('engmgr');
  });

  it('cannot decide on a closed application', async () => {
    const appl = await applicationOnVacancy(ctx, s, 'closeddec');
    const rejected = (await call(ctx, admin, 'GET', '/pipeline/stages')).json().data.find((x: { code: string }) => x.code === 'rejected').id;
    await call(ctx, admin, 'PATCH', `/applications/${appl.applicationId}/stage`, { stage_id: rejected, reason: 'No fit' });
    const res = await call(ctx, engManager, 'POST', `/applications/${appl.applicationId}/decisions`, { decision: 'advance' });
    expect(res.statusCode).toBe(409);
  });
});

describe('colleagues with an account', () => {
  it('see only the interviews they are on, with the scorecard and a candidate brief', async () => {
    const iv = await interview([{ user_id: s.users.engManager.id }]);
    const list = (await call(ctx, engManager, 'GET', '/me/interviews')).json().data;
    expect(list.map((r: { id: string }) => r.id)).toContain(iv.id);
    expect(list.find((r: { id: string }) => r.id === iv.id)).toMatchObject({ candidate_name: 'Interviewee fr', feedback_status: 'pending', can_submit: true });
    expect((await call(ctx, salesManager, 'GET', '/me/interviews')).json().data.map((r: { id: string }) => r.id)).not.toContain(iv.id);

    const detail = await call(ctx, engManager, 'GET', `/me/interviews/${iv.id}`);
    expect(detail.statusCode).toBe(200);
    expect(detail.json().data.scorecard).toHaveLength(3);
    for (const secret of ['interviewee.fr@mail.test', 'current_ctc', '"phone"']) expect(detail.body).not.toContain(secret);
    expect((await call(ctx, salesManager, 'GET', `/me/interviews/${iv.id}`)).statusCode).toBe(404);
  });

  it('submit feedback once, which withdraws any outstanding link', async () => {
    const iv = await interview([{ user_id: s.users.engManager.id }]);
    const mine = iv.panel.find((m) => m.user_id === s.users.engManager.id)!;
    const link = await issueLink(ctx, recruiter, iv.id, mine.id);
    const res = await call(ctx, engManager, 'POST', `/me/interviews/${iv.id}/feedback`, goodFeedback({ overall_rating: 5 }));
    expect(res.statusCode).toBe(201);
    expect((await call(ctx, engManager, 'POST', `/me/interviews/${iv.id}/feedback`, goodFeedback())).statusCode).toBe(409);
    expect((await publicPost(ctx, 'submit', { token: link.token, ...goodFeedback() })).statusCode).toBe(410);
    const rows = await ctx.adminDb.selectFrom('feedback').select(['overall_rating', 'feedback_link_id']).where('interviewer_id', '=', mine.id).execute();
    expect(rows).toEqual([{ overall_rating: 5, feedback_link_id: null }]);
    const detail = (await call(ctx, engManager, 'GET', `/me/interviews/${iv.id}`)).json().data;
    expect(detail.my_feedback).toMatchObject({ overall_rating: 5 });
    expect(detail.can_submit).toBe(false);
  });

  it('are held to the same scorecard rules as a link', async () => {
    const iv = await interview([{ user_id: s.users.engManager.id }]);
    const bad = await call(ctx, engManager, 'POST', `/me/interviews/${iv.id}/feedback`, goodFeedback({ competency_ratings: {} }));
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.details.map((d: { path: string }) => d.path)).toContain('competency_ratings.role_skills');
  });

  it('cannot give feedback on an interview they are not on, or one that was cancelled', async () => {
    const iv = await interview([{ user_id: s.users.engManager.id }]);
    expect((await call(ctx, salesManager, 'POST', `/me/interviews/${iv.id}/feedback`, goodFeedback())).statusCode).toBe(404);
    await call(ctx, recruiter, 'POST', `/interviews/${iv.id}/cancel`, { reason: 'Off' });
    expect((await call(ctx, engManager, 'POST', `/me/interviews/${iv.id}/feedback`, goodFeedback())).statusCode).toBe(409);
  });

  it('the recruiter who set the interview up is told when feedback arrives', async () => {
    const iv = await interview([{ user_id: s.users.engManager.id }]);
    await call(ctx, engManager, 'POST', `/me/interviews/${iv.id}/feedback`, goodFeedback({ overall_rating: 5 }));
    const inbox = (await call(ctx, recruiter, 'GET', '/notifications?unread=true')).json().data;
    const hit = inbox.find((x: { type: string; link: string }) => x.type === 'feedback.submitted' && x.link === `/interviews/${iv.id}`);
    expect(hit).toMatchObject({ title: 'Interview feedback received', read: false });
    expect(hit.body).toContain('5/5');
  });
});
