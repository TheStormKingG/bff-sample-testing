/**
 * Two changes this round that are claims about behaviour, tested as claims.
 *
 *   1. PDI is computed from two weighings rather than typed in.
 *   2. The workbook's sieve headings follow the lab's sieve table.
 *
 * The second one is here for a specific reason. The settings screen tells an
 * administrator, in words, that the workbook's headings will change to match
 * when they re-designate a sieve. That sentence is an assertion about what
 * the system does, read by somebody at the moment they are changing a
 * quality record, and the last time a sentence on that screen went untested
 * it was wrong twice. So the sentence has a test, and the test came first.
 */

import { describe, expect, it } from 'vitest';

import { deriveSystemValues, hasDerivedColumns } from '@/forms/derived';
import { STAGE_SCHEMAS } from '@/forms/registry';
import { diffHeaders, expectedHeaders, seriesDerivedColumns } from '@/forms/sheetMapping';
import { STAGES, type Stage } from '@/forms/types';
import { DEFAULT_SIEVE_PRESET } from '@/lib/dgm';
import { defaultSieveSeriesDocument, type SieveSeriesDocument } from '@/lib/sieveSeries';
import {
  applyRepair,
  assertHeaderRepairCells,
  planRepair,
} from '../supabase/functions/_shared/headerRepair.ts';

import {
  verifySchema,
  type WorkbookReading,
} from '../supabase/functions/_shared/headerCheck.ts';
import { repairSieveHeaders } from '../supabase/functions/_shared/headerRepair.ts';
import {
  FakeGoogleSheetsAdapter,
  FakeWorkbook,
} from '../supabase/functions/_shared/fakeSheets.ts';

// ---------------------------------------------------------------------------
// 1. Pellet durability
// ---------------------------------------------------------------------------

describe('PDI is the arithmetic of the two weighings beside it', () => {
  it('computes the method figure', () => {
    // The worked example from the method sheet: 488.4 g out of 500 g -> 97.7.
    // (The sheet prints 97.6; 488.4/500 is 97.68, which rounds to 97.7 at one
    // place. The arithmetic here is the ratio, not the sheet's rounding.)
    const out = deriveSystemValues('crumble', { pdi_before_g: 500, pdi_after_g: 488.4 });
    expect(out['pellet_durability_pdi_pct']).toBe('97.7');
  });

  it('is on both tabs that carry a durability tester, and no others', () => {
    const carries = STAGES.filter((stage) =>
      STAGE_SCHEMAS[stage].fields.some((f) => f.key === 'pellet_durability_pdi_pct'),
    );
    expect(carries).toEqual(['pellets', 'crumble']);

    // And on both of them the operator records weights, never a percentage.
    for (const stage of carries) {
      const pdi = STAGE_SCHEMAS[stage].fields.find(
        (f) => f.key === 'pellet_durability_pdi_pct',
      )!;
      expect(pdi.type, `${stage} PDI type`).toBe('system');
      expect(pdi.required, `${stage} PDI requiredness`).toBe('system');
      // `apply_measurement` raises for a `system` field, so this is what makes
      // a submitted PDI impossible rather than merely discouraged.
      expect(STAGE_SCHEMAS[stage].fields.map((f) => f.key)).toContain('pdi_before_g');
      expect(STAGE_SCHEMAS[stage].fields.map((f) => f.key)).toContain('pdi_after_g');
    }
  });

  it('writes an impossible figure rather than hiding it', () => {
    // More came out than went in, which means one of the two weighings is
    // wrong. The useful thing on the screen is the contradiction next to the
    // numbers that caused it, not a tidy 100.0 that hides which to re-check.
    const out = deriveSystemValues('pellets', { pdi_before_g: 500, pdi_after_g: 520 });
    expect(out['pellet_durability_pdi_pct']).toBe('104.0');
  });

  it('says nothing when there is nothing to divide by', () => {
    // A blank before-weight, and a mis-keyed zero. Both yield no percentage:
    // "divided by what?" has no answer, and Infinity is not one.
    expect(deriveSystemValues('pellets', { pdi_after_g: 480 })).toEqual({});
    expect(deriveSystemValues('pellets', { pdi_before_g: 0, pdi_after_g: 480 })).toEqual({});
  });

  it('is independent of the sieve test on the same tab', () => {
    // A sample can be tumbled without the stack being weighed, and weighed
    // without being tumbled. Each derivation stands or falls on its own
    // inputs; neither suppresses the other.
    const tumbledOnly = deriveSystemValues('crumble', { pdi_before_g: 500, pdi_after_g: 490 });
    expect(Object.keys(tumbledOnly)).toEqual(['pellet_durability_pdi_pct']);
    expect(deriveSystemValues('crumble', {})).toEqual({});
  });

  it('put the whole sieve test on 4 Pellets', () => {
    expect(hasDerivedColumns('pellets')).toBe(true);
    const keys = STAGE_SCHEMAS.pellets.fields.map((f) => f.key);
    for (let n = 1; n <= 7; n++) {
      expect(keys, `sieve ${n}`).toContain(`sieve${n}_tare_g`);
      expect(keys, `sieve ${n}`).toContain(`sieve${n}_gross_g`);
    }
    expect(keys).toContain('dgm_um');
  });
});

