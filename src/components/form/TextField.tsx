import { FieldShell, describedBy, inputClass } from './FieldShell';
import type { FieldInputProps } from './fieldControl';

/** Single-line text, and the multi-line narrative columns. */
export function TextField({
  field,
  ids,
  required,
  error,
  control,
  disabled,
}: FieldInputProps): JSX.Element {
  const multiline = field.type === 'textarea';

  return (
    <FieldShell field={field} ids={ids} required={required} error={error}>
      {multiline ? (
        <textarea
          {...control}
          id={ids.input}
          rows={3}
          placeholder={field.placeholder}
          disabled={disabled}
          aria-invalid={error !== undefined}
          aria-describedby={describedBy(field, ids, error !== undefined)}
          className={inputClass(error !== undefined)}
        />
      ) : (
        <input
          {...control}
          id={ids.input}
          type="text"
          autoComplete="off"
          placeholder={field.placeholder}
          disabled={disabled}
          aria-invalid={error !== undefined}
          aria-describedby={describedBy(field, ids, error !== undefined)}
          className={inputClass(error !== undefined)}
        />
      )}
    </FieldShell>
  );
}
