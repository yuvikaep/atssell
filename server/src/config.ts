import { z } from 'zod';

const ConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().int().positive().default(3000),
  // 0.0.0.0 inside containers; loopback only for local development.
  API_HOST: z.string().default('127.0.0.1'),
  DATABASE_URL: z.string().min(1),
  // On Vercel it defaults to the project's production domain.
  WEB_ORIGIN: z.string().url(),
  // Extra origins (comma separated), e.g. a custom domain.
  EXTRA_ORIGINS: z.string().optional(),
  // Connections per API instance; keep small on serverless.
  DB_POOL_MAX: z.coerce.number().int().min(1).max(50).default(10),
  // Enables /cron/worker for a scheduler (Vercel Cron sends it as a Bearer token).
  CRON_SECRET: z.string().min(16).optional(),
  SESSION_TTL_HOURS: z.coerce.number().positive().default(12),
  INVITATION_TTL_HOURS: z.coerce.number().positive().default(72),
  PASSWORD_RESET_TTL_MINUTES: z.coerce.number().positive().default(60),
  IP_HASH_SALT: z.string().min(1),
  // Relative paths resolve from the repository root.
  STORAGE_DIR: z.string().default('.storage'),
  FILE_URL_SECRET: z.string().min(16),
  // Outside services. Unset, they default to the development stubs, or to 'off' in production: an
  // 'off' service refuses the feature that needs it (uploads, exports, email) instead of the API failing to start.
  // 'blob': Vercel Blob, private; the token is added by Vercel when a Blob store is connected.
  STORAGE_DRIVER: z.enum(['local', 's3', 'blob', 'off']).optional(),
  BLOB_READ_WRITE_TOKEN: z.string().min(1).optional(),
  S3_BUCKET: z.string().min(1).optional(),
  S3_REGION: z.string().default('ap-south-1'),
  S3_ENDPOINT: z.string().url().optional(),
  S3_PREFIX: z.string().regex(/^([a-z0-9-]+\/)*$/i).default(''),
  SCANNER_DRIVER: z.enum(['dev', 'clamav', 'http', 'none', 'off']).optional(),
  // 'http': ClamAV behind scanner-service/ over HTTPS. 'none': accept files without a virus scan.
  SCANNER_URL: z.string().url().optional(),
  SCANNER_TOKEN: z.string().min(16).optional(),
  CLAMAV_HOST: z.string().default('127.0.0.1'),
  CLAMAV_PORT: z.coerce.number().int().positive().default(3310),
  MAIL_DRIVER: z.enum(['console', 'smtp', 'off']).optional(),
  SMTP_URL: z.string().min(1).optional(),
  // Instead of SMTP_URL: separate settings, so an email address or password needs no URL encoding (Gmail: see docs/EMAIL.md).
  SMTP_HOST: z.string().min(1).optional(),
  // 465 is TLS from the start; 587 upgrades with STARTTLS.
  SMTP_PORT: z.coerce.number().int().positive().default(465),
  SMTP_USER: z.string().min(1).optional(),
  // Gmail shows app passwords in groups of four letters; the spaces are not part of it.
  SMTP_PASSWORD: z.string().min(1).transform((s) => s.replace(/\s+/g, '')).optional(),
  // Defaults to "RMS <SMTP_USER>". Gmail sends only from the signed-in account or an alias set up in Gmail.
  MAIL_FROM: z.string().min(3).optional(),
  FILE_URL_TTL_SECONDS: z.coerce.number().int().min(30).max(3600).default(300),
});

type Parsed = z.infer<typeof ConfigSchema>;
export type Config = Omit<Parsed, 'STORAGE_DRIVER' | 'SCANNER_DRIVER' | 'MAIL_DRIVER'> & {
  STORAGE_DRIVER: NonNullable<Parsed['STORAGE_DRIVER']>;
  SCANNER_DRIVER: NonNullable<Parsed['SCANNER_DRIVER']>;
  MAIL_DRIVER: NonNullable<Parsed['MAIL_DRIVER']>;
  /** Origins allowed to make state-changing requests: WEB_ORIGIN, plus this deployment's own Vercel URLs. */
  ALLOWED_ORIGINS: string[];
};

const vercelUrl = (host: string | undefined) => (host ? `https://${host}` : undefined);

/**
 * With APP_DB_PASSWORD set (hosted setups where DATABASE_URL is the provider's owner connection),
 * connect as the restricted app role instead, so row-level security applies.
 */
