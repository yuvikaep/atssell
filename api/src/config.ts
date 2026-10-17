import { z } from 'zod';

const ConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().int().positive().default(3000),
  // 0.0.0.0 inside containers; loopback only for local development.
  API_HOST: z.string().default('127.0.0.1'),
  DATABASE_URL: z.string().min(1),
  WEB_ORIGIN: z.string().url(),
  SESSION_TTL_HOURS: z.coerce.number().positive().default(12),
  INVITATION_TTL_HOURS: z.coerce.number().positive().default(72),
  PASSWORD_RESET_TTL_MINUTES: z.coerce.number().positive().default(60),
  IP_HASH_SALT: z.string().min(1),
  // Relative paths resolve from the repository root.
  STORAGE_DIR: z.string().default('.storage'),
  FILE_URL_SECRET: z.string().min(16),
  // Outside services. The defaults are for local development only; production must name real ones.
  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  S3_BUCKET: z.string().min(1).optional(),
  S3_REGION: z.string().default('ap-south-1'),
  S3_ENDPOINT: z.string().url().optional(),
  S3_PREFIX: z.string().regex(/^([a-z0-9-]+\/)*$/i).default(''),
  SCANNER_DRIVER: z.enum(['dev', 'clamav']).default('dev'),
  CLAMAV_HOST: z.string().default('127.0.0.1'),
  CLAMAV_PORT: z.coerce.number().int().positive().default(3310),
  MAIL_DRIVER: z.enum(['console', 'smtp']).default('console'),
  SMTP_URL: z.string().min(1).optional(),
  MAIL_FROM: z.string().min(3).optional(),
  FILE_URL_TTL_SECONDS: z.coerce.number().int().min(30).max(3600).default(300),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const config = ConfigSchema.parse(env);
  if (config.STORAGE_DRIVER === 's3' && !config.S3_BUCKET) throw new Error('S3_BUCKET is required when STORAGE_DRIVER=s3');
  if (config.MAIL_DRIVER === 'smtp' && (!config.SMTP_URL || !config.MAIL_FROM)) throw new Error('SMTP_URL and MAIL_FROM are required when MAIL_DRIVER=smtp');
  if (config.NODE_ENV === 'production') {
    if (config.STORAGE_DRIVER !== 's3') throw new Error('Production needs STORAGE_DRIVER=s3: local disk is for development');
    if (config.SCANNER_DRIVER !== 'clamav') throw new Error('Production needs SCANNER_DRIVER=clamav: the dev scanner only catches the EICAR test file');
    if (config.MAIL_DRIVER !== 'smtp') throw new Error('Production needs MAIL_DRIVER=smtp: the console mailer prints live links');
    if (config.IP_HASH_SALT.startsWith('dev-only')) throw new Error('IP_HASH_SALT must be set to a random value in production');
    if (config.FILE_URL_SECRET.startsWith('dev-only')) throw new Error('FILE_URL_SECRET must be set to a random value in production');
  }
  return config;
}
