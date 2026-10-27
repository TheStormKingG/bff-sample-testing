/**
 * THE DRIFT LATCH, AND HOW AN OPERATOR GETS OUT OF IT.
 *
 * ===========================================================================
 * THE INCIDENT THIS FILE REPRODUCES
 * ===========================================================================
 * 18:58  POST /schema-verify {action:'verify_headers'} read the real workbook,
 *        found a legacy self-filling sample-ID formula in A5 of all seven
 *        operational tabs, recorded `schema_drifted = true` with seven
 *        problems, and took the single-writer lease. The lease was never
 *        released; the row sat expired for twenty minutes.
 * 19:12  The operator cleared the formulas — exactly what the check asked for.
 * 19:1x  Every subsequent check returned HTTP 500 with the generic body
 *        {"code":"internal","message":"Something went wrong. Nothing was
 *        saved. Please try again."} The caller held `administrator`. Nothing
 *        in the response named the latch, the tabs, or a remedy.
 * 19:21  A hand-written service_role UPDATE cleared the state. The very next
 *        call returned 200.
 *
 * ===========================================================================
 * WHICH OF THE TWO CANDIDATES IT WAS, SETTLED BY EXECUTION
 * ===========================================================================
 * Both candidates were set up in isolation against a local PostgreSQL database
 * with every migration applied, and the real RPCs were called with the
 * arguments the handler sends.
 *
 *   (a) THE STALE LEASE — NOT THE CAUSE. With `lease_holder` set and
 *       `leased_until` twenty minutes in the past, `rpc_acquire_sheet_lease`
 *       TOOK THE LEASE OVER and bumped the fence 1 -> 2. No error, no refusal.
 *       The fence-token design works as documented. And the clean branch never
 *       called `acquireLease` at all, so the stale lease could not have been
 *       on the 500's path.
 *
 *   (b) THE DRIFT LATCH — THE CAUSE, precisely. With `schema_drifted = true`,
 *       a passing read makes `schema.ok` true, and the old clean branch called
 *
 *           rpc_write_workbook_verification(key, now(), <all 7 stages>, true)
 *                                                                       ^^^^
 *                                             previous.schemaDrifted, carried
 *                                             forward verbatim
 *
 *       which raises
 *         ERROR: BFF_DRIFT_WITH_VERIFIED_STAGES: a verification cannot report
 *         drift and list verified tabs at the same time
 *       (SQLSTATE 22023). `mapRpcError` maps any unrecognised RPC error to
 *       `ApiError('internal')`, whose message is the exact generic sentence the
 *       operator saw. Positive control: the identical call with `false` in that
 *       position SUCCEEDS and clears the problem list. Second positive control:
 *       `true` with an EMPTY stage list also succeeds — so the raise is
 *       specific to the pair, not to the call.
 *
 * `FakeSyncStore` below mirrors those measured semantics, including the exact
 * refusal, so this suite exercises the same states without a database.
 *
 * ===========================================================================
 * WHAT IS UNDER TEST
 * ===========================================================================
 * The REAL sequence: `verifySchema` over a `FakeWorkbook` reading taken
 * through the real `FakeGoogleSheetsAdapter`, handed to the real
 * `runDriftRecovery`. Only the database is a double. `schema-verify/index.ts`
 * itself is not imported — it calls `Deno.serve` — which is why the whole
 * sequence was moved into `_shared/driftRecovery.ts` where a test can reach it.
 *
 * EVERY CLAIM HAS A POSITIVE CONTROL. "The latch is gone" passes for a
 * recovery path that clears unconditionally, so each refusal is paired with
 * the call that must succeed, and each success with the call that must be
 * refused.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { STAGES, type Stage } from '@/forms/types';
import { STAGE_SCHEMAS } from '@/forms/registry';

import {
  FakeGoogleSheetsAdapter,
  FakeWorkbook,
} from '../supabase/functions/_shared/fakeSheets.ts';
import {
  verifySchema,
  type SchemaProblem,
  type VerificationState,
} from '../supabase/functions/_shared/headerCheck.ts';
import {
  affectedTabs,
  clearRefusal,
  planDriftRecovery,
  runDriftRecovery,
  verificationWriteRefusal,
  type DriftAction,
  type DriftOutcome,
  type DriftStore,
} from '../supabase/functions/_shared/driftRecovery.ts';
import {
  DEFAULT_LEASE_TTL_MS,
  type FenceClaim,
  type LeaseState,
} from '../supabase/functions/_shared/lease.ts';
import { DEFAULT_BACKOFF } from '../supabase/functions/_shared/backoff.ts';
import {
  SCHEMA_DRIFT_LATCH_PERMISSION,
  SCHEMA_VERIFY_ACTIONS,
  SCHEMA_VERIFY_ACTION_PERMISSION,
} from '../supabase/functions/_shared/actions.ts';

const WORKBOOK = 'operational-workbook';
const LEGACY_FORMULA = '=IF(B5<>"","BFF-"&TEXT(ROW()-4,"0000"),"")';

// ---------------------------------------------------------------------------
// The database double, faithful to the measured SQL
// ---------------------------------------------------------------------------

/** Named exactly as the SQL raises them, so a failure here reads like psql. */
const SQL_REFUSALS = {
  driftWithVerifiedStages: 'BFF_DRIFT_WITH_VERIFIED_STAGES',
  leaseLost: 'BFF_LEASE_LOST',
  fenceStale: 'BFF_FENCE_STALE',
  leaseExpired: 'BFF_LEASE_EXPIRED',
  partialVerification: 'BFF_PARTIAL_VERIFICATION',
  problemsRequired: 'BFF_PROBLEMS_REQUIRED',
} as const;

