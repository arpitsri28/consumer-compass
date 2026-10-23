# Deploy Consumer Compass on EC2

This guide describes one Ubuntu x86-64 EC2 host running Next.js, PostgreSQL 16,
Redis 7 and Nginx. It is a small single-host deployment, with downtime during app
replacement and no database high availability. The current demo deliberately leaves
Firebase and OpenRouter unconfigured. Public pages work; sign-in and chat are unavailable,
and authenticated APIs remain protected. Health checks cover PostgreSQL and Redis,
not Firebase or the model provider.

Commands marked **Mac** run locally. Commands marked **EC2** run after SSH. AWS
commands run from your own authenticated AWS CLI session, except the backup and
health scripts, which use the EC2 IAM role. Nothing in this document creates an AWS
resource until you run its command. S3, logs, metrics, alarms and allocated storage
can incur charges; review the account's current plan and pricing.

## 1. Instance, network and hostname

In **EC2 → Launch instance**, select Ubuntu Server 24.04 or 26.04 LTS, **x86-64**,
a key pair you keep outside the repository, and an encrypted 30 GiB gp3 root disk.
A t3.micro works for this limited demo with 2 GiB swap; it is not a capacity claim
for real users. Build images in CI where possible. The Compose memory limits are
small-instance defaults, not load-tested production sizing.

Use a public subnet with an internet gateway and public IPv4 enabled. Security
Group inbound rules: SSH/22 from **your current IP /32**, HTTP/80 and HTTPS/443
from `0.0.0.0/0`. Add IPv6 rules only if you intentionally configure IPv6. Do not
expose PostgreSQL/5432, Redis/6379, or Next.js/3000. Require IMDSv2 under instance
metadata options; leave the hop limit at 1 so the app containers cannot obtain the
instance role through metadata. The host Docker daemon and host AWS CLI use that role.

**Mac**, replacing the address/key name:

```bash
chmod 400 ~/.ssh/consumer-compass.pem
ssh -i ~/.ssh/consumer-compass.pem ubuntu@YOUR_PUBLIC_IP
```

Verify the server fingerprint using **Actions → Monitor and troubleshoot → Get
system log** before accepting it. On the instance, check `cat /etc/os-release`,
`free -h`, and `df -h /`.

For a temporary hostname use `consumer-compass.YOUR-PUBLIC-IP.sslip.io` with dashes
in the IP, e.g. `consumer-compass.18-225-184-193.sslip.io`. Confirm it resolves to
your instance. This is a third-party DNS service, not a domain you own. An owned
domain's A record is preferable for long-term use. An automatically assigned public
IP can change after stop/start; update DNS and reissue the certificate if it does.
An optional Elastic IP provides stability but has its own charges.

## 2. Docker and swap

**EC2**. On a fresh server with no existing `/swapfile`, run once:

```bash
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
printf '/swapfile none swap sw 0 0\n' | sudo tee -a /etc/fstab
```

Install Docker from its official repository using the actual Ubuntu codename:

```bash
sudo apt update
sudo apt install -y ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
sudo tee /etc/apt/sources.list.d/docker.sources > /dev/null <<SOURCES
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: $(. /etc/os-release && echo "$VERSION_CODENAME")
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
SOURCES
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
sudo usermod -aG docker ubuntu
exit
```

Reconnect over SSH, then run `docker run --rm hello-world` and `docker compose version`.
Use Compose **2.30 or newer**: raw environment files and the optional `!override`
logging configuration require a recent version. Docker group membership grants
administrative access to this host. Swap reduces memory exhaustion risk, not CPU or
RAM requirements. Reboot after OS updates if Ubuntu indicates it is required.

## 3. Transfer source and configure secrets

**Mac**, from the repository root, without local credentials or build artifacts:

```bash
tar -czf /tmp/consumer-compass-source.tar.gz \
  Dockerfile .dockerignore .eslintrc.json next.config.mjs jsconfig.json \
  package.json package-lock.json app public migrations scripts deploy \
  docker-compose.prod.yml docker-compose.cloudwatch.yml
scp -i ~/.ssh/consumer-compass.pem /tmp/consumer-compass-source.tar.gz ubuntu@YOUR_PUBLIC_IP:/tmp/
```

