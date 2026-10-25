import { useEffect, useRef } from 'react';
import { AlertCircle } from 'lucide-react';
import { cn } from '@/lib/cn';

export interface FieldError {
  /** The control's DOM id, so the summary can move focus to it. */
  readonly id?: string;
  /** The field label as the operator sees it. */
  readonly label: string;
  readonly message: string;
}

export interface ErrorSummaryProps {
  readonly errors: readonly FieldError[];
  readonly title?: string;
  /** Move focus here when the list appears, after a failed submit. */
  readonly autoFocus?: boolean;
  readonly className?: string;
}

/**
 * The list of everything wrong with the form, at the top of the form.
 *
 * Two deliberate choices.
 *
 * Each entry is a BUTTON, not an `href="#field-id"` anchor. This app routes
 * with HashRouter, so the fragment is the page address: a fragment link would
 * be read as a navigation to the route `/field-id` and would throw the
 * operator out of the half-filled form. Calling `focus()` directly does what
 * the link was for without touching the address.
 *
 * `role="alert"` lives on the container rather than on each field's own error
 * text, so a submit with six problems announces one summary instead of six
 * interruptions.
 */
export function ErrorSummary({
  errors,
  title,
  autoFocus = false,
  className,
}: ErrorSummaryProps) {
  const headingRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    if (autoFocus && errors.length > 0) headingRef.current?.focus();
  }, [autoFocus, errors.length]);

  if (errors.length === 0) return null;

  const heading =
    title ??
    (errors.length === 1
      ? 'There is 1 problem to fix before saving'
      : `There are ${errors.length} problems to fix before saving`);

  return (
    <div
      role="alert"
      className={cn('rounded-xl border-2 border-red-600 bg-red-50 p-4', className)}
    >
      <p
        ref={headingRef}
        tabIndex={-1}
        className="flex items-start gap-2 text-base font-semibold text-red-900"
      >
        <AlertCircle aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0" />
        <span>{heading}</span>
      </p>
      <ul className="mt-2 space-y-1 pl-7">
        {errors.map(({ id, label, message }, index) => (
          // `id` is destructured to a const so TypeScript keeps the narrowing
          // inside the click handler; a narrowed property access would not
          // survive into the closure and would need a cast.
          <li key={id ?? `${label}-${index}`}>
            {id === undefined ? (
              <span className="text-sm text-red-900">
                <span className="font-medium">{label}:</span> {message}
              </span>
            ) : (
              <button
                type="button"
                className="min-h-tap text-left text-sm text-red-900 underline hover:no-underline"
                onClick={() => {
                  const target = document.getElementById(id);
                  target?.focus();
                  target?.scrollIntoView({ block: 'center' });
                }}
              >
                <span className="font-medium">{label}:</span> {message}
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