interface AuditRecord {
  readonly action: string;
  readonly actorId: string | null;
  readonly at: string;
  readonly problemsCleared: number;
  readonly verifiedStages: readonly Stage[];
}

/**
 * In-memory `sheet_sync_worker_lease` + `sheet_workbook_state`.
 *
 * Mirrors the measured behaviour of the real functions, refusal for refusal:
 *
 *   rpc_acquire_sheet_lease           takes over a free, expired or own lease;
 *                                     bumps the fence except for the own case
 *   rpc_release_sheet_lease           silently nothing unless holder AND fence
 *                                     match
 *   assert_sheet_lease                BFF_LEASE_LOST / BFF_FENCE_STALE /
 *                                     BFF_LEASE_EXPIRED
 *   rpc_write_workbook_verification   BFF_DRIFT_WITH_VERIFIED_STAGES on the pair
 *   rpc_mark_schema_drifted           BFF_PROBLEMS_REQUIRED on an empty list;
 *                                     clears the verified-stage list
 *   rpc_clear_schema_drift            BFF_PARTIAL_VERIFICATION unless every
 *                                     stage is named; writes the audit event
 *                                     in the same act
 */
class FakeSyncStore implements DriftStore {
  lease: {
    holder: string | null;
    fence: number;
    acquiredAt: string | null;
    expiresAt: string | null;
  } = { holder: null, fence: 0, acquiredAt: null, expiresAt: null };

  state: VerificationState & { problems: readonly SchemaProblem[] } = {
    lastVerifiedAt: null,
    verifiedStages: [],
    schemaDrifted: false,
    problems: [],
  };

  readonly audit: AuditRecord[] = [];
  readonly calls: string[] = [];
  /** Queue a throw for the next call to one of the mutating methods. */
  failNext: Partial<Record<'markSchemaDrifted' | 'clearSchemaDrift' | 'releaseLease', string>> = {};

  constructor(private readonly clock: () => Date = () => new Date()) {}

  // -- what the real lease row does ----------------------------------------

  acquireLease(owner: string, ttlMs: number): Promise<LeaseState | null> {
    this.calls.push('acquireLease');
    const now = this.clock().getTime();
    const expiry = this.lease.expiresAt === null ? null : Date.parse(this.lease.expiresAt);
    const free = this.lease.holder === null || expiry === null || expiry <= now;
    const mine = this.lease.holder === owner;
    if (!free && !mine) return Promise.resolve(null);

    this.lease = {
      holder: owner,
      fence: mine ? this.lease.fence : this.lease.fence + 1,
      acquiredAt: mine ? (this.lease.acquiredAt ?? new Date(now).toISOString()) : new Date(now).toISOString(),
      expiresAt: new Date(now + ttlMs).toISOString(),
    };
    return Promise.resolve({
      workbookKey: WORKBOOK,
      owner,
      fence: this.lease.fence,
      acquiredAt: this.lease.acquiredAt as string,
      expiresAt: this.lease.expiresAt as string,
    });
  }

  releaseLease(claim: FenceClaim): Promise<void> {
    this.calls.push('releaseLease');
    const queued = this.failNext.releaseLease;
    if (queued !== undefined) {
      this.failNext = { ...this.failNext, releaseLease: undefined };
      return Promise.reject(new Error(queued));
    }
    if (this.lease.holder === claim.owner && this.lease.fence === claim.fence) {
      this.lease = { ...this.lease, holder: null, acquiredAt: null, expiresAt: null };
    }
    return Promise.resolve();
  }

  /** `public.assert_sheet_lease`, refusal for refusal. */
  private assertLease(claim: FenceClaim): void {
    if (this.lease.holder !== claim.owner) {
      throw new Error(
        `${SQL_REFUSALS.leaseLost}: the sync lease for "${WORKBOOK}" is held by ${this.lease.holder ?? '(nobody)'}, not ${claim.owner}`,
      );
    }
    if (this.lease.fence !== claim.fence) {
      throw new Error(`${SQL_REFUSALS.fenceStale}: fence ${claim.fence} is stale`);
    }
    const expiry = this.lease.expiresAt === null ? null : Date.parse(this.lease.expiresAt);
    if (expiry === null || expiry <= this.clock().getTime()) {
      throw new Error(`${SQL_REFUSALS.leaseExpired}: the sync lease for "${WORKBOOK}" expired`);
    }
  }

  // -- what the real workbook-state row does --------------------------------

  readVerificationState(): VerificationState {
    return {
      lastVerifiedAt: this.state.lastVerifiedAt,
      verifiedStages: this.state.verifiedStages,
      schemaDrifted: this.state.schemaDrifted,
    };
  }

  writeVerificationState(next: VerificationState): Promise<void> {
    this.calls.push('writeVerificationState');
    // THE DEFECT'S REFUSAL. Measured: SQLSTATE 22023 from
    // rpc_write_workbook_verification. This is what became a 500.
    if (next.schemaDrifted && next.verifiedStages.length > 0) {
      return Promise.reject(
        new Error(
          `${SQL_REFUSALS.driftWithVerifiedStages}: a verification cannot report drift and list verified tabs at the same time`,
        ),
      );
    }
    this.state = {
      lastVerifiedAt: next.lastVerifiedAt,
      verifiedStages: next.verifiedStages,
      schemaDrifted: next.schemaDrifted,
      problems: next.schemaDrifted ? this.state.problems : [],
    };
    return Promise.resolve();
  }

