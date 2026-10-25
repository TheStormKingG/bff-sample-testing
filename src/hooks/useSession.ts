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
  if (typeof window === 'undefined') return { sawCode: false, problem: null };

  const search = new URLSearchParams(window.location.search);

  const error = search.get('error');
  const errorCode = search.get('error_code');
  const errorDescription = search.get('error_description');

  if (error !== null || errorCode !== null || errorDescription !== null) {
    const detail = errorDescription ?? error ?? errorCode ?? 'unspecified error';
    return {
      sawCode: false,
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
        problem: `Google sign-in was not completed: ${fragmentError.replace(/\+/g, ' ')}`,
      };
    }
  }

  return { sawCode: search.has('code'), problem: null };
}

const CALLBACK = snapshotCallback();

/**
 * Remove the spent callback parameters from the address bar, keeping the
 * HashRouter route intact.
 *
 * supabase-js already deletes `code` after a successful exchange; this also
 * clears the error parameters and a `code` that was never redeemed, so a
 * reload does not replay a stale sign-in attempt.
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
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let active = true;

    // `getSession()` awaits the client's own initialization, which is where the
    // PKCE code exchange happens, so this resolves only after the callback has
    // been fully processed. That ordering is what lets the app distinguish
    // "still checking" from "really signed out".
    void supabase.auth
      .getSession()
      .then(({ data, error }) => {
        if (!active) return;
        if (error !== null) setLookupError(error.message);
        setSession(data.session);
        setChecking(false);
      })
      .catch((cause: unknown) => {
        if (!active) return;
        setLookupError(
          cause instanceof Error
            ? cause.message
            : 'Could not check the sign-in state. Check the connection and retry.',
        );
        setChecking(false);
      });

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

  // Runs after the library has read the URL (see snapshotCallback).
  useEffect(() => {
    cleanCallbackParams();
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
      return (
        'Sign-in could not be completed. Start sign-in again in this same ' +
        'browser, and do not open the Google link on another device.'
      );
    }
    return null;
  }, [dismissed, lookupError, status]);

  const dismissAuthError = useCallback(() => setDismissed(true), []);

  return {
    status,
    session,
    user: session?.user ?? null,
    authError,
    dismissAuthError,
  };
}
