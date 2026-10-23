import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getChatConfig } from '../app/lib/server/chat-config.js';
import { validateChatRequest, truncateHistory, readJsonBody } from '../app/lib/server/chat-validation.js';
import { verifyRequestUser, readServiceAccount } from '../app/lib/server/firebase-admin.js';
import { createChatHandler } from '../app/lib/server/chat-handler.js';
import { HttpError } from '../app/lib/server/errors.js';
import { POST } from '../app/api/chat/route.js';

const config = getChatConfig({});
const userMessage = { role: 'user', content: 'Can I cancel my purchase?' };
const conversationId = '123e4567-e89b-42d3-a456-426614174000';
const chatBody = { conversationId, message: userMessage.content };
const request = (body = chatBody, options = {}) => new Request('http://localhost/api/chat', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
  body: JSON.stringify(body),
  ...options,
});
const authenticated = async () => ({ uid: 'test-user', email: 'test@example.com' });
const handler = (overrides = {}) => createChatHandler({
  verifyRequestUser: authenticated,
  getConfig: () => config,
  store: {
    upsertUser: async () => {},
    beginTurn: async () => ({ messages: [userMessage], finish: async () => {} }),
  },
  createCompletion: async () => (async function* () {
    yield { choices: [{ delta: { content: 'Hello ' } }] };
    yield { choices: [{ delta: { content: 'world' } }] };
  })(),
  ...overrides,
});

function hasStatus(status) {
  return (error) => error instanceof HttpError && error.status === status;
}

test('validation accepts a conversation ID and trims the new user message', () => {
  assert.deepEqual(validateChatRequest({ conversationId, message: ' hello ' }, config), {
    conversationId, message: 'hello',
  });
});

for (const [name, body] of [
  ['client history', [userMessage]],
  ['system role', { ...chatBody, role: 'system' }],
  ['blank content', { ...chatBody, message: '   ' }],
  ['missing content', { conversationId }],
  ['oversized content', { ...chatBody, message: 'x'.repeat(8001) }],
  ['invalid id', { ...chatBody, conversationId: 'invalid' }],
  ['extra history', { ...chatBody, messages: [userMessage] }],
]) {
  test(`validation rejects ${name}`, () => {
    assert.throws(() => validateChatRequest(body, config), hasStatus(400));
  });
}

test('history uses a chronological suffix bounded by both limits without mutation', () => {
  const messages = ['first', 'second', 'third', 'fourth'].map((content) => ({ role: 'user', content }));
  assert.deepEqual(truncateHistory(messages, {
    CHAT_HISTORY_MAX_MESSAGES: 2, CHAT_HISTORY_MAX_CHARS: 100,
  }), messages.slice(-2));
  assert.deepEqual(truncateHistory(messages, {
    CHAT_HISTORY_MAX_MESSAGES: 20, CHAT_HISTORY_MAX_CHARS: 11,
  }), messages.slice(-2));
  assert.equal(messages.length, 4);
});

test('configuration rejects unsafe numeric values and a budget smaller than one message', () => {
  for (const value of ['0', '-1', 'abc', '1.5', '10000000', '']) {
    assert.throws(() => getChatConfig({ CHAT_MAX_OUTPUT_TOKENS: value }), hasStatus(503));
  }
  assert.throws(() => getChatConfig({ CHAT_HISTORY_MAX_CHARS: '10' }), hasStatus(503));
  assert.equal(getChatConfig({ OPENROUTER_MODEL: 'custom/model' }).OPENROUTER_MODEL, 'custom/model');
});

