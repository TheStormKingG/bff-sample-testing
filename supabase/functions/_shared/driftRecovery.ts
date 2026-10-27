/**
 * What a header check is allowed to do to the drift latch, and the sequence
 * that does it.
 *
 * ===========================================================================
 * THE DEFECT THIS MODULE EXISTS TO PREVENT
 * ===========================================================================
 * The latch was write-only. `schema-verify` recorded `schema_drifted = true`
 * when it saw a problem and then, on every later run, carried that flag
 * forward verbatim while ALSO reporting the stages it had just verified:
 *
 *     await store.writeVerificationState({
 *       lastVerifiedAt: checkedAt,
 *       verifiedStages: schema.verifiedStages,   // all seven, after a repair
 *       schemaDrifted: previous.schemaDrifted,   // still true
 *     });
 *
 * `rpc_write_workbook_verification` refuses exactly that pair — a verification
 * cannot report drift and list verified tabs at the same time, because
 * `verified_stages` IS the worker's write permit and a fenced-off workbook has
 * no writable tab. The refusal raises SQLSTATE 22023, `mapRpcError` turns any
 * unrecognised RPC error into `ApiError('internal')`, and the operator who had
 * just FIXED the workbook got
 * `{"code":"internal","message":"Something went wrong. Nothing was saved."}`
 * on every subsequent check. Measured against a local database before any of
 * this was written; `tests/schemaDriftRecovery.test.ts` drives the same states
 * through the code below.
 *
 * So the rule this module enforces, and the reason it is a module rather than
 * three lines inside the entrypoint (an entrypoint calls `Deno.serve` and
 * cannot be loaded by a test — "a policy that cannot be loaded by a test is a
 * policy nobody can show to be right"):
 *
 *   NO PLAN EVER WRITES `schemaDrifted: true` TOGETHER WITH A NON-EMPTY
 *   VERIFIED-STAGE LIST.
 *
 * The test asserts that over the whole input cross-product, not on a sample,
 * because the combination that broke production was reachable from exactly one
 * of sixteen input states.
 *
 * ===========================================================================
 * THE SAFETY PROPERTY
 * ===========================================================================
 * Clearing the latch is a CONSEQUENCE of a passing read of the live workbook,
 * never an independent switch. `planDriftRecovery` returns `lift_latch` only
 * when BOTH of these hold:
 *
 *   - `schemaOk` — `verifySchema` found no problem of any kind: no missing
 *     tab, no moved header, no legacy A5 formula, no unread stage, and both
 *     reference tabs present; and
 *   - every required stage appears in `verifiedStages` — an independent
 *     second condition over the same reading, so a future change that made
 *     `ok` true for a partial read could still not lift the latch.
 *
 * Neither input can be supplied by a caller. Both are derived by the handler
 * from what `GoogleSheetsApiAdapter.verifyWorkbook` actually read out of the
 * live workbook in the same request. There is no action, body field or
 * permission that reaches `lift_latch` without that read, and the explicit
 * `clear_drift` action goes through this same function — it is `verify_headers`
 * with a different message, not a different code path.
 *
 * Behind that, `rpc_clear_schema_drift` refuses any call that does not name
 * every operational stage, counted against the stage enum rather than a
 * literal list. So the guard holds in SQL even for a caller that bypasses this
 * module entirely.
 *
 * PURE: no Deno, no npm/jsr, no I/O of its own. Every database call goes
 * through the injected `DriftStore`, the clock through `now`, and the server
 * log through `log` — the same shape as `syncWorker.ts`.
 */

import { STAGE_SCHEMAS } from '../../../src/forms/registry.ts';
import { STAGES, type Stage } from '../../../src/forms/types.ts';
import type { SchemaProblem, SchemaVerification, VerificationState } from './headerCheck.ts';
import {
  DEFAULT_LEASE_TTL_MS,
  validateFence,
  type FenceClaim,
  type LeaseState,
} from './lease.ts';

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

/**
 * What this run may do to the latch.
 *
 *   latch_drift        the live read failed and this caller may record the stop
 *   report_drift_only  the live read failed and this caller may NOT record it
 *   lift_latch         the live read passed in full and lifts a standing latch
 *   latch_stands       the live read passed in full but this caller may not lift
 *   record_clean       the live read passed in full and no latch was standing
 */
