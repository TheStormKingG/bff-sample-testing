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

/**
 * NO LABEL MAY WRAP. `whitespace-nowrap` is the load-bearing class here.
 *
 * Without it "Register sample" broke across two lines on a 375px phone, and
 * the damage was not cosmetic. The bar is `sticky bottom-0`, so its height is
 * subtracted from the form the operator can see: two-line buttons made it
 * 142px tall, three buttons wrapped onto two rows, and the field underneath
 * was clipped mid-sentence. Measured on the running app before this change —
 * "Register sample" 2 lines, "Save draft" 2 lines, bar 142px, the Date hint
 * cut off behind it.
 *
 * `shrink-0` on the label text keeps the icon from stealing the room the word
 * needs, and `min-w-0` is deliberately NOT used: these labels are short and
 * must never be ellipsised. If a future label genuinely cannot fit at 320px,
 * shorten the WORD rather than letting it wrap or truncate — a quality action
 * the operator cannot read is worse than a terse one.
 */
const BUTTON_BASE =
  'inline-flex min-h-[44px] items-center justify-center gap-2 whitespace-nowrap rounded-xl px-4 py-2 ' +
  'text-base transition-[transform,box-shadow] duration-150 ease-out focus:outline-none focus-visible:ring-2 ' +
  'focus-visible:ring-offset-2 focus-visible:ring-offset-neu-base disabled:cursor-not-allowed ' +
  'disabled:opacity-60 active:scale-[0.98]';

const PRIMARY =
  `${BUTTON_BASE} flex-1 bg-bff-700 font-bold text-white shadow-neu-sm hover:bg-bff-800 ` +
  'focus-visible:ring-bff-700 active:shadow-neu-pressed';

const SECONDARY =
  `${BUTTON_BASE} bg-neu-base font-semibold text-slate-800 shadow-neu-sm hover:text-slate-900 ` +
  'focus-visible:ring-bff-700 active:shadow-neu-inset';

const DANGER =
  `${BUTTON_BASE} bg-neu-base font-semibold text-red-800 shadow-neu-sm hover:text-red-900 ` +
  'focus-visible:ring-red-700 active:shadow-neu-inset';

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
    <div
      data-form-actions
      className="sticky bottom-0 z-40 border-t border-slate-200 bg-neu-base/95 px-4 py-3 backdrop-blur"
    >
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
