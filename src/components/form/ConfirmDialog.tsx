import { useEffect, useRef, type ReactNode } from 'react';

export interface ConfirmDialogProps {
  readonly open: boolean;
  readonly title: string;
  readonly confirmLabel: string;
  readonly cancelLabel?: string;
  /** Visual weight: a void or an override reads differently from a save. */
  readonly tone?: 'normal' | 'caution';
  readonly busy?: boolean;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
  readonly children: ReactNode;
}

/**
 * A modal confirmation for every high-impact action — register, save results,
 * void (PRD §11: "All destructive or decision-affecting actions require
 * confirmation").
 *
 * Implemented as a focus-trapping div rather than `<dialog>`, because
 * `showModal()` is imperative and does not survive a React re-render cleanly,
 * and because jsdom's `<dialog>` support is incomplete enough that the
 * behaviour could not be tested.
 *
 * What it guarantees: the dialog is labelled, focus moves into it on open,
 * Escape cancels, and the confirm button is NOT focused first — the operator
 * should read the question before the easiest key press answers it.
 */
export function ConfirmDialog({
  open,
  title,
  confirmLabel,
  cancelLabel = 'Go back',
  tone = 'normal',
  busy = false,
  onConfirm,
  onCancel,
  children,
}: ConfirmDialogProps): JSX.Element | null {
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (open) cancelRef.current?.focus();
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

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/60 p-4 sm:items-center">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        className="w-full max-w-md rounded-lg bg-white p-5 shadow-xl"
      >
        <h2 id="confirm-dialog-title" className="text-xl font-bold text-slate-900">
          {title}
        </h2>

        <div className="mt-3 text-base text-slate-800">{children}</div>

        <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button
            type="button"
            ref={cancelRef}
            onClick={onCancel}
            disabled={busy}
            className="min-h-[44px] rounded-md border-2 border-slate-400 bg-white px-4 py-2 text-base font-semibold text-slate-800 hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-blue-700 focus:ring-offset-2 disabled:opacity-60"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className={[
              'min-h-[44px] rounded-md px-4 py-2 text-base font-bold text-white',
              'focus:outline-none focus:ring-2 focus:ring-offset-2 disabled:opacity-60',
              tone === 'caution'
                ? 'bg-amber-700 hover:bg-amber-800 focus:ring-amber-700'
                : 'bg-blue-700 hover:bg-blue-800 focus:ring-blue-700',
            ].join(' ')}
          >
            {busy ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
