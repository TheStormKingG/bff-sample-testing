/**
 * Upstream and downstream samples.
 *
 * PRD §6.4: a stage may have several samples per batch, so these are always
 * one-to-many lists and never a claimed one-to-one match. A MISSING upstream
 * link is shown as a recorded traceability exception, because inferring a
 * parent from a matching batch number would be a guess presented as a fact.
 */

import { Link } from 'react-router-dom';
import { ArrowDown, ArrowUp, AlertTriangle } from 'lucide-react';

import { formatPlantDateTimeLabelled } from '@/lib/time';
import { stageTitle, sourceSummary, type SampleRow } from '@/hooks/useSamples';

function LinkList({
  rows,
  heading,
  direction,
  emptyText,
}: {
  rows: readonly SampleRow[];
  heading: string;
  direction: 'up' | 'down';
  emptyText: string;
}) {
  const Icon = direction === 'up' ? ArrowUp : ArrowDown;
  return (
    <div>
      <h3 className="flex items-center gap-2 text-base font-semibold text-slate-800">
        <Icon aria-hidden className="h-4 w-4" />
        {heading}
      </h3>
      {rows.length === 0 ? (
        <p className="mt-1 text-sm text-slate-600">{emptyText}</p>
      ) : (
        <ul className="mt-2 flex flex-col gap-2">
          {rows.map((row) => {
            const collected = new Date(row.collection_instant);
            return (
              <li key={row.id} className="rounded-md border border-slate-200 p-2">
                <Link
                  to={`/samples/${row.id}`}
                  className="min-h-tap font-semibold text-bff-700 underline focus:outline-none focus-visible:ring-2 focus-visible:ring-bff-600"
                >
                  {row.sample_id ?? 'Draft record'}
                </Link>
                <p className="text-sm text-slate-700">
                  {stageTitle(row.stage)}
                  {Number.isNaN(collected.getTime())
                    ? ''
                    : ` · ${formatPlantDateTimeLabelled(collected)}`}
                </p>
                <p className="text-sm text-slate-600">{sourceSummary(row)}</p>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export function LinkedSamples({
  upstream,
  downstream,
  missingLinkNote,
}: {
  upstream: readonly SampleRow[];
  downstream: readonly SampleRow[];
  missingLinkNote: string | null;
}) {
  return (
    <div className="flex flex-col gap-5">
      {missingLinkNote ? (
        <p
          role="alert"
          className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900"
        >
          <AlertTriangle aria-hidden className="mt-0.5 h-4 w-4 flex-shrink-0" />
          <span>{missingLinkNote}</span>
        </p>
      ) : null}

      <LinkList
        rows={upstream}
        heading="Earlier in the process (upstream)"
        direction="up"
        emptyText="No upstream sample is linked to this record."
      />
      <LinkList
        rows={downstream}
        heading="Later in the process (downstream)"
        direction="down"
        emptyText="No later sample has been linked to this record yet."
      />
    </div>
  );
}
