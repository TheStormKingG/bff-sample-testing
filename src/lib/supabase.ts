/**
 * The Supabase browser client.
 *
 * This client carries ONLY the publishable (anon) key. That key grants no
 * authority of its own: every read and write is decided by Row Level Security
 * evaluated against the signed-in user's JWT, and every mutation goes through
 * an authenticated Edge Function or a controlled RPC. Master Prompt section 1:
 * "Security must reside in Supabase, RLS, Edge Functions and locked-down
 * Google Sheet sharing — not in hidden UI buttons."
 */

import { createClient } from '@supabase/supabase-js';
import { env, basePath } from '@/lib/env';

/**
 * Where Google must send the browser back to after sign-in.
 *
 * `import.meta.env.BASE_URL` is Vite's compiled `base`, so this resolves to
 * `http://localhost:5173/` in local dev and `https://OWNER.github.io/REPO/`
 * on GitHub Pages. Both exact strings must appear in the Supabase Auth
 * "Redirect URLs" allowlist, and the Site URL must be the Pages one.
 *
 * Note there is no `#/...` route in the returned URL. The callback lands on
 * the app root and HashRouter then takes over — see the long comment in
 * `App.tsx` for why that ordering matters.
 */
export function oauthRedirectUrl(): string {
  return new URL(basePath, window.location.origin).toString();
}

export const supabase = createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY, {
  auth: {
    /**
     * PKCE, not implicit — and this is not a preference, it is a correctness
     * requirement of this deployment.
     *
     * supabase-js defaults to the implicit flow, which returns the session as
     * a URL *fragment*: `https://host/REPO/#access_token=...&expires_in=...`.
     * This app routes with HashRouter, so the fragment is also where the route
     * lives. The two uses collide: the router sees `/access_token=...` as an
     * unknown route, and whichever of the two reads or rewrites the fragment
     * first destroys the other's data. Implicit flow also leaves a bearer
     * token in browser history.
     *
     * PKCE instead returns `?code=...` in the QUERY string, which HashRouter
     * never touches. supabase-js exchanges that code for a session and then
     * removes only the `code` parameter, preserving the hash, so the route
     * survives the exchange intact.
     *
     * If the Supabase project is ever switched back to implicit, the hash will
     * arrive carrying tokens; `useSession` detects that case explicitly and
     * reports it rather than failing silently.
     */
    flowType: 'pkce',

    /**
     * Let supabase-js perform the code exchange on load. It reads
     * `window.location.href` synchronously while the client is being
     * constructed, which is before any React effect runs — so nothing in the
     * app can strip the callback parameters out from under it.
     */
    detectSessionInUrl: true,

    persistSession: true,
    autoRefreshToken: true,

    /**
     * An explicit key keeps the stored session (and the PKCE code verifier,
     * which is stored at `<storageKey>-code-verifier`) separate from any other
     * Supabase app served from the same github.io origin. GitHub Pages shares
     * one origin across every repository of an account, so the default key
     * would be shared too.
     */
    storageKey: 'bff-sample-testing-auth',
  },
});

/**
 * Start Google sign-in.
 *
 * Only the default OpenID scopes are requested. No Drive or Sheets scope is
 * ever asked for: staff sign-in proves identity only, and all workbook access
 * runs server-side through a dedicated least-privilege service account
 * (Master Prompt section 1). Google login does not grant app permission — the
 * resulting profile starts as `pending` and sees nothing until approved.
 */
export async function signInWithGoogle(): Promise<{ error: Error | null }> {
  const { error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo: oauthRedirectUrl(),
      // Always show the account chooser: plant tablets are shared devices, so
      // silently reusing the previously signed-in Google account would
      // mis-attribute quality records to the wrong person (PRD section 2).
      queryParams: { prompt: 'select_account' },
    },
  });
  return { error: error ?? null };
}

export async function signOut(): Promise<{ error: Error | null }> {
  const { error } = await supabase.auth.signOut();
  return { error: error ?? null };
}
