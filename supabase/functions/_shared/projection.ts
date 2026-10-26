/**
 * Idempotent projection: decide what to do to the sheet, before touching it.
 *
 * Master Prompt §7: "At-least-once delivery is expected; design idempotent
 * projection, not naive append-on-every-retry. On first registration, locate
 * by immutable sample ID in column A, append precisely one record row, and
 * persist a confirmed mapping. On results update, locate the existing record
 * by stable sample ID/verified row location and update that same row; if sheet
 * was sorted, detect drift and relocate by ID before writing."
 *
 * The decision is separated from the write for one reason: it is the part that
 * has to be right, and a pure function is the only version of it that can be
 * exhaustively tested. Everything here is a function of (what the sheet
 * currently holds for this sample ID, what we intend it to hold, what mapping
 * we previously confirmed). Nothing here performs I/O, and in particular
 * nothing here trusts a cached row number: the cached value is an INPUT to the
 * drift check, never the write target.
 *
 * PURE: no Deno, no npm/jsr, no I/O.
 */

import { FIRST_DATA_ROW, STAGE_SCHEMAS } from '../../../src/forms/registry.ts';
import type { Stage } from '../../../src/forms/types.ts';
import { normaliseRow, rowDifferences, rowsEqual, type CellDifference } from './hash.ts';

/** What `locateRecord` found for one sample ID in column A. */
export interface LocatedRecord {
  readonly rowNumber: number;
  /** The row's current cells, as returned by the API (may be short). */
  readonly values: readonly string[];
}

export interface ProjectionInput {
  readonly stage: Stage;
  readonly sampleId: string;
  /** The row we intend the sheet to hold, from `toSheetRow`. */
  readonly intendedRow: readonly string[];
  /** The single row currently carrying this sample ID, or null if absent. */
  readonly located: LocatedRecord | null;
  /**
   * Every OTHER row carrying the same sample ID. Non-empty means the sheet has
   * duplicates, which is a human-edit or past-bug condition, never ours to
   * resolve by overwriting one of them.
   */
  readonly duplicateRows?: readonly number[];
  /**
   * The row number last CONFIRMED by a successful verified write. Used only to
   * detect that the row has moved; never used as a write target.
   */
  readonly confirmedRowNumber?: number | null;
  /**
   * EVERY row this application has projected for this sample at this stage,
   * for an outbox event that was CLAIMED at least once — plus the row this
   * event intends to write. In other words, the complete set of contents the
   * app could have put in that row. Supplied from
   * `sheet_sync_outbox.projected_row`; see `SyncStore.projectedRowsFor`.
   *
   * This is the ONLY input that distinguishes a row the app owns from a row a
   * human has typed into, which is why it is REQUIRED rather than optional: an
   * optional baseline fails toward the permissive branch, and a caller that
   * forgot to supply it would silently restore the overwrite this guard
   * exists to prevent.
   *
   * Why the whole set and not just "the last row we confirmed":
   *
   *  - A write can land and then time out. The event is then unconfirmed while
   *    its row IS in the sheet, and the next event for the same sample would
   *    see content that no confirmed baseline explains. `rpc_claim_outbox_batch`
   *    orders by `next_retry_at`, and a freshly enqueued revision 2 sorts ahead
   *    of a revision 1 that is waiting out a backoff, so this ordering is
   *    reachable rather than theoretical.
   *  - "Claimed at least once" (`last_attempt_at is not null`) is the precise
   *    form of "the app could have written this". Claiming happens before the
   *    write, so it also covers a worker that died between the write and its
   *    bookkeeping. `attempt_count > 0` would NOT cover that: the counter is
   *    incremented when the outcome is recorded, which is the step that never
   *    ran.
   *
   * A hand edit that happens to reproduce one of the app's own projections
   * exactly is admitted, and loses nothing: the cells already hold values the
   * app wrote or is about to write.
   */
  readonly priorProjections: readonly (readonly string[])[];
  /**
   * The row the app last CONFIRMED for this sample — written and read back —
   * or null if it has never confirmed one. `sheet_sync_outbox.projected_row`
   * of the confirmed event, the same row `confirmedRowNumber` refers to.
   *
   * MESSAGE ONLY. It names the cells a human changed, by diffing what we left
   * in the sheet against what is there now; diffing against `intendedRow`
   * instead would list the update's own intended changes alongside the human's
   * and so point an administrator at the wrong cells. The guard's VERDICT never
   * consults it, so a caller that omits it degrades the wording and cannot
   * open the gate.
   */
  readonly lastConfirmedRow?: readonly string[] | null;
}

