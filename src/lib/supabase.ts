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

import {
  createClient,
  FunctionsFetchError,
  FunctionsHttpError,
  isAuthError,
  isAuthRetryableFetchError,
} from '@supabase/supabase-js';
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

// ---------------------------------------------------------------------------
// Email and password sign-in
//
// WHY THIS EXISTS ALONGSIDE GOOGLE, AND WHY THERE IS NO SELF-SERVICE PATH.
//
// Plant-floor operators do not all have Google accounts, so Google alone
// cannot be the only way in. The obvious alternative — self-service signup
// and a "forgot password" email — cannot work on this project: it has no
// custom SMTP configured, and Supabase's shared sender only delivers to
// members of the Supabase organisation. A "forgot password" link here would
// be a button that sends nothing.
//
// So an administrator creates the account with a temporary password and the
// holder is forced to replace it. That forcing is NOT implemented here, and it
// is not implemented in the router either. Migration 0019 put it inside
// `public.require_permission`, which covers the RPC and Edge Function route
// only; migration 0020 put it inside `public.is_active_user()` and
// `public.has_permission()`, which is what the row-level-security policies
// authorise through. BOTH are needed for the claim "no permission by any
// route — PostgREST, Edge Function or RPC" to be true, and before 0020 it was
// not: the policies never consulted the credential, so an armed account was
// refused by the Edge Functions and served by PostgREST. What the frontend
// adds is the way out of that state and an honest explanation of it.
// ---------------------------------------------------------------------------

/**
 * The shortest password this app will submit.
 *
 * NOT IN THE CROSS-AGENT CONTRACT — added here and exported so there is one
 * number rather than one per screen. The client must be at least as strict as
 * the server: anything accepted here has to be accepted there, or the rule
 * stated to the operator before they type becomes a lie that only surfaces on
 * submit. Supabase's own floor is 6 characters and nothing in this project
 * raises it, so 10 is strictly safe today. If the `change-own-password` Edge
 * Function or the administrator screen enforces a different minimum, THIS
 * number is the one that must move, and both should import it rather than
 * writing their own.
 */
export const MIN_PASSWORD_LENGTH = 10;

/**
 * The longest password that is stored without silent loss, in BYTES.
 *
 * Mirrors `MAX_PASSWORD_BYTES` in `supabase/functions/_shared/validation.ts`,
 * where the reasoning is: GoTrue hashes with bcrypt, bcrypt ignores everything
 * past the 72nd byte, so a longer password would be accepted, truncated, and
 * two passwords differing only after byte 72 would both sign in — including
 * the temporary one an administrator typed and the "new" one chosen to replace
 * it. That is the whole point of this feature failing quietly.
 *
 * It is stated and checked HERE as well as there, because a rule the operator
 * meets only on submit is the thing this screen exists to avoid. BYTES, not
 * characters: a non-Latin script reaches 72 bytes well inside 72 characters.
 * A second declaration rather than an import, because the Edge module is Deno
 * code that cannot be pulled into a browser bundle; the two are compared by
 * `tests/passwordChangeRule.test.ts`.
 */
export const MAX_PASSWORD_BYTES = 72;

/** Count a password the way bcrypt does, so the limit means what it says. */
export function passwordByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

/**
 * The Edge Function that changes the caller's own password.
 *
 * Named once, here, because the string is a cross-component contract: the
 * function's directory name, this constant and the deployed function must
 * agree, and nothing compares them. Three outages in this project came from
 * exactly that shape of mismatch.
 */
export const CHANGE_OWN_PASSWORD_FUNCTION = 'change-own-password';

/**
 * The one answer to a rejected email-and-password pair.
 *
 * It deliberately does not say which half was wrong. Two reasons, and only
 * the second is about security: the server does not tell us (GoTrue answers
 * `invalid_credentials` for an unknown address and for a wrong password
 * alike), and saying "no such email" would let anyone test whether an address
 * has an account here. "Not accepted" is both the true statement and the
 * non-enumerating one.
 */
