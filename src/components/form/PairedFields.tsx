import type { ReactNode } from 'react';

import { cn } from '@/lib/cn';
import type { FieldDef } from '@/forms/types';

/**
 * Sample details and machine settings, two fields to a line.
 *
 * ===========================================================================
 * WHY THESE TWO BANDS AND NOT THE WHOLE FORM
 * ===========================================================================
 * See `PAIRED_SECTIONS` below for the rule. In short: these are the bands
 * whose fields are all SHORT and none of which is a measurement — the
 * paperwork at the top and the machine's state, not the work. Stacked one per
 * row they filled most of a phone screen before the form's actual subject
 * appeared.
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
 * ===========================================================================
 * TWO COLUMNS FROM 375px, ONE BELOW IT
 * ===========================================================================
 * 390px is the phone these forms are filled on and 375px is the next size
 * down, so the pairing covers the real devices. It stops at 320px — the width
 * `playwright.config.ts` runs its `small-phone` project at — and that
 * breakpoint is a MEASUREMENT, not a preference.
 *
 * The rule being protected is that no help text in a two-column cell may run
 * past two lines, because a three-line hint beside a field with none leaves a
 * dead zone the height of the difference. Measured at 390px and 375px every
 * sample-details hint fits two lines; at 320px the same strings run to three
 * and four. Rewriting them short enough for 320 would have cost words that
 * carry meaning — "in Guyana local time" is the whole point of that hint — so
 * below 375 the fields stack and get the full width instead, where the same
 * strings are one line.
 *
 * `tests/pairedFields.test.tsx` caps the source strings so a long one cannot
 * be committed; this breakpoint is what makes that cap achievable without
 * losing words.
 */
/**
 * The bands that go two fields to a line.
 *
 * `sample_details` was the first and the reasoning above is written about it.
 * `settings` joined it at the owner's instruction and it fits the same
 * description: how the machine was set — a screen size, a roll gap, a drum
 * speed, a frequency, a vibration time, the stack in use — is short, is a
 * setting rather than a reading, and is not the thing the operator walked to
 * the bench to record.
 *
 * `test_results` is deliberately NOT here. A measurement wants the full width
 * of the screen, its unit beside it, and nothing competing for the same
 * glance; halving that to fit two numbers on a line would be optimising the
 * part of the form that should be slowest to fill.
 */
export const PAIRED_SECTIONS: ReadonlySet<string> = new Set(['sample_details', 'settings']);

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
        <div key={row[0]!.key} className="grid grid-cols-1 gap-x-4 min-[375px]:grid-cols-2">
          {row.map((field) => (
            <div
              key={field.key}
              // A lone trailing field takes the whole line rather than half of
              // it. An odd count is the normal case — five of the eight tabs
              // have five sample-details columns — and a half-width control
              // with nothing beside it reads as a column that failed to load.
              // `paired-cell` is read by `HelpHint`, which allows two lines
              // of hint in this narrower column and one everywhere else.
              className={cn('paired-cell', row.length === 1 && 'min-[375px]:col-span-2')}
            >
              {renderField(field)}
            </div>
          ))}
        </div>
      ))}
    </>
  );
}
