/**
 * Workbook schema verification — the gate in front of every write.
 *
 * Master Prompt §7: "Check headers/schema before first write and
 * periodically." Master Prompt §10: "Live workbook schema mismatch blocks
 * writer." PRD §4.3 requires validating all nine sheet titles and every row-4
 * header before enabling writes.
 *
 * Fails CLOSED. Anything unexpected — a renamed tab, a changed header, an
 * inserted column, a formula still sitting in A5 from the legacy ID mechanism
 * (workbook-verification.md Finding 7) — stops the writer rather than
 * degrading to a best-effort write. The column that moved is the column the
 * next row would be written into, so a "probably fine" here is a silently
 * corrupted quality record.
 *
 * PURE: no Deno, no npm/jsr, no I/O. The caller supplies what it read.
 */

import {
  REFERENCE_TABS,
  STAGE_SCHEMAS,
  FIRST_DATA_ROW,
} from '../../../src/forms/registry.ts';
import { STAGES, type Stage } from '../../../src/forms/types.ts';
import { diffHeaders, type HeaderMismatch } from '../../../src/forms/sheetMapping.ts';

/** What the caller read from the workbook, per stage. */
export interface StageHeaderReading {
  readonly stage: Stage;
  /** Row-4 cells, A through the stage's last column. */
  readonly headerRow: readonly string[];
  /**
   * The literal content of A5 as the API reports it with
   * `valueRenderOption=FORMULA`. A leading `=` means the legacy
   * self-filling-ID formula is still present and would fight the server for
   * column A.
   */
  readonly a5Formula?: string | null;
}

export interface WorkbookReading {
  /** Every tab title present in the workbook. */
  readonly tabTitles: readonly string[];
  readonly stages: readonly StageHeaderReading[];
}

export type SchemaProblemKind =
  | 'missing_tab'
  | 'header_mismatch'
  | 'legacy_id_formula_present'
  | 'stage_not_read'
  | 'reference_tab_missing';

export interface SchemaProblem {
  readonly kind: SchemaProblemKind;
  readonly stage?: Stage;
  readonly tab?: string;
  readonly columnLetter?: string;
  readonly expected?: string;
  readonly actual?: string;
  readonly message: string;
}

export interface SchemaVerification {
  /** True only when every check passed. Writing is permitted only then. */
  readonly ok: boolean;
  readonly problems: readonly SchemaProblem[];
  /** Stages verified clean. A partial read can still clear SOME stages. */
  readonly verifiedStages: readonly Stage[];
  /** Total columns compared, for the admin screen's evidence line. */
  readonly columnsCompared: number;
}

function mismatchProblem(m: HeaderMismatch): SchemaProblem {
  const tab = STAGE_SCHEMAS[m.stage].sheetTab;
  return {
    kind: 'header_mismatch',
    stage: m.stage,
    tab,
    columnLetter: m.columnLetter,
    expected: m.expected,
    actual: m.actual,
    message: `"${tab}" column ${m.columnLetter} header reads ${JSON.stringify(m.actual)} but the system expects ${JSON.stringify(m.expected)}.`,
  };
}

/**
 * Verify the workbook against the registry.
 *
 * `requiredStages` lets a worker verify only the tabs it is about to write,
 * which keeps the periodic re-check inside the Sheets read quota, while the
 * admin screen and the cutover checklist pass all seven.
 */
