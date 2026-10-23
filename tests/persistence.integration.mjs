import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import pg from 'pg';
import { createConversationStore } from '../app/lib/server/conversations.js';
import { createConversationHandlers } from '../app/lib/server/conversation-handlers.js';
import { createChatHandler } from '../app/lib/server/chat-handler.js';
import { getChatConfig } from '../app/lib/server/chat-config.js';

const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith('_test')) {
  throw new Error('Set TEST_DATABASE_URL to a dedicated database whose name ends in _test, and run migrations first.');
}
const pool = new pg.Pool({ connectionString: url, max: 5, connectionTimeoutMillis: 5000 });
const store = createConversationStore(() => pool);
const owner = { uid: `phase2-${randomUUID()}`, email: 'owner@example.com' };
const other = { uid: `phase2-${randomUUID()}`, email: 'other@example.com' };
const request = (body, signal) => new Request('http://localhost/api/chat', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal,
});
const makeHandler = (createCompletion, user = owner) => createChatHandler({
  verifyRequestUser: async () => user, store, getConfig: () => getChatConfig({}), createCompletion,
});
const answer = async () => (async function* () { yield { choices: [{ delta: { content: 'A saved reply.' } }] }; })();
const status = (expected) => (error) => error.status === expected;

test('PostgreSQL persistence and API integration', async (t) => {
  try {
    await store.upsertUser(owner);
    await store.upsertUser(other);
    await t.test('user upsert updates email without duplicating rows', async () => {
      await store.upsertUser({ ...owner, email: 'updated@example.com' });
      const rows = await pool.query('SELECT email FROM users WHERE id = $1', [owner.uid]);
      assert.equal(rows.rowCount, 1);
      assert.equal(rows.rows[0].email, 'updated@example.com');
    });
    const first = await store.create(owner.uid);
    const second = await store.create(owner.uid);
    await t.test('list ordering, ownership and parameterized rename', async () => {
      assert.deepEqual((await store.list(owner.uid)).map((row) => row.id), [second.id, first.id]);
      assert.deepEqual(await store.list(other.uid), []);
      const title = "'); DROP TABLE users; --";
      assert.equal((await store.rename(owner.uid, first.id, title)).title, title);
      assert.equal((await store.list(owner.uid))[0].id, first.id);
      await store.rename(owner.uid, first.id, 'My title');
      for (const action of [() => store.get(other.uid, first.id), () => store.rename(other.uid, first.id, 'bad'),
        () => store.delete(other.uid, first.id), () => store.beginTurn(other.uid, first.id, 'bad', 20)]) {
        await assert.rejects(action, status(404));
      }
    });
    await t.test('successful stream persists server-owned history and keeps explicit titles', async () => {
      const response = await makeHandler(answer)(request({ conversationId: first.id, message: 'First question' }));
      assert.equal(await response.text(), 'A saved reply.');
      const saved = await store.get(owner.uid, first.id);
      assert.equal(saved.title, 'My title');
      assert.deepEqual(saved.messages.map(({ role, content, incomplete }) => ({ role, content, incomplete })), [
        { role: 'user', content: 'First question', incomplete: false },
        { role: 'assistant', content: 'A saved reply.', incomplete: false },
      ]);
      const next = await makeHandler(async (parameters) => {
        assert.deepEqual(parameters.messages.slice(1), [
          { role: 'user', content: 'First question' }, { role: 'assistant', content: 'A saved reply.' },
          { role: 'user', content: 'Follow-up' },
        ]);
        return answer();
      })(request({ conversationId: first.id, message: 'Follow-up' }));
      await next.text();
    });
    await t.test('first user message auto-titles without another model call', async () => {
      const response = await makeHandler(answer)(request({ conversationId: second.id, message: '  A question\nabout refunds  ' }));
      await response.text();
      assert.equal((await store.get(owner.uid, second.id)).title, 'A question about refunds');
    });
    await t.test('abort saves generated partial text, marks incomplete, and releases the lock', async () => {
      const controller = new AbortController();
      const response = await makeHandler(async (_, { signal }) => (async function* () {
        yield { choices: [{ delta: { content: 'partial text' } }] };
        if (!signal.aborted) await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
      })())(request({ conversationId: second.id, message: 'Interrupted question' }, controller.signal));
      const reader = response.body.getReader();
      await reader.read();
      controller.abort();
      await assert.rejects(reader.read());
      const saved = await store.get(owner.uid, second.id);
      assert.equal(saved.messages.at(-1).content, 'partial text');
      assert.equal(saved.messages.at(-1).incomplete, true);
      const turn = await store.beginTurn(owner.uid, second.id, 'Next question', 20);
      assert.ok(!turn.messages.some((entry) => entry.content === 'partial text'));
      await turn.finish('Recovery', false);
    });
    await t.test('overlapping turns and deletion return 409 and finish is idempotent', async () => {
      const turn = await store.beginTurn(owner.uid, second.id, 'Held generation', 20);
      await assert.rejects(store.beginTurn(owner.uid, second.id, 'Overlap', 20), status(409));
      await assert.rejects(store.delete(owner.uid, second.id), status(409));
      await Promise.all([turn.finish('Once', false), turn.finish('Twice', false)]);
      assert.equal((await store.get(owner.uid, second.id)).messages.at(-1).content, 'Once');
    });
    await t.test('all conversation endpoints and chat conceal another user with 404', async () => {
      const handlers = createConversationHandlers({ verifyRequestUser: async () => other, store });
      const context = { params: { id: first.id } };
      const renameRequest = new Request('http://localhost', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'bad' }) });
      assert.equal((await handlers.get(new Request('http://localhost'), context)).status, 404);
      assert.equal((await handlers.rename(renameRequest, context)).status, 404);
      assert.equal((await handlers.delete(new Request('http://localhost', { method: 'DELETE' }), context)).status, 404);
      const response = await makeHandler(() => assert.fail('must not call provider'), other)(request({ conversationId: first.id, message: 'bad' }));
      assert.equal(response.status, 404);
    });
    await t.test('provider failure preserves the user and an incomplete placeholder', async () => {
      const response = await makeHandler(async () => { throw { status: 503 }; })(request({ conversationId: first.id, message: 'Failure question' }));
      assert.equal(response.status, 503);
      const messages = (await store.get(owner.uid, first.id)).messages;
      assert.equal(messages.at(-2).content, 'Failure question');
      assert.equal(messages.at(-1).content, '');
      assert.equal(messages.at(-1).incomplete, true);
    });
    await t.test('SQL failures roll back and release generation locks', async () => {
      const before = await store.get(owner.uid, first.id);
      await assert.rejects(store.beginTurn(owner.uid, first.id, 'Rolled back question', -1), status(503));
      const after = await store.get(owner.uid, first.id);
      assert.equal(after.messages.length, before.messages.length);
      const turn = await store.beginTurn(owner.uid, first.id, 'Failed finalization', 20);
      await assert.rejects(turn.finish(null, false), status(503));
      assert.equal((await store.get(owner.uid, first.id)).messages.at(-1).incomplete, true);
      const recovery = await store.beginTurn(owner.uid, first.id, 'Recovered', 20);
      await recovery.finish('Recovered answer', false);
    });
    await t.test('deletion cascades to messages and users cascade to conversations', async () => {
      await store.delete(owner.uid, second.id);
      assert.equal((await pool.query('SELECT id FROM messages WHERE conversation_id = $1', [second.id])).rowCount, 0);
      await pool.query('DELETE FROM users WHERE id = $1', [owner.uid]);
      assert.equal((await pool.query('SELECT id FROM conversations WHERE id = $1', [first.id])).rowCount, 0);
      assert.equal((await pool.query('SELECT id FROM messages WHERE conversation_id = $1', [first.id])).rowCount, 0);
    });
  } finally {
    await pool.query('DELETE FROM users WHERE id = ANY($1::text[])', [[owner.uid, other.uid]]);
    await pool.end();
  }
});
