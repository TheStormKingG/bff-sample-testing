/**
 * In-memory Google Sheets double.
 *
 * Master Prompt §7 requires "a fake/in-memory adapter for fast tests". A fake
 * that only models the happy path would pass every test while proving nothing,
 * so this one models the behaviours that actually break naive sync code:
 *
 *  - trailing empty cells are DROPPED on read, exactly as the Sheets API does,
 *    so any comparison that forgets to normalise row width reports false drift;
 *  - `append` picks the first blank row in the data region, which is NOT
 *    necessarily the row after the last one we wrote;
 *  - a write can be instructed to land and THEN time out, which is the only
 *    faithful model of an unknown outcome;
 *  - rows can be re-sorted or hand-edited between calls, as a human
 *    collaborator would;
 *  - a header cell can be changed, to prove the writer refuses to run;
 *  - every call is counted, so a test can assert that locating a record does
 *    not read the whole spreadsheet.
 *
 * PURE: no Deno, no npm/jsr, no I/O.
 */

import {
  FIRST_DATA_ROW,
  PROTECTED_HEADER_ROWS,
  REFERENCE_TABS,
  STAGE_SCHEMAS,
} from '../../../src/forms/registry.ts';
import { STAGES, type Stage } from '../../../src/forms/types.ts';
import { expectedHeaders } from '../../../src/forms/sheetMapping.ts';
import { assertWritableRange } from './headerCheck.ts';
import type { LocatedRecord } from './projection.ts';
import {
  SheetsError,
  SheetsQuotaError,
  SheetsUnknownOutcomeError,
  type GoogleSheetsAdapter,
  type LocateResult,
  type ReconciliationRead,
  type ReconciliationRow,
  type SheetsHealth,
  type UpsertRequest,
  type UpsertResult,
  type VerifyWorkbookResult,
} from './sheets.ts';

export type FakeOperation =
  | 'verifyWorkbook'
  | 'locateRecord'
  | 'upsertOperationalRow'
  | 'readForReconciliation'
  | 'healthCheck';

export type FakeFault =
  /**
   * `landsFirst: true` applies the write and THEN throws. This is the case
   * that produces a duplicate row in implementations that read a timeout as
   * a failure.
   */
  | { readonly kind: 'timeout'; readonly landsFirst?: boolean; readonly message?: string }
  | { readonly kind: 'quota'; readonly retryAfterMs?: number | null }
  | { readonly kind: 'retryable'; readonly message?: string; readonly status?: number }
  | { readonly kind: 'permanent'; readonly message?: string; readonly status?: number };

/** Strip trailing blanks, as the Sheets API does on `values.get`. */
function truncateTrailingBlanks(cells: readonly string[]): string[] {
  const out = [...cells];
  while (out.length > 0 && (out[out.length - 1] ?? '') === '') out.pop();
  return out;
}

export class FakeWorkbook {
  /** tab title -> rows, index 0 = spreadsheet row 1. */
  private readonly grid = new Map<string, string[][]>();
  private readonly a5Formula = new Map<Stage, string | null>();
  private readonly titles: string[];

  constructor(readonly title = 'BFF Sample Test Log — CONTROLLED TEST COPY') {
    this.titles = [...REFERENCE_TABS];
    for (const tab of REFERENCE_TABS) {
      // The reference tabs exist but carry no operational rows; a test that
      // asserts they were never written needs them to be present.
      this.grid.set(tab, [[`${tab} — preserved reference content`]]);
    }
    for (const stage of STAGES) {
      const schema = STAGE_SCHEMAS[stage];
      this.titles.push(schema.sheetTab);
      const width = schema.columnCount;
      const blank = (): string[] => new Array<string>(width).fill('');
      const rows: string[][] = [];
      // Row 1 title, row 2 instruction, row 3 merged section bands, row 4 headers.
      const row1 = blank();
      row1[0] = `${schema.ordinal}  ${schema.title}`;
      const row2 = blank();
      row2[0] = schema.instruction;
      const row3 = blank();
      let seen: string | null = null;
      schema.fields.forEach((f, i) => {
        if (f.section !== seen) {
          row3[i] = f.section;
          seen = f.section;
        }
      });
      rows.push(row1, row2, row3, [...expectedHeaders(stage)]);
      this.grid.set(schema.sheetTab, rows);
      this.a5Formula.set(stage, null);
    }
  }

  get tabTitles(): readonly string[] {
    return [...this.titles];
  }

  private rowsOf(tab: string): string[][] {
    const rows = this.grid.get(tab);
    if (rows === undefined) throw new SheetsError(`Unknown tab "${tab}"`, { retryable: false, status: 400 });
    return rows;
  }

