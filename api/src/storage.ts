import { createHmac, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AppError } from './errors.js';

/** Private object storage. Local disk in development; S3 (private bucket) in production. */
export interface ObjectStorage {
  put(key: string, data: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
}

export class LocalDiskStorage implements ObjectStorage {
  constructor(private readonly root: string) {}

  private resolve(key: string) {
    if (!/^[a-z0-9/-]+$/i.test(key) || key.includes('..')) throw new Error('invalid storage key');
    return path.join(this.root, key);
  }

  async put(key: string, data: Buffer) {
    const file = this.resolve(key);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, data, { mode: 0o600 });
  }

  async get(key: string) {
    return readFile(this.resolve(key));
  }
}

/** STORAGE_DRIVER=off: no bucket is configured, so uploads and exports are refused with a clear message. */
export class OffStorage implements ObjectStorage {
  async put(): Promise<void> {
    throw filesNotConfigured();
  }

  async get(): Promise<Buffer> {
    throw filesNotConfigured();
  }
}

export const filesNotConfigured = () =>
  new AppError(503, 'FILES_NOT_CONFIGURED', 'File uploads are not set up on this server yet. Ask your administrator to configure storage and scanning.');

export type ScanResult = 'clean' | 'infected' | 'failed';

/** Malware scanning. ClamAV in a background worker before pilot. */
export interface FileScanner {
  scan(data: Buffer): Promise<ScanResult>;
}

// The standard EICAR antivirus test string, so the infected path can be exercised without malware.
const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

/**
 * Development stub: flags only the EICAR test file. Real scanning replaces this before any real
 * candidate data is stored.
 */
export class DevScanner implements FileScanner {
  constructor(nodeEnv: string) {
    if (nodeEnv === 'production') throw new Error('DevScanner must not be used in production');
  }

  async scan(data: Buffer): Promise<ScanResult> {
    return data.includes(EICAR) ? 'infected' : 'clean';
  }
}

/** SCANNER_DRIVER=off: nothing can be scanned, so no file is accepted. */
/** No malware scan: files are still checked by content type, but nothing looks for viruses. Opt-in only. */
export class NoScanScanner implements FileScanner {
  async scan(): Promise<ScanResult> {
    return 'clean';
  }
}

export class OffScanner implements FileScanner {
  async scan(): Promise<ScanResult> {
    throw filesNotConfigured();
  }
}

// ---- Accepted resume formats, checked by content, not by the client's filename or MIME type ----

export const RESUME_TYPES = {
  pdf: { mime: 'application/pdf', magic: [Buffer.from('%PDF-')] },
  docx: {
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    magic: [Buffer.from([0x50, 0x4b, 0x03, 0x04])],
  },
  doc: { mime: 'application/msword', magic: [Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])] },
} as const;

export function detectResumeType(filename: string, data: Buffer) {
  const ext = path.extname(filename).slice(1).toLowerCase();
  if (!(ext in RESUME_TYPES)) return null;
  const type = RESUME_TYPES[ext as keyof typeof RESUME_TYPES];
  return type.magic.some((m) => data.subarray(0, m.length).equals(m)) ? { ext, mime: type.mime } : null;
}

// ---- Short-lived signed download links ----

interface FileClaims {
  t: string; // tenant id
  d: string; // document id
  e: number; // expiry, unix seconds
  x?: 'export'; // set when `d` is an export job rather than a candidate document
}

export function signFileToken(secret: string, claims: FileClaims): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const sig = createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

/** Returns the claims if the signature is valid and the link has not expired. */
export function verifyFileToken(secret: string, token: string, now = Date.now()): FileClaims | null {
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const expected = createHmac('sha256', secret).update(payload).digest();
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as FileClaims;
    if (typeof claims.t !== 'string' || typeof claims.d !== 'string' || typeof claims.e !== 'number') return null;
    if (claims.x !== undefined && claims.x !== 'export') return null;
    return claims.e * 1000 > now ? claims : null;
  } catch {
    return null;
  }
}
