import assert from 'node:assert/strict';
import { afterEach, test } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';

const fixtures = [];
afterEach(async () => { await Promise.all(fixtures.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function setup(extra = {}) {
  const root = await mkdtemp(join(tmpdir(), 'compass-deploy-'));
  fixtures.push(root);
  const bin = join(root, 'bin'); const app = join(root, 'app');
  await Promise.all([mkdir(bin), mkdir(join(app, 'scripts'), { recursive: true })]);
  for (const file of ['runtime.env', '.env.production', 'docker-compose.prod.yml']) await writeFile(join(app, file), 'fixture\n');
  const oldImage = 'consumer-compass:previous';
  await writeFile(join(app, '.deployed-image'), oldImage + '\n');
  await copyFile(new URL('../scripts/deploy-ec2.sh', import.meta.url), join(root, 'deploy-ec2.sh'));
  await copyFile(new URL('../scripts/compose-prod.sh', import.meta.url), join(app, 'scripts/compose-prod.sh'));
  await writeFile(join(root, 'image.tar.gz'), gzipSync('fake image payload'));
  await writeFile(join(root, 'image.sha256'), 'fixture');
  const executable = async (name, content) => writeFile(join(bin, name), content, { mode: 0o755 });
  await executable('docker', `#!/usr/bin/env bash
set -eu
printf '%s %s\\n' "\${APP_IMAGE:-unset}" "$*" >> "$TEST_LOG"
case "$1" in
  load) cat >/dev/null ;;
  image) printf '%s\\n' "$TEST_REVISION" ;;
  compose)
    case "$*" in
      *'run --rm'*) [[ "\${TEST_MIGRATION_FAIL:-0}" != 1 ]] ;;
      *'up -d'*) [[ "\${TEST_READY_FAIL:-0}" != 1 || "$APP_IMAGE" == consumer-compass:previous ]] ;;
      *'exec -T nginx'*) exit 0 ;;
      *) exit 1 ;;
    esac ;;
  *) exit 1 ;;
esac
`);
  await executable('curl', '#!/usr/bin/env bash\n[[ "${TEST_HTTP_FAIL:-0}" != 1 ]]\n');
  for (const name of ['flock', 'sha256sum']) await executable(name, '#!/usr/bin/env bash\nexit 0\n');
  const revision = 'a'.repeat(40);
  const run = (value = revision) => spawnSync('bash', [join(root, 'deploy-ec2.sh'), value], {
    encoding: 'utf8', timeout: 5000,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, COMPASS_DEPLOY_DIR: app,
      TEST_LOG: join(root, 'commands'), TEST_REVISION: revision, ...extra },
  });
  return { run, app, oldImage, revision, commands: () => readFile(join(root, 'commands'), 'utf8') };
}

test('deployment migrates before replacing the app, reloads Nginx and records rollback image', async () => {
  const fixture = await setup(); const result = fixture.run();
  assert.equal(result.status, 0, result.stderr);
  const commands = await fixture.commands();
  assert.ok(commands.indexOf('run --rm') < commands.indexOf('up -d'));
  assert.match(commands, /nginx -s reload/);
  assert.equal((await readFile(join(fixture.app, '.deployed-image'), 'utf8')).trim(), `consumer-compass:${fixture.revision}`);
  assert.equal((await readFile(join(fixture.app, '.previous-image'), 'utf8')).trim(), fixture.oldImage);
});

test('migration failure leaves the existing release untouched', async () => {
  const fixture = await setup({ TEST_MIGRATION_FAIL: '1' });
  assert.notEqual(fixture.run().status, 0);
  assert.doesNotMatch(await fixture.commands(), /up -d/);
  assert.equal((await readFile(join(fixture.app, '.deployed-image'), 'utf8')).trim(), fixture.oldImage);
});

for (const failure of ['TEST_READY_FAIL', 'TEST_HTTP_FAIL']) {
  test(`${failure} restores the previous app image without advancing deployment state`, async () => {
    const fixture = await setup({ [failure]: '1' });
    assert.notEqual(fixture.run().status, 0);
    assert.match(await fixture.commands(), /consumer-compass:previous compose .*up -d/);
    assert.equal((await readFile(join(fixture.app, '.deployed-image'), 'utf8')).trim(), fixture.oldImage);
  });
}

test('invalid revision or missing server configuration fails before Docker changes', async () => {
  const fixture = await setup();
  assert.notEqual(fixture.run('bad; command').status, 0);
  await rm(join(fixture.app, 'runtime.env'));
  assert.notEqual(fixture.run().status, 0);
  await assert.rejects(fixture.commands(), { code: 'ENOENT' });
});

test('a revision mismatch fails before migration', async () => {
  const fixture = await setup({ TEST_REVISION: 'b'.repeat(40) });
  assert.notEqual(fixture.run().status, 0);
  assert.doesNotMatch(await fixture.commands(), /run --rm|up -d/);
});
