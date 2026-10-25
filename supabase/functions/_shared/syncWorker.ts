/**
 * The sync worker's decision sequence, as a pure orchestration over ports.
 *
 * Everything the worker does to Google and to Postgres goes through two
 * injected interfaces, so the entire failure matrix — timeout after a
 * successful write, re-sorted sheet, stale fence, drifted headers, quota
 * exhaustion, duplicate delivery — is exercisable in a unit test with no
 * network and no database. The Deno entrypoint
 * (`sheets-sync-worker/index.ts`) supplies the real implementations.
 *
 * The sequence, and why it is in this order:
 *
 *   1. workbook fenced off?        a drifted workbook is never written to
 *   2. verify headers if due       before the first write of the session
 *   3. superseded?                 never roll an operational row backwards
 *   4. LOCATE BY SAMPLE ID         always, for every event, before deciding
 *   5. decide projection           pure; append / update / noop / blocked
 *   6. re-check the lease fence    immediately before the write, not before 1
 *   7. write, then READ BACK       a 200 is not evidence; the read-back is
 *   8. record the transition       under the same fence
 *
 * Step 4 before step 5 is the whole anti-duplication design: the decision
 * cannot be "append" if the identifier is already present, whatever the event
 * kind says and however many times the event has been delivered.
 *
 * PURE: no Deno, no npm/jsr, no I/O of its own.
 */

import type { Stage } from '../../../src/forms/types.ts';
import { STAGE_SCHEMAS } from '../../../src/forms/registry.ts';
import {
  needsVerification,
  verifySchema,
  type SchemaProblem,
  type VerificationState,
} from './headerCheck.ts';
import {
  decideProjection,
  verifyPersistedRow,
  type ProjectionDecision,
} from './projection.ts';
import {
  isSuperseded,
  nextOutboxState,
  type OutboxEvent,
  type OutboxTransition,
  type SyncOutcome,
} from './outbox.ts';
import { validateFence, type FenceClaim, type LeaseRejection, type LeaseState } from './lease.ts';
import { classifySheetsError, type GoogleSheetsAdapter } from './sheets.ts';
import { DEFAULT_BACKOFF, type BackoffPolicy } from './backoff.ts';

/** Everything the worker needs from the database, as narrow methods. */
export interface SyncStore {
  /** Current lease row for the workbook, or null. */
  readLease(): Promise<LeaseState | null>;
  /** Extend our own lease. Returns the renewed lease, or null if lost. */
  renewLease(claim: FenceClaim): Promise<LeaseState | null>;

  readVerificationState(): Promise<VerificationState>;
  writeVerificationState(state: VerificationState): Promise<void>;
  /** Latch drift on the workbook and record the problems for the admin screen. */
  markSchemaDrifted(args: {
    readonly claim: FenceClaim;
    readonly problems: readonly SchemaProblem[];
  }): Promise<void>;

  /** Highest sample revision already confirmed in the sheet, or null. */
  latestConfirmedRevision(sampleUuid: string): Promise<number | null>;
  /** Row number of the last VERIFIED write for this sample, or null. */
  confirmedRowNumber(sampleUuid: string): Promise<number | null>;

  /** Persist the outbox transition. Must reject a stale fence. */
  recordOutcome(args: {
    readonly claim: FenceClaim;
    readonly event: OutboxEvent;
    readonly transition: OutboxTransition;
    readonly decision: ProjectionDecision | null;
  }): Promise<void>;

  /** Persist the confirmed sample -> row mapping. Must reject a stale fence. */
  confirmRowMapping(args: {
    readonly claim: FenceClaim;
    readonly sampleUuid: string;
    readonly stage: Stage;
    readonly rowNumber: number;
    readonly revision: number;
    readonly payloadHash: string;
    readonly confirmedAt: string;
  }): Promise<void>;
}

/** The lease was lost mid-pass. Abort the pass; do not write anything else. */
export class LeaseLostError extends Error {
  readonly reason: LeaseRejection;
  constructor(reason: LeaseRejection, message: string) {
    super(message);
    this.name = 'LeaseLostError';
    this.reason = reason;
  }
}

export interface WorkerLogRecord {
  readonly event: string;
  readonly [key: string]: unknown;
}

export interface WorkerDeps {
  readonly adapter: GoogleSheetsAdapter;
  readonly store: SyncStore;
  readonly claim: FenceClaim;
  readonly now: () => Date;
  /** `[0,1)`. Injected so retry schedules are reproducible in tests. */
  readonly random: () => number;
  readonly policy?: BackoffPolicy;
  readonly log?: (record: WorkerLogRecord) => void;
  /**
   * Opt-in optimisation: append without locating first, for a first-ever
   * projection. Refused whenever the event carries `reconcileFirst`, which is
   * the only case where skipping the locate could duplicate a row.
   */
  readonly allowAppendWithoutLocate?: boolean;
}

