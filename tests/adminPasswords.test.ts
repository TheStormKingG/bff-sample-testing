/**
 * Administrator-managed passwords: the generator, the read-aloud spelling, the
 * forced-change rule and the wire names.
 *
 * ===========================================================================
 * WHAT THIS SUITE IS FOR
 * ===========================================================================
 * Four claims the admin screen makes that nothing else in the project can
 * check, each one a claim whose failure is silent:
 *
 *  1. THE GENERATOR IS A CSPRNG AND IS UNBIASED. A password drawn from
 *     `Math.random`, or mapped with `byte % 25`, still looks like a password.
 *     There is no output you can inspect to tell the difference, so the only
 *     place the difference is visible is here: `Math.random` is asserted never
 *     to be called, and the rejection of out-of-range bytes is asserted with a
 *     byte whose biased mapping differs from its rejected one.
 *
 *  2. THE ALPHABET EXCLUDES WHAT IT CLAIMS TO EXCLUDE. The exclusions exist
 *     because the password is read down a telephone. Every expectation below
 *     is derived from `TEMPORARY_PASSWORD_EXCLUSIONS` in the module, never
 *     from a second list written here — a hard-coded copy would pass while the
 *     alphabet drifted, which is the defect the table exists to prevent.
 *
 *  3. THE FORCED-CHANGE RULE MATCHES THE DATABASE'S. `must_change_password`
 *     in migration 0019 is `service_role` only, so the browser cannot ask it
 *     and the screen computes the same rule from two readable columns. Two
 *     implementations of one rule is exactly the arrangement that drifts, so
 *     the `<=` tie, the never-changed case and two equal instants written at
 *     different UTC offsets are all pinned.
 *
 *  4. THE WIRE NAMES ARE THE CONTRACT'S. `email`, `displayName`,
 *     `temporaryPassword`, `userId`, `reason`, `create_account`,
 *     `set_password` are strings this file sends and a Deno function parses.
 *     TypeScript cannot compare the two sides and neither can the linter, so
 *     the full key set of each request body is frozen here. This is the
 *     cheapest half of that comparison and not the whole of it: it pins what
 *     the browser SENDS, and a matching test over what the function READS has
 *     to live with the function.
 *
 * `@/hooks/useAdmin` reaches `@/lib/supabase`, which validates the `VITE_*`
 * allowlist at module load, so the two required variables are stubbed before
 * the import. No client is constructed against them and nothing here touches
 * the network: every export under test is a pure function.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.stubEnv('VITE_SUPABASE_URL', 'https://test.supabase.co');
vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'test-anon-key');

const {
  TEMPORARY_PASSWORD_ALPHABET,
  TEMPORARY_PASSWORD_EXCLUSIONS,
  TEMPORARY_PASSWORD_GROUP,
  TEMPORARY_PASSWORD_LENGTH,
  TEMPORARY_PASSWORD_SEPARATOR,
  adminActionBody,
  carriesCredential,
  generateTemporaryPassword,
  hasOutstandingPasswordChange,
  spellTemporaryPassword,
} = await import('@/hooks/useAdmin');

afterEach(() => {
  vi.restoreAllMocks();
});

/** The real generator, held unbound so identity against it is meaningful. */
const REAL_GET_RANDOM_VALUES = globalThis.crypto.getRandomValues;

/**
 * Feed `generateTemporaryPassword` a scripted byte stream.
 *
 * Each element is one block returned by one call. Running out is an error
 * rather than a wrap-around: a generator that asked for more blocks than the
 * script allows for has changed its sampling behaviour, and silently recycling
 * bytes would hide that.
 */
function scriptBytes(blocks: readonly number[][]): void {
  let call = 0;
  vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(((
    target: Uint8Array,
  ): Uint8Array => {
    const block = blocks[call];
    call += 1;
    if (block === undefined) {
      throw new Error(`The generator asked for block ${call}; only ${blocks.length} scripted.`);
    }
    for (let at = 0; at < target.length; at += 1) target[at] = block[at] ?? 0;
    return target;
  }) as typeof globalThis.crypto.getRandomValues);
}