export type ProjectionBlockReason =
  /** Several rows share the sample ID. An administrator must de-duplicate. */
  | 'duplicate_rows'
  /** A confirmed row has vanished: somebody deleted an operational record. */
  | 'confirmed_row_missing'
  /** The located row sits in rows 1-4, which are protected. */
  | 'row_in_protected_region'
  /** The intended row has the wrong width for the stage. */
  | 'row_width_mismatch'
  /** Column A of the located row is not the sample ID we searched for. */
  | 'id_mismatch_at_row'
  /**
   * The app wrote and verified this row, and its contents have changed since.
   * Somebody edited the sheet by hand. Reconciliation calls the same condition
   * `cell_mismatch` -> `administrator_must_review_edit` (see `reconcile.ts`);
   * this is the enforcing half of that finding.
   */
  | 'row_edited_in_sheet'
  /**
   * A row already carries this sample ID and the app has never confirmed a
   * write for the sample. The row was entered by hand, or two collections
   * minted the same identifier (`allocate_sample_id` restarts at 01 per date,
   * so a back-dated collection can collide). Either way the content is not
   * ours to replace.
   */
  | 'row_not_authored_by_app';

export type ProjectionDecision =
  | {
      readonly action: 'append';
      readonly reason: 'no_existing_row';
      readonly width: number;
    }
  | {
      readonly action: 'update';
      readonly rowNumber: number;
      readonly reason: 'row_located' | 'relocated_after_drift';
      readonly width: number;
      readonly differences: readonly CellDifference[];
    }
  | {
      readonly action: 'noop';
      readonly rowNumber: number;
      readonly reason: 'already_current';
      readonly width: number;
    }
  | {
      readonly action: 'blocked';
      readonly reason: ProjectionBlockReason;
      readonly message: string;
      /**
       * The cells that differ, when the block was decided by comparing
       * content. Stored in `sheet_sync_outbox.last_decision`, so an
       * administrator can see exactly which cells were preserved.
       */
      readonly differences?: readonly CellDifference[];
    };

/**
 * Describe a differing cell the way an administrator reads the workbook:
 * by column letter and row-4 header, with the value that is actually there.
 */
function describeCell(stage: Stage, difference: CellDifference): string {
  const field = STAGE_SCHEMAS[stage].fields[difference.index];
  const where =
    field === undefined
      ? `column index ${difference.index}`
      : `column ${field.columnLetter} "${field.sheetHeader}"`;
  const found =
    difference.actual === '' ? 'is now empty' : `reads ${JSON.stringify(trim(difference.actual))}`;
  return `${where} ${found}`;
}

/** Keep a quoted cell value short enough for an error column and a log line. */
function trim(value: string): string {
  return value.length <= 60 ? value : `${value.slice(0, 57)}...`;
}

/** `column K "Comments" reads "..." and 2 other cells` */
function describeCells(stage: Stage, differences: readonly CellDifference[]): string {
  const named = differences.slice(0, 2).map((d) => describeCell(stage, d));
  const rest = differences.length - named.length;
  const list = named.join('; ');
  return rest <= 0 ? list : `${list}; and ${rest} other cell${rest === 1 ? '' : 's'}`;
}

/** The non-empty cells of a row, for a row this system did not write. */
function occupiedCells(stage: Stage, cells: readonly string[], width: number): string {
  const present: CellDifference[] = [];
  const row = normaliseRow(cells, width);
  for (let i = 0; i < width; i++) {
    if (row[i] !== '') present.push({ index: i, expected: '', actual: row[i]! });
  }
  return present.length === 0 ? 'no values at all' : describeCells(stage, present);
}

/**
 * Decide the projection.
 *
 * Order of the guards is load-bearing. Duplicates and protected rows are
 * refused before anything can be written; the "already current" no-op is
 * checked before the update branch, because that no-op is precisely what makes
 * a retry after an unknown outcome safe. The hand-edit guard sits immediately
 * after that no-op, so by the time it runs the only remaining action is an
 * overwrite of content that is NOT what we are trying to write.
 */
