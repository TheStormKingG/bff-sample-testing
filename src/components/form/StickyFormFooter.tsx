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
 * ONE WORD PER BUTTON, ONE ROW, NO WRAPPING.
 *
 * THE ICONS ARE HIDDEN BELOW `sm`, and that is what makes the row fit rather
 * than overflow. Measured at 320px — the width `playwright.config.ts` runs
 * its `small-phone` project at, a Galaxy S9+ — the action bar is 256px wide
 * after the page's own padding, and three icon-bearing buttons wanted 319px.
 * The page scrolled sideways (scrollWidth 369 against a 320 viewport), which
 * is the one thing `hasHorizontalScroll` exists to catch. An icon beside a
 * word that already says "Cancel" is reinforcement; the word is the content,
 * so the icon is what gives way.
 *
 * `whitespace-nowrap` stops a label breaking in two; `flex-nowrap` stops the
 * ROW breaking in two. Both are load-bearing and for the same reason: the bar
 * is `sticky bottom-0`, so every pixel of its height is subtracted from the
 * form the operator can see. Measured on the running app: with two-word
 * labels the three buttons wrapped onto two rows at 390px and the bar stood
 * 121px tall, clipping the field behind it mid-sentence.
 *
 * The labels are therefore single words — Register, Save, Cancel, Void — and
 * that is the fix the earlier version of this comment already prescribed
 * ("shorten the WORD rather than letting it wrap or truncate"). Two of them
 * lost a noun they did not need: the button sits under the form it acts on,
 * so "Register sample" said "sample" to somebody looking at one.
 *
 * WHAT THE SHORTENING WOULD HAVE COST, AND HOW IT IS PAID BACK. "Save draft"
 * and "Save results" are different acts, and both become "Save". They can
 * never appear together — `availableActions` gates the first on the capture
 * state being `draft` and the second on `awaiting_results` — so no screen
 * ever shows two Saves. But a screen reader announcing a bare "Save" to
 * somebody who cannot see which form they are on would have lost the
 * distinction for good, so each keeps its full name as its ACCESSIBLE name
 * via `aria-label`. Visible text short, announced text exact.
 *
 * `px-3` rather than `px-4`, and `gap-1.5` rather than `gap-2`, bought the
 * room for four buttons at 320px. `flex-1 basis-0` on every button divides
 * the row evenly instead of letting the longest word set three widths.
 */
const BUTTON_BASE =
  'inline-flex min-h-[44px] flex-1 basis-0 items-center justify-center gap-1.5 whitespace-nowrap ' +
  'rounded-xl px-3 py-2 sm:gap-2 sm:px-4 ' +
  'text-base transition-[transform,box-shadow] duration-150 ease-out focus:outline-none focus-visible:ring-2 ' +
  'focus-visible:ring-offset-2 focus-visible:ring-offset-neu-base disabled:cursor-not-allowed ' +
  'disabled:opacity-60 active:scale-[0.98]';

const PRIMARY =
  `${BUTTON_BASE} bg-bff-700 font-bold text-white shadow-neu-sm hover:bg-bff-800 ` +
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

      {/* `flex-nowrap`: the row may not break, whatever the label. */}
      <div className="flex flex-nowrap items-stretch gap-2">
        {actions.canRegister ? (
          <button
            type="button"
            onClick={onRegister}
            disabled={busy}
            aria-label="Register sample"
            className={PRIMARY}
          >
            <Send aria-hidden="true" className="hidden h-5 w-5 shrink-0 sm:block" />
            Register
          </button>
        ) : null}

        {actions.canSaveResults ? (
          <button
            type="button"
            onClick={onSaveResults}
            disabled={busy}
            aria-label="Save results"
            className={PRIMARY}
          >
            <Save aria-hidden="true" className="hidden h-5 w-5 shrink-0 sm:block" />
            Save
          </button>
        ) : null}

        {actions.canSaveDraft ? (
          <button
            type="button"
            onClick={onSaveDraft}
            disabled={busy}
            aria-label="Save draft"
            className={SECONDARY}
          >
            <FileText aria-hidden="true" className="hidden h-5 w-5 shrink-0 sm:block" />
            Save
          </button>
        ) : null}

        <button type="button" onClick={onCancel} disabled={busy} className={SECONDARY}>
          <X aria-hidden="true" className="hidden h-5 w-5 shrink-0 sm:block" />
          Cancel
        </button>

        {actions.canVoid ? (
          <button type="button" onClick={onVoid} disabled={busy} className={DANGER}>
            <Ban aria-hidden="true" className="hidden h-5 w-5 shrink-0 sm:block" />
            Void
          </button>
        ) : null}
      </div>
    </div>
  );
}
