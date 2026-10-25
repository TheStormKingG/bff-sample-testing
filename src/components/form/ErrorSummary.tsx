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
export function ErrorSummary({ errors, onNavigate }: ErrorSummaryProps): JSX.Element | null {
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const count = errors.length;

  useEffect(() => {
    if (count > 0) headingRef.current?.focus();
  }, [count]);

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
            <a
              href={`#${error.targetId}`}
              onClick={(event) => {
                event.preventDefault();
                onNavigate(error.fieldKey);
                // The section may have been collapsed; it is opened by
                // onNavigate, so the focus call waits for that render.
                requestAnimationFrame(() => {
                  const target = document.getElementById(error.targetId);
                  target?.focus();
                  target?.scrollIntoView({ block: 'center' });
                });
              }}
              className="inline-flex min-h-[44px] items-center font-semibold text-red-900 underline decoration-2 underline-offset-2 hover:no-underline focus:outline-none focus:ring-2 focus:ring-red-700"
            >
              {error.label} — {error.message}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
