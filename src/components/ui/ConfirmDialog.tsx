import { useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';

export interface ConfirmDialogProps {
  readonly open: boolean;
  readonly title: string;
  /**
   * What will happen, in plain words, naming the record and the effect. PRD
   * section 11: decision-affecting actions are reversible only through a
   * controlled new event, so the operator has to be told what they are about
   * to commit, not merely asked "are you sure?".
   */
  readonly description: ReactNode;
  readonly confirmLabel: string;
  readonly cancelLabel?: string;
  readonly destructive?: boolean;
  readonly onConfirm: () => void | Promise<void>;
  readonly onCancel: () => void;
  readonly children?: ReactNode;
  /** A problem from the last attempt, shown without closing the dialog. */
  readonly error?: string | null;
}

/**
 * The confirmation step in front of every high-impact action: register,
 * release, void, clear a hold, approve a specification.
 *
 * While the action is running the dialog cannot be dismissed and the confirm
 * button is busy, so a second press cannot become a second request.
 */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel = 'Cancel',
  destructive = false,
  onConfirm,
  onCancel,
  children,
  error,
}: ConfirmDialogProps) {
  const [busy, setBusy] = useState(false);

  async function handleConfirm() {
    setBusy(true);
    try {
      await onConfirm();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onCancel}
      title={title}
      description={description}
      dismissable={!busy}
      footer={
        <>
          <Button variant="secondary" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </Button>
          <Button
            variant={destructive ? 'danger' : 'primary'}
            onClick={() => void handleConfirm()}
            loading={busy}
            loadingLabel="Working…"
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children}
      {error !== undefined && error !== null && error !== '' && (
        <p role="alert" className="mt-3 rounded-lg bg-red-50 p-3 text-sm font-medium text-red-900">
          {error}
        </p>
      )}
    </Dialog>
  );
}
