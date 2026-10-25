/**
 * Every field of the sample, with its value, unit and assessment.
 *
 * Three distinctions are preserved visibly, because conflating any of them
 * would misstate a quality record:
 *
 *   - A blank value means NOT MEASURED. A measured zero prints as "0".
 *   - A field that does not apply to this sampling point says so, rather than
 *     showing an empty cell that reads as a missed test.
 *   - A field with no specification parameter is "recorded only", which is not
 *     the same as "not assessable".
 */

import { SECTION_LABELS, type Section } from '@/forms/types';
import type { MeasurementView } from '@/hooks/useSampleDetail';
import { formatPlantDateTimeLabelled } from '@/lib/time';
import { AssessmentChip } from '@/components/ui/AssessmentChip';
import { EmptyState } from './common';

const SECTION_ORDER: readonly Section[] = [
  'sample_details',
  'settings',
  'test_results',
  'follow_up',
];

function valueCell(view: MeasurementView) {
  if (!view.applicable) {
    return (
      <span className="text-slate-600">
        Not applicable to this sampling point
      </span>
    );
  }
  if (view.displayText === '') {
    return <span className="text-slate-600">Not measured</span>;
  }
  return (
    <span className="font-semibold text-slate-900">
      {view.displayText}
      {view.unit ? <span className="ml-1 font-normal text-slate-700">{view.unit}</span> : null}
    </span>
  );
}

function Row({ view }: { view: MeasurementView }) {
  const recorded =
    view.recordedAt !== null && !Number.isNaN(new Date(view.recordedAt).getTime())
      ? formatPlantDateTimeLabelled(new Date(view.recordedAt))
      : null;

  return (
    <div className="border-b border-slate-100 py-3 last:border-b-0">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
        <div className="sm:w-2/5">
          <p className="text-base font-medium text-slate-800">
            {view.field.label}
            {view.requiredForReview ? (
              <span className="ml-2 text-sm font-normal text-slate-600">(required for review)</span>
            ) : null}
          </p>
          {view.field.help ? (
            <p className="mt-0.5 text-sm text-slate-600">{view.field.help}</p>
          ) : null}
        </div>
        <div className="sm:w-1/5">{valueCell(view)}</div>
        <div className="sm:w-2/5">
          {view.assessment !== null ? (
            <AssessmentChip
              result={view.assessment.result}
              explanation={view.assessment.explanation}
            />
          ) : view.field.adverseValue !== undefined ? (
            /* A visual observation carries no numeric limit; what matters is
               that an adverse answer forces a hold, which the hold banner
               states. Labelling it "Not assessable" would read as a fault. */
            <p className="text-sm text-slate-700">
              Visual check. Any &ldquo;Yes&rdquo; holds the load until the Quality Officer decides.
            </p>
          ) : null}
          {view.assessment?.ruleId ? (
            <p className="mt-0.5 text-xs text-slate-500">
              Decided by rule version {view.assessment.ruleVersion} ({view.assessment.ruleId})
            </p>
          ) : null}
          {recorded ? (
            <p className="mt-0.5 text-xs text-slate-500">
              Recorded {recorded}
              {view.recordedByName ? ` by ${view.recordedByName}` : ''}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export function MeasurementTable({ views }: { views: readonly MeasurementView[] }) {
  if (views.length === 0) {
    return <EmptyState title="This form has no recorded fields." />;
  }

  const bySection = SECTION_ORDER.map((section) => ({
    section,
    rows: views.filter((v) => v.field.section === section),
  })).filter((group) => group.rows.length > 0);

  return (
    <div className="flex flex-col gap-6">
      {bySection.map((group) => (
        <div key={group.section}>
          <h3 className="mb-1 text-base font-semibold uppercase tracking-wide text-slate-600">
            {SECTION_LABELS[group.section]}
          </h3>
          <div className="rounded-md border border-slate-200">
            <div className="hidden border-b border-slate-200 bg-slate-50 px-0 py-2 sm:flex sm:gap-4 sm:px-3">
              <p className="w-2/5 text-sm font-semibold text-slate-700">Test or field</p>
              <p className="w-1/5 text-sm font-semibold text-slate-700">Value</p>
              <p className="w-2/5 text-sm font-semibold text-slate-700">Assessment</p>
            </div>
            <div className="px-3">
              {group.rows.map((view) => (
                <Row key={view.field.key} view={view} />
              ))}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
