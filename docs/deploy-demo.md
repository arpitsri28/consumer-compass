# Temporary EC2 demo

This is a deliberately limited first deployment: public Next.js pages behind Nginx,
PostgreSQL persistence storage, Redis, and a dependency health check. Firebase and
OpenRouter are not configured. Login/register show an unavailable notice, protected
pages still require login, and API authentication is not bypassed. No model calls
are made. A successful health check establishes database/Redis connectivity only.

Use the instance's AWS-assigned public DNS name as the temporary hostname. This
bootstrap serves HTTP on port 80. HTTPS, CloudWatch, backups, production logging,
dependency security upgrades, and the complete Phase 5 deployment remain unfinished.
Do not enter real credentials or treat this as a production service.

## Verified deployment

Verified on 2026-10-23 at 05:31 UTC on the existing `t3.micro` EC2 instance in
`us-east-2`, through a manual SSH deployment. GitHub Actions deployment was not run.

Temporary URL: <http://ec2-18-225-184-193.us-east-2.compute.amazonaws.com/>

- External HTTP checks: `/`, `/auth/login`, `/auth/register`, `/logo.webp`, a
  browser JavaScript bundle, and `/api/health` returned 200.
- Home displayed the deployment notice. Login/register displayed the unavailable
  notice and did not render a credential form.
- Unauthenticated `POST /api/chat` and `GET /api/conversations` returned 401.
- Health reported database and Redis connectivity as true.
- `schema_migrations` contained `001_conversations.sql`.
- The running app's user ID was 1000, and its Docker health status was healthy.
- Local lint, 79 unit tests, and the production build passed. The Linux Docker
  build and its migration dependency check also passed on EC2.

Running image ID:
`sha256:34d9141ab8e97d445d22f79a4e7a6884c5c66acc2fa1bba02c4ba1bbefd98452`.

These are deployment smoke checks, not browser automation, load-test results, or
verification of Firebase/OpenRouter functionality.

## Server prerequisites

Ubuntu x86-64, Docker Engine and Compose, 30 GiB gp3 disk, and 2 GiB persistent swap.
The t3.micro demo has approximately 1 GiB RAM; the Compose file limits each service's
memory and rotates logs. Swap reduces out-of-memory risk but does not provide RAM
performance. Building on GitHub Actions is preferable to building on this small host.
The one-off server build uses one Next.js worker and a 512 MiB Node heap limit.

Allow inbound SSH (22) from your IP and HTTP (80) from the internet. PostgreSQL,
Redis, and Next.js have no host port bindings; only Nginx publishes a port. No AWS
resource creation or security group changes are performed by these files.

## First deploy

Transfer the source without `.git`, `node_modules`, `.next`, or environment files to
`/opt/consumer-compass-demo`. Keep this separate from the Phase 4 CI deployment
directory, `/opt/consumer-compass`; that workflow does not manage this demo stack.

On EC2, inside the source directory, generate the database password once:

```bash
umask 077
printf 'POSTGRES_PASSWORD=' > .env.demo
openssl rand -hex 24 >> .env.demo
```

Do not regenerate the password after initializing the database volume; changing an
environment variable does not change an existing PostgreSQL user's password.
`.env.demo` is ignored by Git and excluded from image builds.

Run these commands on EC2:

```bash
docker compose --env-file .env.demo -f docker-compose.demo.yml config --quiet
docker compose --env-file .env.demo -f docker-compose.demo.yml build app
docker compose --env-file .env.demo -f docker-compose.demo.yml up -d --wait postgres redis
docker compose --env-file .env.demo -f docker-compose.demo.yml run --rm --no-deps app \
  node --conditions=react-server --experimental-default-type=module scripts/migrate.mjs
docker compose --env-file .env.demo -f docker-compose.demo.yml up -d --wait
docker compose --env-file .env.demo -f docker-compose.demo.yml ps
curl --fail http://127.0.0.1/api/health
```

Expected health JSON after a successful deployment:

```json
{"status":"ok","checks":{"database":true,"redis":true}}
```

Open `http://YOUR_EC2_PUBLIC_DNS/` from your own computer. The home page should
show the deployment notice; `/auth/login` should show that sign-in is unavailable.
Unauthenticated `POST /api/chat` must return 401, not model output.

## Inspect and stop

```bash
cd /opt/consumer-compass-demo
docker compose --env-file .env.demo -f docker-compose.demo.yml logs --tail 50
docker stats --no-stream
```

Stop the stack without deleting the database:

```bash
docker compose --env-file .env.demo -f docker-compose.demo.yml down
```

Stopping containers does not stop EC2 billing. Stop or terminate the instance in
AWS when finished; retained volumes, snapshots, and allocated addresses can still
incur charges. The AWS-assigned public IP/hostname can change after stopping and
starting the instance.

## Enable integrations later

Add the real Firebase web configuration as Docker build arguments and rebuild.
Supply Firebase Admin and OpenRouter secrets only through the server's runtime
environment; this demo Compose file intentionally does not configure them. Complete
HTTPS and the remaining deployment hardening before enabling real user accounts.

No new dependency was introduced for this bootstrap. The standalone image retains
the migration script and its server dependencies, runs as the non-root `node` user,
and checks `/api/health`. A health failure marks the container unhealthy; Docker's
restart policy alone does not restart an unhealthy process that is still running.
