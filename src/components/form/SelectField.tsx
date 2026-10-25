import { FieldShell, describedBy, inputClass } from './FieldShell';
import type { FieldInputProps } from './fieldControl';

/**
 * A controlled-vocabulary dropdown.
 *
 * The `value` on every option is the stored CODE and the text is the display
 * label (PRD §6.1). An operator picking "AM after mill" stores `AM`; the sheet
 * cell receives the label, and the sample-ID prefix is derived from the code,
 * never by substring-matching the label.
 *
 * The placeholder option carries an empty value so "nothing chosen" stays
 * distinguishable from a real choice, and it is not selectable once the field
 * is required — an empty submission must raise an error, not silently pick the
 * first option.
 */
export function SelectField({
  field,
  ids,
  required,
  error,
  control,
  disabled,
}: FieldInputProps): JSX.Element {
  return (
    <FieldShell field={field} ids={ids} required={required} error={error}>
      <select
        {...control}
        id={ids.input}
        disabled={disabled}
        aria-invalid={error !== undefined}
        aria-describedby={describedBy(field, ids, error !== undefined)}
        className={inputClass(error !== undefined)}
      >
        <option value="">Choose…</option>
        {(field.options ?? []).map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </FieldShell>
  );
}
