import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertRlsEnforced, RlsBypassError } from '../src/db.js';
import { postgresRateLimitStore } from '../src/rate-limit-store.js';
import { setupApp, type TestContext } from './helpers.js';

const SALT = 'test-rate-limit-salt';

// Two API instances, as on serverless hosting: each has its own memory, they share the database.
let a: TestContext;
let b: TestContext;

beforeAll(async () => {
  a = await setupApp({ rateLimitStore: (db) => postgresRateLimitStore(db, SALT) });
  b = await setupApp({ rateLimitStore: (db) => postgresRateLimitStore(db, SALT) });
});
afterAll(async () => {
  await a.close();
  await b.close();
});

const attempt = (ctx: TestContext, remoteAddress: string) =>
  ctx.app.inject({ method: 'POST', url: '/api/v1/auth/login', remoteAddress, payload: { company: 'nobody', email: 'x@nobody.test', password: 'wrong-password' } });

describe('rate limits shared through the database', () => {
  it('counts one client across every instance, so the login limit holds on serverless hosting', async () => {
    const ip = '10.250.1.1';
    const statuses: number[] = [];
    for (let i = 0; i < 10; i++) statuses.push((await attempt(i % 2 ? a : b, ip)).statusCode);
    expect(statuses.every((s) => s === 401)).toBe(true);
    expect((await attempt(a, ip)).statusCode).toBe(429);
    expect((await attempt(b, ip)).statusCode).toBe(429);
    // Another client is not affected.
    expect((await attempt(b, '10.250.1.2')).statusCode).toBe(401);
  });

  it('keeps separate counts per route and never stores the client IP', async () => {
    const ip = '10.250.2.1';
    for (let i = 0; i < 10; i++) await attempt(a, ip);
    expect((await attempt(a, ip)).statusCode).toBe(429);
    const reset = await b.app.inject({ method: 'POST', url: '/api/v1/auth/password-reset/request', remoteAddress: ip, payload: { company: 'nobody', email: 'x@nobody.test' } });
    expect(reset.statusCode).toBe(202);
    const keys = await sql<{ key: string }>`SELECT key FROM rate_limit_counters`.execute(a.adminDb);
    expect(keys.rows.length).toBeGreaterThan(0);
    expect(keys.rows.some((r) => r.key.includes('10.250'))).toBe(false);
  });

  it('starts a fresh window once the old one has ended', async () => {
    const ip = '10.250.3.1';
    for (let i = 0; i < 11; i++) await attempt(a, ip);
    expect((await attempt(a, ip)).statusCode).toBe(429);
    await sql`UPDATE rate_limit_counters SET window_ends_at = now() - interval '1 second'`.execute(a.adminDb);
    expect((await attempt(b, ip)).statusCode).toBe(401);
  });
});

describe('database role check at startup', () => {
  it('accepts the restricted app role', async () => {
    await expect(assertRlsEnforced(a.appDb)).resolves.toBeUndefined();
  });

  it('refuses a role that bypasses row-level security', async () => {
    await expect(assertRlsEnforced(a.adminDb)).rejects.toThrow(RlsBypassError);
    await expect(assertRlsEnforced(a.adminDb)).rejects.toThrow(/bypasses row-level security/);
  });
});
