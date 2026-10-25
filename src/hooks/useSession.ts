/**
 * Supabase Auth session state, plus honest reporting of OAuth redirect
 * failures.
 *
 * A session here means only "Google has proved who this person is". It says
 * nothing about whether they may use the app — that is `useProfile`, and the
 * real control is RLS. Master Prompt section 1: "Google login proves identity
 * but does not grant app permission."
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Session, User } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';

export type SessionStatus = 'checking' | 'signed_in' | 'signed_out';

export interface UseSessionResult {
  readonly status: SessionStatus;
  readonly session: Session | null;
  readonly user: User | null;
  /** A readable problem with the sign-in attempt, or null. */
  readonly authError: string | null;
  readonly dismissAuthError: () => void;
}

interface CallbackSnapshot {
  /** A PKCE authorization code was present in the query string. */
  readonly sawCode: boolean;
  /**
   * The authorization code itself, captured at module load.
   *
   * Kept rather than discarded because the exchange is performed EXPLICITLY
   * below. Relying on the library to find the code in `window.location` made
   * sign-in depend on which of two asynchronous things happened first, and the
   * wrong one won — see the note on `cleanCallbackParams`.
   */
  readonly code: string | null;
  /** A problem the redirect itself reported, already made readable. */
  readonly problem: string | null;
}

/**
 * Read the OAuth callback parameters exactly once, at module load.
 *
 * Two things make the timing matter.
 *
 * 1. supabase-js reads `window.location.href` synchronously while the client
 *    is constructed (importing `@/lib/supabase` above is what constructs it),
 *    so by the time this runs the library already has its own copy. Nothing
 *    here can race it.
 * 2. React may mount this hook twice in development (StrictMode) and the URL
 *    is cleaned in an effect, so reading inside the component body would give
 *    a different answer on the second pass. A module-level snapshot is read
 *    once per page load, which is the right granularity for a redirect.
 */
function snapshotCallback(): CallbackSnapshot {
  if (typeof window === 'undefined') return { sawCode: false, code: null, problem: null };

  const search = new URLSearchParams(window.location.search);

  const error = search.get('error');
  const errorCode = search.get('error_code');
  const errorDescription = search.get('error_description');

  if (error !== null || errorCode !== null || errorDescription !== null) {
    const detail = errorDescription ?? error ?? errorCode ?? 'unspecified error';
    return {
      sawCode: false,
      code: null,
      problem: `Google sign-in was not completed: ${detail.replace(/\+/g, ' ')}`,
    };
  }

  /**
   * Guard against a fragment-mode (implicit) response.
   *
   * HashRouter owns the fragment, and a router route always begins `#/`. Any
   * other fragment shape on a fresh page load is not ours, so it is safe to
   * parse — and if it carries `access_token` the Supabase project is
   * configured for the implicit flow, which cannot work with hash routing.
   * Saying so is far better than the alternative, which is a sign-in that
   * appears to do nothing at all.
   */
  const hash = window.location.hash;
  if (hash.length > 1 && !hash.startsWith('#/')) {
    const fragment = new URLSearchParams(hash.slice(1));
    if (fragment.has('access_token')) {
      return {
        sawCode: false,
        code: null,
        problem:
          'The sign-in response came back in the page fragment, which this app ' +
          'cannot read because the fragment holds the page address. Ask an ' +
          'administrator to confirm the Supabase Auth redirect settings.',
      };
    }
    const fragmentError = fragment.get('error_description') ?? fragment.get('error');
    if (fragmentError !== null) {
      return {
        sawCode: false,
        code: null,
        problem: `Google sign-in was not completed: ${fragmentError.replace(/\+/g, ' ')}`,
      };
    }
  }

  const code = search.get('code');
  return { sawCode: code !== null, code, problem: null };
}

const CALLBACK = snapshotCallback();

/**
 * Remove the spent callback parameters from the address bar, keeping the
 * HashRouter route intact.
 *
 * MUST NOT RUN BEFORE THE EXCHANGE. This previously ran in its own effect on
 * mount, on the stated assumption that supabase-js had already taken its own
 * copy of the URL. Both halves of that assumption were wrong:
 *
 *   - supabase-js does not read the URL synchronously when the client is
 *     constructed. `_initialize()` is async, so `_getSessionFromURL()` runs in
 *     a later microtask.
 *   - `main.tsx` loads the app through `await import(...)`, so the client is
 *     constructed in a lazily-fetched chunk, after React has begun mounting.
 *
 * The effect therefore stripped `?code=` before the library ever looked, and
 * the library then found nothing to exchange. Measured, not inferred: with a
 * code in the query string and a valid verifier in localStorage, the page load
 * issued 23 network requests and NOT ONE of them went to the Supabase host.
 * The symptom was a sign-in that reported failure while the server had already
 * created the user.
 *
 * It is now called once, after the exchange has been attempted and settled.
 */
