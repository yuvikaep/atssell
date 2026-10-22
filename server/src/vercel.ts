// Vercel Function entry: the whole API as one function, built by scripts/vercel-build.mjs.
// No timers run here (instances pause between requests): background work runs after signed-in
// requests (serverless.ts) and from the scheduled /api/v1/cron/worker call.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { assertRlsEnforced, createDb, RlsBypassError } from './db.js';
import { postgresRateLimitStore } from './rate-limit-store.js';
import { misconfiguredApp } from './misconfigured.js';
import { waitUntil } from '@vercel/functions';
import { createMailer, createScanner, createStorage } from './providers/index.js';
import { serverlessWorker } from './serverless.js';

let app: Promise<FastifyInstance> | null = null;

async function load(): Promise<FastifyInstance> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    return misconfiguredApp(err);
  }
  // Each instance serves one request at a time; a few connections are plenty. Use Neon's pooled URL.
  const db = createDb(config.DATABASE_URL, Math.min(config.DB_POOL_MAX, 3));
  try {
    await assertRlsEnforced(db);
  } catch (err) {
    // A connection failure is thrown so the next request tries again; a wrong role is a settings problem.
    if (!(err instanceof RlsBypassError)) { await db.destroy(); throw err; }
    await db.destroy();
    return misconfiguredApp(err);
  }
  const mailer = createMailer(config);
  const storage = createStorage(config, '/tmp');
  const worker = serverlessWorker({ db, mailer, config, storage, log: (msg, extra) => console.info(JSON.stringify({ msg, ...extra })) }, { waitUntil });
  return buildApp({
    config, db, mailer, storage, scanner: createScanner(config), afterAuthenticatedRequest: worker,
    rateLimitStore: postgresRateLimitStore(db, config.IP_HASH_SALT),
  });
}

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  app ??= load().then(async (a) => { await a.ready(); return a; });
  let instance: FastifyInstance;
  try {
    instance = await app;
  } catch (err) {
    app = null; // try again on the next request
    throw err;
  }
  // The routing rewrite may hand over /api?__path=/api/v1/me; restore the original path and query.
  const url = new URL(req.url ?? '/', 'http://x');
  const original = url.searchParams.get('__path');
  if (original !== null) {
    url.searchParams.delete('__path');
    req.url = `${original.startsWith('/') ? original : `/${original}`}${url.search}`;
  }
  instance.server.emit('request', req, res);
}
