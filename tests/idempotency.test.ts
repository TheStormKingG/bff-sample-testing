/**
 * The request registry: same key + same payload replays, same key + different
 * payload is refused.
 *
 * PRD §10.3 and Master Prompt §10. The decision is a pure function of the
 * stored record and the incoming request, so the whole matrix is testable
 * without a database — which is the only reason it can be exhaustive.
 *
 * Imports the pure `_shared` modules by relative path. The entrypoints are
 * deliberately absent: they call `Deno.serve` and `Deno.env`, neither of which
 * exists under vitest.
 *
 * Three separate guarantees are covered, and they are not the same guarantee:
 *
 *   REQUEST level  one operator pressing Save twice produces one record
 *                  (`decideIdempotency`).
 *   PAYLOAD level  "the same payload" is decided by a canonical hash, so key
 *                  order and formatting cannot make two identical requests
 *                  look different, and a changed VALUE cannot look the same
 *                  (`canonicalise`, `payloadHash`).
 *   PROJECTION     the same committed event delivered twice to the sheet
 *     level        writes one row, not two (`decideProjection`).
 */

import { describe, expect, it } from 'vitest';

import { STAGE_SCHEMAS } from '@/forms/registry';
import { STAGES, type Stage } from '@/forms/types';

import {
  decideIdempotency,
  isValidIdempotencyKey,
  IDEMPOTENCY_STATES,
  IN_PROGRESS_TIMEOUT_MS,
  type IdempotencyRecord,
  type IncomingRequest,
} from '../supabase/functions/_shared/idempotency.ts';
import {
  canonicalise,
  CanonicalisationError,
} from '../supabase/functions/_shared/canonical.ts';
import {
  HASH_PREFIX,
  normaliseRow,
  payloadHash,
  rowDifferences,
  rowHash,
  rowsEqual,
} from '../supabase/functions/_shared/hash.ts';
import { sha256Hex } from '../supabase/functions/_shared/sha256.ts';
import { decideProjection } from '../supabase/functions/_shared/projection.ts';

const NOW = new Date('2026-10-24T13:00:00.000Z');
const KEY = 'b3f1c2d4-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
const ACTOR = '11111111-1111-4111-8111-111111111111';
const OTHER_ACTOR = '22222222-2222-4222-8222-222222222222';

const STORED_RESPONSE = {
  sampleId: 'AP-2026-10-24-01',
  revision: 1,
  sheetSync: { state: 'pending', label: 'Recorded securely, Google Sheets sync pending' },
};

function incoming(overrides?: Partial<IncomingRequest>): IncomingRequest {
  return {
    key: KEY,
    operation: 'register_sample',
    actorId: ACTOR,
    payloadHash: payloadHash({ _operation: 'register_sample', values: { a: 1 } }),
    ...overrides,
  };
}

