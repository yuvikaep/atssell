#!/usr/bin/env bash
# Backs up the database (custom-format dump) and the file storage directory into backups/<timestamp>/,
# writes SHA-256 checksums, and prunes backups older than BACKUP_KEEP_DAYS (default 14).
#
#   bash scripts/backup.sh
#
# Reads DATABASE_URL_ADMIN from the environment or .env. With STORAGE_DRIVER=s3 the files live in the
# bucket and are protected by bucket versioning/replication instead (see docs/RUNBOOK.md); this script
# then backs up the database only.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
[ -f "$ROOT/.env" ] && set -a && . "$ROOT/.env" && set +a
: "${DATABASE_URL_ADMIN:?DATABASE_URL_ADMIN is not set}"
PG_BIN="${PG_BIN:-/opt/homebrew/opt/postgresql@16/bin}"
[ -x "$PG_BIN/pg_dump" ] || PG_BIN="$(dirname "$(command -v pg_dump)")"
BACKUP_DIR="${BACKUP_DIR:-$ROOT/backups}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DEST="$BACKUP_DIR/$STAMP"
mkdir -p "$DEST"
umask 077

echo "Dumping database…"
"$PG_BIN/pg_dump" --format=custom --no-owner --no-privileges --file="$DEST/database.dump" "$DATABASE_URL_ADMIN"

if [ "${STORAGE_DRIVER:-local}" = "local" ]; then
  STORAGE_PATH="$ROOT/${STORAGE_DIR:-.storage}"
  if [ -d "$STORAGE_PATH" ]; then
    echo "Archiving files…"
    tar -czf "$DEST/files.tar.gz" -C "$STORAGE_PATH" .
  else
    echo "No storage directory yet; skipping files."
  fi
fi

( cd "$DEST" && shasum -a 256 * > SHA256SUMS )
echo "Backup written to $DEST"
cat "$DEST/SHA256SUMS"

# Prune old backups (only directories named like a timestamp, so nothing else is ever touched).
find "$BACKUP_DIR" -maxdepth 1 -type d -name '2*T*Z' -mtime "+$KEEP_DAYS" -print -exec rm -rf {} + || true
echo "$DEST" > "$BACKUP_DIR/LATEST"
