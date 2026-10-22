import { randomUUID } from 'node:crypto';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import multipart from '@fastify/multipart';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import type { Config } from './config.js';
import type { Db } from './db.js';
import { AppError, errorHandler, unauthenticated } from './errors.js';
import type { Mailer } from './mailer.js';
import type { Principal } from './permissions.js';
import { analyticsRoutes } from './routes/analytics.js';
import { candidateStatusRoutes } from './routes/candidate-status.js';
import { candidateMasterRoutes } from './routes/candidate-master.js';
import { leaderboardRoutes } from './routes/leaderboards.js';
import { employmentRoutes } from './routes/employment.js';
import { ownershipCorrectionRoutes } from './routes/ownership-correction.js';
import { agencyTermsRoutes } from './routes/agency-terms.js';
import { cronRoutes } from './routes/cron.js';
import { jobRoutes } from './routes/jobs.js';
import { hiringHomeRoutes } from './routes/hiring-home.js';
import { offerRoutes } from './routes/offers.js';
import { exportRoutes } from './routes/exports.js';
import { applicationRoutes } from './routes/applications.js';
import { agencyRoutes } from './routes/agencies.js';
import { agencyMemberRoutes } from './routes/agency-members.js';
import { agencyPolicyRoutes } from './routes/agency-policy.js';
import { agencyPortalRoutes } from './routes/agency-portal.js';
import { authRoutes } from './routes/auth.js';
import { candidateRoutes, fileRoutes } from './routes/candidates.js';
import { departmentRoutes } from './routes/departments.js';
import { jobRoleRoutes } from './routes/job-roles.js';
import { feedbackRoutes, publicFeedbackRoutes } from './routes/feedback.js';
import { interviewRoutes } from './routes/interviews.js';
import { invitationPublicRoutes } from './routes/invitations.js';
import { meRoutes } from './routes/me.js';
import { notificationRoutes } from './routes/notifications.js';
import { requisitionRoutes } from './routes/requisitions.js';
import { userRoutes } from './routes/users.js';
import { vacancyRoutes } from './routes/vacancies.js';
import { resolveSession, SESSION_COOKIE } from './services/sessions.js';
import type { FileScanner, ObjectStorage } from './storage.js';

export interface RouteEntry { method: string; url: string; authenticated: boolean }

declare module 'fastify' {
  interface FastifyInstance {
    routeTable: RouteEntry[];
    config: Config;
    db: Db;
    mailer: Mailer;
    storage: ObjectStorage;
    scanner: FileScanner;
  }
  interface FastifyRequest {
    principal: Principal | null;
  }
}

export interface AppDeps {
  config: Config;
  db: Db;
  mailer: Mailer;
  storage: ObjectStorage;
  scanner: FileScanner;
  logger?: boolean;
  /** Called after each signed-in request. Serverless hosting uses it to run background work. */
  afterAuthenticatedRequest?: (tenantId: string) => void;
}

/** The authenticated principal; only call inside routes registered under the authenticated scope. */
export function principal(req: FastifyRequest): Principal {
  if (!req.principal) throw unauthenticated();
  return req.principal;
}

