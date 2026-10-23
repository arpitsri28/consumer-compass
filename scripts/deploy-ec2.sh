#!/usr/bin/env bash
set -euo pipefail

revision=${1:?Pass the tested Git commit SHA}
[[ "$revision" =~ ^[a-f0-9]{40}$ ]] || { echo 'Expected a 40-character Git SHA.' >&2; exit 1; }
release_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
app_dir=${COMPASS_DEPLOY_DIR:-/opt/consumer-compass}
image="consumer-compass:$revision"

for file in .env.production runtime.env docker-compose.prod.yml scripts/compose-prod.sh; do
  [[ -r "$app_dir/$file" ]] || { echo "Missing server configuration: $file" >&2; exit 1; }
done
exec 9>"$app_dir/deploy.lock"
flock -w 300 9
compose() { bash "$app_dir/scripts/compose-prod.sh" "$@"; }
previous=''
if [[ -r "$app_dir/.deployed-image" ]]; then previous=$(cat "$app_dir/.deployed-image"); fi
if [[ -n "$previous" && ! "$previous" =~ ^consumer-compass:[a-zA-Z0-9_.-]+$ ]]; then
  echo 'Invalid previous image reference.' >&2; exit 1
fi
(cd "$release_dir" && sha256sum --check image.sha256)
gzip -dc "$release_dir/image.tar.gz" | docker load
actual_revision=$(docker image inspect "$image" --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}')
[[ "$actual_revision" == "$revision" ]] || { echo 'Image revision does not match the tested commit.' >&2; exit 1; }
export APP_IMAGE="$image"
# Never stop the existing app if its replacement cannot migrate the database.
compose run --rm --no-deps app node --conditions=react-server --experimental-default-type=module scripts/migrate.mjs

replacement_started=false
# Registered as an EXIT callback.
# shellcheck disable=SC2329
rollback() {
  result=$?
  trap - EXIT
  if (( result != 0 )) && [[ "$replacement_started" == true ]]; then
    if [[ -n "$previous" ]]; then
      echo 'Deployment failed; restoring the previously deployed image.' >&2
      export APP_IMAGE="$previous"
      if compose up -d --no-deps --force-recreate --wait --wait-timeout 120 app; then
        compose exec -T nginx nginx -s reload || true
      else
        echo 'Rollback failed. Inspect Compose logs and the previous image.' >&2
      fi
    else
      echo 'First deployment failed; there is no previous release to restore.' >&2
    fi
  fi
  exit "$result"
}
trap 'rollback' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP
replacement_started=true
compose up -d --no-deps --force-recreate --wait --wait-timeout 120 app
# Nginx resolves app's container address when loading its configuration.
compose exec -T nginx nginx -t
compose exec -T nginx nginx -s reload
curl --fail --silent --max-time 12 http://127.0.0.1:3000/api/health >/dev/null
# Persist the selected image only after the replacement and Nginx are healthy.
if [[ -n "$previous" ]]; then printf '%s\n' "$previous" > "$app_dir/.previous-image"; fi
printf '%s\n' "$image" > "$app_dir/.deployed-image.tmp"
mv "$app_dir/.deployed-image.tmp" "$app_dir/.deployed-image"
echo "Deployed $revision"
