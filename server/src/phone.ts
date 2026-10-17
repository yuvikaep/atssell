import { z } from 'zod';

/**
 * Normalizes to E.164 so the same number always matches. Bare 10-digit numbers and 0-prefixed
 * numbers are treated as Indian (+91), the tenant default; anything else must include a country code.
 */
export function normalizePhone(raw: string): string | null {
  const trimmed = raw.trim();
  const digits = trimmed.replace(/\D/g, '');
  let e164: string;
  if (trimmed.startsWith('+')) e164 = `+${digits}`;
  else if (digits.length === 10) e164 = `+91${digits}`;
  else if (digits.length === 11 && digits.startsWith('0')) e164 = `+91${digits.slice(1)}`;
  else if (digits.length === 12 && digits.startsWith('91')) e164 = `+${digits}`;
  else return null;
  return /^\+[1-9]\d{7,14}$/.test(e164) ? e164 : null;
}

export const phoneSchema = z
  .string()
  .max(30)
  .transform((v, ctx) => {
    const n = normalizePhone(v);
    if (!n) ctx.addIssue({ code: 'custom', message: 'Enter a valid phone number, with country code if outside India.' });
    return n ?? '';
  });
