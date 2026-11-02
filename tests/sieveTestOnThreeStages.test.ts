/**
 * The sieve test behaves identically on the three tabs that gained it.
 *
 * ===========================================================================
 * WHAT THIS FILE IS FOR THAT `dgmServerPath.test.ts` IS NOT
 * ===========================================================================
 * That file proves the plumbing on `8 DGM`, where the sieve test is the WHOLE
 * row: the weights start at K, the computed block runs Y..AG, and every
 * column on the tab belongs to the test. Nothing it asserts would notice the
 * three ways `2 Ground`, `6 Crumble` and `7 Mash` differ:
 *
 *  1. The computed block sits PAST COLUMN Z on all three — AC..AK on Ground
 *     and Crumble, Z..AH on Mash. `toSheetRow` places cells by array index
 *     and the letter is documentation, so a generator that produced the
 *     wrong letter past Z would be invisible to the index and visible only
 *     to an assertion naming the letter. `8 DGM` crosses Z too, but it was
 *     written out by hand; these three are the first generated from a
 *     starting index, which is the thing that could be off by one.
 *
 *  2. The weights are OPTIONAL here, not `registration`-required. A sample
 *     taken at the mill and registered before the lab has run the test is
 *     the ordinary case on these tabs, and it must register cleanly with
 *     nine blank computed cells — which is exactly the shape the
 *     `derivation_incomplete` guard was written to REFUSE on `8 DGM`.
 *
 *  3. The test shares the row with columns that are not part of it. A
 *     moisture, a roll gap, a PDI and a crumble size sit among the weights,
 *     so a derive step that leaked a key, or a row that was one cell short,
 *     would land a computed figure on an operator's measurement.
 *
 * The NUMBERS are the same worked example `tests/dgmMaths.test.ts` pins
 * against the source workbook `Cópia de DGM (2).xls`, deliberately: if the
 * same weights produce the same figures on four tabs, the arithmetic is one
 * implementation and not four.
 */

import { describe, expect, it } from 'vitest';
import { validateStagePayload } from '../supabase/functions/_shared/validation.ts';
import { STAGE_SCHEMAS } from '@/forms/registry';
import { columnLetterToIndex } from '@/forms/sheetMapping';
import type { Stage } from '@/forms/types';

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

/** What that example computes to, as the spreadsheet cells. */
const EXPECTED: Readonly<Record<string, string>> = {
  total_retained_g: '202.00',
  fineness_module: '3.821782',
  dgm_um: '1472.6131',
  ui_coarse_pct: '22.7723',
  ui_average_pct: '77.2277',
  ui_fine_pct: '0.0000',
  dpg_legacy_index: '4.520676',
};

/**
 * The columns each tab requires at registration that are NOT part of the
 * sieve test — sample details, and on two of the three a machine setting.
 * Named per stage rather than derived from the registry on purpose: a
 * fixture built by asking `fieldsRequiredAt` what is required would satisfy
 * whatever requiredness the registry happened to declare, including a wrong
 * one.
 */
const IDENTITY: Readonly<Record<string, Record<string, string>>> = {
  ground: {
    sampling_point: 'AM',
    material_or_feed_type: 'Corn',
    batch_or_bin_no: 'B-2214',
    mill_screen_size_mm: '5',
    hammer_distance_mm: '40',
  },
  crumble: {
    feed_type: 'Broiler crumble',
    batch_no: 'B-2214',
    crumbler_roll_gap_mm: '2.5',
  },
  mash: { feed_type: 'Broiler mash', batch_no: 'B-2214' },
};

const STAGES_UNDER_TEST = ['ground', 'crumble', 'mash'] as const;

function weights(): Record<string, string> {
  const values: Record<string, string> = { sieve_series: 'abnt-standard-7' };
  MASSES.forEach(([tare, gross], i) => {
    values[`sieve${i + 1}_tare_g`] = String(tare);
    values[`sieve${i + 1}_gross_g`] = String(gross);
  });
  return values;
}

function payload(stage: (typeof STAGES_UNDER_TEST)[number], withWeights: boolean) {
  return {
    collection_date: '2026-10-29',
    collection_time: '09:30',
    sampled_by: 'S. Gravesande',
    ...IDENTITY[stage],
    ...(withWeights ? weights() : {}),
  };
}

function validate(stage: Stage, values: Record<string, unknown>) {
  return validateStagePayload({ stage, phase: 'registration', values });
}

/** The column letter the registry gives a key on a stage. */
function letterOf(stage: Stage, key: string): string {
  const field = STAGE_SCHEMAS[stage].fields.find((f) => f.key === key);
  if (field === undefined) throw new Error(`${stage} has no column ${key}`);
  return field.columnLetter;
}

