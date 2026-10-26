/**
 * The forced-password-change predicate, and the one number it shares with the
 * administrator screen.
 *
 * ===========================================================================
 * WHY THIS SUITE EXISTS
 * ===========================================================================
 * `isPasswordChangeOutstanding` in `src/hooks/useProfile.ts` is a COPY of a
 * server rule: the authority is `public.must_change_password(uuid)` in
 * migration 0019, which the browser cannot call because it is granted to
 * `service_role` only. A copy of a rule in another language, kept in a
 * different file from the original, with no compiler and no foreign key
 * between them, is exactly the shape this project's three previous outages
 * took. So the two properties that cannot be allowed to drift are asserted
 * here in words rather than left in a comment:
 *
 *   1. the `<=` boundary, where a tie means STILL OUTSTANDING; and
 *   2. the direction it fails in when the data is unreadable.
 *
 * Property 2 is the one a reasonable author leaves out. Answering `false` when
 * the server answers `true` does not produce a visible error — it produces an
 * app that offers every screen and is refused on every request, with the one
 * screen that could fix it unreachable. That failure is silent in the UI and
 * total in effect, so the safe direction is asserted, not assumed.
 *
 * This file does NOT re-implement the SQL to compare the two. A probe that
 * re-expresses the function under test in another language only validates the
 * author's model of it. The SQL side is asserted by
 * `scripts/verify-0019-admin-managed-passwords.sh` against a real database;
 * what is asserted here is that the TypeScript side states the same boundary.
 */

import { describe, expect, it, vi } from 'vitest';

/**
 * `src/lib/env.ts` validates the Vite environment AT MODULE LOAD and throws a
 * readable error when it is absent, which is correct behaviour for a
 * deployment and fatal for a test runner with no `.env`. Only the
 * configuration is faked; the real `@/lib/supabase` is then imported, so
 * `MIN_PASSWORD_LENGTH` below is the value the application actually ships. A
 * stub of that module would make the invariant at the bottom of this file
 * assert a number this suite had invented.
 */
vi.mock('@/lib/env', () => ({
  env: {
    VITE_SUPABASE_URL: 'https://example.supabase.co',
    VITE_SUPABASE_ANON_KEY: 'test-anon-key',
    VITE_APP_VERSION: 'test',
    VITE_BASE_PATH: '/',
  },
  basePath: '/',
  readEnv: () => ({
    VITE_SUPABASE_URL: 'https://example.supabase.co',
    VITE_SUPABASE_ANON_KEY: 'test-anon-key',
    VITE_APP_VERSION: 'test',
    VITE_BASE_PATH: '/',
  }),
}));

const { isPasswordChangeOutstanding } = await import('@/hooks/useProfile');

const EARLIER = '2026-10-26T08:00:00.000000+00:00';
const LATER = '2026-10-26T09:00:00.000000+00:00';

describe('isPasswordChangeOutstanding', () => {
  it('is false when no administrator has ever set this account a password', () => {
    // The honest reading of NULL: this never happened. Every Google account
    // that existed before migration 0019 looks like this, and none of them
    // may be locked out by the new gate.
    expect(isPasswordChangeOutstanding(null, null)).toBe(false);
    expect(isPasswordChangeOutstanding(null, LATER)).toBe(false);
  });

  it('is true when an administrator set a password and the holder never changed one', () => {
    expect(isPasswordChangeOutstanding(EARLIER, null)).toBe(true);
  });

  it('is false once the holder has changed it since', () => {
    expect(isPasswordChangeOutstanding(EARLIER, LATER)).toBe(false);
  });

  it('is true when the last change was BEFORE the administrator reset it', () => {
    // The reset case. Somebody who chose their own password months ago and
    // then had it reset owes a new one; reading the mere presence of
    // `password_changed_at` as "done" would clear every reset silently.
    expect(isPasswordChangeOutstanding(LATER, EARLIER)).toBe(true);
  });

  it('is true on a tie, matching the SQL `<=` and not `<`', () => {
    // Same instant to the microsecond. With `<=` a tie costs one extra
    // screen; with `<` a tie silently clears a reset that never happened.
    // The SQL chose `<=`, so this must too.
    expect(isPasswordChangeOutstanding(LATER, LATER)).toBe(true);
  });

  it('compares instants, not strings', () => {
    // Both are the same moment. Lexically the second is the SMALLER string,
    // so a `<=` on the raw text would call this outstanding. PostgREST
    // renders `timestamptz` with a variable fractional part and a real
    // offset, so this is the normal case and not a contrived one.
    const utc = '2026-10-26T12:00:00.000000+00:00';
    const sameMomentOffset = '2026-10-26T08:00:00-04:00';
    expect(sameMomentOffset < utc).toBe(true); // the trap, stated out loud
    expect(isPasswordChangeOutstanding(utc, sameMomentOffset)).toBe(true); // tie → outstanding

    const oneSecondLater = '2026-10-26T08:00:01-04:00';
    expect(oneSecondLater < utc).toBe(true); // still lexically smaller
    expect(isPasswordChangeOutstanding(utc, oneSecondLater)).toBe(false); // but later in time
  });

  it('fails toward "outstanding" when a timestamp cannot be read', () => {
    // The direction matters more than the case. Answering `false` here would
    // produce an account that is offered everything and refused everywhere,
    // with no route to the remedy.
    expect(isPasswordChangeOutstanding(EARLIER, 'not a timestamp')).toBe(true);
    expect(isPasswordChangeOutstanding('not a timestamp', LATER)).toBe(true);
    expect(isPasswordChangeOutstanding('', '')).toBe(true);
  });
});

