import type { ImplausibleFinding } from '@/forms/zodSchema';
import { ConfirmDialog } from './ConfirmDialog';

export interface ImplausibleValueDialogProps {
  readonly findings: readonly ImplausibleFinding[];
  readonly busy?: boolean;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}

/**
 * The soft typo guard, asked as a question.
 *
 * `implausibleAbove` is NOT an acceptance limit and this dialog is not a
 * rejection. The value passed validation; what happens here is that the
 * operator is asked whether they meant it, and a Yes records the value exactly
 * as typed. PRD §6.1 allows configurable bounds to block "scientific
 * nonsense" while reserving operational bounds for process-owner approval, and
 * this is the line between those two things.
 *
 * The wording never implies a quality verdict. "Unusually high" describes the
 * number against a data-entry threshold; it says nothing about whether the
 * material conforms, which only an approved specification rule can decide.
 */
export function ImplausibleValueDialog({
  findings,
  busy = false,
  onConfirm,
  onCancel,
}: ImplausibleValueDialogProps): JSX.Element | null {
  if (findings.length === 0) return null;

  return (
    <ConfirmDialog
      open
      tone="caution"
      title={findings.length === 1 ? 'Check this value' : 'Check these values'}
      confirmLabel="Yes, that is correct"
      cancelLabel="Let me change it"
      busy={busy}
      onConfirm={onConfirm}
      onCancel={onCancel}
    >
      <p>
        {findings.length === 1
          ? 'This reading looks unusually high. Is it correct?'
          : 'These readings look unusually high. Are they correct?'}
      </p>

      <ul className="mt-3 space-y-2">
        {findings.map((finding) => (
          <li
            key={finding.field.key}
            className="rounded border border-amber-300 bg-amber-50 p-2"
          >
            <span className="font-semibold">{finding.field.label}:</span>{' '}
            <span className="font-mono">{finding.entered}</span>
            {finding.field.unit !== undefined ? ` ${finding.field.unit}` : ''}
            <span className="block text-sm text-slate-700">
              Usually below {finding.threshold}
              {finding.field.unit !== undefined ? ` ${finding.field.unit}` : ''}.
            </span>
          </li>
        ))}
      </ul>

      <p className="mt-3 text-sm text-slate-700">
        This is only a check for typing mistakes. It is not a pass or fail
        decision about the material.
      </p>
    </ConfirmDialog>
  );
}
