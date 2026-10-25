/**
 * Where a mutation failed: BEFORE the transaction committed, or AFTER.
 *
 * The request registry exists so a retry replays rather than repeats. That
 * guarantee rests on one classification the pipeline could not previously
 * make. `runMutation` wraps the endpoint's whole `run` callback in a single
 * `try`, and everything inside it — parse, validate, the transactional RPC,
 * the audit write, and then BUILDING THE RESPONSE OBJECT — lands in the same
 * `catch`. A throw while serialising the reply is therefore recorded exactly
 * like a throw before the RPC: the key is marked `failed` and becomes
 * retryable, while the ledger has already committed.
 *
 * That is the worst outcome in the system. The work HAPPENED and the record
 * says it did not, so:
 *
 *  - the client is told "Nothing was saved" (`ERROR_MESSAGES.internal`), which
 *    is false;
 *  - the same key is retryable, so the obvious operator response — press Save
 *    again — re-enters a transaction against a sample whose revision has
 *    already moved, producing a revision conflict at best;
 *  - nothing distinguishes it from a genuine failure in any log or counter.
 *
 * So the commit point is marked EXPLICITLY, and a throw after it is a
 * different outcome with a different name: `completed_unreported`. The work is
 * recorded as having succeeded (a replay of the key returns it), the caller
 * gets the authoritative identifiers the transaction returned, and the fact
 * that the reply was incomplete is reported rather than hidden.
 *
 * Why the decision lives in a pure module rather than inside the adapter: the
 * adapter imports `npm:@supabase/supabase-js` and `Deno.serve`, so it cannot
 * be loaded under vitest, and a policy that cannot be tested is a policy
 * nobody can show to be right. Same reason `idempotency.ts` is pure and
 * `adapters/store.ts` is not.
 *
 * PURE: no Deno, no npm/jsr, no I/O.
 */

/**
 * What the request registry must be told.
 *
 *  - `succeeded` — the effect happened; a replay must return the response.
 *  - `failed`    — the effect did not happen; the key stays retryable with the
 *                  SAME payload.
 *  - `leave`     — do not touch the row. The key is already bound to another
 *                  payload or another in-flight caller, and writing `failed`
 *                  here would let the conflicting payload take it over.
 */
export type RegistryDisposition = 'succeeded' | 'failed' | 'leave';

/**
 * Error codes that mean "this key belongs to somebody else's request". They
 * are raised by the pipeline before the endpoint's work begins, so they can
 * never be post-commit — but they are matched FIRST regardless, because the
 * cost of mis-ordering is rebinding a key that another payload holds.
 */
export const KEY_HELD_ELSEWHERE_CODES: readonly string[] = [
  'idempotency_conflict',
  'idempotency_in_progress',
];

/** Marker field on a reply that is authoritative but incomplete. */
export const RESPONSE_INCOMPLETE_FIELD = 'responseIncomplete';

/**
 * Operator-facing sentence for a committed-but-unreported outcome.
 *
 * It states the one fact that matters — the entry is recorded — and makes no
 * claim about Google Sheets, because this path is reached precisely when the
 * code that computes the sync label did not run. Phrased with the codebase's
 * own "Recorded securely" vocabulary and deliberately not with "Saved", which
 * `syncStatus.ts` treats as the phrase a well-meaning change reaches for.
 */
export const INCOMPLETE_RESPONSE_MESSAGE =
  'Recorded securely. Some details of this reply could not be prepared, so reload the sample to see its current state.';

/** Audit reason prefix for a post-commit serialisation failure. */
export const RESPONSE_INCOMPLETE_REASON_PREFIX = 'response_incomplete';

export interface FailureContext {
  /**
   * True once the endpoint has declared its transaction committed. Set by the
   * endpoint at the commit point, never inferred from the error.
   */
  readonly committed: boolean;
  /**
   * The authoritative outcome recorded at the commit point: the identifiers
   * and revision the transaction returned. `null` when the endpoint committed
   * without declaring a summary, which is treated as not having a reportable
   * outcome.
   */
  readonly committedSummary: Record<string, unknown> | null;
  readonly errorCode: string;
  /** HTTP status of the mapped error, for the audit outcome. */
  readonly errorStatus: number;
}

