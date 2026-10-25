/**
 * Bounded exponential backoff with jitter, and the dead-letter boundary.
 *
 * Master Prompt §7: "retries failures with bounded exponential backoff and a
 * dead-letter/needs-attention state."
 *
 * Jitter shape matters, so it is stated explicitly. The nominal delay is
 * `base * factor^(attempt-1)`, clamped to `maxDelayMs`. Jitter then ADDS a
 * fraction of the nominal delay: `nominal * (1 + r * jitterRatio)` for
 * `r ∈ [0,1)`. That choice is deliberate over the more common "full jitter"
 * (`r * nominal`), because full jitter can make attempt 5 fire sooner than
 * attempt 2 and the retry schedule then stops being monotonic — which is the
 * property that keeps a struggling Sheets API from being hammered. With
 * additive jitter both the floor and the ceiling of the delay are
 * monotonically non-decreasing in `attempt`, and both are bounded by
 * `maxDelayMs * (1 + jitterRatio)`.
 *
 * PURE: no Deno, no npm/jsr, no I/O. The randomness is an injected
 * parameter, never `Math.random()` read from inside, so every schedule in the
 * test suite is exactly reproducible.
 */

export interface BackoffPolicy {
  /** Delay before the second attempt, i.e. after attempt 1 failed. */
  readonly baseMs: number;
  readonly factor: number;
  /** Cap on the nominal delay, before jitter is added. */
  readonly maxDelayMs: number;
  /** Total attempts allowed, including the first. Dead-letter after this. */
  readonly maxAttempts: number;
  /** Fraction of the nominal delay available as additive jitter. 0 disables. */
  readonly jitterRatio: number;
}

/**
 * Chosen against the Sheets API quota of 60 write requests per minute per
 * user: six attempts spanning roughly 1s, 2s, 4s, 8s, 16s, 32s, capped at
 * 5 minutes, which clears a short outage without a thundering herd and
 * surfaces a longer one to an administrator within minutes rather than hours.
 */
export const DEFAULT_BACKOFF: BackoffPolicy = {
  baseMs: 1_000,
  factor: 2,
  maxDelayMs: 300_000,
  maxAttempts: 6,
  jitterRatio: 0.25,
};

export function assertValidPolicy(policy: BackoffPolicy): void {
  const problems: string[] = [];
  if (!Number.isFinite(policy.baseMs) || policy.baseMs <= 0) problems.push('baseMs must be > 0');
  if (!Number.isFinite(policy.factor) || policy.factor < 1) problems.push('factor must be >= 1');
  if (!Number.isFinite(policy.maxDelayMs) || policy.maxDelayMs < policy.baseMs) {
    problems.push('maxDelayMs must be >= baseMs');
  }
  if (!Number.isInteger(policy.maxAttempts) || policy.maxAttempts < 1) {
    problems.push('maxAttempts must be a positive integer');
  }
  if (!Number.isFinite(policy.jitterRatio) || policy.jitterRatio < 0 || policy.jitterRatio > 1) {
    problems.push('jitterRatio must be between 0 and 1');
  }
  if (problems.length > 0) {
    throw new Error(`Invalid backoff policy: ${problems.join('; ')}`);
  }
}

/** The clamped delay before jitter. Monotonically non-decreasing in `attempt`. */
export function nominalDelayMs(attempt: number, policy: BackoffPolicy): number {
  assertValidPolicy(policy);
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new Error(`Attempt must be a positive integer, received ${attempt}`);
  }
  // Math.pow overflows to Infinity for a large attempt count; Math.min then
  // yields maxDelayMs, which is the correct clamped answer.
  const raw = policy.baseMs * Math.pow(policy.factor, attempt - 1);
  return Math.min(policy.maxDelayMs, raw);
}

/** Inclusive floor and exclusive ceiling of the delay for a given attempt. */
export function delayEnvelopeMs(
  attempt: number,
  policy: BackoffPolicy,
): { readonly minMs: number; readonly maxMs: number } {
  const nominal = nominalDelayMs(attempt, policy);
  return { minMs: nominal, maxMs: nominal * (1 + policy.jitterRatio) };
}

/**
 * Delay after `attempt` failed attempts, with `random` supplying `[0,1)`.
 * Rounded to whole milliseconds because the stored `next_attempt_at` has
 * millisecond resolution and a fractional delay would not survive a round trip.
 */
export function backoffDelayMs(
  attempt: number,
  policy: BackoffPolicy,
  random: () => number,
): number {
  const nominal = nominalDelayMs(attempt, policy);
  const r = random();
  if (!Number.isFinite(r) || r < 0 || r >= 1) {
    throw new Error(`Jitter source must return a value in [0,1), received ${r}`);
  }
  return Math.round(nominal * (1 + r * policy.jitterRatio));
}

export type RetryDecision =
  | { readonly retry: true; readonly delayMs: number; readonly nextAttempt: number }
  | { readonly retry: false; readonly reason: 'max_attempts_exhausted'; readonly attempts: number };

/**
 * After `attempt` has just failed, should there be another?
 *
 * `attempt` counts attempts already made, so with `maxAttempts: 6` the sixth
 * failure dead-letters. A caller that respects a server-supplied
 * `Retry-After` passes it as `minimumDelayMs`; the longer of the two wins,
 * because ignoring a quota hint is how a rate limit becomes a ban.
 */
export function decideRetry(
  attempt: number,
  policy: BackoffPolicy,
  random: () => number,
  minimumDelayMs = 0,
): RetryDecision {
  assertValidPolicy(policy);
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new Error(`Attempt must be a positive integer, received ${attempt}`);
  }
  if (attempt >= policy.maxAttempts) {
    return { retry: false, reason: 'max_attempts_exhausted', attempts: attempt };
  }
  const computed = backoffDelayMs(attempt, policy, random);
  return {
    retry: true,
    delayMs: Math.max(computed, Math.max(0, Math.round(minimumDelayMs))),
    nextAttempt: attempt + 1,
  };
}

/** `next_attempt_at` for the outbox row. */
export function nextAttemptAt(now: Date, delayMs: number): string {
  return new Date(now.getTime() + delayMs).toISOString();
}
