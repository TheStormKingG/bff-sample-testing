import { ChevronDown, Clock, Info, TriangleAlert } from 'lucide-react';

import type { StageSchema } from '@/forms/types';
import { useIsPhone } from '@/components/layout/viewport';

export interface InstructionStripProps {
  readonly schema: StageSchema;
}

/**
 * The "where and when to take this sample" strip above the fields (PRD §3.2:
 * "an instruction strip identifying *where* and *when* the sample is taken").
 *
 * The frequency line is the delicate part. Only three of the seven stages have
 * a stated sampling frequency — Raw materials (every load), Extruded soya
 * (every run) and Mash (once per production run). For Ground, Conditioned,
 * Pellets and Crumble the workbook `Read me` tab says "To set", which means
 * nobody has approved one.
 *
 * So when `frequencyApproved` is false this strip says so IN WORDS rather than
 * printing "To set" as though it were an instruction. An operator reading a
 * confident-looking frequency that no process owner ever approved would be
 * following a rule the organisation has not made — and the same unset value is
 * why no overdue flag or sampling-adherence KPI may be computed for those four
 * stages (FR-020, risk R-08).
 */
export function InstructionStrip({ schema }: InstructionStripProps): JSX.Element {
  const wide = useIsPhone() === false;

  return (
    /**
     * A DISCLOSURE ON A PHONE, OPEN EVERYWHERE ELSE.
     *
     * Measured at 375x812: this strip is 172px, and with the header, the nav
     * and the title block the first field began at 683px of an 812px screen.
     * The operator could not see a single field on the screen whose only job
     * is entering one.
     *
     * `open` comes from `useIsPhone`, NOT from CSS. `details[open]` is a
     * boolean attribute and a media query cannot set it — a first attempt
     * here tried and would have collapsed the strip on desktop too. The
     * layout already documents this exact constraint: the page's choice
     * "cannot be made in CSS". So nothing changes on a tablet or desktop; on
     * a phone it starts closed — but the SUMMARY still carries the frequency, including
     * the warning when no frequency has been approved. That is the point: the
     * prose can wait behind a tap, the unapproved-frequency warning cannot,
     * because four of the seven stages have no approved frequency and hiding
     * that would be hiding a known gap (FR-020, risk R-08).
     */
    <details
      open={wide}
      className="group mb-4 rounded-lg border-2 border-blue-700 bg-blue-50 p-4 [&:not([open])]:pb-3"
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 text-base font-bold text-blue-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-700 focus-visible:ring-offset-2">
        <Info aria-hidden="true" className="h-5 w-5 shrink-0" />
        <span className="flex-1">Before you start</span>
        {!schema.frequencyApproved && (
          <span className="inline-flex items-center gap-1 whitespace-nowrap rounded border border-amber-400 bg-amber-50 px-2 py-0.5 text-xs font-semibold text-amber-900 group-open:hidden">
            <TriangleAlert aria-hidden="true" className="h-4 w-4 shrink-0" />
            Frequency not set
          </span>
        )}
        <ChevronDown
          aria-hidden="true"
          className="h-5 w-5 shrink-0 transition-transform group-open:rotate-180"
        />
      </summary>

      <p className="mt-2 text-base leading-snug text-slate-900">{schema.instruction}</p>

      {schema.frequencyApproved ? (
        <p className="mt-3 flex items-start gap-2 text-base text-slate-900">
          <Clock aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0 text-blue-900" />
          <span>
            <span className="font-semibold">How often:</span> {schema.frequency}
          </span>
        </p>
      ) : (
        <p className="mt-3 flex items-start gap-2 rounded border border-amber-400 bg-amber-50 p-2 text-base text-amber-900">
          <TriangleAlert aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0" />
          <span>
            <span className="font-semibold">How often: not decided yet.</span> No
            sampling frequency has been approved for this stage, so there is no
            rule here to follow and the app does not flag these samples as late.
            Ask your supervisor how often to sample.
          </span>
        </p>
      )}
    </details>
  );
}
