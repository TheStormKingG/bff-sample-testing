import { useEffect, useMemo, useState } from 'react';

import { Card, InfoNote } from '@/components/records/common';
import { Button } from '@/components/ui/Button';
import { STAGE_SCHEMAS } from '@/forms/registry';
import type { Stage } from '@/forms/types';
import { useDgmTargets } from '@/hooks/useDgmTargets';
import type { AdminActionInput } from '@/hooks/useAdmin';
import {
  DGM_TARGET_STAGES,
  parseDgmTargets,
  type DgmTargetDocument,
} from '@/lib/dgmTargets';

/**
 * The DGM range each sieve form is aiming at.
 *
 * ===========================================================================
 * THIS SCREEN SETS THE ONLY LIMIT IN THE SYSTEM
 * ===========================================================================
 * Everywhere else, this application reports and declines to judge: the
 * workbook's 34 limits are unapproved, so no screen shows a pass, a fail or a
 * colour that means either. What is set here is drawn as a green band on a
 * quality record, which is the closest thing to an acceptance the system
 * produces — so three things are enforced rather than encouraged.
 *
 *   A SOURCE IS REQUIRED. Not a nicety: the figures are printed beside the
 *   sample's own on the results screen, and a target with no stated origin
 *   reads as an approved specification to anybody who did not set it. The
 *   Save button stays disabled until every filled-in row says where its
 *   numbers came from.
 *
 *   BLANK IS A REAL STATE, AND IT IS THE DEFAULT FOR TWO FORMS. Clearing both
 *   figures removes the target, and the results screen goes back to showing
 *   DGM with nothing around it. `4 Pellets` and `6 Crumble` ship this way on
 *   purpose: the published guidance behind the seeded figures covers the
 *   grind before pelleting and mash feed, and gives no geometric-mean target
 *   for a finished pellet, which the literature sizes by sieve cut instead.
 *   An empty row here is the screen saying so, not a setting somebody forgot.
 *
 *   IT CHANGES NO RECORDED FIGURE. Saving this re-colours screens. It does
 *   not re-compute, re-grade or re-open anything, and no sample's stored
 *   result moves. The note on the card says that, because an administrator
 *   about to change a limit in a quality system is entitled to know whether
 *   they are about to alter history.
 */
export interface DgmTargetPanelProps {
  readonly onRequest: (action: {
    readonly input: Omit<AdminActionInput, 'reason'>;
    readonly title: string;
    readonly prompt: string;
    readonly confirmLabel: string;
  }) => void;
  readonly mayEdit: boolean;
}

/** One row, held as the strings the inputs actually contain. */
interface DraftRow {
  readonly lower: string;
  readonly upper: string;
  readonly basis: string;
}

const BLANK: DraftRow = { lower: '', upper: '', basis: '' };

function toDraft(document: DgmTargetDocument): Record<string, DraftRow> {
  const out: Record<string, DraftRow> = {};
  for (const stage of DGM_TARGET_STAGES) {
    const range = document.ranges[stage];
    out[stage] =
      range === undefined
        ? BLANK
        : {
            lower: String(range.lowerMicrons),
            upper: String(range.upperMicrons),
            basis: range.basis,
          };
  }
  return out;
}

/** A row the administrator has started filling in, however incompletely. */
function isTouched(row: DraftRow): boolean {
  return row.lower.trim() !== '' || row.upper.trim() !== '' || row.basis.trim() !== '';
}

