/**
 * The real `GoogleSheetsAdapter`, over Sheets API v4. DENO-ONLY.
 *
 * Reads narrowly and writes narrowly, on purpose:
 *
 *  - `locateRecord` reads COLUMN A ONLY (`rangeForIdColumn`), then one row.
 *    Master Prompt §7 forbids reading the whole spreadsheet per request, and a
 *    304-row × 19-column read for every event would exhaust the quota while
 *    pulling data we have no use for.
 *  - `upsertOperationalRow` writes exactly `A{n}:{last}{n}` (`rangeForRow`),
 *    which physically cannot touch an adjacent column or another tab, and
 *    refuses rows 1-4 before the request is built.
 *  - `verifyWorkbook` uses one `values:batchGet` for all requested header rows
 *    plus their A5 cells, so verifying seven tabs costs two API calls.
 *
 * Nothing in this file decides what to write. The projection decision is made
 * by `_shared/projection.ts` and handed down as an instruction, so the
 * append-versus-update choice is testable without a network.
 */

import {
  FIRST_DATA_ROW,
  PROTECTED_HEADER_ROWS,
  STAGE_SCHEMAS,
} from '../../../../src/forms/registry.ts';
import { STAGES, type Stage } from '../../../../src/forms/types.ts';
import {
  quoteTabName,
  rangeForHeaderRow,
  rangeForIdColumn,
  rangeForRow,
} from '../../../../src/forms/sheetMapping.ts';
import { assertWritableRange, type StageHeaderReading } from '../headerCheck.ts';
import type { LocatedRecord } from '../projection.ts';
import {
  SHEETS_VALUE_INPUT_OPTION,
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
} from '../sheets.ts';
import { DEFAULT_READ_BUDGET, DEFAULT_WRITE_BUDGET, QuotaLedger } from '../quota.ts';
import { GoogleTokenProvider, parseServiceAccount } from './googleAuth.ts';
import { readSheetsConfig, type SheetsConfig } from './env.ts';

const API_ROOT = 'https://sheets.googleapis.com/v4/spreadsheets';

/** A read has no side effect, so an interrupted read is merely retryable. */
type CallKind = 'read' | 'write';

