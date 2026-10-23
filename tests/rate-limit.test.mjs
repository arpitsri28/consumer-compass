import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createRateLimiter, RATE_LIMIT_SCRIPT } from '../app/lib/server/rate-limit.js';
import { createChatHandler } from '../app/lib/server/chat-handler.js';
import { getChatConfig } from '../app/lib/server/chat-config.js';

const config = getChatConfig({});

test('limiter evaluates atomically with a uid hash and a window in milliseconds', async () => {
  let key;
  const check = createRateLimiter({ getClient: async () => ({ eval: async (...args) => {
    assert.equal(args[0], RATE_LIMIT_SCRIPT);
    assert.equal(args[1], 1);
    key = args[2];
    assert.match(key, /^consumer-compass:chat-rate:v1:[a-f0-9]{64}$/);
    assert.ok(!key.includes('private-user-id'));
    assert.equal(args[3], 60000);
    return [1, 59999];
  } }) });
  assert.deepEqual(await check('private-user-id', config), { allowed: true, retryAfter: 60 });
});

test('quota boundary allows the last request and blocks the next with a rounded TTL', async () => {
  let count = config.CHAT_RATE_LIMIT_MAX_REQUESTS - 1;
  const check = createRateLimiter({ getClient: async () => ({ eval: async () => [++count, 1501] }) });
  assert.equal((await check('uid', config)).allowed, true);
  assert.deepEqual(await check('uid', config), { allowed: false, retryAfter: 2 });
});

test('different users have separate keys and requests near expiry still get Retry-After 1', async () => {
  const keys = [];
  const check = createRateLimiter({ getClient: async () => ({ eval: async (_script, _count, key) => {
    keys.push(key); return [11, 0];
  } }) });
  assert.equal((await check('one', config)).retryAfter, 1);
  await check('two', config);
  assert.notEqual(keys[0], keys[1]);
});

test('Redis connection and command failures fail open with a redacted warning', async () => {
  let warned = 0;
  for (const getClient of [async () => { throw new Error('redis://secret@host'); },
    async () => ({ eval: async () => { throw new Error('secret payload'); } })]) {
    const check = createRateLimiter({ getClient, warn: (...args) => { assert.deepEqual(args, []); warned++; } });
    assert.deepEqual(await check('uid', config), { allowed: true, retryAfter: 0, degraded: true });
  }
  assert.equal(warned, 2);
});

test('invalid rate-limit configuration is rejected instead of silently disabling quotas', () => {
  for (const field of ['CHAT_RATE_LIMIT_MAX_REQUESTS', 'CHAT_RATE_LIMIT_WINDOW_SECONDS']) {
    for (const value of ['0', '-1', 'bad', '1.5']) {
      assert.throws(() => getChatConfig({ [field]: value }), (error) => error.status === 503);
    }
  }
});

test('429 includes Retry-After and rejects before database writes or provider calls', async () => {
  const POST = createChatHandler({
    verifyRequestUser: async () => ({ uid: 'verified-uid' }),
    getConfig: () => config,
    checkRateLimit: async (uid) => { assert.equal(uid, 'verified-uid'); return { allowed: false, retryAfter: 17 }; },
    store: { upsertUser: () => assert.fail('must not touch database') },
    createCompletion: () => assert.fail('must not call model'),
  });
  const response = await POST(new Request('http://localhost/api/chat', { method: 'POST' }));
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('Retry-After'), '17');
  assert.equal((await response.json()).error.code, 'RATE_LIMITED');
});
