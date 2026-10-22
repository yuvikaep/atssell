#!/usr/bin/env bash
# The only thing the GitHub Actions deploy key may run. In ~/.ssh/authorized_keys the key carries
#   command="bash /home/jobsmato/rms/app/deploy/server/deploy-ssh.sh",restrict
# so whatever command the client asks for arrives here as SSH_ORIGINAL_COMMAND and is checked.
# Accepted: "deploy" (latest main) or "deploy <full commit SHA>". See docs/DEPLOY-SERVER.md.
set -euo pipefail

read -r verb sha extra <<< "${SSH_ORIGINAL_COMMAND:-}"
if [ "${verb:-}" != "deploy" ] || [ -n "${extra:-}" ]; then
  echo "This key can only run: deploy [commit]" >&2
  exit 2
fi
if [ -n "${sha:-}" ]; then
  if ! [[ "$sha" =~ ^[0-9a-f]{40}$ ]]; then echo "The commit must be a full 40-character SHA." >&2; exit 2; fi
  export DEPLOY_SHA="$sha"
fi
exec bash /home/jobsmato/rms/app/deploy/server/deploy.sh
