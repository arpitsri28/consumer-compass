# Phase 4: Vitest, integration tests, and CI/CD

This phase migrates tests to Vitest, tests the exported API routes against real PostgreSQL and Redis, and adds the GitHub Actions workflow plus its SSH deployment script. No GitHub workflow or AWS deployment has been executed by this local work.

The request places Docker image deployment in Phase 4 but the production Dockerfile in Phase 5. To make the Phase 4 workflow concrete, a baseline Dockerfile is included now. It runs `next start` with production dependencies as a non-root user. Standalone output, the dependency-aware health endpoint, production Compose/nginx/HTTPS, and AWS provisioning/operations documentation remain in Phase 5.

## Test setup

Vitest 4.1.12 runs the tests; Vite 6.4.5 is pinned to a compatible major so the existing Node.js 20.16 workspace can run it. CI and the container use Node.js 22. These are the only new development dependencies; no runtime dependency was added. Node's built-in assertions remain in tests for readability.

```bash
npm ci
npm test
```

`npm test` runs the `unit` Vitest project without external services. It covers request/configuration validation, history truncation, limiter decisions/fail-open behavior, token verification, route failures/streaming, client retry decisions, Markdown security, and deployment control flow.

Vitest aliases `server-only` to a test-only empty module because these tests run outside the Next.js React server compiler. Production builds still use the real package and its client-import protection. Firebase Admin is mocked at its module boundary in `tests/firebase-admin.test.mjs`, exercising the default initializer/verifier, app reuse, credentials, revocation checks, and error mapping. The earlier dependency-injected tests are retained.

The config optionally loads `.env.local` using Node's native `loadEnvFile`; exported environment variables take precedence. The test runner does not require experimental default-module flags. The existing migration CLI retains its server-only condition/module flags because it runs outside Vitest.

### Real service tests

Docker Compose is used instead of Testcontainers to keep lifecycle commands explicit:

```bash
docker compose -p consumer-compass-test -f docker-compose.test.yml up -d --wait
```

Create `.env.local` from `.env.example` if it does not already exist, and add:

```env
TEST_DATABASE_URL=postgresql://compass_test:local-test-only@127.0.0.1:55432/consumer_compass_test
TEST_REDIS_URL=redis://127.0.0.1:56379/15
```

Apply migrations specifically to the test database, then run all projects:

```bash
DATABASE_URL=postgresql://compass_test:local-test-only@127.0.0.1:55432/consumer_compass_test npm run db:migrate
npm run test:all
docker compose -p consumer-compass-test -f docker-compose.test.yml down
```

The Compose database uses tmpfs and no named data volume. This setup is disposable and must not be used for retained application data. Test fixtures have unique uids and clean up only their own rows/keys. Database tests reject a database name that does not end in `_test`; Redis tests require an explicit disposable test URL and never flush Redis.

| Command | Vitest project / requirement |
|---|---|
| `npm test` | Unit, mocked-route, client/helper, Markdown, and deployment control-flow tests; no services |
| `npm run test:db` | PostgreSQL access-layer and exported API tests; requires both test services |
| `npm run test:redis` | Redis integration tests; requires test Redis |
| `npm run test:all` | All projects; requires migrated test PostgreSQL and test Redis |

The ordered persistence suite exercises parameterized queries, upserts, ownership, indexes' expected ordering, auto-titles, transactions, rollback/recovery, locks, retry-in-place, abort persistence, and cascade deletion. The Redis suite tests atomic parallel requests, user isolation, expiry/reset, and TTL repair.

`tests/api.integration.mjs` imports the actual exported Next.js route functions, uses real PostgreSQL/Redis, and mocks Firebase Admin and the OpenAI SDK used for OpenRouter. It verifies:

- 401 without a token or with an invalid token.
- 400 for a bad request body without saving a turn.
- 404 for another user's conversation on chat and item endpoints.
- 429 plus `Retry-After` from the real Redis limiter, without another saved turn/provider call.
- Successful streaming and persisted user/assistant rows.
- Abort propagation to the SDK and incomplete partial-message persistence.
- Conversation create/list/rename/delete through the exported handlers.

The tests do not introduce a production authentication bypass or call real Firebase/OpenRouter services. Route-function tests do not replace a full browser or deployed reverse-proxy test.

Deployment tests run the real shell script against fake local Docker/curl/flock/checksum commands in temporary directories. They cover normal replacement, migration failure before stopping the app, startup failure rollback, and invalid/missing configuration. They do not claim to test real SSH transport or an EC2 host.

