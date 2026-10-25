/**
 * Reconciliation: compare the ledger against the sheet and name the drift.
 *
 * Master Prompt §7: "Reconcile sample IDs, revisions and payload checksums;
 * surface drift caused by direct human sheet edits instead of silently
 * overwriting important records." PRD FR-016 requires a documented
 * reconciliation process, and NFR-001 requires reconciliation of the request
 * registry against the operational rows.
 *
 * The design decision worth stating: this module REPORTS, it does not repair.
 * Every finding below has at least one reading in which overwriting would
 * destroy real work — a quality officer who corrected a figure directly in the
 * sheet, an administrator mid-way through a manual fix, a row moved during a
 * sort. So reconciliation produces findings with a recommended action, and an
 * authorised human (or, for the unambiguous `missing_row` case, a re-queued
 * outbox event) resolves them.
 *
 * PURE: no Deno, no npm/jsr, no I/O.
 */

import { STAGE_SCHEMAS } from '../../../src/forms/registry.ts';
import type { Stage } from '../../../src/forms/types.ts';
import { rowDifferences, rowsEqual, type CellDifference } from './hash.ts';
import type { ReconciliationRow } from './sheets.ts';

/** What the ledger believes about one sample, for one stage. */
export interface LedgerRecord {
  readonly sampleUuid: string;
  readonly sampleId: string;
  readonly stage: Stage;
  readonly revision: number;
  /** The row the ledger would write right now. */
  readonly row: readonly string[];
  /** Row number of the last verified write, or null if never confirmed. */
  readonly confirmedRowNumber: number | null;
  /** True when an outbox event for this sample is still queued or retrying. */
  readonly syncPending: boolean;
}

export type DriftKind =
  /** In the ledger, confirmed synced, absent from the sheet. */
  | 'missing_row'
  /** Two or more sheet rows share one sample ID. */
  | 'duplicate_rows'
  /** Row present, cells differ from the ledger. A hand edit, most likely. */
  | 'cell_mismatch'
  /** Row moved since the last confirmed write. Harmless; mapping updated. */
  | 'row_relocated'
  /** A sheet row whose sample ID the ledger has never heard of. */
  | 'unknown_row'
  /** A sheet row with content but a blank column A. */
  | 'unidentified_row';

export type RecommendedAction =
  | 'requeue_outbox_event'
  | 'administrator_must_deduplicate'
  | 'administrator_must_review_edit'
  | 'update_row_mapping'
  | 'administrator_must_identify_row'
  | 'none';

export interface DriftFinding {
  readonly kind: DriftKind;
  readonly stage: Stage;
  readonly sampleId: string | null;
  readonly sampleUuid: string | null;
  readonly rowNumbers: readonly number[];
  readonly differences: readonly CellDifference[];
  readonly action: RecommendedAction;
  readonly message: string;
}

export interface ReconciliationSummary {
  readonly stage: Stage;
  readonly ledgerRecords: number;
  readonly sheetRows: number;
  readonly matched: number;
  readonly findings: readonly DriftFinding[];
  /** True when nothing needs a human and nothing needs re-queueing. */
  readonly clean: boolean;
}

/**
 * Compare one stage.
 *
 * `syncPending` records are deliberately exempt from `missing_row`: a sample
 * registered thirty seconds ago and not yet projected is not drift, it is the
 * queue working. Reporting it would make the reconciliation report noisy
 * enough to be ignored, which is how real drift goes unnoticed.
 */
