/**
 * Whether an audit event actually got written, and how that is reported.
 *
 * `recordAudit` catches a failed audit write and returns normally. That
 * decision is right and stays: FR-002's acceptance criterion is that an
 * operator attempting to clear a hold "receives a denial AND a logged event",
 * and turning a failed log write into a 500 would make the audit trail an
 * availability dependency of the security control — the denial would stop
 * being returned at all.
 *
 * What was wrong is that the failure went nowhere. `audit_write_failed` and
 * `audit_write_threw` were written to stderr and had ZERO consumers: no
 * counter, no row, no alert, and nothing in `/health`. So FR-002 was half met
 * whenever the write failed, and no instrument in the system could tell that
 * from fully met. A swallowed error with no consumer is indistinguishable from
 * no error.
 *
 * The fix is a durable dead-letter row carrying the WHOLE original event, so
 * the trail can be replayed rather than merely counted, plus a count surfaced
 * in `/health`'s detail tier beside the outbox counts.
 *
 * THE COUNT MUST NEVER READ ZERO WHEN IT WAS NOT MEASURED. Three different
 * facts produce a "0" if they are allowed to collapse: no failures happened,
 * the snapshot could not be read, and this database does not report the field
 * at all. Only the first is good news, and it is the one an unqualified zero
 * would be read as — so they are kept as separate states here, and the two
 * that are not good news each produce a problem sentence.
 *
 * PURE: no Deno, no npm/jsr, no I/O.
 */

/** Outcome of trying to write one audit event. */
export type AuditDelivery =
  /** The audit event is in the trail. */
  | { readonly state: 'delivered' }
  /**
   * The audit event is NOT in the trail, but a durable dead-letter row
   * records it and `/health` counts it. Recoverable, and visible.
   */
  | { readonly state: 'dead_lettered'; readonly detail: string }
  /**
   * Neither the event nor a record of its loss could be stored. The server
   * log is the only trace. This is the state the system must make loud,
   * because it is the only one nothing durable can report.
   */
  | { readonly state: 'lost'; readonly detail: string };

/** Log event names. Kept here so a consumer can match them by import. */
export const AUDIT_WRITE_FAILED_EVENT = 'audit_write_failed';
export const AUDIT_WRITE_THREW_EVENT = 'audit_write_threw';
export const AUDIT_DEAD_LETTERED_EVENT = 'audit_dead_lettered';
export const AUDIT_DEAD_LETTER_LOST_EVENT = 'audit_dead_letter_lost';

/** Which stage of the audit write failed, recorded on the dead-letter row. */
export type AuditFailureStage = 'rpc_error' | 'threw';

export type AuditHealthState =
  /** The health snapshot itself could not be read. */
  | 'unread'
  /** The snapshot was read but carries no audit dead-letter field. */
  | 'unavailable'
  | 'clear'
  | 'needs_attention';

export interface AuditHealth {
  readonly state: AuditHealthState;
  /** True only when a usable count was actually obtained. */
  readonly read: boolean;
  /** `null` whenever the number was not measured. Never 0 as a stand-in. */
  readonly deadLetters: number | null;
  readonly oldestDeadLetterAt: string | null;
  readonly message: string;
}

function asCount(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value >= 0 ? value : null;
  }
  // PostgREST renders bigint counts as strings.
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const n = Number(value);
    return Number.isSafeInteger(n) ? n : null;
  }
  return null;
}

function asInstant(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * Project the audit part of a health snapshot.
 *
 * `deadLetters` is read as `unknown` on purpose: the field is optional in the
 * RPC contract, so "absent" is a case this function must handle rather than a
 * case the type system can rule out.
 */
export function auditHealth(input: {
  readonly snapshotRead: boolean;
  readonly deadLetters: unknown;
  readonly oldestDeadLetterAt: unknown;
}): AuditHealth {
  if (!input.snapshotRead) {
    return {
      state: 'unread',
      read: false,
      deadLetters: null,
      oldestDeadLetterAt: null,
      message: 'The audit dead-letter count could not be read.',
    };
  }

  const count = asCount(input.deadLetters);
  if (count === null) {
    return {
      state: 'unavailable',
      read: false,
      deadLetters: null,
      oldestDeadLetterAt: null,
      message:
        'This database does not report an audit dead-letter count, so a failed audit write would not be visible here.',
    };
  }

  const oldest = asInstant(input.oldestDeadLetterAt);
  if (count === 0) {
    return {
      state: 'clear',
      read: true,
      deadLetters: 0,
      oldestDeadLetterAt: null,
      message: 'Every audit event has been written.',
    };
  }

  return {
    state: 'needs_attention',
    read: true,
    deadLetters: count,
    oldestDeadLetterAt: oldest,
    message: `${count} audit event(s) could not be written and are held in the audit dead-letter queue.`,
  };
}

/**
 * Problem sentences for `/health`.
 *
 * `clear` is the only state that yields none. In particular `unavailable`
 * yields one: a deployment whose database cannot report the counter has no way
 * to notice a lost audit event, and silence there would be exactly the false
 * clean this module exists to prevent.
 */
export function auditProblems(health: AuditHealth): string[] {
  switch (health.state) {
    case 'clear':
      return [];
    case 'unread':
    case 'unavailable':
      return [health.message];
    case 'needs_attention':
      return [
        health.oldestDeadLetterAt === null
          ? health.message
          : `${health.message} The oldest is from ${health.oldestDeadLetterAt}.`,
      ];
  }
}
