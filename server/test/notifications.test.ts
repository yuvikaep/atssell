import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAX_EMAIL_ATTEMPTS, runTenantTick, type WorkerDeps } from '../src/worker.js';
import { call, setupApp, type TestContext } from './helpers.js';
import { applicationOnVacancy, goodFeedback, issueLink, publicPost, scheduleInterview, setupCompany } from './hiring-helpers.js';

let ctx: TestContext;
let s: Awaited<ReturnType<typeof setupCompany>>;
let admin: string;
let recruiter: string;
let engManager: string;
let applicationId: string;
let deps: WorkerDeps;
let n = 0;

beforeAll(async () => {
  ctx = await setupApp();
  s = await setupCompany(ctx, 'nt');
  [admin, recruiter, engManager] = await Promise.all([s.as('admin'), s.as('recruiter'), s.as('engManager')]);
  const a = await applicationOnVacancy(ctx, s, 'nt');
  applicationId = a.applicationId;
  await call(ctx, admin, 'POST', `/vacancies/${a.vacancyId}/assign-recruiter`, { user_id: s.users.recruiter.id });
  deps = { db: ctx.appDb, mailer: ctx.mailer, config: ctx.app.config, storage: ctx.storage };
});
afterAll(() => ctx.close());

const tick = (now = new Date()) => runTenantTick(deps, s.co.tenant.id, now);
const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);
const notices = (subject: string) => ctx.mailer.notices.filter((m) => m.subject === subject);

/** An interview that ended `endedHoursAgo` hours ago; its feedback deadline is `dueInHours` from now. */
async function endedInterview(endedHoursAgo: number, dueInHours: number, panel: object[]) {
  const iv = await scheduleInterview(ctx, recruiter, applicationId, { round_name: `Round ${++n}`, panel });
  await ctx.adminDb
    .updateTable('interviews')
    .set({ scheduled_start: hoursAgo(endedHoursAgo + 1), scheduled_end: hoursAgo(endedHoursAgo), feedback_due_at: new Date(Date.now() + dueInHours * 3_600_000) })
    .where('id', '=', iv.id)
    .execute();
  return iv;
}
const rowsFor = (key: string) => ctx.adminDb.selectFrom('notifications').selectAll().where('dedupe_key', 'like', `${key}%`).execute();

