#!/usr/bin/env bash
set -euo pipefail
: "${DOMAIN:?Set DOMAIN}"
: "${AWS_REGION:?Set AWS_REGION}"
: "${DEPLOYMENT_ID:?Set DEPLOYMENT_ID}"
failed=0
if ! curl --fail --silent --show-error --max-time 15 \
  --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/api/health" >/dev/null; then failed=1; fi
aws cloudwatch put-metric-data --region "$AWS_REGION" --namespace ConsumerCompass \
  --metric-name HealthCheckFailed --dimensions "Name=Deployment,Value=$DEPLOYMENT_ID" \
  --value "$failed" --unit Count
