#!/usr/bin/env bash
set -euo pipefail
app_dir=${COMPASS_DEPLOY_DIR:-/opt/consumer-compass}
exec 9>"$app_dir/certbot.lock"
flock -w 300 9
docker run --rm --memory 128m --memory-swap 256m \
  -v "$app_dir/state/letsencrypt:/etc/letsencrypt" \
  -v "$app_dir/state/acme:/var/www/certbot" \
  certbot/certbot:v5.8.0 renew --non-interactive "$@"
# Certbot exits 0 when nothing is due. Reloading then is harmless.
bash "$app_dir/scripts/compose-prod.sh" exec -T nginx nginx -t
bash "$app_dir/scripts/compose-prod.sh" exec -T nginx nginx -s reload
