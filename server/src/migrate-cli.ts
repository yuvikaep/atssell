// Production migration entry point (compiled with the API): node server/dist/migrate-cli.js
import { migrate } from './migrate.js';

// DATABASE_URL_UNPOOLED is the owner connection Vercel's Neon integration adds.
const adminUrl = process.env.DATABASE_URL_ADMIN || process.env.DATABASE_URL_UNPOOLED;
if (!adminUrl) throw new Error('DATABASE_URL_ADMIN is not set');
await migrate(adminUrl, process.env.APP_DB_ROLE ?? 'jm_app', console.log, process.env.APP_DB_PASSWORD);
console.log('migrations up to date');
