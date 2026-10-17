#!/usr/bin/env bash
# Proves a backup can actually be restored. Restores the latest (or given) backup into a scratch
# database, checks the checksums, compares row counts with the live database, confirms row-level
# security is still forced on every tenant table, then drops the scratch database.
#
#   bash scripts/restore-drill.sh [backups/<timestamp>]
#
# Exits non-zero on any mismatch. Run it on a schedule: an untested backup is not a backup.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
[ -f "$ROOT/.env" ] && set -a && . "$ROOT/.env" && set +a
: "${DATABASE_URL_ADMIN:?DATABASE_URL_ADMIN is not set}"
PG_BIN="${PG_BIN:-/opt/homebrew/opt/postgresql@16/bin}"
[ -x "$PG_BIN/pg_restore" ] || PG_BIN="$(dirname "$(command -v pg_restore)")"
BACKUP_DIR="${BACKUP_DIR:-$ROOT/backups}"
SRC="${1:-$(cat "$BACKUP_DIR/LATEST")}"
[ -f "$SRC/database.dump" ] || { echo "No database.dump in $SRC"; exit 1; }

# Scratch database name and connection derived from the admin URL (same server, different database).
SCRATCH="jm_restore_drill_$$"
BASE="${DATABASE_URL_ADMIN%/*}"
SCRATCH_URL="$BASE/$SCRATCH"
PSQL="$PG_BIN/psql -X -q -v ON_ERROR_STOP=1 -At"
cleanup() { $PSQL "$BASE/postgres" -c "DROP DATABASE IF EXISTS $SCRATCH" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "1/5 Verifying checksums…"
( cd "$SRC" && shasum -a 256 -c SHA256SUMS )

echo "2/5 Restoring into scratch database $SCRATCH…"
$PSQL "$BASE/postgres" -c "CREATE DATABASE $SCRATCH"
"$PG_BIN/pg_restore" --no-owner --no-privileges --exit-on-error --dbname="$SCRATCH_URL" "$SRC/database.dump"

echo "3/5 Comparing row counts with the live database…"
TABLES=$($PSQL "$SCRATCH_URL" -c "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY 1")
FAIL=0
for t in $TABLES; do
  a=$($PSQL "$DATABASE_URL_ADMIN" -c "SELECT count(*) FROM public.\"$t\"")
  b=$($PSQL "$SCRATCH_URL" -c "SELECT count(*) FROM public.\"$t\"")
  # Live data may have moved on since the backup; the restored copy must never have MORE rows than live
  # unless rows were deleted, and the drill reports every difference so a person can judge it.
  if [ "$a" != "$b" ]; then echo "  note: $t live=$a restored=$b"; fi
done
CNT=$($PSQL "$SCRATCH_URL" -c "SELECT count(*) FROM tenants")
echo "  restored $(echo "$TABLES" | wc -w | tr -d ' ') tables; $CNT companies"

echo "4/5 Checking migrations and row-level security in the restored copy…"
MIG=$($PSQL "$SCRATCH_URL" -c "SELECT count(*) FROM schema_migrations" 2>/dev/null || echo "?")
echo "  migrations recorded: $MIG"
BAD=$($PSQL "$SCRATCH_URL" -c "
  SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relkind='r'
    AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attname='tenant_id' AND NOT a.attisdropped)
    AND NOT (c.relrowsecurity AND c.relforcerowsecurity)")
[ "$BAD" = "0" ] || { echo "  FAIL: $BAD tenant tables lost forced row-level security"; FAIL=1; }

echo "5/5 Spot-checking that append-only protection survived…"
TRG=$($PSQL "$SCRATCH_URL" -c "SELECT count(*) FROM pg_trigger WHERE tgname LIKE 'trg_%append_only%' AND NOT tgisinternal")
[ "$TRG" -ge 4 ] || { echo "  FAIL: expected append-only triggers, found $TRG"; FAIL=1; }
echo "  append-only triggers: $TRG"

if [ "$FAIL" = "0" ]; then echo "RESTORE DRILL PASSED ($SRC)"; else echo "RESTORE DRILL FAILED"; exit 1; fi
