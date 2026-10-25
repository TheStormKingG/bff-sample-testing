/**
 * The transactional outbox: event shape and state machine.
 *
 * Master Prompt §7: "when a sample registration, accepted results update or
 * correction commits in Supabase, create exactly one versioned outbox event in
 * the same DB transaction." The enqueue is done by the RPC (see `rpc.ts`);
 * this module owns what happens to an event afterwards.
 *
 * Two invariants this state machine exists to hold:
 *
 *  1. An UNKNOWN outcome never goes straight back to `pending`. It goes to
 *     `retry_scheduled` with `reconcileFirst: true`, so the next pass is
 *     forced to read the sheet and compare before deciding append vs update.
 *     A retry that skips that step is how one timeout becomes two rows.
 *
 *  2. A stale event is `superseded`, not retried. If revision 3 of a sample
 *     has already been confirmed in the sheet, re-applying the revision-2
 *     event would roll the operational record backwards — a silent data
 *     regression that looks like a successful sync.
 *
 * PURE: no Deno, no npm/jsr, no I/O.
 */

import type { Stage } from '../../../src/forms/types.ts';
import {
  decideRetry,
  nextAttemptAt,
  type BackoffPolicy,
  DEFAULT_BACKOFF,
} from './backoff.ts';

export const OUTBOX_EVENT_KINDS = [
  /** First projection of a sample: appends the operational row. */
  'sample_registered',
  /** Test results added by a Quality Officer: updates the same row. */
  'results_recorded',
  /** Reasoned amendment of a previously written value. */
  'correction_applied',
  /** Review outcome or disposition that changes a written cell. */
  'review_recorded',
] as const;
export type OutboxEventKind = (typeof OUTBOX_EVENT_KINDS)[number];

export const OUTBOX_STATES = [
  /** Waiting for a worker. */
  'pending',
  /** Claimed by a worker under a fence. */
  'in_flight',
  /** Written and read back. The only state that may show "Confirmed". */
  'confirmed',
  /** Will be retried at `nextAttemptAt`. */
  'retry_scheduled',
  /** Dead letter. Visible to an administrator and retryable by hand. */
  'needs_attention',
  /** A newer revision of the same sample was confirmed instead. */
  'superseded',
] as const;
export type OutboxState = (typeof OUTBOX_STATES)[number];

export const OUTBOX_STATE_LABELS: Readonly<Record<OutboxState, string>> = {
  pending: 'Waiting to sync',
  in_flight: 'Syncing now',
  confirmed: 'Confirmed in Google Sheets',
  retry_scheduled: 'Sync failed, will retry',
  needs_attention: 'Sync failed, needs attention',
  superseded: 'Replaced by a newer version',
};

/**
 * Narrow an untrusted outbox-state string.
 *
 * An unrecognised value becomes `null`, which `publicSyncState` renders as
 * "pending". That direction is deliberate: the failure mode of guessing wrong
 * here is either an unnecessary "sync pending" (harmless) or a false
 * "Confirmed in Google Sheets" (forbidden by build rule 6), so an unknown
 * value must never fall through to `confirmed`.
 */
export function asOutboxState(value: unknown): OutboxState | null {
  return typeof value === 'string' && (OUTBOX_STATES as readonly string[]).includes(value)
    ? (value as OutboxState)
    : null;
}

export interface OutboxEvent {
  readonly id: string;
  readonly sampleUuid: string;
  readonly sampleId: string;
  readonly stage: Stage;
  readonly kind: OutboxEventKind;
  /** The sample revision this event projects. Monotonic per sample. */
  readonly revision: number;
  /** Hash of the row this event intends to write. */
  readonly payloadHash: string;
  /** The row cells, serialised by `toSheetRow` at enqueue time. */
  readonly row: readonly string[];
  readonly state: OutboxState;
  readonly attempts: number;
  readonly nextAttemptAt: string | null;
  /**
   * Set when the previous attempt ended in an unknown outcome. The worker MUST
   * reconcile against the sheet before deciding what to write.
   */
  readonly reconcileFirst: boolean;
  readonly lastError: string | null;
  readonly confirmedRowNumber: number | null;
  readonly confirmedAt: string | null;
  readonly createdAt: string;
}

export type SyncOutcome =
  | { readonly kind: 'confirmed'; readonly rowNumber: number }
  | { readonly kind: 'noop'; readonly rowNumber: number }
  /** Timeout, aborted connection, or an unclassifiable throw mid-write. */
  | { readonly kind: 'unknown'; readonly detail: string }
  | { readonly kind: 'retryable'; readonly detail: string; readonly retryAfterMs?: number | null }
  | { readonly kind: 'permanent'; readonly detail: string }
  /** Headers no longer match. The whole workbook is fenced off. */
  | { readonly kind: 'schema_drift'; readonly detail: string }
  /** Projection refused: duplicates, deleted row, protected region. */
  | { readonly kind: 'blocked'; readonly detail: string }
  /** A newer revision has already been confirmed. */
  | { readonly kind: 'superseded'; readonly detail: string };