describe('the drum speed is only where there is a drum', () => {
  it.each([
    ['pellets', true],
    ['crumble', true],
    ['ground', false],
    ['mash', false],
  ] as const)('%s', (stage: Stage, expected: boolean) => {
    const has = STAGE_SCHEMAS[stage].fields.some((f) => f.key === 'durability_tester_rpm');
    expect(has).toBe(expected);
  });

  it('left no gap where it was removed', () => {
    // A removed column that did not close up would leave a blank column in
    // the middle of a quality record and shift every cell right of it.
    for (const stage of ['ground', 'mash'] as const) {
      const schema = STAGE_SCHEMAS[stage];
      const settings = schema.fields.filter((f) => f.section === 'settings');
      const keys = settings.map((f) => f.key);
      expect(keys, stage).toContain('sieve_shaker_hz');
      expect(keys, stage).not.toContain('durability_tester_rpm');
    }
  });
});

// ---------------------------------------------------------------------------
// 2. The headings follow the sieve table
// ---------------------------------------------------------------------------

/** The shipped table with position 3 re-designated from ABNT 16 to ABNT 18. */
function reDesignated(): SieveSeriesDocument {
  const base = defaultSieveSeriesDocument();
  return {
    ...base,
    positions: base.positions.map((p, i) => (i === 2 ? { ...p, abnt: '18' } : p)),
  };
}

const SIEVE_TABS: readonly Stage[] = ['ground', 'pellets', 'crumble', 'mash', 'dgm'];