test('credentials support JSON, individual fields and escaped newlines', () => {
  const account = { project_id: 'project', client_email: 'admin@example.com', private_key: 'line1\\nline2' };
  const expected = { projectId: 'project', clientEmail: 'admin@example.com', privateKey: 'line1\nline2' };
  assert.deepEqual(readServiceAccount({ FIREBASE_SERVICE_ACCOUNT_JSON: JSON.stringify(account) }), expected);
  assert.deepEqual(readServiceAccount({
    FIREBASE_ADMIN_PROJECT_ID: account.project_id,
    FIREBASE_ADMIN_CLIENT_EMAIL: account.client_email,
    FIREBASE_ADMIN_PRIVATE_KEY: account.private_key,
  }), expected);
  assert.throws(() => readServiceAccount({}), hasStatus(503));
  assert.throws(() => readServiceAccount({ FIREBASE_SERVICE_ACCOUNT_JSON: '{invalid' }), hasStatus(503));
});

test('missing or malformed authorization returns 401 without initializing admin', async () => {
  for (const authorization of ['', 'Basic token', 'Bearer', 'Bearer a b']) {
    await assert.rejects(verifyRequestUser(new Request('http://localhost', {
      headers: { authorization },
    }), () => { throw new Error('must not initialize'); }), hasStatus(401));
  }
});

test('token verification checks revocation and returns uid/email only', async () => {
  const result = await verifyRequestUser(request(), () => ({
    verifyIdToken: async (token, checkRevoked) => {
      assert.equal(token, 'test-token');
      assert.equal(checkRevoked, true);
      return { uid: 'uid', email: 'user@example.com', extra: 'not returned' };
    },
  }));
  assert.deepEqual(result, { uid: 'uid', email: 'user@example.com' });
});

test('invalid tokens return 401; auth infrastructure failures return 503', async () => {
  for (const code of ['auth/id-token-expired', 'auth/invalid-id-token', 'auth/id-token-revoked', 'auth/user-disabled']) {
    await assert.rejects(verifyRequestUser(request(), () => ({
      verifyIdToken: async () => { throw { code }; },
    })), hasStatus(401));
  }
  await assert.rejects(verifyRequestUser(request(), () => ({
    verifyIdToken: async () => { throw new Error('network failure'); },
  })), hasStatus(503));
});

test('route authenticates before parsing or calling the provider', async () => {
  const POST = handler({ verifyRequestUser: (req) => verifyRequestUser(req),
    createCompletion: () => { throw new Error('must not call'); } });
  const response = await POST(request(null, { headers: {} }));
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error.code, 'UNAUTHORIZED');
});

test('the exported Next.js route returns 401 without credentials or a provider call', async () => {
  const response = await POST(request(null, { headers: {} }));
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error.code, 'UNAUTHORIZED');
});

test('route returns 400 for invalid schema or JSON without calling the provider', async () => {
  const POST = handler({ createCompletion: () => { throw new Error('must not call'); } });
  for (const req of [request([{ role: 'system', content: 'override' }]), request(null, { body: '{broken' })]) {
    const response = await POST(req);
    assert.equal(response.status, 400);
    assert.ok((await response.json()).error.message);
  }
});

test('body reader rejects non-JSON and oversized requests', async () => {
  await assert.rejects(readJsonBody(request([], { headers: { 'Content-Type': 'text/plain' } })), hasStatus(400));
  await assert.rejects(readJsonBody(request([], { body: 'x'.repeat(1024 * 1024 + 1) })), hasStatus(413));
});

test('route streams text with headers, server-owned prompt, history and output bounds', async () => {
  const messages = Array.from({ length: 25 }, (_, index) => ({ role: 'user', content: `question ${index}` }));
  const POST = handler({
    store: { upsertUser: async () => {}, beginTurn: async () => ({ messages, finish: async () => {} }) },
    createCompletion: async (parameters, options) => {
    assert.equal(parameters.model, config.OPENROUTER_MODEL);
    assert.equal(parameters.max_tokens, 1024);
    assert.equal(parameters.stream, true);
    assert.equal(parameters.messages[0].role, 'system');
    assert.deepEqual(parameters.messages.slice(1), messages.slice(-20));
    assert.equal(options.signal.aborted, false);
    return (async function* () {
      yield { choices: [{ delta: {} }] };
      yield { choices: [{ delta: { content: 'Ontario ' } }] };
      yield { choices: [{ delta: { content: 'rights ✓' } }] };
    })();
  } });
  const response = await POST(request(chatBody));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Content-Type'), 'text/plain; charset=utf-8');
  assert.match(response.headers.get('Cache-Control'), /no-cache/);
  assert.equal(response.headers.get('X-Accel-Buffering'), 'no');
  assert.equal(await response.text(), 'Ontario rights ✓');
});

