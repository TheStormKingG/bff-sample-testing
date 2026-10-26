/**
 * THE PASSWORD POLICY, AND THE ONE THING THAT CAN SILENTLY BREAK IT.
 *
 * ===========================================================================
 * WHAT THIS SUITE IS FOR
 * ===========================================================================
 * `passwordIssues` gained strength rules: whitespace, variety, repeated runs
 * and straight sequences. Length and byte-ceiling boundaries are covered in
 * `tests/adminPasswordBoundary.test.ts`, which also owns the cross-boundary
 * comparison against the browser's own minimum. What lives HERE is the half of
 * the policy that no example-based test can reach.
 *
 * THIS FIELD HAS TWO WRITERS AND ONLY ONE OF THEM IS A PERSON. The second is
 * `generateTemporaryPassword()` in `src/hooks/useAdmin.ts`, which draws 12
 * characters from a 25-character alphabet of lowercase letters and the digits
 * 2–9 — no uppercase, no symbols — and joins them 4-4-4 with a `-`. So:
 *
 *   - the reflex rule, "one upper, one lower, one digit, one symbol", would
 *     refuse the system's OWN generated credential whenever a draw happened to
 *     contain no digit: (17/25)^12, about one account creation in 112; and
 *
 *   - every threshold in the policy is a claim about that generator's output
 *     distribution, which is RANDOM. A rule set that is wrong by one on any
 *     threshold passes every hand-written case and then refuses a measurable
 *     fraction of real account creations, at a rate low enough to be mistaken
 *     for a fluke by whoever hits it.
 *
 * That is not a failure mode a case can find, so the test below is a VOLUME
 * probe: the real generator, the real validator, many times, zero issues.
 *
 * WHAT THE PROBE'S SAMPLE CAN AND CANNOT SEE, stated rather than implied. The
 * thresholds were chosen from a 300,000-sample measurement in which the
 * generator's extremes were 6 distinct characters, a 4-character identical run
 * and a 4-character sequence run — so each threshold sits one measured decade
 * clear of the extreme it has to clear. The sample below is smaller, because it
 * runs on every push: it will catch any systematic incompatibility immediately
 * (a class rule, an off-by-one threshold, a changed alphabet) and it cannot see
 * a one-in-a-million tail. It does not claim to.
 */
import { describe, expect, it, vi } from 'vitest';

// `@/hooks/useAdmin` reaches `@/lib/supabase`, which validates the `VITE_*`
// allowlist at module load, so the two required variables are stubbed before
// the import. Nothing here constructs a client or touches the network.
vi.stubEnv('VITE_SUPABASE_URL', 'https://test.supabase.co');
vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'test-anon-key');

const {
  TEMPORARY_PASSWORD_ALPHABET,
  TEMPORARY_PASSWORD_LENGTH,
  TEMPORARY_PASSWORD_SEPARATOR,
  generateTemporaryPassword,
} = await import('@/hooks/useAdmin');

const {
  MAX_PASSWORD_IDENTICAL_RUN,
  MAX_PASSWORD_SEQUENCE_RUN,
  MIN_PASSWORD_DISTINCT_CHARACTERS,
  MIN_PASSWORD_LENGTH,
  passwordIssues,
} = await import('../supabase/functions/_shared/validation.ts');

const codes = (value: unknown): string[] =>
  passwordIssues('temporaryPassword', value).map((issue) => issue.code);

