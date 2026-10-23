import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import { chatRequest, retryAfterSeconds, resolveChatRetry } from '../../app/lib/chat-client.js';

const body = { conversationId: 'conversation', message: 'question' };
const saved = [
  { id: '1', role: 'user', content: 'question', incomplete: false },
  { id: '2', role: 'assistant', content: 'partial', incomplete: true },
];

test('each request attaches the current Firebase token and propagates cancellation', async () => {
  let calls = 0;
  const user = { getIdToken: async () => `token-${++calls}` };
  const controller = new AbortController();
  vi.spyOn(globalThis, 'fetch').mockImplementation( async (_path, options) => {
    assert.equal(options.headers.Authorization, `Bearer token-${calls}`);
    assert.equal(options.signal, controller.signal);
    assert.equal(options.cache, 'no-store');
    return new Response('{}');
  });
  try {
    await chatRequest(user, '/api/conversations', { signal: controller.signal });
    await chatRequest(user, '/api/conversations', { signal: controller.signal });
    assert.equal(calls, 2);
  } finally { vi.restoreAllMocks(); }
});

test('HTTP errors preserve safe error codes, status and Retry-After', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation( async () => Response.json({ error: { code: 'RATE_LIMITED', message: 'Wait.' } }, {
    status: 429, headers: { 'Retry-After': '12' },
  }));
  try {
    await assert.rejects(chatRequest({ getIdToken: async () => 'token' }, '/api/chat'), (error) =>
      error.status === 429 && error.code === 'RATE_LIMITED' && error.retryAfter === 12 && error.message === 'Wait.');
  } finally { vi.restoreAllMocks(); }
});

test('Retry-After accepts seconds and HTTP dates and ignores malformed headers', () => {
  const now = Date.parse('2026-01-01T00:00:00Z');
  assert.equal(retryAfterSeconds('3'), 3);
  assert.equal(retryAfterSeconds('Thu, 01 Jan 2026 00:00:05 GMT', now), 5);
  assert.equal(retryAfterSeconds('bad', now), 0);
  assert.equal(retryAfterSeconds('-5', now), 0);
});

test('retry targets a saved incomplete assistant instead of duplicating the user message', () => {
  assert.deepEqual(resolveChatRetry({ body, beforeIds: [] }, saved), {
    kind: 'generate', body: { conversationId: 'conversation', retryMessageId: '2' },
  });
});

test('already-complete responses are reconciled without generating again', () => {
  assert.deepEqual(resolveChatRetry({ body, beforeIds: [] }, [saved[0], { ...saved[1], incomplete: false }]), { kind: 'complete' });
});

test('ambiguous network failures and newer turns require review before resending', () => {
  assert.deepEqual(resolveChatRetry({ body, beforeIds: [] }, []), { kind: 'review' });
  assert.deepEqual(resolveChatRetry({ body, beforeIds: [] }, [...saved, { id: '3', role: 'user', content: 'another question' }]), { kind: 'review' });
  assert.deepEqual(resolveChatRetry({ body: { conversationId: 'conversation', retryMessageId: '2' } }, saved.slice(0, 1)), { kind: 'review' });
});

test('requests rejected before persistence may be sent again after reconciliation', () => {
  assert.deepEqual(resolveChatRetry({ body, beforeIds: [], status: 429 }, []), { kind: 'generate', body });
});
