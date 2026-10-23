import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createHealthHandler } from '../app/lib/server/health.js';

test('health succeeds only when both dependencies are reachable', async () => {
  const response = await createHealthHandler({ database: async () => ({}), redis: async () => 'PONG' })();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { status: 'ok', checks: { database: true, redis: true } });
});

test('health reports failure without exposing credentials or connection errors', async () => {
  const response = await createHealthHandler({ database: () => { throw Error('secret-database-password'); },
    redis: async () => { throw Error('secret-redis-url'); } })();
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { status: 'unavailable', checks: { database: false, redis: false } });
});

test('a single dependency failure makes health unavailable', async () => {
  const response = await createHealthHandler({ database: async () => ({}), redis: async () => { throw Error(); } })();
  assert.equal(response.status, 503);
  assert.deepEqual((await response.json()).checks, { database: true, redis: false });
});
