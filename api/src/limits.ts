/**
 * Vercel Functions refuse request bodies over 4.5 MB before our code runs, so a larger upload would fail
 * with an unhelpful error. On Vercel the resume limit is therefore capped below that, and the app tells
 * people the real number. Elsewhere the company's own setting applies.
 */
export const VERCEL_BODY_LIMIT_BYTES = 4_000_000;
export const DEFAULT_RESUME_BYTES = 10 * 1024 * 1024;

export function resumeLimit(configuredBytes: number | null | undefined, env: NodeJS.ProcessEnv = process.env): number {
  const wanted = configuredBytes ?? DEFAULT_RESUME_BYTES;
  return env.VERCEL === '1' ? Math.min(wanted, VERCEL_BODY_LIMIT_BYTES) : wanted;
}
