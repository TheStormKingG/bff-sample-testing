/**
 * One report widget.
 *
 * The number and its definition travel together: numerator, denominator,
 * timestamp convention and missing-data handling are always one disclosure
 * away (PRD §12). "Insufficient data" is rendered in words, in the same place
 * a number would go, so an unmeasured widget can never be mistaken for a zero.
 */

import { useState } from 'react';
import { ChevronDown, ChevronRight, HelpCircle, Info } from 'lucide-react';
import { Link } from 'react-router-dom';

import { INSUFFICIENT_DATA_TEXT, renderMetric, type Metric } from '@/lib/reportMetrics';

export function ReportCard({ metric, to }: { metric: Metric; to?: string }) {
  const [open, setOpen] = useState(false);
  const text = renderMetric(metric.value);
  const numeric = metric.value.kind === 'count';

  return (
    <section className="flex flex-col rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <h3 className="text-base font-medium text-slate-700">{metric.definition.label}</h3>

      <p
        className={
          numeric
            ? 'mt-1 text-4xl font-bold tabular-nums text-slate-900'
            : 'mt-1 flex items-start gap-2 text-lg font-semibold text-amber-900'
        }
      >
        {numeric ? (
          text
        ) : (
          <>
            <HelpCircle aria-hidden className="mt-1 h-5 w-5 flex-shrink-0" />
            {text}
          </>
        )}
      </p>

      {metric.value.kind !== 'count' ? (
        <p className="mt-1 text-sm text-amber-900">{metric.value.reason}</p>
      ) : null}

      {to && numeric ? (
        <Link
          to={to}
          className="mt-2 min-h-tap text-base text-bff-700 underline focus:outline-none focus-visible:ring-2 focus-visible:ring-bff-600"
        >
          Open the list
        </Link>
      ) : null}

      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="mt-3 inline-flex min-h-tap items-center gap-1 self-start text-sm text-slate-700 underline focus:outline-none focus-visible:ring-2 focus-visible:ring-bff-600"
      >
        {open ? (
          <ChevronDown aria-hidden className="h-4 w-4" />
        ) : (
          <ChevronRight aria-hidden className="h-4 w-4" />
        )}
        {open ? 'Hide how this is counted' : 'How is this counted?'}
      </button>

      {open ? (
        <dl className="mt-2 border-t border-slate-200 pt-2 text-sm">
          <dt className="font-semibold text-slate-700">Counts</dt>
          <dd className="mb-1 text-slate-800">{metric.definition.numerator}</dd>
          <dt className="font-semibold text-slate-700">Out of</dt>
          <dd className="mb-1 text-slate-800">{metric.definition.denominator}</dd>
          <dt className="font-semibold text-slate-700">Which clock</dt>
          <dd className="mb-1 text-slate-800">{metric.definition.timestampConvention}</dd>
          <dt className="font-semibold text-slate-700">Missing data</dt>
          <dd className="text-slate-800">{metric.definition.missingData}</dd>
        </dl>
      ) : null}
    </section>
  );
}

/** A small breakdown row, e.g. samples today per stage. */
export function StageBreakdown({
  title,
  rows,
}: {
  title: string;
  rows: readonly { stage: string; ordinal: number; title: string; valueText: string; numeric: boolean }[];
}) {
  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <h3 className="text-base font-medium text-slate-700">{title}</h3>
      <ul className="mt-2 divide-y divide-slate-100">
        {rows.map((row) => (
          <li key={row.stage} className="flex items-baseline justify-between gap-4 py-2">
            <span className="text-base text-slate-800">
              {row.ordinal}. {row.title}
            </span>
            <span
              className={
                row.numeric
                  ? 'text-xl font-semibold tabular-nums text-slate-900'
                  : 'text-sm font-medium text-amber-900'
              }
            >
              {row.valueText}
            </span>
          </li>
        ))}
      </ul>
      {rows.some((r) => !r.numeric) ? (
        <p className="mt-2 flex items-start gap-2 text-sm text-amber-900">
          <Info aria-hidden className="mt-0.5 h-4 w-4 flex-shrink-0" />
          {INSUFFICIENT_DATA_TEXT} means the figure was not measured. It does not mean zero.
        </p>
      ) : null}
    </section>
  );
}
