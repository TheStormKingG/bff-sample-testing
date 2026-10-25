import { AlertTriangle } from 'lucide-react';

import type { FieldDef } from '@/forms/types';

export interface UnitBadgeProps {
  readonly field: FieldDef;
}

/**
 * The unit shown beside a measurement, and an explicit marker when the source
 * workbook does not state an approved one.
 *
 * Three distinct cases, and conflating any two of them would mislead:
 *
 *  - A unit is stated (`%`, `°C`, `µm`) — show it.
 *  - The field is dimensionless by definition (GSD) — `unitConfirmed` is
 *    `undefined`, show nothing. A GSD has no unit and that is correct.
 *  - The unit is explicitly NOT confirmed (`unitConfirmed === false`) — the
 *    only such fields are Conditioned steam pressure, whose workbook `Limits`
 *    Unit cell literally reads "to confirm", and the raw-materials other
 *    mycotoxin result, which has no defined unit at all. Say so in words, and
 *    say what follows from it: the reading cannot be assessed against a limit
 *    (PRD §5.3, UAT-07).
 *
 * The test is `=== false`, never falsy, because `undefined` means the opposite
 * thing here.
 */
export function UnitBadge({ field }: UnitBadgeProps): JSX.Element | null {
  const unconfirmed = field.unitConfirmed === false;

  if (!unconfirmed && field.unit === undefined) return null;

  if (!unconfirmed) {
    return (
      <span className="ml-2 whitespace-nowrap rounded bg-slate-100 px-2 py-0.5 text-sm font-medium text-slate-700">
        {field.unit}
      </span>
    );
  }

  return (
    <span className="ml-2 inline-flex items-center gap-1 whitespace-nowrap rounded border border-amber-400 bg-amber-50 px-2 py-0.5 text-sm font-semibold text-amber-900">
      <AlertTriangle aria-hidden="true" className="h-4 w-4 shrink-0" />
      {field.unit !== undefined ? `${field.unit} — ` : ''}unit not confirmed
    </span>
  );
}

export interface UnitNoteProps {
  readonly field: FieldDef;
  readonly id: string;
}

/**
 * The consequence of an unconfirmed unit, in plain words, wired into the
 * input's `aria-describedby` so a screen reader hears it with the field rather
 * than having to find it.
 */
export function UnitNote({ field, id }: UnitNoteProps): JSX.Element | null {
  if (field.unitConfirmed !== false) return null;
  return (
    <p id={id} className="mt-1 text-sm text-amber-900">
      The unit for this reading is not confirmed yet, so the value is recorded
      but cannot be checked against a limit.
    </p>
  );
}
