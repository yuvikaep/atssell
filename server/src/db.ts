import { Kysely, PostgresDialect, sql, type Transaction } from 'kysely';
import pg from 'pg';
import type { Database } from './db-types.js';

// NUMERIC (CTC, experience) and BIGINT (counts, sizes) arrive as strings by default. Values in this
// schema fit safely in a double (NUMERIC(14,2), byte sizes), so parse them as numbers.
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => Number.parseFloat(v));
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number.parseInt(v, 10));
// DATE stays 'YYYY-MM-DD': converting to a JS Date would apply the server's timezone.
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);

export type Db = Kysely<Database>;
export type Tx = Transaction<Database>;

export function createDb(connectionString: string, max = 10): Db {
  const pool = new pg.Pool({ connectionString, max });
  // An idle connection can be cut by the database (a restart, a failover). That must not take the API down:
  // the pool drops the dead connection and the next request opens a new one.
  pool.on('error', (err) => console.error('database connection lost:', err.message));
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}

/**
 * Runs fn in a transaction scoped to one tenant. Row-Level Security uses app.tenant_id, so every
 * query inside fn only sees and writes that tenant's rows. The setting is transaction-local
 * (set_config(..., true)) and cannot leak to the next request that reuses the pooled connection.
 */
export function withTenant<T>(db: Db, tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction().execute(async (tx) => {
    await setTenant(tx, tenantId);
    return fn(tx);
  });
}

export async function setTenant(tx: Tx, tenantId: string): Promise<void> {
  await sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`.execute(tx);
}

/** Exposes rows matched by a token-only RLS policy (sessions, invitations, resets, feedback links). */
export async function setTokenHash(
  tx: Tx,
  setting: 'app.session_token_hash' | 'app.invitation_token_hash' | 'app.reset_token_hash' | 'app.feedback_token_hash',
  hash: string,
): Promise<void> {
  await sql`SELECT set_config(${setting}, ${hash}, true)`.execute(tx);
}

export function pgErrorCode(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null && 'code' in err ? String(err.code) : undefined;
}

export function pgConstraint(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null && 'constraint' in err ? String(err.constraint) : undefined;
}