**EC2**:

```bash
sudo install -d -o ubuntu -g ubuntu -m 750 /opt/consumer-compass
cd /opt/consumer-compass
tar -xzf /tmp/consumer-compass-source.tar.gz
rm /tmp/consumer-compass-source.tar.gz
umask 077
cp deploy/production.env.example .env.production
cp deploy/runtime.env.example runtime.env
openssl rand -hex 24
nano .env.production
nano runtime.env
chmod 600 .env.production runtime.env
mkdir -p state/nginx state/acme state/letsencrypt
cp deploy/http.conf.template state/nginx/default.conf.template
```

Paste the generated hex password into `POSTGRES_PASSWORD`. Set `DOMAIN` to your
resolving hostname, `DEPLOYMENT_ID=consumer-compass`, and initially
`APP_IMAGE=consumer-compass:initial`. Set `AWS_REGION` if using AWS scripts.

`.env.production` is Compose interpolation configuration. `runtime.env` uses
**raw Docker environment-file syntax**: no wrapping shell quotes, and single-line
Firebase service-account JSON with `\n` inside the JSON string. Do not copy quoted
multiline dotenv private keys into it. DATABASE_URL and REDIS_URL are supplied by
Compose. Secrets stay on EC2, never in Git, the image, build arguments, or CI logs.

For the current no-auth demo, keep only `LOG_LEVEL=info` in runtime.env. When ready,
add Firebase Admin credentials and OpenRouter settings from `.env.example`. The
Firebase web settings are public **build arguments**: pass the six documented
`NEXT_PUBLIC_FIREBASE_*` variables to `docker build` or configure them as GitHub
variables. Rebuild after changing them. Do not use fake web configuration to enable
login. Authentication is enabled only when the four required public fields exist.

Create the named PostgreSQL volume once:

```bash
docker volume create consumer-compass-postgres
```

The production Compose volume is external, so normal stack teardown does not remove
it. Do not remove it manually unless you intend to erase the database. For an
existing database, preserve its original password: changing the environment variable
does not change a PostgreSQL password stored in the volume.

### Moving the earlier demo into production Compose

Our existing demo used `/opt/consumer-compass-demo` and volume
`consumer-compass-demo_postgres_data`. Reuse that volume by setting `POSTGRES_VOLUME`
to that exact name and copying the **existing** POSTGRES_PASSWORD privately into
`.env.production`. Build and test the new image first. Then stop the old stack with
`docker compose --env-file .env.demo -f docker-compose.demo.yml down` in the old
folder, **without `-v`**, before starting the production stack. Never run two
PostgreSQL containers against the same data volume simultaneously. Keep the old
source, image, and environment file for a manual fallback.

## 4. First build, migrate and start

**EC2**, `/opt/consumer-compass`:

```bash
docker build -t consumer-compass:initial .
bash scripts/compose-prod.sh config --quiet
bash scripts/compose-prod.sh up -d --wait postgres redis
bash scripts/compose-prod.sh run --rm --no-deps app \
  node --conditions=react-server --experimental-default-type=module scripts/migrate.mjs
bash scripts/compose-prod.sh up -d --wait --wait-timeout 120
printf 'consumer-compass:initial\n' > .deployed-image
bash scripts/compose-prod.sh ps
curl --fail http://127.0.0.1:3000/api/health
```

The migration runner uses a PostgreSQL advisory lock and records applied SQL files.
Never edit an applied migration; add a new file. Apply backward-compatible migrations
before app replacement. Migrations are not automatically reversed by app rollback.
Take a backup before risky schema changes.

Open `http://YOUR_DOMAIN/` from another machine. `/api/health` should return
`{"status":"ok","checks":{"database":true,"redis":true}}`; it returns 503 if
either dependency fails. No authorization is required for this boolean-only health
endpoint. App Docker health checks use it, and Compose waits for health before
starting Nginx. An unhealthy process is marked unhealthy; the Docker restart policy
only restarts exited processes. It is not an automatic health-recovery controller.

