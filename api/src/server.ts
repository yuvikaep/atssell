import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createDb } from './db.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMailer, createScanner, createStorage } from './providers/index.js';
import { startWorker } from './worker.js';

const config = loadConfig();
const db = createDb(config.DATABASE_URL);
// Production refuses local disk, the dev scanner and the console mailer (see loadConfig).
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const storage = createStorage(config, root);
const app = await buildApp({ config, db, mailer: createMailer(config), storage, scanner: createScanner(config) });

const stopWorker = startWorker({ db, mailer: app.mailer, config, storage, log: (msg, extra) => app.log.info(extra ?? {}, msg) });

const shutdown = async () => {
  stopWorker();
  await app.close();
  await db.destroy();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ port: config.API_PORT, host: config.API_HOST });