function appRoleUrl(env: NodeJS.ProcessEnv) {
  if (!env.DATABASE_URL || !env.APP_DB_PASSWORD) return env.DATABASE_URL;
  const url = new URL(env.DATABASE_URL);
  url.username = env.APP_DB_ROLE ?? 'jm_app';
  url.password = env.APP_DB_PASSWORD;
  return url.toString();
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const onVercel = env.VERCEL === '1';
  const parsed = ConfigSchema.parse({
    ...env,
    DATABASE_URL: appRoleUrl(env),
    // A Vercel deployment is never a development machine: no local disk, no printed email links.
    NODE_ENV: env.NODE_ENV || (onVercel ? 'production' : undefined),
    WEB_ORIGIN: env.WEB_ORIGIN || (onVercel ? vercelUrl(env.VERCEL_PROJECT_PRODUCTION_URL) : undefined),
  });
  const production = parsed.NODE_ENV === 'production';
  const config: Config = {
    ...parsed,
    WEB_ORIGIN: parsed.WEB_ORIGIN.replace(/\/+$/, ''),
    // A connected Vercel Blob store is used without further settings.
    STORAGE_DRIVER: parsed.STORAGE_DRIVER ?? (parsed.BLOB_READ_WRITE_TOKEN ? 'blob' : production ? 'off' : 'local'),
    SCANNER_DRIVER: parsed.SCANNER_DRIVER ?? (production ? 'off' : 'dev'),
    MAIL_DRIVER: parsed.MAIL_DRIVER ?? (production ? 'off' : 'console'),
    ALLOWED_ORIGINS: [],
  };
  config.ALLOWED_ORIGINS = [...new Set([
    config.WEB_ORIGIN,
    ...(config.EXTRA_ORIGINS ?? '').split(',').map((o) => o.trim().replace(/\/+$/, '')).filter(Boolean),
    ...(onVercel ? [vercelUrl(env.VERCEL_URL), vercelUrl(env.VERCEL_BRANCH_URL)].filter((o): o is string => !!o) : []),
  ])];
  if (config.STORAGE_DRIVER === 's3' && !config.S3_BUCKET) throw new Error('S3_BUCKET is required when STORAGE_DRIVER=s3');
  if (config.STORAGE_DRIVER === 'blob' && !config.BLOB_READ_WRITE_TOKEN) throw new Error('BLOB_READ_WRITE_TOKEN is required when STORAGE_DRIVER=blob (connect a Blob store in Vercel Storage)');
  if (config.MAIL_DRIVER === 'smtp') {
    if (!config.SMTP_URL && !(config.SMTP_HOST && config.SMTP_USER && config.SMTP_PASSWORD)) {
      throw new Error('MAIL_DRIVER=smtp needs SMTP_URL, or SMTP_HOST, SMTP_USER and SMTP_PASSWORD');
    }
    config.MAIL_FROM ??= config.SMTP_USER ? `RMS <${config.SMTP_USER}>` : undefined;
    if (!config.MAIL_FROM) throw new Error('MAIL_FROM is required when MAIL_DRIVER=smtp with SMTP_URL');
  }
  if (config.SCANNER_DRIVER === 'http' && (!config.SCANNER_URL || !config.SCANNER_TOKEN)) throw new Error('SCANNER_URL and SCANNER_TOKEN are required when SCANNER_DRIVER=http');
  if (config.NODE_ENV === 'production') {
    if (config.SCANNER_DRIVER === 'http' && !config.SCANNER_URL!.startsWith('https://')) throw new Error('SCANNER_URL must be https:// in production');
    if (config.STORAGE_DRIVER === 'local') throw new Error('Production needs STORAGE_DRIVER=s3 or blob (or off): local disk is for development');
    if (config.SCANNER_DRIVER === 'dev') throw new Error('Production needs SCANNER_DRIVER=clamav (or off): the dev scanner only catches the EICAR test file');
    if (config.MAIL_DRIVER === 'console') throw new Error('Production needs MAIL_DRIVER=smtp (or off): the console mailer prints live links');
    if (config.IP_HASH_SALT.startsWith('dev-only')) throw new Error('IP_HASH_SALT must be set to a random value in production');
    if (config.FILE_URL_SECRET.startsWith('dev-only')) throw new Error('FILE_URL_SECRET must be set to a random value in production');
  }
  return config;
}
