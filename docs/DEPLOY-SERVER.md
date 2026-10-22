# Deploying RMS on the JobsMato server

RMS runs on the JobsMato Ubuntu server as its own Docker Compose project, reached at
**https://rms.jobsmato.com** through the existing Cloudflare tunnel.

```
Browser ─HTTPS─> Cloudflare ─tunnel─> cloudflared (server) ─> 127.0.0.1:5010 ─> rms_web (nginx: app + /api)
                                                                                    └─> rms_api ─> rms_postgres
```

| | |
|---|---|
| Folder | `/home/jobsmato/rms/app` (a clone of this repository) |
| Compose files and secrets | `/home/jobsmato/rms/app/deploy/server/` (`.env`, `api.env`, both `chmod 600`, not in git) |
| Containers | `rms_web`, `rms_api`, `rms_postgres` (project `rms`) |
| Port | `127.0.0.1:5010` → `rms_web`; nothing else is published |
| Data | Docker volumes `rms_pgdata` (database) and `rms_files` (resumes, exports) |
| Backups | `deploy/server/backups/`, nightly at 02:30 by cron, 14 days kept |

Connect to the server as described in the JobsMato backend's `docs/MULTI-DOMAIN-BACKEND-SETUP.md`
(Cloudflare `access tcp` to `ssh.jobsmato.com`, then `ssh -p 2222 jobsmato@localhost`).

## First install

```bash
mkdir -p /home/jobsmato/rms && cd /home/jobsmato/rms
git clone --branch deploy-rms https://github.com/yuvikaep/atssell.git app
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

### Domain

1. Add to `/etc/cloudflared/config.yml`, above the final `http_status:404` line (back the file up first):
   ```yaml
     - hostname: rms.jobsmato.com
       service: http://localhost:5010
   ```
2. `sudo systemctl restart cloudflared`. Every site on the tunnel drops for a few seconds.
3. DNS: in Cloudflare → jobsmato.com → DNS, add a **CNAME** `rms` → `<tunnel-id>.cfargotunnel.com`, **Proxied**
   (or `cloudflared tunnel route dns <tunnel> rms.jobsmato.com` on a machine with the account certificate).

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

## Updating

```bash
cd /home/jobsmato/rms/app && git pull
cd deploy/server && docker compose build && docker compose up -d
```

`up` runs the migrations first; the API starts only if they succeed.

## Checking

```bash
docker compose ps
docker compose logs --tail 50 api
curl -s http://127.0.0.1:5010/health
curl -s https://rms.jobsmato.com/health
```

## Notes

- **Visitor addresses.** `rms_web` passes Cloudflare's `CF-Connecting-IP` to the API (`TRUST_CF_CONNECTING_IP=on`),
  so rate limits and the audit log see each visitor. This is safe only because port 5010 listens on 127.0.0.1.
  Do not publish it on `0.0.0.0`.
- **Files** are stored on the `rms_files` volume (`ALLOW_LOCAL_STORAGE=true`), so they live on this one server: keep the backups.
- **Virus scanning** is off (`SCANNER_DRIVER=none`). To turn it on, run a ClamAV container (about 1 GB of RAM) and set
  `SCANNER_DRIVER=clamav` with `CLAMAV_HOST` in `api.env`.
