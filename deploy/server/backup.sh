#!/usr/bin/env bash
# Nightly backup for the server deployment: database dump and uploaded files, from the running containers.
# Writes backups/<timestamp>/ next to this script, with SHA-256 checksums, and keeps BACKUP_KEEP_DAYS (default 14).
#
#   bash backup.sh          # cron: 30 2 * * * bash /home/jobsmato/rms/app/deploy/server/backup.sh >> .../backup.log 2>&1
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
BACKUP_DIR="${BACKUP_DIR:-$HERE/backups}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
DEST="$BACKUP_DIR/$(date -u +%Y%m%dT%H%M%SZ)"
umask 077
mkdir -p "$DEST"

docker exec rms_postgres pg_dump -U rms_owner -d rms --format=custom --no-owner --no-privileges > "$DEST/database.dump"
docker exec rms_api tar -czf - -C /data/files . > "$DEST/files.tar.gz"
( cd "$DEST" && sha256sum database.dump files.tar.gz > SHA256SUMS )

find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d -mtime +"$KEEP_DAYS" -exec rm -rf {} +
echo "$(date -u +%FT%TZ) backup written to $DEST ($(du -sh "$DEST" | cut -f1))"