export function reconcileStage(args: {
  readonly stage: Stage;
  readonly ledger: readonly LedgerRecord[];
  readonly sheetRows: readonly ReconciliationRow[];
  readonly blankIdRows?: readonly number[];
}): ReconciliationSummary {
  const { stage } = args;
  const schema = STAGE_SCHEMAS[stage];
  const width = schema.columnCount;
  const findings: DriftFinding[] = [];
  let matched = 0;

  const bySampleId = new Map<string, ReconciliationRow[]>();
  for (const row of args.sheetRows) {
    const list = bySampleId.get(row.sampleId) ?? [];
    list.push(row);
    bySampleId.set(row.sampleId, list);
  }

  const ledgerIds = new Set<string>();

  for (const record of args.ledger) {
    if (record.stage !== stage) continue;
    ledgerIds.add(record.sampleId);
    const rows = bySampleId.get(record.sampleId) ?? [];

    if (rows.length === 0) {
      if (record.syncPending) continue;
      findings.push({
        kind: 'missing_row',
        stage,
        sampleId: record.sampleId,
        sampleUuid: record.sampleUuid,
        rowNumbers: record.confirmedRowNumber === null ? [] : [record.confirmedRowNumber],
        differences: [],
        action: 'requeue_outbox_event',
        message:
          record.confirmedRowNumber === null
            ? `${record.sampleId} is recorded in the system but has no row in "${schema.sheetTab}" and no sync is queued. A sync event will be re-queued.`
            : `${record.sampleId} was confirmed on row ${record.confirmedRowNumber} of "${schema.sheetTab}" but is no longer present. The row was deleted by hand.`,
      });
      continue;
    }

    if (rows.length > 1) {
      findings.push({
        kind: 'duplicate_rows',
        stage,
        sampleId: record.sampleId,
        sampleUuid: record.sampleUuid,
        rowNumbers: rows.map((r) => r.rowNumber),
        differences: [],
        action: 'administrator_must_deduplicate',
        message: `${record.sampleId} appears on ${rows.length} rows of "${schema.sheetTab}" (${rows
          .map((r) => r.rowNumber)
          .join(', ')}). Synchronisation for this sample is blocked until the duplicate is removed.`,
      });
      continue;
    }

    const row = rows[0]!;

    if (!rowsEqual(record.row, row.values, width)) {
      if (record.syncPending) {
        // An update is already queued; the difference is the update itself.
        continue;
      }
      findings.push({
        kind: 'cell_mismatch',
        stage,
        sampleId: record.sampleId,
        sampleUuid: record.sampleUuid,
        rowNumbers: [row.rowNumber],
        differences: rowDifferences(record.row, row.values, width),
        action: 'administrator_must_review_edit',
        message: `Row ${row.rowNumber} of "${schema.sheetTab}" no longer matches the system record for ${record.sampleId}. The sheet was edited directly; the system will not overwrite it without review.`,
      });
      continue;
    }

    if (record.confirmedRowNumber !== null && record.confirmedRowNumber !== row.rowNumber) {
      findings.push({
        kind: 'row_relocated',
        stage,
        sampleId: record.sampleId,
        sampleUuid: record.sampleUuid,
        rowNumbers: [row.rowNumber],
        differences: [],
        action: 'update_row_mapping',
        message: `${record.sampleId} moved from row ${record.confirmedRowNumber} to row ${row.rowNumber} of "${schema.sheetTab}" (the sheet was sorted). The stored row mapping will be updated; the values agree.`,
      });
      matched++;
      continue;
    }

    matched++;
  }

  for (const [sampleId, rows] of bySampleId) {
    if (ledgerIds.has(sampleId)) continue;
    findings.push({
      kind: 'unknown_row',
      stage,
      sampleId,
      sampleUuid: null,
      rowNumbers: rows.map((r) => r.rowNumber),
      differences: [],
      action: 'administrator_must_review_edit',
      message: `"${schema.sheetTab}" row${rows.length === 1 ? '' : 's'} ${rows
        .map((r) => r.rowNumber)
        .join(', ')} carr${rows.length === 1 ? 'ies' : 'y'} identifier ${sampleId}, which the system has no record of. It was entered directly into the sheet and has no audit trail.`,
    });
  }

  for (const rowNumber of args.blankIdRows ?? []) {
    findings.push({
      kind: 'unidentified_row',
      stage,
      sampleId: null,
      sampleUuid: null,
      rowNumbers: [rowNumber],
      differences: [],
      action: 'administrator_must_identify_row',
      message: `"${schema.sheetTab}" row ${rowNumber} has data but no sample identifier in column A, so it cannot be traced to a record.`,
    });
  }

  // `row_relocated` is self-healing, so it does not make the stage unclean.
  const needsAttention = findings.some((f) => f.action !== 'update_row_mapping' && f.action !== 'none');

  return {
    stage,
    ledgerRecords: args.ledger.filter((r) => r.stage === stage).length,
    sheetRows: args.sheetRows.length,
    matched,
    findings,
    clean: !needsAttention,
  };
}

export interface ReconciliationReport {
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly stages: readonly ReconciliationSummary[];
  readonly totalFindings: number;
  readonly requeue: readonly { sampleUuid: string; stage: Stage; sampleId: string }[];
  readonly clean: boolean;
}

export function buildReport(
  stages: readonly ReconciliationSummary[],
  startedAt: string,
  finishedAt: string,
): ReconciliationReport {
  const all = stages.flatMap((s) => s.findings);
  return {
    startedAt,
    finishedAt,
    stages,
    totalFindings: all.length,
    requeue: all
      .filter((f) => f.action === 'requeue_outbox_event' && f.sampleUuid !== null)
      .map((f) => ({ sampleUuid: f.sampleUuid!, stage: f.stage, sampleId: f.sampleId ?? '' })),
    clean: stages.every((s) => s.clean),
  };
}