  markSchemaDrifted(args: {
    readonly claim: FenceClaim;
    readonly problems: readonly SchemaProblem[];
  }): Promise<void> {
    this.calls.push('markSchemaDrifted');
    const queued = this.failNext.markSchemaDrifted;
    if (queued !== undefined) {
      this.failNext = { ...this.failNext, markSchemaDrifted: undefined };
      return Promise.reject(new Error(queued));
    }
    try {
      this.assertLease(args.claim);
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    if (args.problems.length === 0) {
      return Promise.reject(
        new Error(`${SQL_REFUSALS.problemsRequired}: drift is recorded with its divergences`),
      );
    }
    this.state = {
      lastVerifiedAt: null,
      verifiedStages: [],
      schemaDrifted: true,
      problems: args.problems,
    };
    return Promise.resolve();
  }

  clearSchemaDrift(args: {
    readonly claim: FenceClaim;
    readonly actorId: string | null;
    readonly verifiedAt: string;
    readonly verifiedStages: readonly Stage[];
  }): Promise<number> {
    this.calls.push('clearSchemaDrift');
    const queued = this.failNext.clearSchemaDrift;
    if (queued !== undefined) {
      this.failNext = { ...this.failNext, clearSchemaDrift: undefined };
      return Promise.reject(new Error(queued));
    }
    try {
      this.assertLease(args.claim);
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    // THE GUARD, as measured: counted against the stage enum, so a partial or
    // empty list is refused. This is what stops "mark it fine".
    const named = new Set(args.verifiedStages);
    if (named.size !== STAGES.length) {
      return Promise.reject(
        new Error(
          `${SQL_REFUSALS.partialVerification}: the drift block is lifted only by a read that cleared all ${STAGES.length} operational tabs; this call cleared ${named.size}`,
        ),
      );
    }
    const cleared = this.state.problems.length;
    this.state = {
      lastVerifiedAt: args.verifiedAt,
      verifiedStages: args.verifiedStages,
      schemaDrifted: false,
      problems: [],
    };
    // Written in the same act as the clearing, as the real RPC does.
    this.audit.push({
      action: 'sheet_sync.schema_drift_cleared',
      actorId: args.actorId,
      at: args.verifiedAt,
      problemsCleared: cleared,
      verifiedStages: args.verifiedStages,
    });
    return Promise.resolve(cleared);
  }
}

// ---------------------------------------------------------------------------
// Driving the real sequence
// ---------------------------------------------------------------------------

interface RunOptions {
  readonly mayLatch?: boolean;
  readonly clearRequested?: boolean;
  readonly actorId?: string | null;
  readonly correlationId?: string;
  readonly now?: Date;
}

/**
 * One POST /schema-verify, minus the HTTP and the authorisation: read the
 * workbook through the real fake adapter, run the real `verifySchema`, hand it
 * to the real `runDriftRecovery`.
 */
async function runCheck(
  sheets: FakeGoogleSheetsAdapter,
  store: FakeSyncStore,
  options: RunOptions = {},
): Promise<DriftOutcome & { readonly ok: boolean; readonly problems: readonly SchemaProblem[] }> {
  const reading = await sheets.verifyWorkbook(STAGES);
  const schema = verifySchema(reading.reading, STAGES);
  const checkedAt = (options.now ?? new Date()).toISOString();
  const previous = store.readVerificationState();

  const outcome = await runDriftRecovery(
    {
      store,
      correlationId: options.correlationId ?? 'corr-0001',
      actorId: options.actorId ?? 'user-admin',
      now: () => options.now ?? new Date(),
      log: () => undefined,
    },
    {
      verification: schema,
      requiredStages: STAGES,
      previouslyDrifted: previous.schemaDrifted,
      mayLatch: options.mayLatch ?? true,
      clearRequested: options.clearRequested ?? false,
      checkedAt,
    },
  );

  return { ...outcome, ok: schema.ok, problems: schema.problems };
}

/** The live fault: the legacy self-filling sample-ID formula in A5. */
function plantLegacyFormulas(workbook: FakeWorkbook, stages: readonly Stage[] = STAGES): void {
  for (const stage of stages) workbook.setA5Formula(stage, LEGACY_FORMULA);
}

function clearLegacyFormulas(workbook: FakeWorkbook, stages: readonly Stage[] = STAGES): void {
  for (const stage of stages) workbook.setA5Formula(stage, null);
}

// ===========================================================================
// 1. The instruments
// ===========================================================================

describe('the double is faithful to the measured SQL', () => {
  it('refuses the pair that produced the 500, and accepts both halves alone', async () => {
    const store = new FakeSyncStore();
    store.state = {
      lastVerifiedAt: null,
      verifiedStages: [],
      schemaDrifted: true,
      problems: [{ kind: 'legacy_id_formula_present', stage: 'ground', message: 'A5' }],
    };

    // The exact call the old clean branch made, and the exact refusal.
    await expect(
      store.writeVerificationState({
        lastVerifiedAt: '2026-10-26T23:15:00.000Z',
        verifiedStages: STAGES,
        schemaDrifted: true,
      }),
    ).rejects.toThrow(SQL_REFUSALS.driftWithVerifiedStages);

    // POSITIVE CONTROL 1: same call, drift false. Measured to succeed.
    await expect(
      store.writeVerificationState({
        lastVerifiedAt: '2026-10-26T23:15:00.000Z',
        verifiedStages: STAGES,
        schemaDrifted: false,
      }),
    ).resolves.toBeUndefined();

    // POSITIVE CONTROL 2: drift true, no verified stage. Measured to succeed —
    // so the refusal is specific to the PAIR, not to the call.
    await expect(
      store.writeVerificationState({
        lastVerifiedAt: '2026-10-26T23:15:00.000Z',
        verifiedStages: [],
        schemaDrifted: true,
      }),
    ).resolves.toBeUndefined();
  });

  it('takes over an EXPIRED lease and bumps the fence, as measured', async () => {
    const now = new Date('2026-10-26T23:20:00.000Z');
    const store = new FakeSyncStore(() => now);
    // The live row: holder set, expiry twenty minutes in the past, fence 1.
    store.lease = {
      holder: 'e7301ecb-3f43-4086-beca-8b26e2b44c66',
      fence: 1,
      acquiredAt: '2026-10-26T22:58:12.000Z',
      expiresAt: '2026-10-26T22:59:12.000Z',
    };

    const taken = await store.acquireLease('new-run', DEFAULT_LEASE_TTL_MS);
    expect(taken).not.toBeNull();
    expect(taken!.owner).toBe('new-run');
    expect(taken!.fence).toBe(2); // 1 -> 2, measured against the real RPC

    // POSITIVE CONTROL: a LIVE lease held by somebody else is NOT taken over,
    // so the takeover above is a property of expiry rather than of the double.
    const contended = new FakeSyncStore(() => now);
    contended.lease = {
      holder: 'other-run',
      fence: 4,
      acquiredAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 60_000).toISOString(),
    };
    expect(await contended.acquireLease('new-run', DEFAULT_LEASE_TTL_MS)).toBeNull();
  });

  it('plants a fault the real check actually catches (instrument check)', async () => {
    const workbook = new FakeWorkbook();
    const sheets = new FakeGoogleSheetsAdapter(workbook);

    // Clean to start with: if this were not true, every "drift found" below
    // would pass vacuously.
    const before = verifySchema((await sheets.verifyWorkbook(STAGES)).reading, STAGES);
    expect(before.ok).toBe(true);
    expect(before.verifiedStages).toHaveLength(STAGES.length);

    plantLegacyFormulas(workbook);
    const after = verifySchema((await sheets.verifyWorkbook(STAGES)).reading, STAGES);
    expect(after.ok).toBe(false);
    expect(after.problems.filter((p) => p.kind === 'legacy_id_formula_present')).toHaveLength(
      STAGES.length,
    );
  });
});

// ===========================================================================
// 2. The incident, end to end
// ===========================================================================

describe('drift found and latched -> workbook fixed -> re-run passes and the latch lifts', () => {
  it('walks the whole 18:58 -> 19:12 -> 19:1x sequence without a single throw', async () => {
    const workbook = new FakeWorkbook();
    const sheets = new FakeGoogleSheetsAdapter(workbook);
    const store = new FakeSyncStore();

    // --- before: a clean workbook verifies and records nothing alarming ----
    const first = await runCheck(sheets, store);
    expect(first.ok).toBe(true);
    expect(first.plan.action).toBe<DriftAction>('record_clean');
    expect(first.drifted).toBe(false);
    expect(store.state.schemaDrifted).toBe(false);
    expect(store.state.verifiedStages).toHaveLength(STAGES.length);

    // --- 18:58: the legacy A5 formula appears on all seven tabs ------------
    plantLegacyFormulas(workbook);
    const latched = await runCheck(sheets, store, { correlationId: 'corr-1858' });
    expect(latched.ok).toBe(false);
    expect(latched.plan.action).toBe<DriftAction>('latch_drift');
    expect(latched.driftLatched).toBe(true);
    expect(latched.drifted).toBe(true);
    expect(store.state.schemaDrifted).toBe(true);
    expect(store.state.problems).toHaveLength(STAGES.length);
    // A drifted workbook has no writable tab.
    expect(store.state.verifiedStages).toEqual([]);
    // Defect 3: the lease was never released. It is now.
    expect(latched.leaseReleased).toBe(true);
    expect(store.lease.holder).toBeNull();
    // The message names the tabs, which the generic 500 never did.
    expect(latched.explanation.affectedTabs).toHaveLength(STAGES.length);

    // --- 19:12: the operator does exactly what the check asked -------------
    clearLegacyFormulas(workbook);

    // --- 19:1x: the re-run. This is where it used to return 500. -----------
    const recovered = await runCheck(sheets, store, {
      correlationId: 'corr-1915',
      actorId: 'user-admin',
    });
    expect(recovered.ok).toBe(true);
    expect(recovered.plan.action).toBe<DriftAction>('lift_latch');
    expect(recovered.driftLifted).toBe(true);
    expect(recovered.stateWriteFailed).toBe(false);
    expect(recovered.drifted).toBe(false);
    expect(recovered.problemsCleared).toBe(STAGES.length);

    // The stored state really changed, not just the response.
    expect(store.state.schemaDrifted).toBe(false);
    expect(store.state.problems).toEqual([]);
    expect(store.state.verifiedStages).toHaveLength(STAGES.length);
    expect(store.state.lastVerifiedAt).not.toBeNull();

    // An audit event saying so, with who and when.
    expect(store.audit).toHaveLength(1);
    expect(store.audit[0]!.action).toBe('sheet_sync.schema_drift_cleared');
    expect(store.audit[0]!.actorId).toBe('user-admin');
    expect(store.audit[0]!.at).toBe(recovered.plan.verification?.lastVerifiedAt ?? store.state.lastVerifiedAt);
    expect(store.audit[0]!.problemsCleared).toBe(STAGES.length);

    // And the lease is handed back again.
    expect(recovered.leaseReleased).toBe(true);
    expect(store.lease.holder).toBeNull();

    // --- and a fourth run over the now-clean, now-unlatched workbook -------
    const steady = await runCheck(sheets, store);
    expect(steady.plan.action).toBe<DriftAction>('record_clean');
    expect(steady.drifted).toBe(false);
    expect(steady.driftLifted).toBe(false); // nothing left to lift
    expect(store.audit).toHaveLength(1); // not audited twice
  });

  it('never sends the pair that produced the 500, over the whole sequence', async () => {
    const workbook = new FakeWorkbook();
    const sheets = new FakeGoogleSheetsAdapter(workbook);
    const store = new FakeSyncStore();

    const sent: VerificationState[] = [];
    const original = store.writeVerificationState.bind(store);
    store.writeVerificationState = (next: VerificationState): Promise<void> => {
      sent.push(next);
      return original(next);
    };

    await runCheck(sheets, store);
    plantLegacyFormulas(workbook);
    await runCheck(sheets, store);
    clearLegacyFormulas(workbook);
    await runCheck(sheets, store);

    expect(sent.length).toBeGreaterThan(0); // instrument check
    for (const state of sent) {
      expect(verificationWriteRefusal(state)).toBeNull();
    }
  });
});

// ===========================================================================
// 3. The latch is NOT lifted while the problem persists
// ===========================================================================

describe('the latch survives anything short of a fully passing read', () => {
  /** Latch the workbook, then hand back a store that is in the 19:12 state. */
  async function latched(): Promise<{
    workbook: FakeWorkbook;
    sheets: FakeGoogleSheetsAdapter;
    store: FakeSyncStore;
  }> {
    const workbook = new FakeWorkbook();
    const sheets = new FakeGoogleSheetsAdapter(workbook);
    const store = new FakeSyncStore();
    plantLegacyFormulas(workbook);
    const first = await runCheck(sheets, store);
    expect(first.driftLatched).toBe(true); // instrument check
    expect(store.state.schemaDrifted).toBe(true);
    return { workbook, sheets, store };
  }

  it('does not lift while ONE tab still carries the formula, and does once it does not', async () => {
    const { workbook, sheets, store } = await latched();

    // Six of seven repaired. A partial fix is not a fix.
    clearLegacyFormulas(workbook);
    workbook.setA5Formula('mash', LEGACY_FORMULA);

    const partial = await runCheck(sheets, store);
    expect(partial.ok).toBe(false);
    expect(partial.plan.action).not.toBe<DriftAction>('lift_latch');
    expect(partial.driftLifted).toBe(false);
    expect(store.state.schemaDrifted).toBe(true);
    expect(store.audit).toHaveLength(0);
    expect(partial.explanation.affectedTabs).toEqual([STAGE_SCHEMAS.mash.sheetTab]);

    // POSITIVE CONTROL: the seventh tab too, and now it lifts. Without this,
    // the assertion above would pass for a path that never lifts anything.
    workbook.setA5Formula('mash', null);
    const full = await runCheck(sheets, store);
    expect(full.plan.action).toBe<DriftAction>('lift_latch');
    expect(store.state.schemaDrifted).toBe(false);
    expect(store.audit).toHaveLength(1);
  });

  it('does not lift over a MOVED HEADER, and does once it is put back', async () => {
    const { workbook, sheets, store } = await latched();
    clearLegacyFormulas(workbook);

    const originalHeader = workbook.rawRow('ground', 4)?.[5] ?? '';
    expect(originalHeader).not.toBe(''); // instrument check
    workbook.setHeader('ground', 5, 'Moisture (renamed by hand)');

    const moved = await runCheck(sheets, store);
    expect(moved.ok).toBe(false);
    expect(moved.driftLifted).toBe(false);
    expect(store.state.schemaDrifted).toBe(true);

    // POSITIVE CONTROL: restore the header and the same call lifts it.
    workbook.setHeader('ground', 5, originalHeader);
    const restored = await runCheck(sheets, store);
    expect(restored.plan.action).toBe<DriftAction>('lift_latch');
    expect(store.state.schemaDrifted).toBe(false);
  });

  it('does not lift for a caller without the latch permission, and does for one with it', async () => {
    const { workbook, sheets, store } = await latched();
    clearLegacyFormulas(workbook);

    const viewer = await runCheck(sheets, store, { mayLatch: false });
    expect(viewer.ok).toBe(true); // told the truth about the headings
    expect(viewer.plan.action).toBe<DriftAction>('latch_stands');
    expect(viewer.driftLifted).toBe(false);
    expect(viewer.drifted).toBe(true);
    expect(store.state.schemaDrifted).toBe(true);
    // And it must not have touched the re-check clock either.
    expect(store.state.lastVerifiedAt).toBeNull();
    expect(store.calls).not.toContain('clearSchemaDrift');
    expect(viewer.explanation.whatToDo).toMatch(/synchronisation rights/i);

    // POSITIVE CONTROL: the same workbook, a caller who may latch.
    const admin = await runCheck(sheets, store, { mayLatch: true });
    expect(admin.plan.action).toBe<DriftAction>('lift_latch');
    expect(store.state.schemaDrifted).toBe(false);
  });

  it('does not lift when the lease is held by a live run, and does once it is free', async () => {
    const now = new Date('2026-10-26T23:30:00.000Z');
    const workbook = new FakeWorkbook();
    const sheets = new FakeGoogleSheetsAdapter(workbook);
    const store = new FakeSyncStore(() => now);
    plantLegacyFormulas(workbook);
    await runCheck(sheets, store, { now });
    expect(store.state.schemaDrifted).toBe(true);
    clearLegacyFormulas(workbook);

    // Another run holds a LIVE lease.
    store.lease = {
      holder: 'other-run',
      fence: 9,
      acquiredAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 60_000).toISOString(),
    };

    const contended = await runCheck(sheets, store, { now });
    expect(contended.plan.action).toBe<DriftAction>('lift_latch'); // it tried
    expect(contended.driftLifted).toBe(false); // and could not
    expect(contended.stateWriteFailed).toBe(true);
    expect(store.state.schemaDrifted).toBe(true);
    // It must not have stolen or released somebody else's lease.
    expect(store.lease.holder).toBe('other-run');
    expect(store.lease.fence).toBe(9);
    expect(contended.explanation.message).toMatch(/still stopped/i);

    // POSITIVE CONTROL: free the lease and the same call succeeds.
    store.lease = { holder: null, fence: 9, acquiredAt: null, expiresAt: null };
    const freed = await runCheck(sheets, store, { now });
    expect(freed.driftLifted).toBe(true);
    expect(store.state.schemaDrifted).toBe(false);
  });

  it('refuses a partial or empty stage list at the store boundary too', async () => {
    // The caller-side planner is one guard; this is the other. A second caller
    // that bypassed `planDriftRecovery` still cannot clear.
    const now = new Date('2026-10-26T23:35:00.000Z');
    const store = new FakeSyncStore(() => now);
    store.state = {
      lastVerifiedAt: null,
      verifiedStages: [],
      schemaDrifted: true,
      problems: [{ kind: 'legacy_id_formula_present', stage: 'ground', message: 'A5' }],
    };
    const lease = await store.acquireLease('run-1', DEFAULT_LEASE_TTL_MS);
    const claim: FenceClaim = { owner: lease!.owner, fence: lease!.fence };

    for (const stages of [[] as Stage[], ['raw_materials', 'ground'] as Stage[]]) {
      await expect(
        store.clearSchemaDrift({
          claim,
          actorId: 'user-admin',
          verifiedAt: now.toISOString(),
          verifiedStages: stages,
        }),
      ).rejects.toThrow(SQL_REFUSALS.partialVerification);
    }
    expect(store.state.schemaDrifted).toBe(true);

    // POSITIVE CONTROL: every stage named, and it clears.
    await expect(
      store.clearSchemaDrift({
        claim,
        actorId: 'user-admin',
        verifiedAt: now.toISOString(),
        verifiedStages: STAGES,
      }),
    ).resolves.toBe(1);
    expect(store.state.schemaDrifted).toBe(false);
  });
});