The standalone runtime runs as UID 1000. Only Nginx publishes public ports; Next.js
is additionally reachable at localhost:3000 for operator checks. The Dockerfile checks
the unbundled migration dependencies during image construction, including pg's ESM
entry point. The PostgreSQL data volume survives application replacement; Redis is
an ephemeral rate-limit store, and restarting it resets quota counters.

## 5. HTTPS and renewal

Confirm DNS resolves correctly and ports **80 and 443** are allowed. Then **EC2**:

```bash
cd /opt/consumer-compass
bash scripts/enable-https.sh YOUR_DOMAIN
sudo cp deploy/consumer-compass-renew.service deploy/consumer-compass-renew.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now consumer-compass-renew.timer
sudo systemctl list-timers consumer-compass-renew.timer
```

This requests a Let's Encrypt certificate using Certbot's HTTP-01 webroot challenge,
accepts the CA terms, and switches the active Nginx template from HTTP to HTTPS.
It registers without an email by default; optionally prefix the command with
`CERTBOT_EMAIL=you@example.com` to receive account communications. Private keys stay
under `state/letsencrypt` on EC2 and are mounted read-only into Nginx. Nginx redirects
HTTP to the configured HTTPS hostname while keeping ACME challenges accessible.
The script restores the previous Nginx template if local TLS verification fails.

Test from your Mac using `curl --fail https://YOUR_DOMAIN/api/health`; do not use
`-k`. Inspect the certificate expiry using your browser or OpenSSL. Test renewal:

```bash
sudo bash /opt/consumer-compass/scripts/renew-cert.sh --dry-run
sudo journalctl -u consumer-compass-renew.service --no-pager -n 30
```

Renewal runs twice daily with randomized delay and reloads Nginx after success.
`--dry-run` uses the CA staging environment and does not replace the live certificate.
The chat location has `proxy_buffering off`, `proxy_cache off`, `gzip off`, and a
150-second read timeout; JSON and raw-text streams keep their application headers.
A temporary DNS provider or CA can reject requests or apply rate limits; don't keep
retrying production issuance. Resolve the reported DNS/challenge error first.

## 6. Updates, CI and rollback

The GitHub workflow runs lint, migration, all tests, and build on PRs/main. A main
push then builds an x86 image tagged with its tested commit SHA, transfers it over
SSH, verifies the archive checksum and image revision label, migrates, and replaces
**only the app** using installed production Compose configuration. Nginx reloads
once the new app is healthy. This introduces downtime; no zero-downtime claim is made.
Provision the host configuration above before enabling CI deployment.

In GitHub **Settings → Environments → production**, add secrets:

| Secret | Value |
|---|---|
| EC2_HOST | Current public IP or DNS hostname |
| EC2_USER | `ubuntu` |
| EC2_SSH_PRIVATE_KEY | Dedicated, unencrypted deployment SSH private key |
| EC2_SSH_KNOWN_HOSTS | Verified SSH host-key entries for that host and port |

Variables: optional `EC2_SSH_PORT` (default 22), and the six public Firebase fields
from `.env.example`. Leave all Firebase variables empty for this demo; provide a
complete required set when enabling login. Server credentials stay in runtime.env.
Use a dedicated deployment key rather than a personal key. Derive known_hosts with
`ssh-keyscan` only after comparing its fingerprint against an independently verified
AWS system log; scanning alone is not trust verification.

GitHub-hosted runners cannot SSH through a security-group rule limited to your home
IP. Before enabling automated deploy, either use a trusted self-hosted runner with
an explicitly allowed source address, or arrange restricted runner access through
your network tooling. Do not permanently expose SSH to the whole internet. The
current manual deployment does not demonstrate a successful GitHub Actions run.

For a manual update, build `consumer-compass:SHA` with
`--build-arg SOURCE_REVISION=SHA`, save it to `image.tar.gz`, create `image.sha256`
with `sha256sum image.tar.gz`, and transfer the bundle plus `scripts/deploy-ec2.sh`
to a private release directory on EC2. Run `bash /path/to/release/deploy-ec2.sh SHA`.
Build arguments for Firebase must match the configured web project. Keep release
archives private, and remove them after verified deployment.

