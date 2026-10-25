import { forwardRef, type TextareaHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';
import { useFieldControl } from '@/components/ui/fieldContext';
import { CONTROL_BORDER_INVALID, CONTROL_BORDER_OK } from '@/components/ui/Input';

export type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement>;

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  {
    className,
    id,
    rows = 3,
    'aria-describedby': describedBy,
    'aria-invalid': invalid,
    required,
    ...rest
  },
  ref,
) {
  const field = useFieldControl();
  const isInvalid = invalid ?? field?.invalid ?? false;
  return (
    <textarea
      ref={ref}
      id={id ?? field?.id}
      rows={rows}
      aria-describedby={describedBy ?? field?.describedBy}
      aria-invalid={isInvalid || undefined}
      required={required ?? field?.required}
      className={cn(
        'block w-full rounded-lg border bg-white px-3 py-2.5 text-base text-slate-900',
        'placeholder:text-slate-400 disabled:cursor-not-allowed disabled:bg-slate-100',
        isInvalid ? CONTROL_BORDER_INVALID : CONTROL_BORDER_OK,
        className,
      )}
      {...rest}
    />
  );
});