interface SheetsValueRange {
  readonly range?: string;
  readonly values?: readonly (readonly string[])[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfter(header: string | null): number | null {
  if (header === null) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(header);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return null;
}

export class GoogleSheetsApiAdapter implements GoogleSheetsAdapter {
  private readonly readQuota = new QuotaLedger(DEFAULT_READ_BUDGET);
  private readonly writeQuota = new QuotaLedger(DEFAULT_WRITE_BUDGET);

  constructor(
    private readonly config: SheetsConfig,
    private readonly tokens: GoogleTokenProvider,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** Build from Edge Function secrets, or refuse. Never defaults the id. */
  static fromEnvironment(fetchImpl: typeof fetch = fetch): GoogleSheetsApiAdapter {
    const config = readSheetsConfig();
    const account = parseServiceAccount(config.serviceAccountJson);
    return new GoogleSheetsApiAdapter(
      config,
      new GoogleTokenProvider(account, undefined, fetchImpl),
      fetchImpl,
    );
  }

  get serviceAccountEmail(): string {
    return this.tokens.clientEmail;
  }

  private async awaitQuota(kind: CallKind): Promise<void> {
    const ledger = kind === 'read' ? this.readQuota : this.writeQuota;
    const decision = ledger.check(Date.now());
    if (!decision.allow) {
      // Surfaced rather than slept through: a function that blocks for most of
      // a minute looks like a hang and will be killed by the platform anyway.
      throw new SheetsQuotaError(
        `Local Sheets ${kind} budget exhausted (${ledger.used} calls in the rolling window). Deferring.`,
        decision.retryAfterMs,
      );
    }
    if (decision.waitMs > 0) await sleep(decision.waitMs);
    ledger.record(Date.now());
  }

  private async call(
    kind: CallKind,
    path: string,
    init: RequestInit & { readonly operation: string },
  ): Promise<unknown> {
    await this.awaitQuota(kind);
    const token = await this.tokens.getAccessToken();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(`${API_ROOT}/${this.config.spreadsheetId}${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          ...(init.headers ?? {}),
        },
      });
    } catch (error) {
      const aborted = controller.signal.aborted;
      if (kind === 'write') {
        // THE case that produces duplicate rows if mishandled. We do not know
        // whether Google applied the write, so this is not a failure.
        throw new SheetsUnknownOutcomeError(
          aborted
            ? `Sheets ${init.operation} was aborted after ${this.config.requestTimeoutMs} ms; the outcome is unknown and must be reconciled before any retry.`
            : `Sheets ${init.operation} failed in transport; the outcome is unknown and must be reconciled before any retry.`,
          init.operation,
          error,
        );
      }
      throw new SheetsError(
        `Sheets ${init.operation} could not be completed: ${error instanceof Error ? error.message : String(error)}`,
        { retryable: true, cause: error },
      );
    } finally {
      clearTimeout(timer);
    }

    if (response.ok) {
      if (response.status === 204) return null;
      return await response.json();
    }

    const detail = await response.text().catch(() => '');
    const trimmed = detail.slice(0, 500);

    if (response.status === 401) {
      this.tokens.invalidate();
      throw new SheetsError(
        `Sheets ${init.operation} was rejected as unauthenticated. The access token has been discarded.`,
        { retryable: true, status: 401 },
      );
    }

    if (response.status === 429) {
      throw new SheetsQuotaError(
        `Sheets ${init.operation} hit the API quota. ${trimmed}`,
        parseRetryAfter(response.headers.get('retry-after')),
      );
    }

    if (response.status === 403) {
      // 403 covers both "quota" and "not shared with the service account".
      // The body distinguishes them, and only one is retryable.
      const looksLikeQuota = /quota|rate limit/i.test(trimmed);
      if (looksLikeQuota) {
        throw new SheetsQuotaError(
          `Sheets ${init.operation} was rate limited. ${trimmed}`,
          parseRetryAfter(response.headers.get('retry-after')),
        );
      }
      throw new SheetsError(
        `Sheets ${init.operation} was refused. The spreadsheet must be shared with ${this.serviceAccountEmail} as an Editor. ${trimmed}`,
        { retryable: false, status: 403 },
      );
    }

    if (response.status >= 500 || response.status === 408) {
      if (kind === 'write') {
        throw new SheetsUnknownOutcomeError(
          `Sheets ${init.operation} returned HTTP ${response.status}; the outcome is unknown and must be reconciled before any retry. ${trimmed}`,
          init.operation,
        );
      }
      throw new SheetsError(`Sheets ${init.operation} returned HTTP ${response.status}. ${trimmed}`, {
        retryable: true,
        status: response.status,
      });
    }

    throw new SheetsError(
      `Sheets ${init.operation} returned HTTP ${response.status}. ${trimmed}`,
      { retryable: false, status: response.status },
    );
  }

  private async batchGet(
    ranges: readonly string[],
    options?: { readonly formulas?: boolean },
  ): Promise<readonly SheetsValueRange[]> {
    const params = new URLSearchParams();
    for (const range of ranges) params.append('ranges', range);
    params.set('majorDimension', 'ROWS');
    params.set('valueRenderOption', options?.formulas === true ? 'FORMULA' : 'UNFORMATTED_VALUE');
    const payload = (await this.call('read', `/values:batchGet?${params.toString()}`, {
      method: 'GET',
      operation: 'values.batchGet',
    })) as { valueRanges?: readonly SheetsValueRange[] } | null;
    return payload?.valueRanges ?? [];
  }

  async verifyWorkbook(stages: readonly Stage[] = STAGES): Promise<VerifyWorkbookResult> {
    const metadata = (await this.call(
      'read',
      '?fields=properties.title,sheets.properties.title',
      { method: 'GET', operation: 'spreadsheets.get' },
    )) as {
      properties?: { title?: string };
      sheets?: readonly { properties?: { title?: string } }[];
    } | null;

    const tabTitles = (metadata?.sheets ?? [])
      .map((s) => s.properties?.title)
      .filter((t): t is string => typeof t === 'string');

    const present = stages.filter((stage) => tabTitles.includes(STAGE_SCHEMAS[stage].sheetTab));

    // Header rows and the A5 cells in ONE batchGet, rendered as FORMULA so a
    // leftover legacy sample-ID formula in A5 is visible as `=...` rather than
    // as its evaluated text (workbook-verification.md Finding 7).
    const headerRanges = present.map((stage) => rangeForHeaderRow(stage));
    const a5Ranges = present.map(
      (stage) => `${quoteTabName(STAGE_SCHEMAS[stage].sheetTab)}!A${FIRST_DATA_ROW}`,
    );
    const valueRanges =
      present.length === 0 ? [] : await this.batchGet([...headerRanges, ...a5Ranges], { formulas: true });

    const readings: StageHeaderReading[] = present.map((stage, i) => {
      const headerRange = valueRanges[i];
      const a5Range = valueRanges[present.length + i];
      const headerRow = (headerRange?.values?.[0] ?? []).map((cell) => String(cell ?? ''));
      const a5 = a5Range?.values?.[0]?.[0];
      return {
        stage,
        headerRow,
        a5Formula: a5 === undefined || a5 === null ? null : String(a5),
      };
    });

    return {
      identity: {
        spreadsheetId: this.config.spreadsheetId,
        title: metadata?.properties?.title ?? '',
      },
      reading: { tabTitles, stages: readings },
    };
  }

  /**
   * The first data row the workbook is offering as blank.
   *
   * EMPTINESS IS JUDGED ACROSS THE WHOLE ROW, NOT COLUMN A. That distinction
   * is the entire safety of this function and it is not hypothetical: the
   * project's own test double picked its row by "column A is blank", and an
   * audit demonstrated that silently overwriting a legacy hand-entered row
   * holding '2019-03-02' and 'HISTORIC PAPER RECORD — no id'. A row somebody
   * typed into without an identifier is exactly the row a naive check hands
   * over, and exactly the row that must be left alone.
   *
   * A gap in the middle is therefore reused — that is deliberate, since a
   * cleared row is blank and the workbook offers it again. A row with any
   * content anywhere is skipped, identifier or not.
   *
   * When every row the API returns has content, the answer is the row after
   * the last one. That is still an UPDATE into a cell the sheet already has
   * (these tabs carry 1000 rows), so it never inserts and never inherits the
   * header's formatting. It only runs out at the sheet's own row limit, which
   * Google reports as a plain error rather than silent truncation.
   */
  private async firstEmptyDataRow(stage: Stage): Promise<number> {
    const schema = STAGE_SCHEMAS[stage];
    const range = `${quoteTabName(schema.sheetTab)}!A${FIRST_DATA_ROW}:${schema.lastColumn}`;
    const payload = (await this.call(
      'read',
      `/values/${encodeURIComponent(range)}?majorDimension=ROWS&valueRenderOption=UNFORMATTED_VALUE`,
      { method: 'GET', operation: 'values.get(first free row)' },
    )) as SheetsValueRange | null;

    const rows = payload?.values ?? [];
    for (let i = 0; i < rows.length; i++) {
      // Sheets omits trailing empty cells, so a short row is a sparse row, not
      // a malformed one. `every` over a shorter array is still the right test.
      const occupied = (rows[i] ?? []).some((cell) => String(cell ?? '').trim() !== '');
      if (!occupied) return FIRST_DATA_ROW + i;
    }
    return FIRST_DATA_ROW + rows.length;
  }

  /** Read `A5:A` of one tab and return every row whose column A matches. */
  private async findRows(stage: Stage, sampleId: string): Promise<number[]> {
    const params = new URLSearchParams({
      majorDimension: 'COLUMNS',
      valueRenderOption: 'UNFORMATTED_VALUE',
    });
    const payload = (await this.call(
      'read',
      `/values/${encodeURIComponent(rangeForIdColumn(stage))}?${params.toString()}`,
      { method: 'GET', operation: 'values.get(column A)' },
    )) as SheetsValueRange | null;

    const column = payload?.values?.[0] ?? [];
    const matches: number[] = [];
    for (let i = 0; i < column.length; i++) {
      if (String(column[i] ?? '').trim() === sampleId) matches.push(FIRST_DATA_ROW + i);
    }
    return matches;
  }

  private async readRow(stage: Stage, rowNumber: number): Promise<LocatedRecord | null> {
    const payload = (await this.call(
      'read',
      `/values/${encodeURIComponent(rangeForRow(stage, rowNumber))}?valueRenderOption=UNFORMATTED_VALUE`,
      { method: 'GET', operation: 'values.get(row)' },
    )) as SheetsValueRange | null;
    const values = payload?.values?.[0];
    if (values === undefined) return null;
    return { rowNumber, values: values.map((cell) => String(cell ?? '')) };
  }

  async locateRecord(stage: Stage, sampleId: string): Promise<LocateResult> {
    const matches = await this.findRows(stage, sampleId);
    if (matches.length === 0) {
      return { record: null, duplicateRows: [], rowsScanned: 0 };
    }
    const first = matches[0]!;
    const record = await this.readRow(stage, first);
    return {
      record,
      duplicateRows: matches.slice(1),
      rowsScanned: matches.length,
    };
  }

  async upsertOperationalRow(request: UpsertRequest): Promise<UpsertResult> {
    const schema = STAGE_SCHEMAS[request.stage];
    if (request.row.length !== schema.columnCount) {
      throw new SheetsError(
        `Refusing a ${request.row.length}-cell write to "${schema.sheetTab}" (${schema.columnCount} columns, A:${schema.lastColumn}).`,
        { retryable: false, status: 400 },
      );
    }

    let apiCalls = 0;
    let targetRow: number;

    if (request.instruction.mode === 'update') {
      assertWritableRange(schema.sheetTab, request.instruction.rowNumber);
      targetRow = request.instruction.rowNumber;
      // `rangeForRow` refuses rows 1-4 and bounds the range at the stage's
      // last column, so this request cannot widen or climb.
      const range = rangeForRow(request.stage, targetRow);
      await this.call(
        'write',
        `/values/${encodeURIComponent(range)}?valueInputOption=${SHEETS_VALUE_INPUT_OPTION}&includeValuesInResponse=false`,
        {
          method: 'PUT',
          operation: 'values.update',
          body: JSON.stringify({ range, majorDimension: 'ROWS', values: [request.row] }),
        },
      );
      apiCalls++;
    } else {
      /**
       * FILL THE WORKBOOK'S OWN BLANK ROW. DO NOT APPEND.
       *
       * This used to call `values.append` with `insertDataOption=INSERT_ROWS`,
       * and that was wrong in a way nobody noticed until rows reached the real
       * workbook. INSERT_ROWS creates a NEW row, and Google Sheets gives an
       * inserted row the formatting of the row ABOVE it — which, for the first
       * data row, is row 4, the header. Every synced row therefore arrived
       * styled as a header: dark fill, white bold text, sitting above the pale
       * template rows it should have matched. Measured on the live workbook:
       * a tab that held 1000 rows held 1001 after a single sync.
       *
       * The formatting was the visible half. The operational half is worse.
       * Each tab is a TEMPLATE with roughly 300 pre-formatted blank data rows
       * carrying the sheet's real presentation — the grey Sample ID column,
       * borders, number formats, and the data-validation dropdowns an operator
       * uses when completing a row by hand. An inserted row inherits none of
       * it, and pushes the genuine template rows down ahead of itself. Left
       * alone this would have grown every tab by one row per sample forever,
       * stranding the template below a wall of header-styled inserts.
       *
       * So the writer now finds the first blank row the template already
       * provides and updates it in place. `values.update` never inserts, so
       * the row keeps whatever the workbook gave it.
       */
      const targetFree = await this.firstEmptyDataRow(request.stage);
      apiCalls++;
      assertWritableRange(schema.sheetTab, targetFree);
      const freeRange = rangeForRow(request.stage, targetFree);
      await this.call(
        'write',
        `/values/${encodeURIComponent(freeRange)}?valueInputOption=${SHEETS_VALUE_INPUT_OPTION}&includeValuesInResponse=false`,
        {
          method: 'PUT',
          operation: 'values.update(first free row)',
          body: JSON.stringify({ range: freeRange, majorDimension: 'ROWS', values: [request.row] }),
        },
      );
      apiCalls++;

      const reported = targetFree;
      // The reported range is a HINT, not the answer: Master Prompt §7 forbids
      // relying on "an unverified assumption that append returns exactly the
      // final canonical row". The authoritative answer comes from locating the
      // immutable identifier in column A.
      const matches = await this.findRows(request.stage, request.sampleId);
      apiCalls++;
      if (matches.length === 0) {
        throw new SheetsUnknownOutcomeError(
          `Wrote ${request.sampleId} into row ${targetFree} of "${schema.sheetTab}" but column A does not contain it; the outcome is unknown.`,
          'values.update(first free row)',
        );
      }
      targetRow = matches[0]!;
      if (reported !== null && reported !== targetRow) {
        // Not an error: a collaborator insert between the two calls explains
        // it, and the identifier is what we trust. Worth reporting upward.
        if (matches.length > 1) {
          throw new SheetsError(
            `Writing ${request.sampleId} to "${schema.sheetTab}" produced ${matches.length} rows with that identifier (${matches.join(', ')}). Refusing to continue.`,
            { retryable: false, status: 409 },
          );
        }
      }
      if (targetRow < FIRST_DATA_ROW) {
        throw new SheetsError(
          `The write placed ${request.sampleId} at row ${targetRow} of "${schema.sheetTab}", inside the protected header region.`,
          { retryable: false, status: 500 },
        );
      }
    }

    // Read-back verification. A 200 from Sheets is not evidence that the
    // intended cells are in the intended row (Master Prompt §7: "verify
    // persisted values").
    const readBack = await this.readRow(request.stage, targetRow);
    apiCalls++;

    return { rowNumber: targetRow, readBack, apiCalls };
  }

  async readForReconciliation(
    stage: Stage,
    options?: { readonly limit?: number; readonly fromRow?: number },
  ): Promise<ReconciliationRead> {
    const schema = STAGE_SCHEMAS[stage];
    const fromRow = Math.max(FIRST_DATA_ROW, options?.fromRow ?? FIRST_DATA_ROW);
    const lastRow = options?.limit === undefined ? null : fromRow + options.limit - 1;
    const range =
      `${quoteTabName(schema.sheetTab)}!A${fromRow}:${schema.lastColumn}` +
      (lastRow === null ? '' : String(lastRow));

    const payload = (await this.call(
      'read',
      `/values/${encodeURIComponent(range)}?majorDimension=ROWS&valueRenderOption=UNFORMATTED_VALUE`,
      { method: 'GET', operation: 'values.get(reconciliation)' },
    )) as SheetsValueRange | null;

    const rows: ReconciliationRow[] = [];
    const blankIdRows: number[] = [];
    const matrix = payload?.values ?? [];
    for (let i = 0; i < matrix.length; i++) {
      const cells = (matrix[i] ?? []).map((c) => String(c ?? ''));
      const rowNumber = fromRow + i;
      const id = (cells[0] ?? '').trim();
      if (id === '') {
        if (cells.some((c) => c !== '')) blankIdRows.push(rowNumber);
        continue;
      }
      rows.push({ rowNumber, sampleId: id, values: cells });
    }

    return { stage, rows, blankIdRows, apiCalls: 1 };
  }

  async healthCheck(): Promise<SheetsHealth> {
    const started = Date.now();
    try {
      const metadata = (await this.call('read', '?fields=properties.title', {
        method: 'GET',
        operation: 'spreadsheets.get(health)',
      })) as { properties?: { title?: string } } | null;
      return {
        reachable: true,
        latencyMs: Date.now() - started,
        title: metadata?.properties?.title ?? null,
        error: null,
      };
    } catch (error) {
      return {
        reachable: false,
        latencyMs: Date.now() - started,
        title: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /** Protected-row constant, re-exported so the health response can state it. */
  static readonly protectedRows = PROTECTED_HEADER_ROWS;
}