// ---------------------------------------------------------------------------
// THE POSITIVE CONTROL THAT MATTERS MOST.
// ---------------------------------------------------------------------------
describe('the policy accepts the credential the application itself generates', () => {
  const SAMPLE = 20_000;

  it(`refuses none of ${SAMPLE} real generated passwords`, () => {
    const refused: { password: string; codes: string[] }[] = [];
    for (let i = 0; i < SAMPLE; i++) {
      const password = generateTemporaryPassword();
      const found = codes(password);
      if (found.length > 0) refused.push({ password, codes: found });
      if (refused.length >= 3) break;
    }
    expect(
      refused,
      'the server policy refuses a password the admin screen generated. The ' +
        'administrator would see a validation error on a value the application ' +
        'produced for them, on a screen with no way to influence it. Either a ' +
        'threshold in _shared/validation.ts is one too tight, or the generator ' +
        'in src/hooks/useAdmin.ts narrowed. The thresholds were measured ' +
        'against this generator; re-measure before changing either side. ' +
        `Refused: ${JSON.stringify(refused)}`,
    ).toEqual([]);
  });

  it('is measuring the generator it thinks it is', () => {
    // INSTRUMENT CHECK. A generator that threw, or returned a constant, would
    // make the sweep above trivially green. Confirm it produces the shape the
    // thresholds were measured against — and if any of these change, the
    // measurement behind MIN_PASSWORD_DISTINCT_CHARACTERS no longer applies.
    const sample = generateTemporaryPassword();
    const groups = Math.ceil(TEMPORARY_PASSWORD_LENGTH / 4);
    expect(sample).toHaveLength(TEMPORARY_PASSWORD_LENGTH + groups - 1);
    expect(sample.split(TEMPORARY_PASSWORD_SEPARATOR).join('')).toHaveLength(
      TEMPORARY_PASSWORD_LENGTH,
    );
    expect(TEMPORARY_PASSWORD_ALPHABET).toHaveLength(25);
    // Two consecutive calls differ: a cached or constant generator would make
    // 20,000 draws one draw.
    expect(generateTemporaryPassword()).not.toBe(generateTemporaryPassword());

    // The generated password clears the length floor with room to spare, which
    // is why the floor is not what refuses a hand-typed short one here.
    expect(sample.length).toBeGreaterThan(MIN_PASSWORD_LENGTH);
  });

  it('would have refused generated passwords under a character-class rule', () => {
    // THE RULE NOT CHOSEN, demonstrated rather than asserted — so the reason
    // this policy counts variety instead of categories is checkable, and the
    // next person to reach for a class rule meets the evidence.
    let digitless = 0;
    for (let i = 0; i < 5_000; i++) {
      if (!/[0-9]/.test(generateTemporaryPassword())) digitless++;
    }
    // (17/25)^12 ≈ 0.0089, so ≈ 45 of 5,000. A floor of 1 is enough to make
    // the point without making the assertion itself flaky.
    expect(
      digitless,
      'no generated password lacked a digit in 5,000 draws, so the alphabet or ' +
        'the length has changed and the class-rule argument in ' +
        '_shared/validation.ts needs re-checking against the new generator',
    ).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Each rule, from BOTH sides of its boundary.
//
// An assertion that a value is refused proves nothing on its own: a validator
// that refused everything would satisfy every refusal below. So each rule is
// paired with the nearest value it must ACCEPT, which is the one a
// one-too-tight threshold breaks.
// ---------------------------------------------------------------------------
describe('variety: fewer distinct characters than the floor', () => {
  /** `n` distinct characters, padded to at least the length floor. */
  const withDistinct = (n: number): string => {
    const pool = 'acdefhjkmnprtuwxy23456789';
    const base = pool.slice(0, n);
    // Interleaved rather than repeated as a block, so this value trips neither
    // the identical-run rule nor the sequence rule and the distinct count is
    // the only thing under test. The pool's own order is alphabetical, so
    // `base` itself would be a sequence run at n >= 5 — hence the reversal
    // every other pass.
    let out = '';
    while (out.length < Math.max(MIN_PASSWORD_LENGTH, n)) {
      out += out.length % (n * 2) === 0 ? base : [...base].reverse().join('');
    }
    return out.slice(0, Math.max(MIN_PASSWORD_LENGTH, n * 2));
  };

  it('refuses one below the floor and accepts the floor itself', () => {
    const below = withDistinct(MIN_PASSWORD_DISTINCT_CHARACTERS - 1);
    const at = withDistinct(MIN_PASSWORD_DISTINCT_CHARACTERS);
    expect(new Set([...below]).size).toBe(MIN_PASSWORD_DISTINCT_CHARACTERS - 1);
    expect(new Set([...at]).size).toBe(MIN_PASSWORD_DISTINCT_CHARACTERS);
    expect(codes(below)).toEqual(['not_varied']);
    expect(codes(at)).toEqual([]);
  });

  it('refuses the degenerate cases the audit named', () => {
    // One character, ten times. Trips variety AND the identical-run rule, and
    // both codes are reported so the reply names every broken rule at once.
    expect(codes('x'.repeat(MIN_PASSWORD_LENGTH))).toEqual(['not_varied', 'repeated_run']);
    // Two characters alternating — 14 long, no run, still not a password.
    expect(codes('abababababab')).toEqual(['not_varied']);
  });

  it('accepts a long password built from few distinct WORDS but many characters', () => {
    // The rule counts characters, not words: a spoken passphrase is one of the
    // better credentials in a plant, and it must not be collateral damage.
    expect(codes('red tractor nine')).toEqual([]);
    expect(codes('mill floor shift two')).toEqual([]);
  });
});

describe('repeated runs: one character held down', () => {
  const held = (n: number): string => `va${'r'.repeat(n)}ied9k`;

  it('refuses one above the ceiling and accepts the ceiling itself', () => {
    const at = held(MAX_PASSWORD_IDENTICAL_RUN);
    const over = held(MAX_PASSWORD_IDENTICAL_RUN + 1);
    expect(at.length).toBeGreaterThanOrEqual(MIN_PASSWORD_LENGTH);
    expect(codes(at)).toEqual([]);
    expect(codes(over)).toEqual(['repeated_run']);
  });

  it('catches a long password whose variety comes from a short tail', () => {
    // The case the variety floor alone would miss: 5 distinct characters is
    // easy to reach in a long string, so the run rule has to carry it.
    //
    // The tail is `k9mp` and not `bcde`, which is what this assertion was
    // first written with: `a`×20 followed by `bcde` puts `abcde` at the
    // junction, so it tripped the SEQUENCE rule as well and the assertion was
    // no longer isolating the run rule it names. Every character pair below is
    // non-consecutive, and the five distinct characters clear the variety floor
    // exactly, so `repeated_run` is the only rule in play.
    const value = `${'a'.repeat(20)}k9mp`;
    expect(new Set([...value]).size).toBe(MIN_PASSWORD_DISTINCT_CHARACTERS);
    expect(codes(value)).toEqual(['repeated_run']);
  });
});

describe('sequences: a straight run of consecutive characters', () => {
  it('refuses the value the audit named', () => {
    // Ten distinct characters, no repeats — invisible to every other rule, and
    // the single most likely thing a hurried administrator types.
    expect(codes('1234567890')).toContain('sequential');
    expect(codes('abcdefghij')).toContain('sequential');
    expect(codes('0987654321')).toContain('sequential');
    // Case-insensitively, so the obvious evasion does not work.
    expect(codes('ABCDEFGHIJ')).toContain('sequential');
    expect(codes('varied-ABCDE-9k')).toEqual(['sequential']);
  });

  it('refuses one above the ceiling and accepts the ceiling itself', () => {
    // The run is DERIVED from the constant rather than written out, so raising
    // or lowering MAX_PASSWORD_SEQUENCE_RUN moves both sides of this boundary
    // together. A hardcoded 'abcd'/'abcde' pair would keep passing against a
    // changed rule and would be testing a number nothing else holds.
    const run = (length: number): string =>
      'abcdefghijklmnop'.slice(0, length);
    const at = `vk9-${run(MAX_PASSWORD_SEQUENCE_RUN)}-wx`;
    const over = `vk9-${run(MAX_PASSWORD_SEQUENCE_RUN + 1)}-wx`;
    expect(at.length).toBeGreaterThanOrEqual(MIN_PASSWORD_LENGTH);
    expect(over.length).toBeGreaterThanOrEqual(MIN_PASSWORD_LENGTH);
    expect(codes(at)).toEqual([]);
    expect(codes(over)).toEqual(['sequential']);
  });

  it('does not claim to catch a keyboard row, and does not', () => {
    // Stated so the gap is a decision on the record rather than a surprise.
    // `qwertyuiop` is not a code-point run; catching it needs a per-layout
    // table, and this plant uses more than one layout.
    expect(codes('qwertyuiop')).toEqual([]);
  });
});

describe('whitespace', () => {
  it('refuses a password made only of whitespace, by its own code', () => {
    expect(codes(' '.repeat(MIN_PASSWORD_LENGTH))).toContain('blank');
    expect(codes('\t'.repeat(MIN_PASSWORD_LENGTH))).toContain('blank');
    expect(codes(' \t \t \t \t \t')).toContain('blank');
  });

  it('refuses a leading or trailing space and accepts an interior one', () => {
    expect(codes(' varied-9k')).toEqual(['surrounding_whitespace']);
    expect(codes('varied-9k ')).toEqual(['surrounding_whitespace']);
    expect(codes('\tvaried-9k')).toEqual(['surrounding_whitespace']);
    expect(codes('varied-9k\n')).toEqual(['surrounding_whitespace']);
    expect(codes('varied 9k mill')).toEqual([]);
  });

  it('never alters the value it is judging', () => {
    // The principle the refusal preserves: `passwordIssues` returns issues, so
    // the credential this function approved is byte-identical to the one that
    // gets set. Guarded here because a future "helpful" trim would make the
    // approved value and the stored value two different strings, and the holder
    // would be refused by a password they typed exactly as dictated.
    const padded = ' varied-9k ';
    const copy = padded.slice();
    passwordIssues('newPassword', padded);
    expect(padded).toBe(copy);
  });
});

// ---------------------------------------------------------------------------
// Properties that hold across every rule.
// ---------------------------------------------------------------------------
describe('the policy as a whole', () => {
  it('quotes no part of the password in any message', () => {
    // The issues travel to the browser in `ApiError.details` and into the
    // server log through `toLogRecord`. A message naming the offending
    // character, its position or the length would put a function of the
    // credential into both — which is the same class of defect as hashing it
    // into the idempotency registry, one layer over.
    const secret = 'Zq7!tt tt@#Xv';
    for (const issue of passwordIssues('newPassword', secret)) {
      for (const character of new Set([...secret])) {
        if (/[a-z ]/.test(character)) continue; // ordinary prose letters
        expect(
          issue.message,
          `the message for '${issue.code}' quotes '${character}' from the password`,
        ).not.toContain(character);
      }
      expect(issue.message).not.toContain(String(secret.length));
    }
  });

  it('reports every broken rule at once, not the first', () => {
    // An administrator fixing a temporary password is told the whole rule in
    // one reply; otherwise they submit a credential four times and are refused
    // for a different reason each time.
    //
    // The value is `' aaaaa '` and not the `' 1234 '` this was first written
    // with: `' 1234 '` has five distinct characters counting the spaces, so it
    // clears the variety floor and reports only two codes. A test value chosen
    // to look bad is not the same as one run through the rules.
    const awful = ' aaaaa ';
    const found = codes(awful);
    expect(found).toContain('too_short');
    expect(found).toContain('surrounding_whitespace');
    expect(found).toContain('not_varied');
    expect(found).toContain('repeated_run');
    expect(found.length).toBeGreaterThanOrEqual(4);
  });

  it('names the field it was given, so the right input is marked', () => {
    expect(passwordIssues('temporaryPassword', 'short')[0]?.field).toBe('temporaryPassword');
    expect(passwordIssues('newPassword', 'short')[0]?.field).toBe('newPassword');
  });

  it('holds the administrator’s temporary password and the replacement to ONE rule', () => {
    // A rule enforced on only one of them lets the weak value in by the other
    // door. There is one function and both callers pass through it; what is
    // asserted here is that the FIELD NAME does not change the verdict, which
    // is the only way the single function could still behave as two rules.
    for (const value of ['1234567890', ' '.repeat(12), 'xxxxxxxxxx', 'varied-9k']) {
      expect(
        passwordIssues('temporaryPassword', value).map((i) => i.code),
        `'${value}' is judged differently depending on which field it arrived in`,
      ).toEqual(passwordIssues('newPassword', value).map((i) => i.code));
    }
  });
});
