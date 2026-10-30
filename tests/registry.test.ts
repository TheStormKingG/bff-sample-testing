/**
 * Registry structural contract tests.
 *
 * These assert the registry against the headers VERIFIED from the live
 * workbook: tabs 1-7 on 2026-10-24 (docs/workbook-verification.md), tab 8 on
 * 2026-10-29. The expected strings below are an independent transcription of
 * that read: if someone edits registry.ts and quietly changes a header, these
 * fail. That is the point — the registry must not be able to drift from the
 * workbook silently.
 *
 * `8 DGM` differs from the other seven in HISTORY, not in kind. Those tabs
 * existed and were transcribed; the DGM tab was authored into the workbook on
 * 2026-10-29 and then read back out of it with
 * `gviz/tq?tqx=out:csv&sheet=8 DGM&range=A4:AI4`, and the values below are that
 * read-back. The read-back was not a formality: it caught cell AA4 arriving as
 * `DGM (¬µm)`, because the clipboard carried UTF-8 bytes that Sheets decoded as
 * Mac Roman. The micro sign in `DGM (µm)` below is U+00B5, the same codepoint
 * the workbook uses in `Average particle size (µm)` on tabs 2, 6 and 7, and
 * `diffHeaders` compares these strings exactly.
 */
import { describe, it, expect } from 'vitest';
import {
  STAGE_SCHEMAS,
  DASHBOARD_ORDER,
  resolvePrefix,
  isFieldApplicable,
  fieldsRequiredAt,
  adverseObservationFields,
  assessableFields,
  ALL_PREFIXES,
  PROTECTED_HEADER_ROWS,
  FIRST_DATA_ROW,
} from '@/forms/registry';
import { STAGES, type Stage } from '@/forms/types';
import { columnLetterToIndex, indexToColumnLetter } from '@/forms/sheetMapping';

/** Verified row-4 headers, transcribed independently from the live workbook. */
const VERIFIED_HEADERS: Record<Stage, { tab: string; headers: string[] }> = {
  raw_materials: {
    tab: '1 Raw materials',
    headers: [
      'Sample ID', 'Date', 'Time', 'Material', 'Supplier', 'Delivery or lot no.',
      'Truck or container no.', 'Quantity received (tonnes)', 'Sampled by',
      'Moisture (%)', 'Aflatoxin (ppb)', 'Other mycotoxin tested (name)',
      'Other mycotoxin result', 'Mould seen?', 'Insects seen?',
      'Foreign matter seen?', 'Bad smell?', 'Tested by (QO)', 'Comments',
    ],
  },
  ground: {
    tab: '2 Ground',
    headers: [
      'Sample ID', 'Date', 'Time', 'Sampling point', 'Material or feed type',
      'Batch or bin no.', 'Sampled by', 'Mill screen size (mm)',
      'Hammer distance from screen (mm)', 'Average particle size (µm)',
      'Size spread (GSD)', 'Moisture (%) at BC', 'Action taken',
      'Tested by (QO)', 'Comments',
    ],
  },
  conditioned: {
    tab: '3 Conditioned',
    headers: [
      'Sample ID', 'Date', 'Time', 'Feed type', 'Batch no.', 'Sampled by',
      'Steam pressure reading', 'Water added (%)', 'Mash temperature (°C)',
      'Moisture (%)', 'Action taken', 'Tested by (QO)', 'Comments',
    ],
  },
  pellets: {
    tab: '4 Pellets',
    headers: [
      'Sample ID', 'Date', 'Time', 'Feed type', 'Batch no.', 'Sampled by',
      'Pellet temperature (°C)', 'Pellet diameter (mm)', 'Action taken',
      'Tested by (QO)', 'Comments',
    ],
  },
  extruded_soya: {
    tab: '5 Extruded soya',
    headers: [
      'Sample ID', 'Date', 'Time', 'Run no.', 'Raw soya lot no.', 'Sampled by',
      'Crusher roller gap (mm)', 'Steam line (%)', 'Steam line temperature (°C)',
      'Extruder temperature (°C)', 'Amount (ton/hr)', 'Moisture (%)',
      'Urease (pH rise)', 'Protein solubility (%)', 'Tested by (QO)', 'Comments',
    ],
  },
  crumble: {
    tab: '6 Crumble',
    headers: [
      'Sample ID', 'Date', 'Time', 'Feed type', 'Batch no.', 'Sampled by',
      'Crumbler roll gap (mm)', 'Moisture (%)', 'Average particle size (µm)',
      'Pellet durability (PDI, %)', 'Crumble size (mm)', 'Tested by (QO)',
      'Comments',
    ],
  },
  mash: {
    tab: '7 Mash',
    headers: [
      'Sample ID', 'Date', 'Time', 'Feed type', 'Batch no.', 'Sampled by',
      'Moisture (%)', 'Average particle size (µm)', 'Size spread (GSD)',
      'Tested by (QO)', 'Comments',
    ],
  },
  dgm: {
    tab: '8 DGM',
    headers: [
      'Sample ID', 'Date', 'Time', 'Feed type', 'Batch no.', 'Sampled by',
      'Durability tester RPM', 'Sieve shaker frequency (Hz)', 'Vibration time (min)', 'Sieve series',
      'ABNT 5 empty sieve (g)', 'ABNT 5 sieve + sample (g)',
      'ABNT 10 empty sieve (g)', 'ABNT 10 sieve + sample (g)',
      'ABNT 16 empty sieve (g)', 'ABNT 16 sieve + sample (g)',
      'ABNT 30 empty sieve (g)', 'ABNT 30 sieve + sample (g)',
      'ABNT 50 empty sieve (g)', 'ABNT 50 sieve + sample (g)',
      'ABNT 400 empty sieve (g)', 'ABNT 400 sieve + sample (g)',
      'Pan empty (g)', 'Pan + sample (g)',
      'Total retained (g)', 'Fineness module (MF)', 'DGM (µm)',
      'UI coarse (%)', 'UI average (%)', 'UI fine (%)',
      'DPG legacy index', 'Geometric standard deviation', 'GSD basis',
      'Tested by (QO)', 'Comments',
    ],
  },
};

