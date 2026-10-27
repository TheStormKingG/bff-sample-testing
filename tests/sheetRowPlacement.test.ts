/**
 * A synced row fills a blank row the workbook already has. It never inserts.
 *
 * WHY THIS EXISTS. The writer used to call `values.append` with
 * `insertDataOption=INSERT_ROWS`. That creates a NEW row, and Google Sheets
 * gives an inserted row the formatting of the row ABOVE it — which, for the
 * first data row, is row 4, the header. Every synced row therefore arrived in
 * the live workbook styled as a header: dark fill, white bold text, sitting
 * above the pale template rows it was meant to match.
 *
 * Measured on the live workbook before the fix: a tab that held 1000 rows held
 * 1001 after a single sample synced, while the other operational tabs still
 * held 1000. One append, one extra row — the insert was real, not inferred.
 *
 * The formatting was the visible half and the cheaper half. Each tab is a
 * TEMPLATE carrying roughly 300 pre-formatted blank data rows: the grey Sample
 * ID column, borders, number formats, and the data-validation dropdowns an
 * operator uses when completing a row by hand. An inserted row inherits none
 * of that, and pushes the genuine template rows down ahead of itself. Left
 * alone it would have grown every tab by a row per sample forever.
 *
 * WHY NO TEST CAUGHT IT. The double did not model production on this axis. It
 * picked the first row whose COLUMN A was blank and replaced it, while
 * production inserted. The two differed on exactly the behaviour under test,
 * so a green suite was evidence about neither. The double now matches, and the
 * assertions below are the ones that would have failed.
 */

import { describe, expect, it } from 'vitest';

import { FIRST_DATA_ROW, STAGE_SCHEMAS } from '@/forms/registry';
import type { Stage } from '@/forms/types';
import { FakeWorkbook } from '../supabase/functions/_shared/fakeSheets.ts';

const STAGE: Stage = 'pellets';

/**
 * Give the double a template, the way the real workbook has one.
 *
 * `FakeWorkbook` starts with only the four protected header rows and grows as
 * rows are written, whereas each live tab ships ~300 pre-formatted blank data
 * rows. Without seeding them the double cannot express the invariant that
 * matters here — that a write FILLS an existing row rather than adding one —
 * because every write grows it either way.
 */
function withTemplate(stage: Stage, blankRows: number): FakeWorkbook {
  const workbook = new FakeWorkbook();
  const width = STAGE_SCHEMAS[stage].columnCount;
  for (let n = 0; n < blankRows; n++) {
    workbook.writeRow(stage, FIRST_DATA_ROW + n, new Array<string>(width).fill(''));
  }
  return workbook;
}

/** A row of the right width for a stage, with a value in one column. */
function rowWith(stage: Stage, cells: Record<number, string>): string[] {
  const width = STAGE_SCHEMAS[stage].columnCount;
  return Array.from({ length: width }, (_, i) => cells[i] ?? '');
}

describe('placement fills the template, and never inserts', () => {
  it('chooses the first blank row rather than growing the sheet', () => {
    const workbook = withTemplate(STAGE, 20);
    const before = workbook.rowsFor(STAGE).length;

    const target = workbook.firstFreeRow(STAGE);
    expect(target).toBe(FIRST_DATA_ROW);

    workbook.writeRow(STAGE, target, rowWith(STAGE, { 0: 'AP-261027-01' }));

    // The assertion that would have failed before: the sheet is the same
    // height. An insert would have made it one taller.
    expect(workbook.rowsFor(STAGE).length).toBe(before);
    expect(workbook.rowsFor(STAGE)[target - 1]?.[0]).toBe('AP-261027-01');
  });

  it('moves down one row per record, still without growing', () => {
    const workbook = withTemplate(STAGE, 20);
    const before = workbook.rowsFor(STAGE).length;

    for (let n = 0; n < 3; n++) {
      const row = workbook.firstFreeRow(STAGE);
      expect(row).toBe(FIRST_DATA_ROW + n);
      workbook.writeRow(STAGE, row, rowWith(STAGE, { 0: `AP-26102${n}-01` }));
    }

    expect(workbook.rowsFor(STAGE).length).toBe(before);
  });
});

