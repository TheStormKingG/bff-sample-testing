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
import { rowDifferences, rowsEqual, type CellDifference } from './hash.ts';

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
  | 'id_mismatch_at_row';

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
    };

/**
 * Decide the projection.
 *
 * Order of the guards is load-bearing. Duplicates and protected rows are
 * refused before anything can be written; the "already current" no-op is
 * checked before the update branch, because that no-op is precisely what makes
 * a retry after an unknown outcome safe.
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
