/**
 * Google Sheets projection, leasing, backoff and the dead-letter boundary.
 *
 * Everything here exercises the PURE modules under
 * `supabase/functions/_shared/` through the in-memory `FakeGoogleSheetsAdapter`
 * and an in-memory `SyncStore`. No Deno, no network, no database — the
 * entrypoint (`sheets-sync-worker/index.ts`) is deliberately not imported,
 * because it calls `Deno.serve` and reads `Deno.env`.
 *
 * The cases chosen are the ones that silently corrupt a quality record in
 * naive sync code:
 *
 *   - a write that LANDED and then timed out, retried (the duplicate-row bug)
 *   - the same event delivered twice (at-least-once delivery)
 *   - a sheet somebody sorted between two writes (stale row number)
 *   - a row-4 header that moved (every column index now means something else)
 *   - a stalled worker waking up after its lease was taken (the fence)
 *   - a retry schedule that is not monotonic, or unbounded
 *   - a dead letter reached early, or never
 *
 * Nothing in this file asserts a numeric acceptance limit; the fixtures are
 * row strings, not measurements.
 */

import { describe, expect, it } from 'vitest';

import { FIRST_DATA_ROW, PROTECTED_HEADER_ROWS, REFERENCE_TABS, STAGE_SCHEMAS } from '@/forms/registry';
import { SHEETS_VALUE_INPUT_OPTION as MAPPING_VALUE_INPUT_OPTION } from '@/forms/sheetMapping';
import { STAGES, type Stage } from '@/forms/types';

import {
  FakeGoogleSheetsAdapter,
  FakeWorkbook,
} from '../supabase/functions/_shared/fakeSheets.ts';
import {
  assertWritableRange,
  isWritableTab,
  needsVerification,
  verifySchema,
  type SchemaProblem,
  type VerificationState,
} from '../supabase/functions/_shared/headerCheck.ts';
import {
  decideProjection,
  verifyPersistedRow,
  type ProjectionDecision,
} from '../supabase/functions/_shared/projection.ts';
import {
  nextOutboxState,
  isDue,
  isSuperseded,
  type OutboxEvent,
  type OutboxTransition,
} from '../supabase/functions/_shared/outbox.ts';
import {
  DEFAULT_BACKOFF,
  backoffDelayMs,
  decideRetry,
  delayEnvelopeMs,
  nominalDelayMs,
  type BackoffPolicy,
} from '../supabase/functions/_shared/backoff.ts';
import {
  canAcquire,
  nextLease,
  renewedLease,
  validateFence,
  type FenceClaim,
  type LeaseState,
} from '../supabase/functions/_shared/lease.ts';
import {
  LeaseLostError,
  processEvent,
  runSyncPass,
  type SyncStore,
} from '../supabase/functions/_shared/syncWorker.ts';
import { rowHash } from '../supabase/functions/_shared/hash.ts';
import {
  syncStatusFor,
  SYNC_ATTENTION_LABEL,
  SYNC_CONFIRMED_LABEL,
} from '../supabase/functions/_shared/syncStatus.ts';
import { SHEETS_VALUE_INPUT_OPTION } from '../supabase/functions/_shared/sheets.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** `4 Pellets`, A:K, 11 columns. Narrow enough to read in an assertion. */
const STAGE: Stage = 'pellets';
const WIDTH = STAGE_SCHEMAS[STAGE].columnCount;
const TAB = STAGE_SCHEMAS[STAGE].sheetTab;

const WORKBOOK_KEY = 'test-workbook';
const T0 = new Date('2026-10-24T13:00:00.000Z');

/** A row of the right width whose column A is the immutable identifier. */
function row(sampleId: string, marker = 'a'): string[] {
  const cells = new Array<string>(WIDTH).fill('');
  cells[0] = sampleId;
  cells[1] = '2026-10-24';
  cells[2] = '09:30';
  // One interior cell carries the marker, so two revisions of the same sample
  // differ somewhere that is not column A.
  cells[4] = marker;
  return cells;
}

function event(overrides: Partial<OutboxEvent> & { sampleId: string }): OutboxEvent {
  const cells = overrides.row ?? row(overrides.sampleId);
  const base: OutboxEvent = {
    id: `evt-${overrides.sampleId}-${overrides.revision ?? 1}`,
    sampleUuid: `uuid-${overrides.sampleId}`,
    sampleId: overrides.sampleId,
    stage: STAGE,
    kind: 'sample_registered',
    revision: 1,
    payloadHash: rowHash(cells, WIDTH),
    row: cells,
    state: 'pending',
    attempts: 0,
    nextAttemptAt: null,
    reconcileFirst: false,
    lastError: null,
    confirmedRowNumber: null,
    confirmedAt: null,
    createdAt: T0.toISOString(),
  };
  // The hash is always of the row that is actually carried, so an override
  // cannot produce an event whose checksum describes a different row.
  return { ...base, ...overrides, row: cells, payloadHash: rowHash(cells, WIDTH) };
}

/**
 * In-memory `SyncStore` that enforces the fence the way the SQL side must.
 *
 * Every mutating method re-validates the caller's claim against the CURRENT
 * lease and refuses a stale one. That refusal is the whole point of the fence:
 * a worker's own state can never tell it that its lease lapsed, so the check
 * has to live where the current fence is known.
 */
class FakeSyncStore implements SyncStore {
  lease: LeaseState | null;
  verification: VerificationState = {
    lastVerifiedAt: null,
    verifiedStages: [],
    schemaDrifted: false,
  };
  readonly confirmedRevision = new Map<string, number>();
  readonly confirmedRow = new Map<string, number>();
  /**
   * `sheet_sync_outbox.projected_row` for every event this store has seen
   * CLAIMED, newest first, modelling `rpc_read_sample_projected_rows`. The
   * worker records an outcome for every event it processes, which is the point
   * at which this store learns the event existed; a test that needs a
   * projection the worker never processed declares it with `seedProjection`.
   */
  readonly projections = new Map<string, string[][]>();
  /** The row of the last VERIFIED write, which the blocked message diffs against. */
  readonly confirmedProjection = new Map<string, readonly string[]>();
  readonly outcomes: { event: OutboxEvent; transition: OutboxTransition; decision: ProjectionDecision | null }[] = [];
  readonly fenceRejections: string[] = [];
  driftProblems: readonly SchemaProblem[] = [];
  renewals = 0;

  constructor(lease: LeaseState | null, private readonly clock: () => Date = () => T0) {
    this.lease = lease;
  }

  private guard(claim: FenceClaim, at: string): void {
    const check = validateFence(this.lease, claim, this.clock());
    if (!check.ok) {
      this.fenceRejections.push(`${at}:${check.reason}`);
      throw new Error(check.message);
    }
  }

  readLease(): Promise<LeaseState | null> {
    return Promise.resolve(this.lease);
  }

  renewLease(claim: FenceClaim): Promise<LeaseState | null> {
    const check = validateFence(this.lease, claim, this.clock());
    if (!check.ok || this.lease === null) {
      this.fenceRejections.push(`renew:${check.ok ? 'no_lease' : check.reason}`);
      return Promise.resolve(null);
    }
    this.renewals++;
    this.lease = renewedLease(this.lease, this.clock());
    return Promise.resolve(this.lease);
  }

  readVerificationState(): Promise<VerificationState> {
    return Promise.resolve(this.verification);
  }

  writeVerificationState(state: VerificationState): Promise<void> {
    this.verification = state;
    return Promise.resolve();
  }

  // The three mutating methods are `async`, so a refused fence arrives as a
  // REJECTED promise — which is how the SQL side reports it. A synchronous
  // throw would be a different failure mode from the one being modelled.
  async markSchemaDrifted(args: {
    claim: FenceClaim;
    problems: readonly SchemaProblem[];
  }): Promise<void> {
    await Promise.resolve();
    this.guard(args.claim, 'markSchemaDrifted');
    this.driftProblems = args.problems;
    this.verification = { ...this.verification, schemaDrifted: true };
  }