## GitHub Actions

[`.github/workflows/ci.yml`](../.github/workflows/ci.yml) runs on all pull requests and pushes to `main`.

The `check` job uses PostgreSQL 16 and Redis 7 service containers, installs with `npm ci`, runs lint, migrations, all tests, the Next.js production build, and shell syntax validation. It uses `.env.example` public Firebase placeholders and disposable database credentials. It needs no real service/API credentials, including for fork pull requests.

On a push to `main`, after `check` succeeds, the `deploy` job:

1. Uses the GitHub `production` environment and checks deployment settings.
2. Builds `consumer-compass:<full commit SHA>` for `linux/amd64`, with the six public Firebase build arguments and an OCI revision label.
3. Saves a gzipped Docker image, deployment script, and SHA-256 checksum.
4. Transfers the bundle over SSH/SCP with strict host-key verification.
5. Runs the remote deployment script and removes the successful transfer bundle.
6. Removes SSH credentials from the temporary runner even on failure.

There is no registry dependency or registry token. SSH image transfer is simpler for one EC2 machine, at the cost of larger transfers and fewer registry/cache features. Only `contents: read` is granted to the workflow token. Deployment does not run on pull requests. Concurrency cancels outdated PR checks while allowing a running `main` deployment to finish.

### Required GitHub secrets

Create an environment named **production** under repository **Settings → Environments**, restrict it to `main`, and configure these environment secrets. Environment approval rules are your choice; none are assumed to exist.

| Secret | Required value |
|---|---|
| `EC2_HOST` | The DNS name or IPv4 address of your EC2 instance; no URL scheme or shell syntax |
| `EC2_USER` | The dedicated Linux deployment user, for example `ubuntu` if that is your chosen account |
| `EC2_SSH_PRIVATE_KEY` | The unencrypted private key used by that user for noninteractive deployment; an Ed25519 key is recommended |
| `EC2_SSH_KNOWN_HOSTS` | Verified OpenSSH `known_hosts` entry/entries for that host; for a nondefault port, use `[host]:port` format |

Verify the server host-key fingerprint through an independently trusted channel such as the EC2 console before storing `EC2_SSH_KNOWN_HOSTS`. The workflow does not blindly trust `ssh-keyscan` output and never disables host checking. Install the matching deployment public key in that user's `authorized_keys`. Do not commit either private key.

### Required GitHub variables

Public Firebase web configuration belongs in production environment **variables**, not server-secret fields. Set all six from the Firebase web app configuration:

- `NEXT_PUBLIC_FIREBASE_API_KEY`
- `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN`
- `NEXT_PUBLIC_FIREBASE_PROJECT_ID`
- `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET`
- `NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID`
- `NEXT_PUBLIC_FIREBASE_APP_ID`

`EC2_SSH_PORT` is an optional production environment variable; it defaults to `22`. The workflow fails with a setting name, without printing its value, when required configuration is absent.

Firebase Admin credentials, `OPENROUTER_API_KEY`, `DATABASE_URL`, and `REDIS_URL` stay in the instance's runtime environment file. They are not sent as build arguments or required by CI. Public Firebase values are embedded at build time, so changing those values requires another image build.

## EC2 prerequisites and remote contract

The workflow assumes an **x86-64 Ubuntu host**. An ARM/Graviton target requires changing the build platform and validating that image on the matching architecture. No instance, database, security group, IAM role, DNS record, certificate, or GitHub environment is assumed to exist.

Before enabling this workflow against a real host, you must arrange:

- Docker Engine, Bash, `flock`, `gzip`, `sha256sum`, and `curl` on the host.
- A deployment user able to use Docker and write `/opt/consumer-compass`. Docker access grants substantial host privileges; use a dedicated deployment key/account.
- A Docker network named `consumer-compass`, with PostgreSQL/Redis reachable from containers on it, or equivalent reachable database URLs. The script does not create database resources.
- A readable `/opt/consumer-compass/runtime.env` with real server settings, mode 600 and owned by the deployment user. `COMPASS_DEPLOY_DIR` can override the directory for a manual invocation/test; the workflow uses the default path.
- Port 3000 available for the app's localhost-only binding. A reverse proxy/HTTPS setup will be provided in Phase 5; this phase does not expose the app directly to the internet.
- SSH access from the chosen GitHub runner to the instance. Decide your network access policy rather than assuming runner connectivity or opening a security group here.

