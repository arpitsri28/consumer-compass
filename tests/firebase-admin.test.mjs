import assert from 'node:assert/strict';
import { beforeEach, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  cert: vi.fn(), getApps: vi.fn(), initializeApp: vi.fn(), getAuth: vi.fn(), verifyIdToken: vi.fn(),
}));
vi.mock('firebase-admin/app', () => ({ cert: mocks.cert, getApps: mocks.getApps, initializeApp: mocks.initializeApp }));
vi.mock('firebase-admin/auth', () => ({ getAuth: mocks.getAuth }));
import { verifyRequestUser } from '../app/lib/server/firebase-admin.js';

const request = (authorization = 'Bearer signed-token') => new Request('http://localhost', { headers: { authorization } });
const account = { project_id: 'test-project', client_email: 'admin@example.invalid', private_key: 'line1\\nline2' };

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('FIREBASE_SERVICE_ACCOUNT_JSON', JSON.stringify(account));
  mocks.getApps.mockReturnValue([]);
  mocks.cert.mockReturnValue('mock-certificate');
  mocks.initializeApp.mockReturnValue({ name: 'consumer-compass-server' });
  mocks.getAuth.mockReturnValue({ verifyIdToken: mocks.verifyIdToken });
  mocks.verifyIdToken.mockResolvedValue({ uid: 'verified-user', email: 'user@example.invalid', admin: true });
});

test('default verifier initializes Firebase Admin and checks revocation', async () => {
  assert.deepEqual(await verifyRequestUser(request()), { uid: 'verified-user', email: 'user@example.invalid' });
  assert.deepEqual(mocks.cert.mock.calls[0], [{ projectId: 'test-project', clientEmail: account.client_email, privateKey: 'line1\nline2' }]);
  assert.deepEqual(mocks.initializeApp.mock.calls[0], [{ credential: 'mock-certificate', projectId: 'test-project' }, 'consumer-compass-server']);
  assert.deepEqual(mocks.verifyIdToken.mock.calls[0], ['signed-token', true]);
});

test('default verifier reuses its named app without parsing credentials again', async () => {
  const app = { name: 'consumer-compass-server' };
  mocks.getApps.mockReturnValue([app]);
  vi.stubEnv('FIREBASE_SERVICE_ACCOUNT_JSON', 'invalid');
  await verifyRequestUser(request());
  assert.equal(mocks.initializeApp.mock.calls.length, 0);
  assert.deepEqual(mocks.getAuth.mock.calls[0], [app]);
});

test('missing authorization never initializes Firebase Admin', async () => {
  await assert.rejects(verifyRequestUser(request('')), (error) => error.status === 401);
  assert.equal(mocks.initializeApp.mock.calls.length, 0);
  assert.equal(mocks.verifyIdToken.mock.calls.length, 0);
});

test('malformed service-account configuration returns a safe 503', async () => {
  vi.stubEnv('FIREBASE_SERVICE_ACCOUNT_JSON', '{broken');
  await assert.rejects(verifyRequestUser(request()), (error) => error.status === 503 && !error.message.includes('broken'));
  assert.equal(mocks.verifyIdToken.mock.calls.length, 0);
});

for (const code of ['auth/invalid-id-token', 'auth/id-token-expired', 'auth/id-token-revoked', 'auth/user-disabled']) {
  test(`Firebase Admin ${code} maps to 401`, async () => {
    mocks.verifyIdToken.mockRejectedValue(Object.assign(new Error('private SDK details'), { code }));
    await assert.rejects(verifyRequestUser(request()), (error) => error.status === 401 && !error.message.includes('private SDK details'));
  });
}

test('Firebase infrastructure failure maps to a safe 503', async () => {
  mocks.verifyIdToken.mockRejectedValue(new Error('private infrastructure details'));
  await assert.rejects(verifyRequestUser(request()), (error) => error.status === 503 && !error.message.includes('private infrastructure details'));
});