// ===========================================================================
// 4. The plan can never produce the forbidden pair, over the whole space
// ===========================================================================

describe('planDriftRecovery: the invariant that broke production, enumerated', () => {
  const partialStages: readonly Stage[] = STAGES.slice(0, 3);
  const spaces = {
    schemaOk: [true, false],
    verifiedStages: [STAGES, partialStages, [] as readonly Stage[]],
    previouslyDrifted: [true, false],
    mayLatch: [true, false],
  };

  interface Case {
    readonly inputs: {
      readonly schemaOk: boolean;
      readonly verifiedStages: readonly Stage[];
      readonly previouslyDrifted: boolean;
      readonly mayLatch: boolean;
    };
    readonly plan: ReturnType<typeof planDriftRecovery>;
  }

  const all = (): Case[] => {
    const out: Case[] = [];
    for (const schemaOk of spaces.schemaOk) {
      for (const verifiedStages of spaces.verifiedStages) {
        for (const previouslyDrifted of spaces.previouslyDrifted) {
          for (const mayLatch of spaces.mayLatch) {
            const inputs = { schemaOk, verifiedStages, previouslyDrifted, mayLatch };
            out.push({
              inputs,
              plan: planDriftRecovery({
                ...inputs,
                requiredStages: STAGES,
                checkedAt: '2026-10-26T23:40:00.000Z',
              }),
            });
          }
        }
      }
    }
    return out;
  };

  it('enumerates the whole cross-product (instrument check)', () => {
    expect(all()).toHaveLength(
      spaces.schemaOk.length *
        spaces.verifiedStages.length *
        spaces.previouslyDrifted.length *
        spaces.mayLatch.length,
    );
  });

  it('never plans a write that reports drift AND lists verified tabs', () => {
    let writes = 0;
    for (const { plan } of all()) {
      if (plan.verification === null) continue;
      writes++;
      expect(verificationWriteRefusal(plan.verification)).toBeNull();
    }
    // POSITIVE CONTROL: some inputs DO plan a write, so the loop is not empty.
    expect(writes).toBeGreaterThan(0);
  });

  it('plans lift_latch ONLY when the read passed on every required stage', () => {
    let lifts = 0;
    for (const { inputs, plan } of all()) {
      if (plan.action !== 'lift_latch') continue;
      lifts++;
      expect(inputs.schemaOk).toBe(true);
      expect(inputs.verifiedStages).toHaveLength(STAGES.length);
      expect(inputs.previouslyDrifted).toBe(true);
      expect(inputs.mayLatch).toBe(true);
      expect(plan.fullyVerified).toBe(true);
    }
    // POSITIVE CONTROL: exactly one of the twenty-four inputs reaches it, so
    // the assertions above are neither vacuous nor over-broad.
    expect(lifts).toBe(1);
  });

  it('never lifts on a partial pass even if `ok` were somehow true', () => {
    // The guard against a future change to verifySchema: `ok` true with an
    // incomplete verified list must not lift.
    const plan = planDriftRecovery({
      schemaOk: true,
      verifiedStages: partialStages,
      requiredStages: STAGES,
      previouslyDrifted: true,
      mayLatch: true,
      checkedAt: '2026-10-26T23:40:00.000Z',
    });
    expect(plan.action).toBe<DriftAction>('latch_stands');
    expect(plan.fullyVerified).toBe(false);
    expect(plan.driftedAfter).toBe(true);
  });

  it('a STANDING latch is only ever dropped by a fully clean read', () => {
    // Stated over the cases that actually had a latch. An unlatched workbook
    // ending up unlatched is not the property under test, and including it is
    // what made the first version of this assertion fail against correct code.
    let standing = 0;
    for (const { inputs, plan } of all()) {
      if (!inputs.previouslyDrifted) continue;
      standing++;
      if (plan.driftedAfter) continue;
      expect(plan.action).toBe<DriftAction>('lift_latch');
      expect(plan.fullyVerified).toBe(true);
    }
    expect(standing).toBe(12); // instrument check: half the cross-product
  });
});

