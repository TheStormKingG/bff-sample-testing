/**
 * Shared presentation pieces for the record screens.
 *
 * Everything that states a STATUS delegates to `src/components/ui`, so a
 * capture state, a disposition, an assessment and a sync state have exactly
 * one appearance and one wording across the whole app. The wrappers here only
 * adapt that library to the record screens' call sites; they never restyle a
 * status or reword a label.
 *
 * What is local is local because the shared library has no equivalent: the
 * page header, the three-way loading/failed/empty treatment, the "not
 * permitted, and here is why" note and the definition rows of the detail
 * screen.
 */

import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import clsx from 'clsx';
import { AlertTriangle, Info, Lock, RefreshCw, Search } from 'lucide-react';

import { CAPTURE_STATE_LABELS, DISPOSITION_LABELS } from '@/lib/workflow';
import type { CaptureState, Disposition } from '@/lib/workflow';
import { Button as UiButton } from '@/components/ui/Button';
import { Card as UiCard } from '@/components/ui/Card';
import { EmptyState as UiEmptyState } from '@/components/ui/EmptyState';
import { Spinner } from '@/components/ui/Spinner';
import { StatusChip } from '@/components/ui/StatusChip';
import { SyncStatus } from '@/components/ui/SyncStatus';
import {
  CAPTURE_STATE_ICON,
  CAPTURE_STATE_TONE,
  DISPOSITION_ICON,
  DISPOSITION_TONE,
  type SheetSyncState,
} from '@/components/ui/statusMaps';
import type { SyncState } from '@/hooks/useSamples';

// ---------------------------------------------------------------------------
// Page scaffolding
// ---------------------------------------------------------------------------

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="mb-6 flex flex-col gap-3 border-b border-slate-200 pb-4 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900 sm:text-3xl">{title}</h1>
        {description !== undefined ? (
          <p className="mt-1 max-w-3xl text-base text-slate-600">{description}</p>
        ) : null}
      </div>
      {actions !== undefined ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </header>
  );
}

export function Card({
  title,
  description,
  children,
}: {
  title?: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <UiCard title={title} description={description}>
      {children}
    </UiCard>
  );
}

/**
 * A button, forwarded to the single shared implementation so tap target,
 * focus ring and variant palette are the app's and not this slice's.
 */
export function Button({
  children,
  onClick,
  variant = 'secondary',
  type = 'button',
  disabled,
  title,
  ariaLabel,
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  type?: 'button' | 'submit';
  disabled?: boolean;
  title?: string;
  ariaLabel?: string;
}) {
  return (
    <UiButton
      type={type}
      variant={variant}
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={ariaLabel}
    >
      <span className="inline-flex items-center gap-2">{children}</span>
    </UiButton>
  );
}

/**
 * A navigation action that looks like a button.
 *
 * A `<button>` wrapping an `<a>` is invalid markup and announces twice to a
 * screen reader, so anything that navigates is a link styled as a button
 * rather than a button containing a link.
 */
export function LinkButton({
  to,
  children,
  variant = 'secondary',
}: {
  to: string;
  children: ReactNode;
  variant?: 'primary' | 'secondary';
}) {
  return (
    <Link
      to={to}
      className={clsx(
        'inline-flex min-h-tap min-w-tap items-center justify-center gap-2 rounded-lg border px-4 py-2.5 text-base font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-bff-600 focus-visible:ring-offset-2',
        variant === 'primary'
          ? 'border-bff-800 bg-bff-700 text-white hover:bg-bff-800'
          : 'border-bff-300 bg-white text-bff-800 hover:bg-bff-50',
      )}
    >
      {children}
    </Link>
  );
}

// ---------------------------------------------------------------------------
// Loading, failed and empty — three distinct answers
// ---------------------------------------------------------------------------

export function LoadingBlock({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="flex items-center gap-3 py-6">
      <Spinner label={label} />
      <p role="status" className="text-base text-slate-600">
        {label}…
      </p>
    </div>
  );
}

/**
 * A failed read, stated plainly with the server's own words.
 *
 * The underlying message is shown rather than hidden behind "something went
 * wrong", because a quality record that cannot be read is an operational fact
 * somebody has to act on (PRD section 11).
 */
