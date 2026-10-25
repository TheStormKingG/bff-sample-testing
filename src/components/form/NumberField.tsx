import { FieldShell, describedBy, inputClass } from './FieldShell';
import type { FieldInputProps } from './fieldControl';

/**
 * A measurement input.
 *
 * `type="text"` with `inputMode="decimal"`, NOT `type="number"`. This is a
 * deliberate choice and reversing it would break the record:
 *
 *  - `type="number"` normalises its own value, so `12.50` can come back as
 *    `12.5`. That trailing zero states the instrument's resolution and is part
 *    of the quality record (PRD §6.1: "preserve entered decimal precision").
 *  - A `type="number"` field whose content is invalid reports an EMPTY value to
 *    the DOM, which would turn a typo into "not measured" instead of into a
 *    validation error the operator can see and fix.
 *  - Its spinner arrows are a hazard on a touch screen: a stray tap silently
 *    changes a recorded measurement.
 *
 * `inputMode="decimal"` still brings up the numeric keypad on a phone, which
 * is the actual usability requirement.
 */
export function NumberField({
  field,
  ids,
  required,
  error,
  control,
  disabled,
}: FieldInputProps): JSX.Element {
  return (
    <FieldShell field={field} ids={ids} required={required} error={error}>
      <input
        {...control}
        id={ids.input}
        type="text"
        inputMode="decimal"
        autoComplete="off"
        // Hints the on-screen keyboard without constraining what can be typed;
        // validation, not the keyboard, decides what is acceptable.
        pattern="[0-9.\-]*"
        placeholder={field.placeholder}
        disabled={disabled}
        aria-invalid={error !== undefined}
        aria-describedby={describedBy(field, ids, error !== undefined)}
        className={inputClass(error !== undefined)}
      />
    </FieldShell>
  );
}
