/**
 * Find a sample.
 *
 * One searchable, server-paginated list across all seven stages. Results are
 * whatever row level security lets this user read, so a pending account sees
 * an empty list because the database says so.
 *
 * Loading, failed and empty are three different states and each says which it
 * is. A failed search never renders as "no results found".
 */

import { useState } from 'react';
import { Download, FileSpreadsheet } from 'lucide-react';

import {
  EMPTY_FILTERS,
  PAGE_SIZE,
  fetchSamplesForExport,
  appVersion,
  useAuthority,
  useMaterialOptions,
  useSampleList,
  type SampleFilters as Filters,
} from '@/hooks/useSamples';
import {
  Button,
  Card,
  EmptyState,
  ErrorNotice,
  InfoNote,
  LoadingBlock,
  NotPermitted,
  PageHeader,
} from '@/components/records/common';
import { SampleFilters } from '@/components/records/SampleFilters';
import { SampleTable } from '@/components/records/SampleTable';
import { Pagination } from '@/components/records/Pagination';
import {
  EXPORT_ROW_LIMIT,
  buildSampleCsv,
  downloadCsv,
  exportFileName,
  type ExportResult,
} from '@/components/records/sampleCsv';

export default function SamplesPage() {
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [page, setPage] = useState(0);
  const { user, allows } = useAuthority();
  const list = useSampleList(filters, page);
  const materials = useMaterialOptions();

  const [exporting, setExporting] = useState(false);
  const [exportResult, setExportResult] = useState<ExportResult | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  const canExport = allows('export.run');

  function changeFilters(next: Filters) {
    setFilters(next);
    setPage(0);
  }

  async function runExport() {
    setExporting(true);
    setExportError(null);
    setExportResult(null);
    try {
      const data = await fetchSamplesForExport(filters, EXPORT_ROW_LIMIT);
      if (data.rows.length === 0) {
        setExportError('Nothing matched the current filters, so no file was produced.');
        return;
      }
      const result = buildSampleCsv(data, {
        exportedByName: user?.fullName ?? user?.email ?? 'Unknown user',
        exportedByEmail: user?.email ?? null,
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
    <div className="mx-auto max-w-7xl px-4 py-6">
      <PageHeader
        title="Samples"
        description="Search every sample from all seven forms. Dates are the Guyana day the sample was taken."
        actions={
          canExport ? (
            <Button variant="secondary" onClick={() => void runExport()} disabled={exporting}>
              <Download aria-hidden className="h-4 w-4" />
              {exporting ? 'Preparing export…' : 'Export these results (CSV)'}
            </Button>
          ) : undefined
        }
      />

      <div className="flex flex-col gap-5">
        <SampleFilters
          value={filters}
          onChange={changeFilters}
          materials={materials.data ?? []}
          materialsUnavailable={materials.isError}
        />

        {!canExport ? (
          <NotPermitted reason="Exporting records needs the export permission. Ask a Quality Supervisor if you need a copy." />
        ) : null}

        {exportError ? (
          <p role="alert" className="rounded-md border border-red-300 bg-red-50 p-3 text-base text-red-900">
            The export did not complete: {exportError}
          </p>
        ) : null}

        {exportResult ? (
          <InfoNote tone={exportResult.failures.length > 0 ? 'warning' : 'info'}>
            <span className="flex flex-col gap-1">
              <span className="flex items-center gap-2">
                <FileSpreadsheet aria-hidden className="h-4 w-4" />
                {exportResult.rowCount} record{exportResult.rowCount === 1 ? '' : 's'} written. The
                file states its source range, who exported it and when.
              </span>
              {exportResult.failures.length > 0 ? (
                <span>
                  {exportResult.failures.length} record
                  {exportResult.failures.length === 1 ? '' : 's'} could not be serialised and are
                  named in the file rather than dropped:{' '}
                  {exportResult.failures.map((f) => f.sampleId).join(', ')}.
                </span>
              ) : null}
            </span>
          </InfoNote>
        ) : null}

        <Card>
          {list.isPending ? (
            <LoadingBlock label="Searching samples" />
          ) : list.isError ? (
            <ErrorNotice error={list.error} what="The sample list" onRetry={() => void list.refetch()} />
          ) : list.data.rows.length === 0 ? (
            <EmptyState
              title="No samples match this search."
              hint="Try clearing a filter, or widening the date range. If you have just signed in and expect to see records, your access may still be awaiting approval."
            />
          ) : (
            <div className="flex flex-col gap-4">
              {list.isFetching ? (
                <p role="status" className="text-sm text-slate-600">
                  Updating results…
                </p>
              ) : null}
              <SampleTable rows={list.data.rows} />
              <Pagination
                page={page}
                pageSize={PAGE_SIZE}
                total={list.data.total}
                totalUnknown={list.data.totalUnknown}
                rowsOnPage={list.data.rows.length}
                onPageChange={setPage}
                busy={list.isFetching}
              />
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