export type DriftAction =
  | 'latch_drift'
  | 'report_drift_only'
  | 'lift_latch'
  | 'latch_stands'
  | 'record_clean';

export interface DriftPlan {
  readonly action: DriftAction;
  /**
   * True when the store write this plan implies is FENCED and therefore needs
   * the workbook lease first. Both state-changing plans are fenced: latching
   * and lifting are the same decision with opposite signs, and a stalled run
   * must not be able to lift a latch a newer run has just set.
   */
  readonly needsLease: boolean;
  /**
   * The unfenced verification row to write, or null when this plan writes
   * through a fenced call or writes nothing at all.
   *
   * `latch_stands` deliberately writes NOTHING. The latch and its evidence are
   * the fenced-off state; a run that may not lift it must not touch
   * `last_verified_at` either, or it would move the worker's re-check clock
   * while the workbook is still stopped.
   */
  readonly verification: VerificationState | null;
  /** Every required stage was read and matched. The precondition for lifting. */
  readonly fullyVerified: boolean;
  /** Whether the workbook stays fenced off if this plan succeeds. */
  readonly driftedAfter: boolean;
}

export interface DriftInputs {
  /** `verifySchema(...).ok` — no problem of any kind over the required stages. */
  readonly schemaOk: boolean;
  /** `verifySchema(...).verifiedStages`. */
  readonly verifiedStages: readonly Stage[];
  /** The stages the check was asked to cover. */
  readonly requiredStages: readonly Stage[];
  /** `schema_drifted` as the database held it BEFORE this run. */
  readonly previouslyDrifted: boolean;
  /** Does this caller hold the latch permission (or is it the scheduler)? */
  readonly mayLatch: boolean;
  /** The instant the live reading was taken. */
  readonly checkedAt: string;
}

/**
 * Decide what this run does to the latch.
 *
 * Total over its inputs by construction: `schemaOk` splits the space in two
 * and each half is decided by `mayLatch` and, on the clean side, by whether a
 * latch was standing. No branch falls through.
 */
export function planDriftRecovery(inputs: DriftInputs): DriftPlan {
  const cleared = new Set(inputs.verifiedStages);
  const fullyVerified =
    inputs.schemaOk && inputs.requiredStages.every((stage) => cleared.has(stage));

  if (!inputs.schemaOk) {
    // A failing read never writes a verified-stage list, so the forbidden pair
    // is unreachable from this half of the space regardless of `mayLatch`.
    return {
      action: inputs.mayLatch ? 'latch_drift' : 'report_drift_only',
      needsLease: inputs.mayLatch,
      verification: null,
      fullyVerified: false,
      driftedAfter: true,
    };
  }

  if (!fullyVerified) {
    /**
     * `ok` is true but a required stage is missing from the verified list.
     * `verifySchema` cannot currently produce this — an unread stage is a
     * `stage_not_read` problem and makes `ok` false — so this is a guard
     * against a future change to that function, not a reachable state today.
     * Treat it as a clean read that proves nothing: report, and never lift.
     */
    return {
      action: inputs.previouslyDrifted ? 'latch_stands' : 'record_clean',
      needsLease: false,
      verification: inputs.previouslyDrifted
        ? null
        : { lastVerifiedAt: inputs.checkedAt, verifiedStages: [], schemaDrifted: false },
      fullyVerified: false,
      driftedAfter: inputs.previouslyDrifted,
    };
  }

  if (!inputs.previouslyDrifted) {
    return {
      action: 'record_clean',
      needsLease: false,
      verification: {
        lastVerifiedAt: inputs.checkedAt,
        verifiedStages: inputs.verifiedStages,
        schemaDrifted: false,
      },
      fullyVerified: true,
      driftedAfter: false,
    };
  }

  if (!inputs.mayLatch) {
    return {
      action: 'latch_stands',
      needsLease: false,
      verification: null,
      fullyVerified: true,
      driftedAfter: true,
    };
  }

  return {
    action: 'lift_latch',
    needsLease: true,
    verification: null,
    fullyVerified: true,
    driftedAfter: false,
  };
}

/**
 * The combination `rpc_write_workbook_verification` refuses, stated on this
 * side of the boundary so a test can reach it.
 *
 * Returns the refusal text, or null when the row is writable.
 * `planDriftRecovery` already cannot produce the pair; this is checked before
 * every unfenced write so that a second planner, added later, fails as a
 * reported state rather than as a 500.
 */
