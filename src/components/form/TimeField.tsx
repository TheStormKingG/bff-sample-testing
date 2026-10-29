import { FieldShell, describedBy, inputClass } from './FieldShell';
import type { FieldInputProps } from './fieldControl';

/**
 * The plant-local collection time, 24-hour.
 *
 * `type="time"` exchanges `HH:mm` with the DOM even where the browser displays
 * a 12-hour clock, so the stored string never depends on the device locale
 * (PRD §6.1 forbids relying on it). Seeded with the current Guyana time and
 * correctable, for the same reason as the date.
 */
export function TimeField({
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
        type="time"
        disabled={disabled}
        aria-invalid={error !== undefined}
        aria-required={required}
        aria-describedby={describedBy(field, ids, error !== undefined)}
        className={inputClass(error !== undefined)}
      />
    </FieldShell>
  );
}