The deploy script records `.deployed-image` and `.previous-image` after success.
`scripts/compose-prod.sh` uses `.deployed-image` unless APP_IMAGE is explicitly set.
On a failed replacement it restores the previous image and reloads Nginx. That
rollback path is tested with fake Docker commands; first deploy has no previous
release to restore. Keep the previous image until the replacement is verified.

For manual rollback **on EC2**:

```bash
cd /opt/consumer-compass
previous=$(cat .previous-image)
APP_IMAGE="$previous" bash scripts/compose-prod.sh up -d --no-deps --force-recreate --wait app
APP_IMAGE="$previous" bash scripts/compose-prod.sh exec -T nginx nginx -s reload
curl --fail http://127.0.0.1:3000/api/health
printf '%s\n' "$previous" > .deployed-image
```

Inspect an image before using its name if the state file is missing or unfamiliar.
Rollback restores application code, not schema/data. Incompatible migrations require
an explicit recovery plan. Source/Compose/Nginx/script changes are infrastructure
updates: transfer them deliberately, validate Compose/Nginx, and restart/reload the
relevant services. CI does not silently upgrade the whole database/proxy stack.

## 7. Structured request logs

Pino emits JSON to stdout for all exported API handlers: `requestId`, `method`,
route-template `path`, `status`, `latencyMs`, and `uid` (null when unauthenticated).
Each response gets `X-Request-ID`. Query strings, messages, credentials, provider
errors, and request/response bodies are omitted. Internal warnings/errors are static
event names. `LOG_LEVEL` controls verbosity; use `info` for request records.

For chat, logging observes streaming EOF, error, request abort or downstream cancel
without collecting the response. A mid-stream failure can have HTTP `status:200`
because headers were already sent; inspect `outcome:error/aborted/cancelled`. The
latency then covers the stream's lifetime, not just time to first byte. Normal JSON
latency covers handler work. AsyncLocalStorage isolates authenticated UIDs between
concurrent requests.

Nginx logs all HTTP requests as JSON with its own fallback ID, method, path, status,
latency in seconds, and deployment ID; API responses reuse the app's correlation ID.
It does not log query strings, headers or bodies. Page/static requests have no
verified Firebase UID. Nginx and API log events are intentionally separate; count
only `event:http_request` when computing the proxy's HTTP error rate.

```bash
cd /opt/consumer-compass
bash scripts/compose-prod.sh logs --tail 100 app nginx
docker stats --no-stream
```

Default Docker JSON logs rotate at 5 MiB × 2 per container. This is distinct from
the optional CloudWatch transport below. Failed health checks produce 503 request
logs. Docker health status does not imply that authentication/model access works.

## 8. S3 backups and the EC2 IAM role

These are **user-run setup commands**, not resources this phase created. Install
AWS CLI v2 and authenticate your own administration session (prefer IAM Identity
Center/SSO). Never put permanent AWS access keys into runtime.env or the image.
The instance scripts use a narrowly scoped EC2 role instead.

In your authenticated administration terminal, set actual values:

```bash
export AWS_REGION=us-east-2
INSTANCE_ID=YOUR_INSTANCE_ID
AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
BACKUP_BUCKET="consumer-compass-$AWS_ACCOUNT_ID-backups-$AWS_REGION"
CW_LOG_GROUP=/consumer-compass/production
DEPLOYMENT_ID=consumer-compass
```

Create the backup bucket (this example region is not us-east-1):

```bash
aws s3api create-bucket --bucket "$BACKUP_BUCKET" --region "$AWS_REGION" \
  --create-bucket-configuration "LocationConstraint=$AWS_REGION"
aws s3api put-public-access-block --bucket "$BACKUP_BUCKET" \
  --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
aws s3api put-bucket-encryption --bucket "$BACKUP_BUCKET" \
  --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'
aws s3api put-bucket-versioning --bucket "$BACKUP_BUCKET" --versioning-configuration Status=Enabled
aws s3api put-bucket-lifecycle-configuration --bucket "$BACKUP_BUCKET" \
  --lifecycle-configuration '{"Rules":[{"ID":"expire-backups","Status":"Enabled","Filter":{"Prefix":"postgres/"},"Expiration":{"Days":30},"NoncurrentVersionExpiration":{"NoncurrentDays":7},"AbortIncompleteMultipartUpload":{"DaysAfterInitiation":1}}]}'
```