describe('the two client-side copies of the contract rule agree', () => {
  it('answers identically to the administrator slice on every boundary case', async () => {
    /**
     * THE RULE IS IMPLEMENTED TWICE IN THE BROWSER, IN TWO FILES OWNED BY TWO
     * DIFFERENT PEOPLE.
     *
     * `isPasswordChangeOutstanding` (src/hooks/useProfile.ts) decides where
     * the router sends the holder. `hasOutstandingPasswordChange`
     * (src/hooks/useAdmin.ts) decides what the administrator's user list says
     * about that same account. They were written independently against the
     * contract's one RULE, they are not derived from each other, and nothing
     * in the toolchain relates them — which is the exact shape of the three
     * outages this project's contract preamble warns about.
     *
     * The dangerous divergence is not "both wrong" but "one wrong": an
     * administrator looking at a list that says an account owes no change,
     * while that account is held at the password screen, would conclude the
     * app is broken and go looking in the wrong place. So the agreement is
     * asserted rather than left to two identical-looking bodies staying
     * identical.
     *
     * This is not a re-implementation used to check itself — both sides are
     * shipped production code, and the assertion fails the moment either
     * moves. The SQL authority is proved separately, against a real database,
     * by scripts/verify-0019-admin-managed-passwords.sh.
     */
    const { hasOutstandingPasswordChange } = await import('@/hooks/useAdmin');

    const instants = [null, EARLIER, LATER, '2026-10-26T04:00:00-04:00', 'rubbish', ''];
    let compared = 0;

    for (const setAt of instants) {
      for (const changedAt of instants) {
        expect(
          isPasswordChangeOutstanding(setAt, changedAt),
          `set=${String(setAt)} changed=${String(changedAt)}`,
        ).toBe(
          hasOutstandingPasswordChange({
            password_set_by_admin_at: setAt,
            password_changed_at: changedAt,
          }),
        );
        compared += 1;
      }
    }

    // A loop that silently ran zero times would report agreement it never
    // measured.
    expect(compared).toBe(instants.length * instants.length);
  });
});

describe('the password length rules the surfaces share', () => {
  it('states the same byte ceiling as the Edge Functions do', async () => {
    /**
     * The client and the server each declare this number, because the Edge
     * module is Deno code that cannot be imported into a browser bundle. The
     * ceiling is not a preference: bcrypt discards everything past the 72nd
     * byte, so a client ceiling ABOVE the server's would let the screen accept
     * a password the server refuses, and a client ceiling that is simply
     * absent — which is what this screen shipped first — lets an operator type
     * a long passphrase and meet the real rule only on submit.
     *
     * The MINIMUM is deliberately not re-asserted here:
     * `tests/adminPasswordBoundary.test.ts` already compares the two, and a
     * second assertion of the same pair would make a later change look
     * doubly-guarded while adding nothing.
     */
    const client = await import('@/lib/supabase');
    const server = await import('../supabase/functions/_shared/validation.ts');

    expect(client.MAX_PASSWORD_BYTES).toBe(server.MAX_PASSWORD_BYTES);
    // And the two counters agree on what a byte is, for input the limit is
    // actually about: a character count would pass this with Latin text and
    // disagree the moment somebody uses a non-Latin script.
    for (const sample of ['abcdefghij', 'passwörd-ü', '🔐🔐🔐🔐', 'пароль-123']) {
      expect(client.passwordByteLength(sample)).toBe(server.passwordByteLength(sample));
    }
  });

  it('never lets the administrator generate a password shorter than the floor', async () => {
    // CROSS-FILE INVARIANT, asserted because nothing else compares these two.
    // `MIN_PASSWORD_LENGTH` (src/lib/supabase.ts) is the shortest password the
    // change-password screen will submit, and it is stated to the operator
    // BEFORE they type. `TEMPORARY_PASSWORD_LENGTH` (src/hooks/useAdmin.ts) is
    // the length of the password an administrator hands over. If the generated
    // one were shorter than the stated floor, the system would be issuing
    // credentials it tells people are too short — and the two numbers live in
    // two files owned by two different people, with no compiler relating them.
    const { MIN_PASSWORD_LENGTH } = await import('@/lib/supabase');
    const { TEMPORARY_PASSWORD_LENGTH } = await import('@/hooks/useAdmin');

    expect(MIN_PASSWORD_LENGTH).toBeGreaterThan(0);
    expect(TEMPORARY_PASSWORD_LENGTH).toBeGreaterThanOrEqual(MIN_PASSWORD_LENGTH);
  });
});
