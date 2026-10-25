import { forwardRef, type InputHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';
import { useFieldControl } from '@/components/ui/fieldContext';

export type InputProps = InputHTMLAttributes<HTMLInputElement>;

export const CONTROL_CLASSES =
  'block w-full min-h-tap rounded-lg border bg-white px-3 py-2.5 text-base text-slate-900 ' +
  'placeholder:text-slate-400 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-500';

export const CONTROL_BORDER_OK = 'border-slate-300';
export const CONTROL_BORDER_INVALID = 'border-red-600 bg-red-50';

/**
 * A text or numeric input.
 *
 * It inherits its id and its accessible wiring from the enclosing `Field`, so
 * the two cannot drift apart. No value is ever pre-filled — PRD section 11 is
 * explicit that a test result must not be pre-filled as zero, and a blank
 * field means "not measured" while 0 is a real measurement.
 */
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, id, 'aria-describedby': describedBy, 'aria-invalid': invalid, required, ...rest },
  ref,
) {
  const field = useFieldControl();
  const isInvalid = invalid ?? field?.invalid ?? false;
  return (
    <input
      ref={ref}
      id={id ?? field?.id}
      aria-describedby={describedBy ?? field?.describedBy}
      aria-invalid={isInvalid || undefined}
      required={required ?? field?.required}
      className={cn(
        CONTROL_CLASSES,
        isInvalid ? CONTROL_BORDER_INVALID : CONTROL_BORDER_OK,
        className,
      )}
      {...rest}
    />
  );
});