For us-east-1 omit `--create-bucket-configuration`. If a resource already exists,
inspect it and reuse your intended resource rather than suppressing errors. Set an
appropriate retention policy for your own recovery requirements. Backups contain
private conversations; keep access restricted and encryption enabled.

Create a log group and an EC2 role/profile (names assume first setup):

```bash
aws logs create-log-group --log-group-name "$CW_LOG_GROUP"
aws logs put-retention-policy --log-group-name "$CW_LOG_GROUP" --retention-in-days 7
cat > /tmp/compass-trust.json <<'JSON'
{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}
JSON
aws iam create-role --role-name ConsumerCompassInstanceRole --assume-role-policy-document file:///tmp/compass-trust.json
cat > /tmp/compass-policy.json <<JSON
{"Version":"2012-10-17","Statement":[
 {"Effect":"Allow","Action":["logs:CreateLogStream","logs:PutLogEvents"],"Resource":"arn:aws:logs:$AWS_REGION:$AWS_ACCOUNT_ID:log-group:$CW_LOG_GROUP:*"},
 {"Effect":"Allow","Action":"cloudwatch:PutMetricData","Resource":"*","Condition":{"StringEquals":{"cloudwatch:namespace":"ConsumerCompass"}}},
 {"Effect":"Allow","Action":["s3:PutObject","s3:GetObject","s3:AbortMultipartUpload"],"Resource":"arn:aws:s3:::$BACKUP_BUCKET/postgres/*"}
]}
JSON
aws iam put-role-policy --role-name ConsumerCompassInstanceRole --policy-name ConsumerCompassOperations --policy-document file:///tmp/compass-policy.json
aws iam create-instance-profile --instance-profile-name ConsumerCompassInstanceProfile
aws iam add-role-to-instance-profile --instance-profile-name ConsumerCompassInstanceProfile --role-name ConsumerCompassInstanceRole
aws ec2 associate-iam-instance-profile --instance-id "$INSTANCE_ID" --iam-instance-profile Name=ConsumerCompassInstanceProfile
```

Wait for IAM propagation before testing. If the instance already has a profile, review
and update that profile through **EC2 → Actions → Security → Modify IAM role**;
do not blindly replace unrelated permissions. No administrator policy is needed on
the host. The role allows reading/writing only this backup prefix and publishing
the configured logs/metrics. Docker's daemon obtains role credentials on the host;
the app container should not be able to reach EC2 metadata with hop limit 1.

Install AWS CLI v2 **on EC2** if needed:

```bash
sudo apt install -y unzip
curl -fsSL https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip -o /tmp/awscliv2.zip
unzip -q /tmp/awscliv2.zip -d /tmp/compass-awscli
sudo /tmp/compass-awscli/aws/install
aws --version
```

Set AWS_REGION in your session, then run a backup **on EC2**, supplying the bucket name:

```bash
cd /opt/consumer-compass
export AWS_DEFAULT_REGION=us-east-2
bash scripts/backup-db.sh YOUR_BACKUP_BUCKET
```

The script runs a consistent logical `pg_dump`, compresses it in a mode-600 temp
file, uploads with SSE-S3, and removes the local file on success or failure. It fails
if dump/compression/upload fails. Run before migrations and on your chosen schedule.
For daily scheduling, install a root cron entry using the actual bucket name:

```cron
17 3 * * * AWS_DEFAULT_REGION=us-east-2 /bin/bash /opt/consumer-compass/scripts/backup-db.sh YOUR_BACKUP_BUCKET >> /var/log/consumer-compass-backup.log 2>&1
```

Test restores to a **new disposable database**, never overwrite the live database:

