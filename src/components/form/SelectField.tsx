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
 *
 * ===========================================================================
 * A RETIRED OPTION IS SHOWN ONLY ON THE RECORD THAT HOLDS IT
 * ===========================================================================
 * Three of these lists were free text until 0036, so the database holds
 * values no operator should pick again — `Crumble` in a feed TYPE column,
 * commissioning names like `TEST OPERATOR`. Those are marked `retired` in the
 * registry and they are still legal: they validate and they encode, because
 * `encodeEnum` throws on a code it cannot find and an old record has to stay
 * writable.
 *
 * What must NOT happen is this control rendering "Choose…" over a record that
 * does hold an answer. An operator who sees an empty dropdown picks something,
 * and a value nobody observed replaces one somebody did. So a retired option
 * appears when — and only when — it is this record's current value, named as
 * no longer offered so the reader knows why it is not in anyone else's list.
 */
export function SelectField({
  field,
  ids,
  required,
  error,
  control,
  disabled,
  currentValue,
}: FieldInputProps): JSX.Element {
  return (
    <FieldShell field={field} ids={ids} required={required} error={error}>
      <select
        {...control}
        id={ids.input}
        disabled={disabled}
        aria-invalid={error !== undefined}
        aria-required={required}
        aria-describedby={describedBy(field, ids, error !== undefined)}
        className={inputClass(error !== undefined)}
      >
        <option value="">Choose…</option>
        {(field.options ?? [])
          // `currentValue` and not `control.value`: these inputs are
          // UNCONTROLLED — `control` is react-hook-form's `register()` return
          // and carries no value at all — and `currentValue` is the prop that
          // exists for exactly this kind of display decision.
          .filter((option) => option.retired !== true || option.value === currentValue)
          .map((option) => (
            <option key={option.value} value={option.value}>
              {option.retired === true ? `${option.label} (no longer offered)` : option.label}
            </option>
          ))}
      </select>
    </FieldShell>
  );
}
