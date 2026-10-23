import { afterEach, expect, test, vi } from 'vitest';

vi.mock('firebase/app', () => ({ getApps: vi.fn(() => []), getApp: vi.fn(), initializeApp: vi.fn(() => ({})) }));
vi.mock('firebase/auth', () => ({ getAuth: vi.fn(() => ({})) }));
afterEach(() => { vi.resetModules(); vi.clearAllMocks(); });

test('missing Firebase configuration leaves public pages usable without starting auth', async () => {
  vi.stubEnv('NEXT_PUBLIC_FIREBASE_API_KEY', '');
  const { auth, app, firebaseConfigured } = await import('../../app/lib/firebase.js');
  const { initializeApp } = await import('firebase/app');
  const { getAuth } = await import('firebase/auth');
  expect(firebaseConfigured).toBe(false);
  expect(auth).toBeNull();
  expect(app).toBeNull();
  expect(initializeApp).not.toHaveBeenCalled();
  expect(getAuth).not.toHaveBeenCalled();
});

test('configured builds initialize the normal Firebase authentication client', async () => {
  for (const name of ['API_KEY', 'AUTH_DOMAIN', 'PROJECT_ID', 'APP_ID']) {
    vi.stubEnv(`NEXT_PUBLIC_FIREBASE_${name}`, 'test-setting');
  }
  const { auth, firebaseConfigured } = await import('../../app/lib/firebase.js');
  expect(firebaseConfigured).toBe(true);
  expect(auth).not.toBeNull();
});
