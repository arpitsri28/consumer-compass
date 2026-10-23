#!/usr/bin/env bash
set -euo pipefail
cd "${COMPASS_DEPLOY_DIR:-/opt/consumer-compass}"
if [[ -z "${APP_IMAGE:-}" && -r .deployed-image ]]; then
  APP_IMAGE=$(cat .deployed-image)
  [[ "$APP_IMAGE" =~ ^consumer-compass:[a-zA-Z0-9_.-]+$ ]] || { echo 'Invalid deployed image.' >&2; exit 1; }
  export APP_IMAGE
fi
args=(--env-file .env.production -f docker-compose.prod.yml)
if [[ -f .cloudwatch-enabled ]]; then args+=(-f docker-compose.cloudwatch.yml); fi
exec docker compose "${args[@]}" "$@"
