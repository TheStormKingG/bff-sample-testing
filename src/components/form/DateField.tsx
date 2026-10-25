import { FieldShell, describedBy, inputClass } from './FieldShell';
import type { FieldInputProps } from './fieldControl';

/**
 * The plant-local collection date.
 *
 * `type="date"` exchanges `YYYY-MM-DD` with the DOM regardless of how the
 * browser chooses to display it, which is exactly the string the sheet and the
 * sample-ID date part expect. No locale parsing happens anywhere.
 *
 * It is seeded with today's date in `America/Guyana` and remains correctable:
 * samples are sometimes logged after the fact, and a form that refuses to
 * accept yesterday's date produces a wrong record rather than a late one.
 */
export function DateField({
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
        type="date"
        disabled={disabled}
        aria-invalid={error !== undefined}
        aria-describedby={describedBy(field, ids, error !== undefined)}
        className={inputClass(error !== undefined)}
      />
    </FieldShell>
  );
}
