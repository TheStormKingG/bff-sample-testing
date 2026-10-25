/**
 * Google Sheets sync health.
 *
 * Failed and dead-lettered jobs are listed first and never collapsed into a
 * single "some errors" summary: a job that stopped retrying is a record that
 * is in Supabase and not in the operational sheet, and somebody has to know
 * which one (Master Prompt §7).
 *
 * Retrying is safe to press twice. Delivery is at-least-once and the worker's
 * projection is idempotent, so a repeat does not add a second row.
 */

import { Link } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, CircleDashed, CloudOff, RefreshCw } from 'lucide-react';

import { formatPlantDateTimeLabelled } from '@/lib/time';
import type { SyncHealth, SyncJobRow } from '@/hooks/useAdmin';
import { Button, EmptyState } from './common';

function when(value: string | null): string {
  if (value === null) return '—';
  const instant = new Date(value);
  return Number.isNaN(instant.getTime()) ? value : formatPlantDateTimeLabelled(instant);
}

function StateCell({ state }: { state: string }) {
  const failed = state === 'failed' || state === 'dead_letter';
  const Icon = state === 'confirmed' ? CheckCircle2 : failed ? CloudOff : CircleDashed;
  const label =
    state === 'dead_letter'
      ? 'Stopped retrying — needs attention'
      : state === 'failed'
        ? 'Failed, will retry'
        : state === 'confirmed'
          ? 'Confirmed in Google Sheets'
          : state.replace(/_/g, ' ');

  return (
    <span
      className={
        failed
          ? 'inline-flex items-center gap-1.5 text-sm font-semibold text-red-900'
          : 'inline-flex items-center gap-1.5 text-sm text-slate-800'
      }
    >
      <Icon aria-hidden className="h-4 w-4 flex-shrink-0" />
      {label}
    </span>
  );
}

function JobRow({
  job,
  onRetry,
  retrying,
  canRetry,
}: {
  job: SyncJobRow;
  onRetry: (jobId: string) => void;
  retrying: boolean;
  canRetry: boolean;
}) {
  return (
    <tr className="border-b border-slate-100 align-top">
      <td className="py-3 pr-3">
        {job.sample_uuid ? (
          <Link
            to={`/samples/${job.sample_uuid}`}
            className="font-medium text-bff-700 underline focus:outline-none focus-visible:ring-2 focus-visible:ring-bff-600"
          >
            {job.sample_id ?? 'Open record'}
          </Link>
        ) : (
          <span className="text-slate-700">{job.sample_id ?? 'Not linked to a sample'}</span>
        )}
        <p className="text-xs text-slate-600">{job.intended_tab ?? 'Tab not recorded'}</p>
      </td>
      <td className="py-3 pr-3">
        <StateCell state={job.state} />
        {job.reconciliation_status ? (
          <p className="text-xs text-slate-600">Reconciliation: {job.reconciliation_status}</p>
        ) : null}
      </td>
      <td className="py-3 pr-3 text-sm text-slate-800">
        {job.attempt_count}
        {job.payload_revision !== null ? (
          <p className="text-xs text-slate-600">Revision {job.payload_revision}</p>
        ) : null}
      </td>
      <td className="py-3 pr-3 text-sm text-slate-800">
        <p>Next retry: {when(job.next_retry_at)}</p>
        <p className="text-xs text-slate-600">Updated: {when(job.updated_at)}</p>
      </td>
      <td className="max-w-sm py-3 pr-3 text-sm text-red-900">
        {job.last_error ?? <span className="text-slate-600">No error recorded</span>}
      </td>
      <td className="py-3">
        {canRetry ? (
          <Button onClick={() => onRetry(job.id)} disabled={retrying}>
            <RefreshCw aria-hidden className="h-4 w-4" />
            {retrying ? 'Retrying…' : 'Retry now'}
          </Button>
        ) : (
          <span className="text-sm text-slate-600">No retry permission</span>
        )}
      </td>
    </tr>
  );
}

export function SyncHealthTable({
  health,
  onRetry,
  retryingJobId,
  canRetry,
}: {
  health: SyncHealth;
  onRetry: (jobId: string) => void;
  retryingJobId: string | null;
  canRetry: boolean;
}) {
  const ordered = [...health.needsAttention, ...health.jobs.filter((j) => !health.needsAttention.includes(j))];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-2">
        {Object.entries(health.counts).length === 0 ? (
          <p className="text-sm text-slate-700">No sync jobs have been queued yet.</p>
        ) : (
          Object.entries(health.counts).map(([state, count]) => (
            <span
              key={state}
              className="rounded-md border border-slate-300 bg-white px-3 py-1 text-sm text-slate-800"
            >
              {state.replace(/_/g, ' ')}: <strong>{count}</strong>
            </span>
          ))
        )}
      </div>

      {health.needsAttention.length > 0 ? (
        <p
          role="alert"
          className="flex items-center gap-2 rounded-md border border-red-300 bg-red-50 p-3 text-base font-semibold text-red-900"
        >
          <AlertTriangle aria-hidden className="h-5 w-5" />
          {health.needsAttention.length} record
          {health.needsAttention.length === 1 ? ' is' : 's are'} held securely in the ledger but not
          yet written to Google Sheets.
        </p>
      ) : null}

      {ordered.length === 0 ? (
        <EmptyState
          title="No sync jobs to show."
          hint="A job appears here as soon as a sample is registered or its results are saved."
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[56rem] border-collapse text-left">
            <caption className="sr-only">
              Google Sheets synchronisation jobs, failed and stalled jobs first.
            </caption>
            <thead>
              <tr className="border-b border-slate-300 text-sm font-semibold text-slate-700">
                <th scope="col" className="py-2 pr-3">
                  Record
                </th>
                <th scope="col" className="py-2 pr-3">
                  State
                </th>
                <th scope="col" className="py-2 pr-3">
                  Attempts
                </th>
                <th scope="col" className="py-2 pr-3">
                  Timing (Guyana)
                </th>
                <th scope="col" className="py-2 pr-3">
                  Last error
                </th>
                <th scope="col" className="py-2">
                  Action
                </th>
              </tr>
            </thead>
            <tbody>
              {ordered.map((job) => (
                <JobRow
                  key={job.id}
                  job={job}
                  onRetry={onRetry}
                  retrying={retryingJobId === job.id}
                  canRetry={canRetry}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
