/**
 * Making the workbook's sieve headings follow the lab's sieve table.
 *
 * ===========================================================================
 * THE GAP THIS CLOSES
 * ===========================================================================
 * An administrator may re-designate a sieve — the lab re-calibrates, or puts
 * the nearest sieve it has into a position. Until now that designation
 * reached three of the four places it belongs: the arithmetic, the form, and
 * the settings screen. It did NOT reach the workbook, whose row-4 headings
 * are the first thing a reader of the quality record sees. A stack
 * re-designated to ABNT 18 left a column headed `ABNT 16 empty sieve (g)`
 * standing over figures weighed on an ABNT 18 sieve, and the only remedy was
 * to retype it by hand in the sheet and hope nobody forgot.
 *
 * So the headings follow. `expectedHeaders(stage, series)` derives the
 * contract from the stored table, and this module is what makes the live
 * sheet match it.
 *
 * ===========================================================================
 * WHY REPAIR RATHER THAN A SECOND WRITE PATH
 * ===========================================================================
 * The obvious design is to have the settings RPC push the new headings into
 * the sheet. It cannot: Postgres cannot reach Google, so the push would have
 * to be a second step, and a second step can fail. Whichever order it runs
 * in, a failure between the two leaves the stored table and the live heading
 * disagreeing — and the system FAILS CLOSED on exactly that disagreement, so
 * a half-finished rename would fence the whole workbook off and stop every
 * sync in the deployment until somebody edited a spreadsheet by hand.
 *
 * Repair has no such window. The stored table is the single commit; the
 * sheet catches up on the next pass of a worker that was already reading
 * row 4 before every write. If the worker is down, rows queue and nothing is
 * written against a stale heading — the existing safety property, unchanged.
 *
 * ===========================================================================
 * WHAT IT MAY TOUCH, WHICH IS ALMOST NOTHING
 * ===========================================================================
 * Only cells in row 4, only on the seven operational tabs, and only in
 * columns whose heading is DERIVED from the sieve table — the fourteen sieve
 * mass columns of the four tabs that carry a sieve test. Every other header
 * mismatch is left exactly as it was and still fences the workbook off.
 *
 * That is the whole safety argument, and it is structural: `planRepair` asks
 * `seriesDerivedColumns(stage)` which columns qualify and discards every
 * mismatch outside the set, so a bug here can at worst fail to repair. It
 * cannot widen into the data region, because `assertHeaderRepairCells`
 * refuses any row but 4 and any column the set does not contain.
 *
 * It is also not a vote on whether the heading SHOULD change. A heading in
 * this set has exactly one correct value — the one the stored table implies —
 * and the stored table is only ever written by `rpc_set_sieve_series`, which
 * takes `user.manage` and audits the before and after. A hand edit in the
 * sheet is therefore not an opinion to be weighed; it is a divergence from an
 * audited decision, and putting it back is the correct response.
 *
 * PURE, apart from the adapter call in `repairSieveHeaders`: the planning is
 * a function of what was read, and `tests/headerRepair.test.ts` drives it.
 */

import {
  diffHeaders,
  seriesDerivedColumns,
  type HeaderMismatch,
} from '../../../src/forms/sheetMapping.ts';
import { STAGE_SCHEMAS, PROTECTED_HEADER_ROWS } from '../../../src/forms/registry.ts';
import type { Stage } from '../../../src/forms/types.ts';
import type { SieveSeriesDocument } from '../../../src/lib/sieveSeries.ts';
import { isWritableTab, type WorkbookReading } from './headerCheck.ts';
import type { GoogleSheetsAdapter } from './sheets.ts';

/** The one row this module is ever allowed to address. */
export const HEADER_ROW = PROTECTED_HEADER_ROWS;

export interface HeaderCell {
  readonly columnLetter: string;
  /** The heading the stored sieve table implies for this column. */
  readonly value: string;
  /** What the sheet says now, for the audit record. */
  readonly was: string;
}

export interface StageHeaderRepair {
  readonly stage: Stage;
  readonly tab: string;
  readonly cells: readonly HeaderCell[];
}

/**
 * Which heading cells, if any, the stored sieve table says are now wrong.
 *
 * Mismatches outside the derived set are not returned and not reported here:
 * they are not this module's business and `verifySchema` will raise them as
 * the drift they are.
 */