describe('registry: workbook contract', () => {
  it('covers exactly the eight operational stages', () => {
    expect(STAGES).toHaveLength(8);
    expect(Object.keys(STAGE_SCHEMAS).sort()).toEqual([...STAGES].sort());
  });

  it.each(STAGES)('%s: tab name matches the live workbook exactly', (stage) => {
    expect(STAGE_SCHEMAS[stage].sheetTab).toBe(VERIFIED_HEADERS[stage].tab);
  });

  it.each(STAGES)('%s: row-4 headers match the live workbook exactly', (stage) => {
    const actual = STAGE_SCHEMAS[stage].fields.map((f) => f.sheetHeader);
    expect(actual).toEqual(VERIFIED_HEADERS[stage].headers);
  });

  it.each(STAGES)('%s: declared column count equals the field count', (stage) => {
    const s = STAGE_SCHEMAS[stage];
    expect(s.fields).toHaveLength(s.columnCount);
    expect(s.columnCount).toBe(VERIFIED_HEADERS[stage].headers.length);
  });

  it.each(STAGES)('%s: column letters are contiguous A..lastColumn', (stage) => {
    const s = STAGE_SCHEMAS[stage];
    const letters = s.fields.map((f) => f.columnLetter);
    const expected = s.fields.map((_, i) => indexToColumnLetter(i));
    expect(letters).toEqual(expected);
    expect(letters[0]).toBe('A');
    expect(letters[letters.length - 1]).toBe(s.lastColumn);
    expect(columnLetterToIndex(s.lastColumn)).toBe(s.columnCount - 1);
  });

  it('total verified columns across the eight tabs is 133', () => {
    // 98 across the original seven, plus 35 for `8 DGM`. Stated as the sum of
    // its parts rather than as one number, so a change to either side names
    // which side moved.
    const originalSeven = STAGES.filter((s) => s !== 'dgm').reduce(
      (n, s) => n + STAGE_SCHEMAS[s].columnCount,
      0,
    );
    expect(originalSeven).toBe(98);
    expect(STAGE_SCHEMAS.dgm.columnCount).toBe(35);
    const total = STAGES.reduce((n, s) => n + STAGE_SCHEMAS[s].columnCount, 0);
    expect(total).toBe(133);
  });

  it.each(STAGES)('%s: field keys are unique', (stage) => {
    const keys = STAGE_SCHEMAS[stage].fields.map((f) => f.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it.each(STAGES)('%s: column A is the system-assigned sample ID', (stage) => {
    const first = STAGE_SCHEMAS[stage].fields[0]!;
    expect(first.key).toBe('sample_id');
    expect(first.type).toBe('system');
    expect(first.required).toBe('system');
  });

  it.each(STAGES)('%s: B and C are the local collection date and time', (stage) => {
    const f = STAGE_SCHEMAS[stage].fields;
    expect(f[1]!.key).toBe('collection_date');
    expect(f[1]!.type).toBe('date');
    expect(f[2]!.key).toBe('collection_time');
    expect(f[2]!.type).toBe('time');
  });

  it('preserves the header asymmetry between tabs rather than normalising it', () => {
    // `2 Ground` uses longer header text than tabs 3/4/6/7. A well-meaning
    // refactor that unifies these would corrupt the operational log.
    expect(STAGE_SCHEMAS.ground.fields[4]!.sheetHeader).toBe('Material or feed type');
    expect(STAGE_SCHEMAS.ground.fields[5]!.sheetHeader).toBe('Batch or bin no.');
    expect(STAGE_SCHEMAS.conditioned.fields[3]!.sheetHeader).toBe('Feed type');
    expect(STAGE_SCHEMAS.conditioned.fields[4]!.sheetHeader).toBe('Batch no.');
  });

  it('protects rows 1-4 and starts data at row 5', () => {
    // Row 3 holds merged section bands discovered in the live workbook, so the
    // protected region is four rows, not three.
    expect(PROTECTED_HEADER_ROWS).toBe(4);
    expect(FIRST_DATA_ROW).toBe(5);
  });
});

describe('registry: dashboard', () => {
  it('presents exactly eight cards in the order fixed by the PRD, then DGM', () => {
    expect(DASHBOARD_ORDER).toHaveLength(8);
    expect(DASHBOARD_ORDER.map((s) => s.title)).toEqual([
      'Raw Materials', 'Ground', 'Conditioned', 'Pellets',
      'Extruded Soya', 'Crumble', 'Mash', 'DGM',
    ]);
    expect(DASHBOARD_ORDER.map((s) => s.ordinal)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('lists every stage exactly once — DASHBOARD_ORDER is not type-checked', () => {
    // `DASHBOARD_ORDER` is a plain array, not a `Record<Stage, …>`, so a stage
    // added to STAGE_SCHEMAS and forgotten here compiles and then vanishes from
    // the dashboard and the phone home screen with no error. This is the only
    // thing that notices.
    expect([...DASHBOARD_ORDER].map((s) => s.stage).sort()).toEqual([...STAGES].sort());
  });
});

describe('registry: sample ID prefixes', () => {
  it.each([
    ['raw_materials', 'RM'],
    ['conditioned', 'AC'],
    ['pellets', 'AP'],
    ['extruded_soya', 'ES'],
    ['crumble', 'CR'],
    ['mash', 'MS'],
  ] as const)('%s resolves to %s', (stage, prefix) => {
    expect(resolvePrefix(stage)).toBe(prefix);
  });

  it('derives AM/BC from the structured point code, not display text', () => {
    expect(resolvePrefix('ground', { sampling_point: 'AM' })).toBe('AM');
    expect(resolvePrefix('ground', { sampling_point: 'BC' })).toBe('BC');
  });

  it('refuses to default a ground prefix when the point code is missing or unknown', () => {
    // Defaulting here would mint a real, immutable identifier under the wrong
    // prefix, so this must fail loudly rather than pick one.
    expect(() => resolvePrefix('ground', {})).toThrow(/sampling_point/);
    expect(() => resolvePrefix('ground', { sampling_point: 'AM after mill' })).toThrow();
    expect(() => resolvePrefix('ground', { sampling_point: 'am' })).toThrow();
    expect(() => resolvePrefix('ground', { sampling_point: null })).toThrow();
  });

  it('enumerates all nine issuable prefixes', () => {
    expect([...ALL_PREFIXES].sort()).toEqual(
      ['AC', 'AM', 'AP', 'BC', 'CR', 'DG', 'ES', 'MS', 'RM'],
    );
  });

  it('declares a prefix for every stage that has one, and no orphans', () => {
    // `StageSchema.prefix` is `string | null`, NOT `SamplePrefix`, so a stage
    // can name a prefix that ALL_PREFIXES omits — it compiles, and then fails
    // at runtime inside identifier allocation, which is the worst place to
    // find out. 'DG' reached this list only because this comparison exists.
    const declared = [...STAGES]
      .map((s) => STAGE_SCHEMAS[s].prefix)
      .filter((p): p is string => p !== null);
    for (const prefix of declared) {
      expect(ALL_PREFIXES, `stage prefix ${prefix} is not issuable`).toContain(prefix);
    }
    // Ground is the one stage with no fixed prefix: it issues AM or BC from
    // the structured sampling point, so those two are issuable without being
    // declared on any schema.
    const orphans = ALL_PREFIXES.filter(
      (p) => !declared.includes(p) && p !== 'AM' && p !== 'BC',
    );
    expect(orphans, 'issuable prefixes no stage can mint').toEqual([]);
  });
});

describe('registry: conditional applicability (UAT-02)', () => {
  const moistureBc = STAGE_SCHEMAS.ground.fields.find((f) => f.key === 'moisture_pct_bc')!;

  it('moisture at BC applies at BC', () => {
    expect(isFieldApplicable(moistureBc, { sampling_point: 'BC' })).toBe(true);
  });

  it('moisture at BC does not apply at AM', () => {
    expect(isFieldApplicable(moistureBc, { sampling_point: 'AM' })).toBe(false);
  });

  it('excludes non-applicable fields from testing requirements', () => {
    const amRequired = fieldsRequiredAt('ground', 'testing', { sampling_point: 'AM' }).map((f) => f.key);
    const bcRequired = fieldsRequiredAt('ground', 'testing', { sampling_point: 'BC' }).map((f) => f.key);
    expect(amRequired).not.toContain('moisture_pct_bc');
    expect(bcRequired).toContain('moisture_pct_bc');
  });
});

describe('registry: quality-critical flags', () => {
  it('marks the four raw-material visual checks as adverse-on-yes', () => {
    const keys = adverseObservationFields('raw_materials').map((f) => f.key);
    expect(keys).toEqual(['mould_seen', 'insects_seen', 'foreign_matter_seen', 'bad_smell']);
    for (const f of adverseObservationFields('raw_materials')) {
      expect(f.adverseValue).toBe('yes');
    }
  });

  it('declares steam pressure unit UNCONFIRMED so it can never pass (UAT-07, R-02)', () => {
    const f = STAGE_SCHEMAS.conditioned.fields.find((x) => x.key === 'steam_pressure_reading')!;
    expect(f.unitConfirmed).toBe(false);
    expect(f.unit).toBeUndefined();
  });

  it('declares the other-mycotoxin result unit UNCONFIRMED', () => {
    const f = STAGE_SCHEMAS.raw_materials.fields.find((x) => x.key === 'other_mycotoxin_result')!;
    expect(f.unitConfirmed).toBe(false);
  });

  it('constrains every percentage field to 0-100', () => {
    for (const stage of STAGES) {
      for (const f of STAGE_SCHEMAS[stage].fields) {
        if (f.unit === '%') {
          expect(f.min, `${stage}.${f.key} min`).toBe(0);
          expect(f.max, `${stage}.${f.key} max`).toBe(100);
        }
      }
    }
  });

  it('forbids negative values on every numeric measurement', () => {
    for (const stage of STAGES) {
      for (const f of STAGE_SCHEMAS[stage].fields) {
        if (f.type === 'number') expect(f.min, `${stage}.${f.key}`).toBe(0);
      }
    }
  });

  it('never encodes an operational acceptance limit as a validation bound', () => {
    // The only approved-looking numbers in the source (84-86 degC, 2.2-2.8,
    // 0.5-1%, 1.2-1.8mm, 0.05-0.20, 70-85%) are NOT approved specifications.
    // If any had been pasted into min/max, a value outside them would be
    // rejected at the keyboard, which fabricates a limit the plant never
    // approved. Guard: no numeric bound may equal one of those edges unless
    // it is a true 0/100 percentage boundary.
    const forbidden = [84, 86, 2.2, 2.8, 0.5, 1.2, 1.8, 0.05, 0.2, 70, 85, 850, 950];
    for (const stage of STAGES) {
      for (const f of STAGE_SCHEMAS[stage].fields) {
        for (const bound of [f.min, f.max]) {
          if (bound === undefined) continue;
          if (bound === 0 || bound === 100) continue;
          expect(forbidden, `${stage}.${f.key} bound ${bound}`).not.toContain(bound);
        }
      }
    }
  });

  it('never states an unapproved limit as a bare target in operator-facing help', () => {
    // A validation bound is not the only way an unapproved limit can reach an
    // operator. Help text rendered beside the input is read as authority too,
    // and a numeric "target" there contradicts the Not-assessable chip on the
    // same screen. So any help string quoting one of the source workbook's
    // unapproved figures must carry an explicit marker that it is not approved.
    const unapprovedFigures = [
      /\b84\b/, /\b86\b/, /\b2\.2\b/, /\b2\.8\b/, /\b1\.2\b/, /\b1\.8\b/,
      /\b0\.05\b/, /\b0\.20?\b/, /\b70\b/, /\b85\b/, /\b850\b/, /\b950\b/,
    ];
    const markers = /not an approved limit|reference only|not yet approved|unit not confirmed/i;

    for (const stage of STAGES) {
      for (const f of STAGE_SCHEMAS[stage].fields) {
        if (!f.help) continue;
        const quotes = unapprovedFigures.some((re) => re.test(f.help!));
        if (quotes) {
          expect(
            markers.test(f.help),
            `${stage}.${f.key} help quotes an unapproved figure without marking it: "${f.help}"`,
          ).toBe(true);
        }
      }
    }
  });

  it('links every assessable measurement to a stable parameter key', () => {
    for (const stage of STAGES) {
      for (const f of assessableFields(stage)) {
        expect(f.parameterKey, `${stage}.${f.key}`).toMatch(/^[a-z_]+\.[a-z_]+$/);
      }
    }
  });

  it('keeps parameter keys unique within a stage', () => {
    for (const stage of STAGES) {
      const ks = assessableFields(stage).map((f) => f.parameterKey);
      expect(new Set(ks).size, stage).toBe(ks.length);
    }
  });
});

describe('registry: sampling frequency honesty (FR-020, R-08)', () => {
  it('marks the four unset frequencies as unapproved', () => {
    expect(STAGE_SCHEMAS.ground.frequencyApproved).toBe(false);
    expect(STAGE_SCHEMAS.conditioned.frequencyApproved).toBe(false);
    expect(STAGE_SCHEMAS.pellets.frequencyApproved).toBe(false);
    expect(STAGE_SCHEMAS.crumble.frequencyApproved).toBe(false);
  });

  it('marks the three stated frequencies as approved', () => {
    expect(STAGE_SCHEMAS.raw_materials.frequency).toBe('Every load');
    expect(STAGE_SCHEMAS.raw_materials.frequencyApproved).toBe(true);
    expect(STAGE_SCHEMAS.extruded_soya.frequency).toBe('Every run');
    expect(STAGE_SCHEMAS.extruded_soya.frequencyApproved).toBe(true);
    expect(STAGE_SCHEMAS.mash.frequency).toBe('Once per production run');
    expect(STAGE_SCHEMAS.mash.frequencyApproved).toBe(true);
  });

  it('every stage whose frequency reads "To set" is unapproved', () => {
    for (const stage of STAGES) {
      const s = STAGE_SCHEMAS[stage];
      if (s.frequency === 'To set') expect(s.frequencyApproved, stage).toBe(false);
    }
  });
});
