import type { ReactNode } from 'react';

import type { FieldDef } from '@/forms/types';

/**
 * Sample details, two fields to a line.
 *
 * ===========================================================================
 * WHY THESE SIX FIELDS AND NOT THE WHOLE FORM
 * ===========================================================================
 * The sample-details band is the only one whose fields are all SHORT and all
 * ADMINISTRATIVE: a date, a time, a point, a material, a batch number, a name.
 * None of them is a measurement, none carries a unit, and none is the thing
 * the operator walked to the bench to record. Stacked one per row they filled
 * most of a phone screen before the form's actual subject appeared, so the
 * reading this layout acts on is that they are the paperwork at the top, not
 * the work.
 *
 * Test results are deliberately left alone. A measurement wants the full width
 * of the screen, its unit beside it and nothing competing for the same glance;
 * halving that to fit two numbers on a line would be optimising the part of
 * the form that should be slowest to fill.
 *
 * ===========================================================================
 * WHY PAIRS IN REGISTRY ORDER RATHER THAN A NAMED LAYOUT
 * ===========================================================================
 * Nothing here names a stage or a field. The fields arrive in registry order
 * and are taken two at a time, so on `2 Ground` that produces exactly
 * date | time, sampling point | material, batch | sampled by — and on the
 * five-field tabs it produces date | time, feed type | batch no., then
 * sampled by. A stage that gains or loses a sample-details column re-pairs
 * itself with no change to this file, which is the same rule the rest of the
 * form follows (PRD NFR-006).
 *
 * The ordering is the REGISTRY's, which is the workbook's column order, so a
 * form read top-to-bottom still matches the row it will become.
 *
 * ===========================================================================
 * WHY EACH ROW IS ITS OWN ELEMENT
 * ===========================================================================
 * `FormSection` separates fields with `divide-y` on the container, which draws
 * a rule between its direct children. One grid holding all six would be a
 * single child and the rules would vanish; a row per element keeps exactly one
 * rule between lines, which is the rhythm the one-per-row layout already had.
 *
 * TWO COLUMNS AT EVERY WIDTH, including a 390px phone, which is where this
 * form is actually filled in. Collapsing to one column below a breakpoint
 * would mean the change did nothing on the device it was asked for. The grid
 * does not shrink the tap targets: the controls keep their full height and
 * only lose width, and the narrowest of them measured 171px.
 */
export interface PairedFieldsProps {
  /** Sample-details fields, in registry order. */
  readonly fields: readonly FieldDef[];
  /** Renders one field: the ordinary renderer, not the compact variant. */
  readonly renderField: (field: FieldDef) => ReactNode;
}

/** `[a, b, c, d, e]` -> `[[a, b], [c, d], [e]]`. */
function inPairs<T>(items: readonly T[]): T[][] {
  const rows: T[][] = [];
  for (let i = 0; i < items.length; i += 2) {
    rows.push(items.slice(i, i + 2));
  }
  return rows;
}

export function PairedFields({ fields, renderField }: PairedFieldsProps): JSX.Element | null {
  if (fields.length === 0) return null;

  return (
    <>
      {inPairs(fields).map((row) => (
        // Keyed on the first field in the row. Field keys are unique within a
        // stage, so the first one names the row uniquely and stably.
        <div key={row[0]!.key} className="grid grid-cols-2 gap-x-4">
          {row.map((field) => (
            <div
              key={field.key}
              // A lone trailing field takes the whole line rather than half of
              // it. An odd count is the normal case — five of the eight tabs
              // have five sample-details columns — and a half-width control
              // with nothing beside it reads as a column that failed to load.
              className={row.length === 1 ? 'col-span-2' : undefined}
            >
              {renderField(field)}
            </div>
          ))}
        </div>
      ))}
    </>
  );
}
