# Vercel deployment

Import the repository as one Vercel project. Root Directory `./` (preferred) or `web` both work:
`vercel.json` (and `web/vercel.json`) run `scripts/vercel-build.mjs`, which writes the
[Build Output API](https://vercel.com/docs/build-output-api) layout to `.vercel/output`:

- `static/`: the web app (Vite build)
- `functions/api.func`: the whole API bundled as one Node function (`server/src/vercel.ts`)
- routes: `/api/*` and `/health` go to the function, other paths serve the app (so `/login` works)

The build does not depend on the project's framework preset or output settings.

## Quick start (Vercel only, no outside services)

1. **Import** the GitHub repository in Vercel (Root Directory `./`, leave the build settings as they are).
2. **Storage → Create → Neon (Postgres)**, connect it to the project for **Production**. This adds
   `DATABASE_URL` (pooled, owner) and `DATABASE_URL_UNPOOLED` (direct, owner).
3. **Storage → Create → Blob**, connect it to the project. This adds `BLOB_READ_WRITE_TOKEN`;
   resumes and exports are then stored as private blobs (`STORAGE_DRIVER` defaults to `blob`).
4. **Settings → Environment Variables**, add (each value from `openssl rand -hex 32`):

   | Variable | Value |
   | --- | --- |
   | `APP_DB_PASSWORD` | Password for the restricted `jm_app` role |
   | `IP_HASH_SALT` | Random secret |
   | `FILE_URL_SECRET` | Different random secret |
   | `CRON_SECRET` | Random secret (Vercel sends it to the daily cron) |
   | `SCANNER_DRIVER` | `none` to accept uploads without a virus scan (until a scanner is set up) |

5. **Redeploy.** The production build creates or updates the `jm_app` role with
   `APP_DB_PASSWORD`, applies migrations through `DATABASE_URL_UNPOOLED`, and the API then connects
   as `jm_app` (the owner user in `DATABASE_URL` is swapped for it) so row-level security applies.

Email stays off until `MAIL_DRIVER=smtp` is set (see below); feedback links are shown to copy.
Then create the first company (see "First company/admin").

## Database (manual setup)

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
node server/dist/migrate-cli.js
```

Run migrations once before deploying the corresponding code, not on every request or
in parallel preview builds. Do not connect previews to the production database.

Without a terminal, you can instead let production builds migrate: add `DATABASE_URL_ADMIN`
(owner, unpooled) and `APP_DB_ROLE=jm_app` to the Vercel project for the **Production**
environment only. Each production build then applies new migrations before going live, and a
failed migration fails the deployment. The trade-off: the owner credential is then stored in
Vercel, so keep project access tight. The `jm_app` role must exist first (SQL above).

## API environment variables

The API starts with just these. Set them in Vercel for the intended deployment environment:

| Variable | Value |
| --- | --- |
| `DATABASE_URL` | Neon connection for the restricted `jm_app` role |
| `IP_HASH_SALT` | Fresh random secret |
| `FILE_URL_SECRET` | Separate fresh random secret, at least 16 characters |
| `WEB_ORIGIN` | Optional on Vercel: defaults to the project's production domain (`https://atssell.vercel.app`). Set it when you use a custom domain |

`NODE_ENV` is treated as `production` on Vercel. Requests from the deployment's own URLs (`VERCEL_URL`,
`VERCEL_BRANCH_URL`) are accepted besides `WEB_ORIGIN`, so preview links can sign in too.

### Optional services

Each one is **off** until configured. While off, the rest of the app works and only the feature
that needs it is refused with a clear message (HTTP 503):

| Service | Off means | To turn on |
| --- | --- | --- |
| File storage | Resume uploads and CSV exports are refused | A connected Vercel Blob store (`BLOB_READ_WRITE_TOKEN`), or `STORAGE_DRIVER=s3`, `S3_BUCKET`, `S3_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` (plus `S3_ENDPOINT` for S3-compatible stores such as Cloudflare R2) |
| Malware scanning | Uploads are refused (nothing unscanned is ever stored) | `SCANNER_DRIVER=clamav`, `CLAMAV_HOST`, `CLAMAV_PORT` (default 3310) |
| Email | Invitations, feedback-request and notification emails are not sent (feedback links are still shown to copy); password reset requests are accepted but send nothing | `MAIL_DRIVER=smtp` with `SMTP_HOST`, `SMTP_USER`, `SMTP_PASSWORD` (Gmail: see [EMAIL.md](EMAIL.md)), or `SMTP_URL` and `MAIL_FROM` |

Uploads need both storage and scanning. ClamAV is an external service that this configuration does not
provision; keep its TCP endpoint private or protected. The development drivers (`local`, `dev`,
`console`) are still refused in production.

### Troubleshooting

| Response | Fix |
| --- | --- |
| `503 SERVER_MISCONFIGURED` | `details` names each missing or invalid setting. Set it in Vercel and redeploy |
| `503 DATABASE_NOT_READY` "no tables yet" | Run the migrations (above) against this database |
| `503 DATABASE_NOT_READY` "cannot sign in" / "cannot reach" | Check `DATABASE_URL` (role, password, host, `sslmode=require`) |
| `403 BAD_ORIGIN` on sign-in | You opened the app on a domain other than `WEB_ORIGIN`; set `WEB_ORIGIN` to it |
| `401` right after a successful sign-in | The session cookie is `Secure`: open the site over https |

## First company/admin

In the private operator environment, set `WEB_ORIGIN` to the deployed app origin
and use the owner connection as `DATABASE_URL_ADMIN`:

```sh
node server/dist/create-tenant-cli.js --name "Your Company" --slug your-company --admin-email admin@example.com --admin-name "Admin Name"
```

Use the printed one-time password setup link privately. Do not run this from deployment
build logs, where the token could be exposed. No public database setup endpoint is added.

## Vercel-specific settings (added)

| Variable | Value |
| --- | --- |
| `DB_POOL_MAX` | `3` (use Neon's **pooled** `-pooler` URL for `DATABASE_URL`) |
| `CRON_SECRET` | Random 32+ chars. Enables `/api/v1/cron/worker`, which `vercel.json` calls daily |
| `ALLOWED_ORIGINS` | Optional extra origins, e.g. a custom domain |
| `SCANNER_DRIVER=http`, `SCANNER_URL`, `SCANNER_TOKEN` | ClamAV via `scanner-service/` over HTTPS (Vercel cannot reach clamd directly) |

- Background work runs after signed-in requests (at most once a minute per company) plus the daily cron. On a Pro plan change the cron schedule to `* * * * *`.
- Resume uploads are capped at 4 MB on Vercel (its request limit is 4.5 MB); the form shows the limit.
- Run migrations with the **Migrate database** GitHub Action (secret `DATABASE_URL_ADMIN`) before deploying.

## Background jobs and validation

On Vercel the in-process timer is off; the worker runs from traffic and the cron above.

Verify `/health`, direct navigation to `/login`, login using the company code, tenant
isolation, uploads/downloads and email delivery. Vercel Function request-body limits
also apply; the application's 25 MB upload limit does not override the hosting limit.

Reference: https://vercel.com/docs/build-output-api
