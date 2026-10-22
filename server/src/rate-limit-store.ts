// Rate-limit counters in PostgreSQL, so every API instance shares them. The plugin's default store
// keeps counts in memory, which on serverless hosting means a separate, short-lived count per
// instance: a limit of 10 logins a minute would not hold.
import { sql } from 'kysely';
import type { Db } from './db.js';
import { sha256Hex } from './security.js';

type Callback = (err: Error | null, res: { current: number; ttl: number } | null) => void;
interface RouteOptions { routeInfo?: { method?: string | string[]; url?: string } }

// Expired rows are removed by a small share of requests instead of a separate job.
const CLEANUP_CHANCE = 0.01;

/**
 * Builds a store class for @fastify/rate-limit. Keys are hashed with the salt, so client IPs are
 * never stored. A fixed window per key: the first hit opens it, later hits count until it ends.
 */
export function postgresRateLimitStore(db: Db, salt: string) {
  return class PostgresRateLimitStore {
    private readonly prefix: string;

    constructor(_globalOptions?: unknown, prefix = '') {
      this.prefix = prefix;
    }

    incr(key: string, cb: Callback, timeWindow: number) {
      hit(db, sha256Hex(`${salt}:${this.prefix}${key}`), timeWindow).then(
        (res) => cb(null, res),
        (err: Error) => cb(err, null),
      );
    }

    child(routeOptions: RouteOptions) {
      const method = [routeOptions.routeInfo?.method ?? ''].flat().join(',');
      return new PostgresRateLimitStore(undefined, `${this.prefix}${method}${routeOptions.routeInfo?.url ?? ''}-`);
    }
  };
}

async function hit(db: Db, key: string, timeWindowMs: number) {
  const { rows } = await sql<{ hits: number; ttl: number }>`
    INSERT INTO rate_limit_counters AS c (key, hits, window_ends_at)
    VALUES (${key}, 1, now() + ${timeWindowMs} * interval '1 millisecond')
    ON CONFLICT (key) DO UPDATE SET
      hits = CASE WHEN c.window_ends_at <= now() THEN 1 ELSE c.hits + 1 END,
      window_ends_at = CASE WHEN c.window_ends_at <= now() THEN EXCLUDED.window_ends_at ELSE c.window_ends_at END
    RETURNING hits, GREATEST(0, ceil(extract(epoch FROM c.window_ends_at - now()) * 1000))::int AS ttl
  `.execute(db);
  if (Math.random() < CLEANUP_CHANCE) {
    await sql`DELETE FROM rate_limit_counters WHERE window_ends_at < now() - interval '1 hour'`.execute(db);
  }
  return { current: rows[0]!.hits, ttl: rows[0]!.ttl };
}
