// Production migration entry point (compiled with the API): node api/dist/migrate-cli.js
import { migrate } from './migrate.js';

const adminUrl = process.env.DATABASE_URL_ADMIN;
if (!adminUrl) throw new Error('DATABASE_URL_ADMIN is not set');
await migrate(adminUrl, process.env.APP_DB_ROLE ?? 'jm_app');
console.log('migrations up to date');
