# Runbook

For whoever runs JobsMato in a pilot. Commands run from the repository root.

## Environments
| | Local development | Rehearsal stack | Production |
|---|---|---|---|
| Start | `npm run db:init`, `npm run dev` | `docker compose up --build` | your platform |
| Storage | disk (`.storage/`) | S3 API (LocalStack) | S3 (versioning on) |
| Scanner | dev stub (EICAR only) | ClamAV | ClamAV |
| Mail | console | Mailpit inbox at :8025 | SMTP provider |

`loadConfig` refuses to start in production with disk storage, the dev scanner or the console mailer.

## Deploying
1. `docker build -f api/Dockerfile -t jobsmato-api .` and `docker build -f web/Dockerfile -t jobsmato-web .`
2. Run migrations first: `node api/dist/migrate-cli.js` (needs `DATABASE_URL_ADMIN`). It is idempotent and refuses to continue if an applied migration file was edited.
3. Start the API (one process; it also runs the background worker) and the web container. Put TLS in front; set `WEB_ORIGIN` to the public HTTPS origin.
4. Create a company: `docker compose run --rm tenant --name … --slug … --admin-email … --admin-name …`. Send the admin the printed one-time link.
5. Check `GET /health` and sign in.

Rolling back: restore the previous images. Migrations only move forward; a bad migration is fixed with a new migration, or by restoring a backup taken before deploying.

## Backups and restore
- `bash scripts/backup.sh` writes `backups/<UTC timestamp>/` with a custom-format database dump, a files archive (local storage only) and SHA-256 sums; it prunes after `BACKUP_KEEP_DAYS` (14).
- `bash scripts/restore-drill.sh` restores the latest backup into a scratch database, verifies checksums, confirms row-level security is still forced on every tenant table and append-only triggers exist, then drops the scratch database. **Run it after every backup job and at least weekly by hand during the pilot.** Both scripts were run successfully on the development database; that is not evidence about your production setup.
- With S3 storage: enable bucket versioning and cross-region replication; the script backs up the database only.
- Copy backups off the host and encrypt them at rest. Test a full restore into a clean environment before the pilot starts.
- Targets to agree with the customer: RPO (data you can lose, ≈ time since last backup) and RTO (time to restore). Nothing here promises a figure.

## Routine checks
| When | What |
|---|---|
| Daily | `/health`; failed exports and unsent emails (`SELECT status, count(*) FROM notifications WHERE delivery_channel='email' GROUP BY 1`, `SELECT * FROM export_jobs WHERE status='failed'`) |
| Weekly | Restore drill; `npm audit --omit=dev`; `npm run -w api retention:report -- --company <code>` |
| Per release | CI green; migrations on a copy of production first |

## Incidents
- **Emails not arriving:** check SMTP credentials; failed sends retry with backoff up to 5 attempts, then stay `failed` and the in-app notice remains. Fix the provider, then reset `status='queued'` on the failed rows.
- **Uploads stuck or rejected:** scan status `failed` means ClamAV was unreachable; the file is never served. Restore ClamAV, ask the user to upload again.
- **Suspected link leak (feedback/invite/reset):** revoke from the app (regenerate the feedback link) or expire the invitation; links are single-use and hash-only.
- **Suspected account compromise:** deactivate the user (sessions stop working), reset their password, review `audit_events` for that actor.
- **Data deletion request:** see `docs/DATA_PROTECTION.md`.

## Capacity
`npm run -w api load-test` seeds a throwaway company (default 2,000 candidates, 40 vacancies) and drives 20 concurrent users across the read endpoints. On a developer laptop with API, database and load generator on one machine: 5,037 requests in 30 s, 0 errors, p50 52 ms, p95 493 ms, p99 594 ms (target p95 < 2 s). The slowest endpoint was the hiring funnel (p95 637 ms). This is a smoke test of the read path, not a capacity plan: rerun on production-like hardware with production-like data before relying on it. Writes, uploads and the worker were not load tested.
