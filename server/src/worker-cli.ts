// One worker tick for a separately scheduled job, using the same environment as the API.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { createDb } from './db.js';
import { createMailer, createStorage } from './providers/index.js';
import { runTick } from './worker.js';

const config = loadConfig();
const db = createDb(config.DATABASE_URL, 1);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
try {
  console.log(await runTick({
    config,
    db,
    mailer: createMailer(config),
    storage: createStorage(config, root),
    log: (message, extra) => console.info(message, extra ?? {}),
  }));
} finally {
  await db.destroy();
}