describe('feedback reminders', () => {
  it('stay quiet until the reminder time has passed', async () => {
    const iv = await endedInterview(10, 38, [{ user_id: s.users.engManager.id }]);
    await tick();
    expect(await rowsFor(`feedback_reminder:${iv.panel[0]!.id}`)).toHaveLength(0);
  });

  it('go to a colleague in the app and by email once the time has passed, pointing at My interviews', async () => {
    const iv = await endedInterview(25, 23, [{ user_id: s.users.engManager.id }]);
    const before = notices('Feedback pending').length;
    await tick();
    const rows = await rowsFor(`feedback_reminder:${iv.panel[0]!.id}`);
    expect(rows.map((r) => r.delivery_channel).sort()).toEqual(['email', 'in_app']);
    expect(notices('Feedback pending').length).toBe(before + 1);
    const mail = ctx.mailer.notices.filter((m) => m.subject === 'Feedback pending').at(-1)!;
    expect(mail).toMatchObject({ to: s.email('engManager'), link: 'http://localhost:5180/my-interviews' });
    const inbox = (await call(ctx, engManager, 'GET', '/notifications')).json().data;
    expect(inbox.find((x: { type: string; link: string }) => x.type === 'feedback.reminder')).toMatchObject({ title: 'Feedback pending', read: false });
  });

  it('are never sent twice, however often the worker runs, even at the same time', async () => {
    const iv = await endedInterview(30, 18, [{ user_id: s.users.engManager.id }]);
    const before = notices('Feedback pending').length;
    await Promise.all([tick(), tick(), tick()]);
    await tick();
    expect(await rowsFor(`feedback_reminder:${iv.panel[0]!.id}`)).toHaveLength(2); // one in-app, one email
    expect(notices('Feedback pending').length).toBe(before + 1);
  });

  it('go to an external interviewer by email only, and never contain a feedback link', async () => {
    const iv = await endedInterview(26, 22, [{ name: 'Ext Reviewer', email: 'ext.reviewer@partner.test' }]);
    const ext = iv.panel.find((m) => m.user_id === null)!;
    await issueLink(ctx, recruiter, iv.id, ext.id, { send_email: false });
    await tick();
    const rows = await rowsFor(`feedback_reminder:${ext.id}`);
    expect(rows.map((r) => r.delivery_channel)).toEqual(['email']);
    const mail = ctx.mailer.notices.filter((m) => m.to === 'ext.reviewer@partner.test').at(-1)!;
    expect(mail.text).toContain('original email');
    expect(mail.text).toContain('rec'); // names the recruiter to ask
    expect(JSON.stringify(mail)).not.toMatch(/feedback#|http/);
  });

  it('are not sent for interviewers who have already given feedback, or for cancelled interviews', async () => {
    const done = await endedInterview(30, 18, [{ user_id: s.users.engManager.id }]);
    await call(ctx, engManager, 'POST', `/me/interviews/${done.id}/feedback`, goodFeedback());
    const cancelled = await endedInterview(30, 18, [{ user_id: s.users.engManager.id }]);
    await ctx.adminDb.updateTable('interviews').set({ status: 'cancelled', cancelled_reason: 'Off' }).where('id', '=', cancelled.id).execute();
    await tick();
    expect(await rowsFor(`feedback_reminder:${done.panel[0]!.id}`)).toHaveLength(0);
    expect(await rowsFor(`feedback_reminder:${cancelled.panel[0]!.id}`)).toHaveLength(0);
  });

  it('use the hours the company configured', async () => {
    await ctx.adminDb.updateTable('tenant_settings').set({ feedback_reminder_hours: [2, 48] }).where('tenant_id', '=', s.co.tenant.id).execute();
    const iv = await endedInterview(3, 45, [{ user_id: s.users.engManager.id }]);
    await tick();
    const keys = (await rowsFor(`feedback_reminder:${iv.panel[0]!.id}`)).map((r) => r.dedupe_key);
    expect(new Set(keys)).toEqual(new Set([`feedback_reminder:${iv.panel[0]!.id}:2`]));
    await ctx.adminDb.updateTable('tenant_settings').set({ feedback_reminder_hours: [24] }).where('tenant_id', '=', s.co.tenant.id).execute();
  });
});

describe('overdue feedback', () => {
  it('tells the person who set the interview up and gives them a to-do, once', async () => {
    const iv = await endedInterview(60, -2, [{ user_id: s.users.engManager.id }]);
    await tick();
    await tick();
    const rows = await rowsFor(`feedback_overdue:${iv.panel[0]!.id}`);
    expect(rows.filter((r) => r.delivery_channel === 'in_app')).toHaveLength(1);
    const tasks = (await call(ctx, recruiter, 'GET', '/tasks')).json().data.filter((t: { entity_id: string }) => t.entity_id === iv.id);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ task_type: 'feedback_overdue', overdue: true, title: expect.stringContaining('Chase feedback') });
    const sla = (await call(ctx, recruiter, 'GET', '/interviews?feedback=overdue')).json().data;
    expect(sla.map((r: { id: string }) => r.id)).toContain(iv.id);
    expect(sla.find((r: { id: string }) => r.id === iv.id).feedback_overdue).toBe(true);
  });

  it('the to-do finishes itself once nobody owes feedback', async () => {
    const iv = await endedInterview(60, -2, [{ user_id: s.users.engManager.id }]);
    await tick();
    expect((await call(ctx, recruiter, 'GET', '/tasks')).json().data.some((t: { entity_id: string }) => t.entity_id === iv.id)).toBe(true);
    await call(ctx, engManager, 'POST', `/me/interviews/${iv.id}/feedback`, goodFeedback());
    await tick();
    expect((await call(ctx, recruiter, 'GET', '/tasks')).json().data.some((t: { entity_id: string }) => t.entity_id === iv.id)).toBe(false);
    expect((await call(ctx, recruiter, 'GET', '/tasks?status=done')).json().data.some((t: { entity_id: string }) => t.entity_id === iv.id)).toBe(true);
  });

  it('a task can also be completed by hand, only by its owner', async () => {
    const iv = await endedInterview(60, -2, [{ user_id: s.users.engManager.id }]);
    await tick();
    const task = (await call(ctx, recruiter, 'GET', '/tasks')).json().data.find((t: { entity_id: string }) => t.entity_id === iv.id);
    expect((await call(ctx, engManager, 'POST', `/tasks/${task.id}/complete`)).statusCode).toBe(404);
    expect((await call(ctx, recruiter, 'POST', `/tasks/${task.id}/complete`)).statusCode).toBe(204);
    expect((await call(ctx, recruiter, 'POST', `/tasks/${task.id}/complete`)).statusCode).toBe(404);
  });
});

