# Deploying RMS on the JobsMato server

RMS runs on the JobsMato Ubuntu server as its own Docker Compose project, reached at
**https://rms.jobsmato.com** through the existing Cloudflare tunnel.

```
Browser ─HTTPS─> Cloudflare ─"rms" tunnel─> rms_tunnel ─> rms_web (nginx: app + /api) ─> rms_api ─> rms_postgres
```

| | |
|---|---|
| Folder | `/home/jobsmato/rms/app` (a clone of this repository) |
| Compose files and secrets | `/home/jobsmato/rms/app/deploy/server/` (`.env`, `api.env`, both `chmod 600`, not in git) |
| Containers | `rms_tunnel`, `rms_web`, `rms_api`, `rms_postgres` (project `rms`) |
| Port | `127.0.0.1:5010` → `rms_web`, for checks on the server; nothing else is published |
| Data | Docker volumes `rms_pgdata` (database) and `rms_files` (resumes, exports) |
| Backups | `deploy/server/backups/`, nightly at 02:30 by cron, 14 days kept |
| Deploys | Automatic after CI passes on `main` (GitHub Actions, self-hosted runner `rms`) |

Connect to the server as described in the JobsMato backend's `docs/MULTI-DOMAIN-BACKEND-SETUP.md`
(Cloudflare `access tcp` to `ssh.jobsmato.com`, then `ssh -p 2222 jobsmato@localhost`).

## First install

```bash
mkdir -p /home/jobsmato/rms && cd /home/jobsmato/rms
git clone --branch main https://github.com/yuvikaep/atssell.git app
cd app/deploy/server

# Secrets: fresh random values, never reused from anywhere else.
umask 077
cp env.example .env && cp api.env.example api.env
for k in POSTGRES_PASSWORD APP_DB_PASSWORD; do sed -i "s/^$k=$/$k=$(openssl rand -hex 32)/" .env; done
for k in IP_HASH_SALT FILE_URL_SECRET; do sed -i "s/^$k=$/$k=$(openssl rand -hex 32)/" api.env; done

docker compose build
docker compose up -d
docker compose ps
curl -s http://127.0.0.1:5010/health        # {"status":"ok"}
```

### Domain: RMS's own tunnel

RMS has its own Cloudflare tunnel, run by the `rms_tunnel` container. The server's main tunnel
(`home-server`, `/etc/cloudflared/config.yml`, which also carries SSH) is never edited or restarted for RMS.

```bash
cd /home/jobsmato/rms/app/deploy/server
cloudflared tunnel create rms                          # uses ~/.cloudflared/cert.pem; prints the tunnel ID
ID=<tunnel ID printed above>
mkdir -p tunnel && cp ~/.cloudflared/$ID.json tunnel/ && chmod 700 tunnel && chmod 600 tunnel/$ID.json
cat > tunnel/config.yml <<EOF
tunnel: $ID
credentials-file: /etc/cloudflared/$ID.json
ingress:
  - hostname: rms.jobsmato.com
    service: http://web:80
  - service: http_status:404
EOF
# CNAME rms → <ID>.cfargotunnel.com, proxied. Pass --config: without it cloudflared reads the server's
# default config, which names the main tunnel, and points the record there instead.
cloudflared tunnel --config tunnel/config.yml route dns --overwrite-dns $ID rms.jobsmato.com
echo "COMPOSE_PROFILES=tunnel" >> .env
docker compose up -d tunnel
```

### First company

Either open https://rms.jobsmato.com/signup, or create it on the server and send the printed set-password link:

```bash
docker compose run --rm tenant --name "Jobsmato" --slug jobsmato --admin-email you@jobsmato.com --admin-name "Your Name"
```

### Email

Put the Gmail settings in `api.env` (see [EMAIL.md](EMAIL.md)), then `docker compose up -d api`.

### Backups

```bash
chmod +x backup.sh
( crontab -l 2>/dev/null; echo "30 2 * * * bash /home/jobsmato/rms/app/deploy/server/backup.sh >> /home/jobsmato/rms/backup.log 2>&1" ) | crontab -
```

Restore a dump into the running database: `docker exec -i rms_postgres pg_restore -U rms_owner -d rms --clean --if-exists < backups/<stamp>/database.dump`.

## Updating: automatic on push to main

A push to `main` runs **CI** on GitHub. When CI passes, the **Deploy** workflow (`.github/workflows/deploy.yml`) runs on
the self-hosted runner `rms` on this server, which runs `deploy/server/deploy.sh` for the commit CI tested:

1. checks out that commit (refusing anything not on `main`); `.env`, `api.env`, `tunnel/` and `backups/` are kept;
2. builds new images while the live site keeps running (a failed build changes nothing);
3. `docker compose up -d`: migrations first, then the API and web are replaced;
4. waits up to 90 s for `/health`; if it never comes up, the previous images and commit are put back.

Progress and logs are in the repository's **Actions** tab; GitHub emails you when a deploy fails.
To redeploy by hand: Actions → Deploy → **Run workflow**, or on the server `bash /home/jobsmato/rms/app/deploy/server/deploy.sh`.

A rollback restores the code but not the database: a migration that already ran stays applied.

### The runner

The runner lives in `/home/jobsmato/actions-runner-rms` and runs as the `actions.runner.*` systemd service, like the
other repositories' runners on this server. It only takes jobs labelled `rms`.

**The repository is public.** Pull requests from forks can add their own workflows, and one that asked for the
`rms` runner would run its code on this server. In GitHub → Settings → Actions → General, set
**"Require approval for all external contributors"** (or make the repository private) so no outside workflow runs
without your approval.

## Checking

```bash
docker compose ps
docker compose logs --tail 50 api
curl -s http://127.0.0.1:5010/health
curl -s https://rms.jobsmato.com/health
```

## Notes

- **Visitor addresses.** `rms_web` passes Cloudflare's `CF-Connecting-IP` to the API (`TRUST_CF_CONNECTING_IP=on`),
  so rate limits and the audit log see each visitor. This is safe only because rms_web is reachable just from the
  tunnel container and from 127.0.0.1:5010.
  Do not publish it on `0.0.0.0`.
- **Files** are stored on the `rms_files` volume (`ALLOW_LOCAL_STORAGE=true`), so they live on this one server: keep the backups.
- **Virus scanning** is off (`SCANNER_DRIVER=none`). To turn it on, run a ClamAV container (about 1 GB of RAM) and set
  `SCANNER_DRIVER=clamav` with `CLAMAV_HOST` in `api.env`.
