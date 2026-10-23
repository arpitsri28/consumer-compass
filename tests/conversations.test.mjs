import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createConversationHandlers } from '../app/lib/server/conversation-handlers.js';
import { createChatHandler } from '../app/lib/server/chat-handler.js';
import { getChatConfig } from '../app/lib/server/chat-config.js';
import { HttpError } from '../app/lib/server/errors.js';
import { GET as list, POST as create } from '../app/api/conversations/route.js';
import { GET as get, PATCH as rename, DELETE as remove } from '../app/api/conversations/[id]/route.js';

const id = '123e4567-e89b-42d3-a456-426614174000';
const context = { params: { id } };
const req = (method = 'GET', body) => new Request('http://localhost/api/conversations', {
  method,
  ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
});
const user = { uid: 'caller', email: 'caller@example.com' };

for (const [name, route, method] of [
  ['list', list, 'GET'], ['create', create, 'POST'], ['get', get, 'GET'],
  ['rename', rename, 'PATCH'], ['delete', remove, 'DELETE'],
]) {
  test(`exported conversation ${name} route rejects unauthenticated access`, async () => {
    assert.equal((await route(req(method), context)).status, 401);
  });
}

test('conversation handlers scope every action to the verified uid and upsert the user', async () => {
  const calls = [];
  const store = {
    upsertUser: async (identity) => { assert.deepEqual(identity, user); calls.push('upsert'); },
    list: async (uid) => { assert.equal(uid, user.uid); return []; },
    create: async (uid) => { assert.equal(uid, user.uid); return { id }; },
    get: async (uid, value) => { assert.equal(uid, user.uid); assert.equal(value, id); return { id, messages: [] }; },
    rename: async (uid, value, title) => { assert.equal(uid, user.uid); assert.equal(value, id); assert.equal(title, 'Title'); return { id, title }; },
    delete: async (uid, value) => { assert.equal(uid, user.uid); assert.equal(value, id); },
  };
  const handlers = createConversationHandlers({ verifyRequestUser: async () => user, store });
  assert.equal((await handlers.list(req(), context)).status, 200);
  assert.equal((await handlers.create(req('POST'), context)).status, 201);
  assert.equal((await handlers.get(req(), context)).status, 200);
  assert.equal((await handlers.rename(req('PATCH', { title: ' Title ' }), context)).status, 200);
  assert.equal((await handlers.delete(req('DELETE'), context)).status, 204);
  assert.equal(calls.length, 5);
});

test('conversation handlers reject invalid IDs, blank titles and extra rename fields', async () => {
  const handlers = createConversationHandlers({ verifyRequestUser: async () => user,
    store: { upsertUser: async () => {}, get: () => assert.fail('must not access store') } });
  assert.equal((await handlers.get(req(), { params: { id: 'bad' } })).status, 400);
  for (const body of [{ title: ' ' }, { title: 'x'.repeat(101) }, { title: 'ok', user_id: 'other' }]) {
    assert.equal((await handlers.rename(req('PATCH', body), context)).status, 400);
  }
});

test('chat returns 404 for unowned conversations without calling the model', async () => {
  const POST = createChatHandler({ checkRateLimit: async () => ({ allowed: true }), verifyRequestUser: async () => user, getConfig: () => getChatConfig({}),
    store: { upsertUser: async () => {}, beginTurn: async () => { throw new HttpError(404, 'NOT_FOUND', 'Conversation not found.'); } },
    createCompletion: async () => assert.fail('must not call model'),
  });
  const response = await POST(req('POST', { conversationId: id, message: 'hello' }));
  assert.equal(response.status, 404);
});

test('chat finalizes a reply as complete before closing its response', async () => {
  const saved = [];
  const POST = createChatHandler({ checkRateLimit: async () => ({ allowed: true }), verifyRequestUser: async () => user, getConfig: () => getChatConfig({}),
    store: { upsertUser: async () => {}, beginTurn: async (uid, value, content, limit) => {
      assert.equal(uid, user.uid); assert.equal(value, id); assert.equal(content, 'hello'); assert.equal(limit, 20);
      return { messages: [{ role: 'user', content }], finish: async (...args) => saved.push(args) };
    } },
    createCompletion: async () => (async function* () {
      yield { choices: [{ delta: { content: 'saved answer' } }] };
    })(),
  });
  const response = await POST(req('POST', { conversationId: id, message: 'hello' }));
  assert.equal(await response.text(), 'saved answer');
  assert.deepEqual(saved, [['saved answer', false]]);
});

test('provider rejection leaves an incomplete assistant placeholder', async () => {
  const saved = [];
  const POST = createChatHandler({ checkRateLimit: async () => ({ allowed: true }), verifyRequestUser: async () => user, getConfig: () => getChatConfig({}),
    store: { upsertUser: async () => {}, beginTurn: async () => ({ messages: [], finish: async (...args) => saved.push(args) }) },
    createCompletion: async () => { throw { status: 503 }; },
  });
  const response = await POST(req('POST', { conversationId: id, message: 'hello' }));
  assert.equal(response.status, 503);
  assert.deepEqual(saved, [['', true]]);
});