Docker's `--env-file` syntax is not shell/dotenv syntax: do not wrap values in shell quotes. Prefer a single-line `FIREBASE_SERVICE_ACCOUNT_JSON={...}` with JSON-escaped newlines, without surrounding single quotes. Avoid copying the quoted private-key example straight into Docker's env file. Never print the runtime file or commit it.

The deployment script verifies the image checksum/revision, runs migrations in a one-off container, and only then stops/renames the current app. It starts the new non-root container on `127.0.0.1:3000` and checks `/auth/login` for successful startup. If startup fails, it removes the replacement and restores/starts the previous container when one exists. The previous stopped container/image is retained after success for manual rollback; older rollback containers are removed on the next deployment. It does not prune arbitrary images or containers.

This replacement has a brief interruption and is not blue/green deployment. Migration failure leaves the current app running. Successful database migrations are **not** undone when an application rollback occurs: future migrations must remain backward-compatible with the previous app or require a planned manual rollout. The current startup check does not verify live Firebase/OpenRouter, and dependency-aware health checks remain in Phase 5.

A failed remote deploy can leave its image bundle under `/tmp/consumer-compass-<SHA>` for inspection/cleanup. Keep sufficient disk space for the incoming archive, new image, and previous image; no storage metric is claimed here.

Do not run the remote script until those prerequisites exist. Nothing in this phase provisions AWS or pushes the local commit to GitHub.

## Docker baseline

The baseline Dockerfile uses Node.js 22, a build stage, production-only dependencies in the runtime stage, and the built-in `node` user. `.dockerignore` excludes `.env*`, Git metadata, local dependencies/builds, tests, common credential files, and local agent/AWS/SSH directories. Only public Firebase arguments are embedded. The runtime image includes the plain-SQL migration runner and required server database modules.

Local image validation uses placeholder public Firebase build arguments. It verifies compilation/startup only; it cannot authenticate a real user. Standalone output, smaller runtime packaging, a Docker healthcheck, and the full production deployment stack are explicitly left to Phase 5.

## Phase completion checks

- `npm ci`: passed using the committed lockfile. A temporary newer npm resolved an internal npm 10.8 upgrade error; no system npm installation was changed.
- `npm run lint`: passed without warnings or errors.
- `npm run test:all`: 98 tests passed across 10 files: 74 unit/mocked/client/deployment tests, 20 PostgreSQL/API scenarios, and four Redis scenarios. No tests were skipped.
- `npm run build`: passed with placeholder public Firebase values. The initial sandboxed attempt could not resolve Google Fonts; the network-enabled build passed. Browserslist data remains outdated.
- Workflow YAML and `actionlint`: passed. Deployment shell syntax and ShellCheck: passed. The EXIT callback has a documented suppression for ShellCheck's indirect-call false positive.
- Docker image build: passed on ARM64 Docker Desktop with Node.js 22. This does not claim that the workflow's x86-64 build ran on GitHub.
- Runtime image checks: ran as uid 1000, excluded `.env.local`, `.env.example`, Git metadata, and Vitest, and successfully ran the migration CLI against the disposable PostgreSQL instance.
- Container HTTP smoke check: `/auth/login` returned 200 and unauthenticated `/api/chat` returned 401.
- npm installation reported 42 audit findings (19 moderate, 20 high, three critical); the production-only Docker prune reported 28 (18 moderate, seven high, three critical). These remain unresolved.
- No SSH connection to EC2, GitHub workflow execution, live Firebase/OpenRouter request, or AWS deployment was performed. The temporary app/test containers and placeholder `.env.local` were removed after verification.

## Remaining limitations

- This workflow has been validated locally, not executed by GitHub Actions or against EC2.
- Real Firebase/OpenRouter integration, browser interaction, and HTTPS streaming remain unverified here.
- There is no zero-downtime rollout or automatic database down migration.
- The current dependency audit still has unresolved findings, including critical runtime dependency findings. The test-tool upgrade avoids the older runner's findings but does not make the existing Next.js 14 dependency tree production-ready.
- Google Fonts are still downloaded at build time, so the build needs outbound access or a future local-font change.
- Phase 5 still owns full EC2 provisioning/deploy/backup/CloudWatch instructions and replacing `awsSync.txt`.

## References

- [Vitest test projects](https://vitest.dev/guide/projects)
- [GitHub Actions service containers](https://docs.github.com/en/actions/tutorials/use-containerized-services)
- [GitHub workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax)