describe('generateTemporaryPassword: where the randomness comes from', () => {
  it('draws from crypto.getRandomValues and never from Math.random', () => {
    const insecure = vi.spyOn(Math, 'random');
    const secure = vi.spyOn(globalThis.crypto, 'getRandomValues');

    generateTemporaryPassword();

    expect(secure).toHaveBeenCalled();
    // The whole security argument for the feature. Math.random is specified
    // nowhere as unpredictable, so a password drawn from it is one somebody
    // else can draw again — and the output of the two is indistinguishable.
    expect(insecure).not.toHaveBeenCalled();
  });

  it('refuses, rather than falling back, when no secure generator exists', () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true });
    try {
      expect(() => generateTemporaryPassword()).toThrow(/secure random/i);
    } finally {
      if (original === undefined) delete (globalThis as { crypto?: unknown }).crypto;
      else Object.defineProperty(globalThis, 'crypto', original);
    }
    // And the real one is back, so a later test in this file is not silently
    // running against a broken global and passing for the wrong reason.
    expect(globalThis.crypto.getRandomValues).toBe(REAL_GET_RANDOM_VALUES);
    expect(generateTemporaryPassword()).toHaveLength(
      TEMPORARY_PASSWORD_LENGTH +
        Math.ceil(TEMPORARY_PASSWORD_LENGTH / TEMPORARY_PASSWORD_GROUP) -
        1,
    );
  });

  it('rejects out-of-range bytes instead of taking them modulo the alphabet', () => {
    const size = TEMPORARY_PASSWORD_LENGTH;
    // 251 is above the 250 cut-off (25 × 10), and 251 % 25 === 1. So a
    // rejecting implementation discards the whole first block and spells the
    // password from the second; a `byte % 25` one spells it entirely from the
    // SECOND character of the alphabet. The two outputs cannot be confused,
    // which is the only reason this byte was chosen.
    scriptBytes([new Array<number>(size).fill(251), new Array<number>(size).fill(0)]);

    const password = generateTemporaryPassword();

    const first = TEMPORARY_PASSWORD_ALPHABET[0]!;
    const second = TEMPORARY_PASSWORD_ALPHABET[1]!;
    expect(password.split(TEMPORARY_PASSWORD_SEPARATOR).join('')).toBe(first.repeat(size));
    expect(password).not.toContain(second);
  });

  it('maps every in-range byte onto the alphabet it claims to use', () => {
    // 0..24 land on the alphabet in order; the 25th byte wraps to the first
    // character again, which is the behaviour that makes the cut-off at 250
    // (and not at 256) the thing that removes the bias.
    const block = Array.from({ length: TEMPORARY_PASSWORD_LENGTH }, (_unused, index) => index);
    scriptBytes([block]);

    const password = generateTemporaryPassword();

    expect(password.split(TEMPORARY_PASSWORD_SEPARATOR).join('')).toBe(
      TEMPORARY_PASSWORD_ALPHABET.slice(0, TEMPORARY_PASSWORD_LENGTH),
    );
  });
});