  latestConfirmedRevision(sampleUuid: string): Promise<number | null> {
    return Promise.resolve(this.confirmedRevision.get(sampleUuid) ?? null);
  }

  confirmedRowNumber(sampleUuid: string): Promise<number | null> {
    return Promise.resolve(this.confirmedRow.get(sampleUuid) ?? null);
  }

  confirmedProjectedRow(sampleUuid: string): Promise<readonly string[] | null> {
    return Promise.resolve(this.confirmedProjection.get(sampleUuid) ?? null);
  }

  projectedRowsFor(sampleUuid: string): Promise<readonly (readonly string[])[]> {
    return Promise.resolve(this.projections.get(sampleUuid) ?? []);
  }

  /** A row the app projected for an event this store never processed. */
  seedProjection(sampleUuid: string, row: readonly string[]): void {
    const list = this.projections.get(sampleUuid) ?? [];
    list.unshift([...row]);
    this.projections.set(sampleUuid, list);
  }

  async recordOutcome(args: {
    claim: FenceClaim;
    event: OutboxEvent;
    transition: OutboxTransition;
    decision: ProjectionDecision | null;
  }): Promise<void> {
    await Promise.resolve();
    this.guard(args.claim, 'recordOutcome');
    this.outcomes.push({ event: args.event, transition: args.transition, decision: args.decision });
    // The event has been claimed and attempted, so its projected row is now
    // one of the contents this app could have put in the sheet. This is the
    // `last_attempt_at is not null` filter of rpc_read_sample_projected_rows.
    this.seedProjection(args.event.sampleUuid, args.event.row);
    // And this is the call that flips the event's state to `confirmed` in SQL
    // (rpc_record_outbox_outcome), which is what makes its projected row the
    // one `was_confirmed` row the writer diffs a hand edit against.
    if (args.transition.state === 'confirmed') {
      this.confirmedProjection.set(args.event.sampleUuid, [...args.event.row]);
    }
  }

  async confirmRowMapping(args: {
    claim: FenceClaim;
    sampleUuid: string;
    stage: Stage;
    rowNumber: number;
    revision: number;
    payloadHash: string;
    confirmedAt: string;
  }): Promise<void> {
    await Promise.resolve();
    this.guard(args.claim, 'confirmRowMapping');
    this.confirmedRow.set(args.sampleUuid, args.rowNumber);
    this.confirmedRevision.set(args.sampleUuid, args.revision);

  }
}

function liveLease(fence: number, owner = 'worker-1'): LeaseState {
  return {
    workbookKey: WORKBOOK_KEY,
    owner,
    fence,
    acquiredAt: T0.toISOString(),
    expiresAt: new Date(T0.getTime() + 60_000).toISOString(),
  };
}

interface Harness {
  readonly adapter: FakeGoogleSheetsAdapter;
  readonly workbook: FakeWorkbook;
  readonly store: FakeSyncStore;
  readonly claim: FenceClaim;
  readonly deps: Parameters<typeof processEvent>[0];
}

function harness(options?: {
  readonly fence?: number;
  readonly claimFence?: number;
  readonly owner?: string;
  readonly random?: () => number;
}): Harness {
  const workbook = new FakeWorkbook();
  const adapter = new FakeGoogleSheetsAdapter(workbook);
  const owner = options?.owner ?? 'worker-1';
  const store = new FakeSyncStore(liveLease(options?.fence ?? 7, owner));
  const claim: FenceClaim = { owner, fence: options?.claimFence ?? options?.fence ?? 7 };
  return {
    adapter,
    workbook,
    store,
    claim,
    deps: {
      adapter,
      store,
      claim,
      now: () => T0,
      random: options?.random ?? ((): number => 0),
      policy: DEFAULT_BACKOFF,
    },
  };
}

// ---------------------------------------------------------------------------

describe('RAW is the only value input option', () => {
  it('agrees with the registry constant, so the two cannot drift apart', () => {
    // sheets.ts repeats the literal rather than importing it, because there it
    // is an HTTP query-string argument. This is the assertion that keeps the
    // duplication honest.
    expect(SHEETS_VALUE_INPUT_OPTION).toBe('RAW');
    expect(SHEETS_VALUE_INPUT_OPTION).toBe(MAPPING_VALUE_INPUT_OPTION);
  });
});

describe('the writer never touches a protected row or a reference tab', () => {
  it('refuses every row above the first data row', () => {
    for (let r = 0; r < FIRST_DATA_ROW; r++) {
      expect(() => assertWritableRange(TAB, r)).toThrow(/protected/i);
    }
    expect(() => assertWritableRange(TAB, FIRST_DATA_ROW)).not.toThrow();
  });

  it('refuses the "Read me" and "Limits" tabs by name', () => {
    // Derived from REFERENCE_TABS rather than listed, so adding a reference
    // tab to the registry extends this assertion automatically.
    expect(REFERENCE_TABS.length).toBeGreaterThan(0);
    for (const tab of REFERENCE_TABS) {
      expect(isWritableTab(tab)).toBe(false);
      expect(() => assertWritableRange(tab, FIRST_DATA_ROW)).toThrow(/preserved read-only/i);
    }
    expect(isWritableTab(TAB)).toBe(true);
  });

  it('has no tab name in common between the writable set and the reference set', () => {
    // The write path is keyed by Stage, and no stage resolves to a reference
    // tab, so there is no argument by which a caller could address one.
    const writable = new Set(STAGES.map((s) => STAGE_SCHEMAS[s].sheetTab));
    for (const tab of REFERENCE_TABS) expect(writable.has(tab)).toBe(false);
  });

  it('writes exactly one operational row for one registration', async () => {
    const h = harness();
    await processEvent(h.deps, event({ sampleId: 'AP-2026-10-24-01' }));
    // The fake's own `writeRow` runs `assertWritableRange`, so a write aimed
    // at a protected row or a reference tab would have thrown here rather than
    // silently succeeding.
    expect(h.workbook.countRecords(STAGE)).toBe(1);
    expect(h.workbook.rawRow(STAGE, FIRST_DATA_ROW)?.[0]).toBe('AP-2026-10-24-01');
  });
});

