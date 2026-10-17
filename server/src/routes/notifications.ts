// The notification centre and task list: what needs this person's attention.
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { z } from 'zod';
import { principal } from '../app.js';
import { withTenant } from '../db.js';
import { notFound } from '../errors.js';
import { idParams, pageQuery } from './common.js';

const ListQuery = pageQuery.extend({ unread: z.enum(['true', 'false']).optional() });

export async function notificationRoutes(app: FastifyInstance) {
  const { db } = app;

  app.get('/notifications', async (req) => {
    const p = principal(req);
    const f = ListQuery.parse(req.query);
    return withTenant(db, p.tenantId, async (tx) => {
      let base = tx.selectFrom('notifications').where('recipient_user_id', '=', p.userId).where('delivery_channel', '=', 'in_app');
      if (f.unread === 'true') base = base.where('read_at', 'is', null);
      const { total } = await base.select(sql<number>`count(*)::int`.as('total')).executeTakeFirstOrThrow();
      const rows = await base
        .select(['id', 'event_type', 'payload', 'read_at', 'created_at'])
        .orderBy('created_at', 'desc')
        .limit(f.page_size)
        .offset((f.page - 1) * f.page_size)
        .execute();
      return {
        data: rows.map((r) => ({ id: r.id, type: r.event_type, ...(r.payload as { title?: string; body?: string; link?: string | null }), read: r.read_at !== null, created_at: r.created_at })),
        page: f.page, page_size: f.page_size, total,
      };
    });
  });

  app.get('/notifications/unread-count', async (req) => {
    const p = principal(req);
    const row = await withTenant(db, p.tenantId, (tx) =>
      tx.selectFrom('notifications').select(sql<number>`count(*)::int`.as('n')).where('recipient_user_id', '=', p.userId).where('delivery_channel', '=', 'in_app').where('read_at', 'is', null).executeTakeFirstOrThrow());
    return { data: { unread: row.n } };
  });

  app.post('/notifications/:id/read', async (req, reply) => {
    const p = principal(req);
    const { id } = idParams.parse(req.params);
    await withTenant(db, p.tenantId, async (tx) => {
      const r = await tx.updateTable('notifications').set({ read_at: sql`now()` }).where('id', '=', id).where('recipient_user_id', '=', p.userId).where('delivery_channel', '=', 'in_app').returning('id').executeTakeFirst();
      if (!r) throw notFound('Notification');
    });
    return reply.status(204).send();
  });

  app.post('/notifications/read-all', async (req, reply) => {
    const p = principal(req);
    await withTenant(db, p.tenantId, (tx) =>
      tx.updateTable('notifications').set({ read_at: sql`now()` }).where('recipient_user_id', '=', p.userId).where('delivery_channel', '=', 'in_app').where('read_at', 'is', null).execute());
    return reply.status(204).send();
  });

  app.get('/tasks', async (req) => {
    const p = principal(req);
    const { status } = z.object({ status: z.enum(['open', 'done']).default('open') }).parse(req.query);
    const rows = await withTenant(db, p.tenantId, (tx) => {
      let q = tx.selectFrom('tasks').select(['id', 'task_type', 'title', 'entity_type', 'entity_id', 'due_at', 'completed_at', 'created_at']).where('assignee_user_id', '=', p.userId).orderBy('created_at', 'desc').limit(100);
      q = status === 'open' ? q.where('completed_at', 'is', null) : q.where('completed_at', 'is not', null);
      return q.execute();
    });
    const now = Date.now();
    return { data: rows.map((t) => ({ ...t, overdue: t.completed_at === null && t.due_at !== null && t.due_at.getTime() < now })) };
  });

  app.post('/tasks/:id/complete', async (req, reply) => {
    const p = principal(req);
    const { id } = idParams.parse(req.params);
    await withTenant(db, p.tenantId, async (tx) => {
      const r = await tx.updateTable('tasks').set({ completed_at: sql`now()` }).where('id', '=', id).where('assignee_user_id', '=', p.userId).where('completed_at', 'is', null).returning('id').executeTakeFirst();
      if (!r) throw notFound('Task');
    });
    return reply.status(204).send();
  });
}