export function ErrorNotice({
  error,
  what,
  onRetry,
}: {
  error: unknown;
  what: string;
  onRetry?: () => void;
}) {
  const message =
    error instanceof Error ? error.message : typeof error === 'string' ? error : 'Unknown error';
  return (
    <div role="alert" className="rounded-lg border border-red-300 bg-red-50 p-4">
      <p className="flex items-center gap-2 text-base font-semibold text-red-900">
        <AlertTriangle aria-hidden className="h-5 w-5" />
        {what} could not be loaded
      </p>
      <p className="mt-1 text-sm text-red-900">{message}</p>
      <p className="mt-1 text-sm text-red-800">
        Nothing has been changed. Check the connection and try again.
      </p>
      {onRetry !== undefined ? (
        <div className="mt-3">
          <Button onClick={onRetry}>
            <RefreshCw aria-hidden className="h-4 w-4" />
            Try again
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** An empty list, which is not the same thing as an unanswered query. */
export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return <UiEmptyState title={title} description={hint} icon={Search} />;
}

export function InfoNote({
  children,
  tone = 'info',
}: {
  children: ReactNode;
  tone?: 'info' | 'warning';
}) {
  const Icon = tone === 'warning' ? AlertTriangle : Info;
  return (
    <p
      className={clsx(
        'flex items-start gap-2 rounded-lg border p-3 text-sm',
        tone === 'warning'
          ? 'border-amber-300 bg-amber-50 text-amber-900'
          : 'border-bff-200 bg-bff-50 text-bff-900',
      )}
    >
      <Icon aria-hidden className="mt-0.5 h-4 w-4 flex-shrink-0" />
      <span>{children}</span>
    </p>
  );
}

/** Shown where a role is not permitted to act, with the reason stated. */
export function NotPermitted({ reason }: { reason: string }) {
  return (
    <p className="flex items-start gap-2 rounded-lg border border-slate-300 bg-slate-50 p-3 text-sm text-slate-700">
      <Lock aria-hidden className="mt-0.5 h-4 w-4 flex-shrink-0" />
      <span>{reason}</span>
    </p>
  );
}

// ---------------------------------------------------------------------------
// Status chips — appearance and wording come from the shared tables
// ---------------------------------------------------------------------------

export function CaptureStateBadge({ state }: { state: CaptureState }) {
  return (
    <StatusChip
      label={CAPTURE_STATE_LABELS[state]}
      tone={CAPTURE_STATE_TONE[state]}
      icon={CAPTURE_STATE_ICON[state]}
      srPrefix="Record state:"
    />
  );
}

export function DispositionBadge({ disposition }: { disposition: Disposition }) {
  return (
    <StatusChip
      label={DISPOSITION_LABELS[disposition]}
      tone={DISPOSITION_TONE[disposition]}
      icon={DISPOSITION_ICON[disposition]}
      srPrefix="Material decision:"
    />
  );
}

/**
 * Collapse the ledger's sync states onto the two the app is allowed to say.
 *
 * The outbox distinguishes queued, in-flight, failed and dead-lettered, but to
 * somebody reading a sample record all four mean the same thing: the row is
 * not in the workbook yet. Only `confirmed` may claim it is. Sync failures are
 * an operations concern and are shown in full on the admin sync screen, beside
 * the outbox detail that explains them (Master Prompt section 7).
 */
export function sheetSyncState(state: SyncState): SheetSyncState {
  return state === 'confirmed' ? 'confirmed' : 'pending';
}

export function SyncStatePill({
  state,
  confirmedAt,
}: {
  state: SyncState;
  confirmedAt?: string | null;
}) {
  const instant =
    typeof confirmedAt === 'string' && !Number.isNaN(new Date(confirmedAt).getTime())
      ? new Date(confirmedAt)
      : null;
  return <SyncStatus state={sheetSyncState(state)} confirmedAt={instant} />;
}

// ---------------------------------------------------------------------------
// Small form primitives
// ---------------------------------------------------------------------------

export function Labelled({
  id,
  label,
  hint,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium text-slate-800">
        {label}
      </label>
      {children}
      {hint !== undefined ? (
        <p id={`${id}-hint`} className="text-xs text-slate-600">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export const INPUT_CLASS =
  'min-h-tap w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-base text-slate-900 placeholder:text-slate-400 focus:border-bff-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-bff-600';

/** A definition row, used throughout the detail screen. */
export function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 border-b border-slate-100 py-2 last:border-b-0 sm:flex-row sm:gap-4">
      <dt className="w-56 flex-shrink-0 text-sm font-medium text-slate-600">{label}</dt>
      <dd className="text-base text-slate-900">{children}</dd>
    </div>
  );
}
