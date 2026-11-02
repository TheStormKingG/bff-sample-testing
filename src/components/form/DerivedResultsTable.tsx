import { Calculator } from 'lucide-react';

import { STAGE_SCHEMAS } from '@/forms/registry';
import type { Stage } from '@/forms/types';
import { dgmStanding, DGM_STANDING_LABELS, type DgmTargetRange } from '@/lib/dgmTargets';

/** The one computed column that is lifted out of the list below. */
const DGM_KEY = 'dgm_um';

export interface DerivedResultsTableProps {
  readonly stage: Stage;
  /** Computed cells by field key, exactly as the server wrote them. */
  readonly derived: Readonly<Record<string, string>>;
  /**
   * The DGM range this form is aiming at, when an administrator has set one.
   * `null` shows the sample's own figure with no limits either side of it.
   */
  readonly target?: DgmTargetRange | null;
  readonly className?: string;
}

/** One line of the DGM stack: a limit, or the sample's own figure. */
interface DgmLine {
  readonly key: string;
  readonly label: string;
  /** What orders the stack. `null` keeps a figure that has no number last. */
  readonly sortValue: number | null;
  readonly text: string;
  readonly tone: 'limit' | 'sample';
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
  target = null,
  className,
}: DerivedResultsTableProps): JSX.Element | null {
  const schema = STAGE_SCHEMAS[stage];
  const rows = schema.fields.filter((f) => f.type === 'system' && f.key !== 'sample_id');
  if (rows.length === 0) return null;

  /*
    Nothing computed at all means nothing to show, even on a tab that HAS
    computed columns.

    This became load-bearing when the sieve test moved onto `2 Ground`,
    `6 Crumble` and `7 Mash`, where the weights are optional: a sample
    registered at the mill before the lab has run the test carries no weights
    and therefore no results. Without this, every such record would show a
    "Calculated results" card listing nine rows of "Not calculated" — a
    heading asserting a calculation over an answer that reads as a failure,
    for a test nobody has run yet.

    An all-zero weighing is NOT this case and still renders: `total_retained_g`
    comes back as "0.00", which is a measurement, so the map is not empty.
    The emptiness tested here is the absence of any computation, not the
    absence of an answer from one.
  */
  if (rows.every((field) => (derived[field.key] ?? '').trim() === '')) return null;

  // `gsd_basis` is shown as a footnote rather than a row: it is provenance for
  // the figure above it, not a result in its own right, and a row reading
  // "GSD basis — series-ratio-top-bound/pan-excluded" in a results table reads
  // like a measurement of something.
  const basis = derived['gsd_basis'] ?? '';

  /*
    ===========================================================================
    DGM IS LIFTED OUT OF THE LIST
    ===========================================================================
    It was the third of nine rows in a table whose other eight are indices,
    shares and provenance. It is the one figure the miller changes the mill
    for, and the only one with a range to be read against, so it is shown
    first, on its own, with that range around it.

    THE STACK IS A NUMBER LINE, read top to bottom, coarse to fine. Sorting
    the three lines by value descending is the whole of the layout rule and
    it produces every case the screen needs without a branch:

      within   upper limit / THIS SAMPLE / lower limit
      coarser  THIS SAMPLE / upper limit / lower limit
      finer    upper limit / lower limit / THIS SAMPLE

    A sample sitting exactly ON a limit keeps the limit above it, because the
    seed order is [upper, sample, lower] and `Array.prototype.sort` is stable
    — and because `dgmStanding` counts both edges as within, so a figure that
    reads 1200.0 against a 1200 limit must not be shown outside the range.
  */
  const dgmField = rows.find((f) => f.key === DGM_KEY) ?? null;
  const dgmText = (derived[DGM_KEY] ?? '').trim();
  const dgmValue = dgmText === '' ? null : Number(dgmText);
  const dgmNumber = dgmValue !== null && Number.isFinite(dgmValue) ? dgmValue : null;
  const standing = target === null || dgmNumber === null ? null : dgmStanding(dgmNumber, target);

  const dgmLines: readonly DgmLine[] =
    dgmField === null
      ? []
      : (
          [
            ...(target === null
              ? []
              : [
                  {
                    key: 'upper',
                    label: 'Upper limit',
                    sortValue: target.upperMicrons,
                    text: `${target.upperMicrons} µm`,
                    tone: 'limit' as const,
                  },
                ]),
            {
              key: 'sample',
              label: 'This sample',
              sortValue: dgmNumber,
              // The stored string verbatim, never re-rounded. The record
              // holds one number for this sample and the screen shows that
              // number; a tidier version here would be a second figure for
              // the reader to reconcile against the spreadsheet.
              text: dgmText === '' ? 'Not calculated' : `${dgmText} µm`,
              tone: 'sample' as const,
            },
            ...(target === null
              ? []
              : [
                  {
                    key: 'lower',
                    label: 'Lower limit',
                    sortValue: target.lowerMicrons,
                    text: `${target.lowerMicrons} µm`,
                    tone: 'limit' as const,
                  },
                ]),
          ] satisfies DgmLine[]
        ).sort((a, b) => (b.sortValue ?? -Infinity) - (a.sortValue ?? -Infinity));

  const valueRows = rows.filter((f) => f.key !== 'gsd_basis' && f.key !== DGM_KEY);

  return (
    <section
      className={className}
      aria-labelledby={`derived-${stage}-heading`}
    >
      <h3
        id={`derived-${stage}-heading`}
        className="flex items-center gap-2 text-base font-semibold text-slate-900"
      >
        <Calculator className="h-5 w-5 shrink-0 text-slate-600" aria-hidden="true" />
        Calculated results
      </h3>
      <p className="mt-1 text-sm text-slate-600">
        Worked out by the system from the weights you entered. Nobody types these.
      </p>

      {dgmField !== null ? (
        <section className="mt-3" aria-labelledby={`dgm-${stage}-heading`}>
          <h4
            id={`dgm-${stage}-heading`}
            className="text-sm font-semibold text-slate-900"
          >
            Average particle size (DGM)
          </h4>

          <ul className="mt-2 space-y-1.5">
            {dgmLines.map((line) => (
              <li
                key={line.key}
                className={
                  // Green is the region that was aimed at; blue is this
                  // sample. Neither colour means good or bad — a sample
                  // outside the range keeps the same blue it has inside it,
                  // because where the grind sits is information for the
                  // miller and not a disposition. See `src/lib/dgmTargets.ts`.
                  line.tone === 'sample'
                    ? 'flex items-baseline justify-between gap-3 rounded-neu bg-blue-100 px-4 py-3'
                    : 'flex items-baseline justify-between gap-3 rounded-neu bg-green-100 px-4 py-2'
                }
              >
                <span
                  className={
                    line.tone === 'sample'
                      ? 'text-sm font-semibold text-blue-950'
                      : 'text-sm font-medium text-green-900'
                  }
                >
                  {line.label}
                </span>
                <span
                  className={
                    line.tone === 'sample'
                      ? 'tabular text-right text-lg font-bold text-blue-950'
                      : 'tabular text-right text-base font-semibold text-green-900'
                  }
                >
                  {line.text}
                </span>
              </li>
            ))}
          </ul>

          {/*
            The standing IN WORDS as well as in position and colour. The
            ordering of the stack and the two greens carry it for a reader who
            can see them; this carries it for everyone else, and it is the
            sentence an auditor can quote.
          */}
          {standing !== null ? (
            <p className="mt-2 text-sm font-semibold text-slate-800">
              {DGM_STANDING_LABELS[standing]}.
            </p>
          ) : null}

          {target !== null ? (
            <p className="mt-1 text-xs text-slate-600">
              Target {target.lowerMicrons}–{target.upperMicrons} µm. {target.basis} It is a
              target for the mill, not an approved specification: nothing in this system
              accepts or rejects a sample on it.
            </p>
          ) : null}
        </section>
      ) : null}

      <dl className="mt-3 divide-y divide-slate-200 rounded-neu bg-neu-base shadow-neu-sm">
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
                  <span className="text-slate-600"> ({field.unit})</span>
                )}
              </dt>
              <dd
                className={
                  shown
                    ? 'tabular text-right text-base font-semibold text-slate-900'
                    : 'text-right text-sm text-slate-600'
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
        <p className="mt-2 text-xs text-slate-600">
          Geometric standard deviation basis: <span className="tabular">{basis}</span>. The
          coarsest sieve has nothing above it and the pan has nothing below it, so both need a
          stated rule; it is recorded with the result so an old record can be read back under
          the rule that produced it.
        </p>
      )}
    </section>
  );
}
