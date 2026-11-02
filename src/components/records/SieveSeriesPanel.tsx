import { useEffect, useMemo, useState } from 'react';

import { Card, InfoNote } from '@/components/records/common';
import { Button } from '@/components/ui/Button';
import { useSieveSeries } from '@/hooks/useSieveSeries';
import type { AdminActionInput } from '@/hooks/useAdmin';
import {
  defaultSieveSeriesDocument,
  parseSieveSeries,
  renamedPositions,
  type SieveSeriesDocument,
} from '@/lib/sieveSeries';

/**
 * The lab's sieve table, as an administrator may correct it.
 *
 * ===========================================================================
 * WHY THIS SCREEN SAYS SO MUCH
 * ===========================================================================
 * Three columns, seven rows, and every one of them changes what a recorded
 * figure means. An administrator editing this is almost always doing one
 * small, safe thing — a sieve was replaced and weighs 4 g more than the last
 * one — and the screen must not bury that in warnings. But two of the three
 * columns have consequences that are genuinely not guessable from the form,
 * and a person who finds them out afterwards finds them out from a record
 * that is already wrong.
 *
 * So the empty weight is presented plainly, and the other two carry their
 * consequence beside them:
 *
 *   APERTURE. Two of the nine computed figures follow it — the geometric
 *   standard deviation and the DPG legacy index, both built on the per-bin
 *   geometric means. DGM, the fineness module and the uniformity bands do
 *   NOT: `kj` is positional and DGM is `104.14 × 2 ** finenessModule`. An
 *   administrator who changes an aperture and watches DGM stand still has to
 *   have been told first, or they will change it again.
 *
 *   DESIGNATION. The workbook's row-4 headings FOLLOW it. `expectedHeaders`
 *   derives the twelve sieve headings from this table, and the sync worker
 *   rewrites those cells in the live sheet on its next pass — the four tabs
 *   that carry a sieve test, those columns only. Nothing has to be retyped.
 *   The screen still names what is about to change, because the rewrite
 *   happens a moment later on a machine the administrator cannot see, and a
 *   heading changing in a quality record without warning is worse than a
 *   heading changing with one. The pan's heading is the exception and says
 *   so: it reads "Pan", not a designation, because the workbook's own
 *   conversion table has not settled whether the pan is ABNT 400.
 *
 * ===========================================================================
 * IT SAVES WHOLE OR NOT AT ALL
 * ===========================================================================
 * `parseSieveSeries` validates the edited table before anything is sent, and
 * the server validates it again in `rpc_set_sieve_series` because this runs
 * in a browser and is not a control. Half an overridden stack would compute a
 * figure from one lab's apertures and another's tares and present it as a
 * measurement.
 */
export interface SieveSeriesPanelProps {
  readonly onRequest: (action: {
    // The reason is collected by the page's own confirmation dialog, which is
    // where every audited administrative action asks for one.
    readonly input: Omit<AdminActionInput, 'reason'>;
    readonly title: string;
    readonly prompt: string;
    readonly confirmLabel: string;
  }) => void;
  readonly mayEdit: boolean;
}

/** One row, held as the strings the inputs actually contain. */
interface DraftRow {
  readonly abnt: string;
  readonly apertureMicrons: string;
  readonly tareDefaultGrams: string;
}

function toDraft(document: SieveSeriesDocument): DraftRow[] {
  return document.positions.map((p) => ({
    abnt: p.abnt,
    apertureMicrons: String(p.apertureMicrons),
    tareDefaultGrams: String(p.tareDefaultGrams),
  }));
}