export interface OutboxTransition {
  readonly state: OutboxState;
  readonly attempts: number;
  readonly nextAttemptAt: string | null;
  readonly reconcileFirst: boolean;
  readonly lastError: string | null;
  readonly confirmedRowNumber: number | null;
  readonly confirmedAt: string | null;
  /** True when this transition is the dead-letter one, for alerting. */
  readonly deadLettered: boolean;
}

/**
 * Is this event already overtaken?
 *
 * `latestConfirmedRevision` is the highest revision of the SAME sample already
 * confirmed in the sheet. Equal is not stale — a duplicate delivery of the
 * event that was already applied must still be processed, because the
 * projection no-op is what makes it harmless, and short-circuiting here would
 * skip the read-back that proves the row is actually right.
 */
export function isSuperseded(
  event: Pick<OutboxEvent, 'revision'>,
  latestConfirmedRevision: number | null,
): boolean {
  if (latestConfirmedRevision === null) return false;
  return event.revision < latestConfirmedRevision;
}

/**
 * Next state for an event whose attempt has just finished.
 *
 * `attempts` on the input event counts attempts BEFORE this one, so the
 * attempt that just ran is `attempts + 1`.
 */
export function nextOutboxState(args: {
  readonly event: Pick<OutboxEvent, 'attempts' | 'confirmedRowNumber' | 'confirmedAt'>;
  readonly outcome: SyncOutcome;
  readonly now: Date;
  readonly random: () => number;
  readonly policy?: BackoffPolicy;
}): OutboxTransition {
  const policy = args.policy ?? DEFAULT_BACKOFF;
  const attempts = args.event.attempts + 1;
  const { outcome, now } = args;

  const terminal = (
    state: OutboxState,
    lastError: string | null,
    extra?: Partial<OutboxTransition>,
  ): OutboxTransition => ({
    state,
    attempts,
    nextAttemptAt: null,
    reconcileFirst: false,
    lastError,
    confirmedRowNumber: args.event.confirmedRowNumber,
    confirmedAt: args.event.confirmedAt,
    deadLettered: false,
    ...extra,
  });

  switch (outcome.kind) {
    case 'confirmed':
    case 'noop':
      return terminal('confirmed', null, {
        confirmedRowNumber: outcome.rowNumber,
        confirmedAt: now.toISOString(),
      });

    case 'superseded':
      return terminal('superseded', outcome.detail);

    // Schema drift and projection blocks are NOT retried on a timer. Both need
    // a human to look at the workbook; retrying would burn quota re-discovering
    // the same condition and would bury the alert under repeated failures.
    case 'schema_drift':
      return terminal('needs_attention', outcome.detail, { deadLettered: true });

    case 'blocked':
      return terminal('needs_attention', outcome.detail, { deadLettered: true });

    case 'permanent':
      return terminal('needs_attention', outcome.detail, { deadLettered: true });

    case 'unknown':
    case 'retryable': {
      const minimum = outcome.kind === 'retryable' ? (outcome.retryAfterMs ?? 0) : 0;
      const decision = decideRetry(attempts, policy, args.random, minimum);
      // The unknown case carries `reconcileFirst` into the retry even when it
      // dead-letters, so a manual retry by an administrator also reconciles.
      const reconcileFirst = outcome.kind === 'unknown';

      if (!decision.retry) {
        return {
          state: 'needs_attention',
          attempts,
          nextAttemptAt: null,
          reconcileFirst,
          lastError: `${outcome.detail} (gave up after ${attempts} attempts)`,
          confirmedRowNumber: args.event.confirmedRowNumber,
          confirmedAt: args.event.confirmedAt,
          deadLettered: true,
        };
      }

      return {
        state: 'retry_scheduled',
        attempts,
        nextAttemptAt: nextAttemptAt(now, decision.delayMs),
        reconcileFirst,
        lastError: outcome.detail,
        confirmedRowNumber: args.event.confirmedRowNumber,
        confirmedAt: args.event.confirmedAt,
        deadLettered: false,
      };
    }
  }
}

/** Is an event due, given the clock? Used by the claim query and by tests. */
export function isDue(event: Pick<OutboxEvent, 'state' | 'nextAttemptAt'>, now: Date): boolean {
  if (event.state === 'pending') return true;
  if (event.state !== 'retry_scheduled') return false;
  if (event.nextAttemptAt === null) return true;
  const due = Date.parse(event.nextAttemptAt);
  if (Number.isNaN(due)) return true;
  return due <= now.getTime();
}
