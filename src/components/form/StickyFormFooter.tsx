import { Ban, FileText, Save, Send, X } from 'lucide-react';

import type { FormActionAvailability, SaveState } from './saveState';

export interface StickyFormFooterProps {
  readonly actions: FormActionAvailability;
  readonly saveState: SaveState;
  readonly onSaveDraft: () => void;
  readonly onRegister: () => void;
  readonly onSaveResults: () => void;
  readonly onVoid: () => void;
  readonly onCancel: () => void;
  /** Shown when the actor has no action at all, so the reason is not a mystery. */
  readonly noActionReason?: string | null;
}

const PRIMARY =
  'inline-flex min-h-[44px] flex-1 items-center justify-center gap-2 rounded-md bg-blue-700 px-4 py-2 ' +
  'text-base font-bold text-white hover:bg-blue-800 focus:outline-none focus:ring-2 focus:ring-blue-700 ' +
  'focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60';

const SECONDARY =
  'inline-flex min-h-[44px] items-center justify-center gap-2 rounded-md border-2 border-slate-400 bg-white ' +
  'px-4 py-2 text-base font-semibold text-slate-800 hover:bg-slate-50 focus:outline-none focus:ring-2 ' +
  'focus:ring-blue-700 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60';

const DANGER =
  'inline-flex min-h-[44px] items-center justify-center gap-2 rounded-md border-2 border-red-700 bg-white ' +
  'px-4 py-2 text-base font-semibold text-red-800 hover:bg-red-50 focus:outline-none focus:ring-2 ' +
  'focus:ring-red-700 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60';

/**
 * The action bar, pinned to the bottom of the viewport.
 *
 * Which buttons appear comes from `availableActions()`, which composes the
 * permission matrix with the capture state machine. None of that logic lives
 * here, and none of it is a security control: the server re-authorises every
 * action (Master Prompt §1).
 *
 * When an actor has no available action the footer says so in words. A silent
 * empty bar reads as a broken page, and the commonest cause is the correct and
 * deliberate one: a Google sign-in that has not been approved yet sees the
 * form but holds no permission (FR-001).
 *
 * `type="button"` on every control is deliberate. The default `submit` type
 * would make the Enter key fire whichever button happens to be first in the
 * DOM, which could register a sample from a half-filled form.
 */
export function StickyFormFooter({
  actions,
  saveState,
  onSaveDraft,
  onRegister,
  onSaveResults,
  onVoid,
  onCancel,
  noActionReason = null,
}: StickyFormFooterProps): JSX.Element {
  const busy = saveState === 'saving';
  const hasAnyAction =
    actions.canSaveDraft || actions.canRegister || actions.canSaveResults || actions.canVoid;

  return (
    <div className="sticky bottom-0 z-40 border-t-2 border-slate-300 bg-white/95 px-4 py-3 backdrop-blur">
      {!hasAnyAction && noActionReason !== null ? (
        <p className="mb-2 text-sm font-medium text-slate-700">{noActionReason}</p>
      ) : null}

      <div className="flex flex-wrap gap-2">
        {actions.canRegister ? (
          <button type="button" onClick={onRegister} disabled={busy} className={PRIMARY}>
            <Send aria-hidden="true" className="h-5 w-5" />
            Register sample
          </button>
        ) : null}

        {actions.canSaveResults ? (
          <button type="button" onClick={onSaveResults} disabled={busy} className={PRIMARY}>
            <Save aria-hidden="true" className="h-5 w-5" />
            Save results
          </button>
        ) : null}

        {actions.canSaveDraft ? (
          <button type="button" onClick={onSaveDraft} disabled={busy} className={SECONDARY}>
            <FileText aria-hidden="true" className="h-5 w-5" />
            Save draft
          </button>
        ) : null}

        <button type="button" onClick={onCancel} disabled={busy} className={SECONDARY}>
          <X aria-hidden="true" className="h-5 w-5" />
          Cancel
        </button>

        {actions.canVoid ? (
          <button type="button" onClick={onVoid} disabled={busy} className={DANGER}>
            <Ban aria-hidden="true" className="h-5 w-5" />
            Void
          </button>
        ) : null}
      </div>
    </div>
  );
}
