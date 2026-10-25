/**
 * The sample results table.
 *
 * Shows stage, permanent ID, plant-local collection time, capture state,
 * disposition and the honest Google Sheets state for every row. A sample on
 * hold is marked on the row itself, because a reader scanning a list must not
 * have to open the record to find out that the material is held.
 *
 * Rendered as a real table on wide screens and as stacked cards on a phone,
 * so a plant tablet in portrait never produces a horizontal scroll.
 */

import { Link } from 'react-router-dom';
import { PauseCircle } from 'lucide-react';

import { formatPlantDateTimeLabelled } from '@/lib/time';
import { sourceSummary, stageTitle, type SampleRow } from '@/hooks/useSamples';
import { CaptureStateBadge, DispositionBadge, SyncStatePill } from './common';

function collectedAt(row: SampleRow): string {
  const instant = new Date(row.collection_instant);
  if (Number.isNaN(instant.getTime())) {
    // Fall back to the stored plant-local parts rather than printing an
    // "Invalid Date": those two columns are the operational record.
    return `${row.collection_local_date} ${row.collection_local_time} (Guyana)`;
  }
  return formatPlantDateTimeLabelled(instant);
}

function HoldMark() {
  return (
    <span className="inline-flex items-center gap-1 rounded-md border border-red-400 bg-red-100 px-2 py-0.5 text-sm font-semibold text-red-900">
      <PauseCircle aria-hidden className="h-4 w-4" />
      On hold
    </span>
  );
}

export function SampleTable({ rows }: { rows: readonly SampleRow[] }) {
  return (
    <>
      {/* Phone and small tablet: one card per record. */}
      <ul className="flex flex-col gap-3 lg:hidden">
        {rows.map((row) => (
          <li key={row.id} className="rounded-lg border border-slate-200 bg-white p-3 shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Link
                to={`/samples/${row.id}`}
                className="min-h-tap text-lg font-semibold text-bff-700 underline focus:outline-none focus-visible:ring-2 focus-visible:ring-bff-600"
              >
                {row.sample_id ?? 'Draft — no sample ID yet'}
              </Link>
              {row.hold_active ? <HoldMark /> : null}
            </div>
            <p className="mt-1 text-sm text-slate-700">
              {stageTitle(row.stage)} · {collectedAt(row)}
            </p>
            <p className="mt-1 text-sm text-slate-600">{sourceSummary(row)}</p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <CaptureStateBadge state={row.capture_state} />
              <DispositionBadge disposition={row.disposition} />
            </div>
            <div className="mt-2">
              <SyncStatePill state={row.sync_state} confirmedAt={row.sheet_confirmed_at} />
            </div>
          </li>
        ))}
      </ul>

      {/* Desktop. */}
      <div className="hidden lg:block">
        <table className="w-full border-collapse text-left">
          <caption className="sr-only">
            Sample records, most recently collected first. Each row links to the full record.
          </caption>
          <thead>
            <tr className="border-b border-slate-300 text-sm font-semibold text-slate-700">
              <th scope="col" className="py-2 pr-3">
                Sample ID
              </th>
              <th scope="col" className="py-2 pr-3">
                Stage
              </th>
              <th scope="col" className="py-2 pr-3">
                Collected (Guyana)
              </th>
              <th scope="col" className="py-2 pr-3">
                Source
              </th>
              <th scope="col" className="py-2 pr-3">
                Record state
              </th>
              <th scope="col" className="py-2 pr-3">
                Material decision
              </th>
              <th scope="col" className="py-2">
                Google Sheets
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className="border-b border-slate-100 align-top">
                <td className="py-3 pr-3">
                  <Link
                    to={`/samples/${row.id}`}
                    className="font-semibold text-bff-700 underline focus:outline-none focus-visible:ring-2 focus-visible:ring-bff-600"
                  >
                    {row.sample_id ?? 'Draft'}
                  </Link>
                  {row.hold_active ? (
                    <div className="mt-1">
                      <HoldMark />
                    </div>
                  ) : null}
                </td>
                <td className="py-3 pr-3 text-slate-800">{stageTitle(row.stage)}</td>
                <td className="py-3 pr-3 text-slate-800">{collectedAt(row)}</td>
                <td className="max-w-xs py-3 pr-3 text-slate-700">{sourceSummary(row)}</td>
                <td className="py-3 pr-3">
                  <CaptureStateBadge state={row.capture_state} />
                </td>
                <td className="py-3 pr-3">
                  <DispositionBadge disposition={row.disposition} />
                </td>
                <td className="py-3">
                  <SyncStatePill state={row.sync_state} confirmedAt={row.sheet_confirmed_at} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
