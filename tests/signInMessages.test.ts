/**
 * The two error classifiers in `src/lib/supabase.ts`, executed.
 *
 * ===========================================================================
 * WHY THIS SUITE EXISTS
 * ===========================================================================
 * `signInFailureMessage` and `edgeFailureMessage` are about a hundred lines
 * deciding which sentence an operator is shown, with a written rationale for
 * why one branch must be tested FIRST. Before this file, not one test executed
 * either of them: both live inside the module that every other suite replaces
 * wholesale with `vi.mock('@/lib/supabase', ...)`, and neither was exported, so
 * they were reachable only through `signInWithPassword` and `changeOwnPassword`
 * — the two functions the stubs replace.
 *
 * The consequence was specific: reordering the retryable-fetch branch below the
 * status branches — undoing the one decision the file argues hardest for —
 * would have broken nothing in the suite. A mock defines the floor of what a
 * test file can observe, and these rules live below that floor.
 *
 * ===========================================================================
 * THE LOAD-BEARING BRANCH
 * ===========================================================================
 * `AuthRetryableFetchError` extends `AuthError` and carries a `status` (503 in
 * practice), so `error.status === 400 || error.status === 422` and the 429
 * branch would all happily claim it if they ran first. A dropped connection
 * reported as "that email and password were not accepted" sends somebody to ask
 * for a password reset they do not need; a wrong password reported as "check
 * the connection" sends them to a network they cannot fix. The two failures are
 * indistinguishable to a caller that only reads `error.message`.
 *
 * So the ordering is not asserted by reading the source. It is asserted by
 * constructing a retryable error that ALSO satisfies each later branch's
 * condition, and requiring the unreachable-service answer anyway. That is a
 * test only because the two hypotheses predict different outputs: if the
 * branches were reordered, these cases return the credential answer.
 *
 * Nothing here is faked except the Vite environment, which `src/lib/env.ts`
 * validates at module load. The error classes are the real ones from
 * `@supabase/supabase-js`, because `isAuthError` keys on a private
 * `__isAuthError` property and a hand-rolled object would be classified by the
 * first branch and prove nothing about the rest.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  AuthApiError,
  AuthError,
  AuthRetryableFetchError,
  FunctionsFetchError,
  FunctionsHttpError,
} from '@supabase/supabase-js';

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

const { signInFailureMessage, edgeFailureMessage } = await import('@/lib/supabase');

const NOT_ACCEPTED = /that email address and password were not accepted/i;
const UNREACHABLE = /sign-in service could not be reached/i;

describe('signInFailureMessage: the retryable-fetch branch comes first', () => {
  it('reports an unreachable service, not a rejected credential', () => {
    expect(signInFailureMessage(new AuthRetryableFetchError('Failed to fetch', 503))).toMatch(
      UNREACHABLE,
    );
  });

  it('still does so when the status would satisfy the 400 branch', () => {
    // THE ORDERING TEST. 400 is the branch that maps to the credential answer,
    // so if the retryable check moved below it this returns NOT_ACCEPTED. The
    // two orderings predict different strings, which is what makes this a test
    // rather than a restatement.
    const error = new AuthRetryableFetchError('Failed to fetch', 400);
    expect(signInFailureMessage(error)).toMatch(UNREACHABLE);
    expect(signInFailureMessage(error)).not.toMatch(NOT_ACCEPTED);
  });

  it('still does so when the status would satisfy the 422 branch', () => {
    expect(signInFailureMessage(new AuthRetryableFetchError('Failed to fetch', 422))).toMatch(
      UNREACHABLE,
    );
  });

  it('still does so when the status would satisfy the rate-limit branch', () => {
    // 429 is the other branch that claims a status. "Wait a minute and try
    // again — nothing is locked" is a false reassurance about a dropped
    // connection, which does not clear on its own.
    const message = signInFailureMessage(new AuthRetryableFetchError('Failed to fetch', 429));
    expect(message).toMatch(UNREACHABLE);
    expect(message).not.toMatch(/too many sign-in attempts/i);
  });

  it('the branches it guards do fire on their own — the positive control', () => {
    // Without this, every assertion above is satisfied by a function that
    // returns UNREACHABLE for everything.
    expect(signInFailureMessage(new AuthApiError('Invalid login credentials', 400, undefined))).toMatch(
      NOT_ACCEPTED,
    );
    expect(signInFailureMessage(new AuthApiError('rate limited', 429, undefined))).toMatch(
      /too many sign-in attempts/i,
    );
  });
});

describe('signInFailureMessage: the enumeration-safe answer', () => {
  it('gives the same answer for an unknown address and a wrong password', () => {
    // GoTrue answers `invalid_credentials` for both, and saying "no such
    // email" would let anyone test whether an address has an account here. The
    // two must be byte-identical, not merely similar.
    const unknownAddress = signInFailureMessage(
      new AuthApiError('Invalid login credentials', 400, 'invalid_credentials'),
    );
    const wrongPassword = signInFailureMessage(
      new AuthApiError('Invalid login credentials', 400, 'user_not_found'),
    );

    expect(unknownAddress).toBe(wrongPassword);
    expect(unknownAddress).toMatch(NOT_ACCEPTED);
  });

  it('names no cause for a banned account, and points at a person', () => {
    // "Banned" would confirm the address has an account AND name a remedy the
    // holder cannot apply.
    const message = signInFailureMessage(
      new AuthApiError('User is banned', 400, 'user_banned'),
    );

    expect(message).not.toMatch(/ban/i);
    expect(message).toMatch(/quality supervisor|administrator/i);
  });

  it('tells an unconfirmed account that no confirmation email is coming', () => {
    // This project has no SMTP at all, so "check your email" would be a
    // permanent dead end.
    const message = signInFailureMessage(
      new AuthApiError('Email not confirmed', 400, 'email_not_confirmed'),
    );

    expect(message).toMatch(/not been confirmed/i);
    expect(message).toMatch(/no confirmation email is sent/i);
  });

  it('mentions that a forgotten password is handed over in person', () => {
    // The whole feature in one sentence, where the person who needs it reads
    // it: there is no reset link, so the remedy is to ask somebody.
    const message = signInFailureMessage(
      new AuthApiError('Invalid login credentials', 400, 'invalid_credentials'),
    );

    expect(message).toMatch(/nothing is emailed/i);
    expect(message).toMatch(/give it to you directly/i);
  });

  it('treats a 422 as the credential answer', () => {
    expect(signInFailureMessage(new AuthApiError('unprocessable', 422, undefined))).toMatch(
      NOT_ACCEPTED,
    );
  });

  it('treats an AuthError with no status as an unreachable service', () => {
    // The base `AuthError`, not `AuthApiError`. `AuthError.status` is typed
    // `number | undefined` and its own documentation names the population:
    // "some errors that occur before a response is received will not have one
    // present. In that case status will also be undefined." `AuthApiError`
    // narrows `status` to `number`, so constructing this case through it is a
    // type error — which is how the real population was found, rather than by
    // reading the branch and inventing an input for it.
    expect(signInFailureMessage(new AuthError('Request aborted'))).toMatch(UNREACHABLE);
  });

  it('falls through to the library wording for a status it has no rule for', () => {
    const message = signInFailureMessage(new AuthApiError('Teapot', 418, undefined));
    expect(message).toMatch(/sign-in could not be completed/i);
    expect(message).toContain('Teapot');
  });
});

describe('signInFailureMessage: things that are not AuthErrors at all', () => {
  it('keeps a plain Error’s message, without classifying it', () => {
    const message = signInFailureMessage(new Error('TypeError: fetch failed'));
    expect(message).toMatch(/sign-in could not be completed/i);
    expect(message).toContain('fetch failed');
    // Not claimed as a credential failure and not claimed as a network one:
    // nothing established either.
    expect(message).not.toMatch(NOT_ACCEPTED);
    expect(message).not.toMatch(UNREACHABLE);
  });

  it('says something usable when the rejection is not an Error', () => {
    expect(signInFailureMessage('a string')).toMatch(/sign-in could not be completed\.?$/i);
    expect(signInFailureMessage(null)).toMatch(/sign-in could not be completed\.?$/i);
    expect(signInFailureMessage(undefined)).toMatch(/sign-in could not be completed\.?$/i);
  });
});

// ---------------------------------------------------------------------------
// edgeFailureMessage
// ---------------------------------------------------------------------------

/** A `FunctionsHttpError` carrying the body the real function would return. */
function httpError(status: number, body: unknown, broken = false): FunctionsHttpError {
  const response = {
    status,
    json: broken
      ? () => Promise.reject(new Error('not JSON'))
      : () => Promise.resolve(body),
  } as unknown as Response;
  return new FunctionsHttpError(response);
}

