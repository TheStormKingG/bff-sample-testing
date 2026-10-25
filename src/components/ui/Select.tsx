import { forwardRef, type SelectHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';
import { useFieldControl } from '@/components/ui/fieldContext';
import {
  CONTROL_BORDER_INVALID,
  CONTROL_BORDER_OK,
  CONTROL_CLASSES,
} from '@/components/ui/Input';

export interface SelectOptionItem {
  readonly value: string;
  readonly label: string;
}

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  readonly options: readonly SelectOptionItem[];
  /**
   * First entry, selected when nothing has been chosen. Its value is the empty
   * string, which is distinct from any real option code — so "not answered"
   * can never be mistaken for a choice the operator made.
   */
  readonly placeholder?: string;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  {
    className,
    id,
    options,
    placeholder = 'Choose…',
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
    <select
      ref={ref}
      id={id ?? field?.id}
      aria-describedby={describedBy ?? field?.describedBy}
      aria-invalid={isInvalid || undefined}
      required={required ?? field?.required}
      className={cn(
        CONTROL_CLASSES,
        'pr-10',
        isInvalid ? CONTROL_BORDER_INVALID : CONTROL_BORDER_OK,
        className,
      )}
      {...rest}
    >
      <option value="">{placeholder}</option>
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
});
