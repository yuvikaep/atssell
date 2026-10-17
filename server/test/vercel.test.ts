// What hosting on Vercel (serverless functions) relies on: the scheduler endpoint, background work driven
// by traffic, origin handling, the upload cap, and the HTTP scanning service.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { resumeLimit, VERCEL_BODY_LIMIT_BYTES } from '../src/limits.js';
import { HttpScanner } from '../src/providers/http-scanner.js';
import { serverlessWorker } from '../src/serverless.js';
import { call, setupApp, WEB_ORIGIN, type TestContext } from './helpers.js';
import { setupCompany } from './hiring-helpers.js';

const base = { DATABASE_URL: 'postgres://x', WEB_ORIGIN: 'https://app.example.com', IP_HASH_SALT: 'a-random-salt-value', FILE_URL_SECRET: 'a-random-secret-value-123' };

describe('the scheduler endpoint', () => {
  let off: TestContext;
  let on: TestContext;
  const SECRET = 'cron-secret-value-0123456789';
  beforeAll(async () => { off = await setupApp(); on = await setupApp({ env: { CRON_SECRET: SECRET } }); });
  afterAll(async () => { await off.close(); await on.close(); });
  const hit = (ctx: TestContext, method: 'GET' | 'POST', auth?: string) => ctx.app.inject({ method, url: '/api/v1/cron/worker', headers: auth ? { authorization: auth } : {} });

  it('does not exist unless a secret is configured', async () => {
    expect((await hit(off, 'GET', `Bearer ${SECRET}`)).statusCode).toBe(404);
  });

  it('refuses a missing or wrong secret, and runs one pass for the right one', async () => {
    expect((await hit(on, 'GET')).statusCode).toBe(401);
    expect((await hit(on, 'GET', 'Bearer wrong-secret-value-0123456789')).statusCode).toBe(401);
    expect((await hit(on, 'GET', SECRET)).statusCode).toBe(401); // the Bearer prefix is required
    const ok = await hit(on, 'GET', `Bearer ${SECRET}`);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().data).toMatchObject({ tenants: expect.any(Number), emailsSent: expect.any(Number) });
    expect((await hit(on, 'POST', `Bearer ${SECRET}`)).statusCode).toBe(200);
  });
});

describe('background work on serverless hosting', () => {
  it('runs one pass per company at most once a minute, after signed-in requests only', async () => {
    const passes: string[] = [];
    let clock = 1_000_000;
    const pending: Promise<unknown>[] = [];
    const ctx = await setupApp({
      afterAuthenticatedRequest: serverlessWorker(
        { db: undefined as never, mailer: undefined as never, config: undefined as never, storage: undefined as never, log: () => {} },
        { waitUntil: (p) => pending.push(p), now: () => clock },
      ),
    });
    try {
      const s = await setupCompany(ctx, 'sv');
      const cookie = await s.as('admin');
      const before = pending.length; // the sign-in itself is not a signed-in request
      await call(ctx, cookie, 'GET', '/me');
      expect(pending.length - before).toBe(1);
      await call(ctx, cookie, 'GET', '/me');
      expect(pending.length - before).toBe(1); // inside the minute
      clock += 61_000;
      await call(ctx, cookie, 'GET', '/me');
      expect(pending.length - before).toBe(2);
      await call(ctx, null, 'GET', '/me');
      expect(pending.length - before).toBe(2); // anonymous traffic never triggers it
      await Promise.allSettled(pending); // failures are logged, never thrown into the request
      passes.push('ok');
    } finally {
      await ctx.close();
    }
    expect(passes).toEqual(['ok']);
  });
});

describe('origins', () => {
  it('the API accepts a listed extra origin and still refuses strangers', async () => {
    const ctx = await setupApp({ env: { EXTRA_ORIGINS: 'https://jobs.example.com' } });
    try {
      const post = (origin: string) => ctx.app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: { origin } });
      expect((await post('https://jobs.example.com')).statusCode).not.toBe(403);
      expect((await post(WEB_ORIGIN)).statusCode).not.toBe(403);
      expect((await post('https://evil.example.com')).json().error.code).toBe('BAD_ORIGIN');
    } finally { await ctx.close(); }
  });
});

