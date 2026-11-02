/**
 * Deterministic Google Sheets mapping.
 *
 * The ONLY place that turns a stored sample into a spreadsheet row. It
 * serializes exactly column A through the stage's documented last column, in
 * registry order, so a write addressed at `A5:S5` physically cannot touch
 * column T or any other tab.
 *
 * Scope boundary: this module owns STRUCTURE and ENCODING — column order,
 * width, enum-code-to-label translation, zero-vs-blank, precision, and
 * formula-injection refusal. It does NOT own operational range checking;
 * bounds live in `validation.ts` and are enforced server-side before a commit.
 * Keeping them apart avoids two competing sources of truth for a limit.
 */

import { DEFAULT_SIEVE_PRESET } from '../lib/dgm.ts';
import {
  applySieveSeries,
  sieveMassHeaders,
  sieveMassKey,
  type SieveSeriesDocument,
} from '../lib/sieveSeries.ts';
import {
  STAGE_SCHEMAS,
  isFieldApplicable,
  PROTECTED_HEADER_ROWS,
} from './registry.ts';
import type { FieldDef, Stage } from './types.ts';

/**
 * `RAW` is the primary formula-injection control: Sheets stores the string
 * literally instead of parsing a leading `=` as a formula. `USER_ENTERED`
 * would evaluate it. Asserted by test, never assumed.
 */
export const SHEETS_VALUE_INPUT_OPTION = 'RAW' as const;

/**
 * A measurement as held in the application. The object form carries the text
 * the operator actually typed so that a trailing zero — which states the
 * instrument's resolution — survives into the operational record.
 */
export type MeasurementValue =
  | number
  | string
  | null
  | undefined
  | { value: number; enteredText: string };

export type SampleValues = Readonly<Record<string, MeasurementValue>>;

/** Free-text narrative columns, where a leading `-` is legitimate prose. */
const FREEFORM_TEXT_KEYS: ReadonlySet<string> = new Set(['comments', 'action_taken']);

/*
 * The base-26 arithmetic lives in `columns.ts`, which the REGISTRY also uses
 * to generate runs of columns. Re-exported here so every existing caller and
 * test keeps its import path.
 */
export { columnLetterToIndex, indexToColumnLetter } from './columns.ts';

/**
 * Quote a tab name for A1 notation. Every operational tab name contains a
 * space, so quoting is mandatory, and an embedded apostrophe is doubled.
 */
export function quoteTabName(tab: string): string {
  return `'${tab.replace(/'/g, "''")}'`;
}

/** `'1 Raw materials'!A5:S5` — a single bounded data row. */
export function rangeForRow(stage: Stage, rowNumber: number): string {
  if (!Number.isInteger(rowNumber) || rowNumber <= PROTECTED_HEADER_ROWS) {
    throw new Error(
      `Refusing to build a write range at row ${rowNumber} on "${STAGE_SCHEMAS[stage].sheetTab}": rows 1-${PROTECTED_HEADER_ROWS} are protected (titles, merged section bands and the header row). Data starts at row ${PROTECTED_HEADER_ROWS + 1}.`,
    );
  }
  const s = STAGE_SCHEMAS[stage];
  return `${quoteTabName(s.sheetTab)}!A${rowNumber}:${s.lastColumn}${rowNumber}`;
}

/** `'1 Raw materials'!A4:S4` — the header row, read for verification only. */
export function rangeForHeaderRow(stage: Stage): string {
  const s = STAGE_SCHEMAS[stage];
  return `${quoteTabName(s.sheetTab)}!A4:${s.lastColumn}4`;
}

/** `'1 Raw materials'!A5:A` — column A only, for locating a record by ID. */
export function rangeForIdColumn(stage: Stage): string {
  const s = STAGE_SCHEMAS[stage];
  return `${quoteTabName(s.sheetTab)}!A${PROTECTED_HEADER_ROWS + 1}:A`;
}

/**
 * The row-4 header contract for a stage, in column order.
 *
 * ===========================================================================
 * THE CONTRACT FOLLOWS THE LAB'S SIEVE TABLE
 * ===========================================================================
 * Twelve of the fourteen sieve mass columns are named after a sieve's ABNT
 * designation, and an administrator may change those designations — the lab
 * re-calibrates, or replaces a sieve with the nearest one it has. Before this
 * parameter existed the designation reached the arithmetic and the screen but
 * NOT the workbook, so a stack re-designated to ABNT 18 kept a column headed
 * `ABNT 16 empty sieve (g)` until somebody retyped it by hand — a heading
 * that contradicted the figures underneath it on an ISO 9001 record.
 *
 * So `series` is the stored table and the contract is derived from it. Pass
 * `null` and you get the shipped preset's spelling, which is what the four
 * tabs were created with and what the registry's static `sheetHeader`
 * strings say. The two agree by construction: both call `sieveMassHeaders`.
 *
 * ONLY THE SIEVE COLUMNS MOVE. Every other heading is a fixed string in the
 * registry and is unaffected by any setting — see `seriesDerivedColumns`,
 * which is the set the sync worker is allowed to rewrite in the live sheet.
 */
export function expectedHeaders(
  stage: Stage,
  series: SieveSeriesDocument | null = null,
): string[] {
  const positions = applySieveSeries(DEFAULT_SIEVE_PRESET, series).positions;
  return STAGE_SCHEMAS[stage].fields.map((field) => {
    const sieve = sieveMassKey(field.key);
    if (sieve === null) return field.sheetHeader;
    const position = positions[sieve.position - 1];
    if (position === undefined) return field.sheetHeader;
    return sieveMassHeaders(position.abnt, position.isPan)[sieve.kind];
  });
}

