import type { ReactNode } from 'react';

import { DEFAULT_SIEVE_PRESET, sievePresetById } from '@/lib/dgm';
import type { FieldDef } from '@/forms/types';

/**
 * The fourteen sieve weights, laid out the way the bench sheet is.
 *
 * ===========================================================================
 * WHY A TABLE AND NOT FOURTEEN STACKED FIELDS
 * ===========================================================================
 * The weighing is seven PAIRS. An operator puts a sieve on the balance, reads
 * it, tips the sample in, reads it again — and does that seven times down a
 * stack whose order is fixed and physical. Rendered as fourteen full-width
 * fields one under the other, that structure disappears: the screen becomes a
 * column of near-identical boxes labelled "ABNT 16 empty sieve", "ABNT 16
 * sieve + sample", and the operator has to read a label to know where they
 * are. Two numbers that belong to one sieve end up a scroll apart.
 *
 * Here the stack IS the layout. One row per sieve, in stack order, with the
 * sieve named once on the left instead of fourteen times, so the pairing is
 * carried by position rather than by reading.
 *
 * ===========================================================================
 * WHAT THIS DELIBERATELY DOES NOT DO
 * ===========================================================================
 * It does not render inputs. Every cell is whatever `renderField` returns,
 * which is the same `FieldRenderer` every other field on every other form
 * goes through. That is not a detail — five separate mechanisms find fields by
 * their registry key (the error summary, server-issue routing, per-section
 * error counts, `revealField`'s focus move, and applicability clearing), and
 * a hand-rolled `<input>` here would be invisible to all five. This file
 * changes the arrangement and nothing else.
 *
 * The grid stays three columns at every width. A phone is where this form is
 * actually used, and collapsing to one column would rebuild the exact stack
 * of anonymous boxes the layout exists to replace.
 */
export interface SieveGridProps {
  /** The fourteen mass fields, in registry order. */
  readonly fields: readonly FieldDef[];
  /** The chosen series, for the row headings. Falls back to the default. */
  readonly presetId: string;
  /** Renders one field; supply the compact variant. */
  readonly renderField: (field: FieldDef) => ReactNode;
}

/** `sieve3_tare_g` -> 3. Null for anything that is not a sieve mass. */
function sieveIndexOf(key: string): number | null {
  const match = /^sieve(\d+)_(tare|gross)_g$/.exec(key);
  if (match === null) return null;
  const n = Number(match[1]);
  return Number.isInteger(n) ? n : null;
}

/** True when this field is one of the paired sieve masses. */
export function isSieveMassField(field: FieldDef): boolean {
  return sieveIndexOf(field.key) !== null;
}

export function SieveGrid({ fields, presetId, renderField }: SieveGridProps): JSX.Element | null {
  const preset = sievePresetById(presetId) ?? DEFAULT_SIEVE_PRESET;

  // Pair by the number in the key rather than by array position: a field that
  // failed to render, or a registry reordering, would otherwise silently pair
  // one sieve's tare with another's gross — two valid-looking numbers in the
  // wrong row, which no validation could catch.
  const rows = preset.positions.map((position, i) => {
    const n = i + 1;
    return {
      position,
      tare: fields.find((f) => f.key === `sieve${n}_tare_g`),
      gross: fields.find((f) => f.key === `sieve${n}_gross_g`),
    };
  });
  if (rows.every((r) => r.tare === undefined && r.gross === undefined)) return null;

  return (
    <div className="py-2">
      {/*
        A real <table> would be the honest element for tabular data, but these
        cells are form controls that each carry their own label, and a grid
        keeps that association simple. The column headings below are therefore
        presentational: every input still has its own `sr-only` label naming
        both the sieve and which of the two weights it is, so nothing here is
        load-bearing for a screen reader.
      */}
      <div
        aria-hidden="true"
        className="grid grid-cols-[minmax(3.5rem,auto)_1fr_1fr] items-end gap-x-2 gap-y-1 pb-1"
      >
        <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">Sieve</span>
        <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          Empty (g)
        </span>
        <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          + Sample (g)
        </span>
      </div>

      <div className="grid grid-cols-[minmax(3.5rem,auto)_1fr_1fr] items-start gap-x-2 gap-y-2">
        {rows.map(({ position, tare, gross }) => (
          <div key={position.abnt} className="contents">
            {/*
              The aperture sits under the sieve name rather than in the help
              text of both inputs, where it used to be repeated fourteen times.
              The pan is given an em dash, not a number: it is a solid pan and
              the figure the series carries for it is a bookkeeping value, not
              an opening anything passes through.
            */}
            <div className="flex min-h-tap flex-col justify-center pr-1">
              <span className="text-sm font-semibold leading-tight text-slate-900">
                {position.isPan ? 'Pan' : position.abnt}
              </span>
              <span className="tabular text-xs leading-tight text-slate-500">
                {position.isPan ? '—' : `${position.apertureMicrons} µm`}
              </span>
            </div>
            <div>{tare === undefined ? null : renderField(tare)}</div>
            <div>{gross === undefined ? null : renderField(gross)}</div>
          </div>
        ))}
      </div>

      <p className="mt-3 text-sm text-slate-600">
        Weigh each sieve empty, then again with whatever stayed on it. The system works out what
        was retained; nothing here needs to be subtracted by hand.
      </p>
    </div>
  );
}
