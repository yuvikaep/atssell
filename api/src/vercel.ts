// Vercel Function entry: the whole API as one function, built by scripts/vercel-build.mjs.
// No timers run here (instances pause between requests); schedule worker-cli separately.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createDb } from './db.js';
import { misconfiguredApp } from './misconfigured.js';
import { createMailer, createScanner, createStorage } from './providers/index.js';

let app: Promise<FastifyInstance> | null = null;

async function load(): Promise<FastifyInstance> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    return misconfiguredApp(err);
  }
  // Each instance serves one request at a time; a few connections are plenty. Use Neon's pooled URL.
  const db = createDb(config.DATABASE_URL, 3);
  return buildApp({ config, db, mailer: createMailer(config), storage: createStorage(config, '/tmp'), scanner: createScanner(config) });
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
