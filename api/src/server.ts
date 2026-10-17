import Fastify from 'fastify';
import { ZodError } from 'zod';
import { buildApp } from './app.js';
import { loadConfig, type Config } from './config.js';
import { createDb } from './db.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMailer, createScanner, createStorage } from './providers/index.js';
import { startWorker } from './worker.js';

let config: Config | null = null;
let configError: unknown;
try {
  config = loadConfig();
} catch (err) {
  configError = err;
}

if (config) await start(config);
else await serveMisconfigured(configError);

async function start(config: Config) {
  const db = createDb(config.DATABASE_URL);
  // Production refuses local disk, the dev scanner and the console mailer (see loadConfig).
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const storage = createStorage(config, root);
  const app = await buildApp({ config, db, mailer: createMailer(config), storage, scanner: createScanner(config) });

  // Vercel instances may pause between requests. Schedule worker-cli separately there.
  const stopWorker = process.env.VERCEL === '1'
    ? () => {}
    : startWorker({ db, mailer: app.mailer, config, storage, log: (msg, extra) => app.log.info(extra ?? {}, msg) });

  const shutdown = async () => {
    stopWorker();
    await app.close();
    await db.destroy();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await app.listen({ port: config.API_PORT, host: config.API_HOST });
}

/**
 * Invalid settings on Vercel: instead of a crashed function that only says FUNCTION_INVOCATION_FAILED,
 * answer every request with 503 naming the settings to fix (names only, never values). Elsewhere the
 * process exits so a supervisor notices.
 */
async function serveMisconfigured(err: unknown) {
  const problems = err instanceof ZodError
    ? err.issues.map((i) => `${i.path.join('.')}: ${i.message}`)
    : [(err as Error).message];
  console.error(`API configuration is invalid:\n  ${problems.join('\n  ')}`);
  if (process.env.VERCEL !== '1') process.exit(1);
  const app = Fastify();
  app.all('/*', async (req, reply) => reply.status(503).send({
    error: { code: 'SERVER_MISCONFIGURED', message: 'The API is missing required settings. Set them in the Vercel project and redeploy.', details: problems, request_id: req.id },
  }));
  await app.listen({ port: Number(process.env.API_PORT) || 3000, host: process.env.API_HOST ?? '127.0.0.1' });
}