export type FailureOutcome =
  | {
      readonly kind: 'not_performed';
      readonly registry: 'failed' | 'leave';
      readonly auditOutcome: 'denied' | 'error';
      readonly auditReason: string;
      /** No reply to send: the mapped error is rethrown. */
      readonly respond: null;
    }
  | {
      readonly kind: 'completed_unreported';
      readonly registry: 'succeeded';
      /**
       * `error`, not `allowed`. The decision was allowed and the audit event
       * for the decision itself was already written by the endpoint; THIS
       * event records that the reply could not be built, which is a fault.
       */
      readonly auditOutcome: 'error';
      readonly auditReason: string;
      /** The reply to store against the key and return to the caller. */
      readonly respond: Record<string, unknown>;
    };

/**
 * Keep only what `JSON.stringify` is guaranteed to render.
 *
 * The fallback reply is built on the failure path, so it must not be able to
 * fail the same way. A summary carrying a `Date`, a `BigInt`, a circular
 * reference or a function would throw inside the handler that exists to
 * recover from a throw — and that second throw would reach `serveFunction`,
 * which would answer 500 "Nothing was saved" about committed work, exactly the
 * outcome this module exists to prevent. Depth is bounded for the same reason.
 */
export function jsonSafe(value: unknown, depth = 0): unknown {
  if (depth > 6) return null;
  if (value === null) return null;
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value;
    case 'number':
      // NaN and ±Infinity serialise as `null`, so they are normalised here
      // rather than silently becoming null-shaped data downstream.
      return Number.isFinite(value) ? value : null;
    case 'object':
      break;
    default:
      // undefined, bigint, function, symbol.
      return null;
  }
  if (Array.isArray(value)) {
    return value.map((item) => jsonSafe(item, depth + 1));
  }
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (item === undefined) continue;
    out[key] = jsonSafe(item, depth + 1);
  }
  return out;
}

/**
 * The reply for a committed-but-unreported outcome.
 *
 * The transaction's own identifiers are preserved, so the client can address
 * the record it just created, and two explicit fields say the reply is partial.
 * A client that ignores them still gets true data; one that reads them knows to
 * refetch.
 */
export function incompleteResponse(
  summary: Record<string, unknown>,
  errorCode: string,
): Record<string, unknown> {
  const safe = jsonSafe(summary) as Record<string, unknown>;
  return {
    ...safe,
    [RESPONSE_INCOMPLETE_FIELD]: true,
    responseIncompleteReason: `${RESPONSE_INCOMPLETE_REASON_PREFIX}:${errorCode}`,
    message: INCOMPLETE_RESPONSE_MESSAGE,
  };
}

/**
 * Classify a failed mutation attempt.
 *
 * Order matters and is asserted by the tests: the key-held-elsewhere codes are
 * matched before the commit flag, because rebinding another payload's key is
 * worse than losing the distinction this module adds.
 */
export function decideFailureOutcome(ctx: FailureContext): FailureOutcome {
  if (KEY_HELD_ELSEWHERE_CODES.includes(ctx.errorCode)) {
    return {
      kind: 'not_performed',
      registry: 'leave',
      auditOutcome: ctx.errorStatus >= 500 ? 'error' : 'denied',
      auditReason: ctx.errorCode,
      respond: null,
    };
  }

  if (ctx.committed && ctx.committedSummary !== null) {
    return {
      kind: 'completed_unreported',
      registry: 'succeeded',
      auditOutcome: 'error',
      auditReason: `${RESPONSE_INCOMPLETE_REASON_PREFIX}:${ctx.errorCode}`,
      respond: incompleteResponse(ctx.committedSummary, ctx.errorCode),
    };
  }

  return {
    kind: 'not_performed',
    registry: 'failed',
    auditOutcome: ctx.errorStatus >= 500 ? 'error' : 'denied',
    auditReason: ctx.errorCode,
    respond: null,
  };
}

/**
 * Was this stored reply an incomplete one?
 *
 * A replay returns whatever was stored against the key, so a reply stored by
 * the path above comes back with its marker intact. Exposed so a reader — a
 * test, or a client — can ask the question without matching on a string
 * literal in two places.
 */
export function isIncompleteResponse(response: unknown): boolean {
  return (
    typeof response === 'object' &&
    response !== null &&
    (response as Record<string, unknown>)[RESPONSE_INCOMPLETE_FIELD] === true
  );
}
