/**
 * Reports — the MVP operations widgets (PRD §12).
 *
 * ===========================================================================
 * THREE RULES THIS SCREEN EXISTS TO OBEY
 * ===========================================================================
 *
 * 1. EVERY FIGURE DECLARES ITSELF. Numerator, denominator, timestamp
 *    convention and missing-data handling sit one disclosure away from the
 *    number, on every widget. That text comes from `METRIC_DEFINITIONS` in
 *    `@/lib/reportMetrics`, so the declaration is part of the metric rather
 *    than a caption somebody might forget to update.
 *
 * 2. A ZERO IS NOT AN UNKNOWN. "No samples were taken today" and "the sample
 *    list could not be read" are different answers and are rendered
 *    differently — a real 0 prints as 0, an unread query prints
 *    "Insufficient data" with its reason. `MetricValue` makes the two
 *    impossible to confuse by construction.
 *
 * 3. NO ADHERENCE FIGURE WITHOUT AN APPROVED FREQUENCY. The workbook's
 *    `Read me` tab states a sampling frequency for only three of the seven
 *    stages; the other four read "To set". A compliance percentage for those
 *    four would be measured against a target nobody approved, so none is
 *    produced — and the page says which stages and why, rather than leaving a
 *    gap (FR-020, risk R-08, Master Prompt §8: "do not claim 100% sampling
 *    compliance when approved test frequencies are missing").
 *
 * Reports are views of the stored records. Nothing here is a second ledger.
 * ===========================================================================
 */

import { useMemo, useState } from 'react';
import { CalendarDays, Download, FileSpreadsheet, Info, Ruler } from 'lucide-react';

import { DASHBOARD_ORDER } from '@/forms/registry';
import {
  PLANT_TIME_ZONE,
  formatPlantDateTimeLabelled,
  plantDayEnd,
  plantDayStart,
} from '@/lib/time';
import {
  INSUFFICIENT_DATA_TEXT,
  NOT_PRODUCED_TEXT,
  buildOperationsReport,
  renderMetric,
  samplingAdherence,
  unavailable,
  withheldAdherenceStages,
  type AdherenceResult,
} from '@/lib/reportMetrics';
import {
  EMPTY_FILTERS,
  appVersion,
  fetchSamplesForExport,
  useAuthority,
  useOperationsReport,
  type SampleFilters,
} from '@/hooks/useSamples';
import {
  Button,
  Card,
  ErrorNotice,
  InfoNote,
  LoadingBlock,
  NotPermitted,
  PageHeader,
} from '@/components/records/common';
import { ReportCard, StageBreakdown } from '@/components/records/ReportCard';
import {
  EXPORT_ROW_LIMIT,
  buildSampleCsv,
  downloadCsv,
  exportFileName,
  type ExportResult,
} from '@/components/records/sampleCsv';

/** Where each widget's underlying list lives, so a number can be opened. */
const METRIC_DESTINATIONS: Record<string, string> = {
  samples_today: '/samples',
  awaiting_results: '/awaiting',
  ready_for_review: '/reviews',
  on_hold: '/holds',
  recently_updated: '/samples',
};

function AdherenceRow({ result, title }: { result: AdherenceResult; title: string }) {
  const tone =
    result.kind === 'available'
      ? 'text-slate-900'
      : result.kind === 'not_produced'
        ? 'text-slate-700'
        : 'text-amber-900';

  return (
    <li className="border-b border-slate-100 py-3 last:border-b-0">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <p className="text-base font-medium text-slate-900">{title}</p>
        <p className={`text-base font-semibold ${tone}`}>
          {result.kind === 'available'
            ? `${result.percent.toFixed(0)}% (${result.numerator} of ${result.denominator})`
            : result.kind === 'not_produced'
              ? NOT_PRODUCED_TEXT
              : INSUFFICIENT_DATA_TEXT}
        </p>
      </div>
      <p className="mt-0.5 text-sm text-slate-600">
        Workbook frequency: <strong>{result.frequency}</strong>
      </p>
      {result.kind !== 'available' ? (
        <p className={`mt-1 text-sm ${result.kind === 'not_produced' ? 'text-slate-700' : 'text-amber-900'}`}>
          {result.reason}
        </p>
      ) : null}
    </li>
  );
}