  rowsFor(stage: Stage): readonly (readonly string[])[] {
    return this.rowsOf(STAGE_SCHEMAS[stage].sheetTab).map((r) => [...r]);
  }

  /** Raw cells of one spreadsheet row (1-based), or null if beyond the grid. */
  rawRow(stage: Stage, rowNumber: number): readonly string[] | null {
    const rows = this.rowsOf(STAGE_SCHEMAS[stage].sheetTab);
    const row = rows[rowNumber - 1];
    return row === undefined ? null : [...row];
  }

  /** Data rows, 1-based row numbers, excluding the protected header region. */
  dataRows(stage: Stage): { rowNumber: number; cells: string[] }[] {
    const rows = this.rowsOf(STAGE_SCHEMAS[stage].sheetTab);
    const out: { rowNumber: number; cells: string[] }[] = [];
    for (let i = PROTECTED_HEADER_ROWS; i < rows.length; i++) {
      const cells = rows[i];
      if (cells === undefined) continue;
      out.push({ rowNumber: i + 1, cells: [...cells] });
    }
    return out;
  }

  /** How many data rows carry a non-blank column A. */
  countRecords(stage: Stage): number {
    return this.dataRows(stage).filter((r) => (r.cells[0] ?? '') !== '').length;
  }

  writeRow(stage: Stage, rowNumber: number, cells: readonly string[]): void {
    const schema = STAGE_SCHEMAS[stage];
    assertWritableRange(schema.sheetTab, rowNumber);
    if (cells.length !== schema.columnCount) {
      throw new SheetsError(
        `Refusing a ${cells.length}-cell write to "${schema.sheetTab}" (${schema.columnCount} columns)`,
        { retryable: false, status: 400 },
      );
    }
    const rows = this.rowsOf(schema.sheetTab);
    while (rows.length < rowNumber) {
      rows.push(new Array<string>(schema.columnCount).fill(''));
    }
    rows[rowNumber - 1] = [...cells];
  }

  /**
   * The first row the workbook offers as blank — what the writer targets.
   *
   * EMPTINESS IS JUDGED ACROSS THE WHOLE ROW. This used to ask only whether
   * COLUMN A was blank, and that is a materially different rule: a legacy
   * hand-entered row with a date and a note but no identifier reads as free
   * and gets overwritten. An audit demonstrated exactly that against a row
   * holding '2019-03-02' and 'HISTORIC PAPER RECORD — no id'.
   *
   * It matters that the double agrees with production here. It did not: the
   * real adapter used to append with INSERT_ROWS while this picked a blank
   * column A and replaced it, so the two differed on the very axis the writer
   * was being tested against, and a green suite was evidence about neither.
   */
  firstFreeRow(stage: Stage): number {
    const rows = this.rowsOf(STAGE_SCHEMAS[stage].sheetTab);
    for (let i = PROTECTED_HEADER_ROWS; i < rows.length; i++) {
      const occupied = (rows[i] ?? []).some((cell) => String(cell ?? '').trim() !== '');
      if (!occupied) return i + 1;
    }
    return rows.length + 1;
  }

  // -- Mutations a human collaborator could make -----------------------------

  /** Re-sort the data region, as a user clicking "Sort A→Z" would. */
  sortDataRowsByColumn(stage: Stage, columnIndex: number, direction: 'asc' | 'desc' = 'asc'): void {
    const schema = STAGE_SCHEMAS[stage];
    const rows = this.rowsOf(schema.sheetTab);
    const header = rows.slice(0, PROTECTED_HEADER_ROWS);
    const data = rows.slice(PROTECTED_HEADER_ROWS).filter((r) => (r[0] ?? '') !== '');
    const blanks = rows.slice(PROTECTED_HEADER_ROWS).filter((r) => (r[0] ?? '') === '');
    data.sort((a, b) => {
      const x = a[columnIndex] ?? '';
      const y = b[columnIndex] ?? '';
      const cmp = x < y ? -1 : x > y ? 1 : 0;
      return direction === 'asc' ? cmp : -cmp;
    });
    this.grid.set(schema.sheetTab, [...header, ...data, ...blanks]);
  }

  /** A hand edit to one cell. */
  setCell(stage: Stage, rowNumber: number, columnIndex: number, value: string): void {
    const rows = this.rowsOf(STAGE_SCHEMAS[stage].sheetTab);
    const row = rows[rowNumber - 1];
    if (row === undefined) throw new Error(`Row ${rowNumber} does not exist`);
    row[columnIndex] = value;
  }

