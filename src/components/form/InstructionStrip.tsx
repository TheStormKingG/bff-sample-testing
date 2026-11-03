import { ChevronDown, Info } from 'lucide-react';

import type { StageSchema } from '@/forms/types';
import { useIsPhone } from '@/components/layout/viewport';

export interface InstructionStripProps {
  readonly schema: StageSchema;
}

/**
 * The "where to take this sample" strip above the fields (PRD §3.2).
 *
 * ===========================================================================
 * THIS STRIP USED TO CARRY A SAMPLING FREQUENCY. IT NO LONGER DOES.
 * ===========================================================================
 * Three stages had a frequency from the workbook `Read me` tab and five said
 * "To set", so the strip printed either "How often: every load" or an amber
 * warning that nobody had approved one. Bounty Farm removed sampling
 * frequency from the system on 2026-11-03: the cadence is a process
 * instruction the plant gives its operators, not a figure this application
 * tracks or measures adherence against.
 *
 * The warning went with it. An amber panel saying "no frequency approved" is
 * only honest while the system claims to care; once it does not, the panel is
 * telling the operator about a gap in a feature that no longer exists.
 *
 * What remains is `instruction` — WHERE the sample is taken — which is the
 * half of PRD §3.2 the workbook actually states for every stage.
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
     * a phone it starts closed.
     */
    <details
      open={wide}
      className="group mb-4 rounded-lg border-2 border-blue-700 bg-blue-50 p-4 [&:not([open])]:pb-3"
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 text-base font-bold text-blue-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-700 focus-visible:ring-offset-2">
        <Info aria-hidden="true" className="h-5 w-5 shrink-0" />
        <span className="flex-1">Before you start</span>
        <ChevronDown
          aria-hidden="true"
          className="h-5 w-5 shrink-0 transition-transform group-open:rotate-180"
        />
      </summary>

      <p className="mt-2 text-base leading-snug text-slate-900">{schema.instruction}</p>
    </details>
  );
}
