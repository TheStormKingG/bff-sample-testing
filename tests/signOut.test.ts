// @vitest-environment jsdom
//
// Needed because the last-resort path touches `window.localStorage`. Without
// it this file runs under `node`, `window` is undefined, the shipped code's
// own try/catch swallows the ReferenceError and the fallback test fails for a
// reason that has nothing to do with the behaviour under test.

/**
 * Signing out must actually sign the person out, even when the server refuses.
 *
 * WHY THIS EXISTS. `supabase.auth.signOut()` posts to `/logout` with the
 * current access token. If the server rejects that token the call returns an
 * error AND LEAVES THE STORED SESSION IN PLACE, so the app still believes
 * somebody is signed in and the button appears to do nothing.
 *
 * That is the normal case at the one moment a person most wants out. An
 * administrator resetting a password revokes the holder's session server-side,
 * so their next request gets a 401 — and they are then on the change-password
 * screen, holding a credential the server will not accept, pressing a Sign out
 * button that cannot work. Reproduced on the live deployment: a locally valid
 * session with 44 minutes left, 401 and 403 from the server, and the button
 * inert.
 *
 * On a shared plant tablet that is worse than an annoyance. If the previous
 * person cannot sign out, the next one picks up a device still holding an
 * identity, and every record they create is attributed to somebody else —
 * the one thing this application exists to prevent.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const FAKE_ENV = {
  VITE_SUPABASE_URL: 'https://example.supabase.co',
  VITE_SUPABASE_ANON_KEY: 'test-anon-key',
  VITE_APP_VERSION: 'test',
  VITE_BASE_PATH: '/',
};

vi.mock('@/lib/env', () => ({
  env: FAKE_ENV,
  basePath: '/',
  readEnv: () => FAKE_ENV,
}));

const harness = vi.hoisted(() => ({
  /** Calls recorded as {scope} so the test can tell remote from local. */
  calls: [] as Array<string | undefined>,
  /** Queue of results, consumed in order. */
  results: [] as Array<{ error: Error | null }>,
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    auth: {
      signOut: (options?: { scope?: string }) => {
        harness.calls.push(options?.scope);
        return Promise.resolve(
          harness.results.shift() ?? { error: new Error('no result queued') },
        );
      },
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
      getSession: () => Promise.resolve({ data: { session: null }, error: null }),
    },
  }),
}));

/**
 * A working `localStorage`, installed because this environment has none.
 *
 * jsdom here runs on an opaque origin, for which the spec requires storage to
 * be unavailable — `window.localStorage` is a bare object with no `setItem`,
 * `getItem` or `removeItem` at all. That is why the shipped `signOut` wraps
 * its last-resort clear in a try/catch, and why without this stub the
 * fallback test fails for a reason unrelated to the behaviour under test.
 *
 * Worth recording: nothing else in the suite exercises browser storage, so
 * any other code reading it is equally unexercised here.
 */
function installStorage(): void {
  const data = new Map<string, string>();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      removeItem: (k: string) => void data.delete(k),
      clear: () => data.clear(),
      key: (i: number) => [...data.keys()][i] ?? null,
      get length() {
        return data.size;
      },
    },
  });
}

beforeEach(() => {
  harness.calls = [];
  harness.results = [];
  installStorage();
  window.localStorage.setItem('bff-sample-testing-auth', '{"user":"someone"}');
});

describe('signOut', () => {
  it('reports success when the server accepts the logout', async () => {
    harness.results = [{ error: null }];
    const { signOut } = await import('@/lib/supabase');

    await expect(signOut()).resolves.toEqual({ error: null });
    // Exactly one call, with no scope: the remote logout. A fallback fired
    // here would mean the happy path is doing unnecessary work.
    expect(harness.calls).toEqual([undefined]);
  });

  it('falls back to a local sign-out when the server rejects the token', async () => {
    // Precisely the live failure: the session is locally valid, the server has
    // revoked it because an administrator reset the password.
    harness.results = [
      { error: new Error('Auth session missing or already revoked (401)') },
      { error: null },
    ];
    const { signOut } = await import('@/lib/supabase');

    // The person is signed out, so no error is reported. Reporting the first
    // failure would send somebody to fix a problem that no longer exists.
    await expect(signOut()).resolves.toEqual({ error: null });
    expect(harness.calls).toEqual([undefined, 'local']);
  });

  it('clears the stored session by hand when even the local sign-out fails', async () => {
    harness.results = [
      { error: new Error('401') },
      { error: new Error('storage refused') },
    ];
    const { signOut } = await import('@/lib/supabase');

    await expect(signOut()).resolves.toEqual({ error: null });
    // The assertion that matters: the identity is no longer on this device.
    expect(window.localStorage.getItem('bff-sample-testing-auth')).toBeNull();
  });

  it('would catch the original defect', async () => {
    // The positive control. Before the fix, signOut returned the server's
    // error and made no second attempt — so a test that only checked the
    // happy path would have passed against the broken version. This asserts
    // the second attempt HAPPENS, which the old code could not satisfy.
    harness.results = [{ error: new Error('401') }, { error: null }];
    const { signOut } = await import('@/lib/supabase');

    await signOut();
    expect(harness.calls.length).toBeGreaterThan(1);
    expect(harness.calls).toContain('local');
  });
});