export async function buildApp({ config, db, mailer, storage, scanner, logger = true, afterAuthenticatedRequest }: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: logger && {
      level: config.NODE_ENV === 'production' ? 'info' : 'debug',
      // Never log cookies, auth headers or request bodies (bodies carry passwords and tokens).
      redact: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]'],
    },
    genReqId: () => randomUUID(),
    trustProxy: config.NODE_ENV === 'production',
    bodyLimit: 1024 * 1024,
    // Signed download links are ~180 characters; the default limit is 100.
    routerOptions: { maxParamLength: 512 },
  });

  app.decorate('config', config);
  app.decorate('db', db);
  app.decorate('mailer', mailer);
  app.decorate('storage', storage);
  app.decorate('scanner', scanner);
  app.decorateRequest('principal', null);

  // Every route and whether it sits behind the session check. The security tests walk this table, so a
  // route added without authentication is caught instead of assumed.
  const routeTable: RouteEntry[] = [];
  app.decorate('routeTable', routeTable);
  app.addHook('onRoute', (r) => {
    for (const method of [r.method].flat()) if (method !== 'HEAD' && method !== 'OPTIONS') routeTable.push({ method, url: r.url, authenticated: false });
  });

  await app.register(helmet, {
    referrerPolicy: { policy: 'no-referrer' },
    contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
  });
  await app.register(cookie);
  await app.register(rateLimit, { global: false });
  // Per-file size limits are applied per route from tenant settings; this is the hard ceiling.
  await app.register(multipart, { limits: { fileSize: 25 * 1024 * 1024, files: 1, fields: 10 } });

  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler((req, reply) =>
    reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Route not found.', request_id: req.id } }),
  );

  app.addHook('onSend', async (_req, reply) => {
    // Reference lists (such as locations) set their own caching; everything else is never stored.
    if (!reply.hasHeader('cache-control')) reply.header('cache-control', 'no-store');
    reply.header('x-request-id', _req.id);
  });

  // CSRF defence for cookie auth: the session cookie is SameSite=Lax, and state-changing requests
  // from a browser must come from the web app's origin.
  app.addHook('onRequest', async (req) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return;
    const origin = req.headers.origin;
    if (origin !== undefined && !config.ALLOWED_ORIGINS.includes(origin)) {
      throw new AppError(403, 'BAD_ORIGIN', 'Request origin not allowed.');
    }
  });

  app.get('/health', async () => ({ status: 'ok' }));

  await app.register(
    async (api) => {
      // Public routes: no session. Each one is rate limited individually.
      await api.register(authRoutes);
      await api.register(invitationPublicRoutes);
      await api.register(fileRoutes);
      await api.register(cronRoutes);
      await api.register(publicFeedbackRoutes);

      // Authenticated routes.
      await api.register(async (authed) => {
        authed.addHook('onRoute', (r) => {
          for (const e of routeTable) if (e.url === r.url && [r.method].flat().includes(e.method)) e.authenticated = true;
        });
        // Checked before the body is read, so an anonymous caller cannot make the server parse uploads.
        authed.addHook('onRequest', async (req) => {
          const token = req.cookies[SESSION_COOKIE];
          const p = token ? await resolveSession(db, token) : null;
          if (!p) throw unauthenticated();
          req.principal = p;
        });
        if (afterAuthenticatedRequest) authed.addHook('onResponse', async (req) => { if (req.principal) afterAuthenticatedRequest(req.principal.tenantId); });
        await authed.register(meRoutes);
        await authed.register(departmentRoutes);
        await authed.register(jobRoleRoutes);
        await authed.register(userRoutes);
        await authed.register(requisitionRoutes);
        await authed.register(vacancyRoutes);
        await authed.register(agencyRoutes);
        await authed.register(agencyMemberRoutes);
        await authed.register(agencyPortalRoutes);
        await authed.register(agencyPolicyRoutes);
        await authed.register(candidateRoutes);
        await authed.register(applicationRoutes);
        await authed.register(interviewRoutes);
        await authed.register(feedbackRoutes);
        await authed.register(notificationRoutes);
        await authed.register(analyticsRoutes);
        await authed.register(exportRoutes);
        await authed.register(offerRoutes);
        await authed.register(hiringHomeRoutes);
        await authed.register(candidateStatusRoutes);
        await authed.register(jobRoutes);
        await authed.register(agencyTermsRoutes);
        await authed.register(employmentRoutes);
        await authed.register(leaderboardRoutes);
        await authed.register(candidateMasterRoutes);
        await authed.register(ownershipCorrectionRoutes);
      });
    },
    { prefix: '/api/v1' },
  );

  return app;
}
