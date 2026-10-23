#!/usr/bin/env bash
set -euo pipefail
domain=${1:?Pass the DOMAIN configured on the server}
[[ "$domain" =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]+[a-zA-Z0-9]$ ]] || { echo 'Expected a hostname.' >&2; exit 1; }
app_dir=${COMPASS_DEPLOY_DIR:-/opt/consumer-compass}
compose() { bash "$app_dir/scripts/compose-prod.sh" "$@"; }
[[ "$(compose exec -T nginx printenv DOMAIN)" == "$domain" ]] || { echo 'DOMAIN does not match Nginx.' >&2; exit 1; }
contact=(--register-unsafely-without-email)
if [[ -n "${CERTBOT_EMAIL:-}" ]]; then contact=(--email "$CERTBOT_EMAIL"); fi
docker run --rm --memory 128m --memory-swap 256m \
  -v "$app_dir/state/letsencrypt:/etc/letsencrypt" \
  -v "$app_dir/state/acme:/var/www/certbot" \
  certbot/certbot:v5.8.0 certonly --webroot -w /var/www/certbot \
  --non-interactive --agree-tos "${contact[@]}" \
  --cert-name consumer-compass -d "$domain"

template="$app_dir/state/nginx/default.conf.template"
backup=$(mktemp "$app_dir/state/nginx/previous.XXXXXX")
cp "$template" "$backup"
# Registered as an EXIT callback; restore HTTP if TLS cannot start.
# shellcheck disable=SC2329
restore() {
  result=$?
  trap - EXIT
  if (( result != 0 )); then cp "$backup" "$template"; compose restart nginx || true; fi
  rm -f "$backup"
  exit "$result"
}
trap 'restore' EXIT
cp "$app_dir/deploy/https.conf.template" "$template"
compose restart nginx
for (( attempt=0; attempt<20; attempt++ )); do
  if curl --fail --silent --max-time 5 --resolve "$domain:443:127.0.0.1" "https://$domain/api/health" >/dev/null; then
    compose exec -T nginx nginx -t
    echo "HTTPS enabled for $domain"
    exit 0
  fi
  sleep 2
done
echo 'HTTPS health verification failed; restoring the previous Nginx template.' >&2
exit 1
