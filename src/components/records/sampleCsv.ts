/**
 * Filtered CSV export (FR-019).
 *
 * Column fidelity comes from `toSheetRow`, the same function the Google Sheets
 * writer uses, so an exported block has exactly the columns of its tab, in the
 * same order. That is what makes "exported values agree with Google Sheets"
 * checkable rather than asserted.
 *
 * Every cell then passes through `escapeForCsvExport`. `RAW` protects the
 * Sheet itself but gives no protection once a CSV is opened in a spreadsheet
 * application, so a value that reads as a formula is neutralised here too.
 * CSV quoting is applied on top: the two concerns are separate and both are
 * needed.
 *
 * Stages have different column sets, so a multi-stage export is written as one
 * block per tab, each with its own header row. Flattening seven tabs into a
 * single union of columns would invent a shape the workbook does not have.
 */

import { getSchema } from '@/forms/registry';
import {
  escapeForCsvExport,
  expectedHeaders,
  quoteTabName,
  toSheetRow,
  type SampleValues,
} from '@/forms/sheetMapping';
import { FIRST_DATA_ROW } from '@/forms/registry';
import type { Stage } from '@/forms/types';
import { formatPlantDateTimeLabelled } from '@/lib/time';
import type { MeasurementRow, SampleFilters, SampleRow } from '@/hooks/useSamples';

/** Hard cap, so an export cannot become an unbounded download. */
export const EXPORT_ROW_LIMIT = 5000;

/**
 * Identity columns are denormalised onto `samples` for searching, so an
 * export falls back to them when a field has no measurement row. A measurement
 * row always wins, because that is the per-field record.
 */
const SAMPLE_FALLBACK: Readonly<Record<string, (row: SampleRow) => unknown>> = {
  collection_date: (r) => r.collection_local_date,
  collection_time: (r) => r.collection_local_time,
  sampling_point: (r) => r.sampling_point,
  material: (r) => r.material,
  // `2 Ground` column E carries either a material or a feed type.
  material_or_feed_type: (r) => r.material ?? r.feed_type,
  feed_type: (r) => r.feed_type,
  supplier: (r) => r.supplier,
  delivery_or_lot_no: (r) => r.lot_no,
  raw_soya_lot_no: (r) => r.lot_no,
  batch_or_bin_no: (r) => r.batch_no,
  batch_no: (r) => r.batch_no,
  run_no: (r) => r.run_no,
};

