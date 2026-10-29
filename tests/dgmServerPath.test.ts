/**
 * The DGM computation reaches the spreadsheet row, and nothing else.
 *
 * ===========================================================================
 * THE THREE CLAIMS THIS FILE EXISTS TO HOLD
 * ===========================================================================
 * 1. The computed cells land in the row, at the right columns, with the right
 *    values. `toSheetRow` places cells by a field's INDEX in `schema.fields`,
 *    not by its `columnLetter` — the letter is documentation — so a field in
 *    the wrong array position writes to the wrong cell with no error anywhere.
 *    Only an assertion against the letter notices.
 *
 * 2. The computed cells are NOT in `values`. `values` becomes `p_values`,
 *    which `apply_submitted_values` walks one field at a time into
 *    `apply_measurement`, and that function raises for any column whose type
 *    or requiredness is `system` (0008_assessment_engine.sql:386). A computed
 *    value merged into `values` would make every DGM registration fail with a
 *    bare `internal`, which is exactly the shape of the account-creation
 *    defect this project has already had once.
 *
 * 3. An operator cannot supply one. The columns are `type: 'system'`, so
 *    `validateStagePayload` refuses a non-blank value for them with
 *    `server_assigned` — the same control that stops a client claiming its own
 *    sample ID.
 *
 * The NUMBERS are pinned in tests/dgmMaths.test.ts against the source
 * workbook. This file asserts the plumbing, and checks the few values it does
 * check against that same workbook rather than against whatever the code
 * currently produces.
 */

import { describe, expect, it } from 'vitest';
import { validateStagePayload } from '../supabase/functions/_shared/validation.ts';
import { deriveSystemValues, hasDerivedColumns } from '@/forms/derived';
import { STAGE_SCHEMAS } from '@/forms/registry';
import { STAGES } from '@/forms/types';
import { columnLetterToIndex } from '@/forms/sheetMapping';

/** The worked example from `Cópia de DGM (2).xls`: 202 g of "BF". */
const MASSES: ReadonlyArray<readonly [number, number]> = [
  [370, 370],
  [398, 444],
  [388, 472],
  [368, 430],
  [362, 372],
  [330, 330],
  [330, 330],
];

function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const values: Record<string, unknown> = {
    collection_date: '2026-10-29',
    collection_time: '09:30',
    feed_type: 'Broiler crumble',
    batch_no: 'B-2214',
    sampled_by: 'S. Gravesande',
    sieve_series: 'abnt-standard-7',
    tested_by_qo: 'S. Gravesande',
  };
  MASSES.forEach(([tare, gross], i) => {
    values[`sieve${i + 1}_tare_g`] = String(tare);
    values[`sieve${i + 1}_gross_g`] = String(gross);
  });
  return { ...values, ...overrides };
}

function cellAt(row: readonly string[], letter: string): string {
  return row[columnLetterToIndex(letter)] ?? '';
}

describe('a complete DGM registration', () => {
  const result = validateStagePayload({
    stage: 'dgm',
    phase: 'registration',
    values: payload(),
  });

  it('validates', () => {
    expect(
      result.ok ? 'ok' : JSON.stringify(result.issues, null, 1),
    ).toBe('ok');
  });

  it('produces a row of exactly the tab’s width', () => {
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.row).toHaveLength(STAGE_SCHEMAS.dgm.columnCount);
    expect(result.row).toHaveLength(35);
  });

  it('puts each computed value in its own declared column', () => {
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { row } = result;

    // Values from the workbook: MF 3.821782178217822, DGM 1472.6130536938736,
    // UI 22.77227722772277 / 77.22772277227723 / 0, DPG 4.520676308442608,
    // total retained 202. Rendered at the fixed precision src/forms/derived.ts
    // declares for each column.
    expect(cellAt(row, 'Y'), 'Y total retained').toBe('202.00');
    expect(cellAt(row, 'Z'), 'Z fineness module').toBe('3.821782');
    expect(cellAt(row, 'AA'), 'AA DGM µm').toBe('1472.6131');
    expect(cellAt(row, 'AB'), 'AB UI coarse').toBe('22.7723');
    expect(cellAt(row, 'AC'), 'AC UI average').toBe('77.2277');
    expect(cellAt(row, 'AD'), 'AD UI fine').toBe('0.0000');
    expect(cellAt(row, 'AE'), 'AE DPG legacy index').toBe('4.520676');
    // The GSD's digits are pinned in dgmMaths.test.ts against a hand
    // computation; here it only has to be the right NUMBER in the right CELL.
    expect(Number(cellAt(row, 'AF')), 'AF GSD').toBeCloseTo(1.6722, 3);
    expect(cellAt(row, 'AG'), 'AG GSD basis').toBe('series-ratio-top-bound/pan-excluded');
  });

  it('still carries the operator’s own cells, unrounded', () => {
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { row } = result;
    // The masses keep the operator's keystrokes: this is the control showing
    // the computed columns did not overwrite or shift anything.
    expect(cellAt(row, 'K'), 'K sieve 1 tare').toBe('370');
    expect(cellAt(row, 'N'), 'N sieve 2 gross').toBe('444');
    expect(cellAt(row, 'X'), 'X pan + sample').toBe('330');
    expect(cellAt(row, 'D'), 'D feed type').toBe('Broiler crumble');
    // The select writes its LABEL to the sheet and keeps the code in the DB.
    expect(cellAt(row, 'J'), 'J sieve series').toBe(
      'ABNT 5 / 10 / 16 / 30 / 50 / 400 / Fundo',
    );
  });

  it('keeps every computed key OUT of the values applied as measurements', () => {
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const systemKeys = STAGE_SCHEMAS.dgm.fields
      .filter((f) => f.type === 'system')
      .map((f) => f.key);
    // Nine derived columns plus column A.
    expect(systemKeys).toHaveLength(10);
    for (const key of systemKeys) {
      expect(
        Object.keys(result.values),
        `${key} would reach apply_measurement, which refuses server-assigned columns`,
      ).not.toContain(key);
    }
  });

  it('reports the computed cells separately, for the screen to show', () => {
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.derived).sort()).toEqual([
      'dgm_um',
      'dpg_legacy_index',
      'fineness_module',
      'gsd',
      'gsd_basis',
      'total_retained_g',
      'ui_average_pct',
      'ui_coarse_pct',
      'ui_fine_pct',
    ]);
  });
});