function cleanCallbackParams(): void {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  let changed = false;
  for (const key of ['code', 'state', 'error', 'error_code', 'error_description']) {
    if (url.searchParams.has(key)) {
      url.searchParams.delete(key);
      changed = true;
    }
  }
  if (changed) window.history.replaceState(window.history.state, '', url.toString());
}

export function useSession(): UseSessionResult {
  const [session, setSession] = useState<Session | null>(null);
  const [checking, setChecking] = useState(true);
  const [lookupError, setLookupError] = useState<string | null>(null);
  /** What the server said when the authorization code was refused. */
  const [exchangeError, setExchangeError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let active = true;

    /**
     * Resolve the session, redeeming the callback code ourselves.
     *
     * The exchange is explicit rather than left to `detectSessionInUrl`. The
     * library's own URL handling is a race against this module cleaning the
     * address bar, and against whenever the dynamically-imported client chunk
     * happens to finish initialising. Passing the code we captured at module
     * load removes the ordering question entirely: there is exactly one place
     * that redeems it, and it runs after the client is known to exist.
     *
     * `exchangeCodeForSession` is safe to call when the library already
     * succeeded — `getSession()` returns the session first and we never reach
     * the exchange — and safe when it did not, which is the case that was
     * silently failing.
     */
    async function resolveSession(): Promise<void> {
      try {
        const { data, error } = await supabase.auth.getSession();
        if (error !== null && active) setLookupError(error.message);

        let current = data.session;

        if (current === null && CALLBACK.code !== null) {
          const { data: exchanged, error: exchangeFailure } =
            await supabase.auth.exchangeCodeForSession(CALLBACK.code);
          if (exchangeFailure !== null) {
            if (active) setExchangeError(exchangeFailure.message);
          } else {
            current = exchanged.session;
          }
        }

        if (active) setSession(current);
      } catch (cause: unknown) {
        if (active) {
          setLookupError(
            cause instanceof Error
              ? cause.message
              : 'Could not check the sign-in state. Check the connection and retry.',
          );
        }
      } finally {
        if (active) setChecking(false);
        // Only now: the code has been redeemed or definitively refused, so
        // removing it from the address bar cannot destroy a pending sign-in.
        cleanCallbackParams();
      }
    }

    void resolveSession();

    const { data } = supabase.auth.onAuthStateChange((_event, next) => {
      if (!active) return;
      setSession(next);
      setChecking(false);
    });

    return () => {
      active = false;
      data.subscription.unsubscribe();
    };
  }, []);

  const status: SessionStatus = checking
    ? 'checking'
    : session !== null
      ? 'signed_in'
      : 'signed_out';

  const authError = useMemo(() => {
    if (dismissed) return null;
    if (CALLBACK.problem !== null) return CALLBACK.problem;
    if (lookupError !== null) return lookupError;

    /**
     * An authorization code arrived but produced no session. The usual cause
     * is that the PKCE code verifier is missing: the callback was opened in a
     * different browser or profile from the one that started sign-in, or site
     * data was cleared mid-flow. Without this branch the screen would simply
     * return to the sign-in button with no explanation.
     */
    if (CALLBACK.sawCode && status === 'signed_out') {
      // Say what the server actually refused, when it said anything. The
      // generic advice below is a guess about the cause; the server's own
      // message is evidence, and without it this screen sent people to retry
      // in the same browser when the browser was never the problem.
      return exchangeError !== null
        ? `Sign-in could not be completed: ${exchangeError}`
        : 'Sign-in could not be completed. Start sign-in again in this same ' +
            'browser, and do not open the Google link on another device.';
    }
    return null;
  }, [dismissed, exchangeError, lookupError, status]);

  const dismissAuthError = useCallback(() => setDismissed(true), []);

  return {
    status,
    session,
    user: session?.user ?? null,
    authError,
    dismissAuthError,
  };
}
