/**
 * Sheets API quota accounting.
 *
 * Master Prompt §7: "Rate-limit/batch where safe and respect Sheets API
 * quotas." PRD NFR-007: "Sheets API ... quotas must be monitored and the
 * system must signal quota exhaustion explicitly."
 *
 * Google's default per-project limits are 300 read requests and 300 write
 * requests per minute, with 60 of each per minute per user; a service account
 * is one user, so the 60/min figure is the real ceiling for this application.
 * The budget here is deliberately under it: the worker is not the only client
 * (reconciliation and health checks share the quota) and a 429 costs more than
 * a deliberate wait.
 *
 * The decision of HOW LONG to wait is pure and lives here. The waiting itself
 * is `await`ed in the adapter, which is where a timer belongs.
 *
 * PURE: no Deno, no npm/jsr, no I/O, no timers.
 */

export interface QuotaBudget {
  /** Requests permitted inside the rolling window. */
  readonly limit: number;
  readonly windowMs: number;
  /** Minimum gap between consecutive requests, to smooth bursts. */
  readonly minIntervalMs: number;
}

/** 50 of the 60/minute per-user ceiling, leaving headroom for other callers. */
export const DEFAULT_READ_BUDGET: QuotaBudget = {
  limit: 50,
  windowMs: 60_000,
  minIntervalMs: 40,
};

/** Writes are the scarce side: one operational row costs 2-3 of these. */
export const DEFAULT_WRITE_BUDGET: QuotaBudget = {
  limit: 40,
  windowMs: 60_000,
  minIntervalMs: 60,
};

export type QuotaDecision =
  | { readonly allow: true; readonly waitMs: number }
  | { readonly allow: false; readonly retryAfterMs: number; readonly reason: 'window_exhausted' };

/**
 * May another request go out now?
 *
 * `timestamps` are the epoch milliseconds of previous requests, oldest first;
 * the caller prunes them with `pruneWindow`. Returning `allow: true` with a
 * positive `waitMs` means "yes, but not for another `waitMs`" — the smoothing
 * case. Returning `allow: false` means the window is full and the caller must
 * surface quota exhaustion rather than sleeping for most of a minute inside a
 * request.
 */
export function decideQuota(
  timestamps: readonly number[],
  nowMs: number,
  budget: QuotaBudget,
): QuotaDecision {
  const inWindow = timestamps.filter((t) => nowMs - t < budget.windowMs);

  if (inWindow.length >= budget.limit) {
    const oldest = inWindow[0] ?? nowMs;
    const retryAfterMs = Math.max(1, budget.windowMs - (nowMs - oldest));
    return { allow: false, retryAfterMs, reason: 'window_exhausted' };
  }

  const last = inWindow[inWindow.length - 1];
  if (last === undefined) return { allow: true, waitMs: 0 };

  const sinceLast = nowMs - last;
  return {
    allow: true,
    waitMs: sinceLast >= budget.minIntervalMs ? 0 : budget.minIntervalMs - sinceLast,
  };
}

export function pruneWindow(
  timestamps: readonly number[],
  nowMs: number,
  windowMs: number,
): number[] {
  return timestamps.filter((t) => nowMs - t < windowMs);
}

/** Simple rolling-window counter. State is explicit so it can be inspected. */
export class QuotaLedger {
  private stamps: number[] = [];

  constructor(private readonly budget: QuotaBudget) {}

  get used(): number {
    return this.stamps.length;
  }

  check(nowMs: number): QuotaDecision {
    this.stamps = pruneWindow(this.stamps, nowMs, this.budget.windowMs);
    return decideQuota(this.stamps, nowMs, this.budget);
  }

  record(nowMs: number): void {
    this.stamps = pruneWindow([...this.stamps, nowMs], nowMs, this.budget.windowMs);
  }
}