export function verificationWriteRefusal(state: VerificationState): string | null {
  if (state.schemaDrifted && state.verifiedStages.length > 0) {
    return (
      'a verification cannot report drift and list verified tabs at the same time: ' +
      "verified_stages is the worker's write permit and a drifted workbook has no writable tab"
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// What the operator is told
// ---------------------------------------------------------------------------

/**
 * A latched or blocked state must READ, not throw.
 *
 * "Something went wrong. Nothing was saved. Please try again." is the right
 * sentence for a fault and the wrong one for a workbook that is deliberately
 * fenced off: it tells an operator nothing about which tabs are wrong or what
 * to do, and it is what made the live incident take an hour to diagnose. Every
 * plan therefore has a sentence, and the ones that name tabs name them.
 */
export interface DriftExplanation {
  /** One operator-facing sentence. Never an exception, never a code. */
  readonly message: string;
  /** The tabs a person has to go and look at. Empty when nothing is wrong. */
  readonly affectedTabs: readonly string[];
  /** The next action, in plain words. */
  readonly whatToDo: string;
}

/** Tab titles named by a problem list, de-duplicated, in registry order. */
export function affectedTabs(problems: readonly SchemaProblem[]): readonly string[] {
  const named = new Set<string>();
  for (const problem of problems) {
    if (problem.tab !== undefined) named.add(problem.tab);
    else if (problem.stage !== undefined) named.add(STAGE_SCHEMAS[problem.stage].sheetTab);
  }
  const ordered = STAGES.map((stage) => STAGE_SCHEMAS[stage].sheetTab).filter((tab) =>
    named.has(tab),
  );
  // A reference tab is not a stage, so it is not in the ordered list above.
  for (const tab of named) if (!ordered.includes(tab)) ordered.push(tab);
  return ordered;
}

export function explainDrift(args: {
  readonly plan: DriftPlan;
  readonly problems: readonly SchemaProblem[];
  /** True when the caller explicitly asked to clear the latch. */
  readonly clearRequested: boolean;
  /** True when a state write this plan intended did not land. */
  readonly stateWriteFailed: boolean;
}): DriftExplanation {
  const tabs = affectedTabs(args.problems);
  const tabList = tabs.length === 0 ? '' : ` Affected tabs: ${tabs.join(', ')}.`;

  switch (args.plan.action) {
    case 'latch_drift':
      return {
        message: args.stateWriteFailed
          ? `The Google Sheet column headings no longer match the system. The stop could not be recorded by this check, so writing is not yet blocked.${tabList}`
          : `The Google Sheet column headings no longer match the system. Writing has been stopped until an administrator checks the workbook.${tabList}`,
        affectedTabs: tabs,
        whatToDo: args.stateWriteFailed
          ? 'Run this check again. Another synchronisation run held the workbook, so the stop was observed but not recorded.'
          : 'Correct the listed tabs in the workbook, then run this check again. A passing check lifts the block by itself.',
      };

    case 'report_drift_only':
      return {
        message: `The Google Sheet column headings no longer match the system. The stop could not be recorded by this check — an administrator with synchronisation rights must run it again.${tabList}`,
        affectedTabs: tabs,
        whatToDo:
          'Ask an administrator with synchronisation rights to run this check, so the block is recorded against a person who can be accountable for it.',
      };

    case 'lift_latch':
      return {
        message: args.stateWriteFailed
          ? 'The column headings now match the system, but the earlier block could not be lifted by this check. Writing is still stopped.'
          : 'The column headings match the system. The earlier block has been lifted and writing can resume.',
        affectedTabs: [],
        whatToDo: args.stateWriteFailed
          ? 'Run this check again. Another synchronisation run held the workbook, so the block was not lifted.'
          : 'Nothing further. The workbook is verified and synchronisation is no longer blocked.',
      };

    case 'latch_stands':
      return {
        message: args.clearRequested
          ? 'The column headings match the system, but this check is not authorised to lift the block.'
          : 'The column headings match the system, but this workbook is still marked as drifted from an earlier check. Writing stays stopped until a check run with synchronisation rights lifts it.',
        affectedTabs: [],
        whatToDo:
          'Ask an administrator with synchronisation rights to run this check. A passing check from such a person lifts the block; nobody has to edit the database.',
      };

    case 'record_clean':
      return {
        message: args.clearRequested
          ? 'The column headings match the system, and this workbook was not blocked. There was nothing to clear.'
          : 'The column headings match the system.',
        affectedTabs: [],
        whatToDo: 'Nothing further.',
      };
  }
}

/**
 * The refusal for an explicit `clear_drift` that re-read the workbook and
 * found the problem is still there.
 *
 * STATES WHAT IS STILL WRONG. A refusal that only said "no" would send the
 * operator back to the database, which is the remedy this whole change exists
 * to remove.
 */
export function clearRefusal(problems: readonly SchemaProblem[]): DriftExplanation {
  const tabs = affectedTabs(problems);
  return {
    message:
      'The block cannot be cleared: the live workbook still does not match the system. ' +
      `${problems.length} problem(s) were found when it was re-read just now.` +
      (tabs.length === 0 ? '' : ` Affected tabs: ${tabs.join(', ')}.`),
    affectedTabs: tabs,
    whatToDo:
      'Correct the problems listed below in the workbook, then run this again. The block is lifted by a passing read of the live workbook and by nothing else.',
  };
}

// ---------------------------------------------------------------------------
// Carrying the plan out
// ---------------------------------------------------------------------------

/** Everything this sequence needs from the database, as narrow methods. */
export interface DriftStore {
  acquireLease(owner: string, ttlMs: number): Promise<LeaseState | null>;
  releaseLease(claim: FenceClaim): Promise<void>;
  writeVerificationState(state: VerificationState): Promise<void>;
  markSchemaDrifted(args: {
    readonly claim: FenceClaim;
    readonly problems: readonly SchemaProblem[];
  }): Promise<void>;
  /** Lift the latch. Returns how many recorded problems went with it. */
  clearSchemaDrift(args: {
    readonly claim: FenceClaim;
    readonly actorId: string | null;
    readonly verifiedAt: string;
    readonly verifiedStages: readonly Stage[];
  }): Promise<number>;
}

export interface DriftLogRecord {
  readonly event: string;
  readonly detail: string;
}

export interface DriftDeps {
  readonly store: DriftStore;
  /** The lease owner for this run: the request's correlation id, never a user. */
  readonly correlationId: string;
  /** The authenticated user, or null for the scheduler. Lands on the audit event. */
  readonly actorId: string | null;
  readonly now: () => Date;
  readonly leaseTtlMs?: number;
  readonly log?: (record: DriftLogRecord) => void;
}

export interface DriftOutcome {
  readonly plan: DriftPlan;
  /** THIS run recorded the stop. */
  readonly driftLatched: boolean;
  /** THIS run lifted an earlier stop, having re-read the workbook. */
  readonly driftLifted: boolean;
  /** Recorded problems cleared with the latch, or null if none were lifted. */
  readonly problemsCleared: number | null;
  /** A write this plan intended did not land. Never a 500; always said plainly. */
  readonly stateWriteFailed: boolean;
  /** Whether the workbook is fenced off after this run. What the response reports. */
  readonly drifted: boolean;
  /** True when the lease was taken AND handed back. */
  readonly leaseReleased: boolean;
  readonly explanation: DriftExplanation;
}

export interface DriftRunInput {
  /** The result of `verifySchema` over the live reading. */
  readonly verification: SchemaVerification;
  readonly requiredStages: readonly Stage[];
  readonly previouslyDrifted: boolean;
  readonly mayLatch: boolean;
  /** The caller asked for `clear_drift` rather than `verify_headers`. */
  readonly clearRequested: boolean;
  readonly checkedAt: string;
}

/**
 * Plan, carry out, explain.
 *
 * NOTHING HERE THROWS. A latched, blocked or contended workbook is a state to
 * report, not a fault: the header findings are already in hand and they are
 * the valuable part of the answer, so a store failure degrades to
 * `stateWriteFailed` plus a log record, and the caller returns 200 with a
 * readable explanation. A genuine fault still reaches the operator — as
 * `stateWriteFailed` with the plan's own "run it again" sentence — and reaches
 * the server log in full against the request's correlation id. 500 is left for
 * faults this sequence never sees: authentication, an unreadable request, a
 * Google read that failed before any of this.
 *
 * The lease is taken only for the plans that need it, and released in a
 * `finally` so no exit path can leave it held. That was the third defect: the
 * old latching path returned without releasing and the row sat expired for
 * twenty minutes.
 */
export async function runDriftRecovery(
  deps: DriftDeps,
  input: DriftRunInput,
): Promise<DriftOutcome> {
  const plan = planDriftRecovery({
    schemaOk: input.verification.ok,
    verifiedStages: input.verification.verifiedStages,
    requiredStages: input.requiredStages,
    previouslyDrifted: input.previouslyDrifted,
    mayLatch: input.mayLatch,
    checkedAt: input.checkedAt,
  });

  const log = (event: string, detail: string): void => deps.log?.({ event, detail });

  let driftLatched = false;
  let driftLifted = false;
  let problemsCleared: number | null = null;
  let stateWriteFailed = false;
  let leaseReleased = false;

  if (plan.action === 'report_drift_only' || plan.action === 'latch_stands') {
    // Deliberately nothing. The finding is reported; the stored state is left
    // exactly as it was, including `last_verified_at` — a run that may not
    // lift a latch must not move the worker's re-check clock either.
  } else if (plan.verification !== null) {
    const refusal = verificationWriteRefusal(plan.verification);
    if (refusal !== null) {
      log('verification_write_refused_locally', refusal);
      stateWriteFailed = true;
    } else {
      try {
        await deps.store.writeVerificationState(plan.verification);
      } catch (error) {
        log(
          'verification_write_failed',
          error instanceof Error ? error.message : String(error),
        );
        stateWriteFailed = true;
      }
    }
  } else {
    // Fenced write: latching or lifting. Both overwrite a verdict another run
    // may have just recorded, so both go under the workbook lease.
    let claim: FenceClaim | null = null;
    try {
      const lease = await deps.store.acquireLease(
        deps.correlationId,
        deps.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS,
      );
      if (lease !== null && lease.owner === deps.correlationId) {
        const candidate: FenceClaim = { owner: lease.owner, fence: lease.fence };
        if (validateFence(lease, candidate, deps.now()).ok) claim = candidate;
      }

      if (claim === null) {
        log(
          plan.action === 'latch_drift' ? 'schema_drift_not_latched' : 'schema_drift_not_lifted',
          'the workbook lease is held elsewhere; the finding stands but the state was not changed',
        );
        stateWriteFailed = true;
      } else if (plan.action === 'latch_drift') {
        await deps.store.markSchemaDrifted({
          claim,
          problems: input.verification.problems,
        });
        driftLatched = true;
      } else {
        problemsCleared = await deps.store.clearSchemaDrift({
          claim,
          actorId: deps.actorId,
          verifiedAt: input.checkedAt,
          verifiedStages: input.verification.verifiedStages,
        });
        driftLifted = true;
      }
    } catch (error) {
      log(
        plan.action === 'latch_drift' ? 'schema_drift_latch_failed' : 'schema_drift_lift_failed',
        error instanceof Error ? error.message : String(error),
      );
      stateWriteFailed = true;
    } finally {
      if (claim !== null) {
        try {
          // Under the fence: the SQL refuses a release from a stale token, so
          // this cannot free a lease that has moved to another worker. A
          // failed release is logged and swallowed — the lease expires on its
          // own TTL, and throwing from `finally` would replace the real
          // outcome with a bookkeeping error.
          await deps.store.releaseLease(claim);
          leaseReleased = true;
        } catch (error) {
          log('lease_release_failed', error instanceof Error ? error.message : String(error));
        }
      }
    }
  }

  const explanation =
    input.clearRequested && !input.verification.ok
      ? clearRefusal(input.verification.problems)
      : explainDrift({
          plan,
          problems: input.verification.problems,
          clearRequested: input.clearRequested,
          stateWriteFailed,
        });

  /**
   * What the response reports. A failing read is drifted whether or not the
   * stop was recorded — `driftLatched` is what says it was recorded. A clean
   * read is drifted only if a latch was standing and this run did not lift it.
   */
  const drifted = input.verification.ok ? (driftLifted ? false : input.previouslyDrifted) : true;

  return {
    plan,
    driftLatched,
    driftLifted,
    problemsCleared,
    stateWriteFailed,
    drifted,
    leaseReleased,
    explanation,
  };
}