describe('a header mismatch blocks the writer', () => {
  it('detects a changed row-4 header and names the column', async () => {
    const workbook = new FakeWorkbook();
    workbook.setHeader(STAGE, 2, 'Time of day');
    const adapter = new FakeGoogleSheetsAdapter(workbook);
    const read = await adapter.verifyWorkbook([STAGE]);
    const result = verifySchema(read.reading, [STAGE]);
    expect(result.ok).toBe(false);
    expect(result.verifiedStages).not.toContain(STAGE);
    expect(result.problems.some((p) => p.kind === 'header_mismatch')).toBe(true);
    expect(result.problems.some((p) => p.columnLetter === 'C')).toBe(true);
  });

  it('writes nothing, latches the drift and dead-letters the event', async () => {
    const h = harness();
    h.workbook.setHeader(STAGE, 2, 'Time of day');

    const result = await processEvent(h.deps, event({ sampleId: 'AP-2026-10-24-01' }));

    expect(result.outcome.kind).toBe('schema_drift');
    expect(result.wrote).toBe(false);
    expect(h.workbook.countRecords(STAGE)).toBe(0);
    expect(h.store.verification.schemaDrifted).toBe(true);
    expect(h.store.driftProblems.length).toBeGreaterThan(0);
    expect(result.transition.state).toBe('needs_attention');
    // A drifted workbook is not retried on a timer: retrying would burn quota
    // rediscovering the same condition and bury the alert.
    expect(result.transition.nextAttemptAt).toBeNull();
    expect(result.transition.deadLettered).toBe(true);
  });

  it('stays blocked on the next pass without re-reading the workbook', async () => {
    const h = harness();
    h.store.verification = { lastVerifiedAt: null, verifiedStages: [], schemaDrifted: true };

    const before = h.adapter.apiCalls;
    const result = await processEvent(h.deps, event({ sampleId: 'AP-2026-10-24-02' }));

    expect(result.outcome.kind).toBe('schema_drift');
    expect(h.adapter.apiCalls).toBe(before);
    expect(h.workbook.countRecords(STAGE)).toBe(0);
  });

  it('refuses a stage whose tab was renamed, and a missing reference tab', async () => {
    const workbook = new FakeWorkbook();
    workbook.renameStageTab(STAGE, '4 Pellets (old)');
    workbook.removeTab(REFERENCE_TABS[0]!);
    const adapter = new FakeGoogleSheetsAdapter(workbook);
    const read = await adapter.verifyWorkbook([STAGE]);
    const result = verifySchema(read.reading, [STAGE]);

    expect(result.ok).toBe(false);
    expect(result.problems.map((p) => p.kind)).toContain('missing_tab');
    expect(result.problems.map((p) => p.kind)).toContain('reference_tab_missing');
  });

  it('refuses a stage whose A5 still holds the legacy self-filling ID formula', async () => {
    const workbook = new FakeWorkbook();
    workbook.setA5Formula(STAGE, '=IF(B5<>"","AP-"&TEXT(B5,"yy-mm-dd"),"")');
    const adapter = new FakeGoogleSheetsAdapter(workbook);
    const read = await adapter.verifyWorkbook([STAGE]);
    const result = verifySchema(read.reading, [STAGE]);

    expect(result.ok).toBe(false);
    expect(result.problems.map((p) => p.kind)).toContain('legacy_id_formula_present');
    // Headers matched, but the stage is still not cleared for writing.
    expect(result.verifiedStages).not.toContain(STAGE);
  });
});

describe('a timeout is an unknown outcome, not a failure', () => {
  it('does not produce a second row when the write landed before timing out', async () => {
    const h = harness();
    const first = event({ sampleId: 'AP-2026-10-24-03' });

    // The bytes reach Google; the response never comes back.
    h.adapter.failNext('upsertOperationalRow', { kind: 'timeout', landsFirst: true });
    const attempt1 = await processEvent(h.deps, first);

    expect(attempt1.outcome.kind).toBe('unknown');
    expect(attempt1.transition.state).toBe('retry_scheduled');
    // The retry is FORCED to reconcile: this flag is what stops the second
    // attempt appending.
    expect(attempt1.transition.reconcileFirst).toBe(true);
    expect(h.workbook.countRecords(STAGE)).toBe(1);
    // Nothing was confirmed, because nothing was read back.
    expect(h.store.confirmedRow.get(first.sampleUuid)).toBeUndefined();

    // The retry, carrying the transition the first attempt recorded.
    const retry: OutboxEvent = {
      ...first,
      state: attempt1.transition.state,
      attempts: attempt1.transition.attempts,
      nextAttemptAt: attempt1.transition.nextAttemptAt,
      reconcileFirst: attempt1.transition.reconcileFirst,
      lastError: attempt1.transition.lastError,
    };

    const attempt2 = await processEvent(h.deps, retry);

    expect(attempt2.located).toBe(true);
    expect(attempt2.decision?.action).toBe('noop');
    expect(attempt2.outcome.kind).toBe('noop');
    expect(attempt2.transition.state).toBe('confirmed');
    // THE ASSERTION THIS WHOLE TEST EXISTS FOR.
    expect(h.workbook.countRecords(STAGE)).toBe(1);
    expect(h.store.confirmedRow.get(first.sampleUuid)).toBe(FIRST_DATA_ROW);
  });

  it('never skips the locate for an event that must reconcile first', async () => {
    const h = harness();
    const first = event({ sampleId: 'AP-2026-10-24-04' });
    h.adapter.failNext('upsertOperationalRow', { kind: 'timeout', landsFirst: true });
    await processEvent(h.deps, first);

    // `attempts: 0` deliberately: it isolates `reconcileFirst` as the reason
    // the optimisation is refused. With a non-zero attempt count the blind
    // append would be refused anyway and the test would pass without
    // exercising the flag at all.
    const retry: OutboxEvent = {
      ...first,
      attempts: 0,
      reconcileFirst: true,
      state: 'retry_scheduled',
    };

    // Even with the blind-append optimisation switched ON, a reconcile-first
    // event is located before anything is decided.
    const attempt2 = await processEvent(
      { ...h.deps, allowAppendWithoutLocate: true },
      retry,
    );

    expect(attempt2.located).toBe(true);
    expect(h.workbook.countRecords(STAGE)).toBe(1);
  });

  it('treats a timeout with no write as unknown too, and still reconciles', async () => {
    const h = harness();
    const ev = event({ sampleId: 'AP-2026-10-24-05' });
    h.adapter.failNext('upsertOperationalRow', { kind: 'timeout', landsFirst: false });
    const attempt1 = await processEvent(h.deps, ev);

    expect(attempt1.outcome.kind).toBe('unknown');
    expect(attempt1.transition.reconcileFirst).toBe(true);
    expect(h.workbook.countRecords(STAGE)).toBe(0);

    const attempt2 = await processEvent(h.deps, {
      ...ev,
      attempts: attempt1.transition.attempts,
      reconcileFirst: true,
      state: 'retry_scheduled',
    });

    expect(attempt2.decision?.action).toBe('append');
    expect(attempt2.transition.state).toBe('confirmed');
    expect(h.workbook.countRecords(STAGE)).toBe(1);
  });

  it('is a no-op when the same event is delivered twice', async () => {
    const h = harness();
    const ev = event({ sampleId: 'AP-2026-10-24-06' });

    const first = await processEvent(h.deps, ev);
    expect(first.decision?.action).toBe('append');

    // At-least-once delivery: the identical event arrives again.
    const second = await processEvent(h.deps, ev);
    expect(second.decision?.action).toBe('noop');
    expect(h.workbook.countRecords(STAGE)).toBe(1);
  });

  it('does not roll a confirmed row back to an older revision', async () => {
    const h = harness();
    const ev = event({ sampleId: 'AP-2026-10-24-07', revision: 3 });
    h.store.confirmedRevision.set(ev.sampleUuid, 5);

    const result = await processEvent(h.deps, ev);

    expect(isSuperseded(ev, 5)).toBe(true);
    expect(result.outcome.kind).toBe('superseded');
    expect(result.wrote).toBe(false);
    expect(result.transition.state).toBe('superseded');
    expect(h.workbook.countRecords(STAGE)).toBe(0);
  });
});