export function decideProjection(input: ProjectionInput): ProjectionDecision {
  const schema = STAGE_SCHEMAS[input.stage];
  const width = schema.columnCount;

  if (input.intendedRow.length !== width) {
    return {
      action: 'blocked',
      reason: 'row_width_mismatch',
      message: `Refusing to write ${input.intendedRow.length} cells to "${schema.sheetTab}", which is ${width} columns wide (A:${schema.lastColumn}).`,
    };
  }

  const duplicates = input.duplicateRows ?? [];
  if (duplicates.length > 0) {
    const all = input.located === null ? duplicates : [input.located.rowNumber, ...duplicates];
    return {
      action: 'blocked',
      reason: 'duplicate_rows',
      message: `Sample ${input.sampleId} appears on ${all.length} rows of "${schema.sheetTab}" (${all.join(', ')}). Refusing to write: an administrator must remove the duplicate before synchronisation resumes.`,
    };
  }

  const confirmed = input.confirmedRowNumber ?? null;

  if (input.located === null) {
    if (confirmed !== null) {
      // We verified this row existed. Appending now would create a second
      // operational record for a sample that somebody deleted by hand, and
      // would hide the deletion. Surface it instead (Master Prompt §7:
      // "surface drift caused by direct human sheet edits instead of silently
      // overwriting important records").
      return {
        action: 'blocked',
        reason: 'confirmed_row_missing',
        message: `Sample ${input.sampleId} was confirmed on row ${confirmed} of "${schema.sheetTab}" but column A no longer contains it. The row was deleted or the identifier was edited by hand. Refusing to re-append.`,
      };
    }
    return { action: 'append', reason: 'no_existing_row', width };
  }

  if (input.located.rowNumber < FIRST_DATA_ROW) {
    return {
      action: 'blocked',
      reason: 'row_in_protected_region',
      message: `Sample ${input.sampleId} was located at row ${input.located.rowNumber} of "${schema.sheetTab}", inside the protected header region (rows 1-${FIRST_DATA_ROW - 1}). Refusing to write.`,
    };
  }

  const idCell = input.located.values[0] ?? '';
  if (idCell.trim() !== input.sampleId) {
    return {
      action: 'blocked',
      reason: 'id_mismatch_at_row',
      message: `Row ${input.located.rowNumber} of "${schema.sheetTab}" was reported as holding ${input.sampleId} but column A reads ${JSON.stringify(idCell)}. Refusing to write to a row whose identity cannot be confirmed.`,
    };
  }

  if (rowsEqual(input.intendedRow, input.located.values, width)) {
    return {
      action: 'noop',
      rowNumber: input.located.rowNumber,
      reason: 'already_current',
      width,
    };
  }

  // THE HAND-EDIT GUARD.
  //
  // Everything below this point would REWRITE EVERY COLUMN of the located row.
  // So before doing that, establish that the row's current contents are
  // something this application put there. The comparison is against the set of
  // rows the app has projected for this sample, not against the row we are
  // about to write: a legitimate update differs from the sheet by exactly the
  // cells it is changing, so comparing against the intended row cannot
  // distinguish "the app is updating this" from "a human typed this".
  //
  // NORMALISATION is `rowsEqual`, the same function `verifyPersistedRow` has
  // always run on the read-back immediately after every write. If it were too
  // strict for real Sheets round-trips — trailing cells dropped on read, a
  // number re-rendered — no write would ever have verified and every outcome
  // would be `unknown`. Reusing it here therefore adds no new tolerance
  // question: this guard is exactly as strict as the check that already gates
  // every confirmation, and no stricter.
  //
  // Master Prompt §7: "surface drift caused by direct human sheet edits instead
  // of silently overwriting important records."
  const inSheet = input.located.values;
  if (!input.priorProjections.some((candidate) => rowsEqual(candidate, inSheet, width))) {
    const lastWritten = input.lastConfirmedRow ?? null;

    if (lastWritten === null) {
      // Nothing confirmed, so there is no "before" to diff against: the whole
      // row is content this system did not write. Name the cells that carry
      // something, so an administrator can recognise the row in the workbook.
      const occupied = occupiedCells(input.stage, inSheet, width);
      return {
        action: 'blocked',
        reason: 'row_not_authored_by_app',
        message: `Row ${input.located.rowNumber} of "${schema.sheetTab}" already carries ${input.sampleId}, but this system has never written a row for that sample. The row holds ${occupied}. Somebody entered it in the sheet directly, or two collections were given the same identifier. It has been left exactly as it is, and the record in this system is unaffected. TO RESOLVE: decide which collection the sheet row belongs to. If it is a different sample, give it its own identifier in the sheet. If it is this one, clear the row. Then retry this item — RETRYING WILL REPLACE THAT ROW with this system's version of the record.`,
        differences: rowDifferences(input.intendedRow, inSheet, width),
      };
    }

    /**
     * THE MESSAGE MUST DESCRIBE A REMEDY THAT EXISTS.
     *
     * The first version of this said an administrator "must review the edit
     * before the update can be released", and the sibling branch said
     * "before synchronisation resumes". Neither is implemented: there is no
     * release action and no resume action. The only tool an administrator
     * actually has is retrying the dead-lettered item — which overwrites the
     * row, destroying exactly the hand-typed values this guard just saved.
     *
     * So a message that sends somebody looking for a Release button leaves
     * them with one real option and no warning about what it does. The
     * wording below names the decision, the two ways to make the record and
     * the sheet agree, and states plainly what retrying will do. A proper
     * review-and-accept action is worth building; until it exists the message
     * may not imply one.
     */
    const edits = rowDifferences(lastWritten, inSheet, width);
    const where = edits.length === 0 ? 'its contents changed' : describeCells(input.stage, edits);
    return {
      action: 'blocked',
      reason: 'row_edited_in_sheet',
      message: `Somebody edited row ${input.located.rowNumber} of "${schema.sheetTab}" directly in Google Sheets after this system last wrote it: ${where}. Those hand-typed values have been left untouched on purpose and nothing was overwritten. TO RESOLVE for ${input.sampleId}: decide which value is right. If the hand-typed one is, enter it in this system so the record carries it too. If this system's value is, undo the edit in the sheet. Either way, retry this item afterwards — RETRYING WILL REPLACE THAT ROW with this system's version, so resolve it first or the hand-typed values are lost.`,
      differences: edits,
    };
  }

  const differences = rowDifferences(input.intendedRow, input.located.values, width);

  return {
    action: 'update',
    rowNumber: input.located.rowNumber,
    // Relocation is reported separately so the audit trail records that the
    // sheet was re-sorted rather than that the app changed its mind.
    reason: confirmed !== null && confirmed !== input.located.rowNumber
      ? 'relocated_after_drift'
      : 'row_located',
    width,
    differences,
  };
}

