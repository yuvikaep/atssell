import { randomBytes } from 'node:crypto';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createDb, type Db } from '../src/db.js';
import { MemoryMailer } from '../src/mailer.js';
import { hashPassword } from '../src/security.js';
import { DevScanner, type ObjectStorage } from '../src/storage.js';
import { createTenant } from '../src/services/tenants.js';

// Local runs read .env; CI provides the same variables directly.
try { process.loadEnvFile(path.resolve(import.meta.dirname, '../../.env')); } catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; }

export const PASSWORD = 'correct-horse-battery';
export const WEB_ORIGIN = 'http://localhost:5180';
let passwordHash: Promise<string> | undefined;

export class MemoryStorage implements ObjectStorage {
  files = new Map<string, Buffer>();
  async put(key: string, data: Buffer) {
    this.files.set(key, data);
  }
  async get(key: string) {
    const f = this.files.get(key);
    if (!f) throw new Error('missing object');
    return f;
  }
}

export interface TestContext {
  app: FastifyInstance;
  storage: MemoryStorage;
  mailer: MemoryMailer;
  appDb: Db;
  /** Owner connection: bypasses RLS. Only for arranging test data and inspecting results. */
  adminDb: Db;
  close(): Promise<void>;
}

export async function setupApp(opts: { env?: Record<string, string>; afterAuthenticatedRequest?: (tenantId: string) => void; rateLimitStore?: (db: Db) => unknown } = {}): Promise<TestContext> {
  const config = loadConfig({
    ...process.env,
    NODE_ENV: 'test',
    DATABASE_URL: process.env.TEST_DATABASE_URL,
    WEB_ORIGIN,
    ...opts.env,
  });
  const appDb = createDb(config.DATABASE_URL, 5);
  const adminDb = createDb(process.env.TEST_DATABASE_URL_ADMIN!, 2);
  const mailer = new MemoryMailer();
  const storage = new MemoryStorage();
  const app = await buildApp({ config, db: appDb, mailer, storage, scanner: new DevScanner('test'), logger: false, afterAuthenticatedRequest: opts.afterAuthenticatedRequest, rateLimitStore: opts.rateLimitStore?.(appDb) });
  return {
    app,
    storage,
    mailer,
    appDb,
    adminDb,
    async close() {
      await app.close();
      await appDb.destroy();
      await adminDb.destroy();
    },
  };
}

export function uniqueSlug(prefix: string) {
  return `${prefix}-${randomBytes(4).toString('hex')}`;
}

/** A company whose admin already has PASSWORD set. */
export async function createCompany(ctx: TestContext, prefix = 'co') {
  const slug = uniqueSlug(prefix);
  const result = await createTenant(ctx.adminDb, {
    name: `Company ${slug}`,
    slug,
    adminEmail: `admin@${slug}.test`,
    adminName: 'Admin User',
  });
  passwordHash ??= hashPassword(PASSWORD);
  await ctx.adminDb.updateTable('users').set({ password_hash: await passwordHash }).where('id', '=', result.admin.id).execute();
  return { ...result, slug };
}

export async function addUser(
  ctx: TestContext,
  tenantId: string,
  input: { email: string; role: string; departmentId?: string | null; status?: 'active' | 'inactive' },
) {
  passwordHash ??= hashPassword(PASSWORD);
  const user = await ctx.adminDb
    .insertInto('users')
    .values({ tenant_id: tenantId, email: input.email, full_name: input.email.split('@')[0]!, password_hash: await passwordHash, status: input.status ?? 'active' })
    .returning('id')
    .executeTakeFirstOrThrow();
  const role = await ctx.adminDb.selectFrom('roles').select('id').where('code', '=', input.role).where('tenant_id', 'is', null).executeTakeFirstOrThrow();
  await ctx.adminDb
    .insertInto('user_role_assignments')
    .values({ tenant_id: tenantId, user_id: user.id, role_id: role.id, department_id: input.departmentId ?? null })
    .execute();
  return user;
}

export async function addDepartment(ctx: TestContext, tenantId: string, name: string, parentId: string | null = null) {
  return ctx.adminDb
    .insertInto('departments')
    .values({ tenant_id: tenantId, name, parent_department_id: parentId })
    .returning('id')
    .executeTakeFirstOrThrow();
}

export function sessionCookie(res: { cookies: { name: string; value: string }[] }): string {
  const c = res.cookies.find((x) => x.name === 'jm_session');
  if (!c) throw new Error('no session cookie in response');
  return `jm_session=${c.value}`;
}

let ipCounter = 0;
/** A distinct client IP per call, so per-IP rate limits on public routes don't trip unrelated tests. */
export function nextIp() {
  ipCounter += 1;
  return `10.0.${Math.floor(ipCounter / 250)}.${(ipCounter % 250) + 1}`;
}

export async function login(ctx: TestContext, company: string, email: string, password = PASSWORD) {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    remoteAddress: nextIp(),
    payload: { company, email, password },
  });
  if (res.statusCode !== 200) throw new Error(`login failed: ${res.statusCode} ${res.body}`);
  return sessionCookie(res);
}

/** Calls the API as a browser on the web origin would. */
export function call(ctx: TestContext, cookie: string | null, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: unknown) {
  return ctx.app.inject({
    method,
    url: `/api/v1${url}`,
    headers: { ...(cookie ? { cookie } : {}), ...(method === 'GET' ? {} : { origin: WEB_ORIGIN }) },
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
}