describe('the workbook headings follow the ABNT designation', () => {
  it('the shipped table reproduces the registry exactly', () => {
    // The contract with no stored table and the contract with the shipped one
    // must be the same strings, or every tab would read as drifted the moment
    // the setting was seeded. Both come from `sieveMassHeaders`, and this is
    // what proves they do.
    for (const stage of STAGES) {
      expect(expectedHeaders(stage, null), stage).toEqual(
        STAGE_SCHEMAS[stage].fields.map((f) => f.sheetHeader),
      );
      expect(expectedHeaders(stage, defaultSieveSeriesDocument()), stage).toEqual(
        expectedHeaders(stage, null),
      );
    }
  });

  it('a re-designated sieve changes exactly its own two headings, on every sieve tab', () => {
    const series = reDesignated();
    for (const stage of SIEVE_TABS) {
      const before = expectedHeaders(stage, null);
      const after = expectedHeaders(stage, series);
      const moved = after
        .map((heading, i) => (heading === before[i] ? null : i))
        .filter((i): i is number => i !== null);
      expect(moved, `${stage} moved headings`).toHaveLength(2);
      expect(after[moved[0]!]).toBe('ABNT 18 empty sieve (g)');
      expect(after[moved[1]!]).toBe('ABNT 18 sieve + sample (g)');
    }
  });

  it('changes nothing on a tab with no sieve test', () => {
    for (const stage of STAGES.filter((s) => !SIEVE_TABS.includes(s))) {
      expect(expectedHeaders(stage, reDesignated()), stage).toEqual(expectedHeaders(stage, null));
      expect(seriesDerivedColumns(stage).size, stage).toBe(0);
    }
  });

  it('leaves the pan named Pan, because the heading claims no mesh', () => {
    // The workbook's own conversion table puts ABNT 400 at 37 µm and marks it
    // the pan, while the DGM sheet uses 38 µm for ABNT 400 and 37 µm for
    // `Fundo`. Until the lab settles that, position 7's heading says what is
    // physically there. Its designation still reaches the arithmetic.
    const base = defaultSieveSeriesDocument();
    const renamedPan: SieveSeriesDocument = {
      ...base,
      positions: base.positions.map((p, i) => (i === 6 ? { ...p, abnt: 'Base' } : p)),
    };
    expect(DEFAULT_SIEVE_PRESET.positions[6]!.isPan).toBe(true);
    expect(expectedHeaders('dgm', renamedPan)).toEqual(expectedHeaders('dgm', null));
  });

  it('reports a stale live heading as a mismatch against the stored table', () => {
    // This is the condition the repair exists to resolve: the sheet still
    // says what it was created with, the stored table says otherwise.
    const live = expectedHeaders('crumble', null);
    const mismatches = diffHeaders('crumble', live, reDesignated());
    expect(mismatches).toHaveLength(2);
    expect(mismatches.every((m) => m.actual.startsWith('ABNT 16'))).toBe(true);
    expect(mismatches.every((m) => m.expected.startsWith('ABNT 18'))).toBe(true);
  });
});

function readingOf(stages: readonly Stage[], series: SieveSeriesDocument | null): WorkbookReading {
  return {
    tabTitles: STAGES.map((s) => STAGE_SCHEMAS[s].sheetTab),
    stages: stages.map((stage) => ({ stage, headerRow: expectedHeaders(stage, series) })),
  };
}

describe('the repair plan is narrow by construction', () => {
  it('names only the cells the sieve table decides', () => {
    const plan = planRepair(readingOf(SIEVE_TABS, null), reDesignated(), SIEVE_TABS);
    expect(plan.map((p) => p.stage)).toEqual([...SIEVE_TABS]);
    for (const repair of plan) {
      expect(repair.cells, repair.tab).toHaveLength(2);
      const allowed = seriesDerivedColumns(repair.stage);
      for (const cell of repair.cells) expect(allowed.has(cell.columnLetter)).toBe(true);
      expect(repair.cells.map((c) => c.value)).toEqual([
        'ABNT 18 empty sieve (g)',
        'ABNT 18 sieve + sample (g)',
      ]);
      expect(repair.cells.every((c) => c.was.startsWith('ABNT 16'))).toBe(true);
    }
  });

  it('plans nothing when the sheet already agrees', () => {
    const series = reDesignated();
    expect(planRepair(readingOf(SIEVE_TABS, series), series, SIEVE_TABS)).toEqual([]);
  });

  it('plans nothing when there is no stored table to follow', () => {
    expect(planRepair(readingOf(SIEVE_TABS, null), null, SIEVE_TABS)).toEqual([]);
  });

  it('IGNORES a mismatch outside the sieve columns, leaving it to fence the workbook', () => {
    // The safety property. Only the headings a setting can make wrong are
    // repairable; every other difference is drift, and drift stops writing.
    const reading = readingOf(['crumble'], null);
    const row = [...reading.stages[0]!.headerRow];
    row[11] = 'Humidity (%)'; // was `Moisture (%)`
    const damaged: WorkbookReading = {
      tabTitles: reading.tabTitles,
      stages: [{ stage: 'crumble', headerRow: row }],
    };
    const plan = planRepair(damaged, reDesignated(), ['crumble']);
    expect(plan).toHaveLength(1);
    expect(plan[0]!.cells.map((c) => c.columnLetter)).not.toContain('L');
  });

  it('refuses a cell nothing could have made wrong', () => {
    expect(() =>
      assertHeaderRepairCells({
        stage: 'crumble',
        tab: '6 Crumble',
        cells: [{ columnLetter: 'L', value: 'Humidity (%)', was: 'Moisture (%)' }],
      }),
    ).toThrow(/not derived from the sieve table/);
  });

  it('refuses a tab the writer has no business in', () => {
    expect(() =>
      assertHeaderRepairCells({ stage: 'crumble', tab: 'Limits', cells: [] }),
    ).toThrow(/not an operational tab/);
  });

  it('a repaired reading verifies clean, and keeps every other field it came with', () => {
    const series = reDesignated();
    const reading = { ...readingOf(['mash'], null), identity: { title: 'BFF Sample Testing' } };
    const plan = planRepair(reading, series, ['mash']);
    const after = applyRepair(reading, plan);
    expect(diffHeaders('mash', after.stages[0]!.headerRow, series)).toEqual([]);
    // The adapter's reading carries more than this module models; a spread
    // that dropped it would lose the workbook identity on the way through.
    expect(after.identity).toEqual({ title: 'BFF Sample Testing' });
  });
});