/**
 * Verify a write after the fact by re-reading the row.
 *
 * Master Prompt §7 requires "verify persisted values". A write that returned
 * 200 but landed in the wrong row — because `values.append` chose a different
 * row than the one it reported, or because a collaborator inserted a row
 * mid-flight — is indistinguishable from success at the API level. Only a
 * read-back comparison distinguishes them.
 */
export type WriteVerification =
  | { readonly ok: true; readonly rowNumber: number }
  | {
      readonly ok: false;
      readonly reason: 'row_absent' | 'id_mismatch' | 'values_differ' | 'row_moved';
      readonly message: string;
      readonly differences?: readonly CellDifference[];
    };

export function verifyPersistedRow(args: {
  readonly stage: Stage;
  readonly sampleId: string;
  readonly intendedRow: readonly string[];
  readonly expectedRowNumber: number;
  readonly readBack: LocatedRecord | null;
}): WriteVerification {
  const schema = STAGE_SCHEMAS[args.stage];
  const width = schema.columnCount;

  if (args.readBack === null) {
    return {
      ok: false,
      reason: 'row_absent',
      message: `Wrote ${args.sampleId} to "${schema.sheetTab}" but the row could not be read back. Treating the write as unconfirmed.`,
    };
  }

  if (args.readBack.rowNumber !== args.expectedRowNumber) {
    return {
      ok: false,
      reason: 'row_moved',
      message: `Wrote ${args.sampleId} at row ${args.expectedRowNumber} of "${schema.sheetTab}" but it now reads back at row ${args.readBack.rowNumber}.`,
    };
  }

  const idCell = args.readBack.values[0] ?? '';
  if (idCell.trim() !== args.sampleId) {
    return {
      ok: false,
      reason: 'id_mismatch',
      message: `Row ${args.expectedRowNumber} of "${schema.sheetTab}" reads back with identifier ${JSON.stringify(idCell)} instead of ${args.sampleId}.`,
    };
  }

  if (!rowsEqual(args.intendedRow, args.readBack.values, width)) {
    return {
      ok: false,
      reason: 'values_differ',
      message: `Row ${args.expectedRowNumber} of "${schema.sheetTab}" does not match the values written.`,
      differences: rowDifferences(args.intendedRow, args.readBack.values, width),
    };
  }

  return { ok: true, rowNumber: args.expectedRowNumber };
}
