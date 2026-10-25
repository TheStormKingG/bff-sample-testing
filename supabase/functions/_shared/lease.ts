/**
 * Workbook lease with a fencing token.
 *
 * Master Prompt §7: Google writes must be "serialized per workbook or
 * otherwise demonstrably race-safe (e.g. a single leased worker with database
 * advisory lock/fencing/renewal). Guard against workers overlapping, stale
 * jobs applying after newer revisions, and duplicate delivery."
 *
 * A lease alone is NOT enough, and that is the whole reason the fence exists.
 * Worker A takes a 30-second lease, then stalls — garbage collection, a cold
 * network path, a suspended container. The lease expires, worker B takes it,
 * and then A wakes up and issues its write. A still believes it holds the
 * lease; nothing about A's own state can tell it otherwise. The only defence
 * is that every write carries the fence value A was issued, the store knows
 * the current fence is higher, and A's write is refused. So the fence is
 * checked at the point of the write, not merely at the point of acquisition —
 * `validateFence` is called by the store on every mutating call.
 *
 * PURE: no Deno, no npm/jsr, no I/O. Time is an argument.
 */

export interface LeaseState {
  /** Which workbook. One lease per spreadsheet id, never one global lease. */
  readonly workbookKey: string;
  /** Opaque worker identity: an invocation id, not a user. */
  readonly owner: string;
  /**
   * Monotonically increasing. Incremented by the store on every successful
   * acquisition, including a takeover of an expired lease. Never reset.
   */
  readonly fence: number;
  readonly expiresAt: string;
  readonly acquiredAt: string;
}

export interface FenceClaim {
  readonly owner: string;
  readonly fence: number;
}

export type LeaseRejection =
  /** The claim's fence is below the current one: a stale worker woke up. */
  | 'fence_stale'
  /** The fence matches but the owner does not: two workers, same number. */
  | 'owner_mismatch'
  /** The claim is current but the lease has run out; renew before writing. */
  | 'lease_expired'
  /** No lease exists at all, so nothing authorises a write. */
  | 'no_lease'
  /** The claim's fence is ABOVE the stored one, which cannot happen honestly. */
  | 'fence_ahead_of_store';

export type LeaseValidation =
  | { readonly ok: true; readonly msRemaining: number }
  | { readonly ok: false; readonly reason: LeaseRejection; readonly message: string };

export const DEFAULT_LEASE_TTL_MS = 60_000;
/** Renew once under this much time is left, so a long run never lapses mid-write. */
export const DEFAULT_RENEW_BEFORE_MS = 20_000;

function parseInstant(iso: string): number {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? Number.NaN : t;
}

/** Is this claim still the authorised writer for the workbook, right now? */
export function validateFence(
  current: LeaseState | null,
  claim: FenceClaim,
  now: Date,
): LeaseValidation {
  if (current === null) {
    return {
      ok: false,
      reason: 'no_lease',
      message: 'No workbook lease is held, so no write is authorised.',
    };
  }

  if (claim.fence < current.fence) {
    return {
      ok: false,
      reason: 'fence_stale',
      message: `Write refused: this worker holds fence ${claim.fence} but the workbook lease has advanced to ${current.fence}. A newer worker owns the workbook.`,
    };
  }

  if (claim.fence > current.fence) {
    // Only reachable if a worker fabricated a token or the store lost state.
    // Fail closed: a fence we never issued authorises nothing.
    return {
      ok: false,
      reason: 'fence_ahead_of_store',
      message: `Write refused: fence ${claim.fence} was never issued for this workbook (current ${current.fence}).`,
    };
  }

  if (claim.owner !== current.owner) {
    return {
      ok: false,
      reason: 'owner_mismatch',
      message: `Write refused: fence ${claim.fence} belongs to a different worker.`,
    };
  }

  const expiry = parseInstant(current.expiresAt);
  if (Number.isNaN(expiry)) {
    return {
      ok: false,
      reason: 'lease_expired',
      message: 'Write refused: the lease expiry could not be read.',
    };
  }
  const msRemaining = expiry - now.getTime();
  if (msRemaining <= 0) {
    return {
      ok: false,
      reason: 'lease_expired',
      message: `Write refused: the workbook lease expired ${Math.abs(msRemaining)} ms ago. Renew the lease before writing.`,
    };
  }

  return { ok: true, msRemaining };
}

/** May a new worker take the lease? True when it is free or has lapsed. */
export function canAcquire(current: LeaseState | null, now: Date): boolean {
  if (current === null) return true;
  const expiry = parseInstant(current.expiresAt);
  if (Number.isNaN(expiry)) return true;
  return expiry <= now.getTime();
}

/**
 * The lease a successful acquisition produces. The fence is the previous one
 * plus one — strictly increasing even across a takeover, which is what makes a
 * stale write detectable rather than merely unlikely.
 */
export function nextLease(args: {
  readonly current: LeaseState | null;
  readonly workbookKey: string;
  readonly owner: string;
  readonly now: Date;
  readonly ttlMs?: number;
}): LeaseState {
  const ttl = args.ttlMs ?? DEFAULT_LEASE_TTL_MS;
  if (!Number.isFinite(ttl) || ttl <= 0) {
    throw new Error(`Lease TTL must be a positive number of milliseconds, received ${ttl}`);
  }
  return {
    workbookKey: args.workbookKey,
    owner: args.owner,
    fence: (args.current?.fence ?? 0) + 1,
    acquiredAt: args.now.toISOString(),
    expiresAt: new Date(args.now.getTime() + ttl).toISOString(),
  };
}

/** Renew in place: same owner, SAME fence, later expiry. */
export function renewedLease(current: LeaseState, now: Date, ttlMs = DEFAULT_LEASE_TTL_MS): LeaseState {
  return {
    ...current,
    expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
  };
}

export function leaseNeedsRenewal(
  current: LeaseState,
  now: Date,
  renewBeforeMs = DEFAULT_RENEW_BEFORE_MS,
): boolean {
  const expiry = parseInstant(current.expiresAt);
  if (Number.isNaN(expiry)) return true;
  return expiry - now.getTime() <= renewBeforeMs;
}