export function DgmTargetPanel({ onRequest, mayEdit }: DgmTargetPanelProps): JSX.Element {
  const targets = useDgmTargets();
  const stored = targets.data?.document ?? null;
  const [draft, setDraft] = useState<Record<string, DraftRow> | null>(null);

  // Seeded once, and never re-seeded over an edit in progress.
  useEffect(() => {
    if (stored !== null && draft === null) setDraft(toDraft(stored));
  }, [stored, draft]);

  const rows = draft ?? toDraft({ version: 1, ranges: {} });

  const edited = useMemo<DgmTargetDocument>(() => {
    const ranges: Record<string, unknown> = {};
    for (const stage of DGM_TARGET_STAGES) {
      const row = rows[stage] ?? BLANK;
      // An untouched row is an ABSENT target, not a zero one. Three empty
      // boxes must not become `{lower: 0, upper: 0}` and a band of no width.
      if (!isTouched(row)) continue;
      ranges[stage] = {
        lowerMicrons: Number(row.lower),
        upperMicrons: Number(row.upper),
        basis: row.basis.trim(),
      };
    }
    return { version: 1, ranges } as DgmTargetDocument;
  }, [rows]);

  const check = useMemo(() => parseDgmTargets(edited), [edited]);
  const changed =
    stored !== null && JSON.stringify(stored.ranges) !== JSON.stringify(edited.ranges);

  function set(stage: Stage, field: keyof DraftRow, value: string): void {
    setDraft((current) => {
      const base = current ?? rows;
      return { ...base, [stage]: { ...(base[stage] ?? BLANK), [field]: value } };
    });
  }

  function submit(): void {
    if (!check.ok) return;
    onRequest({
      input: { action: 'set_dgm_target_ranges', document: check.document },
      title: 'Change the DGM targets',
      prompt:
        'State why the targets are changing — a nutritionist’s revision, a change of ' +
        'product. The old and new figures are both recorded in the audit trail, so an old ' +
        'record can be read against the target that was in force when it was made.',
      confirmLabel: 'Save the DGM targets',
    });
  }

  return (
    <div className="flex flex-col gap-6">
      <InfoNote>
        The average particle size each sieve form is aiming at. It is shown as a green band on
        the particle-size chart and as the two limits either side of the sample’s own figure. It
        is a target for the mill, <strong>not an approved specification</strong>: nothing in this
        system accepts, rejects or holds a sample because of it.
      </InfoNote>

      {targets.data?.problem !== null && targets.data?.problem !== undefined ? (
        <InfoNote tone="warning">
          <span>
            The stored targets are not in use, because they could not be read:{' '}
            {targets.data.problem} No band is being drawn anywhere. Saving this screen will
            replace the stored document.
          </span>
        </InfoNote>
      ) : null}

      <Card title="DGM targets">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[42rem] border-collapse text-left text-sm">
            <thead>
              {/*
                NOT `uppercase`. CSS `text-transform: uppercase` maps µ
                (U+00B5, MICRO SIGN) to Μ (U+039C, GREEK CAPITAL MU), which
                at this size is indistinguishable from a Latin M — so
                "Lower (µm)" renders as "LOWER (MM)" and states millimetres
                on the screen that sets micrometres. The same thousandfold
                error was found on the sieve table screen and fixed there.
              */}
              <tr className="border-b border-slate-200 text-xs font-semibold tracking-wide text-slate-500">
                <th className="py-2 pr-3">Form</th>
                <th className="py-2 pr-3">Lower (µm)</th>
                <th className="py-2 pr-3">Upper (µm)</th>
                <th className="py-2">Where the figures came from</th>
              </tr>
            </thead>
            <tbody>
              {DGM_TARGET_STAGES.map((stage) => {
                const row = rows[stage] ?? BLANK;
                const schema = STAGE_SCHEMAS[stage];
                return (
                  <tr key={stage} className="border-b border-slate-100 align-top">
                    <td className="py-2 pr-3 text-slate-700">
                      {schema.ordinal}. {schema.title}
                      {!isTouched(row) ? (
                        <span className="ml-1 text-xs text-slate-500">(no target)</span>
                      ) : null}
                    </td>
                    <td className="py-2 pr-3">
                      <input
                        aria-label={`${schema.title} lower figure in micrometres`}
                        inputMode="decimal"
                        value={row.lower}
                        disabled={!mayEdit}
                        onChange={(e) => set(stage, 'lower', e.target.value)}
                        className="min-h-tap w-24 rounded-md border border-slate-300 px-2 py-1 tabular"
                      />
                    </td>
                    <td className="py-2 pr-3">
                      <input
                        aria-label={`${schema.title} upper figure in micrometres`}
                        inputMode="decimal"
                        value={row.upper}
                        disabled={!mayEdit}
                        onChange={(e) => set(stage, 'upper', e.target.value)}
                        className="min-h-tap w-24 rounded-md border border-slate-300 px-2 py-1 tabular"
                      />
                    </td>
                    <td className="py-2">
                      <textarea
                        aria-label={`${schema.title} source for the figures`}
                        rows={2}
                        value={row.basis}
                        disabled={!mayEdit}
                        onChange={(e) => set(stage, 'basis', e.target.value)}
                        className="w-full min-w-[14rem] rounded-md border border-slate-300 px-2 py-1"
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {!check.ok ? (
          <p className="mt-4 text-sm font-semibold text-red-800">{check.reason}</p>
        ) : null}

        <InfoNote>
          <span>
            Clearing both figures on a row <strong>removes</strong> that form’s target: the
            results screen then shows the average particle size with nothing around it, and the
            chart draws no band. Saving changes no figure that has already been recorded — it
            changes what the screens draw around them, for old records as well as new ones.
          </span>
        </InfoNote>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button onClick={submit} disabled={!mayEdit || !check.ok || !changed}>
            Save the DGM targets
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
              Your role does not change targets.
            </span>
          ) : null}
        </div>
      </Card>
    </div>
  );
}
