import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

export const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../db/migrations');

// Tables the web app role may read but never write.
const READ_ONLY_TABLES = ['tenants', 'permissions', 'role_permissions'];
// Tables the web app role may not touch at all.
const NO_ACCESS_TABLES = ['platform_admins', 'schema_migrations'];
// Append-only: insert and read only (also enforced by triggers).
const APPEND_ONLY_TABLES = [
  'audit_events', 'ownership_events', 'application_stage_events', 'feedback', 'feedback_corrections', 'interview_events',
  'duplicate_attempts', 'agency_terms',
];

/**
 * Applies db/migrations/*.sql in filename order, each in its own transaction, then grants the app
 * role its table privileges. Must run as the schema owner. An applied migration whose file changed
 * is an error: write a new migration instead of editing an old one.
 */
export async function migrate(adminUrl: string, appRole: string, log: (msg: string) => void = console.log) {
  if (!/^[a-z_][a-z0-9_]*$/.test(appRole)) throw new Error(`invalid APP_DB_ROLE: ${appRole}`);
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      checksum TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    const applied = new Map(
      (await client.query<{ filename: string; checksum: string }>('SELECT filename, checksum FROM schema_migrations'))
        .rows.map((r) => [r.filename, r.checksum]),
    );

    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      const sqlText = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
      const checksum = createHash('sha256').update(sqlText).digest('hex');
      const previous = applied.get(file);
      if (previous !== undefined) {
        if (previous !== checksum) throw new Error(`migration ${file} was modified after being applied`);
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(sqlText);
        await client.query('INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)', [file, checksum]);
        await client.query('COMMIT');
        log(`applied ${file}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${file} failed: ${(err as Error).message}`);
      }
    }

    const role = `"${appRole}"`;
    await client.query(`
      GRANT USAGE ON SCHEMA public TO ${role};
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role};
      GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${role};
      GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ${role};
      REVOKE INSERT, UPDATE, DELETE ON ${READ_ONLY_TABLES.join(', ')} FROM ${role};
      REVOKE ALL ON ${NO_ACCESS_TABLES.join(', ')} FROM ${role};
      REVOKE UPDATE, DELETE ON ${APPEND_ONLY_TABLES.join(', ')} FROM ${role};
    `);
    log(`granted privileges to ${appRole}`);
  } finally {
    await client.end();
  }
}

/** Drops and recreates the public schema. Test databases only. */
export async function resetDatabase(adminUrl: string) {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    const { rows } = await client.query<{ db: string }>('SELECT current_database() AS db');
    if (!rows[0]?.db.endsWith('_test')) throw new Error(`refusing to reset non-test database ${rows[0]?.db}`);
    await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  } finally {
    await client.end();
  }
}
