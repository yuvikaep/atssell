import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Config } from '../config.js';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, hashIp } from '../security.js';
import { SESSION_COOKIE } from '../services/sessions.js';

export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Use at least ${PASSWORD_MIN_LENGTH} characters.`)
  .max(PASSWORD_MAX_LENGTH);

export const tokenSchema = z.string().min(20).max(200);
export const idParams = z.object({ id: z.uuid() });

export const pageQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(25),
});

/** Rate limit for public, unauthenticated endpoints: per IP. */
export const publicRateLimit = (max: number) => ({ rateLimit: { max, timeWindow: '1 minute' } });

export function setSessionCookie(reply: FastifyReply, config: Config, token: string, expiresAt: Date) {
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: config.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    expires: expiresAt,
  });
}

export function clearSessionCookie(reply: FastifyReply) {
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
}

export function requestIpHash(req: FastifyRequest) {
  return hashIp(req.ip, req.server.config.IP_HASH_SALT);
}