export default function ReportsPage() {
  const { user, allows } = useAuthority();
  const operations = useOperationsReport();

  const [exporting, setExporting] = useState(false);
  const [exportResult, setExportResult] = useState<ExportResult | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  const canExport = allows('export.run');

  const report = useMemo(
    () => (operations.data === undefined ? null : buildOperationsReport(operations.data)),
    [operations.data],
  );

  /**
   * Sampling adherence, computed stage by stage through the shared function so
   * the refusal for an unapproved frequency is the library's decision and not
   * this screen's opinion.
   *
   * The expected-events denominator is deliberately reported as unavailable:
   * the ledger records samples taken, not loads received or production runs
   * started, so there is no honest denominator for the three stages whose
   * frequency IS approved either. An unmeasured denominator reads
   * "Insufficient data"; an unapproved target reads "Not reported". They are
   * different problems and only one of them could be fixed by more data.
   */
  const adherence = useMemo(() => {
    const facts = operations.data?.todayFacts ?? null;
    return DASHBOARD_ORDER.map((schema) => ({
      schema,
      result: samplingAdherence({
        stage: schema.stage,
        samplesTaken:
          facts === null
            ? unavailable('The sample list could not be read.')
            : {
                available: true as const,
                value: facts.filter((f) => f.stage === schema.stage).length,
              },
        expectedEvents: unavailable(
          'The system records samples taken, not the number of loads, runs or production runs that happened. Until that denominator is recorded, no adherence percentage can be calculated.',
        ),
      }),
    }));
  }, [operations.data]);

  const withheld = withheldAdherenceStages();

  async function runExport(plantDate: string) {
    setExporting(true);
    setExportError(null);
    setExportResult(null);
    const filters: SampleFilters = { ...EMPTY_FILTERS, fromDate: plantDate, toDate: plantDate };
    try {
      const data = await fetchSamplesForExport(filters, EXPORT_ROW_LIMIT);
      if (data.rows.length === 0) {
        setExportError(
          `No sample was collected on ${plantDate} (Guyana), so there was nothing to write. This is a real zero, not a failed query.`,
        );
        return;
      }
      const result = buildSampleCsv(data, {
        exportedByName: user.fullName ?? user.email ?? 'Unknown user',
        exportedByEmail: user.email,
        exportedAt: new Date(),
        appVersion: appVersion(),
        filters,
      });
      const ok = downloadCsv(exportFileName(new Date()), result.csv);
      if (!ok) {
        setExportError('The browser would not save the file. Check its download settings.');
        return;
      }
      setExportResult(result);
    } catch (error) {
      setExportError(error instanceof Error ? error.message : String(error));
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="mx-auto max-w-6xl px-4 py-6">
      <PageHeader
        title="Reports"
        description="Volumes, queues and exceptions, taken from the stored records. Every figure states how it is counted."
        actions={
          canExport && report !== null ? (
            <Button
              variant="secondary"
              onClick={() => void runExport(report.plantDate)}
              disabled={exporting}
            >
              <Download aria-hidden className="h-4 w-4" />
              {exporting ? 'Preparing export…' : 'Export today’s records (CSV)'}
            </Button>
          ) : undefined
        }
      />

      {operations.isPending ? (
        <LoadingBlock label="Reading the operations figures" />
      ) : operations.isError ? (
        <ErrorNotice
          error={operations.error}
          what="The operations report"
          onRetry={() => void operations.refetch()}
        />
      ) : report === null ? (
        <ErrorNotice
          error="The report query returned no data at all."
          what="The operations report"
          onRetry={() => void operations.refetch()}
        />
      ) : (
        <div className="flex flex-col gap-6">
          {/* The day these figures describe, and the exact instants that bound
              it. A Guyana calendar day is not a UTC day, and the four-hour
              offset is where a volume figure quietly goes wrong. */}
          <div
            role="region"
            aria-label="Reporting period"
            className="rounded-lg border border-bff-200 bg-bff-50 p-4"
          >
            <p className="flex flex-wrap items-center gap-2 text-base font-semibold text-bff-900">
              <CalendarDays aria-hidden className="h-5 w-5" />
              Today is {report.plantDate} in {PLANT_TIME_ZONE}
            </p>
            <p className="mt-1 text-sm text-bff-900">
              &ldquo;Today&rdquo; means the plant-local calendar day{' '}
              <strong>{report.plantDate}</strong>, which runs from{' '}
              {formatPlantDateTimeLabelled(plantDayStart(report.plantDate))} up to, but not
              including, {formatPlantDateTimeLabelled(plantDayEnd(report.plantDate))}. In UTC that
              is {plantDayStart(report.plantDate).toISOString()} up to, but not including,{' '}
              {plantDayEnd(report.plantDate).toISOString()}. A sample collected at 21:00 Guyana
              belongs to that Guyana day, never to the following UTC day.
            </p>
          </div>

          <InfoNote>
            <strong>{renderMetric({ kind: 'count', value: 0 })}</strong> means the figure was
            measured and the answer is none. <strong>{INSUFFICIENT_DATA_TEXT}</strong> means the
            query did not answer, so the figure is unknown. <strong>{NOT_PRODUCED_TEXT}</strong>{' '}
            means the figure cannot legitimately exist yet. The three are never interchanged.
          </InfoNote>

          {!canExport ? (
            <NotPermitted reason="Exporting records needs the export permission. Ask a Quality Supervisor if you need a copy." />
          ) : null}

          {exportError !== null ? (
            <p
              role="alert"
              className="rounded-md border border-red-300 bg-red-50 p-3 text-base text-red-900"
            >
              The export did not complete: {exportError}
            </p>
          ) : null}

          {exportResult !== null ? (
            <InfoNote tone={exportResult.failures.length > 0 ? 'warning' : 'info'}>
              <span className="flex flex-col gap-1">
                <span className="flex items-center gap-2">
                  <FileSpreadsheet aria-hidden className="h-4 w-4" />
                  {exportResult.rowCount} record{exportResult.rowCount === 1 ? '' : 's'} written,
                  one block per form tab with that tab&rsquo;s own columns. The file states its
                  filters, who exported it and when.
                </span>
                {exportResult.failures.length > 0 ? (
                  <span>
                    {exportResult.failures.length} record
                    {exportResult.failures.length === 1 ? '' : 's'} could not be serialised and{' '}
                    {exportResult.failures.length === 1 ? 'is' : 'are'} named in the file rather
                    than dropped: {exportResult.failures.map((f) => f.sampleId).join(', ')}.
                  </span>
                ) : null}
              </span>
            </InfoNote>
          ) : null}

          <section aria-label="Operations widgets">
            <h2 className="mb-3 text-xl font-semibold text-slate-900">Today and now</h2>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {report.metrics.map((metric) => {
                const to = METRIC_DESTINATIONS[metric.definition.id];
                return (
                  <ReportCard
                    key={metric.definition.id}
                    metric={metric}
                    {...(to !== undefined ? { to } : {})}
                  />
                );
              })}
            </div>
          </section>

          <section aria-label="Samples today by stage">
            <StageBreakdown
              title={`Samples collected on ${report.plantDate} (Guyana), by stage`}
              rows={report.samplesTodayByStage.map((row) => ({
                stage: row.stage,
                ordinal: row.ordinal,
                title: row.title,
                valueText: renderMetric(row.value),
                numeric: row.value.kind === 'count',
              }))}
            />
            <p className="mt-2 text-sm text-slate-600">
              Counts registered samples only. A draft is not a collected sample, and a voided
              record is not counted. The numerator is the sample rows whose plant-local collection
              date is {report.plantDate}; there is no denominator, because this is a count and not
              a rate.
            </p>
          </section>

          <Card
            title="Sampling adherence"
            description="Whether sampling happened as often as the approved frequency requires."
          >
            <div className="flex flex-col gap-4">
              <div
                role="region"
                aria-label="Why four stages have no adherence figure"
                className="rounded-md border-2 border-amber-400 bg-amber-50 p-4"
              >
                <p className="flex items-center gap-2 text-base font-bold text-amber-900">
                  <Ruler aria-hidden className="h-5 w-5" />
                  No adherence or overdue figure is produced for {withheld.length} of{' '}
                  {DASHBOARD_ORDER.length} stages
                </p>
                <p className="mt-1 text-base text-amber-900">
                  The workbook&rsquo;s <code>Read me</code> tab records the sampling frequency for
                  these stages as <strong>&ldquo;To set&rdquo;</strong>, so there is no approved
                  target to measure against. A percentage would have to invent one. These stages
                  are therefore absent from the figures below by design, not by omission:
                </p>
                <ul className="mt-2 list-inside list-disc text-base text-amber-900">
                  {withheld.map((stage) => (
                    <li key={stage.stage}>
                      <strong>{stage.title}</strong> — frequency recorded as &ldquo;
                      {stage.frequency}&rdquo;
                    </li>
                  ))}
                </ul>
                <p className="mt-2 text-sm text-amber-900">
                  An overdue flag is withheld for the same reason: &ldquo;overdue&rdquo; is only
                  meaningful relative to an approved interval.
                </p>
              </div>

              <ul className="rounded-md border border-slate-200 px-3">
                {adherence.map(({ schema, result }) => (
                  <AdherenceRow
                    key={schema.stage}
                    result={result}
                    title={`${schema.ordinal}. ${schema.title}`}
                  />
                ))}
              </ul>

              <p className="flex items-start gap-2 text-sm text-slate-700">
                <Info aria-hidden className="mt-0.5 h-4 w-4 flex-shrink-0" />
                <span>
                  The three stages with a stated frequency read{' '}
                  <strong>{INSUFFICIENT_DATA_TEXT}</strong> rather than a percentage, because the
                  denominator — how many loads arrived, runs were made or production runs were
                  started — is not recorded anywhere in the system yet. That is a missing
                  measurement and could be fixed by recording it. The other four read{' '}
                  <strong>{NOT_PRODUCED_TEXT}</strong>, which no amount of extra data would
                  change: the target itself has not been approved.
                </span>
              </p>
            </div>
          </Card>

          <Card
            title="Metrics not in this release"
            description="Named here so their absence is deliberate rather than looking like an oversight (PRD §12)."
          >
            <p className="text-base text-slate-700">
              Exception rates by material, line and feed type; distributions and trends for
              conditioned temperature, raw-material aflatoxin, moisture, particle size and pellet
              durability; and open-action aging are a later iteration. None of them is shown as an
              empty chart in the meantime, because an empty chart reads as &ldquo;zero
              exceptions&rdquo; rather than &ldquo;not built&rdquo;.
            </p>
            <p className="mt-2 text-base text-slate-700">
              A conformity-exception rate additionally cannot be produced while no limit is
              approved: with nothing approved every measurement assesses as{' '}
              <strong>Not assessable</strong>, so an exception rate would have a numerator of zero
              and would read as perfect conformity. See <strong>Approved limits</strong> for the
              state of the ruleset.
            </p>
          </Card>
        </div>
      )}
    </div>
  );
}
