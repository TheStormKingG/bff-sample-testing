import { can, type AuthorityContext } from '@/lib/roles';
import { allowedTransitionsFrom, type CaptureState } from '@/lib/workflow';

/**
 * What the app currently knows about this record's persistence.
 *
 * Four states, and `recorded` means the SERVER acknowledged the write. There
 * is no optimistic "saved" (FR-015: "success appears only after verifying the
 * record's persistent write"; UAT-13: "do not show 'Saved' without server
 * confirmation").
 */
export type SaveState = 'editing' | 'saving' | 'recorded' | 'failed';

/**
 * Whether the operational Google Sheets row is confirmed.
 *
 * Exactly two honest values. There is no third state that lets the UI imply a
 * sheet write that has not happened: data committed to the Supabase ledger but
 * not yet projected to the sheet is `pending`, and it says so in those words.
 * The ledger is the record of truth; the sheet is a downstream projection
 * written by the sync worker, so a successful save genuinely does not mean the
 * sheet has been touched yet.
 */
export type SheetSyncState = 'pending' | 'confirmed';

export const SHEET_SYNC_LABELS: Record<SheetSyncState, string> = {
  pending: 'Recorded securely, Google Sheets sync pending',
  confirmed: 'Confirmed in Google Sheets',
};

export interface FormActionAvailability {
  readonly canSaveDraft: boolean;
  readonly canRegister: boolean;
  readonly canSaveResults: boolean;
  readonly canVoid: boolean;
}

const NO_ACTIONS: FormActionAvailability = {
  canSaveDraft: false,
  canRegister: false,
  canSaveResults: false,
  canVoid: false,
};

/**
 * Which buttons this actor may see in this capture state.
 *
 * Composed from the two existing primitives — `can()` for authority and
 * `allowedTransitionsFrom()` for the state machine — and reimplements neither.
 *
 * This decides VISIBILITY ONLY. Hiding a button is not an access control
 * (Master Prompt §1); every one of these actions is re-authorised server-side
 * by RLS and the Edge Function before anything is written. The point of the
 * check here is to avoid offering an operator an action that will be refused,
 * not to be the thing that refuses it.
 */
export function availableActions(
  captureState: CaptureState,
  actor: AuthorityContext | null,
): FormActionAvailability {
  if (actor === null) return NO_ACTIONS;

  // A non-active account holds no permission at all, so a pending Google
  // sign-in falls out of every branch below via `can()` (FR-001).
  const reachable = allowedTransitionsFrom(captureState);

  return {
    canSaveDraft: captureState === 'draft' && can(actor, 'sample.draft'),
    canRegister: reachable.includes('registered') && can(actor, 'sample.register'),
    canSaveResults:
      reachable.includes('ready_for_review') && can(actor, 'sample.enter_results'),
    canVoid: reachable.includes('voided') && can(actor, 'sample.void'),
  };
}
