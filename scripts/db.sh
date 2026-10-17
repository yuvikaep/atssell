#!/usr/bin/env bash
# Project-local PostgreSQL 16 cluster in .pgdata/, listening on localhost:5433 (TCP only).
# Local development only: authentication is "trust" for localhost connections.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DATA="$ROOT/.pgdata"
PORT=5433
PG_BIN="${PG_BIN:-/opt/homebrew/opt/postgresql@16/bin}"
export LC_ALL="${LC_ALL:-en_US.UTF-8}" LANG="${LANG:-en_US.UTF-8}"
export PGHOST=localhost PGPORT=$PORT PGUSER=postgres

start() {
  if "$PG_BIN/pg_ctl" -D "$DATA" status >/dev/null 2>&1; then
    echo "Postgres already running on :$PORT"
    return
  fi
  # -k '' disables the Unix socket (paths with spaces/long names are fragile); TCP only.
  "$PG_BIN/pg_ctl" -D "$DATA" -l "$DATA/server.log" -w \
    -o "-p $PORT -k '' -c listen_addresses=localhost" start >/dev/null
  echo "Postgres started on localhost:$PORT"
}

case "${1:-}" in
  init)
    if [ -d "$DATA" ]; then
      echo ".pgdata already exists; run 'npm run db:start'"
      exit 0
    fi
    "$PG_BIN/initdb" -D "$DATA" -U postgres --auth=trust --encoding=UTF8 >/dev/null
    start
    "$PG_BIN/psql" -q -d postgres -c "CREATE ROLE jm_app LOGIN NOBYPASSRLS"
    "$PG_BIN/createdb" jobsmato
    "$PG_BIN/createdb" jobsmato_test
    echo "Created databases jobsmato, jobsmato_test and role jm_app"
    ;;
  start) start ;;
  stop) "$PG_BIN/pg_ctl" -D "$DATA" stop >/dev/null && echo "Postgres stopped" ;;
  *) echo "usage: db.sh init|start|stop"; exit 1 ;;
esac
