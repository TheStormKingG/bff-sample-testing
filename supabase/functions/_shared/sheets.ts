/**
 * The `GoogleSheetsAdapter` contract.
 *
 * Master Prompt §7 fixes the five methods. Two implementations satisfy it:
 * `adapters/googleSheets.ts` (real, Sheets API v4, service account) and
 * `fakeSheets.ts` (in-memory, fault-injecting, used by the unit suite).
 *
 * The outcome taxonomy below is the important part of this file. A Google call
 * has FOUR outcomes, not two:
 *
 *   success          — the write landed and we know it
 *   retryable        — 429/500/502/503, nothing landed, try again later
 *   permanent        — 400/403/404, retrying will fail identically
 *   UNKNOWN          — timeout, aborted connection, 5xx with no body
 *
 * The fourth is the one that produces duplicate operational rows in naive
 * implementations, because "no response" gets filed as "failed" and the retry
 * appends a second row. Master Prompt §7: "A Google API timeout is an unknown
 * outcome, not proof of failure: reconcile by querying target sample ID and
 * payload state before retry." So the adapter must distinguish it, and does,
 * by throwing `SheetsUnknownOutcomeError` rather than a generic failure.
 *
 * PURE: no Deno, no npm/jsr, no I/O. Types and error classes only.
 */

import type { Stage } from '../../../src/forms/types.ts';
import type { LocatedRecord } from './projection.ts';
import type { WorkbookReading } from './headerCheck.ts';

/**
 * `RAW` — never `USER_ENTERED`.
 *
 * `USER_ENTERED` parses the cell the way a human typing it would: a leading
 * `=` becomes a formula, `1-2` becomes a date, `0005` loses its zeros, and a
 * comment field containing `+1 (592) 000-0000` becomes an arithmetic error.
 * Two of those are data corruption and one is a formula-injection vector
 * (PRD §6.1: "Prevent spreadsheet-formula injection"). `RAW` stores the string
 * exactly as given. The registry's `looksLikeFormula`/`escapeForCsvExport`
 * handle the export path, where `RAW` gives no protection.
 *
 * The literal is repeated here rather than imported from
 * `src/forms/sheetMapping.ts` because this constant is an argument in an HTTP
 * query string to Google, not an application value; the test suite asserts the
 * two agree, so they cannot drift apart silently.
 */
export const SHEETS_VALUE_INPUT_OPTION = 'RAW' as const;

export class SheetsError extends Error {
  readonly retryable: boolean;
  readonly status: number | null;
  /** Server-supplied retry hint in milliseconds, when one was given. */
  readonly retryAfterMs: number | null;