describe('an operator cannot supply a computed value', () => {
  it.each([
    'fineness_module',
    'dgm_um',
    'gsd',
    'total_retained_g',
  ])('refuses a client-supplied %s', (key) => {
    const result = validateStagePayload({
      stage: 'dgm',
      phase: 'registration',
      values: payload({ [key]: '999' }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const issue = result.issues.find((i) => i.field === key);
    expect(issue?.code, `${key} was accepted from the client`).toBe('server_assigned');
  });

  it('POSITIVE CONTROL: the same payload without that key is accepted', () => {
    // Without this, the refusals above would pass just as well if the payload
    // were invalid for some entirely unrelated reason.
    const result = validateStagePayload({
      stage: 'dgm',
      phase: 'registration',
      values: payload(),
    });
    expect(result.ok).toBe(true);
  });
});

describe('a sample on which nothing was retained', () => {
  const nothing: Record<string, unknown> = {};
  MASSES.forEach(([tare], i) => {
    nothing[`sieve${i + 1}_tare_g`] = String(tare);
    nothing[`sieve${i + 1}_gross_g`] = String(tare);
  });
  const result = validateStagePayload({
    stage: 'dgm',
    phase: 'registration',
    values: payload(nothing),
  });

  it('is recorded, not refused — the weighing happened', () => {
    expect(result.ok).toBe(true);
  });

  it('leaves the undefined ratios blank rather than writing zero', () => {
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { row } = result;
    // Every R% is 0/0. A zero here would read as "measured, and it was zero".
    // The blank is what the trigger in 0025 turns into the ABSENCE of a
    // derived row, rather than a stored zero.
    expect(cellAt(row, 'Z'), 'Z fineness module').toBe('');
    expect(cellAt(row, 'AA'), 'AA DGM µm').toBe('');
    expect(cellAt(row, 'AB'), 'AB UI coarse').toBe('');
    expect(cellAt(row, 'AF'), 'AF GSD').toBe('');
    expect(cellAt(row, 'AG'), 'AG GSD basis').toBe('');
  });

  it('still records the total, which really was measured and really is zero', () => {
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The distinction this whole file turns on: 0.00 here is a measurement,
    // the blanks above are an absence of one.
    expect(cellAt(result.row, 'Y')).toBe('0.00');
  });
});

describe('the other seven stages are untouched', () => {
  it('only DGM has computed columns', () => {
    const withDerived = STAGES.filter((s) => hasDerivedColumns(s));
    expect(withDerived).toEqual(['dgm']);
  });

  it('derives nothing for them, and allocates nothing doing it', () => {
    for (const stage of STAGES) {
      if (stage === 'dgm') continue;
      expect(deriveSystemValues(stage, {}), stage).toEqual({});
    }
  });

  it('leaves their rows exactly as wide as they were', () => {
    // A regression here would mean the derive step had leaked a key into a
    // stage that has no column for it.
    const widths = STAGES.filter((s) => s !== 'dgm').map((s) => STAGE_SCHEMAS[s].columnCount);
    expect(widths).toEqual([19, 15, 13, 11, 16, 13, 11]);
  });
});

describe('the registry and the computation agree on which columns exist', () => {
  it('every computed key is a system column on the DGM tab', () => {
    // `toSheetRow` IGNORES a key that is not a registry field — it maps over
    // `schema.fields`, so an unknown key is dropped in silence. Without this,
    // renaming a column in the registry would blank the cell rather than fail.
    const derived = deriveSystemValues('dgm', {
      ...Object.fromEntries(
        MASSES.flatMap(([t, g], i) => [
          [`sieve${i + 1}_tare_g`, t],
          [`sieve${i + 1}_gross_g`, g],
        ]),
      ),
      sieve_series: 'abnt-standard-7',
    });
    expect(Object.keys(derived).length).toBeGreaterThan(0);
    for (const key of Object.keys(derived)) {
      const field = STAGE_SCHEMAS.dgm.fields.find((f) => f.key === key);
      expect(field, `computed key ${key} is not a column`).toBeDefined();
      expect(field?.type, `computed key ${key} is not a system column`).toBe('system');
    }
  });

  it('every system column except A is produced by the computation', () => {
    // The other direction: a column declared and never filled would be a
    // permanently blank cell on every record, which looks like missing data.
    const derived = deriveSystemValues('dgm', {
      ...Object.fromEntries(
        MASSES.flatMap(([t, g], i) => [
          [`sieve${i + 1}_tare_g`, t],
          [`sieve${i + 1}_gross_g`, g],
        ]),
      ),
      sieve_series: 'abnt-standard-7',
    });
    const declared = STAGE_SCHEMAS.dgm.fields
      .filter((f) => f.type === 'system' && f.key !== 'sample_id')
      .map((f) => f.key)
      .sort();
    expect(Object.keys(derived).sort()).toEqual(declared);
  });
});