describe('generateTemporaryPassword: what the password looks like', () => {
  const samples = Array.from({ length: 400 }, () => generateTemporaryPassword());

  it('is the stated number of random characters, grouped for reading aloud', () => {
    const groups = Math.ceil(TEMPORARY_PASSWORD_LENGTH / TEMPORARY_PASSWORD_GROUP);
    for (const password of samples) {
      const parts = password.split(TEMPORARY_PASSWORD_SEPARATOR);
      expect(parts).toHaveLength(groups);
      expect(parts.join('')).toHaveLength(TEMPORARY_PASSWORD_LENGTH);
      for (const part of parts) expect(part.length).toBeLessThanOrEqual(TEMPORARY_PASSWORD_GROUP);
    }
  });

  it('contains nothing but the alphabet and the grouping separator', () => {
    const permitted = new Set([...TEMPORARY_PASSWORD_ALPHABET, TEMPORARY_PASSWORD_SEPARATOR]);
    for (const password of samples) {
      for (const character of password) expect(permitted).toContain(character);
    }
  });

  it('contains no character the module lists as confusable', () => {
    // Derived from the module's own table, so the two cannot disagree.
    const excluded = Object.keys(TEMPORARY_PASSWORD_EXCLUSIONS);
    expect(excluded.length).toBeGreaterThan(0);
    for (const character of excluded) {
      expect(TEMPORARY_PASSWORD_ALPHABET).not.toContain(character);
      for (const password of samples) expect(password).not.toContain(character);
    }
  });

  it('has no uppercase letter at all, so "capital" never has to be said', () => {
    for (const password of samples) expect(password).toBe(password.toLowerCase());
  });

  it('accounts for every lowercase letter and digit as either kept or excluded', () => {
    // A character that is in neither list is a character nobody decided
    // about. This is the test that would have caught the alphabet being
    // trimmed without the table being updated.
    const keyboard = [...'abcdefghijklmnopqrstuvwxyz0123456789'];
    const kept = new Set(TEMPORARY_PASSWORD_ALPHABET);
    const excluded = new Set(Object.keys(TEMPORARY_PASSWORD_EXCLUSIONS));
    const undecided = keyboard.filter((c) => !kept.has(c) && !excluded.has(c));
    expect(undecided).toEqual([]);
    const both = keyboard.filter((c) => kept.has(c) && excluded.has(c));
    expect(both).toEqual([]);
  });

  it('does not repeat itself', () => {
    // Not a randomness test — a wiring test. A generator that returned a
    // constant, or re-used one block, would pass every assertion above.
    expect(new Set(samples).size).toBe(samples.length);
  });
});

describe('spellTemporaryPassword', () => {
  it('has a spoken word for every character a generated password can contain', () => {
    // The spoken table is hand-written, so the risk is a character the
    // generator can produce and the readout cannot name. The fallback quotes
    // the character, which is exactly what must never appear for these.
    for (const character of [
      ...TEMPORARY_PASSWORD_ALPHABET,
      TEMPORARY_PASSWORD_SEPARATOR,
    ]) {
      const spoken = spellTemporaryPassword(character);
      expect(spoken).not.toBe(`"${character}"`);
      expect(spoken).toMatch(/^[a-z-]+$/);
    }
  });

  it('names the separator rather than leaving a silent gap', () => {
    expect(spellTemporaryPassword(TEMPORARY_PASSWORD_SEPARATOR)).toBe('dash');
  });

  it('spells a whole password in order, one word per character', () => {
    expect(spellTemporaryPassword('a3-k')).toBe('alfa, three, dash, kilo');
  });

  it('quotes a character it cannot name instead of dropping it', () => {
    // Only a hand-typed password can reach this. A readout that silently
    // omitted a character would fail at the keyboard with no clue why.
    expect(spellTemporaryPassword('a!')).toBe('alfa, "!"');
  });
});

