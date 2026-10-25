/**
 * Idempotency decisions.
 *
 * PRD §10.3: "Every save includes a client-generated idempotency UUID and
 * payload hash... Backend ... checks the request registry." Master Prompt §10
 * fixes the two cases that must be distinguished: "Same idempotency key +
 * same payload returns same result; same key + different payload is rejected."
 *
 * The decision is a pure function of the stored record and the incoming
 * request, so the whole matrix is unit-testable without a database. The
 * entrypoint does the I/O: read the record, call this, then either return the
 * stored response or proceed and persist the outcome.
 *
 * PURE: no Deno, no npm/jsr, no I/O.
 */

export const IDEMPOTENCY_STATES = ['in_progress', 'succeeded', 'failed'] as const;
export type IdempotencyState = (typeof IDEMPOTENCY_STATES)[number];

export interface IdempotencyRecord {
  readonly key: string;
  /** The operation name, so one key cannot be reused across endpoints. */
  readonly operation: string;
  /** `auth.uid()` of the original requester. */
  readonly actorId: string;
  readonly payloadHash: string;
  readonly state: IdempotencyState;
  /** The response body to replay. Only meaningful when state is `succeeded`. */
  readonly response: unknown;
  /** ISO instant the record was created. */
  readonly createdAt: string;
  /** ISO instant the record last changed. Drives the stale-lock takeover. */
  readonly updatedAt: string;
}

export interface IncomingRequest {
  readonly key: string;
  readonly operation: string;
  readonly actorId: string;
  readonly payloadHash: string;
}

export type IdempotencyConflictReason =
  | 'payload_mismatch'
  | 'actor_mismatch'
  | 'operation_mismatch';

export type IdempotencyDecision =
  /** Nothing stored, or a previous attempt failed: run the operation. */
  | { readonly action: 'proceed'; readonly reason: 'no_record' | 'previous_attempt_failed' }
  /** Identical request already completed: return the stored response verbatim. */
  | { readonly action: 'replay'; readonly response: unknown }
  /** A concurrent attempt holds the key. The client should poll, not resend. */
  | { readonly action: 'in_progress'; readonly sinceMs: number }
  /**
   * An in-progress record older than the lock timeout. The original attempt
   * died before recording an outcome, so this request takes it over rather
   * than leaving the key permanently wedged.
   */
  | { readonly action: 'take_over'; readonly staleForMs: number }
  | { readonly action: 'conflict'; readonly reason: IdempotencyConflictReason };

/**
 * How long an `in_progress` record is believed before a later request may take
 * it over. Must exceed the longest possible single request, which here is a
 * registration plus the in-transaction outbox enqueue — well under a second —
 * with a wide margin for a cold function start.
 */
export const IN_PROGRESS_TIMEOUT_MS = 60_000;

/**
 * Key format. A UUID is what PRD §10.3 asks for, but accepting any
 * sufficiently long opaque token keeps a non-UUID client honest rather than
 * forcing it to fabricate a UUID shape. Short or structured keys are refused
 * because they collide: "1", "save", a sample ID.
 */
const KEY_PATTERN = /^[A-Za-z0-9_.:-]{16,128}$/;

export function isValidIdempotencyKey(key: unknown): key is string {
  return typeof key === 'string' && KEY_PATTERN.test(key);
}

export function decideIdempotency(
  existing: IdempotencyRecord | null,
  incoming: IncomingRequest,
  now: Date,
  inProgressTimeoutMs: number = IN_PROGRESS_TIMEOUT_MS,
): IdempotencyDecision {
  if (existing === null) {
    return { action: 'proceed', reason: 'no_record' };
  }

  // Identity checks come before the payload check. A key presented by a
  // different person is not a retry at all — it is either a bug or an attempt
  // to read back somebody else's response — so it must never reach the branch
  // that replays a stored body.
  if (existing.actorId !== incoming.actorId) {
    return { action: 'conflict', reason: 'actor_mismatch' };
  }
  if (existing.operation !== incoming.operation) {
    return { action: 'conflict', reason: 'operation_mismatch' };
  }
  if (existing.payloadHash !== incoming.payloadHash) {
    return { action: 'conflict', reason: 'payload_mismatch' };
  }

  switch (existing.state) {
    case 'succeeded':
      return { action: 'replay', response: existing.response };

    case 'failed':
      // A failed attempt left no committed effect, so the same payload may be
      // retried under the same key. Treating this as a conflict would strand
      // the operator on a key their client has already persisted locally.
      return { action: 'proceed', reason: 'previous_attempt_failed' };

    case 'in_progress': {
      const startedAt = Date.parse(existing.updatedAt);
      const elapsed = Number.isNaN(startedAt)
        ? Number.POSITIVE_INFINITY
        : now.getTime() - startedAt;
      if (elapsed >= inProgressTimeoutMs) {
        return { action: 'take_over', staleForMs: elapsed };
      }
      return { action: 'in_progress', sinceMs: Math.max(0, elapsed) };
    }
  }
}
