import { useEffect, useId, useRef, useState } from 'react';
import { AlertCircle } from 'lucide-react';

export interface ReasonDialogProps {
  readonly open: boolean;
  readonly title: string;
  readonly prompt: string;
  readonly confirmLabel: string;
  readonly busy?: boolean;
  readonly onConfirm: (reason: string) => void;
  readonly onCancel: () => void;
}

/**
 * A confirmation that cannot proceed without a written reason.
 *
 * Used for voiding a sample and for correcting a value after submission. The
 * reason is not decoration: it becomes the audit event's justification
 * (NFR-005, FR-013), and the capture state machine itself refuses these
 * transitions without one — `checkTransition` returns `reason_required`. So
 * this dialog enforces client-side exactly what the server will enforce again,
 * which means the operator finds out before the round trip rather than after.
 */
export function ReasonDialog({
  open,
  title,
  prompt,
  confirmLabel,
  busy = false,
  onConfirm,
  onCancel,
}: ReasonDialogProps): JSX.Element | null {
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fieldId = useId();
  const errorId = `${fieldId}-error`;

  useEffect(() => {
    if (open) {
      setReason('');
      setTouched(false);
      textareaRef.current?.focus();
    }
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, onCancel]);

  if (!open) return null;

  const empty = reason.trim() === '';
  const showError = touched && empty;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/60 p-4 sm:items-center">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${fieldId}-title`}
        className="w-full max-w-md rounded-lg bg-white p-5 shadow-xl"
      >
        <h2 id={`${fieldId}-title`} className="text-xl font-bold text-slate-900">
          {title}
        </h2>

        <label htmlFor={fieldId} className="mt-3 block text-base font-semibold text-slate-900">
          {prompt} <span className="text-sm font-medium text-slate-600">(required)</span>
        </label>
        <textarea
          id={fieldId}
          ref={textareaRef}
          rows={3}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          aria-invalid={showError}
          aria-describedby={showError ? errorId : undefined}
          className={[
            'mt-2 block w-full min-h-[44px] rounded-md border-2 px-3 py-2 text-base text-slate-900',
            'focus:outline-none focus:ring-2 focus:ring-blue-700 focus:ring-offset-1',
            showError ? 'border-red-700 bg-red-50' : 'border-slate-400 bg-white',
          ].join(' ')}
        />
        {showError ? (
          <p id={errorId} className="mt-2 flex items-start gap-1.5 text-sm font-semibold text-red-800">
            <AlertCircle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              <span className="sr-only">Problem: </span>
              Write a reason. It is kept in the sample history.
            </span>
          </p>
        ) : null}

        <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="min-h-[44px] rounded-md border-2 border-slate-400 bg-white px-4 py-2 text-base font-semibold text-slate-800 hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-blue-700 focus:ring-offset-2 disabled:opacity-60"
          >
            Go back
          </button>
          <button
            type="button"
            onClick={() => {
              setTouched(true);
              if (!empty) onConfirm(reason.trim());
            }}
            disabled={busy}
            className="min-h-[44px] rounded-md bg-amber-700 px-4 py-2 text-base font-bold text-white hover:bg-amber-800 focus:outline-none focus:ring-2 focus:ring-amber-700 focus:ring-offset-2 disabled:opacity-60"
          >
            {busy ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