describe('hasOutstandingPasswordChange: the contract rule', () => {
  const admin = '2026-10-20T12:00:00.000+00:00';

  it('is false when no administrator has ever set a password', () => {
    expect(
      hasOutstandingPasswordChange({
        password_set_by_admin_at: null,
        password_changed_at: null,
      }),
    ).toBe(false);
    // Even with a self-chosen password on record: nothing is outstanding
    // because nothing was imposed. This is every Google account in the system.
    expect(
      hasOutstandingPasswordChange({
        password_set_by_admin_at: null,
        password_changed_at: '2026-10-21T12:00:00.000+00:00',
      }),
    ).toBe(false);
  });

  it('is true when the holder has never chosen their own', () => {
    expect(
      hasOutstandingPasswordChange({
        password_set_by_admin_at: admin,
        password_changed_at: null,
      }),
    ).toBe(true);
  });

  it('is true when the holder last chose one BEFORE the reset', () => {
    expect(
      hasOutstandingPasswordChange({
        password_set_by_admin_at: admin,
        password_changed_at: '2026-10-19T12:00:00.000+00:00',
      }),
    ).toBe(true);
  });

  it('is true on an exact tie, which is the <= in the contract', () => {
    // The asymmetry migration 0019 states: a tie costs one extra screen,
    // while a strict < would silently clear a reset that never happened.
    expect(
      hasOutstandingPasswordChange({
        password_set_by_admin_at: admin,
        password_changed_at: admin,
      }),
    ).toBe(true);
  });

  it('is false once the holder has chosen one AFTER the reset', () => {
    expect(
      hasOutstandingPasswordChange({
        password_set_by_admin_at: admin,
        password_changed_at: '2026-10-20T12:00:00.001+00:00',
      }),
    ).toBe(false);
  });

  it('compares instants, not strings', () => {
    // The same moment, written in Guyana's offset and in UTC. As strings
    // '2026-10-20T08:00:00-04:00' sorts BEFORE the UTC form and a string
    // comparison would report the change outstanding; as instants they tie,
    // which the rule above resolves to outstanding for its own reason. The
    // discriminating pair is the one below: a plant-local instant one second
    // LATER than the reset, which sorts earlier as text.
    expect(
      hasOutstandingPasswordChange({
        password_set_by_admin_at: admin,
        password_changed_at: '2026-10-20T08:00:01-04:00',
      }),
    ).toBe(false);
  });

  it('treats an unreadable instant as outstanding, not as cleared', () => {
    // The safe direction: claiming a completed change that never happened
    // would tell an auditor an administrator no longer knows a live password.
    expect(
      hasOutstandingPasswordChange({
        password_set_by_admin_at: admin,
        password_changed_at: 'not a timestamp',
      }),
    ).toBe(true);
    expect(
      hasOutstandingPasswordChange({
        password_set_by_admin_at: 'not a timestamp',
        password_changed_at: '2026-10-21T12:00:00.000+00:00',
      }),
    ).toBe(true);
  });
});

describe('carriesCredential', () => {
  it('names exactly the two actions that send a password', () => {
    expect(carriesCredential('create_account')).toBe(true);
    expect(carriesCredential('set_password')).toBe(true);
    for (const action of [
      'approve_access',
      'deny_access',
      'set_status',
      'set_roles',
      'create_delegation',
      'revoke_delegation',
      'upsert_controlled_value',
    ] as const) {
      expect(carriesCredential(action)).toBe(false);
    }
  });
});