describe('sorted-sheet drift relocates by sample ID', () => {
  it('updates the row the identifier moved to, not the row number it was confirmed at', async () => {
    const h = harness();
    const a = event({ sampleId: 'AP-2026-10-24-01' });
    const b = event({ sampleId: 'AP-2026-10-24-02' });

    await processEvent(h.deps, a);
    await processEvent(h.deps, b);
    expect(h.store.confirmedRow.get(a.sampleUuid)).toBe(FIRST_DATA_ROW);
    expect(h.store.confirmedRow.get(b.sampleUuid)).toBe(FIRST_DATA_ROW + 1);

    // Somebody clicks "Sort Z -> A" on column A.
    h.workbook.sortDataRowsByColumn(STAGE, 0, 'desc');
    expect(h.workbook.rawRow(STAGE, FIRST_DATA_ROW)?.[0]).toBe(b.sampleId);

    const amended = event({
      sampleId: a.sampleId,
      kind: 'results_recorded',
      revision: 2,
      row: row(a.sampleId, 'amended'),
    });

    const result = await processEvent(h.deps, amended);

    expect(result.located).toBe(true);
    expect(result.decision?.action).toBe('update');
    expect(result.decision).toMatchObject({ reason: 'relocated_after_drift' });
    expect(result.transition.state).toBe('confirmed');
    // It wrote to the row the ID is NOW on, and created nothing.
    expect(result.transition.confirmedRowNumber).toBe(FIRST_DATA_ROW + 1);
    expect(h.workbook.countRecords(STAGE)).toBe(2);
    expect(h.workbook.rawRow(STAGE, FIRST_DATA_ROW + 1)?.[4]).toBe('amended');
    // And the other sample was not touched.
    expect(h.workbook.rawRow(STAGE, FIRST_DATA_ROW)?.[0]).toBe(b.sampleId);
  });

  it('reports a relocation as `row_located` when nothing was confirmed before', () => {
    const decision = decideProjection({
      stage: STAGE,
      sampleId: 'AP-2026-10-24-09',
      intendedRow: row('AP-2026-10-24-09', 'new'),
      located: { rowNumber: 11, values: row('AP-2026-10-24-09', 'old') },
      confirmedRowNumber: null,
      // The 'old' row is one this app projected, so its presence in the sheet
      // is the app's own earlier write and not a hand edit. Without it in the
      // history this would be `row_not_authored_by_app`, which is the point of
      // the guard and is asserted separately.
      priorProjections: [row('AP-2026-10-24-09', 'new'), row('AP-2026-10-24-09', 'old')],
    });
    expect(decision).toMatchObject({ action: 'update', rowNumber: 11, reason: 'row_located' });
  });

  it('refuses to re-append a confirmed row that somebody deleted by hand', async () => {
    const h = harness();
    const ev = event({ sampleId: 'AP-2026-10-24-10' });
    await processEvent(h.deps, ev);
    expect(h.workbook.countRecords(STAGE)).toBe(1);

    h.workbook.deleteRow(STAGE, FIRST_DATA_ROW);

    const amended = event({
      sampleId: ev.sampleId,
      kind: 'results_recorded',
      revision: 2,
      row: row(ev.sampleId, 'amended'),
    });
    const result = await processEvent(h.deps, amended);

    expect(result.decision).toMatchObject({ action: 'blocked', reason: 'confirmed_row_missing' });
    expect(result.wrote).toBe(false);
    // The hand deletion surfaces rather than being silently undone.
    expect(h.workbook.countRecords(STAGE)).toBe(0);
    expect(result.transition.deadLettered).toBe(true);
  });

  it('refuses to write when one identifier is on two rows', async () => {
    const h = harness();
    const ev = event({ sampleId: 'AP-2026-10-24-11' });
    await processEvent(h.deps, ev);
    h.workbook.insertDuplicate(STAGE, FIRST_DATA_ROW);

    const amended = event({
      sampleId: ev.sampleId,
      kind: 'results_recorded',
      revision: 2,
      row: row(ev.sampleId, 'amended'),
    });
    const result = await processEvent(h.deps, amended);

    expect(result.decision).toMatchObject({ action: 'blocked', reason: 'duplicate_rows' });
    expect(result.wrote).toBe(false);
    expect(h.workbook.countRecords(STAGE)).toBe(2);
  });

  it('treats trailing blanks dropped by the API as agreement, not drift', () => {
    const intended = row('AP-2026-10-24-12');
    // The Sheets API truncates trailing empties on read.
    const truncated = intended.slice(0, 5);
    const decision = decideProjection({
      stage: STAGE,
      sampleId: 'AP-2026-10-24-12',
      intendedRow: intended,
      located: { rowNumber: 9, values: truncated },
      confirmedRowNumber: 9,
      priorProjections: [intended],
      lastConfirmedRow: intended,
    });
    expect(decision.action).toBe('noop');
  });

  it('refuses a row located inside the protected header region', () => {
    const decision = decideProjection({
      stage: STAGE,
      sampleId: 'AP-2026-10-24-13',
      intendedRow: row('AP-2026-10-24-13'),
      located: { rowNumber: PROTECTED_HEADER_ROWS, values: row('AP-2026-10-24-13') },
      priorProjections: [row('AP-2026-10-24-13')],
    });
    expect(decision).toMatchObject({ action: 'blocked', reason: 'row_in_protected_region' });
  });

  it('refuses a row whose width is wrong for the stage', () => {
    const decision = decideProjection({
      stage: STAGE,
      sampleId: 'AP-2026-10-24-14',
      intendedRow: new Array<string>(WIDTH + 1).fill('x'),
      located: null,
      priorProjections: [],
    });
    expect(decision).toMatchObject({ action: 'blocked', reason: 'row_width_mismatch' });
  });

  it('rejects a write whose read-back landed somewhere else', () => {
    const cells = row('AP-2026-10-24-15');
    expect(
      verifyPersistedRow({
        stage: STAGE,
        sampleId: 'AP-2026-10-24-15',
        intendedRow: cells,
        expectedRowNumber: 9,
        readBack: { rowNumber: 10, values: cells },
      }),
    ).toMatchObject({ ok: false, reason: 'row_moved' });

    expect(
      verifyPersistedRow({
        stage: STAGE,
        sampleId: 'AP-2026-10-24-15',
        intendedRow: cells,
        expectedRowNumber: 9,
        readBack: null,
      }),
    ).toMatchObject({ ok: false, reason: 'row_absent' });

    expect(
      verifyPersistedRow({
        stage: STAGE,
        sampleId: 'AP-2026-10-24-15',
        intendedRow: cells,
        expectedRowNumber: 9,
        readBack: { rowNumber: 9, values: row('AP-2026-10-24-15', 'tampered') },
      }),
    ).toMatchObject({ ok: false, reason: 'values_differ' });
  });

});

