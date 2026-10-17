// Background work: feedback reminders, overdue chasers and email delivery with retry.
//
// The worker walks the active tenants and does each tenant's work inside that tenant's own
// transaction, so row-level security applies to it exactly as it does to a request. Every step is
// idempotent (notifications carry a dedupe key), so running a tick twice, or two workers at once, is safe.
import type { Config } from './config.js';
import { withTenant, type Db } from './db.js';
import type { Mailer } from './mailer.js';
import { audit } from './audit.js';
import { buildExport, EXPORT_TTL_HOURS, principalForUser, type ExportType } from './exports.js';
import { createTask, notify, notifyUser } from './notifications.js';
import type { ObjectStorage } from './storage.js';

export interface WorkerDeps {
  db: Db;
  mailer: Mailer;
  config: Config;
  storage: ObjectStorage;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

export const MAX_EMAIL_ATTEMPTS = 5;
const LEASE_MINUTES = 5;

export interface TickResult {
  tenants: number;
  reminders: number;
  overdue: number;
  emailsSent: number;
  emailsFailed: number;
  exportsDone: number;
}

export async function runTick(deps: WorkerDeps, now = new Date()): Promise<TickResult> {
  const total: TickResult = { tenants: 0, reminders: 0, overdue: 0, emailsSent: 0, emailsFailed: 0, exportsDone: 0 };
  const tenants = await deps.db.selectFrom('tenants').select('id').where('status', '=', 'active').execute();
  for (const t of tenants) {
    try {
      const r = await runTenantTick(deps, t.id, now);
      total.tenants += 1;
      total.reminders += r.reminders;
      total.overdue += r.overdue;
      total.emailsSent += r.emailsSent;
      total.emailsFailed += r.emailsFailed;
      total.exportsDone += r.exportsDone;
    } catch (err) {
      // One tenant's problem must not stop everyone else's reminders.
      deps.log?.('worker tenant tick failed', { tenantId: t.id, error: (err as Error).message });
    }
  }
  return total;
}

export async function runTenantTick(deps: WorkerDeps, tenantId: string, now: Date) {
  const scheduled = await withTenant(deps.db, tenantId, (tx) => scheduleFeedbackNotices(tx, tenantId, now));
  const delivered = await deliverEmails(deps, tenantId, now);
  const exportsDone = await runExports(deps, tenantId, now);
  return { ...scheduled, ...delivered, exportsDone };
}

/** Builds queued CSV exports one at a time. A failure marks that job failed and never blocks the rest. */
async function runExports(deps: WorkerDeps, tenantId: string, now: Date) {
  let done = 0;
  for (let i = 0; i < 10; i++) {
    const job = await withTenant(deps.db, tenantId, async (tx) => {
      const j = await tx.selectFrom('export_jobs').selectAll().where('status', '=', 'queued').orderBy('created_at').limit(1).forUpdate().skipLocked().executeTakeFirst();
      if (!j) return null;
      await tx.updateTable('export_jobs').set({ status: 'running', started_at: now }).where('id', '=', j.id).execute();
      return j;
    });
    if (!job) break;
    try {
      const built = await withTenant(deps.db, tenantId, async (tx) => {
        const p = await principalForUser(tx, tenantId, job.requested_by);
        if (!p) throw new Error('The requester is no longer an active user.');
        return buildExport(tx, p, job.export_type as ExportType, job.fields, job.filters as { status?: string; department_id?: string });
      });
      const key = `exports/${tenantId}/${job.id}`;
      await deps.storage.put(key, Buffer.from(built.csv, 'utf8'), 'text/csv');
      await withTenant(deps.db, tenantId, async (tx) => {
        await tx.updateTable('export_jobs').set({
          status: 'succeeded', storage_key: key, row_count: built.rowCount, finished_at: new Date(),
          filename: `${job.export_type}-${now.toISOString().slice(0, 10)}.csv`,
          expires_at: new Date(now.getTime() + EXPORT_TTL_HOURS * 3_600_000),
        }).where('id', '=', job.id).execute();
        await audit(tx, null, { tenantId, actorUserId: job.requested_by, actorType: 'system', action: 'export.completed', entityType: 'export_job', entityId: job.id, metadata: { rows: built.rowCount } });
        await notifyUser(tx, { tenantId, userId: job.requested_by, eventType: 'export.ready', dedupeKey: `export_ready:${job.id}`, title: 'Your export is ready', body: `${job.export_type} export with ${built.rowCount} rows. It stays available for ${EXPORT_TTL_HOURS} hours.`, link: '/reports', email_too: false });
      });
      done += 1;
    } catch (err) {
      deps.log?.('export failed', { jobId: job.id, error: (err as Error).message });
      await withTenant(deps.db, tenantId, async (tx) => {
        await tx.updateTable('export_jobs').set({ status: 'failed', error: (err as Error).message.slice(0, 300), finished_at: new Date() }).where('id', '=', job.id).execute();
        await audit(tx, null, { tenantId, actorUserId: job.requested_by, actorType: 'system', action: 'export.failed', entityType: 'export_job', entityId: job.id });
      });
    }
  }
  return done;
}

type TxArg = Parameters<Parameters<typeof withTenant>[2]>[0];

/**
 * Reminders go to interviewers still owing feedback, a configurable number of hours after the interview
 * ended. When the feedback deadline passes, the person who set the interview up gets a notice and a to-do.
 *
 * Reminder emails never contain the feedback link: it exists only in the email it was first sent in
 * (we keep just its hash). People with an account are pointed at "My interviews"; external interviewers
 * are told to use their original email or ask for a new link.
 */
async function scheduleFeedbackNotices(tx: TxArg, tenantId: string, now: Date) {
  const settings = await tx.selectFrom('tenant_settings').select(['feedback_reminder_hours']).executeTakeFirst();
  const hours = settings?.feedback_reminder_hours ?? [24];

  const pending = await tx
    .selectFrom('interviewers as m')
    .innerJoin('interviews as i', 'i.id', 'm.interview_id')
    .innerJoin('applications as a', 'a.id', 'i.application_id')
    .innerJoin('candidates as c', 'c.id', 'a.candidate_id')
    .leftJoin('users as u', 'u.id', 'm.user_id')
    .leftJoin('users as creator', 'creator.id', 'i.created_by')
    .select([
      'm.id as interviewer_id', 'm.user_id', 'm.external_email', 'm.external_name', 'u.full_name as user_name',
      'i.id as interview_id', 'i.round_name', 'i.scheduled_end', 'i.feedback_due_at', 'i.created_by',
      'c.full_name as candidate_name', 'creator.full_name as creator_name',
    ])
    .where('m.feedback_status', '=', 'pending')
    .where('i.status', 'in', ['scheduled', 'confirmed', 'completed'])
    .where('i.scheduled_end', '<=', now)
    .execute();

  let reminders = 0;
  let overdue = 0;
  for (const r of pending) {
    const ended = r.scheduled_end!.getTime();
    for (const h of hours) {
      if (now.getTime() < ended + h * 3_600_000) continue;
      const key = `feedback_reminder:${r.interviewer_id}:${h}`;
      const title = 'Feedback pending';
      if (r.user_id) {
        await notifyUser(tx, {
          tenantId, userId: r.user_id, eventType: 'feedback.reminder', dedupeKey: key, title,
          body: `Your feedback on ${r.candidate_name} (${r.round_name}) is still pending.`, link: '/my-interviews',
        });
      } else if (r.external_email) {
        await notify(tx, {
          tenantId, email: r.external_email, eventType: 'feedback.reminder', dedupeKey: key, title,
          body: `Hello ${r.external_name ?? ''}, your feedback on ${r.candidate_name} (${r.round_name}) is still pending. Please use the link in your original email, or ask ${r.creator_name ?? 'the recruiter'} for a new one.`,
        });
      }
      reminders += 1;
    }
    if (r.feedback_due_at && r.feedback_due_at <= now) {
      const who = r.user_name ?? r.external_name ?? 'An interviewer';
      await notifyUser(tx, {
        tenantId, userId: r.created_by, eventType: 'feedback.overdue', dedupeKey: `feedback_overdue:${r.interviewer_id}`,
        title: 'Feedback overdue', body: `${who} has not given feedback on ${r.candidate_name} (${r.round_name}).`, link: `/interviews/${r.interview_id}`,
      });
      await createTask(tx, {
        tenantId, assigneeUserId: r.created_by, taskType: 'feedback_overdue', title: `Chase feedback: ${r.candidate_name} (${r.round_name})`,
        entityType: 'interview', entityId: r.interview_id, dueAt: r.feedback_due_at,
      });
      overdue += 1;
    }
  }

  // A chase-up is finished once nobody on that interview owes feedback any more.
  await tx
    .updateTable('tasks')
    .set({ completed_at: now })
    .where('task_type', '=', 'feedback_overdue')
    .where('completed_at', 'is', null)
    .where((eb) => eb.not(eb.exists(
      eb.selectFrom('interviewers as m').select('m.id').whereRef('m.interview_id', '=', 'tasks.entity_id').where('m.feedback_status', '=', 'pending'),
    )))
    .execute();

  return { reminders, overdue };
}

/**
 * Claims a batch of due emails (marking them leased so a second worker skips them), sends them outside
 * the transaction, then records the outcome. A crash between claim and outcome means a retry after the
 * lease, so delivery is at-least-once. Failures back off and stop after MAX_EMAIL_ATTEMPTS.
 */
async function deliverEmails(deps: WorkerDeps, tenantId: string, now: Date) {
  const claimed = await withTenant(deps.db, tenantId, async (tx) => {
    const rows = await tx
      .selectFrom('notifications')
      .select(['id', 'recipient_email', 'payload', 'attempts'])
      .where('delivery_channel', '=', 'email')
      .where('status', '=', 'queued')
      .where((eb) => eb.or([eb('next_attempt_at', 'is', null), eb('next_attempt_at', '<=', now)]))
      .orderBy('created_at')
      .limit(25)
      .forUpdate()
      .skipLocked()
      .execute();
    for (const r of rows) {
      await tx
        .updateTable('notifications')
        .set({ attempts: r.attempts + 1, next_attempt_at: new Date(now.getTime() + LEASE_MINUTES * 60_000) })
        .where('id', '=', r.id)
        .execute();
    }
    return rows;
  });

  let emailsSent = 0;
  let emailsFailed = 0;
  for (const n of claimed) {
    const payload = n.payload as { title?: string; body?: string; link?: string | null };
    const attempt = n.attempts + 1;
    try {
      if (!n.recipient_email) throw new Error('no recipient address');
      await deps.mailer.sendNotice({
        to: n.recipient_email,
        subject: payload.title ?? 'Notification',
        text: payload.body ?? '',
        link: payload.link ? `${deps.config.WEB_ORIGIN}${payload.link}` : undefined,
      });
      await withTenant(deps.db, tenantId, (tx) =>
        tx.updateTable('notifications').set({ status: 'sent', sent_at: now, next_attempt_at: null, last_error: null }).where('id', '=', n.id).execute());
      emailsSent += 1;
    } catch (err) {
      const final = attempt >= MAX_EMAIL_ATTEMPTS;
      const backoffMinutes = Math.min(2 ** attempt, 60);
      await withTenant(deps.db, tenantId, (tx) =>
        tx
          .updateTable('notifications')
          .set({
            status: final ? 'failed' : 'queued',
            last_error: (err as Error).message.slice(0, 500),
            next_attempt_at: final ? null : new Date(now.getTime() + backoffMinutes * 60_000),
          })
          .where('id', '=', n.id)
          .execute());
      emailsFailed += 1;
    }
  }
  return { emailsSent, emailsFailed };
}

/** Starts the in-process scheduler. Returns a function that stops it. */
export function startWorker(deps: WorkerDeps, everyMs = 60_000): () => void {
  let running = false;
  const tick = async () => {
    if (running) return; // never overlap with the previous run
    running = true;
    try {
      const r = await runTick(deps);
      if (r.reminders || r.overdue || r.emailsSent || r.emailsFailed || r.exportsDone) deps.log?.('worker tick', r as unknown as Record<string, unknown>);
    } catch (err) {
      deps.log?.('worker tick failed', { error: (err as Error).message });
    } finally {
      running = false;
    }
  };
  const first = setTimeout(tick, 5_000);
  const timer = setInterval(tick, everyMs);
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}