describe('adminActionBody: the names on the wire', () => {
  const KEY = 'bff-test-idempotency-key-0001';

  it('sends create_account with exactly the contract payload', () => {
    // THE CREDENTIAL IS A THIRD ARGUMENT, NOT A FIELD OF THE INPUT. The input
    // becomes `mutation.state.variables`, which the MutationCache retains for
    // `gcTime`; the body is built from this argument instead so the plaintext
    // never enters that object. The asserted key set is unchanged — the wire
    // contract did not move, only the route the value takes to reach it.
    const body = adminActionBody(
      {
        action: 'create_account',
        email: 'operator@example.test',
        displayName: 'A Operator',
        reason: 'Authorised by the plant manager; identity confirmed in person.',
      },
      KEY,
      'acdf-h3k9-mn7r',
    );

    // The whole key set, frozen. An extra key is a field the function will
    // not read; a missing one is a field it will refuse the request for.
    expect(Object.keys(body).sort()).toEqual(
      ['action', 'displayName', 'email', 'idempotencyKey', 'reason', 'temporaryPassword'].sort(),
    );
    expect(body['action']).toBe('create_account');
    expect(body['email']).toBe('operator@example.test');
    expect(body['displayName']).toBe('A Operator');
    expect(body['temporaryPassword']).toBe('acdf-h3k9-mn7r');
    expect(body['idempotencyKey']).toBe(KEY);
  });

  it('sends set_password with exactly the contract payload', () => {
    const body = adminActionBody(
      {
        action: 'set_password',
        userId: '11111111-2222-3333-4444-555555555555',
        reason: 'Forgotten password; identity confirmed by the shift supervisor.',
      },
      KEY,
      'acdf-h3k9-mn7r',
    );

    expect(Object.keys(body).sort()).toEqual(
      ['action', 'idempotencyKey', 'reason', 'temporaryPassword', 'userId'].sort(),
    );
    expect(body['userId']).toBe('11111111-2222-3333-4444-555555555555');
    // No email and no displayName: `set_password` acts on an account that
    // already has both, and sending them would invite the function to change
    // them as a side effect of a password reset.
    expect(body['email']).toBeUndefined();
    expect(body['displayName']).toBeUndefined();
  });

  it('omits the credential when none is handed to it, rather than inventing one', () => {
    // The replacement for the claim the two tests above used to make
    // implicitly — that the password arrives through the input. It cannot any
    // more, and this is what holds that closed: an extra `temporaryPassword`
    // property on the input object is ignored, so a later edit that puts the
    // credential back into the mutation variables does not silently work.
    const body = adminActionBody(
      {
        action: 'set_password',
        userId: '11111111-2222-3333-4444-555555555555',
        reason: 'Forgotten password; identity confirmed by the shift supervisor.',
        // @ts-expect-error -- the field no longer exists on AdminActionInput,
        // and the type error IS the assertion. The runtime check below is the
        // second half: a `tsc` that stopped running would not catch it.
        temporaryPassword: 'smuggled-in-the-input',
      },
      KEY,
    );

    expect('temporaryPassword' in body).toBe(false);
    expect(JSON.stringify(body)).not.toContain('smuggled-in-the-input');
  });

  it('carries the idempotency key on every action', () => {
    // `runMutation` refuses any request without one before it does anything
    // else, so an action that omits it is an action that cannot happen. Seven
    // of them omitted it until this body builder existed.
    for (const action of [
      'approve_access',
      'deny_access',
      'set_status',
      'set_roles',
      'create_delegation',
      'revoke_delegation',
      'upsert_controlled_value',
      'create_account',
      'set_password',
    ] as const) {
      const body = adminActionBody({ action, reason: 'because' }, KEY);
      expect(body['idempotencyKey']).toBe(KEY);
      expect(body['action']).toBe(action);
      expect(body['reason']).toBe('because');
    }
  });

  it('never invents a password for an action that does not carry one', () => {
    const body = adminActionBody(
      { action: 'set_roles', userId: 'u1', roles: ['quality_officer'], reason: 'r' },
      KEY,
    );
    expect('temporaryPassword' in body).toBe(false);
  });

  it('keeps an absent roles list different from an empty one', () => {
    // The server reads absent as "leave the roles alone" and empty as "hold
    // none". Collapsing them would tell an administrator who stripped every
    // role that it worked.
    const absent = adminActionBody({ action: 'set_status', userId: 'u1', reason: 'r' }, KEY);
    expect('roles' in absent).toBe(false);

    const empty = adminActionBody(
      { action: 'set_roles', userId: 'u1', roles: [], reason: 'r' },
      KEY,
    );
    expect(empty['roles']).toEqual([]);
  });

  it('keeps a false `active` rather than dropping it as absent', () => {
    // Retiring a controlled value is `active: false`; absent means "leave it
    // as it is", so a falsy-check here would silently reactivate the entry.
    const body = adminActionBody(
      { action: 'upsert_controlled_value', listKey: 'materials', value: 'maize', active: false, reason: 'r' },
      KEY,
    );
    expect(body['active']).toBe(false);
  });

  it('keeps an explicit null effectiveTo, which means "no end date"', () => {
    const body = adminActionBody(
      {
        action: 'create_delegation',
        userId: 'u1',
        permission: 'disposition.override_release',
        effectiveFrom: '2026-10-26',
        effectiveTo: null,
        reason: 'r',
      },
      KEY,
    );
    expect(body['effectiveTo']).toBeNull();
    expect('effectiveTo' in body).toBe(true);
  });

  it('copies the roles array rather than sharing the caller’s', () => {
    const roles: ('quality_officer' | 'operator')[] = ['operator'];
    const body = adminActionBody({ action: 'set_roles', userId: 'u1', roles, reason: 'r' }, KEY);
    roles.push('quality_officer');
    expect(body['roles']).toEqual(['operator']);
  });
});