export interface ProcessResult {
  readonly eventId: string;
  readonly outcome: SyncOutcome;
  readonly transition: OutboxTransition;
  /** Did we read column A for this event? */
  readonly located: boolean;
  /** Did we issue a write? */
  readonly wrote: boolean;
  readonly decision: ProjectionDecision | null;
}

async function assertLease(deps: WorkerDeps, stageLabel: string): Promise<void> {
  const lease = await deps.store.readLease();
  const check = validateFence(lease, deps.claim, deps.now());
  if (check.ok) return;
  deps.log?.({
    event: 'lease_lost',
    reason: check.reason,
    fence: deps.claim.fence,
    at: stageLabel,
  });
  throw new LeaseLostError(check.reason, check.message);
}

/**
 * Process exactly one outbox event.
 *
 * Returns the transition rather than applying it blindly: the transition is
 * persisted through `recordOutcome`, which re-checks the fence, so a worker
 * that lost the lease between the write and the bookkeeping cannot record a
 * confirmation for a row it no longer owns.
 */
export async function processEvent(
  deps: WorkerDeps,
  event: OutboxEvent,
): Promise<ProcessResult> {
  const policy = deps.policy ?? DEFAULT_BACKOFF;
  const schema = STAGE_SCHEMAS[event.stage];
  let located = false;
  let wrote = false;
  let decision: ProjectionDecision | null = null;

  const finish = async (outcome: SyncOutcome): Promise<ProcessResult> => {
    const transition = nextOutboxState({
      event,
      outcome,
      now: deps.now(),
      random: deps.random,
      policy,
    });
    await deps.store.recordOutcome({ claim: deps.claim, event, transition, decision });
    if (transition.deadLettered) {
      deps.log?.({
        event: 'outbox_dead_lettered',
        outboxId: event.id,
        sampleId: event.sampleId,
        attempts: transition.attempts,
        lastError: transition.lastError,
      });
    }
    return { eventId: event.id, outcome, transition, located, wrote, decision };
  };

  try {
    // 1. A drifted workbook is fenced off entirely. Checked before anything
    //    that could cost an API call.
    const verification = await deps.store.readVerificationState();
    if (verification.schemaDrifted) {
      return await finish({
        kind: 'schema_drift',
        detail: `The workbook is marked as schema-drifted. Writing to "${schema.sheetTab}" is blocked until an administrator re-verifies the headers.`,
      });
    }

    // 2. Verify the row-4 headers before the first write of a session, and
    //    periodically after that.
    if (needsVerification(verification, [event.stage], deps.now())) {
      const read = await deps.adapter.verifyWorkbook([event.stage]);
      const result = verifySchema(read.reading, [event.stage]);
      if (!result.ok) {
        await deps.store.markSchemaDrifted({ claim: deps.claim, problems: result.problems });
        deps.log?.({
          event: 'schema_drift_detected',
          stage: event.stage,
          problems: result.problems.map((p) => p.message),
        });
        return await finish({
          kind: 'schema_drift',
          detail: result.problems.map((p) => p.message).join(' '),
        });
      }
      await deps.store.writeVerificationState({
        lastVerifiedAt: deps.now().toISOString(),
        verifiedStages: result.verifiedStages,
        schemaDrifted: false,
      });
    }

    // 3. Never roll a confirmed operational row back to an older revision.
    const latest = await deps.store.latestConfirmedRevision(event.sampleUuid);
    if (isSuperseded(event, latest)) {
      return await finish({
        kind: 'superseded',
        detail: `Revision ${event.revision} of ${event.sampleId} was overtaken by revision ${String(latest)}, which is already confirmed in the sheet.`,
      });
    }

    const confirmedRow = await deps.store.confirmedRowNumber(event.sampleUuid);

    // 4/5. Locate by immutable sample ID, then decide. The optimisation that
    //      skips the locate is refused for any event that needs reconciling.
    const mayAppendBlind =
      deps.allowAppendWithoutLocate === true &&
      event.kind === 'sample_registered' &&
      event.attempts === 0 &&
      !event.reconcileFirst &&
      confirmedRow === null;

    if (mayAppendBlind) {
      decision = { action: 'append', reason: 'no_existing_row', width: schema.columnCount };
    } else {
      const found = await deps.adapter.locateRecord(event.stage, event.sampleId);
      located = true;
      decision = decideProjection({
        stage: event.stage,
        sampleId: event.sampleId,
        intendedRow: event.row,
        located: found.record,
        duplicateRows: found.duplicateRows,
        confirmedRowNumber: confirmedRow,
      });
    }

    if (decision.action === 'blocked') {
      deps.log?.({
        event: 'projection_blocked',
        outboxId: event.id,
        sampleId: event.sampleId,
        reason: decision.reason,
      });
      return await finish({ kind: 'blocked', detail: decision.message });
    }

    if (decision.action === 'noop') {
      // The sheet already holds exactly this row. This is the branch that a
      // retry after an unknown outcome lands on, and the reason a Google
      // timeout cannot produce a second operational row.
      await deps.store.confirmRowMapping({
        claim: deps.claim,
        sampleUuid: event.sampleUuid,
        stage: event.stage,
        rowNumber: decision.rowNumber,
        revision: event.revision,
        payloadHash: event.payloadHash,
        confirmedAt: deps.now().toISOString(),
      });
      deps.log?.({
        event: 'projection_noop',
        outboxId: event.id,
        sampleId: event.sampleId,
        rowNumber: decision.rowNumber,
      });
      return await finish({ kind: 'noop', rowNumber: decision.rowNumber });
    }

    // 6. The fence is re-checked here, immediately before the write, because
    //    the steps above can take seconds and a lease can lapse inside them.
    await assertLease(deps, 'before_write');

    // 7. Write, then prove it.
    wrote = true;
    const upsert = await deps.adapter.upsertOperationalRow({
      stage: event.stage,
      sampleId: event.sampleId,
      row: event.row,
      instruction:
        decision.action === 'append'
          ? { mode: 'append' }
          : { mode: 'update', rowNumber: decision.rowNumber },
    });

    const proof = verifyPersistedRow({
      stage: event.stage,
      sampleId: event.sampleId,
      intendedRow: event.row,
      expectedRowNumber: upsert.rowNumber,
      readBack: upsert.readBack,
    });

    if (!proof.ok) {
      // The write returned success but the row does not read back as intended.
      // That is an UNKNOWN outcome, not a failure: something is in the sheet.
      // The next pass reconciles and either updates or no-ops.
      deps.log?.({
        event: 'write_unverified',
        outboxId: event.id,
        sampleId: event.sampleId,
        reason: proof.reason,
        message: proof.message,
      });
      return await finish({ kind: 'unknown', detail: proof.message });
    }

    await deps.store.confirmRowMapping({
      claim: deps.claim,
      sampleUuid: event.sampleUuid,
      stage: event.stage,
      rowNumber: proof.rowNumber,
      revision: event.revision,
      payloadHash: event.payloadHash,
      confirmedAt: deps.now().toISOString(),
    });

    return await finish({ kind: 'confirmed', rowNumber: proof.rowNumber });
  } catch (error) {
    if (error instanceof LeaseLostError) throw error;

    const classified = classifySheetsError(error);
    deps.log?.({
      event: 'sync_attempt_failed',
      outboxId: event.id,
      sampleId: event.sampleId,
      class: classified.kind,
      detail: classified.detail,
    });

    switch (classified.kind) {
      case 'unknown':
        return await finish({ kind: 'unknown', detail: classified.detail });
      case 'retryable':
        return await finish({
          kind: 'retryable',
          detail: classified.detail,
          retryAfterMs: classified.retryAfterMs,
        });
      case 'permanent':
        return await finish({ kind: 'permanent', detail: classified.detail });
    }
  }
}