  constructor(
    message: string,
    options: { retryable: boolean; status?: number | null; retryAfterMs?: number | null; cause?: unknown },
  ) {
    super(message);
    this.name = 'SheetsError';
    this.retryable = options.retryable;
    this.status = options.status ?? null;
    this.retryAfterMs = options.retryAfterMs ?? null;
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

/**
 * The call may or may not have taken effect. NEVER treat as a failure, and
 * never retry a write after one without reconciling first.
 */
export class SheetsUnknownOutcomeError extends SheetsError {
  /** The operation that was in flight, for the reconciliation log. */
  readonly operation: string;

  constructor(message: string, operation: string, cause?: unknown) {
    super(message, { retryable: true, cause });
    this.name = 'SheetsUnknownOutcomeError';
    this.operation = operation;
  }
}

/** 429, or our own guard before we provoke one. */
export class SheetsQuotaError extends SheetsError {
  constructor(message: string, retryAfterMs: number | null, cause?: unknown) {
    super(message, { retryable: true, status: 429, retryAfterMs, cause });
    this.name = 'SheetsQuotaError';
  }
}

/** A required Edge Function secret is absent. The worker must refuse to run. */
export class SheetsConfigurationError extends Error {
  readonly missing: readonly string[];
  constructor(missing: readonly string[]) {
    super(
      `Google Sheets synchronisation is not configured: ${missing.join(', ')} ${
        missing.length === 1 ? 'is' : 'are'
      } not set. The worker refuses to run rather than fall back to a default spreadsheet.`,
    );
    this.name = 'SheetsConfigurationError';
    this.missing = missing;
  }
}

export interface WorkbookIdentity {
  /** Spreadsheet id. Carried in memory only; never logged, never returned. */
  readonly spreadsheetId: string;
  readonly title: string;
}

export interface VerifyWorkbookResult {
  readonly identity: WorkbookIdentity;
  readonly reading: WorkbookReading;
}

/** `locateRecord` result: the row, plus any duplicates found alongside it. */
export interface LocateResult {
  readonly record: LocatedRecord | null;
  /** Additional rows carrying the same id. Normally empty. */
  readonly duplicateRows: readonly number[];
  /** Rows scanned in column A, for the quota/efficiency log. */
  readonly rowsScanned: number;
}

export type UpsertInstruction =
  | { readonly mode: 'append' }
  | { readonly mode: 'update'; readonly rowNumber: number };

export interface UpsertRequest {
  readonly stage: Stage;
  readonly sampleId: string;
  /** Exactly `columnCount` cells, index 0 = column A. */
  readonly row: readonly string[];
  readonly instruction: UpsertInstruction;
}

export interface UpsertResult {
  /**
   * The row the write landed on, determined by reading back — not by trusting
   * the `updatedRange` an append reports.
   */
  readonly rowNumber: number;
  /** The cells as they read back, for `verifyPersistedRow`. */
  readonly readBack: LocatedRecord | null;
  /** Count of Sheets API calls this upsert consumed, for quota accounting. */
  readonly apiCalls: number;
}

/** One operational row as seen during reconciliation. */
export interface ReconciliationRow {
  readonly rowNumber: number;
  readonly sampleId: string;
  readonly values: readonly string[];
}

export interface ReconciliationRead {
  readonly stage: Stage;
  readonly rows: readonly ReconciliationRow[];
  /** Rows present in the data region but with a blank column A. */
  readonly blankIdRows: readonly number[];
  readonly apiCalls: number;
}

export interface SheetsHealth {
  readonly reachable: boolean;
  /** Round-trip time of the probe, in milliseconds. */
  readonly latencyMs: number | null;
  /** Workbook title, which doubles as proof the id resolves. */
  readonly title: string | null;
  readonly error: string | null;
}

export interface GoogleSheetsAdapter {
  /** Read tab titles plus row-4 headers (and A5 formulas) for verification. */
  verifyWorkbook(stages?: readonly Stage[]): Promise<VerifyWorkbookResult>;

  /** Find a sample ID in column A of one tab. Reads column A only. */
  locateRecord(stage: Stage, sampleId: string): Promise<LocateResult>;

  /** Append or update exactly one bounded operational row, then read it back. */
  upsertOperationalRow(request: UpsertRequest): Promise<UpsertResult>;

  /** Read the data region of one tab for drift detection. */
  readForReconciliation(
    stage: Stage,
    options?: { readonly limit?: number; readonly fromRow?: number },
  ): Promise<ReconciliationRead>;

  /** Cheap liveness probe. Must not write and must not read a data region. */
  healthCheck(): Promise<SheetsHealth>;
}

/** Classify a thrown value for the outbox state machine. */
export type SheetsFailureClass = 'unknown' | 'retryable' | 'permanent';

export function classifySheetsError(error: unknown): {
  readonly kind: SheetsFailureClass;
  readonly detail: string;
  readonly retryAfterMs: number | null;
} {
  if (error instanceof SheetsUnknownOutcomeError) {
    return { kind: 'unknown', detail: error.message, retryAfterMs: null };
  }
  if (error instanceof SheetsError) {
    return {
      kind: error.retryable ? 'retryable' : 'permanent',
      detail: error.message,
      retryAfterMs: error.retryAfterMs,
    };
  }
  if (error instanceof SheetsConfigurationError) {
    return { kind: 'permanent', detail: error.message, retryAfterMs: null };
  }
  // An unrecognised throw from inside a write path could be anything,
  // including a failure after the bytes reached Google. Classifying it as a
  // plain failure is what causes duplicate rows, so it is `unknown`.
  return {
    kind: 'unknown',
    detail: error instanceof Error ? error.message : String(error),
    retryAfterMs: null,
  };
}