describe('edgeFailureMessage: every answer says whether the password changed', () => {
  // The invariant across the whole function. An operator who cannot tell
  // whether their password changed will either keep using the old one or lock
  // themselves out guessing, so no branch may be silent on it.

  it('a transport failure says the password was NOT changed', async () => {
    const response = { status: 0 } as unknown as Response;
    const message = await edgeFailureMessage(
      new FunctionsFetchError(response),
      'change-own-password',
    );

    expect(message).toMatch(/could not be sent/i);
    expect(message).toMatch(/NOT been changed/);
  });

  it('a refusal from our own function is shown verbatim', async () => {
    // The envelope every function in this project emits. The server's wording
    // carries the reason, so it is passed through rather than reworded.
    const message = await edgeFailureMessage(
      httpError(422, { error: { code: 'validation_failed', message: 'That password is too short.' } }),
      'change-own-password',
    );

    expect(message).toBe('That password is too short.');
  });

  it('a 404 with no envelope says the function is not deployed, and names it', async () => {
    // The platform answered, not our function. Reporting this as a refusal
    // would send somebody to change their password again forever.
    const message = await edgeFailureMessage(httpError(404, null), 'change-own-password');

    expect(message).toContain('change-own-password');
    expect(message).toMatch(/not deployed/i);
    expect(message).toMatch(/NOT been changed/);
  });

  it('another status with no envelope admits it has no reason to give', async () => {
    const message = await edgeFailureMessage(httpError(500, null), 'change-own-password');

    expect(message).toMatch(/gave no reason/i);
    expect(message).toMatch(/NOT been changed/);
  });

  it('a body that is not JSON is treated as having no envelope', async () => {
    // An HTML error page from a proxy. `json()` rejects, and the catch must not
    // turn that into a silent success or an unhandled rejection.
    const message = await edgeFailureMessage(httpError(502, null, true), 'change-own-password');

    expect(message).toMatch(/gave no reason/i);
  });

  it('a 404 whose body IS our envelope prefers the envelope', async () => {
    // Ordering again: the status branch must not pre-empt a real message from
    // our own function. A function that genuinely answers 404 for "no such
    // account" would otherwise be reported as undeployed.
    const message = await edgeFailureMessage(
      httpError(404, { error: { code: 'not_found', message: 'No such account.' } }),
      'change-own-password',
    );

    expect(message).toBe('No such account.');
    expect(message).not.toMatch(/not deployed/i);
  });

  it('an envelope with an empty message falls through rather than showing nothing', async () => {
    // A blank sentence is the one outcome worse than a generic one: the screen
    // would show a failure with no text at all.
    const message = await edgeFailureMessage(
      httpError(500, { error: { code: 'internal', message: '' } }),
      'change-own-password',
    );

    expect(message).toMatch(/gave no reason/i);
  });

  it('an envelope whose message is not a string is ignored', async () => {
    const message = await edgeFailureMessage(
      httpError(500, { error: { code: 'internal', message: { nested: 'object' } } }),
      'change-own-password',
    );

    expect(message).toMatch(/gave no reason/i);
    expect(message).not.toContain('nested');
  });

  it('a plain Error keeps its message and claims no cause', async () => {
    const message = await edgeFailureMessage(new Error('boom'), 'change-own-password');

    expect(message).toMatch(/could not be changed/i);
    expect(message).toContain('boom');
  });

  it('a non-Error rejection still produces a sentence', async () => {
    expect(await edgeFailureMessage('a string', 'change-own-password')).toMatch(
      /the password could not be changed\.?$/i,
    );
    expect(await edgeFailureMessage(null, 'change-own-password')).toMatch(
      /the password could not be changed\.?$/i,
    );
  });

  it('never claims the password WAS changed, on any branch', async () => {
    // The sweep. Enumerated over every input shape above rather than asserted
    // per case, because the dangerous string is the one no single branch was
    // written to produce.
    const inputs: readonly unknown[] = [
      new FunctionsFetchError({ status: 0 } as unknown as Response),
      httpError(404, null),
      httpError(500, null),
      httpError(502, null, true),
      httpError(500, { error: { code: 'internal', message: '' } }),
      new Error('boom'),
      'a string',
      null,
    ];

    for (const input of inputs) {
      const message = await edgeFailureMessage(input, 'change-own-password');
      expect(message, `for ${String(input)}`).not.toMatch(
        /your password (has been|was) changed|password is set/i,
      );
      expect(message.length, `for ${String(input)}`).toBeGreaterThan(10);
    }
  });
});
