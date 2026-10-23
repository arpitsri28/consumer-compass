#!/usr/bin/env bash
set -euo pipefail
bucket=${1:?Pass the S3 backup bucket name}
[[ "$bucket" =~ ^[a-z0-9][a-z0-9.-]+[a-z0-9]$ ]] || { echo 'Invalid bucket name.' >&2; exit 1; }
app_dir=${COMPASS_DEPLOY_DIR:-/opt/consumer-compass}
umask 077
backup=$(mktemp /tmp/consumer-compass-backup.XXXXXX.sql.gz)
trap 'rm -f "$backup"' EXIT
bash "$app_dir/scripts/compose-prod.sh" exec -T postgres \
  pg_dump -U consumer_compass -d consumer_compass --no-owner --no-acl | gzip > "$backup"
key="postgres/$(date -u +%Y-%m-%dT%H-%M-%SZ).sql.gz"
aws s3 cp "$backup" "s3://$bucket/$key" --sse AES256 --only-show-errors
echo "Backup uploaded to s3://$bucket/$key"
