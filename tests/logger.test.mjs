import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import { createLogger, setRequestUser, withRequestLogging } from '../app/lib/server/logger.js';

function capture() {
  vi.stubEnv('LOG_LEVEL', 'info');
  const entries = [];
  return { entries, logger: createLogger({ write: (line) => { entries.push(JSON.parse(line)); } }) };
}

test('JSON request logs include correlation, user, status and latency without secrets', async () => {
  const { entries, logger } = capture();
  const handler = withRequestLogging(async () => {
    setRequestUser('verified-user');
    return Response.json({ answer: 'private-response' });
  }, '/api/conversations', logger);
  const response = await handler(new Request('http://localhost/api/conversations?token=private-query', {
    method: 'POST', headers: { Authorization: 'Bearer private-token' }, body: 'private-question',
  }));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].requestId, response.headers.get('x-request-id'));
  assert.equal(entries[0].uid, 'verified-user');
  assert.equal(entries[0].path, '/api/conversations');
  assert.equal(entries[0].method, 'POST');
  assert.equal(entries[0].status, 200);
  assert.ok(entries[0].latencyMs >= 0);
  assert.doesNotMatch(JSON.stringify(entries), /private-/);
});

test('concurrent requests keep their user IDs and request IDs separate', async () => {
  const { entries, logger } = capture();
  const handler = withRequestLogging(async (request) => {
    const uid = request.headers.get('test-user');
    setRequestUser(uid);
    await new Promise((resolve) => setTimeout(resolve, uid === 'one' ? 10 : 1));
    return Response.json({});
  }, '/api/conversations', logger);
  await Promise.all(['one', 'two'].map((uid) => handler(new Request('http://localhost', { headers: { 'test-user': uid } }))));
  assert.deepEqual(entries.map(({ uid }) => uid).sort(), ['one', 'two']);
  assert.equal(new Set(entries.map(({ requestId }) => requestId)).size, 2);
});

test('streams log once on completion without buffering or changing bytes', async () => {
  const { entries, logger } = capture();
  const response = await withRequestLogging(async () => new Response('private-stream', {
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'X-Accel-Buffering': 'no' },
  }), '/api/chat', logger)(new Request('http://localhost'));
  assert.equal(entries.length, 0);
  assert.equal(await response.text(), 'private-stream');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].outcome, 'complete');
  assert.equal(response.headers.get('x-accel-buffering'), 'no');
  assert.doesNotMatch(JSON.stringify(entries), /private-stream/);
});

test('cancelling the wrapped stream cancels its source and logs once', async () => {
  const { entries, logger } = capture();
  let cancelled = false;
  const response = await withRequestLogging(async () => new Response(new ReadableStream({
    cancel() { cancelled = true; },
  }), { headers: { 'Content-Type': 'text/plain' } }), '/api/chat', logger)(new Request('http://localhost'));
  await response.body.cancel();
  assert.equal(cancelled, true);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].outcome, 'cancelled');
});

test('stream failures preserve HTTP status and never serialize the error message', async () => {
  const { entries, logger } = capture();
  const response = await withRequestLogging(async () => new Response(new ReadableStream({
    start(controller) { controller.error(new Error('private-provider-token')); },
  }), { headers: { 'Content-Type': 'text/plain' } }), '/api/chat', logger)(new Request('http://localhost'));
  await assert.rejects(response.text());
  assert.equal(entries.length, 1);
  assert.equal(entries[0].status, 200);
  assert.equal(entries[0].outcome, 'error');
  assert.doesNotMatch(JSON.stringify(entries), /private-provider-token/);
});

test('unexpected handler errors are safe 500s and anonymous users remain null', async () => {
  const { entries, logger } = capture();
  const response = await withRequestLogging(async () => { throw Error('private-password'); }, '/api/health', logger)(new Request('http://localhost'));
  assert.equal(response.status, 500);
  assert.equal(entries[0].uid, null);
  assert.doesNotMatch(JSON.stringify(entries) + await response.text(), /private-password/);
});