/**
 * The columns of a stage whose heading is derived from the sieve table.
 *
 * This is the repair surface, and it is deliberately narrow: these are the
 * only cells the sync worker may rewrite in row 4 of a live tab, so a
 * mismatch anywhere else still fences the workbook off as it always did.
 */
export function seriesDerivedColumns(stage: Stage): ReadonlySet<string> {
  return new Set(
    STAGE_SCHEMAS[stage].fields
      .filter((field) => sieveMassKey(field.key) !== null)
      .map((field) => field.columnLetter),
  );
}

/**
 * Does this text read as a spreadsheet formula? Leading whitespace is stripped
 * first, because a tab or newline before `=` still parses as a formula in some
 * consumers while defeating a naive first-character check.
 */
export function looksLikeFormula(value: string): boolean {
  // The control-character class is the point of this check, not an oversight:
  // a NUL or tab placed before `=` defeats a naive first-character test while
  // still parsing as a formula downstream, so it must be stripped first.
  // eslint-disable-next-line no-control-regex
  const trimmed = value.replace(/^[\s\u0000-\u001f]+/, '');
  if (trimmed.length === 0) return false;
  return ['=', '+', '-', '@'].includes(trimmed[0]!);
}

/**
 * Neutralise formula-like text for CSV/Excel export (FR-019). `RAW` protects
 * the Sheet itself but gives no protection once values are exported and opened
 * in a spreadsheet application, so the export path escapes explicitly.
 */
export function escapeForCsvExport(value: string): string {
  return looksLikeFormula(value) ? `'${value}` : value;
}

function encodeNumber(field: FieldDef, raw: MeasurementValue): string {
  if (typeof raw === 'object' && raw !== null) {
    if (!Number.isFinite(raw.value)) {
      throw new Error(`Field "${field.key}" has a non-finite measurement (${raw.value}); refusing to write`);
    }
    // Trust the operator's own text so entered precision is preserved exactly.
    return raw.enteredText;
  }
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) {
      throw new Error(`Field "${field.key}" has a non-finite measurement (${raw}); refusing to write`);
    }
    return String(raw);
  }
  // A numeric field carrying a string: accept only a clean numeric literal.
  const text = String(raw).trim();
  if (!/^-?\d+(\.\d+)?$/.test(text)) {
    throw new Error(`Field "${field.key}" expects a number, received ${JSON.stringify(raw)}`);
  }
  if (!Number.isFinite(Number(text))) {
    throw new Error(`Field "${field.key}" has a non-finite measurement; refusing to write`);
  }
  return text;
}

function encodeEnum(field: FieldDef, raw: MeasurementValue): string {
  const code = String(raw);
  const option = field.options?.find((o) => o.value === code);
  if (!option) {
    const allowed = (field.options ?? []).map((o) => o.value).join(', ');
    throw new Error(
      `Field "${field.key}" received unknown code ${JSON.stringify(code)}; allowed codes are [${allowed}]`,
    );
  }
  // The sheet receives the human label; the code stays in the database.
  return option.label;
}

function encodeText(field: FieldDef, raw: MeasurementValue): string {
  const text = String(raw);
  if (!FREEFORM_TEXT_KEYS.has(field.key) && looksLikeFormula(text)) {
    throw new Error(
      `Field "${field.key}" contains formula-like text (${JSON.stringify(text.slice(0, 40))}). Identity and traceability fields must not begin with = + - or @.`,
    );
  }
  return text;
}

/**
 * Serialize one sample into its operational row.
 *
 * Returns exactly `columnCount` cells, index 0 = column A. Unknown keys in
 * `values` are ignored rather than appended, so no caller can widen the legacy
 * range by passing an extra field.
 */
export function toSheetRow(
  stage: Stage,
  sampleId: string,
  values: SampleValues,
): string[] {
  const schema = STAGE_SCHEMAS[stage];

  return schema.fields.map((field) => {
    if (field.key === 'sample_id') return sampleId;

    // A field that does not apply is blank — never zero, and never a stale
    // value left behind when the operator switched sampling point.
    if (!isFieldApplicable(field, values as Record<string, unknown>)) return '';

    const raw = values[field.key];
    if (raw === null || raw === undefined || raw === '') return '';

    switch (field.type) {
      case 'number':
        return encodeNumber(field, raw);
      case 'select':
      case 'yesno':
        return encodeEnum(field, raw);
      case 'text':
      case 'textarea':
      case 'date':
      case 'time':
        return encodeText(field, raw);
      case 'system':
        return encodeText(field, raw);
      default: {
        const exhaustive: never = field.type;
        throw new Error(`Unhandled field type ${String(exhaustive)}`);
      }
    }
  });
}

/** Header comparison result from `verifyWorkbook`. */
export interface HeaderMismatch {
  readonly stage: Stage;
  readonly columnLetter: string;
  readonly expected: string;
  readonly actual: string;
}

/**
 * Compare a sheet's actual row-4 headers against the registry contract.
 * Returns every mismatch; an empty array means the tab is safe to write.
 * Trailing blanks beyond the legacy range are ignored, but a difference
 * inside it — including a changed space or accent — is a mismatch.
 */
export function diffHeaders(
  stage: Stage,
  actualRow: readonly string[],
  series: SieveSeriesDocument | null = null,
): HeaderMismatch[] {
  const schema = STAGE_SCHEMAS[stage];
  const expected = expectedHeaders(stage, series);
  const mismatches: HeaderMismatch[] = [];
  schema.fields.forEach((field, i) => {
    const actual = (actualRow[i] ?? '').trim();
    const want = expected[i]!;
    if (actual !== want) {
      mismatches.push({
        stage,
        columnLetter: field.columnLetter,
        expected: want,
        actual,
      });
    }
  });
  return mismatches;
}
