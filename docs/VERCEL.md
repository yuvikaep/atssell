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
| File storage | Resume uploads and CSV exports are refused | `STORAGE_DRIVER=s3`, `S3_BUCKET`, `S3_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` (plus `S3_ENDPOINT` for S3-compatible stores such as Cloudflare R2) |
| Malware scanning | Uploads are refused (nothing unscanned is ever stored) | `SCANNER_DRIVER=clamav`, `CLAMAV_HOST`, `CLAMAV_PORT` (default 3310) |
| Email | Invitations, feedback-request and notification emails are not sent (feedback links are still shown to copy); password reset requests are accepted but send nothing | `MAIL_DRIVER=smtp`, `SMTP_URL`, `MAIL_FROM` |

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
