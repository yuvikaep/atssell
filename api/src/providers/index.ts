// Picks the real or development implementation of each outside service from configuration.
import path from 'node:path';
import { S3Client } from '@aws-sdk/client-s3';
import nodemailer from 'nodemailer';
import type { Config } from '../config.js';
import { ConsoleMailer, OffMailer, type Mailer } from '../mailer.js';
import { DevScanner, LocalDiskStorage, OffScanner, OffStorage, type FileScanner, type ObjectStorage } from '../storage.js';
import { ClamAvScanner } from './clamav.js';
import { S3Storage } from './s3.js';
import { SmtpMailer } from './smtp.js';

export function createStorage(config: Config, repoRoot: string): ObjectStorage {
  if (config.STORAGE_DRIVER === 's3') {
    const client = new S3Client({ region: config.S3_REGION, ...(config.S3_ENDPOINT ? { endpoint: config.S3_ENDPOINT, forcePathStyle: true } : {}) });
    return new S3Storage(client, config.S3_BUCKET!, config.S3_PREFIX);
  }
  if (config.STORAGE_DRIVER === 'off') return new OffStorage();
  return new LocalDiskStorage(path.resolve(repoRoot, config.STORAGE_DIR));
}

export function createScanner(config: Config): FileScanner {
  if (config.SCANNER_DRIVER === 'clamav') return new ClamAvScanner({ host: config.CLAMAV_HOST, port: config.CLAMAV_PORT });
  if (config.SCANNER_DRIVER === 'off') return new OffScanner();
  return new DevScanner(config.NODE_ENV);
}

export function createMailer(config: Config): Mailer {
  if (config.MAIL_DRIVER === 'smtp') return new SmtpMailer(nodemailer.createTransport(config.SMTP_URL!), config.MAIL_FROM!);
  if (config.MAIL_DRIVER === 'off') return new OffMailer();
  return new ConsoleMailer(config.NODE_ENV);
}
