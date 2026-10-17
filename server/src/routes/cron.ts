// A scheduler (Vercel Cron) calls this to run one worker pass: reminders, queued email, exports.
// It is public in the sense that it needs no session, so it is guarded by a shared secret and does not
// exist at all unless CRON_SECRET is configured. Vercel sends the secret as "Authorization: Bearer ...".
import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { AppError, notFound } from '../errors.js';
import { runTick } from '../worker.js';

const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export async function cronRoutes(app: FastifyInstance) {
  const secret = app.config.CRON_SECRET;
  const run = async (authorization: string | undefined) => {
    if (!secret) throw notFound('Route');
    const given = authorization?.startsWith('Bearer ') ? authorization.slice(7) : '';
    if (!same(given, secret)) throw new AppError(401, 'UNAUTHENTICATED', 'Sign in required.');
    const result = await runTick({ db: app.db, mailer: app.mailer, config: app.config, storage: app.storage, log: (msg, extra) => app.log.info(extra ?? {}, msg) });
    return { data: result };
  };
  app.get('/cron/worker', async (req) => run(req.headers.authorization));
  app.post('/cron/worker', async (req) => run(req.headers.authorization));
}