describe('the credential does not reach a persistent sink', () => {
  /**
   * A SOURCE-LEVEL CHECK, AND ITS LIMITS ARE THE POINT.
   *
   * This proves one narrow thing: neither file that handles a plaintext
   * temporary password contains a call to a browser storage API or a logger.
   * Those are the two sinks a reviewer would reach for and the two a later
   * edit is most likely to add casually — a `console.log(input)` while
   * debugging, a draft saved to `localStorage` for convenience — and both
   * would turn a session-scoped credential into a stored one.
   *
   * It does NOT prove the credential is nowhere. The sinks it cannot see are
   * named in the module and page comments and were each checked by reading the
   * layer: the mutation cache (scrubbed by `reset()` once the action settles),
   * the server's request registry (stores a SHA-256 digest of the payload, not
   * the payload), the Edge Function's reply (stored verbatim for replay, so
   * the function must not echo the password back), the audit trail (receives
   * the instant of the reset and the reason, not the credential), and the
   * device clipboard (left behind by the Copy button, which says so on
   * screen). A green result here certifies the two sinks it looked at.
   */
  const OWNED = ['../src/hooks/useAdmin.ts', '../src/pages/AdminPage.tsx'] as const;

  function source(relative: string): string {
    return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
  }

  /**
   * The same text with comments removed.
   *
   * Both files DISCUSS these sinks at length in prose — the whole handling
   * rule is written down next to the code — so a check over the raw text
   * matches its own documentation and reports a leak that is a sentence. The
   * check has to run over code.
   *
   * The stripper is crude: it cannot tell `//` inside a string from the start
   * of a comment. That assumption is asserted rather than assumed, in the test
   * below, because a stripper that silently ate half a file would make every
   * assertion here pass.
   */
  function code(relative: string): string {
    return source(relative)
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/\/\/[^\n]*/g, ' ');
  }

  it('reads the files it is checking, and the comment stripper leaves code behind', () => {
    for (const file of OWNED) {
      const whole = source(file);
      const stripped = code(file);
      expect(whole.length).toBeGreaterThan(2000);
      // Nothing in either file can be mistaken for a comment opener by the
      // crude stripper above. If a URL or a regex literal is ever added, this
      // fails first and says why, instead of the sink checks quietly passing.
      expect(whole).not.toContain('://');
      // Enough survives to be worth searching, and the identifiers the checks
      // below hunt for would still be present if they existed.
      expect(stripped).toContain('generateTemporaryPassword');
      expect(stripped.length).toBeGreaterThan(whole.length / 5);
    }
  });

  it('calls no browser storage API', () => {
    for (const file of OWNED) {
      const text = code(file);
      expect(text).not.toMatch(/\blocalStorage\b/);
      expect(text).not.toMatch(/\bsessionStorage\b/);
      expect(text).not.toMatch(/\bindexedDB\b/);
      expect(text).not.toMatch(/document\s*\.\s*cookie/);
    }
  });

  it('logs nothing', () => {
    for (const file of OWNED) {
      expect(code(file)).not.toMatch(/\bconsole\b/);
    }
  });

  it('still contains the scrub that drops the mutation’s retained variables', () => {
    // `useMutation` keeps the variables it was called with until reset, so
    // deleting this one call silently re-introduces the exposure with no test
    // failure and no visible change on screen.
    expect(code('../src/pages/AdminPage.tsx')).toMatch(/action\s*\.\s*reset\(\)/);
  });
});