describe('upload limit', () => {
  it('is capped below the Vercel request limit on Vercel, and the company setting applies elsewhere', () => {
    expect(resumeLimit(10 * 1024 * 1024, { VERCEL: '1' })).toBe(VERCEL_BODY_LIMIT_BYTES);
    expect(resumeLimit(2_000_000, { VERCEL: '1' })).toBe(2_000_000);
    expect(resumeLimit(10 * 1024 * 1024, {})).toBe(10 * 1024 * 1024);
    expect(resumeLimit(null, {})).toBe(10 * 1024 * 1024);
  });

  it('the app tells the web client the real limit', async () => {
    const ctx = await setupApp();
    try {
      const s = await setupCompany(ctx, 'lm');
      const me = (await call(ctx, await s.as('admin'), 'GET', '/me')).json().data;
      expect(me.limits.resume_max_bytes).toBeGreaterThan(0);
    } finally { await ctx.close(); }
  });
});

describe('HTTP scanning service', () => {
  const scan = (fetchImpl: typeof fetch) => new HttpScanner({ url: 'https://scan.example.com/scan', token: 'token-0123456789abcdef', fetchImpl }).scan(Buffer.from('data'));
  const reply = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  it('trusts only a clear clean or infected answer, and sends the token and the bytes', async () => {
    let seen: { auth: string | null; body: number } | null = null;
    const spy = (async (_u: unknown, init: RequestInit) => { seen = { auth: new Headers(init.headers).get('authorization'), body: (init.body as Uint8Array).length }; return new Response(JSON.stringify({ status: 'clean' })); }) as unknown as typeof fetch;
    expect(await scan(spy)).toBe('clean');
    expect(seen).toEqual({ auth: 'Bearer token-0123456789abcdef', body: 4 });
    expect(await scan(reply(200, { status: 'infected' }))).toBe('infected');
    expect(await scan(reply(200, { status: 'maybe' }))).toBe('failed');
    expect(await scan(reply(500, { status: 'clean' }))).toBe('failed');
    expect(await scan((async () => { throw new Error('network down'); }) as unknown as typeof fetch)).toBe('failed');
  });
});

describe('production configuration for Vercel', () => {
  const prod = { ...base, NODE_ENV: 'production', STORAGE_DRIVER: 's3', S3_BUCKET: 'b', MAIL_DRIVER: 'smtp', SMTP_URL: 'smtp://h', MAIL_FROM: 'a@b.test' };
  it('accepts the HTTP scanner only with a URL, a token and https', () => {
    expect(() => loadConfig({ ...prod, SCANNER_DRIVER: 'http' })).toThrow(/SCANNER_URL/);
    expect(() => loadConfig({ ...prod, SCANNER_DRIVER: 'http', SCANNER_URL: 'http://scan.example.com', SCANNER_TOKEN: 'token-0123456789abcdef' })).toThrow(/https/);
    expect(loadConfig({ ...prod, SCANNER_DRIVER: 'http', SCANNER_URL: 'https://scan.example.com', SCANNER_TOKEN: 'token-0123456789abcdef' }).SCANNER_DRIVER).toBe('http');
    expect(() => loadConfig({ ...prod, SCANNER_DRIVER: 'dev' })).toThrow(/clamav/);
  });
  it('uses a connected Vercel Blob store and the restricted app role', () => {
    const vercel = { ...base, NODE_ENV: 'production', STORAGE_DRIVER: undefined, BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_x', DATABASE_URL: 'postgres://owner:secret@db.example.com/app?sslmode=require', APP_DB_PASSWORD: 'p@ss/word' };
    const config = loadConfig(vercel);
    expect(config.STORAGE_DRIVER).toBe('blob');
    expect(new URL(config.DATABASE_URL).username).toBe('jm_app');
    expect(decodeURIComponent(new URL(config.DATABASE_URL).password)).toBe('p@ss/word');
    expect(config.DATABASE_URL).toContain('sslmode=require');
    expect(() => loadConfig({ ...vercel, BLOB_READ_WRITE_TOKEN: undefined, STORAGE_DRIVER: 'blob' })).toThrow(/BLOB_READ_WRITE_TOKEN/);
    expect(loadConfig({ ...vercel, SCANNER_DRIVER: 'none' }).SCANNER_DRIVER).toBe('none');
  });
  it('limits the pool and validates the cron secret', () => {
    expect(loadConfig({ ...base, DB_POOL_MAX: '3' }).DB_POOL_MAX).toBe(3);
    expect(() => loadConfig({ ...base, DB_POOL_MAX: '0' })).toThrow();
    expect(() => loadConfig({ ...base, CRON_SECRET: 'short' })).toThrow();
  });
});
