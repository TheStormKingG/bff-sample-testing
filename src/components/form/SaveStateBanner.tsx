import { AlertCircle, CheckCircle2, CloudOff, Loader2, Pencil } from 'lucide-react';

import { SHEET_SYNC_LABELS, type SaveState, type SheetSyncState } from './saveState';

export interface SaveStateBannerProps {
  readonly state: SaveState;
  readonly sheetSync?: SheetSyncState | null;
  /** The server's own message, when it failed. */
  readonly errorMessage?: string | null;
  readonly onRetry?: () => void;
}

/**
 * The honest save-state strip (FR-015).
 *
 * Every word here is load-bearing:
 *
 *  - `recorded` says "Recorded securely" plus the sheet-sync state SEPARATELY.
 *    It never says "Saved to Google Sheets", because at that moment the sheet
 *    has not been written — the sync worker runs afterwards from the committed
 *    ledger. Claiming otherwise would tell an operator their record is in the
 *    spreadsheet when it is not.
 *  - `failed` says nothing was saved, and offers a retry. It does not print an
 *    exception trace (PRD §11: "'Not saved — check connection and retry'
 *    rather than a generic exception trace").
 *  - Each state is carried by text and an icon, never colour alone (NFR-004).
 *
 * `aria-live="polite"` rather than `assertive`: the operator should hear the
 * outcome without having their current keystroke interrupted.
 */
export function SaveStateBanner({
  state,
  sheetSync = null,
  errorMessage = null,
  onRetry,
}: SaveStateBannerProps): JSX.Element | null {
  if (state === 'editing') return null;

  if (state === 'saving') {
    return (
      <div
        aria-live="polite"
        className="flex items-center gap-2 rounded-md border-2 border-slate-300 bg-slate-50 px-3 py-2 text-base font-semibold text-slate-800"
      >
        <Loader2 aria-hidden="true" className="h-5 w-5 shrink-0 animate-spin" />
        Saving… do not close this page
      </div>
    );
  }

  if (state === 'recorded') {
    const sync = sheetSync ?? 'pending';
    const SyncIcon = sync === 'confirmed' ? CheckCircle2 : CloudOff;
    return (
      <div
        aria-live="polite"
        className="rounded-md border-2 border-green-700 bg-green-50 px-3 py-2"
      >
        <p className="flex items-center gap-2 text-base font-semibold text-green-900">
          <CheckCircle2 aria-hidden="true" className="h-5 w-5 shrink-0" />
          Recorded securely on the server
        </p>
        <p className="mt-1 flex items-center gap-2 text-sm font-medium text-slate-700">
          <SyncIcon aria-hidden="true" className="h-4 w-4 shrink-0" />
          {SHEET_SYNC_LABELS[sync]}
        </p>
      </div>
    );
  }

  return (
    <div
      aria-live="polite"
      className="rounded-md border-2 border-red-700 bg-red-50 px-3 py-2"
    >
      <p className="flex items-center gap-2 text-base font-bold text-red-900">
        <AlertCircle aria-hidden="true" className="h-5 w-5 shrink-0" />
        Not saved
      </p>
      <p className="mt-1 text-sm text-red-900">
        {errorMessage !== null && errorMessage !== ''
          ? errorMessage
          : 'Check the connection and try again. Nothing has been recorded yet.'}
      </p>
      {onRetry !== undefined ? (
        <button
          type="button"
          onClick={onRetry}
          className="mt-2 inline-flex min-h-[44px] items-center gap-2 rounded-md border-2 border-red-700 bg-white px-4 py-2 text-base font-bold text-red-900 hover:bg-red-100 focus:outline-none focus:ring-2 focus:ring-red-700 focus:ring-offset-2"
        >
          <Pencil aria-hidden="true" className="h-4 w-4" />
          Try again
        </button>
      ) : null}
    </div>
  );
}