export function verifySchema(
  reading: WorkbookReading,
  requiredStages: readonly Stage[] = STAGES,
): SchemaVerification {
  const problems: SchemaProblem[] = [];
  const verifiedStages: Stage[] = [];
  let columnsCompared = 0;

  const titles = new Set(reading.tabTitles);

  // The two reference tabs must still be there. Their absence means this is
  // not the workbook we verified, even if the seven operational tabs match.
  for (const tab of REFERENCE_TABS) {
    if (!titles.has(tab)) {
      problems.push({
        kind: 'reference_tab_missing',
        tab,
        message: `The "${tab}" tab is missing. This workbook is not the verified operational record.`,
      });
    }
  }

  const byStage = new Map<Stage, StageHeaderReading>();
  for (const s of reading.stages) byStage.set(s.stage, s);

  for (const stage of requiredStages) {
    const schema = STAGE_SCHEMAS[stage];

    if (!titles.has(schema.sheetTab)) {
      problems.push({
        kind: 'missing_tab',
        stage,
        tab: schema.sheetTab,
        message: `The "${schema.sheetTab}" tab is missing from the workbook.`,
      });
      continue;
    }

    const read = byStage.get(stage);
    if (read === undefined) {
      problems.push({
        kind: 'stage_not_read',
        stage,
        tab: schema.sheetTab,
        message: `No header row was read for "${schema.sheetTab}", so it cannot be cleared for writing.`,
      });
      continue;
    }

    const mismatches = diffHeaders(stage, read.headerRow);
    columnsCompared += schema.columnCount;

    if (read.a5Formula != null && read.a5Formula.trimStart().startsWith('=')) {
      problems.push({
        kind: 'legacy_id_formula_present',
        stage,
        tab: schema.sheetTab,
        actual: read.a5Formula,
        message: `Cell A${FIRST_DATA_ROW} of "${schema.sheetTab}" still contains the legacy self-filling sample-ID formula. It must be cleared before the system writes identifiers to column A (cutover step C-04).`,
      });
    }

    if (mismatches.length === 0) {
      verifiedStages.push(stage);
    } else {
      for (const m of mismatches) problems.push(mismatchProblem(m));
    }
  }

  // A stage with a formula problem is not clean even though its headers match.
  const blockedByFormula = new Set(
    problems.filter((p) => p.kind === 'legacy_id_formula_present').map((p) => p.stage),
  );
  const clean = verifiedStages.filter((s) => !blockedByFormula.has(s));

  return {
    ok: problems.length === 0,
    problems,
    verifiedStages: clean,
    columnsCompared,
  };
}

/** Is this tab one the writer must never touch? */
export function isWritableTab(tab: string): boolean {
  if ((REFERENCE_TABS as readonly string[]).includes(tab)) return false;
  return STAGES.some((s) => STAGE_SCHEMAS[s].sheetTab === tab);
}

/**
 * Guard every outgoing range. Belt and braces over `rangeForRow`, which
 * already refuses rows 1-4: this also refuses a range addressed at a tab the
 * writer has no business in, which `rangeForRow` cannot see because it only
 * ever builds operational ranges.
 */
export function assertWritableRange(tab: string, firstRow: number): void {
  if (!isWritableTab(tab)) {
    throw new Error(
      `Refusing to write to "${tab}". Only the seven operational tabs are writable; ${REFERENCE_TABS.join(' and ')} are preserved read-only.`,
    );
  }
  if (!Number.isInteger(firstRow) || firstRow < FIRST_DATA_ROW) {
    throw new Error(
      `Refusing to write to "${tab}" row ${firstRow}: rows 1-${FIRST_DATA_ROW - 1} are protected (titles, merged section bands and the header row).`,
    );
  }
}

// ---------------------------------------------------------------------------
// Periodic re-verification
// ---------------------------------------------------------------------------

/** Verify at most this often, so a busy queue does not re-read every pass. */
export const DEFAULT_VERIFY_INTERVAL_MS = 15 * 60_000;

export interface VerificationState {
  /** ISO instant of the last successful verification, or null if never. */
  readonly lastVerifiedAt: string | null;
  /** Stages cleared by that verification. */
  readonly verifiedStages: readonly Stage[];
  /** True once a mismatch was seen. Latches until an administrator clears it. */
  readonly schemaDrifted: boolean;
}

/**
 * Must the worker verify before writing these stages?
 *
 * Three reasons to say yes, and `schemaDrifted` is deliberately not one of
 * them: once drift has been recorded the workbook is fenced off entirely and
 * the answer is not "verify again" but "do not write". The caller checks that
 * first.
 */
export function needsVerification(
  state: VerificationState,
  stages: readonly Stage[],
  now: Date,
  intervalMs: number = DEFAULT_VERIFY_INTERVAL_MS,
): boolean {
  if (state.lastVerifiedAt === null) return true;
  const cleared = new Set(state.verifiedStages);
  if (stages.some((s) => !cleared.has(s))) return true;
  const last = Date.parse(state.lastVerifiedAt);
  if (Number.isNaN(last)) return true;
  return now.getTime() - last >= intervalMs;
}