// ===========================================================================
// 5. A latched or blocked state never throws
// ===========================================================================

describe('a latched, blocked or failing state returns a readable answer, not a 500', () => {
  it('survives a store that throws on the latch, and still releases the lease', async () => {
    const workbook = new FakeWorkbook();
    const sheets = new FakeGoogleSheetsAdapter(workbook);
    const store = new FakeSyncStore();
    plantLegacyFormulas(workbook);
    store.failNext = { markSchemaDrifted: 'connection reset by peer' };

    const outcome = await runCheck(sheets, store);
    expect(outcome.driftLatched).toBe(false);
    expect(outcome.stateWriteFailed).toBe(true);
    // Defect 3, the case that matters most: a FAILURE path must still release.
    expect(outcome.leaseReleased).toBe(true);
    expect(store.lease.holder).toBeNull();
    // And the operator still gets the findings and the tabs.
    expect(outcome.explanation.affectedTabs).toHaveLength(STAGES.length);
    expect(outcome.explanation.message).toMatch(/no longer match/i);
  });

  it('survives a store that throws on the lift, and still releases the lease', async () => {
    const workbook = new FakeWorkbook();
    const sheets = new FakeGoogleSheetsAdapter(workbook);
    const store = new FakeSyncStore();
    plantLegacyFormulas(workbook);
    await runCheck(sheets, store);
    clearLegacyFormulas(workbook);

    store.failNext = { clearSchemaDrift: 'statement timeout' };
    const outcome = await runCheck(sheets, store);
    expect(outcome.driftLifted).toBe(false);
    expect(outcome.stateWriteFailed).toBe(true);
    expect(outcome.leaseReleased).toBe(true);
    expect(store.lease.holder).toBeNull();
    expect(store.state.schemaDrifted).toBe(true); // latch correctly survives

    // POSITIVE CONTROL: without the injected failure the same call lifts it,
    // so "did not lift" above is the failure and not the normal outcome.
    const retry = await runCheck(sheets, store);
    expect(retry.driftLifted).toBe(true);
    expect(store.state.schemaDrifted).toBe(false);
  });

  it('survives a release that itself fails, without losing the real outcome', async () => {
    const workbook = new FakeWorkbook();
    const sheets = new FakeGoogleSheetsAdapter(workbook);
    const store = new FakeSyncStore();
    plantLegacyFormulas(workbook);
    store.failNext = { releaseLease: 'connection closed' };

    const outcome = await runCheck(sheets, store);
    // The latch landed; a bookkeeping failure must not replace that fact.
    expect(outcome.driftLatched).toBe(true);
    expect(outcome.stateWriteFailed).toBe(false);
    expect(outcome.leaseReleased).toBe(false); // reported, not hidden
    expect(store.state.schemaDrifted).toBe(true);
  });

  it('gives every plan a message, a remedy, and no exception text', async () => {
    const seen = new Set<DriftAction>();
    const scenarios: Array<() => Promise<DriftOutcome>> = [
      // record_clean
      async () => await runCheck(new FakeGoogleSheetsAdapter(new FakeWorkbook()), new FakeSyncStore()),
      // latch_drift
      async () => {
        const w = new FakeWorkbook();
        plantLegacyFormulas(w);
        return await runCheck(new FakeGoogleSheetsAdapter(w), new FakeSyncStore());
      },
      // report_drift_only
      async () => {
        const w = new FakeWorkbook();
        plantLegacyFormulas(w);
        return await runCheck(new FakeGoogleSheetsAdapter(w), new FakeSyncStore(), {
          mayLatch: false,
        });
      },
      // lift_latch
      async () => {
        const w = new FakeWorkbook();
        const s = new FakeGoogleSheetsAdapter(w);
        const store = new FakeSyncStore();
        plantLegacyFormulas(w);
        await runCheck(s, store);
        clearLegacyFormulas(w);
        return await runCheck(s, store);
      },
      // latch_stands
      async () => {
        const w = new FakeWorkbook();
        const s = new FakeGoogleSheetsAdapter(w);
        const store = new FakeSyncStore();
        plantLegacyFormulas(w);
        await runCheck(s, store);
        clearLegacyFormulas(w);
        return await runCheck(s, store, { mayLatch: false });
      },
    ];

    for (const scenario of scenarios) {
      const outcome = await scenario();
      seen.add(outcome.plan.action);
      expect(outcome.explanation.message.length).toBeGreaterThan(20);
      expect(outcome.explanation.whatToDo.length).toBeGreaterThan(0);
      // The sentence an operator reads must never be the generic one, and
      // never an exception.
      expect(outcome.explanation.message).not.toMatch(/Something went wrong/i);
      expect(outcome.explanation.message).not.toMatch(/BFF_|SQLSTATE|Error:/);
      expect(outcome.explanation.whatToDo).not.toMatch(/BFF_|SQLSTATE|Error:/);
      expect(outcome.explanation.whatToDo).not.toMatch(/service_role|UPDATE |database directly/i);
    }
    // Every plan was reached, so the loop above covered the whole vocabulary.
    expect([...seen].sort()).toEqual(
      ['latch_drift', 'latch_stands', 'lift_latch', 'record_clean', 'report_drift_only'].sort(),
    );
  });
});

