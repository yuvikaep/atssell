// In-app notifications and email, queued so a slow or failing mail provider never loses anything:
// the in-app copy always exists, and email is retried with backoff by the worker.
import type { Tx } from './db.js';

export interface NotifyInput {
  tenantId: string;
  /** Who to tell. A user gets an in-app notice (and email if requested); an external email gets email only. */
  userId?: string | null;
  email?: string | null;
  eventType: string;
  /** Same key, same notification: re-running a scheduler or retrying a request can never send it twice. */
  dedupeKey: string;
  title: string;
  body: string;
  /** In-app path the notice opens, e.g. /interviews/<id>. */
  link?: string;
  email_too?: boolean;
}

export async function notify(tx: Tx, n: NotifyInput): Promise<void> {
  const payload = JSON.stringify({ title: n.title, body: n.body, link: n.link ?? null });
  const rows: { channel: 'in_app' | 'email'; email: string | null; user: string | null }[] = [];
  if (n.userId) rows.push({ channel: 'in_app', email: null, user: n.userId });
  if (n.email && (!n.userId || n.email_too)) rows.push({ channel: 'email', email: n.email, user: n.userId ?? null });
  for (const r of rows) {
    await tx
      .insertInto('notifications')
      .values({
        tenant_id: n.tenantId,
        recipient_user_id: r.user,
        recipient_email: r.email,
        event_type: n.eventType,
        dedupe_key: n.dedupeKey,
        payload,
        delivery_channel: r.channel,
        // In-app notices are available the moment they exist; only email needs delivering.
        status: r.channel === 'in_app' ? 'sent' : 'queued',
        sent_at: r.channel === 'in_app' ? new Date() : null,
        // A queued email is due at once (null); the worker sets a time only after a failed attempt.
        next_attempt_at: null,
      })
      .onConflict((oc) => oc.columns(['tenant_id', 'dedupe_key', 'delivery_channel']).doNothing())
      .execute();
  }
}

/** A to-do for a user. One open task per user, type and entity. */
export async function createTask(
  tx: Tx,
  t: { tenantId: string; assigneeUserId: string; taskType: string; title: string; entityType: string; entityId: string; dueAt?: Date | null; createdBy?: string | null },
): Promise<void> {
  await tx
    .insertInto('tasks')
    .values({
      tenant_id: t.tenantId, assignee_user_id: t.assigneeUserId, task_type: t.taskType, title: t.title,
      entity_type: t.entityType, entity_id: t.entityId, due_at: t.dueAt ?? null, created_by: t.createdBy ?? null,
    })
    .onConflict((oc) => oc.doNothing())
    .execute();
}

/** Tells a colleague by user id: in-app always, and email when asked. Skips people who are no longer active. */
export async function notifyUser(tx: Tx, n: Omit<NotifyInput, 'userId' | 'email'> & { userId: string }): Promise<void> {
  const u = await tx.selectFrom('users').select(['email', 'status']).where('id', '=', n.userId).executeTakeFirst();
  if (!u || u.status !== 'active') return;
  // People with an account get the in-app notice and an email, unless the caller says otherwise.
  await notify(tx, { ...n, userId: n.userId, email: u.email, email_too: n.email_too ?? true });
}
