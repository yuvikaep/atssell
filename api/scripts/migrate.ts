import { migrate } from '../src/migrate.js';

const adminUrl = process.argv.includes('--test') ? process.env.TEST_DATABASE_URL_ADMIN : process.env.DATABASE_URL_ADMIN;
if (!adminUrl) throw new Error('DATABASE_URL_ADMIN (or TEST_DATABASE_URL_ADMIN with --test) is not set');

await migrate(adminUrl, process.env.APP_DB_ROLE ?? 'jm_app');
console.log('migrations up to date');