const PAIR_NOT_ACCEPTED =
  'That email address and password were not accepted. Check both and try again — ' +
  'capital letters matter. If the password has been forgotten, ask your Quality ' +
  'Supervisor or an administrator to set a new one; nothing is emailed, they give ' +
  'it to you directly.';

const SIGN_IN_UNREACHABLE =
  'The sign-in service could not be reached, so nothing was checked. ' +
  'Check the connection and try again.';

/**
 * Turn whatever `signInWithPassword` rejected with into one operator-facing
 * sentence.
 *
 * Every branch here exists to avoid asserting a cause the library did not
 * establish. A dropped connection reported as "not accepted" would send
 * somebody to ask for a password reset they do not need, and a wrong password
 * reported as "check the connection" would send them to the network they
 * cannot fix. The two failures look identical to a caller that only reads
 * `error.message`.
 */
/*
 * EXPORTED FOR TEST, AND THE REASON IS NOT CONVENIENCE.
 *
 * This function and `edgeFailureMessage` below are about a hundred lines of
 * branch logic deciding which sentence an operator is shown, and every suite
 * that touched this module replaced the whole module with a stub — so neither
 * was executed by a single test. Both are reachable only through
 * `signInWithPassword` and `changeOwnPassword`, which the stubs replace, so
 * reordering the branches below — undoing the one decision this file argues
 * hardest for — broke nothing.
 *
 * A mock defines the floor of what a test file can observe, and a rule
 * implemented below that floor needs a test that imports the real module.
 * Exporting these two is what makes that possible; `tests/signInMessages.test.ts`
 * is that test.
 */
export function signInFailureMessage(error: unknown): string {
  if (!isAuthError(error)) {
    return error instanceof Error
      ? `Sign-in could not be completed: ${error.message}`
      : 'Sign-in could not be completed.';
  }

  // Checked FIRST. A retryable fetch failure is an `AuthError` carrying a
  // status, so every status-based branch below would otherwise claim it.
  if (isAuthRetryableFetchError(error)) return SIGN_IN_UNREACHABLE;

  const code = error.code ?? null;

  if (code === 'invalid_credentials' || code === 'user_not_found') {
    return PAIR_NOT_ACCEPTED;
  }
  if (code === 'over_request_rate_limit' || error.status === 429) {
    return (
      'Too many sign-in attempts from this device. Wait a minute and try again. ' +
      'Nothing is locked — the limit clears on its own.'
    );
  }
  if (code === 'email_not_confirmed') {
    return (
      'This account has not been confirmed, so it cannot sign in yet. Ask the ' +
      'administrator who created it to confirm it — no confirmation email is sent.'
    );
  }
  if (code === 'user_banned') {
    // Deliberately states no cause. Saying "banned" would both confirm the
    // address has an account and point at a remedy the holder cannot apply.
    return (
      'This account cannot sign in at the moment. Speak to your Quality Supervisor ' +
      'or an administrator.'
    );
  }
  if (error.status === 400 || error.status === 422) {
    // GoTrue's catch-all for a malformed address or a rejected credential.
    return PAIR_NOT_ACCEPTED;
  }
  if (error.status === undefined) return SIGN_IN_UNREACHABLE;

  return `Sign-in could not be completed: ${error.message}`;
}

/**
 * Sign in with an email address and a password.
 *
 * The email is trimmed because a tablet keyboard's autocomplete routinely
 * appends a space, and an invisible trailing space is indistinguishable from
 * a wrong address on the screen. The PASSWORD is never trimmed: an
 * administrator may legitimately have typed one with a leading or trailing
 * space, and silently altering it here would reject the correct credential.
 *
 * Signing in successfully does not mean the account may do anything. The
 * profile still has to be `active`, and if an administrator set this
 * password the account holds no permission until it is replaced — see
 * `changeOwnPassword`.
 */
