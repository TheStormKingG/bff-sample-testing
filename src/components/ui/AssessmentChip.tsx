import { ASSESSMENT_LABELS, type AssessmentResult } from '@/lib/assessment';
import { StatusChip } from '@/components/ui/StatusChip';
import { ASSESSMENT_ICON, ASSESSMENT_TONE } from '@/components/ui/statusMaps';

export interface AssessmentChipProps {
  readonly result: AssessmentResult;
  /**
   * The assessment's own `explanation`. Rendered beneath the chip, because a
   * verdict of "Not assessable" is useless to an operator without the reason —
   * no approved limit, unconfirmed unit, or two equally applicable rules.
   */
  readonly explanation?: string;
  readonly size?: 'sm' | 'md';
  readonly className?: string;
}

/**
 * The conformity verdict for one measurement.
 *
 * The wording comes from `ASSESSMENT_LABELS` and is never paraphrased here:
 * the same five phrases must appear on screen, in an export and in the audit
 * record, or two readers of the same sample will describe it differently.
 */
export function AssessmentChip({
  result,
  explanation,
  size = 'md',
  className,
}: AssessmentChipProps) {
  return (
    <span className={className}>
      <StatusChip
        label={ASSESSMENT_LABELS[result]}
        tone={ASSESSMENT_TONE[result]}
        icon={ASSESSMENT_ICON[result]}
        srPrefix="Assessment:"
        size={size}
      />
      {explanation !== undefined && explanation !== '' && (
        <span className="mt-1 block text-sm text-slate-700">{explanation}</span>
      )}
    </span>
  );
}