export function planRepair(
  reading: WorkbookReading,
  series: SieveSeriesDocument | null,
  stages: readonly Stage[],
): readonly StageHeaderRepair[] {
  if (series === null) return [];
  const titles = new Set(reading.tabTitles);
  const byStage = new Map(reading.stages.map((s) => [s.stage, s] as const));
  const out: StageHeaderRepair[] = [];

  for (const stage of stages) {
    const schema = STAGE_SCHEMAS[stage];
    if (!titles.has(schema.sheetTab)) continue;
    const read = byStage.get(stage);
    if (read === undefined) continue;

    const repairable = seriesDerivedColumns(stage);
    if (repairable.size === 0) continue;

    const cells = diffHeaders(stage, read.headerRow, series)
      .filter((m: HeaderMismatch) => repairable.has(m.columnLetter))
      .map((m) => ({ columnLetter: m.columnLetter, value: m.expected, was: m.actual }));

    if (cells.length > 0) out.push({ stage, tab: schema.sheetTab, cells });
  }
  return out;
}

/**
 * The guard, stated separately from the plan that satisfies it.
 *
 * `planRepair` already filters to the derived set, so in the normal path this
 * can never fire. It exists because the plan and the write are separated by
 * an adapter boundary, and the thing on the far side of that boundary is a
 * live quality record: a future caller that builds cells some other way hits
 * a refusal here rather than a `values.update` on a data row.
 */
export function assertHeaderRepairCells(repair: StageHeaderRepair): void {
  if (!isWritableTab(repair.tab)) {
    throw new Error(`Refusing to rewrite headings on "${repair.tab}": not an operational tab.`);
  }
  const allowed = seriesDerivedColumns(repair.stage);
  for (const cell of repair.cells) {
    if (!allowed.has(cell.columnLetter)) {
      throw new Error(
        `Refusing to rewrite "${repair.tab}" column ${cell.columnLetter}: its heading is not ` +
          `derived from the sieve table, so no setting can make it wrong and nothing may ` +
          `overwrite it automatically.`,
      );
    }
  }
}

/**
 * The reading as it will be once the repair has landed.
 *
 * The caller verifies against THIS rather than re-reading: a second read
 * costs another Sheets call inside the same quota the verify was written to
 * stay within, and the write it would be checking has already been confirmed
 * by the API. If the write is refused, nothing is patched and verification
 * sees the stale heading and fences the workbook off, which is the correct
 * outcome.
 */
export function applyRepair<T extends WorkbookReading>(
  reading: T,
  repairs: readonly StageHeaderRepair[],
): T {
  if (repairs.length === 0) return reading;
  const byStage = new Map(repairs.map((r) => [r.stage, r] as const));
  return {
    // Spread, so a caller holding a richer reading (the adapter's, which also
    // carries the workbook identity) keeps every field it came with.
    ...reading,
    stages: reading.stages.map((read) => {
      const repair = byStage.get(read.stage);
      if (repair === undefined) return read;
      const row = [...read.headerRow];
      const fields = STAGE_SCHEMAS[read.stage].fields;
      for (const cell of repair.cells) {
        const index = fields.findIndex((f) => f.columnLetter === cell.columnLetter);
        if (index >= 0) row[index] = cell.value;
      }
      return { ...read, headerRow: row };
    }),
  };
}

export interface RepairOutcome<T extends WorkbookReading = WorkbookReading> {
  readonly reading: T;
  readonly repaired: readonly StageHeaderRepair[];
  /** Tabs whose repair was attempted and refused, left for `verifySchema`. */
  readonly failed: readonly { readonly tab: string; readonly reason: string }[];
}

/**
 * Plan, write, and hand back the reading the caller should verify.
 *
 * A failure to write one tab is NOT propagated. The point of the repair is to
 * let the workbook catch up with a setting; if it cannot, the pre-existing
 * behaviour is the right one — the heading still disagrees, verification
 * still fails, and the workbook is still fenced off rather than written to.
 * Throwing here would instead turn a cosmetic rename into an outage of the
 * health screen that is meant to explain it.
 */
export async function repairSieveHeaders<T extends WorkbookReading>(
  adapter: GoogleSheetsAdapter,
  reading: T,
  series: SieveSeriesDocument | null,
  stages: readonly Stage[],
  log: (message: string, detail?: unknown) => void = () => {},
): Promise<RepairOutcome<T>> {
  const plan = planRepair(reading, series, stages);
  if (plan.length === 0) return { reading, repaired: [], failed: [] };

  const repaired: StageHeaderRepair[] = [];
  const failed: { tab: string; reason: string }[] = [];

  for (const repair of plan) {
    try {
      assertHeaderRepairCells(repair);
      await adapter.writeHeaderCells(repair.tab, repair.cells);
      repaired.push(repair);
      log('sieve headings rewritten', {
        tab: repair.tab,
        cells: repair.cells.map((c) => `${c.columnLetter}: ${c.was} -> ${c.value}`),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      failed.push({ tab: repair.tab, reason });
      log('sieve headings could not be rewritten', { tab: repair.tab, reason });
    }
  }

  return { reading: applyRepair(reading, repaired), repaired, failed };
}