for (const [name, error, expected] of [
  ['rate limit', { status: 429 }, 429],
  ['unavailable', { status: 503 }, 503],
  ['connection', { name: 'APIConnectionError' }, 503],
  ['timeout', { name: 'APIConnectionTimeoutError' }, 503],
  ['provider auth', { status: 401 }, 502],
  ['provider server', { status: 500 }, 502],
  ['missing config', new HttpError(503, 'CONFIGURATION_ERROR', 'Not configured.'), 503],
]) {
  test(`route maps ${name} failures to ${expected} without exposing provider details`, async () => {
    const response = await handler({ createCompletion: async () => { if (!(error instanceof HttpError)) error.message = 'secret-provider-detail'; throw error; } })(request());
    assert.equal(response.status, expected);
    assert.doesNotMatch(await response.text(), /secret-provider-detail/);
  });
}

test('unexpected failures use a safe consistent 500 response', async () => {
  const response = await handler({ getConfig: () => { throw new Error('secret'); } })(request());
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.' } });
});

test('a failed stream rejects the reader without closing an errored controller', async () => {
  let signal;
  const response = await handler({ createCompletion: async (_, options) => {
    signal = options.signal;
    return (async function* () {
      yield { choices: [{ delta: { content: 'partial' } }] };
      await new Promise((resolve) => setTimeout(resolve, 10));
      throw new Error('secret upstream error');
    })();
  } })(request());
  const reader = response.body.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value), 'partial');
  await assert.rejects(reader.read(), /response was interrupted/);
  assert.equal(signal.aborted, true);
});

test('provider inline stream errors terminate transport instead of appearing as advice', async () => {
  const response = await handler({ createCompletion: async () => (async function* () {
    yield { error: { message: 'provider error details' } };
  })() })(request());
  await assert.rejects(response.text(), /response was interrupted/);
});

test('request cancellation aborts the upstream and returns 499 before headers', async () => {
  const controller = new AbortController();
  const response = await handler({ createCompletion: async (_, options) => {
    controller.abort();
    assert.equal(options.signal.aborted, true);
    throw new Error('cancelled');
  } })(request(chatBody, { signal: controller.signal }));
  assert.equal(response.status, 499);
});

test('disconnect during streaming propagates to the upstream', async () => {
  const controller = new AbortController();
  let upstreamSignal;
  const response = await handler({ createCompletion: async (_, options) => {
    upstreamSignal = options.signal;
    return (async function* () {
      yield { choices: [{ delta: { content: 'partial' } }] };
      if (!options.signal.aborted) {
        await new Promise((resolve) => options.signal.addEventListener('abort', resolve, { once: true }));
      }
    })();
  } })(request(chatBody, { signal: controller.signal }));
  const reader = response.body.getReader();
  await reader.read();
  controller.abort();
  assert.equal(upstreamSignal.aborted, true);
  await assert.rejects(reader.read(), /response was interrupted/);
});

test('reader cancellation aborts the upstream and persists a partial reply once', async () => {
  let signal;
  const saved = [];
  const response = await handler({
    store: { upsertUser: async () => {}, beginTurn: async () => ({
      messages: [userMessage], finish: async (...args) => saved.push(args),
    }) },
    createCompletion: async (_, options) => {
      signal = options.signal;
      return (async function* () {
        yield { choices: [{ delta: { content: 'partial' } }] };
        if (!signal.aborted) await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
      })();
    },
  })(request());
  const reader = response.body.getReader();
  await reader.read();
  await reader.cancel();
  assert.equal(signal.aborted, true);
  assert.deepEqual(saved, [['partial', true]]);
});