```bash
aws s3 cp s3://YOUR_BACKUP_BUCKET/postgres/YOUR_BACKUP.sql.gz /tmp/compass-restore.sql.gz
cd /opt/consumer-compass
bash scripts/compose-prod.sh exec -T postgres createdb -U consumer_compass consumer_compass_restore_test
gunzip -c /tmp/compass-restore.sql.gz | bash scripts/compose-prod.sh exec -T postgres \
  psql -v ON_ERROR_STOP=1 -U consumer_compass -d consumer_compass_restore_test
bash scripts/compose-prod.sh exec -T postgres psql -U consumer_compass -d consumer_compass_restore_test -c '\dt'
```

Use `set -o pipefail` in the restore shell, validate the restored schema/data, then
remove the disposable database and downloaded private backup. Recovery timing and
S3 restore were not benchmarked or validated by merely writing these commands.

## 9. CloudWatch logs, health and alarms

After the role/log group above exist, **EC2**: append `AWS_REGION=us-east-2` and
`CW_LOG_GROUP=/consumer-compass/production` to `.env.production`, without duplicate
keys. Then enable the optional AWS logging driver:

```bash
cd /opt/consumer-compass
touch .cloudwatch-enabled
bash scripts/compose-prod.sh config --quiet
bash scripts/compose-prod.sh up -d --force-recreate --wait
```

This recreates services, including PostgreSQL, so schedule a maintenance window.
The Docker `awslogs` driver sends raw stdout/stderr events to CloudWatch, avoiding a
second Docker JSON envelope around Pino/Nginx JSON. It uses a 1 MiB nonblocking
buffer per container; a logging outage can drop buffered events instead of blocking
HTTP responses. Retention is configured on the log group. The default local rotating
logging configuration is used again after removing `.cloudwatch-enabled` and
recreating containers. Do not enable the override until IAM/log group access works.

**Administration terminal**, create metric filters for Nginx JSON only:

```bash
aws logs put-metric-filter --log-group-name "$CW_LOG_GROUP" --filter-name HTTPRequests \
  --filter-pattern '{ $.event = "http_request" }' \
  --metric-transformations 'metricName=HTTPRequests,metricNamespace=ConsumerCompass,metricValue=1,unit=Count,dimensions={Deployment=$.deployment}'
aws logs put-metric-filter --log-group-name "$CW_LOG_GROUP" --filter-name HTTP5xx \
  --filter-pattern '{ ($.event = "http_request") && ($.status >= 500) }' \
  --metric-transformations 'metricName=HTTP5xx,metricNamespace=ConsumerCompass,metricValue=1,unit=Count,dimensions={Deployment=$.deployment}'
```

Filters apply to new ingested logs, not historical ones. Confirm a new page request
appears in **CloudWatch → Logs → Log groups → your group**, then verify the custom
metrics under **Metrics → ConsumerCompass → Deployment**. Nginx logs use seconds;
Pino API logs use milliseconds. Do not combine their latency fields blindly.

**EC2**, enable the one-minute HTTPS health probe only after CLI/IAM/TLS work:

```bash
cd /opt/consumer-compass
grep -E '^(DOMAIN|AWS_REGION|DEPLOYMENT_ID)=' .env.production > monitoring.env
chmod 600 monitoring.env
sudo cp deploy/consumer-compass-health.service deploy/consumer-compass-health.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl start consumer-compass-health.service
sudo systemctl enable --now consumer-compass-health.timer
sudo journalctl -u consumer-compass-health.service --no-pager -n 20
```

The probe checks the real Nginx HTTPS listener and dependency-aware endpoint using
local address resolution with normal certificate verification. It publishes 0 for
healthy and 1 for failed. Missing probe metrics are treated as a health failure by
the alarm; this also catches probe/IAM failures. It is a host-local probe, not an
independent external availability monitor.

**Administration terminal**, optionally create an SNS destination and confirm the
subscription from your email before expecting notifications:

```bash
ALARM_TOPIC_ARN=$(aws sns create-topic --name consumer-compass-alerts --query TopicArn --output text)
aws sns subscribe --topic-arn "$ALARM_TOPIC_ARN" --protocol email --notification-endpoint YOUR_EMAIL
```

Create alarms with these example thresholds, which are operational defaults rather
than measured service limits:

