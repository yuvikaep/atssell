import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';

export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export const unauthenticated = () => new AppError(401, 'UNAUTHENTICATED', 'Sign in to continue.');
export const forbidden = () => new AppError(403, 'FORBIDDEN', 'You do not have permission to do this.');
export const notFound = (what = 'Resource') => new AppError(404, 'NOT_FOUND', `${what} not found.`);

/** A database that is unreachable or has no tables is a deployment problem; say so instead of a bare 500. */
function databaseSetupProblem(err: unknown): string | null {
  const code = typeof err === 'object' && err !== null && 'code' in err ? String(err.code) : '';
  if (code === '42P01') return 'The database has no tables yet. Run the migrations (see docs/VERCEL.md).';
  if (code === '28P01' || code === '28000' || code === '3D000') return 'The API cannot sign in to the database. Check DATABASE_URL.';
  if (['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET'].includes(code)) return 'The API cannot reach the database. Check DATABASE_URL.';
  return null;
}

/** Error body per api_contract.md: { error: { code, message, request_id } }. */
export function errorHandler(err: FastifyError | Error, req: FastifyRequest, reply: FastifyReply) {
  const send = (status: number, code: string, message: string, details?: unknown) =>
    reply.status(status).send({ error: { code, message, request_id: req.id, ...(details ? { details } : {}) } });

  if (err instanceof AppError) {
    return send(err.status, err.code, err.message, err.details);
  }
  if (err instanceof ZodError) {
    return send(400, 'VALIDATION_ERROR', 'Some fields are invalid.', err.issues.map((i) => ({
      path: i.path.join('.'),
      message: i.message,
    })));
  }
  const statusCode = (err as FastifyError).statusCode;
  if (statusCode === 429) {
    return send(429, 'RATE_LIMITED', 'Too many attempts. Try again shortly.');
  }
  if (statusCode && statusCode >= 400 && statusCode < 500) {
    return send(statusCode, 'BAD_REQUEST', err.message);
  }
  const setup = databaseSetupProblem(err);
  if (setup) {
    req.log.error({ err }, 'database not ready');
    return send(503, 'DATABASE_NOT_READY', setup);
  }
  req.log.error({ err }, 'unhandled error');
  return send(500, 'INTERNAL_ERROR', 'Something went wrong.');
}
