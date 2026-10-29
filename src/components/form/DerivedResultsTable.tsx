import { Calculator } from 'lucide-react';

import { STAGE_SCHEMAS } from '@/forms/registry';
import type { Stage } from '@/forms/types';

export interface DerivedResultsTableProps {
  readonly stage: Stage;
  /** Computed cells by field key, exactly as the server wrote them. */
  readonly derived: Readonly<Record<string, string>>;
  readonly className?: string;
}

/**
 * The values the server worked out, shown the way the lab already reads them.
 *
 * WHY THIS IS A SEPARATE TABLE AND NOT PART OF THE MEASUREMENTS LIST. A
 * measurement is something a person put on a balance and attested to; these
 * are arithmetic. The database keeps them apart for that reason —
 * `apply_measurement` refuses any column the server assigns, so they live in
 * `sample_derived_results` with no `recorded_by` at all — and the screen says
 * the same thing, because a table that mixed them would invite an operator to
 * read a computed figure as a reading they took.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. No pass, no fail, no colour, no chip. None
 * of the 34 limits in the workbook is approved, so there is nothing to judge
 * these against, and a green tick here would be an acceptance Bounty Farm
 * never gave (FR-009, UAT-05). The numbers are reported and nothing more.
 *
 * ROWS COME FROM THE REGISTRY. The list below is every `system` column on the
 * stage except column A, in registry order, so a column added to the tab
 * appears here without an edit and a column removed cannot leave a stale row.
 */
export function DerivedResultsTable({
  stage,
  derived,
  className,
}: DerivedResultsTableProps): JSX.Element | null {
  const schema = STAGE_SCHEMAS[stage];
  const rows = schema.fields.filter((f) => f.type === 'system' && f.key !== 'sample_id');
  if (rows.length === 0) return null;

  // `gsd_basis` is shown as a footnote rather than a row: it is provenance for
  // the figure above it, not a result in its own right, and a row reading
  // "GSD basis — series-ratio-top-bound/pan-excluded" in a results table reads
  // like a measurement of something.
  const basis = derived['gsd_basis'] ?? '';
  const valueRows = rows.filter((f) => f.key !== 'gsd_basis');

  return (
    <section
      className={className}
      aria-labelledby={`derived-${stage}-heading`}
    >
      <h3
        id={`derived-${stage}-heading`}
        className="flex items-center gap-2 text-base font-semibold text-slate-900"
      >
        <Calculator className="h-5 w-5 shrink-0 text-slate-500" aria-hidden="true" />
        Calculated results
      </h3>
      <p className="mt-1 text-sm text-slate-600">
        Worked out by the system from the weights you entered. Nobody types these.
      </p>

      <dl className="mt-3 divide-y divide-slate-200 rounded-neu border border-slate-200 bg-white">
        {valueRows.map((field) => {
          const value = derived[field.key] ?? '';
          const shown = value.trim() !== '';
          return (
            <div
              key={field.key}
              className="flex items-baseline justify-between gap-4 px-4 py-3"
            >
              <dt className="text-sm text-slate-700">
                {field.label}
                {field.unit !== undefined && (
                  <span className="text-slate-500"> ({field.unit})</span>
                )}
              </dt>
              <dd
                className={
                  shown
                    ? 'tabular text-right text-base font-semibold text-slate-900'
                    : 'text-right text-sm text-slate-500'
                }
              >
                {/*
                  "Not calculated", never "Not measured" and never a zero. A
                  blank here means the arithmetic had no answer to give — every
                  gross mass equal to its tare makes every share a 0/0 — and
                  both of the other wordings would assert something that was
                  not established.
                */}
                {shown ? value : 'Not calculated'}
              </dd>
            </div>
          );
        })}
      </dl>

      {basis.trim() !== '' && (
        <p className="mt-2 text-xs text-slate-500">
          Geometric standard deviation basis: <span className="tabular">{basis}</span>. The
          coarsest sieve has nothing above it and the pan has nothing below it, so both need a
          stated rule; it is recorded with the result so an old record can be read back under
          the rule that produced it.
        </p>
      )}
    </section>
  );
}
