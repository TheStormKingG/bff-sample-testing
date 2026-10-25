import { CheckCircle2, CloudUpload } from 'lucide-react';
import { cn } from '@/lib/cn';
import { formatPlantDateTimeLabelled } from '@/lib/time';
import { StatusChip } from '@/components/ui/StatusChip';
import {
  SHEET_SYNC_LABELS,
  type SheetSyncState,
} from '@/components/ui/statusMaps';

/**
 * Where a record stands between the Supabase ledger and the Google Sheets
 * workbook. The two permitted wordings, and the reasoning for there being
 * exactly two, live in `statusMaps.ts` beside the other status tables.
 */
export interface SyncStatusProps {
  readonly state: SheetSyncState;
  /** When the workbook row was confirmed. Only meaningful when confirmed. */
  readonly confirmedAt?: Date | null;
  readonly className?: string;
  readonly size?: 'sm' | 'md';
}

export function SyncStatus({ state, confirmedAt, className, size = 'md' }: SyncStatusProps) {
  const confirmed = state === 'confirmed';
  return (
    <span className={cn('inline-block', className)}>
      <StatusChip
        label={SHEET_SYNC_LABELS[state]}
        tone={confirmed ? 'success' : 'info'}
        icon={confirmed ? CheckCircle2 : CloudUpload}
        srPrefix="Google Sheets:"
        size={size}
      />
      {confirmed && confirmedAt != null && (
        <span className="mt-1 block text-sm text-slate-600">
          {formatPlantDateTimeLabelled(confirmedAt)}
        </span>
      )}
    </span>
  );
}
