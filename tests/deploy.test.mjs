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
  const bin = join(root, 'bin'); const app = join(root, 'app'); const state = join(root, 'state');
  await Promise.all([mkdir(bin), mkdir(app), mkdir(state)]);
  await writeFile(join(app, 'runtime.env'), 'DATABASE_URL=fixture-only\n');
  await writeFile(join(state, 'consumer-compass-app'), 'original');
  await copyFile(new URL('../scripts/deploy-ec2.sh', import.meta.url), join(root, 'deploy-ec2.sh'));
  await writeFile(join(root, 'image.tar.gz'), gzipSync('fake image payload'));
  await writeFile(join(root, 'image.sha256'), 'fixture');
  const executable = async (name, content) => writeFile(join(bin, name), content, { mode: 0o755 });
  await executable('docker', `#!/usr/bin/env bash
set -eu
printf '%s\\n' "$*" >> "$TEST_LOG"
case "$1 \${2:-}" in
  'network inspect') exit 0 ;;
  'load '*) cat >/dev/null; exit 0 ;;
  'image inspect') printf '%s\\n' "$TEST_REVISION"; exit 0 ;;
  'container inspect') [[ -f "$TEST_STATE/$3" ]]; exit $? ;;
  'run --rm') [[ "\${TEST_MIGRATION_FAIL:-0}" != 1 ]]; exit $? ;;
  'run -d') printf 'replacement' > "$TEST_STATE/consumer-compass-app"; exit 0 ;;
  'stop --time') exit 0 ;;
  'rename '*) mv "$TEST_STATE/$2" "$TEST_STATE/$3"; exit 0 ;;
  'start '*) touch "$TEST_STATE/restored"; exit 0 ;;
  'rm '*) last="\${!#}"; rm -f "$TEST_STATE/$last"; exit 0 ;;
  *) echo "Unexpected Docker command" >&2; exit 1 ;;
esac
`);
  await executable('curl', '#!/usr/bin/env bash\n[[ "${TEST_READY_FAIL:-0}" != 1 ]]\n');
  for (const name of ['flock', 'sleep', 'sha256sum']) await executable(name, '#!/usr/bin/env bash\nexit 0\n');
  const revision = 'a'.repeat(40);
  const run = (value = revision) => spawnSync('bash', [join(root, 'deploy-ec2.sh'), value], {
    encoding: 'utf8', timeout: 5000,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, COMPASS_DEPLOY_DIR: app,
      TEST_STATE: state, TEST_LOG: join(root, 'commands'), TEST_REVISION: revision, ...extra },
  });
  return { run, state, app, commands: () => readFile(join(root, 'commands'), 'utf8') };
}

test('deployment runs migrations before replacing the app and retains the old container', async () => {
  const fixture = await setup(); const result = fixture.run();
  assert.equal(result.status, 0, result.stderr);
  const commands = await fixture.commands();
  assert.ok(commands.indexOf('run --rm') < commands.indexOf('stop --time'));
  assert.equal(await readFile(join(fixture.state, 'consumer-compass-app'), 'utf8'), 'replacement');
  assert.equal(await readFile(join(fixture.state, 'consumer-compass-app-previous'), 'utf8'), 'original');
});

test('migration failure leaves the existing app untouched', async () => {
  const fixture = await setup({ TEST_MIGRATION_FAIL: '1' });
  assert.notEqual(fixture.run().status, 0);
  assert.doesNotMatch(await fixture.commands(), /stop --time/);
  assert.equal(await readFile(join(fixture.state, 'consumer-compass-app'), 'utf8'), 'original');
});

test('failed replacement readiness restores and starts the previous app', async () => {
  const fixture = await setup({ TEST_READY_FAIL: '1' }); const result = fixture.run();
  assert.notEqual(result.status, 0);
  assert.equal(await readFile(join(fixture.state, 'consumer-compass-app'), 'utf8'), 'original');
  assert.match(await fixture.commands(), /start consumer-compass-app/);
});

test('invalid revision or missing runtime environment fails before Docker changes', async () => {
  const fixture = await setup();
  assert.notEqual(fixture.run('bad; command').status, 0);
  await rm(join(fixture.app, 'runtime.env'));
  assert.notEqual(fixture.run().status, 0);
  await assert.rejects(fixture.commands(), { code: 'ENOENT' });
});
