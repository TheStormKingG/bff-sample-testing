import { Clock, Info, TriangleAlert } from 'lucide-react';

import type { StageSchema } from '@/forms/types';

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
  return (
    <div className="mb-4 rounded-lg border-2 border-blue-700 bg-blue-50 p-4">
      <h2 className="flex items-center gap-2 text-base font-bold text-blue-900">
        <Info aria-hidden="true" className="h-5 w-5 shrink-0" />
        Before you start
      </h2>

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
    </div>
  );
}
