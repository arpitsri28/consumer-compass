#!/usr/bin/env bash
set -euo pipefail

revision=${1:?Pass the tested Git commit SHA}
[[ "$revision" =~ ^[a-f0-9]{40}$ ]] || { echo 'Expected a 40-character Git SHA.' >&2; exit 1; }
release_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
app_dir=${COMPASS_DEPLOY_DIR:-/opt/consumer-compass}
app_name=consumer-compass-app
previous_name=consumer-compass-app-previous
network=consumer-compass
image="consumer-compass:$revision"

[[ -r "$app_dir/runtime.env" ]] || { echo 'Configure runtime.env in the deployment directory before deploying.' >&2; exit 1; }
# Docker env files do not interpret shell quotes or escaped newlines. Prefer single-line service-account JSON.
[[ -w "$app_dir" ]] || { echo 'Deployment user needs write access to /opt/consumer-compass.' >&2; exit 1; }
exec 9>"$app_dir/deploy.lock"
flock -w 300 9

docker network inspect "$network" >/dev/null
(cd "$release_dir" && sha256sum --check image.sha256)
gzip -dc "$release_dir/image.tar.gz" | docker load
actual_revision=$(docker image inspect "$image" --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}')
[[ "$actual_revision" == "$revision" ]] || { echo 'Image revision does not match the tested commit.' >&2; exit 1; }

# Fail before stopping the current app if the database or migrations are unavailable.
docker run --rm --network "$network" --env-file "$app_dir/runtime.env" \
  --entrypoint node "$image" --conditions=react-server --experimental-default-type=module scripts/migrate.mjs

old_stopped=false
old_renamed=false
replacement_created=false
# Registered indirectly as an EXIT trap below.
# shellcheck disable=SC2329
rollback() {
  result=$?
  trap - EXIT
  if (( result != 0 )); then
    echo 'Deployment failed; restoring the previous app container if it was stopped.' >&2
    if [[ "$replacement_created" == true ]]; then docker rm -f "$app_name" >/dev/null 2>&1 || true; fi
    if [[ "$old_renamed" == true ]]; then docker rename "$previous_name" "$app_name"; fi
    if [[ "$old_stopped" == true ]]; then docker start "$app_name" >/dev/null; fi
  fi
  exit "$result"
}
trap 'rollback' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP

if docker container inspect "$app_name" >/dev/null 2>&1; then
  if docker container inspect "$previous_name" >/dev/null 2>&1; then docker rm "$previous_name" >/dev/null; fi
  old_stopped=true
  docker stop --time 150 "$app_name" >/dev/null
  docker rename "$app_name" "$previous_name"
  old_renamed=true
fi
replacement_created=true
docker run -d --name "$app_name" --network "$network" --restart unless-stopped \
  --env-file "$app_dir/runtime.env" -p 127.0.0.1:3000:3000 "$image" >/dev/null

# Phase 5 replaces this boot/readiness check with the dependency-aware health endpoint.
for (( attempt = 0; attempt < 20; attempt++ )); do
  if curl --fail --silent --max-time 5 http://127.0.0.1:3000/auth/login >/dev/null; then
    echo "Deployed $revision"
    exit 0
  fi
  sleep 2
done
echo 'New app did not become ready.' >&2
exit 1