// ===========================================================================
// 6. The explicit clear_drift action
// ===========================================================================

describe('clear_drift re-reads and refuses with what is still wrong', () => {
  it('is a real action, gated on the same permission as latching', () => {
    expect(SCHEMA_VERIFY_ACTIONS).toContain('clear_drift');
    expect(SCHEMA_VERIFY_ACTION_PERMISSION.clear_drift).toBe(SCHEMA_DRIFT_LATCH_PERMISSION);
    // The read-only ask stays available to a viewer.
    expect(SCHEMA_VERIFY_ACTION_PERMISSION.verify_headers).toBe('sync.view');
  });

  it('refuses while the problem is live, naming the tabs, and clears once it is gone', async () => {
    const workbook = new FakeWorkbook();
    const sheets = new FakeGoogleSheetsAdapter(workbook);
    const store = new FakeSyncStore();
    plantLegacyFormulas(workbook);
    await runCheck(sheets, store);
    expect(store.state.schemaDrifted).toBe(true);

    // Still broken, and an operator explicitly asks to clear the block.
    const refused = await runCheck(sheets, store, { clearRequested: true });
    expect(refused.ok).toBe(false);
    expect(refused.driftLifted).toBe(false);
    expect(store.state.schemaDrifted).toBe(true);
    expect(refused.explanation.message).toMatch(/cannot be cleared/i);
    expect(refused.explanation.affectedTabs).toHaveLength(STAGES.length);
    for (const stage of STAGES) {
      expect(refused.explanation.message).toContain(STAGE_SCHEMAS[stage].sheetTab);
    }

    // POSITIVE CONTROL: fix it, ask again, and the same action clears it.
    clearLegacyFormulas(workbook);
    const cleared = await runCheck(sheets, store, { clearRequested: true });
    expect(cleared.driftLifted).toBe(true);
    expect(store.state.schemaDrifted).toBe(false);
    expect(store.audit).toHaveLength(1);
  });

  it('says plainly when there was no block to clear', async () => {
    const workbook = new FakeWorkbook();
    const outcome = await runCheck(
      new FakeGoogleSheetsAdapter(workbook),
      new FakeSyncStore(),
      { clearRequested: true },
    );
    expect(outcome.plan.action).toBe<DriftAction>('record_clean');
    expect(outcome.explanation.message).toMatch(/nothing to clear/i);
  });

  it('names the affected tabs in registry order, including a reference tab', () => {
    const problems: readonly SchemaProblem[] = [
      { kind: 'legacy_id_formula_present', stage: 'mash', message: 'A5' },
      { kind: 'legacy_id_formula_present', stage: 'raw_materials', message: 'A5' },
      { kind: 'reference_tab_missing', tab: 'Specifications', message: 'gone' },
    ];
    const tabs = affectedTabs(problems);
    expect(tabs[0]).toBe(STAGE_SCHEMAS.raw_materials.sheetTab);
    expect(tabs[1]).toBe(STAGE_SCHEMAS.mash.sheetTab);
    expect(tabs).toContain('Specifications');
    // The refusal carries them through.
    expect(clearRefusal(problems).affectedTabs).toEqual(tabs);
    expect(clearRefusal(problems).message).toContain('3 problem(s)');
  });
});

