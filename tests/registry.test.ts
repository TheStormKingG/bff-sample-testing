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
  RECORD_STAGE_ORDER,
  RETIRED_STAGES,
  resolvePrefix,
  isFieldApplicable,
  adverseObservationFields,
  assessableFields,
  ALL_PREFIXES,
  PROTECTED_HEADER_ROWS,
  FIRST_DATA_ROW,
} from '@/forms/registry';
import { STAGES, type FieldDef, type Stage } from '@/forms/types';
import { columnLetterToIndex, indexToColumnLetter } from '@/forms/sheetMapping';
import { isUnitConfirmed } from '@/lib/assessment';

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
      // Retired but not removed: one figure was recorded against it on a
      // voided record, and an append-only assessment cites that figure.
      'Hammer distance from screen (mm)',
      'Mill rotational speed (rpm)',
      'Sieve shaker frequency (Hz)',
      'Vibration time (min)', 'Sieve series',
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
      'Action taken', 'Tested by (QO)', 'Comments',
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
      'Durability tester RPM', 'Sieve shaker frequency (Hz)',
      'Vibration time (min)', 'Sieve series',
      'Pellet temperature (°C)', 'Pellet diameter (mm)',
      'Sample before tumbling (g)', 'Whole pellets after tumbling (g)',
      'Pellet durability (PDI, %)',
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
      'Action taken', 'Tested by (QO)', 'Comments',
    ],
  },
  extruded_soya: {
    tab: '5 Extruded soya',
    headers: [
      'Sample ID', 'Date', 'Time', 'Run no.', 'Raw soya lot no.', 'Sampled by',
      'Crusher roller gap (mm)', 'Steam line (%)', 'Steam line temperature (°C)',
      'Extruder temperature (°C)', 'Amount (ton/hr)', 'Moisture (%)',
      'Qualitative urease', 'Tested by (QO)', 'Comments',
    ],
  },
  crumble: {
    tab: '6 Crumble',
    headers: [
      'Sample ID', 'Date', 'Time', 'Feed type', 'Batch no.', 'Sampled by',
      'Crumbler roll gap (mm)',
      'Durability tester RPM', 'Sieve shaker frequency (Hz)',
      'Vibration time (min)', 'Sieve series',
      'Moisture (%)',
      'Sample before tumbling (g)', 'Whole pellets after tumbling (g)',
      'Pellet durability (PDI, %)', 'Crumble size (mm)',
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
  mash: {
    tab: '7 Mash',
    headers: [
      'Sample ID', 'Date', 'Time', 'Feed type', 'Batch no.', 'Sampled by',
      'Sieve shaker frequency (Hz)',
      'Vibration time (min)', 'Sieve series',
      'Moisture (%)',
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

  it('total verified columns across the eight tabs is 238', () => {
    // Stated as the sum of its parts rather than as one number, so a change
    // names which side moved. Each line below is one tab's own arithmetic
    // against the width it was last verified at, so a stage that moves for an
    // unrelated reason cannot hide inside the total.
    //
    // The original seven were 98 when they were transcribed on 2026-10-24.
    // TWO UNTOUCHED TABS still account for exactly their original width.
    // `4 Pellets` left that group when it gained the sieve test, and
    // `5 Extruded soya` left it at 0038.
    const TWO_UNTOUCHED: readonly Stage[] = ['raw_materials', 'conditioned'];
    const untouched = TWO_UNTOUCHED.reduce((n, s) => n + STAGE_SCHEMAS[s].columnCount, 0);
    expect(untouched).toBe(19 + 13);

    // 5 Extruded soya: 16 transcribed, minus `Protein solubility (%)`. The
    // urease column did not move the width — it stopped being a number and
    // became a four-option select in the same letter.
    expect(STAGE_SCHEMAS.extruded_soya.columnCount).toBe(16 - 1);

    // The sieve test is 27 columns wherever it lands: 4 settings, 14 masses,
    // 9 computed — minus the drum speed on the two tabs whose product is
    // never tumbled, which is why Ground and Mash carry 26.
    const SIEVE_BLOCK = 4 + 14 + 9;
    expect(SIEVE_BLOCK).toBe(27);

    // 2 Ground: 15 transcribed, two analyser columns traded for the sieve
    // block, and no drum speed (ground meal is not tumbled).
    expect(STAGE_SCHEMAS.ground.columnCount).toBe(15 - 2 + SIEVE_BLOCK - 1);
    // 7 Mash: 11 transcribed, same two traded, same missing drum speed.
    expect(STAGE_SCHEMAS.mash.columnCount).toBe(11 - 2 + SIEVE_BLOCK - 1);
    // 6 Crumble: 13 transcribed, one analyser column traded for the sieve
    // block, and PDI went from one typed-in column to two weighings plus the
    // computed percentage, so +2.
    expect(STAGE_SCHEMAS.crumble.columnCount).toBe(13 - 1 + SIEVE_BLOCK + 2);
    // 4 Pellets: 11 transcribed, the whole sieve block added with its drum
    // speed, plus the three durability columns.
    expect(STAGE_SCHEMAS.pellets.columnCount).toBe(11 + SIEVE_BLOCK + 3);
    // 8 DGM is unchanged: it is the master log the other four write into, and
    // nothing in this round moved a column on it.
    expect(STAGE_SCHEMAS.dgm.columnCount).toBe(35);

    const total = STAGES.reduce((n, s) => n + STAGE_SCHEMAS[s].columnCount, 0);
    expect(total).toBe(238)
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
  it('offers the seven forms fixed by the PRD, and not the retired one', () => {
    expect(DASHBOARD_ORDER).toHaveLength(7);
    expect(DASHBOARD_ORDER.map((s) => s.title)).toEqual([
      'Raw Materials', 'Ground', 'Conditioned', 'Pellets',
      'Extruded Soya', 'Crumble', 'Mash',
    ]);
    expect(DASHBOARD_ORDER.map((s) => s.ordinal)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('still knows about every stage a record can belong to', () => {
    // THE DISTINCTION THIS FILE NOW HAS TO HOLD. `DASHBOARD_ORDER` answers
    // "which forms may somebody open"; `RECORD_STAGE_ORDER` answers "which
    // stages may a record belong to". They stopped being the same list when
    // `8 DGM` was retired with four samples already registered against it, and
    // using the shorter one on a record screen would make those four
    // unfilterable and drop them out of every report.
    expect(RECORD_STAGE_ORDER).toHaveLength(8);
    expect(RECORD_STAGE_ORDER.map((s) => s.ordinal)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect([...RECORD_STAGE_ORDER].map((s) => s.stage).sort()).toEqual([...STAGES].sort());
  });

  it('accounts for every stage as either offered or retired, never neither', () => {
    // `DASHBOARD_ORDER` is a plain array, not a `Record<Stage, …>`, so a stage
    // added to STAGE_SCHEMAS and forgotten here compiles and then vanishes from
    // the dashboard and the phone home screen with no error. `RETIRED_STAGES`
    // is derived from the same array, so the partition below is what notices:
    // a forgotten stage shows up as retired, which is a loud and visible
    // claim rather than a silent absence.
    const offered = DASHBOARD_ORDER.map((s) => s.stage);
    expect([...offered, ...RETIRED_STAGES].sort()).toEqual([...STAGES].sort());
    expect(RETIRED_STAGES).toEqual(['dgm']);
    expect(offered.filter((stage) => RETIRED_STAGES.includes(stage))).toEqual([]);
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
  /*
    NO REGISTRY FIELD USES `appliesWhen` ANY MORE.

    `moisture_pct_bc` was the only one, and migration 0043 removed it — the
    plant does not measure moisture on ground meal. These tests used to run
    against it, and deleting them with the column would have taken UAT-02's
    only coverage with it: the machinery is still in the engine, on both
    sides, and the next conditional column will depend on it being right.

    So they run against a SYNTHETIC field instead. That is weaker in one
    specific way and the weakness is worth naming: nothing now proves the
    registry and the database agree about a real conditional column, because
    there is no real conditional column to agree about. What is still proven
    is that the rule itself works.
  */
  const conditional: FieldDef = {
    key: 'synthetic_bc_only',
    columnLetter: 'ZZ',
    sheetHeader: 'Synthetic',
    label: 'Synthetic',
    type: 'number',
    section: 'test_results',
    required: 'testing',
    appliesWhen: { field: 'sampling_point', equals: ['BC'] },
  };

  it('a BC-only field applies at BC', () => {
    expect(isFieldApplicable(conditional, { sampling_point: 'BC' })).toBe(true);
  });

  it('a BC-only field does not apply at AM', () => {
    expect(isFieldApplicable(conditional, { sampling_point: 'AM' })).toBe(false);
  });

  it('a field with no condition applies whatever the context says', () => {
    // The control. Without it the two assertions above would pass on an
    // `isFieldApplicable` that returned the wrong answer for everything.
    const plain = { ...conditional, appliesWhen: undefined };
    expect(isFieldApplicable(plain, { sampling_point: 'AM' })).toBe(true);
    expect(isFieldApplicable(plain, {})).toBe(true);
  });

  it('the registry declares no conditional column, which is why the above is synthetic', () => {
    const conditionals = STAGES.flatMap((stage) =>
      STAGE_SCHEMAS[stage].fields
        .filter((f) => f.appliesWhen !== undefined)
        .map((f) => `${stage}.${f.key}`),
    );
    // When a real one is added, point the suite back at it and delete the
    // synthetic — and this assertion is what will tell you to.
    expect(conditionals).toEqual([]);
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

  it('declares the steam pressure unit as bar, now that D-05 is decided', () => {
    /*
      THIS ASSERTION USED TO BE ITS OWN OPPOSITE, and that is the point of
      keeping it. Until 2026-11-03 it read `unitConfirmed === false` and
      `unit === undefined`, guarding UAT-07 and risk R-02: the workbook's
      `Limits` row 13 Unit cell literally says "to confirm", so the reading
      could never be assessed, whatever bounds anybody set.

      Open decision D-05 asked what the unit is. The Polinutri process audit
      of 21/10/2026 states the conditioner steam pressure in bar, and Bounty
      Farm confirmed bar on 2026-11-03. So the refusal is lifted — by a
      decision, recorded, not by a developer tidying up a failing test.

      What the assertion guards now is the other direction: that nobody
      silently reverts the unit to null or to the placeholder, which would
      make every approved steam-pressure limit inert while still displaying
      it. `isUnitConfirmed` is applied too, because 'to confirm' is a string
      a careless edit could put in `unit` and this would otherwise pass.
    */
    const f = STAGE_SCHEMAS.conditioned.fields.find((x) => x.key === 'steam_pressure_reading')!;
    expect(f.unit).toBe('bar');
    expect(f.unitConfirmed).toBe(true);
    expect(isUnitConfirmed(f.unit)).toBe(true);
  });

  it('still has a field that carries an unconfirmed unit, so UAT-07 has a subject', () => {
    /*
      The control UAT-07 exercises — a value with no agreed unit is recorded
      but never compared — is a property of the engine, not of steam pressure.
      Confirming one field's unit must not quietly retire the mechanism by
      leaving it with nothing to act on. If this ever reaches zero, the
      engine's unit gate is untested by any real column and the suite should
      say so here rather than keep a green tick on an empty set.
    */
    const unconfirmed = STAGES.flatMap((stage) =>
      STAGE_SCHEMAS[stage].fields
        .filter((f) => f.unitConfirmed === false)
        .map((f) => `${stage}.${f.key}`),
    );
    expect(unconfirmed).toEqual(['raw_materials.other_mycotoxin_result']);
  });

  it('declares the other-mycotoxin result unit UNCONFIRMED', () => {
    const f = STAGE_SCHEMAS.raw_materials.fields.find((x) => x.key === 'other_mycotoxin_result')!;
    expect(f.unitConfirmed).toBe(false);
  });

  it('constrains every percentage field an operator types to 0-100', () => {
    /*
      `min` and `max` are a DATA-ENTRY guard: `apply_measurement` refuses a
      value outside them, which is only reachable for a value somebody
      submits. A `system` column is computed by the server and never passes
      through that check, so bounds on one would be decoration — declared,
      never enforced, and read by the next person as a constraint that
      exists.

      This mattered from 0041, which gave `pellet_durability_pdi_pct` the
      unit `%` so it could be compared against an approved limit. A ratio of
      two weighings above 100% would mean the drum returned more whole
      pellets than went in, which is a weighing error — but catching it
      belongs in the arithmetic that produces the figure, not in a bound
      nothing evaluates.
    */
    const checked: string[] = [];
    for (const stage of STAGES) {
      for (const f of STAGE_SCHEMAS[stage].fields) {
        if (f.unit === '%' && f.type !== 'system') {
          expect(f.min, `${stage}.${f.key} min`).toBe(0);
          expect(f.max, `${stage}.${f.key} max`).toBe(100);
          checked.push(`${stage}.${f.key}`);
        }
      }
    }
    // The sweep found something. Narrowing a rule to a subset that turns out
    // to be empty is how an assertion quietly stops asserting.
    expect(checked.length).toBeGreaterThan(5);
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