describe('email delivery', () => {
  it('delivers the "feedback received" email once, and marks it sent', async () => {
    const iv = await scheduleInterview(ctx, recruiter, applicationId, { round_name: 'Delivery round', panel: [{ user_id: s.users.engManager.id }] });
    await call(ctx, engManager, 'POST', `/me/interviews/${iv.id}/feedback`, goodFeedback());
    const before = notices('Interview feedback received').length;
    await tick();
    await tick();
    expect(notices('Interview feedback received').length).toBe(before + 1);
    expect(ctx.mailer.notices.filter((m) => m.subject === 'Interview feedback received').at(-1)).toMatchObject({ to: s.email('recruiter'), link: `http://localhost:5180/interviews/${iv.id}` });
    const row = await ctx.adminDb.selectFrom('notifications').select(['status', 'sent_at', 'attempts']).where('dedupe_key', 'like', 'feedback_submitted:%').where('delivery_channel', '=', 'email').orderBy('created_at', 'desc').executeTakeFirstOrThrow();
    expect(row).toMatchObject({ status: 'sent', attempts: 1 });
  });

  it('retries a failing email with backoff, gives up after the maximum, and still has the in-app copy', async () => {
    const iv = await scheduleInterview(ctx, recruiter, applicationId, { round_name: 'Retry round', panel: [{ user_id: s.users.engManager.id }] });
    await call(ctx, engManager, 'POST', `/me/interviews/${iv.id}/feedback`, goodFeedback({ overall_rating: 2 }));
    const key = (await ctx.adminDb.selectFrom('feedback').select('id').where('interview_id', '=', iv.id).executeTakeFirstOrThrow()).id;
    const email = () => ctx.adminDb.selectFrom('notifications').select(['status', 'attempts', 'next_attempt_at', 'last_error']).where('dedupe_key', '=', `feedback_submitted:${key}`).where('delivery_channel', '=', 'email').executeTakeFirstOrThrow();

    ctx.mailer.failing = true;
    try {
      const t0 = Date.now();
      await tick(new Date(t0));
      const first = await email();
      expect(first).toMatchObject({ status: 'queued', attempts: 1, last_error: 'mail provider unavailable' });
      expect(first.next_attempt_at!.getTime()).toBeGreaterThan(t0 + 60_000); // backs off

      // Too early: the retry is not due yet, so nothing is attempted.
      await tick(new Date(t0 + 30_000));
      expect((await email()).attempts).toBe(1);

      for (let i = 1; i < MAX_EMAIL_ATTEMPTS; i++) await tick(new Date(t0 + i * 3 * 3_600_000));
      expect(await email()).toMatchObject({ status: 'failed', attempts: MAX_EMAIL_ATTEMPTS, next_attempt_at: null });
    } finally {
      ctx.mailer.failing = false;
    }
    // The notification itself was never lost: the in-app copy is there.
    const inbox = (await call(ctx, recruiter, 'GET', '/notifications')).json().data;
    expect(inbox.some((x: { type: string; link: string }) => x.type === 'feedback.submitted' && x.link === `/interviews/${iv.id}`)).toBe(true);
  });

  it('delivers after a temporary outage ends', async () => {
    const iv = await scheduleInterview(ctx, recruiter, applicationId, { round_name: 'Recovery round', panel: [{ user_id: s.users.engManager.id }] });
    ctx.mailer.failing = true;
    await call(ctx, engManager, 'POST', `/me/interviews/${iv.id}/feedback`, goodFeedback({ overall_rating: 3 }));
    const t0 = Date.now();
    await tick(new Date(t0));
    ctx.mailer.failing = false;
    const before = notices('Interview feedback received').length;
    await tick(new Date(t0 + 2 * 3_600_000));
    expect(notices('Interview feedback received').length).toBe(before + 1);
  });

  it('two workers running at once never send the same email twice', async () => {
    const iv = await scheduleInterview(ctx, recruiter, applicationId, { round_name: 'Race round', panel: [{ user_id: s.users.engManager.id }] });
    await call(ctx, engManager, 'POST', `/me/interviews/${iv.id}/feedback`, goodFeedback({ overall_rating: 4 }));
    const before = notices('Interview feedback received').length;
    await Promise.all([tick(), tick(), tick()]);
    expect(notices('Interview feedback received').length).toBe(before + 1);
  });
});

