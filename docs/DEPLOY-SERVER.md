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
cloudflared tunnel route dns rms rms.jobsmato.com      # CNAME rms → <ID>.cfargotunnel.com, proxied
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
  so rate limits and the audit log see each visitor. This is safe only because rms_web is reachable just from the
  tunnel container and from 127.0.0.1:5010.
  Do not publish it on `0.0.0.0`.
- **Files** are stored on the `rms_files` volume (`ALLOW_LOCAL_STORAGE=true`), so they live on this one server: keep the backups.
- **Virus scanning** is off (`SCANNER_DRIVER=none`). To turn it on, run a ClamAV container (about 1 GB of RAM) and set
  `SCANNER_DRIVER=clamav` with `CLAMAV_HOST` in `api.env`.