  /** Change a row-4 header, to prove the writer refuses to proceed. */
  setHeader(stage: Stage, columnIndex: number, value: string): void {
    const rows = this.rowsOf(STAGE_SCHEMAS[stage].sheetTab);
    const header = rows[PROTECTED_HEADER_ROWS - 1];
    if (header === undefined) throw new Error('Header row missing');
    header[columnIndex] = value;
  }

  /** Delete a data row, as a user pressing "Delete row" would. */
  deleteRow(stage: Stage, rowNumber: number): void {
    const schema = STAGE_SCHEMAS[stage];
    const rows = this.rowsOf(schema.sheetTab);
    if (rowNumber <= PROTECTED_HEADER_ROWS) throw new Error('Refusing to delete a protected row');
    rows.splice(rowNumber - 1, 1);
  }

  /** Plant a second row with the same identifier. */
  insertDuplicate(stage: Stage, sourceRowNumber: number): void {
    const schema = STAGE_SCHEMAS[stage];
    const rows = this.rowsOf(schema.sheetTab);
    const source = rows[sourceRowNumber - 1];
    if (source === undefined) throw new Error(`Row ${sourceRowNumber} does not exist`);
    const target = this.firstFreeRow(stage);
    this.writeRow(stage, target, source);
  }

  setA5Formula(stage: Stage, formula: string | null): void {
    this.a5Formula.set(stage, formula);
  }

  a5FormulaFor(stage: Stage): string | null {
    return this.a5Formula.get(stage) ?? null;
  }

  removeTab(tab: string): void {
    this.grid.delete(tab);
    const i = this.titles.indexOf(tab);
    if (i >= 0) this.titles.splice(i, 1);
  }

  renameStageTab(stage: Stage, newTitle: string): void {
    const old = STAGE_SCHEMAS[stage].sheetTab;
    const rows = this.rowsOf(old);
    this.grid.delete(old);
    this.grid.set(newTitle, rows);
    const i = this.titles.indexOf(old);
    if (i >= 0) this.titles[i] = newTitle;
  }
}

export class FakeGoogleSheetsAdapter implements GoogleSheetsAdapter {
  readonly workbook: FakeWorkbook;
  /** Total Sheets API calls the fake has been asked to make. */
  apiCalls = 0;
  /** Per-operation counts, for quota assertions. */
  readonly callLog: FakeOperation[] = [];

  private readonly faults = new Map<FakeOperation, FakeFault[]>();
  /** Invoked immediately before each upsert applies, to simulate a race. */
  private beforeUpsert: ((request: UpsertRequest) => void) | null = null;

  constructor(workbook?: FakeWorkbook, readonly spreadsheetId = 'test-workbook-id') {
    this.workbook = workbook ?? new FakeWorkbook();
  }

  /** Queue a fault for the next call to `operation`. Faults are consumed FIFO. */
  failNext(operation: FakeOperation, fault: FakeFault): this {
    const queue = this.faults.get(operation) ?? [];
    queue.push(fault);
    this.faults.set(operation, queue);
    return this;
  }

  onBeforeUpsert(hook: ((request: UpsertRequest) => void) | null): this {
    this.beforeUpsert = hook;
    return this;
  }

  private take(operation: FakeOperation): FakeFault | null {
    const queue = this.faults.get(operation);
    if (queue === undefined || queue.length === 0) return null;
    return queue.shift() ?? null;
  }

  private count(operation: FakeOperation, calls = 1): void {
    this.apiCalls += calls;
    for (let i = 0; i < calls; i++) this.callLog.push(operation);
  }

  private static raise(fault: FakeFault, operation: string): never {
    switch (fault.kind) {
      case 'timeout':
        throw new SheetsUnknownOutcomeError(
          fault.message ?? `Sheets ${operation} timed out after 15000 ms; outcome unknown`,
          operation,
        );
      case 'quota':
        throw new SheetsQuotaError(
          'Quota exceeded for quota metric "Write requests" of service "sheets.googleapis.com"',
          fault.retryAfterMs ?? 30_000,
        );
      case 'retryable':
        throw new SheetsError(fault.message ?? 'Sheets backend error', {
          retryable: true,
          status: fault.status ?? 503,
        });
      case 'permanent':
        throw new SheetsError(fault.message ?? 'Caller does not have permission', {
          retryable: false,
          status: fault.status ?? 403,
        });
    }
  }