```bash
aws cloudwatch put-metric-alarm --alarm-name consumer-compass-health \
  --namespace ConsumerCompass --metric-name HealthCheckFailed \
  --dimensions "Name=Deployment,Value=$DEPLOYMENT_ID" --statistic Maximum \
  --period 60 --evaluation-periods 3 --datapoints-to-alarm 2 \
  --threshold 1 --comparison-operator GreaterThanOrEqualToThreshold \
  --treat-missing-data breaching --alarm-actions "$ALARM_TOPIC_ARN"
aws cloudwatch put-metric-alarm --alarm-name consumer-compass-cpu \
  --namespace AWS/EC2 --metric-name CPUUtilization \
  --dimensions "Name=InstanceId,Value=$INSTANCE_ID" --statistic Average \
  --period 300 --evaluation-periods 3 --datapoints-to-alarm 3 \
  --threshold 80 --comparison-operator GreaterThanThreshold \
  --treat-missing-data missing --alarm-actions "$ALARM_TOPIC_ARN"
cat > /tmp/compass-5xx.json <<JSON
[
 {"Id":"requests","MetricStat":{"Metric":{"Namespace":"ConsumerCompass","MetricName":"HTTPRequests","Dimensions":[{"Name":"Deployment","Value":"$DEPLOYMENT_ID"}]},"Period":300,"Stat":"Sum"},"ReturnData":false},
 {"Id":"errors","MetricStat":{"Metric":{"Namespace":"ConsumerCompass","MetricName":"HTTP5xx","Dimensions":[{"Name":"Deployment","Value":"$DEPLOYMENT_ID"}]},"Period":300,"Stat":"Sum"},"ReturnData":false},
 {"Id":"rate","Expression":"IF(requests>=20,100*FILL(errors,0)/requests,0)","Label":"HTTP 5xx percent","ReturnData":true}
]
JSON
aws cloudwatch put-metric-alarm --alarm-name consumer-compass-http-5xx \
  --metrics file:///tmp/compass-5xx.json --evaluation-periods 3 --datapoints-to-alarm 2 \
  --threshold 5 --comparison-operator GreaterThanThreshold \
  --treat-missing-data notBreaching --alarm-actions "$ALARM_TOPIC_ARN"
```

The CPU alarm uses EC2's five-minute basic metrics. The 5xx alarm checks a percentage
only when a five-minute window has at least 20 requests, fills sparse error counts
with zero, and uses 2-of-3 windows to reduce late-ingestion artifacts. API stream
errors after headers do not become HTTP 5xx and must be inspected through Pino's
`outcome` field. The health alarm covers low-traffic outages independently.

Check **CloudWatch → Alarms → All alarms** and **History** after metrics arrive;
`INSUFFICIENT_DATA` immediately after creation is expected. Test alarm routing during
a planned maintenance window. No alarm, notification delivery, or S3 restore is
proven until you configure and verify it in your account.

## 10. Shutdown and remaining limitations

Stop containers without deleting the database using
`bash scripts/compose-prod.sh down`. Stop/terminate the instance in AWS separately
when your demonstration is finished. Remove or retain volumes, snapshots, Elastic
IPs, log groups, S3 versions and alarms deliberately; stopping containers does not
remove those resources or their potential charges. Never run a blanket account cleanup.

Firebase/OpenRouter setup remains deferred by request. The dependency patch update
reduces exposure but is not a security certification; inspect `npm audit --omit=dev`
and plan supported framework upgrades before accepting real users. This phase does
not claim zero downtime, automatic unhealthy-container recovery, successful CI SSH
access, tested cloud alarms/backups, or load-test throughput. Phase 6 remains separate.

## References

- [Docker installation on Ubuntu](https://docs.docker.com/engine/install/ubuntu/)
- [Docker's CloudWatch Logs driver](https://docs.docker.com/engine/logging/drivers/awslogs/)
- [Certbot webroot and renewal](https://eff-certbot.readthedocs.io/en/stable/using.html)
- [Temporary sslip.io DNS and TLS](https://nip.io/)
- [CloudWatch metric math](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/using-metric-math.html)
- [AWS CLI installation](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html)
