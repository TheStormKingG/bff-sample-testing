import { useId, type ReactNode } from 'react';
import { AlertCircle, HelpCircle } from 'lucide-react';
import { cn } from '@/lib/cn';
import { FieldControlContext, type FieldControl } from '@/components/ui/fieldContext';

export interface FieldProps {
  readonly label: ReactNode;
  readonly children: ReactNode;
  /** Supply to make the control's id stable, e.g. for an error-summary link. */
  readonly id?: string;
  readonly hint?: ReactNode;
  readonly error?: string | null;
  readonly required?: boolean;
  /** Unit of measure, shown beside the input. Workbook vocabulary, unchanged. */
  readonly unit?: string;
  /**
   * False when the source workbook records no confirmed unit for this
   * measurement. The operator is told, because a value whose unit is
   * unconfirmed can never be assessed against a limit (PRD section 5.3,
   * UAT-07) and they should not expect a result.
   */
  readonly unitConfirmed?: boolean;
  readonly className?: string;
  /** Rendered under the control — an assessment chip, a derived value. */
  readonly trailing?: ReactNode;
}

/**
 * Label, help, unit, control and error as one accessible unit.
 *
 * Requiredness is spelled out in words rather than marked with an asterisk:
 * the operators this is built for should not have to know a typographic
 * convention to find out which boxes they must fill.
 */
export function Field({
  label,
  children,
  id,
  hint,
  error,
  required = false,
  unit,
  unitConfirmed = true,
  className,
  trailing,
}: FieldProps) {
  const generated = useId();
  const controlId = id ?? `field-${generated}`;
  const hintId = `${controlId}-hint`;
  const unitId = `${controlId}-unit`;
  const errorId = `${controlId}-error`;

  const hasError = error !== undefined && error !== null && error !== '';
  const unitNote =
    unit !== undefined ? (unitConfirmed ? `Measured in ${unit}.` : null) : null;
  const unconfirmedNote =
    unit !== undefined && !unitConfirmed
      ? `The unit for this measurement is not confirmed, so the value cannot be compared against a limit.`
      : null;

  const describedBy =
    [
      hint !== undefined ? hintId : null,
      unitNote !== null || unconfirmedNote !== null ? unitId : null,
      hasError ? errorId : null,
    ]
      .filter((v): v is string => v !== null)
      .join(' ') || undefined;

  const control: FieldControl = {
    id: controlId,
    describedBy,
    invalid: hasError,
    required,
  };

  return (
    <div className={cn('space-y-1.5', className)}>
      <label htmlFor={controlId} className="block text-base font-medium text-slate-900">
        {label}
        {required ? (
          <span className="ml-2 align-middle text-xs font-semibold uppercase tracking-wide text-bff-800">
            Required
          </span>
        ) : null}
      </label>

      {hint !== undefined && (
        <p id={hintId} className="flex items-start gap-1.5 text-sm text-slate-600">
          <HelpCircle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{hint}</span>
        </p>
      )}

      <div className="flex items-stretch gap-2">
        <FieldControlContext.Provider value={control}>
          <div className="min-w-0 flex-1">{children}</div>
        </FieldControlContext.Provider>
        {unit !== undefined && (
          // aria-hidden: the same unit is already in the described-by text, so
          // announcing the suffix too would read the unit twice.
          <span
            aria-hidden="true"
            className="inline-flex min-h-tap shrink-0 items-center rounded-lg border border-slate-200 bg-slate-50 px-3 text-base text-slate-700"
          >
            {unit}
          </span>
        )}
      </div>

      {(unitNote !== null || unconfirmedNote !== null) && (
        <p
          id={unitId}
          className={cn(
            'text-sm',
            unconfirmedNote !== null ? 'text-amber-800' : 'text-slate-600',
          )}
        >
          {unconfirmedNote ?? unitNote}
        </p>
      )}

      {hasError && (
        <p id={errorId} className="flex items-start gap-1.5 text-sm font-medium text-red-800">
          <AlertCircle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </p>
      )}

      {trailing !== undefined && <div className="pt-1">{trailing}</div>}
    </div>
  );
}
