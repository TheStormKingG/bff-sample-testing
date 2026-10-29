import { useEffect, useRef } from 'react';
import { AlertCircle } from 'lucide-react';

export interface SummarisedError {
  readonly fieldKey: string;
  /** The field's own label, so the entry reads as a sentence. */
  readonly label: string;
  readonly message: string;
  /** The id of the control (or radio fieldset) to move focus to. */
  readonly targetId: string;
}

export interface ErrorSummaryProps {
  readonly errors: readonly SummarisedError[];
  /**
   * Monotonic count of submit ATTEMPTS, not of errors.
   *
   * This is the whole fix for "I tap Register and nothing happens". The
   * effect below used to be keyed on the error count, which is the RESULT of
   * an attempt rather than the attempt itself. The two coincide on the first
   * failure — 0 goes to N — and never again, so a second tap against the same
   * incomplete form produced the same number, React skipped the effect, and
   * the operator at the bottom of a long form saw no change whatsoever.
   *
   * Keying on the count was also wrong in the other direction. With
   * `reValidateMode` at its default of `onChange`, every keystroke after the
   * first failed submit re-validates; fixing one field drops the count from 8
   * to 7, the effect re-ran, and focus was yanked out of the box the operator
   * was typing in — which on a phone also dismisses the keyboard.
   */
  readonly attempt: number;
  /**
   * Called before focus moves, so the owning form can open the collapsed
   * section the field lives in — a hidden control cannot take focus.
   */
  readonly onNavigate: (fieldKey: string) => void;
}

/**
 * The list of everything wrong, at the top of the form, each entry linking to
 * its field.
 *
 * This is the piece that makes a failed submission comprehensible rather than
 * mysterious. Submitting an incomplete form must never appear to do nothing:
 * the summary takes focus, announces itself, and says how many problems there
 * are and where. For an operator on a phone, the offending field is often
 * several screens away.
 *
 * `role="alert"` sits on this one element only. Repeating it on every field
 * error would make a screen reader read the entire form aloud at once.
 */
export function ErrorSummary({
  errors,
  attempt,
  onNavigate,
}: ErrorSummaryProps): JSX.Element | null {
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const count = errors.length;

  useEffect(() => {
    if (attempt === 0 || count === 0) return;
    /**
     * `preventScroll`, because scrolling is not this component's job.
     *
     * Focus and scroll position are both single-occupancy resources, and the
     * rule this codebase already settled on for focus (see
     * `shouldFocusError: false` in StageForm) is that each gets exactly one
     * owner rather than an ordering between two claimants. The form owns the
     * scroll; this owns the focus. Letting `focus()` also scroll would put
     * two claimants back on the same resource, with the browser choosing the
     * alignment.
     */
    headingRef.current?.focus({ preventScroll: true });
    // `count` is read, not watched: the ATTEMPT is the trigger, so this fires
    // once per submit rather than once per keystroke that changes the tally.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt]);

  if (count === 0) return null;

  return (
    <div
      role="alert"
      className="mb-4 rounded-lg border-2 border-red-700 bg-red-50 p-4"
    >
      <h2
        ref={headingRef}
        tabIndex={-1}
        className="flex items-center gap-2 text-lg font-bold text-red-900 focus:outline-none focus:ring-2 focus:ring-red-700 focus:ring-offset-2"
      >
        <AlertCircle aria-hidden="true" className="h-5 w-5 shrink-0" />
        {count === 1 ? 'There is 1 thing to fix' : `There are ${count} things to fix`}
      </h2>

      <p className="mt-1 text-sm text-red-900">
        Nothing has been saved yet. Fix these and try again.
      </p>

      <ul className="mt-3 space-y-1">
        {errors.map((error) => (
          <li key={error.fieldKey}>
            {/*
              A BUTTON, NOT AN ANCHOR WITH A `#id` HREF.
              `App.tsx` states the rule outright: "Nothing in the app may link
              using a bare `#id` fragment anchor, because that is a route
              change." This app routes with HashRouter, so the fragment IS the
              address. This component used to carry `href={`#${targetId}`}`
              with a `preventDefault()` in front of it — which holds for an
              ordinary tap and fails for a long-press "open in new tab", a
              middle-click or a cmd-click, any of which navigates to a route
              like `/raw-materials-material` and throws the operator out of a
              half-filled form. The sibling summary in `components/ui` already
              used a button for exactly this reason; this copy did not inherit
              it.
            */}
            <button
              type="button"
              onClick={() => {
                onNavigate(error.fieldKey);
                // The section may have been collapsed; it is opened by
                // onNavigate, so the focus call waits for that render.
                requestAnimationFrame(() => {
                  const target = document.getElementById(error.targetId);
                  target?.focus();
                  target?.scrollIntoView({ block: 'center' });
                });
              }}
              className="inline-flex min-h-[44px] items-center text-left font-semibold text-red-900 underline decoration-2 underline-offset-2 hover:no-underline focus:outline-none focus:ring-2 focus:ring-red-700"
            >
              {error.label} — {error.message}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
