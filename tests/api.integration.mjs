import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, test, vi } from 'vitest';

const sdk = vi.hoisted(() => ({ verifyIdToken: vi.fn(), create: vi.fn() }));
vi.mock('firebase-admin/app', () => ({
  getApps: () => [], cert: () => 'test-certificate', initializeApp: () => ({ name: 'consumer-compass-server' }),
}));
vi.mock('firebase-admin/auth', () => ({ getAuth: () => ({ verifyIdToken: sdk.verifyIdToken }) }));
vi.mock('openai', () => ({ default: class MockOpenAI {
  chat = { completions: { create: sdk.create } };
} }));

import { POST as chat } from '../app/api/chat/route.js';
import { GET as list, POST as create } from '../app/api/conversations/route.js';
import { GET as get, PATCH as rename, DELETE as remove } from '../app/api/conversations/[id]/route.js';
import { getPool } from '../app/lib/server/db.js';
import { getRedis } from '../app/lib/server/redis.js';

const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith('_test') || !process.env.TEST_REDIS_URL) {
  throw new Error('API integration tests require TEST_DATABASE_URL ending in _test and a disposable TEST_REDIS_URL.');
}
const owner = { uid: `api-owner-${randomUUID()}`, email: 'owner@example.invalid' };
const other = { uid: `api-other-${randomUUID()}`, email: 'other@example.invalid' };
const quotaUser = { uid: `api-quota-${randomUUID()}`, email: 'quota@example.invalid' };
const identities = { owner, other, quota: quotaUser };
const request = (method = 'GET', body, token = 'owner', signal) => new Request('http://localhost/api', {
  method, signal,
  headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
});
const context = (id) => ({ params: { id } });
const answer = async () => (async function* () {
  yield { choices: [{ delta: { content: 'A verified ' } }] };
  yield { choices: [{ delta: { content: 'stream.' } }] };
})();
let id;
let pool;
let redis;