describe('a stale fence token is rejected while the current one succeeds', () => {
  it('issues a strictly increasing fence, even on a takeover', () => {
    const first = nextLease({ current: null, workbookKey: WORKBOOK_KEY, owner: 'a', now: T0 });
    expect(first.fence).toBe(1);

    const lapsed: LeaseState = { ...first, expiresAt: T0.toISOString() };
    expect(canAcquire(lapsed, new Date(T0.getTime() + 1))).toBe(true);

    const second = nextLease({
      current: lapsed,
      workbookKey: WORKBOOK_KEY,
      owner: 'b',
      now: new Date(T0.getTime() + 1),
    });
    expect(second.fence).toBe(2);
    expect(second.owner).toBe('b');
  });

  it('names every way a claim can fail', () => {
    const current = liveLease(5, 'worker-b');

    expect(validateFence(null, { owner: 'worker-a', fence: 1 }, T0)).toMatchObject({
      ok: false,
      reason: 'no_lease',
    });
    expect(validateFence(current, { owner: 'worker-a', fence: 4 }, T0)).toMatchObject({
      ok: false,
      reason: 'fence_stale',
    });
    expect(validateFence(current, { owner: 'worker-b', fence: 6 }, T0)).toMatchObject({
      ok: false,
      reason: 'fence_ahead_of_store',
    });
    expect(validateFence(current, { owner: 'worker-a', fence: 5 }, T0)).toMatchObject({
      ok: false,
      reason: 'owner_mismatch',
    });
    expect(
      validateFence(current, { owner: 'worker-b', fence: 5 }, new Date(T0.getTime() + 120_000)),
    ).toMatchObject({ ok: false, reason: 'lease_expired' });
    expect(validateFence(current, { owner: 'worker-b', fence: 5 }, T0).ok).toBe(true);
  });

  it('lets the current worker write and refuses the stalled one, in the same workbook', async () => {
    // Worker A took fence 7 and stalled. Worker B has since taken fence 8.
    const workbook = new FakeWorkbook();
    const adapter = new FakeGoogleSheetsAdapter(workbook);
    const store = new FakeSyncStore(liveLease(8, 'worker-b'));

    const currentClaim: FenceClaim = { owner: 'worker-b', fence: 8 };
    const stalledClaim: FenceClaim = { owner: 'worker-a', fence: 7 };

    const current = {
      adapter,
      store,
      claim: currentClaim,
      now: () => T0,
      random: (): number => 0,
    };
    const stalled = {
      adapter,
      store,
      claim: stalledClaim,
      now: () => T0,
      random: (): number => 0,
    };

    const ok = await processEvent(current, event({ sampleId: 'AP-2026-10-24-20' }));
    expect(ok.transition.state).toBe('confirmed');
    expect(workbook.countRecords(STAGE)).toBe(1);

    // Worker A wakes up and tries to write a different sample.
    let caught: unknown = null;
    try {
      await processEvent(stalled, event({ sampleId: 'AP-2026-10-24-21' }));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(LeaseLostError);
    expect((caught as LeaseLostError).reason).toBe('fence_stale');
    // Its write never happened.
    expect(workbook.countRecords(STAGE)).toBe(1);

    // And the bookkeeping side refuses it independently of the worker's own
    // pre-write check, which is what makes the fence a control rather than a
    // courtesy: the stalled worker cannot record an outcome either.
    await expect(
      store.recordOutcome({
        claim: stalledClaim,
        event: event({ sampleId: 'AP-2026-10-24-21' }),
        transition: {
          state: 'confirmed',
          attempts: 1,
          nextAttemptAt: null,
          reconcileFirst: false,
          lastError: null,
          confirmedRowNumber: FIRST_DATA_ROW,
          confirmedAt: T0.toISOString(),
          deadLettered: false,
        },
        decision: null,
      }),
    ).rejects.toThrow(/fence 7/);
    expect(store.fenceRejections.join(' ')).toContain('fence_stale');
  });

  it('aborts a pass when renewal is refused, without processing the rest', async () => {
    const store = new FakeSyncStore(liveLease(9, 'worker-b'));
    const workbook = new FakeWorkbook();
    const adapter = new FakeGoogleSheetsAdapter(workbook);

    const summary = await runSyncPass(
      {
        adapter,
        store,
        // A fence below the store's: renewal is refused immediately.
        claim: { owner: 'worker-a', fence: 8 },
        now: () => T0,
        random: () => 0,
      },
      [event({ sampleId: 'AP-2026-10-24-22' }), event({ sampleId: 'AP-2026-10-24-23' })],
    );

    expect(summary.abortedBecause).toBe('fence_stale');
    expect(summary.processed).toBe(0);
    expect(workbook.countRecords(STAGE)).toBe(0);
  });

  it('renews once per event so a long queue cannot lapse mid-batch', async () => {
    const h = harness();
    const events = [
      event({ sampleId: 'AP-2026-10-24-24' }),
      event({ sampleId: 'AP-2026-10-24-25' }),
      event({ sampleId: 'AP-2026-10-24-26' }),
    ];
    const summary = await runSyncPass(h.deps, events);

    expect(summary.processed).toBe(events.length);
    expect(summary.confirmed).toBe(events.length);
    expect(h.store.renewals).toBe(events.length);
    expect(h.workbook.countRecords(STAGE)).toBe(events.length);
  });

  it('keeps the same fence across a renewal', () => {
    const lease = liveLease(3, 'worker-a');
    const renewed = renewedLease(lease, new Date(T0.getTime() + 30_000));
    expect(renewed.fence).toBe(lease.fence);
    expect(Date.parse(renewed.expiresAt)).toBeGreaterThan(Date.parse(lease.expiresAt));
  });
});

describe('backoff is bounded and monotonic, with jitter inside its bound', () => {
  /** Attempt numbers covering the whole policy plus the clamped tail. */
  const attempts = (policy: BackoffPolicy): number[] =>
    Array.from({ length: policy.maxAttempts + 6 }, (_, i) => i + 1);

  it('never decreases and never exceeds the cap', () => {
    const policy = DEFAULT_BACKOFF;
    let previous = 0;
    for (const attempt of attempts(policy)) {
      const nominal = nominalDelayMs(attempt, policy);
      expect(nominal).toBeGreaterThanOrEqual(previous);
      expect(nominal).toBeLessThanOrEqual(policy.maxDelayMs);
      previous = nominal;
    }
    // The tail is clamped, not growing.
    expect(nominalDelayMs(policy.maxAttempts + 6, policy)).toBe(policy.maxDelayMs);
  });

  it('keeps both the floor and the ceiling of the envelope non-decreasing', () => {
    const policy = DEFAULT_BACKOFF;
    let previous = { minMs: 0, maxMs: 0 };
    for (const attempt of attempts(policy)) {
      const envelope = delayEnvelopeMs(attempt, policy);
      expect(envelope.minMs).toBeGreaterThanOrEqual(previous.minMs);
      expect(envelope.maxMs).toBeGreaterThanOrEqual(previous.maxMs);
      expect(envelope.maxMs).toBeLessThanOrEqual(policy.maxDelayMs * (1 + policy.jitterRatio));
      previous = envelope;
    }
  });

  it('puts every jittered delay inside its own attempt envelope', () => {
    const policy = DEFAULT_BACKOFF;
    const samples = [0, 0.01, 0.25, 0.5, 0.75, 0.999999];
    for (const attempt of attempts(policy)) {
      const envelope = delayEnvelopeMs(attempt, policy);
      for (const r of samples) {
        const delay = backoffDelayMs(attempt, policy, () => r);
        expect(delay).toBeGreaterThanOrEqual(Math.floor(envelope.minMs));
        expect(delay).toBeLessThanOrEqual(Math.ceil(envelope.maxMs));
      }
    }
  });

  it('actually varies with the jitter source, and refuses a bad one', () => {
    const policy = DEFAULT_BACKOFF;
    const low = backoffDelayMs(3, policy, () => 0);
    const high = backoffDelayMs(3, policy, () => 0.9);
    expect(high).toBeGreaterThan(low);
    expect(low).toBe(nominalDelayMs(3, policy));

    expect(() => backoffDelayMs(3, policy, () => 1)).toThrow(/\[0,1\)/);
    expect(() => backoffDelayMs(3, policy, () => -0.1)).toThrow(/\[0,1\)/);
    expect(() => backoffDelayMs(0, policy, () => 0)).toThrow(/positive integer/);
  });

  it('honours a server Retry-After that is longer than its own delay', () => {
    const policy = DEFAULT_BACKOFF;
    const decision = decideRetry(1, policy, () => 0, 30_000);
    expect(decision).toMatchObject({ retry: true });
    if (decision.retry) expect(decision.delayMs).toBe(30_000);

    const shorter = decideRetry(1, policy, () => 0, 1);
    if (shorter.retry) expect(shorter.delayMs).toBe(nominalDelayMs(1, policy));
  });

  it('rejects an incoherent policy rather than silently normalising it', () => {
    expect(() => nominalDelayMs(1, { ...DEFAULT_BACKOFF, baseMs: 0 })).toThrow(/baseMs/);
    expect(() => nominalDelayMs(1, { ...DEFAULT_BACKOFF, factor: 0.5 })).toThrow(/factor/);
    expect(() => nominalDelayMs(1, { ...DEFAULT_BACKOFF, jitterRatio: 2 })).toThrow(/jitterRatio/);
    expect(() => nominalDelayMs(1, { ...DEFAULT_BACKOFF, maxAttempts: 0 })).toThrow(/maxAttempts/);
  });
});

describe('dead letter is reached only after the configured max attempts', () => {
  /** Walk a retryable failure forward one attempt at a time. */
  function walk(policy: BackoffPolicy): OutboxTransition[] {
    const transitions: OutboxTransition[] = [];
    let attempts = 0;
    // One more iteration than the policy allows, to prove the boundary is the
    // policy's and not the loop's.
    for (let i = 0; i < policy.maxAttempts + 1; i++) {
      const transition = nextOutboxState({
        event: { attempts, confirmedRowNumber: null, confirmedAt: null },
        outcome: { kind: 'retryable', detail: 'Sheets backend error' },
        now: T0,
        random: () => 0,
        policy,
      });
      transitions.push(transition);
      if (transition.deadLettered) break;
      attempts = transition.attempts;
    }
    return transitions;
  }

  it('dead-letters on exactly the maxAttempts-th failure, for any policy', () => {
    for (const maxAttempts of [1, 2, 3, DEFAULT_BACKOFF.maxAttempts, 9]) {
      const policy: BackoffPolicy = { ...DEFAULT_BACKOFF, maxAttempts };
      const transitions = walk(policy);

      // The count is DERIVED from the policy, never written as a literal.
      expect(transitions).toHaveLength(maxAttempts);
      transitions.slice(0, -1).forEach((t, i) => {
        expect(t.deadLettered, `attempt ${i + 1} of ${maxAttempts}`).toBe(false);
        expect(t.state).toBe('retry_scheduled');
        expect(t.nextAttemptAt).not.toBeNull();
      });

      const last = transitions[transitions.length - 1]!;
      expect(last.deadLettered).toBe(true);
      expect(last.state).toBe('needs_attention');
      expect(last.attempts).toBe(maxAttempts);
      expect(last.nextAttemptAt).toBeNull();
      expect(last.lastError).toContain(`gave up after ${maxAttempts} attempts`);
    }
  });

  it('carries reconcile-first into a dead letter from an unknown outcome', () => {
    const policy: BackoffPolicy = { ...DEFAULT_BACKOFF, maxAttempts: 2 };
    const transition = nextOutboxState({
      event: { attempts: 1, confirmedRowNumber: null, confirmedAt: null },
      outcome: { kind: 'unknown', detail: 'timed out' },
      now: T0,
      random: () => 0,
      policy,
    });
    expect(transition.deadLettered).toBe(true);
    // A manual retry by an administrator must still reconcile before writing.
    expect(transition.reconcileFirst).toBe(true);
  });

  it('dead-letters a permanent failure immediately, without burning attempts', () => {
    const transition = nextOutboxState({
      event: { attempts: 0, confirmedRowNumber: null, confirmedAt: null },
      outcome: { kind: 'permanent', detail: 'Caller does not have permission' },
      now: T0,
      random: () => 0,
      policy: DEFAULT_BACKOFF,
    });
    expect(transition.attempts).toBe(1);
    expect(transition.deadLettered).toBe(true);
    expect(transition.state).toBe('needs_attention');
    expect(transition.nextAttemptAt).toBeNull();
  });

  it('reaches the dead letter through the worker, not only through the state machine', async () => {
    const policy: BackoffPolicy = { ...DEFAULT_BACKOFF, maxAttempts: 2 };
    const h = harness();
    const ev = event({ sampleId: 'AP-2026-10-24-30' });

    h.adapter.failNext('upsertOperationalRow', { kind: 'retryable' });
    const first = await processEvent({ ...h.deps, policy }, ev);
    expect(first.transition.deadLettered).toBe(false);
    expect(first.transition.state).toBe('retry_scheduled');

    h.adapter.failNext('upsertOperationalRow', { kind: 'retryable' });
    const second = await processEvent({ ...h.deps, policy }, {
      ...ev,
      attempts: first.transition.attempts,
      state: 'retry_scheduled',
    });
    expect(second.transition.deadLettered).toBe(true);
    expect(second.transition.state).toBe('needs_attention');
    expect(h.workbook.countRecords(STAGE)).toBe(0);
  });

  it('respects a quota hint rather than retrying immediately', async () => {
    const h = harness();
    h.adapter.failNext('upsertOperationalRow', { kind: 'quota', retryAfterMs: 45_000 });
    const result = await processEvent(h.deps, event({ sampleId: 'AP-2026-10-24-31' }));

    expect(result.outcome.kind).toBe('retryable');
    expect(result.transition.state).toBe('retry_scheduled');
    const due = Date.parse(result.transition.nextAttemptAt!);
    expect(due - T0.getTime()).toBeGreaterThanOrEqual(45_000);
  });

  it('only treats an event as due once its retry time has passed', () => {
    const scheduled = { state: 'retry_scheduled' as const, nextAttemptAt: new Date(T0.getTime() + 1_000).toISOString() };
    expect(isDue(scheduled, T0)).toBe(false);
    expect(isDue(scheduled, new Date(T0.getTime() + 1_000))).toBe(true);
    expect(isDue({ state: 'pending', nextAttemptAt: null }, T0)).toBe(true);
    // A dead letter is never picked up by the timer.
    expect(isDue({ state: 'needs_attention', nextAttemptAt: null }, T0)).toBe(false);
    expect(isDue({ state: 'confirmed', nextAttemptAt: null }, T0)).toBe(false);
  });
});

describe('header verification is due before the first write and periodically', () => {
  it('is due when nothing was ever verified', () => {
    expect(
      needsVerification({ lastVerifiedAt: null, verifiedStages: [], schemaDrifted: false }, [STAGE], T0),
    ).toBe(true);
  });

  it('is due for a stage the last verification did not cover', () => {
    const state: VerificationState = {
      lastVerifiedAt: T0.toISOString(),
      verifiedStages: ['mash'],
      schemaDrifted: false,
    };
    expect(needsVerification(state, [STAGE], T0)).toBe(true);
    expect(needsVerification(state, ['mash'], T0)).toBe(false);
  });

  it('becomes due again once the interval has elapsed', () => {
    const state: VerificationState = {
      lastVerifiedAt: T0.toISOString(),
      verifiedStages: [STAGE],
      schemaDrifted: false,
    };
    expect(needsVerification(state, [STAGE], new Date(T0.getTime() + 60_000), 15 * 60_000)).toBe(false);
    expect(needsVerification(state, [STAGE], new Date(T0.getTime() + 15 * 60_000), 15 * 60_000)).toBe(true);
  });

  it('verifies before writing, and does not re-read on the next event', async () => {
    const h = harness();
    await processEvent(h.deps, event({ sampleId: 'AP-2026-10-24-40' }));
    const afterFirst = h.adapter.callLog.filter((c) => c === 'verifyWorkbook').length;
    expect(afterFirst).toBeGreaterThan(0);

    await processEvent(h.deps, event({ sampleId: 'AP-2026-10-24-41' }));
    const afterSecond = h.adapter.callLog.filter((c) => c === 'verifyWorkbook').length;
    expect(afterSecond).toBe(afterFirst);
  });

  it('locates a record by identifier without a reconciliation read', async () => {
    const h = harness();
    await processEvent(h.deps, event({ sampleId: 'AP-2026-10-24-42' }));
    const located = await h.adapter.locateRecord(STAGE, 'AP-2026-10-24-42');

    expect(located.record?.rowNumber).toBe(FIRST_DATA_ROW);
    expect(located.duplicateRows).toEqual([]);
    // The locate path must not fall back to reading the whole data region.
    expect(h.adapter.callLog).not.toContain('readForReconciliation');
  });
});

// ---------------------------------------------------------------------------
// A HAND-EDITED OPERATIONAL ROW IS NOT OVERWRITTEN.
//
// The defect these tests exist for, reproduced before it was fixed: a sample
// was registered and confirmed; a person corrected a cell of that row directly
// in Google Sheets; the Quality Officer then entered results; the worker
// located the row by its sample ID, chose `action=update / reason=row_located`
// and REWROTE EVERY COLUMN of the stage. Ten of nineteen cells were wiped,
// including a tester's name and the comment "Accepted. Aflatoxin within vendor
// reference.". The outcome reported was `confirmed`, the operator's screen read
// "Confirmed in Google Sheets", and nothing reached the needs-attention list.
//
// `reconcile.ts` already promised the opposite — "The sheet was edited
// directly; the system will not overwrite it without review" — but
// reconciliation only reports, and `reconcile-sheets/index.ts` says its report
// blocks nothing.
//
// WHY THERE WAS NO TEST: `grep -rn setCell tests/` returned nothing.
// `FakeWorkbook.setCell`, whose own comment is "A hand edit to one cell", was
// called by no test in this repository. These are the tests that call it.
//
// WHAT THIS EVIDENCE IS AND IS NOT. Everything here runs against
// `FakeGoogleSheetsAdapter`. On the UPDATE axis the double is faithful: it
// writes exactly `columnCount` cells to the addressed row, which is what
// `values.update` does. On the APPEND axis it is NOT: it finds the first row
// with a blank column A and REPLACES it, whereas production passes
// `insertDataOption=INSERT_ROWS`. The registration step of each scenario below
// is an append, so it is scaffolding rather than evidence; every assertion that
// carries weight here is about an update to an existing row, and about the
// pure `decideProjection` decision, which is adapter-independent.
// ---------------------------------------------------------------------------

/** The tester-name and comment columns of `4 Pellets`: J and K. */
const TESTER_COL = WIDTH - 2;
const COMMENT_COL = WIDTH - 1;
const HAND_TYPED_NOTE = 'OPERATOR NOTE: retested, see lab book p.44';

/** Register a sample, confirm it, and return where it landed. */
async function registerAndConfirm(h: Harness, sampleId: string): Promise<number> {
  const result = await processEvent(h.deps, event({ sampleId, revision: 1 }));
  // INPUT ASSERTION, before anything is concluded from a later step: the
  // scenario requires a confirmed row to exist. If registration did not
  // confirm, every assertion below is about a different situation.
  expect(result.outcome.kind).toBe('confirmed');
  expect(result.transition.state).toBe('confirmed');
  return result.outcome.kind === 'confirmed' ? result.outcome.rowNumber : -1;
}

describe('a row somebody edited by hand in the sheet', () => {
  it('survives the next update, which is blocked rather than confirmed', async () => {
    const h = harness();
    const sampleId = 'AP-2026-10-24-50';
    const rowNumber = await registerAndConfirm(h, sampleId);

    // STEP 2. A Quality Officer types a correction straight into the sheet.
    h.workbook.setCell(STAGE, rowNumber, TESTER_COL, 'K. Persaud');
    h.workbook.setCell(STAGE, rowNumber, COMMENT_COL, HAND_TYPED_NOTE);
    // INSTRUMENT CHECK: the edit is really in the sheet. Without this the test
    // below passes identically if `setCell` wrote nothing at all.
    expect(h.workbook.rawRow(STAGE, rowNumber)?.[COMMENT_COL]).toBe(HAND_TYPED_NOTE);
    expect(h.workbook.rawRow(STAGE, rowNumber)?.[TESTER_COL]).toBe('K. Persaud');

    // STEP 3/4. The QO enters results. A second event for the same sample.
    const results = await processEvent(
      h.deps,
      event({
        sampleId,
        kind: 'results_recorded',
        revision: 2,
        row: row(sampleId, 'results'),
      }),
    );

    // THE CELLS SURVIVE. This is the assertion the defect failed.
    const after = h.workbook.rawRow(STAGE, rowNumber);
    expect(after?.[COMMENT_COL]).toBe(HAND_TYPED_NOTE);
    expect(after?.[TESTER_COL]).toBe('K. Persaud');

    // And the refusal is the SPECIFIC one claimed, not merely "something was
    // refused": four other guards can also return `blocked` for this input
    // shape, and each would make this test pass while proving nothing.
    expect(results.decision).toMatchObject({ action: 'blocked', reason: 'row_edited_in_sheet' });
    expect(results.wrote).toBe(false);
    expect(results.outcome.kind).toBe('blocked');
  });

  it('becomes a needs-attention item instead of a silent success', async () => {
    const h = harness();
    const sampleId = 'AP-2026-10-24-51';
    const rowNumber = await registerAndConfirm(h, sampleId);
    h.workbook.setCell(STAGE, rowNumber, COMMENT_COL, HAND_TYPED_NOTE);

    const results = await processEvent(
      h.deps,
      event({ sampleId, kind: 'results_recorded', revision: 2, row: row(sampleId, 'results') }),
    );

    // Dead-lettered, so it stops rather than retrying forever against a
    // condition only a human can clear.
    expect(results.transition.state).toBe('needs_attention');
    expect(results.transition.deadLettered).toBe(true);
    expect(results.transition.nextAttemptAt).toBeNull();
    // And it does not claim a confirmation it does not have.
    expect(results.transition.confirmedAt).toBeNull();

    // What a person reads. `needs_attention` is the only outbox state that
    // produces this label, and it is not the confirmation label.
    const status = syncStatusFor({ outboxState: results.transition.state });
    expect(status.state).toBe('needs_attention');
    expect(status.label).toBe(SYNC_ATTENTION_LABEL);
    expect(status.label).not.toBe(SYNC_CONFIRMED_LABEL);
    expect(status.confirmedAt).toBeNull();
  });

  it('says in plain words what happened, and names the cell', async () => {
    const h = harness();
    const sampleId = 'AP-2026-10-24-52';
    const rowNumber = await registerAndConfirm(h, sampleId);
    h.workbook.setCell(STAGE, rowNumber, COMMENT_COL, HAND_TYPED_NOTE);

    const results = await processEvent(
      h.deps,
      event({ sampleId, kind: 'results_recorded', revision: 2, row: row(sampleId, 'results') }),
    );

    const message = results.decision?.action === 'blocked' ? results.decision.message : '';
    expect(message).toContain('edited');
    expect(message).toContain('Google Sheets');
    expect(message).toContain(`row ${rowNumber}`);
    expect(message).toContain(TAB);
    expect(message).toContain(sampleId);
    // The cell, by the column letter and the row-4 header an administrator
    // sees in the workbook, with the text that was typed.
    const commentField = STAGE_SCHEMAS[STAGE].fields[COMMENT_COL]!;
    expect(message).toContain(`column ${commentField.columnLetter}`);
    expect(message).toContain(commentField.sheetHeader);
    expect(message).toContain(HAND_TYPED_NOTE);
    // And that nothing was overwritten, which is the part an operator acts on.
    expect(message).toMatch(/left untouched|nothing was overwritten/);

    // The differing cells travel with the decision, which is stored in
    // `sheet_sync_outbox.last_decision`.
    const differences = results.decision?.action === 'blocked' ? results.decision.differences : undefined;
    expect(differences).toEqual([{ index: COMMENT_COL, expected: '', actual: HAND_TYPED_NOTE }]);
  });

  it('refuses a row carrying the identifier that this system never wrote', async () => {
    // The pre-existing-row collision. `allocate_sample_id` restarts at 01 per
    // date, so a back-dated collection can mint an identifier a hand-entered
    // row already carries. Same harm as a hand edit, by a different route.
    const h = harness();
    const sampleId = 'AP-2026-10-24-53';
    const foreign = row(sampleId, 'entered by hand');
    foreign[COMMENT_COL] = 'Accepted. Aflatoxin within vendor reference.';
    h.workbook.writeRow(STAGE, FIRST_DATA_ROW, foreign);
    expect(h.workbook.countRecords(STAGE)).toBe(1);

    const registered = await processEvent(h.deps, event({ sampleId, revision: 1 }));

    expect(registered.decision).toMatchObject({
      action: 'blocked',
      reason: 'row_not_authored_by_app',
    });
    expect(registered.wrote).toBe(false);
    expect(registered.transition.deadLettered).toBe(true);
    // Untouched, and NOT duplicated either: refusing must not append a second
    // operational row beside the one it refused to overwrite.
    expect(h.workbook.rawRow(STAGE, FIRST_DATA_ROW)?.[COMMENT_COL]).toBe(
      'Accepted. Aflatoxin within vendor reference.',
    );
    expect(h.workbook.countRecords(STAGE)).toBe(1);

    const message = registered.decision?.action === 'blocked' ? registered.decision.message : '';
    expect(message).toContain('never written a row');
    expect(message).toContain(sampleId);
  });

  it('blocks on content alone, with no knowledge of who edited what', () => {
    // The decision as a pure function, so the rule is readable without the
    // worker: a located row whose content matches none of the app's own
    // projections is refused, and one that matches is not.
    const sampleId = 'AP-2026-10-24-54';
    const ours = row(sampleId, 'ours');
    const edited = [...ours];
    edited[COMMENT_COL] = HAND_TYPED_NOTE;

    expect(
      decideProjection({
        stage: STAGE,
        sampleId,
        intendedRow: row(sampleId, 'next'),
        located: { rowNumber: 9, values: edited },
        confirmedRowNumber: 9,
        priorProjections: [row(sampleId, 'next'), ours],
        lastConfirmedRow: ours,
      }),
    ).toMatchObject({ action: 'blocked', reason: 'row_edited_in_sheet' });

    // POSITIVE CONTROL for the same call: identical in every respect except
    // that the sheet holds what we left there. If this did not update, the
    // check above would be evidence of a function that refuses everything.
    expect(
      decideProjection({
        stage: STAGE,
        sampleId,
        intendedRow: row(sampleId, 'next'),
        located: { rowNumber: 9, values: ours },
        confirmedRowNumber: 9,
        priorProjections: [row(sampleId, 'next'), ours],
        lastConfirmedRow: ours,
      }),
    ).toMatchObject({ action: 'update', rowNumber: 9, reason: 'row_located' });
  });
});

describe('the hand-edit guard does not block the work it has to allow', () => {
  it('register then results, with no human edit, still updates the row', async () => {
    // THE SINGLE MOST IMPORTANT FALSE POSITIVE. If this blocks, the product is
    // broken: it is the normal life of every sample.
    const h = harness();
    const sampleId = 'AP-2026-10-24-55';
    const rowNumber = await registerAndConfirm(h, sampleId);

    const results = await processEvent(
      h.deps,
      event({ sampleId, kind: 'results_recorded', revision: 2, row: row(sampleId, 'results') }),
    );

    expect(results.decision).toMatchObject({ action: 'update', rowNumber, reason: 'row_located' });
    expect(results.wrote).toBe(true);
    expect(results.outcome.kind).toBe('confirmed');
    expect(results.transition.state).toBe('confirmed');
    // The results are actually in the sheet, in the row that already existed.
    expect(h.workbook.rawRow(STAGE, rowNumber)?.[4]).toBe('results');
    expect(h.workbook.countRecords(STAGE)).toBe(1);
  });

  it('overwrites an unedited row exactly as it did before', async () => {
    // A correction over a confirmed row. The cell the app owns is replaced,
    // which is the behaviour the guard must leave alone.
    const h = harness();
    const sampleId = 'AP-2026-10-24-56';
    const rowNumber = await registerAndConfirm(h, sampleId);
    expect(h.workbook.rawRow(STAGE, rowNumber)?.[4]).toBe('a');

    const corrected = await processEvent(
      h.deps,
      event({ sampleId, kind: 'correction_applied', revision: 2, row: row(sampleId, 'corrected') }),
    );

    expect(corrected.decision).toMatchObject({ action: 'update', reason: 'row_located' });
    expect(corrected.outcome.kind).toBe('confirmed');
    expect(h.workbook.rawRow(STAGE, rowNumber)?.[4]).toBe('corrected');
  });

  it('still no-ops a retry whose write landed before the timeout', async () => {
    const h = harness();
    const sampleId = 'AP-2026-10-24-57';
    // The write reaches Google and the response never does.
    h.adapter.failNext('upsertOperationalRow', { kind: 'timeout', landsFirst: true });
    const first = await processEvent(h.deps, event({ sampleId, revision: 1 }));

    // DISCRIMINATORS, because a mis-keyed fault injection is silently a request
    // for NO fault, and a plain successful write also leaves one row present.
    // Only the outcome distinguishes them: a successful write reports
    // `confirmed`, this path must report `unknown`.
    expect(first.outcome.kind).toBe('unknown');
    expect(first.transition.reconcileFirst).toBe(true);
    expect(h.workbook.countRecords(STAGE)).toBe(1);

    const retry = await processEvent(
      h.deps,
      event({
        sampleId,
        revision: 1,
        attempts: 1,
        reconcileFirst: true,
        state: 'retry_scheduled',
      }),
    );

    expect(retry.decision).toMatchObject({ action: 'noop', reason: 'already_current' });
    expect(retry.outcome.kind).toBe('noop');
    expect(h.workbook.countRecords(STAGE)).toBe(1);
  });

  it('allows the next revision when an earlier write landed but never confirmed', async () => {
    // The ordering that makes "compare against the last CONFIRMED row" wrong
    // on its own. Revision 1 lands and times out, so nothing is confirmed
    // while its row IS in the sheet. `rpc_claim_outbox_batch` orders by
    // next_retry_at, and a freshly enqueued revision 2 sorts ahead of a
    // revision 1 waiting out a backoff — so revision 2 arrives first and finds
    // content no confirmed baseline explains. It is still the app's own row.
    const h = harness();
    const sampleId = 'AP-2026-10-24-58';
    h.adapter.failNext('upsertOperationalRow', { kind: 'timeout', landsFirst: true });
    const first = await processEvent(h.deps, event({ sampleId, revision: 1 }));
    expect(first.outcome.kind).toBe('unknown');
    expect(await h.store.confirmedRowNumber(`uuid-${sampleId}`)).toBeNull();
    expect(h.workbook.countRecords(STAGE)).toBe(1);

    const results = await processEvent(
      h.deps,
      event({ sampleId, kind: 'results_recorded', revision: 2, row: row(sampleId, 'results') }),
    );

    expect(results.decision).toMatchObject({ action: 'update', reason: 'row_located' });
    expect(results.outcome.kind).toBe('confirmed');
    expect(h.workbook.rawRow(STAGE, FIRST_DATA_ROW)?.[4]).toBe('results');
  });

  it('still updates a row the sheet was sorted into a different position', async () => {
    const h = harness();
    const a = 'AP-2026-10-24-59';
    const b = 'AP-2026-10-24-60';
    await registerAndConfirm(h, b);
    const rowA = await registerAndConfirm(h, a);
    expect(rowA).toBe(FIRST_DATA_ROW + 1);

    // A user clicks Sort A->Z. The values do not change; only the positions.
    h.workbook.sortDataRowsByColumn(STAGE, 0, 'asc');
    expect(h.workbook.rawRow(STAGE, FIRST_DATA_ROW)?.[0]).toBe(a);

    const results = await processEvent(
      h.deps,
      event({ sampleId: a, kind: 'results_recorded', revision: 2, row: row(a, 'results') }),
    );

    expect(results.decision).toMatchObject({
      action: 'update',
      rowNumber: FIRST_DATA_ROW,
      reason: 'relocated_after_drift',
    });
    expect(results.outcome.kind).toBe('confirmed');
    expect(h.workbook.countRecords(STAGE)).toBe(2);
  });

  it('treats trailing blanks the sheet dropped on read as agreement', () => {
    // The guard reuses `rowsEqual`, so it inherits the width normalisation
    // that `verifyPersistedRow` has always depended on. A guard that compared
    // raw arrays would block every single update, because the API returns
    // fewer cells than were written.
    const sampleId = 'AP-2026-10-24-61';
    const ours = row(sampleId, 'ours');
    const asRead = ours.slice(0, 5);
    expect(asRead.length).toBeLessThan(ours.length); // the condition is real

    expect(
      decideProjection({
        stage: STAGE,
        sampleId,
        intendedRow: row(sampleId, 'next'),
        located: { rowNumber: 9, values: asRead },
        confirmedRowNumber: 9,
        priorProjections: [row(sampleId, 'next'), ours],
        lastConfirmedRow: ours,
      }),
    ).toMatchObject({ action: 'update', reason: 'row_located' });
  });
});
