# Vercel deployment

Import the repository as **one Services project**, with Root Directory `./`.
The root `vercel.json` builds `web` (Vite) and `api` (Fastify), sends `/api/*`
and `/health` to the API, and serves frontend routes from the SPA.
If previously imported as a frontend-only project, change its root to the repository root
and remove the project-level frontend build/output overrides before redeploying.

## Database

Connect Neon through Vercel Storage. A newly provisioned database has no application tables.
Keep the owner connection for migrations/provisioning in a private operator environment as
`DATABASE_URL_ADMIN` (use Neon's direct, unpooled connection). Do not use that owner role
as the runtime API connection: this app relies on PostgreSQL row-level security.

In Neon's SQL editor create a dedicated application role with a fresh password:

```sql
CREATE ROLE jm_app LOGIN NOBYPASSRLS PASSWORD '<replace with a generated password>';
```

Set the Vercel project's `DATABASE_URL` to the Neon connection string for **jm_app**,
including the SSL parameters Neon supplies. Set `APP_DB_ROLE=jm_app` in the operator
environment. Never commit connection strings or share their values in screenshots.

From the repository root, with `DATABASE_URL_ADMIN` and `APP_DB_ROLE` loaded securely:

```sh
npm ci
npm run build
node api/dist/migrate-cli.js
```

Run migrations once before deploying the corresponding code, not on every request or
in parallel preview builds. Do not connect previews to the production database.

## API environment variables

Configure these in Vercel for the intended deployment environment:

| Variable | Value |
| --- | --- |
| `NODE_ENV` | `production` |
| `DATABASE_URL` | Neon connection for the restricted `jm_app` role |
| `WEB_ORIGIN` | `https://atssell.vercel.app` for this project (no trailing slash) |
| `IP_HASH_SALT` | Fresh random secret |
| `FILE_URL_SECRET` | Separate fresh random secret, at least 16 characters |
| `STORAGE_DRIVER` | `s3` |
| `S3_BUCKET` | Private resume/export bucket |
| `S3_REGION` | Bucket region |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | Credentials scoped to that bucket |
| `SCANNER_DRIVER` | `clamav` |
| `CLAMAV_HOST`, `CLAMAV_PORT` | Reachable trusted ClamAV service; default port 3310 |
| `MAIL_DRIVER` | `smtp` |
| `SMTP_URL` | Authenticated SMTP connection URL |
| `MAIL_FROM` | Verified sender address |

For S3-compatible providers also set `S3_ENDPOINT`. ClamAV is an external service;
this configuration does not provision it. Keep its TCP endpoint private or protected.
The API intentionally refuses development storage/scanner/mail settings in production.

## First company/admin

In the private operator environment, set `WEB_ORIGIN` to the deployed app origin
and use the owner connection as `DATABASE_URL_ADMIN`:

```sh
node api/dist/create-tenant-cli.js --name "Your Company" --slug your-company --admin-email admin@example.com --admin-name "Admin Name"
```

Use the printed one-time password setup link privately. Do not run this from deployment
build logs, where the token could be exposed. No public database setup endpoint is added.

## Background jobs and validation

On Vercel the API's in-process timer is disabled. Schedule
`node api/dist/worker-cli.js` separately every minute with the API environment,
using a trusted scheduler/worker runtime with the repo and dependencies installed.
Until configured, queued emails, reminders and exports will not process automatically.

Verify `/health`, direct navigation to `/login`, login using the company code, tenant
isolation, uploads/downloads and email delivery. Vercel Function request-body limits
also apply; the application's 25 MB upload limit does not override the hosting limit.

References: https://vercel.com/docs/services and
https://vercel.com/docs/frameworks/backend/fastify