function record(overrides?: Partial<IdempotencyRecord>): IdempotencyRecord {
  const base = incoming();
  return {
    key: base.key,
    operation: base.operation,
    actorId: base.actorId,
    payloadHash: base.payloadHash,
    state: 'succeeded',
    response: STORED_RESPONSE,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------

describe('same idempotency key + same payload returns the same result', () => {
  it('replays the stored response verbatim, without re-running anything', () => {
    const decision = decideIdempotency(record(), incoming(), NOW);
    expect(decision.action).toBe('replay');
    if (decision.action === 'replay') {
      // Verbatim: the client asking "what was the outcome?" must be told the
      // outcome, not a freshly computed approximation of it.
      expect(decision.response).toBe(STORED_RESPONSE);
      expect(decision.response).toEqual(STORED_RESPONSE);
    }
  });

  it('replays the same answer however many times it is asked', () => {
    const stored = record();
    const answers = [1, 2, 3].map(() => decideIdempotency(stored, incoming(), NOW));
    expect(answers.every((a) => a.action === 'replay')).toBe(true);
    expect(new Set(answers.map((a) => JSON.stringify(a))).size).toBe(1);
  });

  it('replays even after the actor lost the permission in between', () => {
    // Re-authorising a replay would turn a completed registration into a 403
    // and invite the client to resubmit under a new key — producing the second
    // record the key exists to prevent. The effect has already happened; the
    // client is only asking what it was.
    const decision = decideIdempotency(record(), incoming(), new Date(NOW.getTime() + 86_400_000));
    expect(decision.action).toBe('replay');
  });

  it('proceeds when there is no record at all', () => {
    expect(decideIdempotency(null, incoming(), NOW)).toEqual({
      action: 'proceed',
      reason: 'no_record',
    });
  });

  it('lets the same payload retry under the same key after a failure', () => {
    // A failed attempt left no committed effect. Calling this a conflict would
    // strand the operator on a key their client has already persisted.
    expect(decideIdempotency(record({ state: 'failed', response: null }), incoming(), NOW)).toEqual({
      action: 'proceed',
      reason: 'previous_attempt_failed',
    });
  });

  it('covers every stored state, so a new one cannot be added silently', () => {
    // Derived from the exported state list rather than written out, so adding
    // a state to the module makes this assertion fail until it is decided on.
    const seen = new Map<string, string>();
    for (const state of IDEMPOTENCY_STATES) {
      const decision = decideIdempotency(record({ state }), incoming(), NOW);
      seen.set(state, decision.action);
    }
    expect([...seen.keys()].sort()).toEqual([...IDEMPOTENCY_STATES].sort());
    expect(seen.get('succeeded')).toBe('replay');
    expect(seen.get('failed')).toBe('proceed');
    expect(seen.get('in_progress')).toBe('in_progress');
  });
});

describe('same key + DIFFERENT payload is rejected', () => {
  it('refuses a changed payload rather than replaying the old answer', () => {
    const decision = decideIdempotency(
      record(),
      incoming({ payloadHash: payloadHash({ _operation: 'register_sample', values: { a: 2 } }) }),
      NOW,
    );
    expect(decision).toEqual({ action: 'conflict', reason: 'payload_mismatch' });
  });

  it('refuses a key presented by a different person, even on a success', () => {
    // This is not a retry at all: it is either a bug or an attempt to read
    // back somebody else's response, so it must never reach the replay branch.
    const decision = decideIdempotency(record(), incoming({ actorId: OTHER_ACTOR }), NOW);
    expect(decision).toEqual({ action: 'conflict', reason: 'actor_mismatch' });
  });

  it('refuses a key reused across endpoints', () => {
    const decision = decideIdempotency(record(), incoming({ operation: 'update_results' }), NOW);
    expect(decision).toEqual({ action: 'conflict', reason: 'operation_mismatch' });
  });

  it('reports the identity mismatch first when both identity and payload differ', () => {
    // Order matters for the message the operator sees: "somebody else used
    // this key" and "you changed the details" lead to different actions.
    const decision = decideIdempotency(
      record(),
      incoming({
        actorId: OTHER_ACTOR,
        payloadHash: payloadHash({ _operation: 'register_sample', values: { a: 99 } }),
      }),
      NOW,
    );
    expect(decision).toEqual({ action: 'conflict', reason: 'actor_mismatch' });
  });

  it('refuses a changed payload against a FAILED record too', () => {
    // Otherwise a failed attempt would be a free opportunity to rebind the key
    // to different details.
    const decision = decideIdempotency(
      record({ state: 'failed', response: null }),
      incoming({ payloadHash: payloadHash({ _operation: 'register_sample', values: { a: 3 } }) }),
      NOW,
    );
    expect(decision).toEqual({ action: 'conflict', reason: 'payload_mismatch' });
  });
});

describe('a concurrent attempt holds the key', () => {
  it('tells the client to poll rather than resend', () => {
    const decision = decideIdempotency(
      record({ state: 'in_progress', response: null, updatedAt: NOW.toISOString() }),
      incoming(),
      new Date(NOW.getTime() + 1_500),
    );
    expect(decision).toMatchObject({ action: 'in_progress' });
    if (decision.action === 'in_progress') expect(decision.sinceMs).toBe(1_500);
  });

  it('never reports a negative elapsed time when the clocks disagree', () => {
    const decision = decideIdempotency(
      record({ state: 'in_progress', response: null, updatedAt: NOW.toISOString() }),
      incoming(),
      new Date(NOW.getTime() - 5_000),
    );
    expect(decision).toMatchObject({ action: 'in_progress' });
    if (decision.action === 'in_progress') expect(decision.sinceMs).toBe(0);
  });

  it('takes over a lock whose owner died, at exactly the timeout', () => {
    const stale = record({ state: 'in_progress', response: null, updatedAt: NOW.toISOString() });

    const justBefore = decideIdempotency(
      stale,
      incoming(),
      new Date(NOW.getTime() + IN_PROGRESS_TIMEOUT_MS - 1),
    );
    expect(justBefore.action).toBe('in_progress');

    const atBoundary = decideIdempotency(
      stale,
      incoming(),
      new Date(NOW.getTime() + IN_PROGRESS_TIMEOUT_MS),
    );
    expect(atBoundary).toMatchObject({ action: 'take_over' });
    if (atBoundary.action === 'take_over') {
      expect(atBoundary.staleForMs).toBe(IN_PROGRESS_TIMEOUT_MS);
    }
  });

  it('takes over rather than wedging the key when the timestamp is unreadable', () => {
    const decision = decideIdempotency(
      record({ state: 'in_progress', response: null, updatedAt: 'not a date' }),
      incoming(),
      NOW,
    );
    expect(decision.action).toBe('take_over');
  });

  it('honours a caller-supplied timeout', () => {
    const stale = record({ state: 'in_progress', response: null, updatedAt: NOW.toISOString() });
    expect(decideIdempotency(stale, incoming(), new Date(NOW.getTime() + 500), 400).action).toBe(
      'take_over',
    );
    expect(decideIdempotency(stale, incoming(), new Date(NOW.getTime() + 500), 600).action).toBe(
      'in_progress',
    );
  });
});

describe('the key itself', () => {
  it('accepts an opaque token long enough not to collide', () => {
    expect(isValidIdempotencyKey(KEY)).toBe(true);
    expect(isValidIdempotencyKey('a'.repeat(16))).toBe(true);
    expect(isValidIdempotencyKey('a'.repeat(128))).toBe(true);
    expect(isValidIdempotencyKey('register:AP-2026-10-24-01:try-1')).toBe(true);
  });

  it('refuses the short or over-long keys that collide', () => {
    for (const bad of ['', '1', 'save', 'a'.repeat(15), 'a'.repeat(129)]) {
      expect(isValidIdempotencyKey(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it('draws the length boundary at 16 and 128 characters inclusive', () => {
    // Asserted explicitly because the boundary is the whole collision defence:
    // the key is opaque, so length is the only property the server can check.
    expect(isValidIdempotencyKey('a'.repeat(15))).toBe(false);
    expect(isValidIdempotencyKey('a'.repeat(16))).toBe(true);
    expect(isValidIdempotencyKey('a'.repeat(128))).toBe(true);
    expect(isValidIdempotencyKey('a'.repeat(129))).toBe(false);
  });

  it('ACCEPTS a sample-ID-shaped key, despite the module comment saying otherwise', () => {
    // `idempotency.ts`'s own comment lists "a sample ID" among the keys that
    // are refused, but a sample identifier is 16 characters of the permitted
    // alphabet and therefore passes. Asserted as the OBSERVED behaviour rather
    // than the documented intent, because this test must describe the code
    // that ships; the divergence is reported as a documentation defect in a
    // module this slice does not own.
    //
    // It is not a security hole: the registry is keyed on
    // (key, operation, actor) and a reused key with a different payload is a
    // refused `payload_mismatch`, so a collision fails closed.
    expect('AP-2026-10-24-01'.length).toBe(16);
    expect(isValidIdempotencyKey('AP-2026-10-24-01')).toBe(true);
  });

  it('refuses a key containing whitespace or a path separator', () => {
    for (const bad of ['key with spaces 123456', 'a/'.repeat(10), 'key\nwith\nnewlines!!']) {
      expect(isValidIdempotencyKey(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it('refuses anything that is not a string', () => {
    for (const bad of [undefined, null, 0, 1, {}, [], true]) {
      expect(isValidIdempotencyKey(bad)).toBe(false);
    }
  });
});

describe('"the same payload" is decided by a canonical hash', () => {
  it('ignores key order, so two identical requests are one payload', () => {
    const a = { operation: 'register', values: { b: 2, a: 1 }, stage: 'pellets' };
    const b = { stage: 'pellets', values: { a: 1, b: 2 }, operation: 'register' };
    expect(canonicalise(a)).toBe(canonicalise(b));
    expect(payloadHash(a)).toBe(payloadHash(b));
  });

  it('does NOT ignore array order, because a list of links is ordered data', () => {
    expect(payloadHash({ links: ['a', 'b'] })).not.toBe(payloadHash({ links: ['b', 'a'] }));
  });

  it('separates zero from blank from absent', () => {
    // Rule 8: zero is a real measured value; blank means not measured.
    const zero = payloadHash({ values: { moisture: 0 } });
    const blank = payloadHash({ values: { moisture: '' } });
    const absent = payloadHash({ values: {} });
    expect(new Set([zero, blank, absent]).size).toBe(3);
  });

  it('separates the number 84 from the string "84" and from "84.0"', () => {
    const hashes = [
      payloadHash({ v: 84 }),
      payloadHash({ v: '84' }),
      payloadHash({ v: '84.0' }),
    ];
    expect(new Set(hashes).size).toBe(3);
  });

  it('names its algorithm, so a future change is visible rather than silent', () => {
    const hash = payloadHash({ a: 1 });
    expect(hash.startsWith(HASH_PREFIX)).toBe(true);
    expect(hash.slice(HASH_PREFIX.length)).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(HASH_PREFIX + sha256Hex(canonicalise({ a: 1 })));
  });

  it('is stable across repeated calls', () => {
    const payload = { operation: 'update_results', values: { t: '84.0', n: null } };
    const first = payloadHash(payload);
    for (let i = 0; i < 5; i++) expect(payloadHash(payload)).toBe(first);
  });

  it('refuses a payload it cannot canonicalise rather than hashing a guess', () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic['self'] = cyclic;
    expect(() => canonicalise(cyclic)).toThrow(CanonicalisationError);
    expect(() => payloadHash(cyclic)).toThrow(CanonicalisationError);
  });

  it('agrees with the known SHA-256 of an empty string', () => {
    // An independently known value, so a broken digest cannot agree with
    // itself and pass.
    expect(sha256Hex('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

describe('a row is the same row whatever the API dropped from the end of it', () => {
  const STAGE: Stage = 'pellets';
  const WIDTH = STAGE_SCHEMAS[STAGE].columnCount;

  function row(sampleId: string, marker = ''): string[] {
    const cells = new Array<string>(WIDTH).fill('');
    cells[0] = sampleId;
    cells[1] = '2026-10-24';
    if (marker !== '') cells[4] = marker;
    return cells;
  }

  it('hashes to the same value once trailing blanks are normalised', () => {
    const full = row('AP-2026-10-24-01');
    const truncated = full.slice(0, 2);
    expect(rowHash(full, WIDTH)).toBe(rowHash(truncated, WIDTH));
    expect(rowsEqual(full, truncated, WIDTH)).toBe(true);
  });

  it('keeps an interior blank distinct from a zero', () => {
    const blank = row('AP-2026-10-24-01');
    const zero = row('AP-2026-10-24-01');
    zero[4] = '0';
    expect(rowHash(blank, WIDTH)).not.toBe(rowHash(zero, WIDTH));
    expect(rowsEqual(blank, zero, WIDTH)).toBe(false);
    expect(rowDifferences(blank, zero, WIDTH)).toEqual([
      { index: 4, expected: '', actual: '0' },
    ]);
  });

  it('pads to the stage width for every stage, never to a fixed width', () => {
    for (const stage of STAGES) {
      const width = STAGE_SCHEMAS[stage].columnCount;
      expect(normaliseRow(['x'], width)).toHaveLength(width);
    }
  });

  it('refuses a nonsensical width rather than returning a short row', () => {
    expect(() => normaliseRow(['x'], 0)).toThrow(/positive integer/);
    expect(() => normaliseRow(['x'], -1)).toThrow(/positive integer/);
    expect(() => normaliseRow(['x'], 1.5)).toThrow(/positive integer/);
  });

  it('is a no-op projection when the sheet already holds exactly this row', () => {
    // The projection-level guarantee: a duplicate delivery of a committed
    // event, or a retry after an unknown outcome, resolves to `noop` — which
    // is why one Google timeout cannot become two operational rows.
    const cells = row('AP-2026-10-24-01', 'first');
    const decision = decideProjection({
      stage: STAGE,
      sampleId: 'AP-2026-10-24-01',
      intendedRow: cells,
      // Read back with trailing blanks dropped, as the API returns it.
      located: { rowNumber: 5, values: cells.slice(0, 5) },
      confirmedRowNumber: 5,
      // The app's own projection history for this sample: this row, which is
      // exactly what the sheet holds.
      priorProjections: [cells],
      lastConfirmedRow: cells,
    });
    expect(decision).toEqual({
      action: 'noop',
      rowNumber: 5,
      reason: 'already_current',
      width: WIDTH,
    });
  });

  it('appends only when the identifier is genuinely absent and nothing was confirmed', () => {
    const cells = row('AP-2026-10-24-02');
    expect(
      decideProjection({
        stage: STAGE,
        sampleId: 'AP-2026-10-24-02',
        intendedRow: cells,
        located: null,
        confirmedRowNumber: null,
        priorProjections: [cells],
      }),
    ).toEqual({ action: 'append', reason: 'no_existing_row', width: WIDTH });

    // Once a row was confirmed, an absent identifier is a deletion to report,
    // never a reason to append a second record.
    expect(
      decideProjection({
        stage: STAGE,
        sampleId: 'AP-2026-10-24-02',
        intendedRow: cells,
        located: null,
        confirmedRowNumber: 5,
        priorProjections: [cells],
        lastConfirmedRow: cells,
      }),
    ).toMatchObject({ action: 'blocked', reason: 'confirmed_row_missing' });
  });

  it('refuses a row whose column A does not actually hold the identifier', () => {
    const cells = row('AP-2026-10-24-03');
    const decision = decideProjection({
      stage: STAGE,
      sampleId: 'AP-2026-10-24-03',
      intendedRow: cells,
      located: { rowNumber: 5, values: row('AP-2026-10-24-99') },
      confirmedRowNumber: 5,
      priorProjections: [cells],
      lastConfirmedRow: cells,
    });
    expect(decision).toMatchObject({ action: 'blocked', reason: 'id_mismatch_at_row' });
  });
});