export async function signInWithPassword(
  email: string,
  password: string,
): Promise<{ error: Error | null }> {
  const { error } = await supabase.auth.signInWithPassword({
    email: email.trim(),
    password,
  });
  return { error: error === null ? null : new Error(signInFailureMessage(error)) };
}

/**
 * Read the message out of an Edge Function failure.
 *
 * supabase-js collapses every non-2xx into one `FunctionsHttpError` whose
 * `message` is the generic "Edge Function returned a non-2xx status code", so
 * the body has to be read to find out what happened. Without this step a
 * rejected password, an expired session and a function that is not deployed
 * are indistinguishable to the person standing at the tablet. The envelope is
 * the one every function in this project emits: `{ error: { code, message } }`
 * (`supabase/functions/_shared/errors.ts`). The same decoding already exists
 * in `useRegisterSample.ts`; this is the short form of it.
 */
export async function edgeFailureMessage(error: unknown, fnName: string): Promise<string> {
  if (error instanceof FunctionsFetchError) {
    return (
      'The change could not be sent, so your password has NOT been changed. ' +
      'Check the connection and try again.'
    );
  }

  if (error instanceof FunctionsHttpError) {
    const response = error.context as Response | undefined;
    const status = typeof response?.status === 'number' ? response.status : null;

    let body: unknown = null;
    if (response !== undefined && typeof response.json === 'function') {
      try {
        body = await response.json();
      } catch {
        // A non-JSON body means the platform answered, not our function.
        body = null;
      }
    }

    const envelope =
      typeof body === 'object' && body !== null
        ? ((body as { error?: unknown }).error as
            | { code?: unknown; message?: unknown }
            | undefined)
        : undefined;

    const message = typeof envelope?.message === 'string' ? envelope.message : '';
    if (message !== '') return message;

    // No envelope: this did not come from our function.
    if (status === 404) {
      return (
        `The "${fnName}" service is not deployed to this project, so no password can be ` +
        'changed. Your password has NOT been changed. An administrator must deploy the ' +
        'Edge Functions.'
      );
    }
    return (
      'The server refused the change and gave no reason that can be shown. Your password ' +
      'has NOT been changed. Tell an administrator if this keeps happening.'
    );
  }

  return error instanceof Error
    ? `The password could not be changed: ${error.message}`
    : 'The password could not be changed.';
}

/**
 * Replace the caller's own password.
 *
 * ROUTED THROUGH AN EDGE FUNCTION ON PURPOSE. `supabase.auth.updateUser`
 * would be one line and it would brick the account: the password would change
 * inside GoTrue while `public.profiles.password_changed_at` stayed NULL, so
 * `public.must_change_password()` would still answer true, so
 * `require_permission` would still withhold every permission — and the holder
 * would have no way back, because the only thing that clears the flag is the
 * recorded change this function performs. The two writes have to happen
 * together or not at all, and only the server can do that.
 *
 * It acts on the CALLER and takes no user id, so it cannot be aimed at
 * somebody else's account. Resetting another person's password is an
 * administrator action and lives on the admin surface.
 */
export async function changeOwnPassword(
  newPassword: string,
): Promise<{ error: Error | null }> {
  try {
    const { error } = await supabase.functions.invoke(CHANGE_OWN_PASSWORD_FUNCTION, {
      body: { newPassword },
    });
    if (error !== null) {
      return { error: new Error(await edgeFailureMessage(error, CHANGE_OWN_PASSWORD_FUNCTION)) };
    }
    return { error: null };
  } catch (cause: unknown) {
    // `invoke` returns its errors rather than throwing, but a transport or
    // serialisation fault can still throw. Reporting it as a refusal would be
    // a false denial; it is reported as an unknown outcome.
    return { error: new Error(await edgeFailureMessage(cause, CHANGE_OWN_PASSWORD_FUNCTION)) };
  }
}