describe('the notification centre', () => {
  it('lists, counts and marks notices as read, for their owner only', async () => {
    const iv = await scheduleInterview(ctx, recruiter, applicationId, { round_name: 'Inbox round', panel: [{ user_id: s.users.engManager.id }] });
    await call(ctx, engManager, 'POST', `/me/interviews/${iv.id}/feedback`, goodFeedback());
    const before = (await call(ctx, recruiter, 'GET', '/notifications/unread-count')).json().data.unread;
    expect(before).toBeGreaterThan(0);
    const first = (await call(ctx, recruiter, 'GET', '/notifications?unread=true')).json().data[0];
    expect((await call(ctx, engManager, 'POST', `/notifications/${first.id}/read`)).statusCode).toBe(404);
    expect((await call(ctx, recruiter, 'POST', `/notifications/${first.id}/read`)).statusCode).toBe(204);
    expect((await call(ctx, recruiter, 'GET', '/notifications/unread-count')).json().data.unread).toBe(before - 1);
    expect((await call(ctx, recruiter, 'POST', '/notifications/read-all')).statusCode).toBe(204);
    expect((await call(ctx, recruiter, 'GET', '/notifications/unread-count')).json().data.unread).toBe(0);
  });

  it('keeps every notice private to the person it is for', async () => {
    const mine = (await call(ctx, recruiter, 'GET', '/notifications')).json().data;
    const theirs = (await call(ctx, engManager, 'GET', '/notifications')).json().data;
    const ids = new Set(mine.map((x: { id: string }) => x.id));
    expect(theirs.every((x: { id: string }) => !ids.has(x.id))).toBe(true);
  });

  it('is isolated between companies, and the worker only touches the company it is running for', async () => {
    const other = await setupCompany(ctx, 'nt2');
    const otherAdmin = await other.as('admin');
    expect((await call(ctx, otherAdmin, 'GET', '/notifications')).json().total).toBe(0);
    const result = await runTenantTick(deps, other.co.tenant.id, new Date());
    expect(result).toMatchObject({ reminders: 0, overdue: 0, emailsSent: 0 });
  });
});