  async verifyWorkbook(stages: readonly Stage[] = STAGES): Promise<VerifyWorkbookResult> {
    // One batchGet for the header ranges, one metadata call for the titles.
    this.count('verifyWorkbook', 2);
    const fault = this.take('verifyWorkbook');
    if (fault !== null) FakeGoogleSheetsAdapter.raise(fault, 'verifyWorkbook');

    const readings = stages
      .filter((stage) => this.workbook.tabTitles.includes(STAGE_SCHEMAS[stage].sheetTab))
      .map((stage) => {
        const header = this.workbook.rawRow(stage, PROTECTED_HEADER_ROWS) ?? [];
        return {
          stage,
          headerRow: truncateTrailingBlanks(header),
          a5Formula: this.workbook.a5FormulaFor(stage),
        };
      });

    return await Promise.resolve({
      identity: { spreadsheetId: this.spreadsheetId, title: this.workbook.title },
      reading: { tabTitles: this.workbook.tabTitles, stages: readings },
    });
  }

  async locateRecord(stage: Stage, sampleId: string): Promise<LocateResult> {
    // One call for column A, one for the matched row. Never the whole sheet.
    const rows = this.workbook.dataRows(stage);
    this.count('locateRecord');
    const fault = this.take('locateRecord');
    if (fault !== null) FakeGoogleSheetsAdapter.raise(fault, 'locateRecord');

    const matches = rows.filter((r) => (r.cells[0] ?? '').trim() === sampleId);
    if (matches.length === 0) {
      return await Promise.resolve({ record: null, duplicateRows: [], rowsScanned: rows.length });
    }

    const first = matches[0]!;
    this.count('locateRecord');
    const record: LocatedRecord = {
      rowNumber: first.rowNumber,
      values: truncateTrailingBlanks(first.cells),
    };
    return await Promise.resolve({
      record,
      duplicateRows: matches.slice(1).map((m) => m.rowNumber),
      rowsScanned: rows.length,
    });
  }

  async upsertOperationalRow(request: UpsertRequest): Promise<UpsertResult> {
    this.count('upsertOperationalRow');
    this.beforeUpsert?.(request);

    const fault = this.take('upsertOperationalRow');
    const landsFirst = fault?.kind === 'timeout' && fault.landsFirst === true;

    if (fault !== null && !landsFirst) {
      FakeGoogleSheetsAdapter.raise(fault, 'upsertOperationalRow');
    }

    const rowNumber =
      request.instruction.mode === 'append'
        ? this.workbook.firstFreeRow(request.stage)
        : request.instruction.rowNumber;

    this.workbook.writeRow(request.stage, rowNumber, request.row);

    if (fault !== null && landsFirst) {
      // The bytes landed; the caller will never learn that from the response.
      FakeGoogleSheetsAdapter.raise(fault, 'upsertOperationalRow');
    }

    // Read-back verification call.
    this.count('upsertOperationalRow');
    const written = this.workbook.rawRow(request.stage, rowNumber);
    return await Promise.resolve({
      rowNumber,
      readBack:
        written === null
          ? null
          : { rowNumber, values: truncateTrailingBlanks(written) },
      apiCalls: 2,
    });
  }

  async readForReconciliation(
    stage: Stage,
    options?: { readonly limit?: number; readonly fromRow?: number },
  ): Promise<ReconciliationRead> {
    this.count('readForReconciliation');
    const fault = this.take('readForReconciliation');
    if (fault !== null) FakeGoogleSheetsAdapter.raise(fault, 'readForReconciliation');

    const fromRow = options?.fromRow ?? FIRST_DATA_ROW;
    const all = this.workbook.dataRows(stage).filter((r) => r.rowNumber >= fromRow);
    const limited = options?.limit === undefined ? all : all.slice(0, options.limit);

    const rows: ReconciliationRow[] = [];
    const blankIdRows: number[] = [];
    for (const r of limited) {
      const id = (r.cells[0] ?? '').trim();
      const hasContent = r.cells.some((c) => (c ?? '') !== '');
      if (id === '') {
        if (hasContent) blankIdRows.push(r.rowNumber);
        continue;
      }
      rows.push({ rowNumber: r.rowNumber, sampleId: id, values: truncateTrailingBlanks(r.cells) });
    }

    return await Promise.resolve({ stage, rows, blankIdRows, apiCalls: 1 });
  }

  async healthCheck(): Promise<SheetsHealth> {
    this.count('healthCheck');
    const fault = this.take('healthCheck');
    if (fault !== null) {
      try {
        FakeGoogleSheetsAdapter.raise(fault, 'healthCheck');
      } catch (error) {
        return await Promise.resolve({
          reachable: false,
          latencyMs: null,
          title: null,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return await Promise.resolve({
      reachable: true,
      latencyMs: 12,
      title: this.workbook.title,
      error: null,
    });
  }
}
