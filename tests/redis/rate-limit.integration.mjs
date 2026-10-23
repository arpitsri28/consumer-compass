import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { getRedis } from '../../app/lib/server/redis.js';
import { createRateLimiter } from '../../app/lib/server/rate-limit.js';
import { getChatConfig } from '../../app/lib/server/chat-config.js';

if (!process.env.TEST_REDIS_URL) throw new Error('Set TEST_REDIS_URL to a disposable Redis service.');
process.env.REDIS_URL = process.env.TEST_REDIS_URL;
const client = await getRedis();
const fixtureKeys = [];
const uid = () => `phase3-test-${randomUUID()}`;
const keyFor = (value) => {
  const key = `consumer-compass:chat-rate:v1:${createHash('sha256').update(value).digest('hex')}`;
  fixtureKeys.push(key);
  return key;
};
const config = getChatConfig({ CHAT_RATE_LIMIT_MAX_REQUESTS: '5', CHAT_RATE_LIMIT_WINDOW_SECONDS: '60' });
const check = createRateLimiter({ getClient: getRedis });

test('Redis fixed-window integration', async (t) => {
  try {
    await t.test('parallel requests share one atomic per-user quota', async () => {
      const user = uid();
      const key = keyFor(user);
      const results = await Promise.all(Array.from({ length: 20 }, () => check(user, config)));
      assert.equal(results.filter((entry) => entry.allowed).length, 5);
      assert.equal(results.filter((entry) => !entry.allowed).length, 15);
      assert.ok(results.every((entry) => entry.retryAfter >= 1 && entry.retryAfter <= 60));
      assert.equal(await client.get(key), '20');
      assert.ok(await client.pttl(key) > 0);
    });
    await t.test('another uid starts with its own quota', async () => {
      const user = uid(); keyFor(user);
      assert.equal((await check(user, config)).allowed, true);
    });
    await t.test('expired windows reset the quota and blocked calls do not extend the TTL', async () => {
      const user = uid(); const key = keyFor(user);
      const short = { ...config, CHAT_RATE_LIMIT_MAX_REQUESTS: 1, CHAT_RATE_LIMIT_WINDOW_SECONDS: 1 };
      assert.equal((await check(user, short)).allowed, true);
      const ttl = await client.pttl(key);
      assert.equal((await check(user, short)).allowed, false);
      assert.ok(await client.pttl(key) <= ttl);
      await delay(1100);
      assert.equal((await check(user, short)).allowed, true);
    });
    await t.test('a counter missing its expiry is repaired atomically', async () => {
      const user = uid(); const key = keyFor(user);
      await client.set(key, '3');
      assert.equal(await client.pttl(key), -1);
      assert.equal((await check(user, config)).allowed, true);
      assert.ok(await client.pttl(key) > 0);
    });
  } finally {
    if (fixtureKeys.length) await client.del(...fixtureKeys);
    client.disconnect();
  }
});