function cellFor(row: readonly string[], stage: Stage, key: string): string {
  return row[columnLetterToIndex(letterOf(stage, key))] ?? '';
}

describe.each(STAGES_UNDER_TEST)('%s: a complete weighing', (stage) => {
  const result = validate(stage, payload(stage, true));

  it('validates', () => {
    expect(result.ok, result.ok ? '' : JSON.stringify(result.issues)).toBe(true);
  });

  it('writes every computed figure at the letter the registry names', () => {
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const [key, want] of Object.entries(EXPECTED)) {
      expect(cellFor(result.row, stage, key), `${stage}.${key}`).toBe(want);
    }
    // Text, not a number: it records WHICH convention bounded the two
    // open-ended bins, and a blank would claim no basis for a figure that has
    // one.
    expect(cellFor(result.row, stage, 'gsd_basis')).not.toBe('');
  });

  it('agrees with `8 DGM` cell for cell', () => {
    // The point of the shared generator. Different tab, different letters,
    // the same nine strings.
    const dgm = validate('dgm', {
      collection_date: '2026-10-29',
      collection_time: '09:30',
      feed_type: 'Broiler crumble',
      batch_no: 'B-2214',
      sampled_by: 'S. Gravesande',
      tested_by_qo: 'S. Gravesande',
      ...weights(),
    });
    expect(result.ok && dgm.ok).toBe(true);
    if (!result.ok || !dgm.ok) return;

    const computed = STAGE_SCHEMAS.dgm.fields
      .filter((f) => f.type === 'system' && f.key !== 'sample_id')
      .map((f) => f.key);
    expect(computed).toHaveLength(9);
    for (const key of computed) {
      expect(cellFor(result.row, stage, key), `${stage}.${key}`).toBe(
        cellFor(dgm.row, 'dgm', key),
      );
    }
  });

  it('keeps the computed values out of `values`', () => {
    // `values` becomes `p_values`, which `apply_submitted_values` walks into
    // `apply_measurement` — and that raises for any `system` column
    // (0008_assessment_engine.sql:386). A computed value merged in here would
    // make every registration on this tab fail with a bare `internal`.
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const key of Object.keys(EXPECTED)) {
      expect(key in result.values, `${stage}.${key} leaked into values`).toBe(false);
    }
  });

  it('writes a row exactly as wide as the tab', () => {
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.row).toHaveLength(STAGE_SCHEMAS[stage].columnCount);
  });

  it('refuses a computed value supplied by the client', () => {
    const forged = validate(stage, { ...payload(stage, true), dgm_um: '1' });
    expect(forged.ok).toBe(false);
    if (forged.ok) return;
    expect(forged.issues.map((i) => i.code)).toContain('server_assigned');
  });
});

describe.each(STAGES_UNDER_TEST)('%s: registered before the lab has run the test', (stage) => {
  const result = validate(stage, payload(stage, false));

  it('registers cleanly with no weights at all', () => {
    // THE CASE `8 DGM` CANNOT HAVE. Its masses are `registration`-required,
    // so this payload would fail requiredness there. Here it is the ordinary
    // working pattern: the sample is taken at the mill, the stack is weighed
    // later.
    expect(result.ok, result.ok ? '' : JSON.stringify(result.issues)).toBe(true);
  });

  it('leaves every computed cell blank rather than computing over nothing', () => {
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const key of [...Object.keys(EXPECTED), 'gsd', 'gsd_basis']) {
      expect(cellFor(result.row, stage, key), `${stage}.${key}`).toBe('');
    }
  });

  it('still writes the columns that are not part of the sieve test', () => {
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(cellFor(result.row, stage, 'sampled_by')).toBe('S. Gravesande');
    expect(cellFor(result.row, stage, 'collection_date')).toBe('2026-10-29');
  });
});

describe.each(STAGES_UNDER_TEST)('%s: a half-finished weighing', (stage) => {
  it('is refused rather than registered with nine blank columns', () => {
    // Six weights of fourteen. `deriveSieveTest` returns `{}` for a partial
    // set, and without the guard that would register as "no test was done" —
    // indistinguishable afterwards from a sample nobody weighed, with the six
    // figures that WERE recorded sitting beside nine blanks.
    const partial = payload(stage, true) as Record<string, unknown>;
    for (let n = 4; n <= 7; n++) {
      delete partial[`sieve${n}_tare_g`];
      delete partial[`sieve${n}_gross_g`];
    }
    const result = validate(stage, partial);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((i) => i.code)).toContain('derivation_incomplete');
  });
});