describe.sequential('exported API routes with PostgreSQL, Redis and mocked SDKs', () => {
  beforeAll(async () => {
    vi.stubEnv('DATABASE_URL', url);
    vi.stubEnv('REDIS_URL', process.env.TEST_REDIS_URL);
    vi.stubEnv('FIREBASE_SERVICE_ACCOUNT_JSON', JSON.stringify({ project_id: 'test', client_email: 'admin@example.invalid', private_key: 'mock' }));
    vi.stubEnv('OPENROUTER_API_KEY', 'mock-only');
    vi.stubEnv('CHAT_RATE_LIMIT_MAX_REQUESTS', '100');
    pool = getPool(); redis = await getRedis();
  });
  beforeEach(() => {
    // Vitest restores env stubs after each test; repeat runtime-only test configuration.
    vi.stubEnv('DATABASE_URL', url);
    vi.stubEnv('REDIS_URL', process.env.TEST_REDIS_URL);
    vi.stubEnv('FIREBASE_SERVICE_ACCOUNT_JSON', JSON.stringify({ project_id: 'test', client_email: 'admin@example.invalid', private_key: 'mock' }));
    vi.stubEnv('OPENROUTER_API_KEY', 'mock-only');
    vi.stubEnv('CHAT_RATE_LIMIT_MAX_REQUESTS', '100');
    sdk.verifyIdToken.mockImplementation(async (token) => {
      if (!identities[token]) throw Object.assign(new Error('Invalid test token'), { code: 'auth/invalid-id-token' });
      return identities[token];
    });
    sdk.create.mockReset().mockImplementation(answer);
  });
  afterAll(async () => {
    try {
      if (pool) await pool.query('DELETE FROM users WHERE id = ANY($1::text[])', [Object.values(identities).map((user) => user.uid)]);
      if (redis) await redis.del(...Object.values(identities).map(({ uid }) =>
        `consumer-compass:chat-rate:v1:${createHash('sha256').update(uid).digest('hex')}`));
    } finally {
      if (pool) await pool.end();
      redis?.disconnect();
      delete globalThis.consumerCompassPool;
      delete globalThis.consumerCompassRedis;
    }
  });
  test('401 for missing and invalid tokens before the model is called', async () => {
    assert.equal((await chat(request('POST', {}, ''))).status, 401);
    assert.equal((await chat(request('POST', {}, 'invalid'))).status, 401);
    assert.equal(sdk.create.mock.calls.length, 0);
  });
  test('conversation creation, listing and rename through the exported routes', async () => {
    const response = await create(request('POST'));
    assert.equal(response.status, 201);
    id = (await response.json()).conversation.id;
    assert.ok((await (await list(request())).json()).conversations.some((entry) => entry.id === id));
    const renamed = await rename(request('PATCH', { title: 'API integration' }), context(id));
    assert.equal((await renamed.json()).conversation.title, 'API integration');
  });
  test('400 for a bad chat body with no saved messages or provider call', async () => {
    assert.equal((await chat(request('POST', { conversationId: id, messages: [{ role: 'system', content: 'bad' }] }))).status, 400);
    assert.equal((await (await get(request(), context(id))).json()).conversation.messages.length, 0);
    assert.equal(sdk.create.mock.calls.length, 0);
  });
  test('404 conceals another user\'s conversation on all item routes and chat', async () => {
    assert.equal((await get(request('GET', undefined, 'other'), context(id))).status, 404);
    assert.equal((await rename(request('PATCH', { title: 'bad' }, 'other'), context(id))).status, 404);
    assert.equal((await remove(request('DELETE', undefined, 'other'), context(id))).status, 404);
    assert.equal((await chat(request('POST', { conversationId: id, message: 'bad' }, 'other'))).status, 404);
    assert.equal(sdk.create.mock.calls.length, 0);
  });
  test('successful stream uses the mocked OpenRouter SDK and persists both messages', async () => {
    const response = await chat(request('POST', { conversationId: id, message: 'A new question' }));
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'A verified stream.');
    assert.equal(sdk.create.mock.calls[0][0].messages.at(-1).content, 'A new question');
    const saved = (await (await get(request(), context(id))).json()).conversation.messages;
    assert.deepEqual(saved.map(({ role, content, incomplete }) => ({ role, content, incomplete })), [
      { role: 'user', content: 'A new question', incomplete: false },
      { role: 'assistant', content: 'A verified stream.', incomplete: false },
    ]);
  });
  test('429 from real Redis includes Retry-After and does not persist another turn', async () => {
    vi.stubEnv('CHAT_RATE_LIMIT_MAX_REQUESTS', '1');
    const created = await create(request('POST', undefined, 'quota'));
    const quotaId = (await created.json()).conversation.id;
    const first = await chat(request('POST', { conversationId: quotaId, message: 'allowed' }, 'quota'));
    assert.equal(await first.text(), 'A verified stream.');
    const second = await chat(request('POST', { conversationId: quotaId, message: 'blocked' }, 'quota'));
    assert.equal(second.status, 429);
    assert.ok(Number(second.headers.get('Retry-After')) >= 1);
    assert.equal(sdk.create.mock.calls.length, 1);
    assert.equal((await (await get(request('GET', undefined, 'quota'), context(quotaId))).json()).conversation.messages.length, 2);
  });
  test('abort propagates to the SDK and persists an incomplete partial reply', async () => {
    const controller = new AbortController();
    sdk.create.mockImplementation(async (_parameters, { signal }) => (async function* () {
      yield { choices: [{ delta: { content: 'Partial API text' } }] };
      if (!signal.aborted) await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
    })());
    const response = await chat(request('POST', { conversationId: id, message: 'Interrupted question' }, 'owner', controller.signal));
    const reader = response.body.getReader();
    await reader.read(); controller.abort(); await assert.rejects(reader.read());
    assert.equal(sdk.create.mock.calls[0][1].signal.aborted, true);
    const messages = (await (await get(request(), context(id))).json()).conversation.messages;
    assert.equal(messages.at(-1).content, 'Partial API text');
    assert.equal(messages.at(-1).incomplete, true);
  });
  test('owner can delete the conversation and its messages', async () => {
    assert.equal((await remove(request('DELETE'), context(id))).status, 204);
    assert.equal((await get(request(), context(id))).status, 404);
    assert.equal((await pool.query('SELECT id FROM messages WHERE conversation_id = $1', [id])).rowCount, 0);
  });
});
