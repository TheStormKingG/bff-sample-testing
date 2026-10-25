/**
 * The two honest sync states, and nothing else.
 *
 * Master Prompt §7 and build rule 6: "Provide two truthful states:
 * 'Recorded securely, Google Sheets sync pending' and 'Confirmed in Google
 * Sheets' (with timestamp)... No false green 'Saved' status."
 *
 * The strings live here, server-side, and are returned in the response body,
 * so the label a user sees is produced by the same code that knows whether the
 * row is confirmed. A UI that invented its own label could show "Saved" for an
 * unconfirmed row, and no test of the backend would catch it.
 *
 * `FORBIDDEN_SYNC_PHRASES` exists so the prohibition is checkable rather than
 * merely written down.
 *
 * PURE: no Deno, no npm/jsr, no I/O.
 */

import type { OutboxState } from './outbox.ts';

export const SYNC_PENDING_LABEL = 'Recorded securely, Google Sheets sync pending';
export const SYNC_CONFIRMED_LABEL = 'Confirmed in Google Sheets';
export const SYNC_ATTENTION_LABEL =
  'Recorded securely. The Google Sheets copy failed and needs attention';
export const SYNC_BLOCKED_LABEL =
  'Recorded securely. Google Sheets writing is stopped until an administrator checks the workbook';

/**
 * Phrases that must never appear in a sync label. "Saved to Google Sheets" is
 * the specific claim rule 6 forbids for unsynced data, and the looser "Saved"
 * is listed too because it is the phrase a well-meaning change would reach for.
 */
export const FORBIDDEN_SYNC_PHRASES: readonly string[] = [
  'saved to google sheets',
  'saved to sheets',
  'saved in google sheets',
];

export type PublicSyncState = 'pending' | 'confirmed' | 'needs_attention' | 'blocked';

export interface SyncStatus {
  readonly state: PublicSyncState;
  readonly label: string;
  /** ISO instant of confirmation. Present only when state is `confirmed`. */
  readonly confirmedAt: string | null;
}

export function publicSyncState(outboxState: OutboxState | null): PublicSyncState {
  switch (outboxState) {
    case 'confirmed':
      return 'confirmed';
    case 'needs_attention':
      return 'needs_attention';
    case null:
    case 'pending':
    case 'in_flight':
    case 'retry_scheduled':
    case 'superseded':
      // A superseded event means a NEWER event carries the truth, so from the
      // operator's point of view this row is still pending until that one
      // confirms. Reporting "confirmed" here would be the false green.
      return 'pending';
  }
}

export function syncStatusFor(args: {
  readonly outboxState: OutboxState | null;
  readonly confirmedAt?: string | null;
  readonly schemaDrifted?: boolean;
}): SyncStatus {
  if (args.schemaDrifted === true) {
    return { state: 'blocked', label: SYNC_BLOCKED_LABEL, confirmedAt: null };
  }
  const state = publicSyncState(args.outboxState);
  switch (state) {
    case 'confirmed':
      return {
        state,
        label: SYNC_CONFIRMED_LABEL,
        confirmedAt: args.confirmedAt ?? null,
      };
    case 'needs_attention':
      return { state, label: SYNC_ATTENTION_LABEL, confirmedAt: null };
    case 'blocked':
      return { state, label: SYNC_BLOCKED_LABEL, confirmedAt: null };
    case 'pending':
      return { state, label: SYNC_PENDING_LABEL, confirmedAt: null };
  }
}

/** Every label this module can emit. Asserted clean by the test suite. */
export const ALL_SYNC_LABELS: readonly string[] = [
  SYNC_PENDING_LABEL,
  SYNC_CONFIRMED_LABEL,
  SYNC_ATTENTION_LABEL,
  SYNC_BLOCKED_LABEL,
];
