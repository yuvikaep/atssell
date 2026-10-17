import path from 'node:path';
import { migrate, resetDatabase } from '../src/migrate.js';

export default async function setup() {
  try { process.loadEnvFile(path.resolve(import.meta.dirname, '../../.env')); } catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; }
  const adminUrl = process.env.TEST_DATABASE_URL_ADMIN;
  if (!adminUrl) throw new Error('TEST_DATABASE_URL_ADMIN is not set');
  await resetDatabase(adminUrl);
  await migrate(adminUrl, process.env.APP_DB_ROLE ?? 'jm_app', () => {});
}