export interface PassSummary {
  readonly processed: number;
  readonly confirmed: number;
  readonly noop: number;
  readonly retrying: number;
  readonly deadLettered: number;
  readonly superseded: number;
  /** Set when the pass stopped early because the lease was lost. */
  readonly abortedBecause: LeaseRejection | null;
  readonly results: readonly ProcessResult[];
}

/**
 * Process a claimed batch in order, renewing the lease when it gets close to
 * expiry so a long queue does not lapse half-way through.
 */
export async function runSyncPass(
  deps: WorkerDeps,
  events: readonly OutboxEvent[],
): Promise<PassSummary> {
  const results: ProcessResult[] = [];
  let abortedBecause: LeaseRejection | null = null;

  for (const event of events) {
    try {
      // Renewal is attempted per event rather than per batch: a batch of 50
      // slow rows can outlive any fixed TTL, and a lapsed lease mid-batch is
      // exactly the overlap the fence exists to catch.
      const renewed = await deps.store.renewLease(deps.claim);
      if (renewed === null) {
        abortedBecause = 'fence_stale';
        deps.log?.({ event: 'pass_aborted', reason: 'lease_renewal_refused' });
        break;
      }
      results.push(await processEvent(deps, event));
    } catch (error) {
      if (error instanceof LeaseLostError) {
        abortedBecause = error.reason;
        break;
      }
      throw error;
    }
  }

  const count = (predicate: (r: ProcessResult) => boolean): number =>
    results.filter(predicate).length;

  return {
    processed: results.length,
    confirmed: count((r) => r.outcome.kind === 'confirmed'),
    noop: count((r) => r.outcome.kind === 'noop'),
    retrying: count((r) => r.transition.state === 'retry_scheduled'),
    deadLettered: count((r) => r.transition.deadLettered),
    superseded: count((r) => r.outcome.kind === 'superseded'),
    abortedBecause,
    results,
  };
}