// ===========================================================================
// 7. The advertised settings now match the code
// ===========================================================================

describe('system_config advertises what the code actually does', () => {
  const sql = readFileSync(
    join(process.cwd(), 'supabase/migrations/0022_schema_drift_recovery.sql'),
    'utf8',
  );

  /**
   * The value 0022 writes for one key.
   *
   * Split per UPDATE statement rather than matched across the whole file: a
   * lazy `[\s\S]*?` between the value and the key happily spans from ONE
   * statement's value to a LATER statement's key, which is how the first
   * version of this test reported the attempt ceiling as the lease TTL. A
   * parser that can cross a statement boundary is not reading rows.
   */
  const advertised = (key: string): string | null => {
    for (const chunk of sql.split(/update\s+public\.system_config/i).slice(1)) {
      if (!new RegExp(`where key = '${key}'`).test(chunk)) continue;
      const value = /set\s+value\s*=\s*'([^']*)'/.exec(chunk);
      return value === null ? null : value[1]!;
    }
    return null;
  };

  it('reads one row per key (instrument check)', () => {
    // Without this, a parser that returned null for everything would make both
    // assertions below fail loudly rather than pass vacuously — but a parser
    // that returned the SAME value for every key would pass one and fail the
    // other confusingly. Prove the two keys resolve to different rows first.
    expect(advertised('sheet_sync_lease_seconds')).not.toBeNull();
    expect(advertised('sheet_sync_max_attempts')).not.toBeNull();
    expect(advertised('sheet_sync_lease_seconds')).not.toBe(
      advertised('sheet_sync_max_attempts'),
    );
    expect(advertised('no_such_key_in_this_migration')).toBeNull();
  });

  it('corrects the lease TTL to the value lease.ts uses', () => {
    // An operator reading system_config predicted a 120-second lease and 8
    // attempts; the code used 60 seconds and 6. Asserted against the constants
    // rather than against the literals, so the next divergence fails here.
    const expected = String(DEFAULT_LEASE_TTL_MS / 1000);
    expect(expected).toBe('60'); // instrument check on the constant itself
    expect(advertised('sheet_sync_lease_seconds')).toBe(expected);
  });

  it('corrects the attempt ceiling to the value backoff.ts uses', () => {
    const expected = String(DEFAULT_BACKOFF.maxAttempts);
    expect(expected).toBe('6'); // instrument check on the constant itself
    expect(advertised('sheet_sync_max_attempts')).toBe(expected);
  });
});