describe('a row somebody typed into is never taken', () => {
  it('skips a legacy row that has content but no identifier', () => {
    const workbook = new FakeWorkbook();

    /**
     * THE CASE THAT MAKES THE WHOLE-ROW TEST NECESSARY. A paper record copied
     * into the sheet years ago: a date and a note, and no sample id, because
     * identifiers did not exist then. Column A is blank, so a check that asks
     * only about column A hands this row over to be overwritten — which an
     * audit demonstrated against a row holding exactly this shape.
     */
    workbook.writeRow(
      STAGE,
      FIRST_DATA_ROW,
      rowWith(STAGE, { 1: '2019-03-02', 2: 'HISTORIC PAPER RECORD — no id' }),
    );

    expect(workbook.firstFreeRow(STAGE)).toBe(FIRST_DATA_ROW + 1);

    // And the legacy row is still there, untouched.
    const legacy = workbook.rowsFor(STAGE)[FIRST_DATA_ROW - 1] ?? [];
    expect(legacy[1]).toBe('2019-03-02');
    expect(legacy[2]).toBe('HISTORIC PAPER RECORD — no id');
  });

  it('skips a row whose only content is in the LAST column', () => {
    // Sheets omits trailing empty cells, so the last column is the easiest
    // place for a naive implementation to stop looking.
    const workbook = new FakeWorkbook();
    const last = STAGE_SCHEMAS[STAGE].columnCount - 1;
    workbook.writeRow(STAGE, FIRST_DATA_ROW, rowWith(STAGE, { [last]: 'pending QO review' }));

    expect(workbook.firstFreeRow(STAGE)).toBe(FIRST_DATA_ROW + 1);
  });

  it('treats whitespace as empty, so a stray space does not strand a row', () => {
    const workbook = new FakeWorkbook();
    workbook.writeRow(STAGE, FIRST_DATA_ROW, rowWith(STAGE, { 3: '   ' }));

    expect(workbook.firstFreeRow(STAGE)).toBe(FIRST_DATA_ROW);
  });

  it('POSITIVE CONTROL: a genuinely blank row IS taken', () => {
    // Without this, a `firstFreeRow` that refused every row would pass every
    // assertion above.
    const workbook = new FakeWorkbook();
    expect(workbook.firstFreeRow(STAGE)).toBe(FIRST_DATA_ROW);

    workbook.writeRow(STAGE, FIRST_DATA_ROW, rowWith(STAGE, { 0: 'AP-261027-01' }));
    expect(workbook.firstFreeRow(STAGE)).toBe(FIRST_DATA_ROW + 1);
  });

  it('reuses a gap left by a cleared row', () => {
    // Deliberate: a cleared row is blank, and the workbook is offering it
    // again. Stated as a test so the behaviour is a decision, not an accident.
    const workbook = new FakeWorkbook();
    workbook.writeRow(STAGE, FIRST_DATA_ROW, rowWith(STAGE, { 0: 'AP-261027-01' }));
    workbook.writeRow(STAGE, FIRST_DATA_ROW + 1, rowWith(STAGE, { 0: 'AP-261027-02' }));
    expect(workbook.firstFreeRow(STAGE)).toBe(FIRST_DATA_ROW + 2);

    workbook.writeRow(STAGE, FIRST_DATA_ROW, rowWith(STAGE, {}));
    expect(workbook.firstFreeRow(STAGE)).toBe(FIRST_DATA_ROW);
  });
});

describe('every stage behaves the same way', () => {
  it('starts at the first data row on all seven tabs', () => {
    const workbook = new FakeWorkbook();
    for (const stage of Object.keys(STAGE_SCHEMAS) as Stage[]) {
      expect(workbook.firstFreeRow(stage)).toBe(FIRST_DATA_ROW);
    }
  });
});
