import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';

/**
 * Stands in for the API when its settings are invalid: instead of a crashed function that only says
 * FUNCTION_INVOCATION_FAILED, every request gets 503 naming the settings to fix (names only, never values).
 */
export function misconfiguredApp(err: unknown): FastifyInstance {
  const problems = err instanceof ZodError
    ? err.issues.map((i) => `${i.path.join('.')}: ${i.message}`)
    : [(err as Error).message];
  console.error(`API configuration is invalid:\n  ${problems.join('\n  ')}`);
  const app = Fastify();
  app.all('/*', async (req, reply) => reply.status(503).send({
    error: { code: 'SERVER_MISCONFIGURED', message: 'The API is missing required settings. Set them in the Vercel project and redeploy.', details: problems, request_id: req.id },
  }));
  return app;
}
