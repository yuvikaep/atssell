import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

// scrypt N=2^15, r=8, p=3: one of OWASP's equivalent minimum settings, ~32 MiB per hash.
// Parameters are stored in each hash, so they can be raised later without breaking old hashes.
const SCRYPT = { N: 2 ** 15, r: 8, p: 3, keylen: 64 };
const MAXMEM = 128 * SCRYPT.N * SCRYPT.r * 2;

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

/** 256-bit URL-safe random token. */
export function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function hashIp(ip: string, salt: string): string {
  return sha256Hex(`${salt}:${ip}`);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const { N, r, p, keylen } = SCRYPT;
  const key = await scryptAsync(password, salt, keylen, { N, r, p, maxmem: MAXMEM });
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, saltB64, keyB64] = stored.split('$');
  if (scheme !== 'scrypt' || !n || !r || !p || !saltB64 || !keyB64) return false;
  const expected = Buffer.from(keyB64, 'base64');
  const params = { N: Number(n), r: Number(r), p: Number(p) };
  const actual = await scryptAsync(password, Buffer.from(saltB64, 'base64'), expected.length, {
    ...params,
    maxmem: 128 * params.N * params.r * 2,
  });
  return timingSafeEqual(actual, expected);
}

// Verified against when the user does not exist, so response time does not reveal valid emails.
let dummyHash: Promise<string> | undefined;
export function getDummyHash(): Promise<string> {
  dummyHash ??= hashPassword(randomToken());
  return dummyHash;
}
