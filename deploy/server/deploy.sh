#!/usr/bin/env bash
# Deploys a commit of main to this server: update the checkout, rebuild, migrate, restart, check health.
# If the new version does not become healthy, the previous images and commit are put back.
#
# Run by .github/workflows/deploy.yml on the self-hosted "rms" runner after CI passes, or by hand:
#   bash /home/jobsmato/rms/app/deploy/server/deploy.sh            # latest origin/main
#   DEPLOY_SHA=<commit> bash .../deploy.sh                           # a specific commit already on main
#
# Everything is inside main(), so bash has read the whole script before git replaces this file on disk.
set -euo pipefail

main() {
  local app=/home/jobsmato/rms/app
  local health=http://127.0.0.1:5010/health

  exec 9>/tmp/rms-deploy.lock
  if ! flock -n 9; then echo "Another deploy is running; stopping."; exit 1; fi

  cd "$app"
  git fetch -q origin main
  local target="${DEPLOY_SHA:-origin/main}"
  target="$(git rev-parse --verify "$target^{commit}")"
  if ! git merge-base --is-ancestor "$target" origin/main; then
    echo "Commit $target is not on origin/main; refusing to deploy it."; exit 1
  fi
  local previous; previous="$(git rev-parse HEAD)"
  echo "Deploying $(git log --oneline -1 "$target") (was $(git log --oneline -1 "$previous"))"

  # Ignored files (.env, api.env, tunnel/, backups/) are not touched by checkout.
  git checkout -q -B main "$target"

  cd deploy/server
  # Keep the running images so a bad release can be undone without a rebuild.
  docker image inspect rms-api:latest >/dev/null 2>&1 && docker tag rms-api:latest rms-api:previous
  docker image inspect rms-web:latest >/dev/null 2>&1 && docker tag rms-web:latest rms-web:previous

  # The live site keeps running during the build; a failed build stops here with nothing changed.
  if ! docker compose build; then
    git -C "$app" checkout -q -B main "$previous"
    echo "Build failed; the site was not changed."; exit 1
  fi

  # Migrations run first; the API is replaced only if they succeed.
  if docker compose up -d && wait_healthy "$health"; then
    docker compose ps --format '{{.Name}}\t{{.Status}}'
    echo "Deployed $(git -C "$app" log --oneline -1)"
    docker image prune -f >/dev/null
    return 0
  fi

  echo "The new version did not become healthy. Last API log lines:"
  docker compose logs --tail 40 api || true
  if docker image inspect rms-api:previous >/dev/null 2>&1; then
    echo "Rolling back to $(git -C "$app" log --oneline -1 "$previous")"
    docker tag rms-api:previous rms-api:latest
    docker tag rms-web:previous rms-web:latest
    git -C "$app" checkout -q -B main "$previous"
    docker compose up -d --no-build api web
    wait_healthy "$health" && echo "Rolled back; the previous version is serving." || echo "Rollback is not healthy either: check the server."
  fi
  exit 1
}

wait_healthy() {
  for _ in $(seq 1 30); do
    if curl -sf "$1" >/dev/null; then return 0; fi
    sleep 3
  done
  return 1
}

main "$@"
