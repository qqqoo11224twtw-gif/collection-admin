#!/usr/bin/env bash
# Wrapper used by root-level deploy scripts. Auto-sources .alchemy.env at
# the repo root (control-plane vars: CLOUDFLARE_API_TOKEN, ALCHEMY_STATE_TOKEN)
# so child processes inherit them, then exec the real
# deploy command.
#
# Usage: scripts/deploy.sh <cmd...>
# Example: scripts/deploy.sh pnpm -r deploy:dev

set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SHARED="$ROOT/.alchemy.env"

if [ -f "$SHARED" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$SHARED"
  set +a
fi

exec "$@"