function csvField(value: string): string {
  // Formula neutralisation first, then CSV quoting of the result.
  const safe = escapeForCsvExport(value);
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

function csvLine(cells: readonly string[]): string {
  return cells.map(csvField).join(',');
}

/** A `#` comment line. Written through the same escaping as any other cell. */
function metaLine(label: string, value: string): string {
  return csvLine([`# ${label}`, value]);
}

export interface ExportContext {
  readonly exportedByName: string;
  readonly exportedByEmail: string | null;
  readonly exportedAt: Date;
  readonly appVersion: string;
  readonly filters: SampleFilters;
}

export interface ExportInput {
  readonly rows: readonly SampleRow[];
  /** Measurements keyed by sample UUID. Missing entries fall back to `samples`. */
  readonly measurementsBySample: ReadonlyMap<string, readonly MeasurementRow[]>;
  readonly truncated: boolean;
}

export interface ExportResult {
  readonly csv: string;
  /** Samples that could not be serialised, with the reason. Never silent. */
  readonly failures: readonly { sampleId: string; message: string }[];
  readonly rowCount: number;
}

function describeFilters(filters: SampleFilters): string {
  const parts: string[] = [];
  if (filters.text) parts.push(`text "${filters.text}"`);
  if (filters.stages.length > 0) {
    parts.push(`stages ${filters.stages.map((s) => getSchema(s).title).join(' / ')}`);
  }
  if (filters.fromDate) parts.push(`collected from ${filters.fromDate} (Guyana)`);
  if (filters.toDate) parts.push(`collected to ${filters.toDate} (Guyana)`);
  if (filters.material) parts.push(`material ${filters.material}`);
  if (filters.supplier) parts.push(`supplier matching "${filters.supplier}"`);
  if (filters.captureStates.length > 0) parts.push(`record state ${filters.captureStates.join(', ')}`);
  if (filters.testingStatus !== 'any') parts.push(`testing status ${filters.testingStatus}`);
  if (filters.holdOnly) parts.push('on quality hold only');
  return parts.length === 0 ? 'no filters — all records the user is permitted to read' : parts.join('; ');
}

function valuesFor(
  row: SampleRow,
  measurements: readonly MeasurementRow[],
  stage: Stage,
): SampleValues {
  const byKey = new Map<string, MeasurementRow>();
  for (const m of measurements) byKey.set(m.field_key, m);

  const values: Record<string, unknown> = {};
  for (const field of getSchema(stage).fields) {
    const measurement = byKey.get(field.key);
    if (measurement) {
      if (measurement.numeric_value !== null) {
        // Preserve the operator's own text so entered precision survives.
        values[field.key] =
          measurement.entered_text !== null && measurement.entered_text !== ''
            ? { value: measurement.numeric_value, enteredText: measurement.entered_text }
            : measurement.numeric_value;
      } else {
        values[field.key] = measurement.text_value;
      }
      continue;
    }
    const fallback = SAMPLE_FALLBACK[field.key];
    if (fallback) values[field.key] = fallback(row);
  }
  return values as SampleValues;
}

export function buildSampleCsv(input: ExportInput, ctx: ExportContext): ExportResult {
  const lines: string[] = [];
  const failures: { sampleId: string; message: string }[] = [];

  const stages = [...new Set(input.rows.map((r) => r.stage))];

  lines.push(metaLine('Export', 'BFF Sample Testing — filtered sample export'));
  lines.push(
    metaLine(
      'Authoritative source',
      'Supabase ledger (table "samples" and "sample_measurements"), the committed quality record',
    ),
  );
  for (const stage of stages) {
    const schema = getSchema(stage);
    lines.push(
      metaLine(
        'Source range',
        `${quoteTabName(schema.sheetTab)}!A${FIRST_DATA_ROW}:${schema.lastColumn} (${schema.columnCount} columns)`,
      ),
    );
  }
  lines.push(
    metaLine('Exported by', `${ctx.exportedByName}${ctx.exportedByEmail ? ` <${ctx.exportedByEmail}>` : ''}`),
  );
  lines.push(metaLine('Exported at', formatPlantDateTimeLabelled(ctx.exportedAt)));
  lines.push(metaLine('Application version', ctx.appVersion));
  lines.push(metaLine('Filters applied', describeFilters(ctx.filters)));
  lines.push(metaLine('Records in this file', String(input.rows.length)));
  if (input.truncated) {
    lines.push(
      metaLine(
        'TRUNCATED',
        `More records matched than the ${EXPORT_ROW_LIMIT}-record export limit. Narrow the filters and export again.`,
      ),
    );
  }
  lines.push(
    metaLine(
      'Note',
      'A value beginning with = + - or @ is prefixed with an apostrophe so a spreadsheet application cannot evaluate it as a formula.',
    ),
  );

  for (const stage of stages) {
    const schema = getSchema(stage);
    const stageRows = input.rows.filter((r) => r.stage === stage);

    lines.push('');
    lines.push(metaLine('Tab', schema.sheetTab));
    lines.push(csvLine(expectedHeaders(stage)));

    for (const row of stageRows) {
      const sampleId = row.sample_id ?? `(draft ${row.id})`;
      try {
        const cells = toSheetRow(
          stage,
          sampleId,
          valuesFor(row, input.measurementsBySample.get(row.id) ?? [], stage),
        );
        lines.push(csvLine(cells));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push({ sampleId, message });
        // The row is named rather than dropped quietly: a short export that
        // looks complete is worse than one that says what is missing.
        lines.push(csvLine([sampleId, `NOT EXPORTED — ${message}`]));
      }
    }
  }

  // A UTF-8 byte-order mark, so µm and °C survive being opened in Excel.
  // Written as an escape rather than a literal U+FEFF: a raw BOM in source is
  // invisible in every editor, so it gets deleted by accident and silently
  // takes the encoding hint with it.
  return { csv: `\uFEFF${lines.join('\r\n')}\r\n`, failures, rowCount: input.rows.length };
}

export function exportFileName(exportedAt: Date): string {
  const stamp = exportedAt.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `bff-sample-export-${stamp}.csv`;
}

/** Hand the file to the browser. Returns false when the browser refused. */
export function downloadCsv(fileName: string, csv: string): boolean {
  try {
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
    return true;
  } catch {
    return false;
  }
}