describe('the repair reaches the live sheet, through the adapter', () => {
  it('rewrites row 4 and nothing else, then verifies clean', async () => {
    // End to end over the fake workbook: the sheet is created with the
    // shipped headings, the lab re-designates a sieve, and the next pass
    // leaves the sheet agreeing with the setting. Planning in isolation
    // proves the arithmetic; this proves the wiring.
    const workbook = new FakeWorkbook();
    const adapter = new FakeGoogleSheetsAdapter(workbook);
    const series = reDesignated();

    // A data row, so the assertion that nothing below row 4 moved has
    // something to be about.
    const row = Array.from({ length: STAGE_SCHEMAS.crumble.columnCount }, (_, i) => `c${i}`);
    workbook.writeRow('crumble', 5, row);

    const before = await adapter.verifyWorkbook(['crumble']);
    expect(diffHeaders('crumble', before.reading.stages[0]!.headerRow, series)).toHaveLength(2);

    const outcome = await repairSieveHeaders(adapter, before.reading, series, ['crumble']);
    expect(outcome.failed).toEqual([]);
    expect(outcome.repaired).toHaveLength(1);

    // Re-READ the workbook rather than trusting the patched reading: the
    // claim is about the sheet, not about the object we handed back.
    const after = await adapter.verifyWorkbook(['crumble']);
    expect(diffHeaders('crumble', after.reading.stages[0]!.headerRow, series)).toEqual([]);
    expect(verifySchema(after.reading, ['crumble'], series).ok).toBe(true);
    expect(workbook.rawRow('crumble', 5)).toEqual(row);
  });

  it('leaves the stale heading standing when the write is refused', async () => {
    // Then verification fails and the workbook is fenced off, which is the
    // behaviour that existed before the repair did. A cosmetic rename must
    // not be able to turn into a write against headings nobody checked.
    const adapter = new FakeGoogleSheetsAdapter();
    adapter.failNext('writeHeaderCells', { kind: 'permanent' });
    const series = reDesignated();

    const read = await adapter.verifyWorkbook(['mash']);
    const outcome = await repairSieveHeaders(adapter, read.reading, series, ['mash']);

    expect(outcome.repaired).toEqual([]);
    expect(outcome.failed.map((f) => f.tab)).toEqual(['7 Mash']);
    expect(verifySchema(outcome.reading, ['mash'], series).ok).toBe(false);
  });
});