export function SieveSeriesPanel({ onRequest, mayEdit }: SieveSeriesPanelProps): JSX.Element {
  const series = useSieveSeries();
  const stored = series.data?.document ?? null;
  const [draft, setDraft] = useState<DraftRow[] | null>(null);

  // Seeded once the stored table arrives, and never re-seeded over an edit in
  // progress: re-seeding on a background refetch would discard typing.
  useEffect(() => {
    if (stored !== null && draft === null) setDraft(toDraft(stored));
  }, [stored, draft]);

  const rows = draft ?? toDraft(defaultSieveSeriesDocument());

  const edited = useMemo<SieveSeriesDocument>(
    () => ({
      version: 1,
      positions: rows.map((r) => ({
        abnt: r.abnt.trim(),
        apertureMicrons: Number(r.apertureMicrons),
        tareDefaultGrams: Number(r.tareDefaultGrams),
      })),
    }),
    [rows],
  );

  const check = useMemo(() => parseSieveSeries(edited), [edited]);
  const renames = useMemo(
    () => (stored === null ? [] : renamedPositions(stored, edited)),
    [stored, edited],
  );
  const changed = stored !== null && JSON.stringify(stored) !== JSON.stringify(edited);

  function set(index: number, field: keyof DraftRow, value: string): void {
    setDraft((current) => {
      const base = current ?? rows;
      return base.map((row, i) => (i === index ? { ...row, [field]: value } : row));
    });
  }

  function submit(): void {
    if (!check.ok) return;
    onRequest({
      input: { action: 'set_sieve_series', table: check.document },
      title: 'Replace the sieve table',
      prompt:
        'State why the sieve table is changing — a sieve replaced, a stack re-calibrated. ' +
        'Every future test is measured against this table, and the old and new values are ' +
        'both recorded in the audit trail.',
      confirmLabel: 'Save the sieve table',
    });
  }

  return (
    <div className="flex flex-col gap-6">
      <InfoNote>
        The stack as it stands on the bench, coarsest first. The empty weights seed the tare
        fields on every sieve form, and the apertures are what DGM and the size spread are
        computed from. How many positions there are, which one is the pan and how the uniformity
        bands are grouped are fixed by the method and are not settings.
      </InfoNote>

      {series.data?.problem !== null && series.data?.problem !== undefined ? (
        <InfoNote tone="warning">
          <span>
            The stored sieve table is not being used, because it could not be read:{' '}
            {series.data.problem} The application is using the series it shipped with. Saving this
            screen will replace the stored table.
          </span>
        </InfoNote>
      ) : null}

      <Card title="Sieve table">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[34rem] border-collapse text-left text-sm">
            <thead>
              {/*
                NOT `uppercase`, and this is a correctness fix rather than a
                style choice. CSS `text-transform: uppercase` maps µ (U+00B5,
                MICRO SIGN) to Μ (U+039C, GREEK CAPITAL MU), which at this
                size is indistinguishable from a Latin M — so "Aperture (µm)"
                rendered as "APERTURE (MM)" and presented micrometres as
                millimetres on the screen that sets them. A thousandfold unit
                error, in a quality system, produced entirely by a text
                transform. Caught in a screenshot of the live page.
              */}
              <tr className="border-b border-slate-200 text-xs font-semibold tracking-wide text-slate-500">
                <th className="py-2 pr-3">Position</th>
                <th className="py-2 pr-3">ABNT</th>
                <th className="py-2 pr-3">Aperture (µm)</th>
                <th className="py-2">Empty weight (g)</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <tr key={index} className="border-b border-slate-100">
                  <td className="py-2 pr-3 text-slate-700">
                    {index + 1}
                    {index === rows.length - 1 ? (
                      // Named, because the last position is a solid pan and
                      // its "aperture" is a bookkeeping value rather than an
                      // opening anything passes through.
                      <span className="ml-1 text-xs text-slate-500">(pan)</span>
                    ) : null}
                  </td>
                  <td className="py-2 pr-3">
                    <input
                      aria-label={`Position ${index + 1} ABNT designation`}
                      value={row.abnt}
                      disabled={!mayEdit}
                      onChange={(e) => set(index, 'abnt', e.target.value)}
                      className="min-h-tap w-24 rounded-md border border-slate-300 px-2 py-1"
                    />
                  </td>
                  <td className="py-2 pr-3">
                    <input
                      aria-label={`Position ${index + 1} aperture in micrometres`}
                      inputMode="decimal"
                      value={row.apertureMicrons}
                      disabled={!mayEdit}
                      onChange={(e) => set(index, 'apertureMicrons', e.target.value)}
                      className="min-h-tap w-28 rounded-md border border-slate-300 px-2 py-1 tabular"
                    />
                  </td>
                  <td className="py-2">
                    <input
                      aria-label={`Position ${index + 1} empty weight in grams`}
                      inputMode="decimal"
                      value={row.tareDefaultGrams}
                      disabled={!mayEdit}
                      onChange={(e) => set(index, 'tareDefaultGrams', e.target.value)}
                      className="min-h-tap w-28 rounded-md border border-slate-300 px-2 py-1 tabular"
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {!check.ok ? (
          <p className="mt-4 text-sm font-semibold text-red-800">{check.reason}</p>
        ) : null}

        {renames.length > 0 ? (
          <InfoNote tone="warning">
            <span>
              The workbook's column headings will change to match. After this is saved,{' '}
              {renames
                .map((r) => `position ${r.position} becomes ${r.to}, where it reads "ABNT ${r.from}" now`)
                .join('; ')}
              . The row-4 headings on tabs 2, 4, 6, 7 and 8 are rewritten the next time the
              spreadsheet is synchronised, which is usually within a minute. Nothing has to be
              retyped, and the figures already recorded are untouched.
            </span>
          </InfoNote>
        ) : null}

        <InfoNote>
          <span>
            Changing an aperture moves the <strong>size spread</strong> and the{' '}
            <strong>DPG legacy index</strong>, and only those two. DGM, the fineness module and
            the uniformity bands are worked out from the position in the stack rather than from
            the apertures, so they will not move. Changing an empty weight changes nothing that
            has already been recorded: it only pre-fills the next form.
          </span>
        </InfoNote>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button onClick={submit} disabled={!mayEdit || !check.ok || !changed}>
            Save the sieve table
          </Button>
          <Button
            variant="ghost"
            onClick={() => setDraft(stored === null ? null : toDraft(stored))}
            disabled={!changed}
          >
            Discard changes
          </Button>
          {!mayEdit ? (
            <span className="text-sm text-slate-600">
              Your role does not change equipment settings.
            </span>
          ) : null}
        </div>
      </Card>
    </div>
  );
}
