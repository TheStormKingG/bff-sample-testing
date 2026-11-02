/**
 * THE FORM SCHEMA REGISTRY — single source of truth.
 *
 * Every `sheetHeader` and `sheetTab` string here was read from the live
 * workbook `BFF-FRM-06_18_Sample_Test_Log_DRAFT`
 * on 2026-10-24 and verified
 * character-for-character against PRD §5. All 98 columns across all 7
 * operational tabs matched with zero divergence. See
 * docs/workbook-verification.md for the evidence record.
 *
 * `help` strings are quoted verbatim from the workbook `Read me` tab, because
 * PRD §11 requires production vocabulary and forbids rewording technical
 * units. Where that text mentions a working range, the range is operator
 * guidance from the source document and carries NO assessment authority —
 * conformity comes only from an approved rule in `specification_versions`.
 */

import {
  STAGES,
  type FieldDef,
  type Requiredness,
  type Stage,
  type StageSchema,
  YES_NO_OPTIONS,
} from './types.ts';
// The sieve series and its apertures live with the arithmetic that consumes
// them, so the registry reads them rather than restating them. `dgm.ts` has no
// imports of its own, which is what keeps it safe for the Edge Function
// toolchain too (scripts/check-shared-module-imports.mjs).
import { DEFAULT_SIEVE_PRESET, SIEVE_PRESETS } from '../lib/dgm.ts';
// Base-26 column arithmetic, so a run of fourteen or nine columns is
// generated from where it starts rather than typed out as letters. Its own
// module because `sheetMapping.ts`, which held it, imports this file.
import { indexToColumnLetter } from './columns.ts';
import { sieveMassHeaders } from '../lib/sieveSeries.ts';

const MATERIAL_OPTIONS = [
  { value: 'corn', label: 'Corn' },
  { value: 'rice', label: 'Rice' },
  { value: 'soya', label: 'Soya' },
  { value: 'other', label: 'Other' },
] as const;

/**
 * The feeds the mill makes, and the people who sample and test them.
 *
 * ===========================================================================
 * THE CODE IS THE LABEL, DELIBERATELY
 * ===========================================================================
 * Everywhere else in this registry a select stores a short code and writes a
 * human label to the sheet — `AM` becomes "AM after mill". These three store
 * exactly what they display, for one reason: all three were FREE TEXT until
 * now, and the database already holds `Grower`, `Stefan` and `Kayla` as typed
 * by an operator. Codes equal to the labels mean those rows are already valid
 * against the new list, their sheet cells keep the characters they have
 * always had, and no migration has to rewrite a single stored measurement.
 *
 * ===========================================================================
 * AND THE LIST HAS A PAST — see `SelectOption.retired`
 * ===========================================================================
 * The values below marked `retired` are not inventions. They are what a
 * query of `sample_measurements` returned on 2026-11-02 for these three
 * fields, minus the ones the live list already covers. They are kept because
 * `encodeEnum` throws on an unknown code: without them, the eight DGM records
 * that say "Crumble" could never be written to the spreadsheet again, and
 * reopening one would show an empty dropdown over a record that holds an
 * answer. They are not offered for a new sample.
 *
 * ===========================================================================
 * CHANGING THEM NEEDS A DEPLOYMENT, AND THAT IS A KNOWN COST
 * ===========================================================================
 * These are source constants, like `MATERIAL_OPTIONS` above, because the
 * option list is the VALIDATION CONTRACT: `enumFieldSchema` is shared with
 * the Edge Functions, so a value not in this file is refused by the server.
 * An administrator-editable list would have to be readable by the server
 * before it could be enforced there — the shape built for the sieve table in
 * 0032 and the DGM targets in 0034. Until that is done, a new sampler on the
 * payroll cannot be recorded without a release, and that is a real
 * operational constraint rather than an oversight.
 */
const FEED_TYPE_OPTIONS = [
  { value: 'Pre-starter', label: 'Pre-starter' },
  { value: 'Starter', label: 'Starter' },
  { value: 'Grower', label: 'Grower' },
  { value: 'Finisher', label: 'Finisher' },
  // Recorded before the list existed. A snapshot of the database, not a
  // design: `Crumble`, `Pellet` and `Pellets` are feed FORMS that operators
  // entered where a feed type was asked for, which is itself the argument
  // for the list.
  { value: 'Crumble', label: 'Crumble', retired: true },
  { value: 'Pellet', label: 'Pellet', retired: true },
  { value: 'Pellets', label: 'Pellets', retired: true },
  { value: 'Broiler Starter (TEST)', label: 'Broiler Starter (TEST)', retired: true },
  { value: 'TEST Broiler Starter', label: 'TEST Broiler Starter', retired: true },
  {
    value: 'TEST BROILER STARTER CRUMBLE (E2E)',
    label: 'TEST BROILER STARTER CRUMBLE (E2E)',
    retired: true,
  },
  { value: 'TEST LAYER MASH (E2E)', label: 'TEST LAYER MASH (E2E)', retired: true },
] as const;

const SAMPLED_BY_OPTIONS = [
  { value: 'Stefan', label: 'Stefan' },
  { value: 'Satesh', label: 'Satesh' },
  { value: 'Kayla', label: 'Kayla' },
  // Commissioning and end-to-end test records. Retired rather than deleted,
  // for the same reason as above: they sit on real rows.
  { value: 'TEST E2E (do not action)', label: 'TEST E2E (do not action)', retired: true },
  { value: 'TEST OPERATOR', label: 'TEST OPERATOR', retired: true },
  { value: 'TEST Quality Officer', label: 'TEST Quality Officer', retired: true },
  { value: 'TEST Quality Manager', label: 'TEST Quality Manager', retired: true },
  { value: 'Autosync Check', label: 'Autosync Check', retired: true },
  { value: 'Live Form Check', label: 'Live Form Check', retired: true },
  { value: 'Test Account (BFF QA)', label: 'Test Account (BFF QA)', retired: true },
] as const;

/**
 * Who may be named as having carried out the test.
 *
 * Shorter than the sampler list on purpose: sampling is a plant task and
 * testing is a Quality Officer's. Nothing here GRANTS that authority — the
 * permission matrix does, on the server — so this is a record of who did the
 * work, not a check that they were allowed to.
 */
const TESTED_BY_OPTIONS = [
  { value: 'Stefan', label: 'Stefan' },
  { value: 'Kayla', label: 'Kayla' },
] as const;

/**
 * Structured sampling-point codes for `2 Ground`. The CODE drives the sample-ID
 * prefix and the BC-moisture rule; the LABEL is what the sheet cell receives.
 * PRD §5.2: "derive prefix AM or BC directly from structured point code rather
 * than free-text substring".
 */
const SAMPLING_POINT_OPTIONS = [
  { value: 'AM', label: 'AM after mill' },
  { value: 'BC', label: 'BC before conditioning' },
] as const;

/**
 * Mill screen sizes present in the source workbook. `Read me`: "Mill screen
 * size (5 or 7 mm)". Administrator-configurable only (PRD §5.2); an operator
 * cannot introduce a third value.
 */
const MILL_SCREEN_OPTIONS = [
  { value: '5', label: '5' },
  { value: '7', label: '7' },
] as const;

// Help text quoted from the workbook `Read me` tab.
const HELP = {
  moisture:
    'How much water is in the sample. Too much lets mould grow in bins and bags.',
  // The workbook's own wording states 84 to 86 °C as a target. Reproducing that
  // bare, beside an assessment chip that correctly reads "Not assessable — no
  // approved limit applies", invites the operator to treat a reference figure as
  // a pass criterion: they read a target, see their value inside it, and record a
  // conforming result against bounds Bounty Farm never approved. That is exactly
  // the outcome FR-009 and UAT-05 exist to prevent. The source wording is kept
  // (PRD §11 requires production vocabulary) but attributed and marked, so the
  // help text cannot contradict the engine on the same screen.
  temperature:
    'How hot the mash or pellets are. The mash needs enough heat to cook through. The workbook Read me tab notes 84 to 86 °C after conditioning — reference only, not an approved limit.',
  particleSize:
    'How fine the grind is, from the particle size analyser and sieves. µm means micrometre, one thousandth of a millimetre. Also called GMD.',
  gsd: 'How even the grind is. A higher number means more very big and very small pieces mixed together.',
  pdi: 'How well pellets or crumbles hold together when shaken in the durability tester. A low number means more dust and broken pieces.',
  size: 'The size of feed the birds get. Crumble size affects how much the birds eat.',
  urease:
    'How much of the raw soya enzyme is left after extrusion. Too high means the soya is undercooked.',
  proteinSolubility:
    'How much of the soya protein the birds can still use. Too low means the soya is overcooked.',
  mycotoxin:
    'Poisons made by mould on grain. They harm bird health and the immune system.',
  visual:
    'Any Yes holds the load until the Quality Officer decides.',
} as const;

/** Columns A-C are identical on all seven tabs. */
const idDateTime = (): FieldDef[] => [
  {
    key: 'sample_id',
    columnLetter: 'A',
    sheetHeader: 'Sample ID',
    label: 'Sample ID',
    type: 'system',
    section: 'sample_details',
    required: 'system',
    help: 'Issued by the system when the sample is registered. Write this ID on the sample bag.',
  },
  {
    key: 'collection_date',
    columnLetter: 'B',
    sheetHeader: 'Date',
    label: 'Date',
    type: 'date',
    section: 'sample_details',
    required: 'registration',
    help: 'Date taken, Guyana local time.',
  },
  {
    key: 'collection_time',
    columnLetter: 'C',
    sheetHeader: 'Time',
    label: 'Time',
    type: 'time',
    section: 'sample_details',
    required: 'registration',
    help: 'Time taken, Guyana local time.',
  },
];

const testedByAndComments = (
  testedByCol: string,
  commentsCol: string,
): FieldDef[] => [
  {
    key: 'tested_by_qo',
    columnLetter: testedByCol,
    sheetHeader: 'Tested by (QO)',
    label: 'Tested by (QO)',
    type: 'select',
    options: TESTED_BY_OPTIONS,
    optionsListKey: 'testers',
    section: 'follow_up',
    required: 'testing',
    help: 'The Quality Officer who actually carried out the test. If that is not you, an attestation is recorded.',
  },
  {
    key: 'comments',
    columnLetter: commentsCol,
    sheetHeader: 'Comments',
    label: 'Comments',
    type: 'textarea',
    section: 'follow_up',
    required: 'optional',
  },
];

const actionTaken = (col: string): FieldDef => ({
  key: 'action_taken',
  columnLetter: col,
  sheetHeader: 'Action taken',
  label: 'Action taken',
  type: 'textarea',
  section: 'follow_up',
  required: 'optional',
  /*
    HIDDEN, AND THE COLUMN STAYS — see `FieldDef.hidden`.

    Three tabs carried it, it was optional on all three, and after the life
    of the system it holds ZERO rows: not one operator has ever used it.
    What they use instead is the disposition and hold flow, which asks for a
    reason, records who gave it and audits it — a free-text box on a form is
    a weaker record of the same thing, and having both invites the real
    decision to be written in the place that is not audited.

    Its help text also said "Required when the sample is placed on hold",
    which nothing enforced and nothing ever has. Removing the field removes
    the false claim with it.

    The column is kept rather than deleted because deleting one means
    restructuring three live workbook tabs and re-widening the frozen rows
    already queued against them. It stays blank, as it has always been.
  */
  hidden: true,
});

// ---------------------------------------------------------------------------
// THE SIEVE TEST — four tabs, one definition
//
// Granulometry by sieve stack is the measurement behind `Average particle
// size` and `Size spread (GSD)`. `8 DGM` records it standalone; `2 Ground`,
// `6 Crumble` and `7 Mash` now record it inline, where those two typed-in
// columns used to sit. The generators below produce the settings, the
// fourteen weights and the nine computed results for ALL FOUR, so the tabs
// cannot drift apart in content or in order.
//
// Each takes the 0-based column index its run STARTS at, because the run
// lands in a different place on every tab. Hand-typed letter arrays were
// defensible for one tab; across four they would be four chances to transpose
// a letter, and a transposed letter puts a header in one column and its value
// in another.
//
// THREE THINGS THAT LOOK LIKE CHOICES AND ARE NOT:
//
//  1. The masses are never `testing`. There is no results-entry screen in
//     this application — `StageFormPage` hardcodes `phase="registration"` —
//     so a `testing` field can be left blank forever with nothing to prompt
//     for it. That is not a hypothetical: `avg_particle_size_um` and
//     `size_spread_gsd` were `testing` on all three tabs, and across every
//     sample ever registered they hold ZERO values. No operator could reach
//     them. Replacing them with fields nobody can fill would have repeated
//     the defect in twenty-three more columns.
//
//     They are `registration` on `8 DGM` and `optional` on the other three,
//     and that difference follows the bench rather than the code. A DGM
//     record IS a sieve test: the weighing is the entire reason the row
//     exists, so a row without it is not a record of anything. A Ground
//     sample is taken at the mill and registered there; its sieve test
//     happens afterwards in the lab. Requiring the weights to register would
//     mean the operator at the mill could not create the record until
//     somebody else had finished the test, which is the wrong way round.
//
//     `sieve_series` follows the masses for the same reason: a stack that
//     was not used yet cannot be named. `derived.ts` falls back to the
//     default preset, and with one preset defined that is the only series
//     there is.
//
//  2. The nine computed columns are `type: 'system'`, exactly like column A.
//     They have to be: `apply_measurement` raises "Column % is assigned by
//     the server and cannot be submitted" for any field whose type OR
//     requiredness is `system`, so a computed value can never be a
//     `sample_measurements` row. They are serialised into the sheet from
//     values the Edge Function injects after validation, and stored in
//     `sample_derived_results`. `validateStagePayload` refuses a
//     client-supplied value for any of them with `server_assigned`, so an
//     operator cannot forge a fineness module.
//
//  3. Nothing here carries a `parameterKey`, including the two computed
//     columns that replace parameters which HAD one. With 0 of 34 workbook
//     limits approved, a parameter key buys no assessment, and a computed
//     value could not be assessed in any case: the engine assesses
//     `sample_measurements` rows and these are not one. Carrying the key
//     forward would imply an acceptance limit exists (PRD FR-009, UAT-05)
//     when none does, on a figure the engine never looks at.
// ---------------------------------------------------------------------------

/**
 * The 14 sieve mass columns, generated from the preset so the ABNT labels and
 * the apertures cannot drift from the arithmetic that consumes them.
 * `src/lib/dgm.ts` is the single definition of the series; this reads it.
 *
 * The pan is named "Pan" rather than by its ABNT designation, because the
 * workbook's own conversion table puts ABNT 400 at 37 µm and marks it as the
 * pan, while the DGM sheet uses 38 µm for ABNT 400 and 37 µm for `Fundo` —
 * possibly the pan counted twice. Until the lab settles that, calling the last
 * position "Pan" says what is physically there without asserting a mesh.
 */
const sieveMassFields = (startIndex: number, required: Requiredness): FieldDef[] =>
  DEFAULT_SIEVE_PRESET.positions.flatMap((position, i): FieldDef[] => {
    const n = i + 1;
    const name = position.isPan ? 'Pan' : `ABNT ${position.abnt}`;
    // Spelled by `sieveMassHeaders`, not here: `expectedHeaders(stage, series)`
    // builds the same two strings from the lab's configured table, and a
    // single space of difference between the two spellings would read as
    // permanent drift on fourteen columns of four tabs.
    const { tare: tareHeader, gross: grossHeader } = sieveMassHeaders(
      position.abnt,
      position.isPan,
    );
    const aperture = `Aperture ${position.apertureMicrons} µm.`;
    const common = {
      type: 'number',
      section: 'test_results',
      required,
      unit: 'g',
      unitConfirmed: true,
      min: 0,
      // A sieve plus a full sample is a few hundred grams. Beyond two
      // kilograms is a mis-keyed decimal point, which the operator confirms
      // rather than the system refusing — it is a typo guard, never a limit.
      implausibleAbove: 2000,
      decimals: 2,
    } as const;
    // Tare and gross alternate, so one sieve's pair is adjacent on the tab
    // exactly as it is adjacent on the form.
    return [
      {
        ...common,
        key: `sieve${n}_tare_g`,
        columnLetter: indexToColumnLetter(startIndex + i * 2),
        sheetHeader: tareHeader,
        label: position.isPan ? 'Pan empty' : `${name} empty sieve`,
        // Seeded from the series, because a sieve's empty weight is the same
        // number every run — and NOT seeded on the gross field below, which
        // is the actual reading. `defaultValue` is applied only to a blank new
        // form, so a figure the operator clears or corrects stays corrected.
        // See `SievePosition.tareDefaultGrams` for why this one measurement
        // is allowed a default and what it costs if the figure is wrong.
        defaultValue: String(position.tareDefaultGrams),
        help: `${aperture} Weigh the sieve before any sample is added.`,
      },
      {
        ...common,
        key: `sieve${n}_gross_g`,
        columnLetter: indexToColumnLetter(startIndex + i * 2 + 1),
        sheetHeader: grossHeader,
        label: position.isPan ? 'Pan + sample' : `${name} sieve + sample`,
        help: `${aperture} Weigh the same sieve again with whatever stayed on it.`,
      },
    ];
  });

/**
 * The four settings that describe HOW the sieve test was run.
 *
 * ===========================================================================
 * WHY THESE KEYS AND NOT THE ONES ON THE DGM TAB
 * ===========================================================================
 * `8 DGM` records three of these under `mill_rpm`, `mill_hz_position` and
 * `grind_time` — names it inherited from a column set written when the tab
 * was thought to be about milling, and that migration 0028 re-headed once the
 * lab explained what they actually are. The headers there are now correct and
 * the keys are not.
 *
 * Those keys are NOT reused here. On `2 Ground` in particular, a field keyed
 * `mill_rpm` meaning "the drum speed of the durability tester" would sit on a
 * form that also records the mill's screen size and hammer distance, and a
 * field keyed `grind_time` meaning "minutes in the vibrator" would read as the
 * grind's duration to every person and every query that ever met it. A
 * misleading key on the stage where the misreading is plausible is worse than
 * an inconsistent one.
 *
 * `8 DGM`'s three keys are deliberately left alone: renaming them is a data
 * migration over the one stage that was verified figure-by-figure against the
 * lab's own workbook, and it buys nothing this change needs. `sieve_series`
 * IS shared, because that name was right the first time — and because it is
 * the one key the arithmetic in `derived.ts` reads by name.
 */
interface SieveSettingsOptions {
  /**
   * Include the Particle Durability Tester's drum speed.
   *
   * It is on the tabs whose product is TUMBLED before the stack is weighed —
   * `4 Pellets` and `6 Crumble` — and on `8 DGM`, which is the master log
   * those two also write to and therefore has to be able to hold the figure.
   * It is NOT on `2 Ground` or `7 Mash`: ground meal and finished mash are
   * never put in the tester's drum, so a drum-speed box on those two forms is
   * a question with no answer, and a blank one on a quality record reads as a
   * step that was skipped rather than one that does not exist.
   */
  readonly durabilityTester: boolean;
}

/*
  The `seriesRequired` parameter is gone with the dropdown it configured.
  Every caller passed 'optional' anyway; the sieve series is now a `system`
  column the server fills in, so there is nothing left for a caller to decide
  about it.
*/
const sieveTestSettings = (
  startIndex: number,
  { durabilityTester }: SieveSettingsOptions,
): FieldDef[] => {
  const settings: Omit<FieldDef, 'columnLetter'>[] = [];
  if (durabilityTester) {
    settings.push({
      key: 'durability_tester_rpm',
      sheetHeader: 'Durability tester RPM',
      label: 'Durability tester RPM',
      type: 'number',
      section: 'settings',
      required: 'optional',
      min: 0,
      implausibleAbove: 10000,
      decimals: 0,
      // Deliberately NOT made conditional on a separate yes/no column. A
      // filled RPM already means "the Particle Durability Tester was used"
      // and a blank one means it was not, so the record answers the question
      // without a second field that could contradict it.
      help: 'Blank unless the tester was used.',
    });
  }
  settings.push(
    {
      key: 'sieve_shaker_hz',
      sheetHeader: 'Sieve shaker frequency (Hz)',
      label: 'Sieve shaker frequency',
      type: 'number',
      unit: 'Hz',
      unitConfirmed: true,
      section: 'settings',
      required: 'optional',
      min: 0,
      implausibleAbove: 200,
      decimals: 0,
      defaultValue: '8',
      help: 'Usually 8 Hz.',
    },
    {
      key: 'sieve_vibration_min',
      sheetHeader: 'Vibration time (min)',
      // NOT grind time. This is how long the stack ran in the vibrator, which
      // is a property of the sieve test and not of how the product was made.
      label: 'Vibration time',
      type: 'number',
      unit: 'min',
      unitConfirmed: true,
      section: 'settings',
      required: 'optional',
      min: 0,
      implausibleAbove: 240,
      decimals: 0,
      defaultValue: '10',
      help: 'Usually 10 minutes.',
    },
    {
      key: 'sieve_series',
      sheetHeader: 'Sieve series',
      label: 'Sieve series',
      type: 'select',
      section: 'settings',
      // Unchanged from the day the column was created: the stored value is
      // still the preset's id and the sheet cell still receives its label.
      options: SIEVE_PRESETS.map((preset) => ({ value: preset.id, label: preset.label })),
      // OPTIONAL on the four inline tabs, which is what every caller of
      // `sieveTestSettings` passed before the parameter was removed. A sample
      // registered at the mill before the lab has run a sieve test records no
      // stack, because none was used yet — requiring one here would refuse
      // the ordinary case on three of the eight tabs.
      required: 'optional',
      /*
        HIDDEN, NOT REMOVED — see `FieldDef.hidden`.

        A dropdown with one option asked the operator, on every sieve test,
        to choose the only answer there is. The list cannot grow by
        configuration either: Kj is assigned by POSITION in the stack and
        104.14 is calibrated to this exact series, so adding a stack is a
        code change by design.

        So the question is gone from the form and the RECORD is not. Which
        stack a sample was weighed on is provenance: the day a second series
        exists, every record made before it has to say which one it was.
        Same column, same heading, same stored code, same text in the cell.
      */
      hidden: true,
      defaultValue: DEFAULT_SIEVE_PRESET.id,
      help: 'The sieve stack used.',
    },
  );
  // Addressed by POSITION in the band, so a tab that carries the tester and a
  // tab that does not both get a contiguous run of columns from `startIndex`
  // with no gap where the omitted field would have been.
  return settings.map((field, i) => ({
    ...field,
    columnLetter: indexToColumnLetter(startIndex + i),
  })) as FieldDef[];
};

/**
 * The pellet durability test: two weights in, one percentage out.
 *
 * ===========================================================================
 * WHY PDI IS NO LONGER TYPED IN
 * ===========================================================================
 * `6 Crumble` carried `Pellet durability (PDI, %)` as a number the operator
 * keyed, which made the record hold a conclusion with no trace of what
 * produced it: a PDI of 97.6 said nothing about whether 500 g or 480 g went
 * into the drum, and nothing could be recomputed or checked afterwards. The
 * method is a ratio of two weighings —
 *
 *     PDI (%) = whole pellets after tumbling / sample before tumbling x 100
 *
 * — so the two weighings are what the operator records and the percentage is
 * what the system works out, exactly as the sieve test's nine columns are.
 * The figure on the record is then always the arithmetic of the figures
 * beside it, and a transcription slip has nowhere to hide.
 *
 * A RESULT ABOVE 100% IS WRITTEN, NOT SUPPRESSED. It is physically
 * impossible — nothing comes out of a tumbler heavier than it went in — so it
 * means one of the two weighings is wrong. Blanking it would hide the fault
 * and leave the operator to wonder why the column is empty; writing it puts
 * the contradiction on the screen beside the two numbers that caused it,
 * where it can be corrected.
 */
const pdiFields = (startIndex: number): FieldDef[] => {
  const at = (offset: number): string => indexToColumnLetter(startIndex + offset);
  const common = {
    type: 'number',
    section: 'test_results',
    // Optional, like the sieve masses beside them: a tab that carries the
    // durability test does not carry it on every sample, and a required pair
    // would block a record of the other measurements on the same form.
    required: 'optional',
    unit: 'g',
    unitConfirmed: true,
    min: 0,
    implausibleAbove: 5000,
    decimals: 2,
  } as const;
  return [
    {
      ...common,
      key: 'pdi_before_g',
      columnLetter: at(0),
      sheetHeader: 'Sample before tumbling (g)',
      label: 'Sample before tumbling',
      // 500 g is the method's figure and the one the lab weighs out, so it is
      // seeded — and, like every default here, only onto a blank new form, so
      // an operator who weighs 498.4 and types it keeps 498.4.
      defaultValue: '500',
      help: 'Weighed whole pellets, before the drum.',
    },
    {
      ...common,
      key: 'pdi_after_g',
      columnLetter: at(1),
      sheetHeader: 'Whole pellets after tumbling (g)',
      label: 'Whole pellets after tumbling',
      help: 'What was left whole on the screen.',
    },
    derivedField(
      'pellet_durability_pdi_pct',
      at(2),
      'Pellet durability (PDI, %)',
      'Pellet durability (PDI)',
      `${HELP.pdi} The two weights above as a percentage, worked out by the system.`,
    ),
  ];
};

/** One server-computed column. */
const derivedField = (
  key: string,
  columnLetter: string,
  sheetHeader: string,
  label: string,
  help: string,
): FieldDef => ({
  key,
  columnLetter,
  sheetHeader,
  label,
  // `system`, like column A: computed by the server, refused from a client,
  // and never a sample_measurements row. See the block comment above.
  type: 'system',
  section: 'test_results',
  required: 'system',
  help,
});

/**
 * The nine columns the server fills in from the weights.
 *
 * `dgm_um` and `gsd` are what `Average particle size (µm)` and `Size spread
 * (GSD)` used to be on `2 Ground`, `6 Crumble` and `7 Mash`: the same two
 * quantities, no longer typed in from an analyser reading but computed from
 * the stack the operator actually weighed. Nothing measured is lost by their
 * removal — those two columns never held a value — and what replaces them
 * arrives with the weights that produced it in the record beside it.
 */
const sieveDerivedFields = (startIndex: number): FieldDef[] => {
  const at = (offset: number): string => indexToColumnLetter(startIndex + offset);
  return [
    derivedField(
      'total_retained_g',
      at(0),
      'Total retained (g)',
      'Total retained',
      'The sum of what stayed on every sieve. Worked out by the system.',
    ),
    derivedField(
      'fineness_module',
      at(1),
      'Fineness module (MF)',
      'Fineness module (MF)',
      'How coarse the grind is overall. Worked out by the system from the weights.',
    ),
    derivedField(
      'dgm_um',
      at(2),
      'DGM (µm)',
      'DGM',
      'Average geometric diameter in micrometres. Worked out by the system.',
    ),
    derivedField(
      'ui_coarse_pct',
      at(3),
      'UI coarse (%)',
      'UI coarse',
      'Share of the sample on the two coarsest sieves. Worked out by the system.',
    ),
    derivedField(
      'ui_average_pct',
      at(4),
      'UI average (%)',
      'UI average',
      'Share of the sample on the three middle sieves. Worked out by the system.',
    ),
    derivedField(
      'ui_fine_pct',
      at(5),
      'UI fine (%)',
      'UI fine',
      'Share of the sample on the finest sieve and the pan. Worked out by the system.',
    ),
    derivedField(
      'dpg_legacy_index',
      at(6),
      'DPG legacy index',
      'DPG legacy index',
      'The spreadsheet’s own DPG figure, reproduced exactly so old records still compare. It is an index, not a standard deviation: it carries units and it doubles if you weigh twice as much sample, so it can only be compared between samples of equal mass.',
    ),
    derivedField(
      'gsd',
      at(7),
      'Geometric standard deviation',
      'Geometric standard deviation',
      'How even the grind is, as a proper dimensionless figure. Unlike the DPG index this does not change with how much sample was weighed.',
    ),
    derivedField(
      'gsd_basis',
      at(8),
      'GSD basis',
      'GSD basis',
      'Which convention produced the figure beside it. Recorded because the coarsest sieve has nothing above it and the pan has nothing below it, so both bins need a stated rule that a number cannot carry by itself.',
    ),
  ];
};

// ---------------------------------------------------------------------------
// F01 — 1 Raw materials, A:S (19 columns), prefix RM
// ---------------------------------------------------------------------------
const rawMaterials: StageSchema = {
  stage: 'raw_materials',
  ordinal: 1,
  title: 'Raw Materials',
  sheetTab: '1 Raw materials',
  lastColumn: 'S',
  columnCount: 19,
  prefix: 'RM',
  description: 'Corn, rice and soya as delivered',
  instruction:
    'Sample every load at the inspection gate, before the load is allowed to offload. Test before any grinding.',
  frequency: 'Every load',
  frequencyApproved: true,
  fields: [
    ...idDateTime(),
    {
      key: 'material',
      columnLetter: 'D',
      sheetHeader: 'Material',
      label: 'Material',
      type: 'select',
      section: 'sample_details',
      required: 'registration',
      options: MATERIAL_OPTIONS,
      help: '"Other" needs a manual review.',
    },
    {
      key: 'supplier',
      columnLetter: 'E',
      sheetHeader: 'Supplier',
      label: 'Supplier',
      type: 'text',
      section: 'sample_details',
      required: 'registration',
    },
    {
      key: 'delivery_or_lot_no',
      columnLetter: 'F',
      sheetHeader: 'Delivery or lot no.',
      label: 'Delivery or lot no.',
      type: 'text',
      section: 'sample_details',
      required: 'registration',
      help: 'Traceability key for this load.',
    },
    {
      key: 'truck_or_container_no',
      columnLetter: 'G',
      sheetHeader: 'Truck or container no.',
      label: 'Truck or container no.',
      type: 'text',
      section: 'sample_details',
      required: 'registration',
    },
    {
      key: 'quantity_received_t',
      columnLetter: 'H',
      sheetHeader: 'Quantity received (tonnes)',
      label: 'Quantity received',
      type: 'number',
      section: 'sample_details',
      required: 'registration',
      unit: 'tonnes',
      unitConfirmed: true,
      min: 0,
      implausibleAbove: 1000,
      decimals: 3,
    },
    {
      key: 'sampled_by',
      columnLetter: 'I',
      sheetHeader: 'Sampled by',
      label: 'Sampled by',
      type: 'select',
      options: SAMPLED_BY_OPTIONS,
      optionsListKey: 'samplers',
      section: 'sample_details',
      required: 'registration',
    },
    {
      key: 'moisture_pct',
      columnLetter: 'J',
      sheetHeader: 'Moisture (%)',
      label: 'Moisture',
      type: 'number',
      section: 'test_results',
      required: 'testing',
      unit: '%',
      unitConfirmed: true,
      min: 0,
      max: 100,
      decimals: 2,
      parameterKey: 'raw_materials.moisture',
      help: HELP.moisture,
    },
    {
      key: 'aflatoxin_ppb',
      columnLetter: 'K',
      sheetHeader: 'Aflatoxin (ppb)',
      label: 'Aflatoxin',
      type: 'number',
      section: 'test_results',
      required: 'testing',
      unit: 'ppb',
      unitConfirmed: true,
      min: 0,
      implausibleAbove: 1000,
      decimals: 2,
      parameterKey: 'raw_materials.aflatoxin',
      help: HELP.mycotoxin,
    },
    {
      key: 'other_mycotoxin_name',
      columnLetter: 'L',
      sheetHeader: 'Other mycotoxin tested (name)',
      label: 'Other mycotoxin tested (name)',
      type: 'text',
      section: 'test_results',
      required: 'optional',
      help: 'If you enter a name you must enter its result. The unit and test method are recorded separately, and no limit comparison is made until they are approved.',
    },
    {
      key: 'other_mycotoxin_result',
      columnLetter: 'M',
      sheetHeader: 'Other mycotoxin result',
      label: 'Other mycotoxin result',
      type: 'number',
      section: 'test_results',
      required: 'optional',
      // Deliberately no unit: the source workbook defines none for this column,
      // so the value is recorded but never compared (Master Prompt §3 F01).
      unitConfirmed: false,
      min: 0,
      decimals: 4,
    },
    {
      key: 'mould_seen',
      columnLetter: 'N',
      sheetHeader: 'Mould seen?',
      label: 'Mould seen?',
      type: 'yesno',
      section: 'test_results',
      required: 'registration',
      options: YES_NO_OPTIONS,
      adverseValue: 'yes',
      help: HELP.visual,
    },
    {
      key: 'insects_seen',
      columnLetter: 'O',
      sheetHeader: 'Insects seen?',
      label: 'Insects seen?',
      type: 'yesno',
      section: 'test_results',
      required: 'registration',
      options: YES_NO_OPTIONS,
      adverseValue: 'yes',
      help: HELP.visual,
    },
    {
      key: 'foreign_matter_seen',
      columnLetter: 'P',
      sheetHeader: 'Foreign matter seen?',
      label: 'Foreign matter seen?',
      type: 'yesno',
      section: 'test_results',
      required: 'registration',
      options: YES_NO_OPTIONS,
      adverseValue: 'yes',
      help: HELP.visual,
    },
    {
      key: 'bad_smell',
      columnLetter: 'Q',
      sheetHeader: 'Bad smell?',
      label: 'Bad smell?',
      type: 'yesno',
      section: 'test_results',
      required: 'registration',
      options: YES_NO_OPTIONS,
      adverseValue: 'yes',
      help: HELP.visual,
    },
    ...testedByAndComments('R', 'S'),
  ],
};

// ---------------------------------------------------------------------------
// F02 — 2 Ground, A:AM (39 columns), prefix AM or BC from the point code
// ---------------------------------------------------------------------------
const ground: StageSchema = {
  stage: 'ground',
  ordinal: 2,
  title: 'Ground',
  sheetTab: '2 Ground',
  lastColumn: 'AM',
  columnCount: 39,
  prefix: null, // resolved from sampling_point — see resolvePrefix()
  description: 'Ground material, before conditioning',
  instruction:
    'AM: single grain at the new sampling door after the mill. BC: mixed mash just before the conditioner. Record the screen size and hammer distance in use.',
  frequency: 'To set',
  frequencyApproved: false,
  fields: [
    ...idDateTime(),
    {
      key: 'sampling_point',
      columnLetter: 'D',
      sheetHeader: 'Sampling point',
      label: 'Sampling point',
      type: 'select',
      section: 'sample_details',
      required: 'registration',
      options: SAMPLING_POINT_OPTIONS,
      help: 'Sets the ID prefix and moisture.',
    },
    {
      key: 'material_or_feed_type',
      columnLetter: 'E',
      sheetHeader: 'Material or feed type',
      label: 'Material or feed type',
      type: 'text',
      section: 'sample_details',
      required: 'registration',
    },
    {
      key: 'batch_or_bin_no',
      columnLetter: 'F',
      sheetHeader: 'Batch or bin no.',
      label: 'Batch or bin no.',
      type: 'text',
      section: 'sample_details',
      required: 'registration',
      help: 'Links forward to the mash record.',
    },
    {
      key: 'sampled_by',
      columnLetter: 'G',
      sheetHeader: 'Sampled by',
      label: 'Sampled by',
      type: 'select',
      options: SAMPLED_BY_OPTIONS,
      optionsListKey: 'samplers',
      section: 'sample_details',
      required: 'registration',
    },
    {
      key: 'mill_screen_size_mm',
      columnLetter: 'H',
      sheetHeader: 'Mill screen size (mm)',
      label: 'Mill screen size',
      type: 'select',
      section: 'settings',
      required: 'registration',
      unit: 'mm',
      unitConfirmed: true,
      options: MILL_SCREEN_OPTIONS,
      help: '5 or 7 mm, as fitted when sampled.',
    },
    {
      key: 'hammer_distance_mm',
      columnLetter: 'I',
      sheetHeader: 'Hammer distance from screen (mm)',
      label: 'Hammer distance from screen',
      type: 'number',
      section: 'settings',
      required: 'registration',
      unit: 'mm',
      unitConfirmed: true,
      min: 0,
      implausibleAbove: 500,
      decimals: 1,
      parameterKey: 'ground.hammer_distance',
    },
    // J..L. The sieve test replaces what used to be J and K: an `Average
    // particle size (µm)` and a `Size spread (GSD)` typed in from an analyser
    // reading, both `testing` and therefore unreachable on a registration-only
    // form — across every Ground sample ever registered, neither column ever
    // held a value. Both quantities are still recorded, as `DGM (µm)` and
    // `Geometric standard deviation` in the computed block below, and now they
    // come from the stack the operator actually weighed.
    //
    // THREE settings, not four. Ground meal never goes in the durability
    // tester's drum, so the drum-speed column was a question this tab could
    // not answer; it was removed at the owner's instruction and everything
    // right of it moved one column left.
    ...sieveTestSettings(9, { durabilityTester: false }),
    {
      key: 'moisture_pct_bc',
      // Kept FIRST in the results band, ahead of the weights, because it is
      // the one result on this tab that is not part of the sieve test.
      columnLetter: 'M',
      sheetHeader: 'Moisture (%) at BC',
      label: 'Moisture at BC',
      type: 'number',
      section: 'test_results',
      required: 'testing',
      unit: '%',
      unitConfirmed: true,
      min: 0,
      max: 100,
      decimals: 2,
      parameterKey: 'ground.moisture',
      // Not applicable at AM. Hidden in the UI and asserted Not Applicable by
      // the server, which never treats the absence as a missing result.
      appliesWhen: { field: 'sampling_point', equals: ['BC'] },
      help: HELP.moisture,
    },
    // N..AA
    ...sieveMassFields(13, 'optional'),
    // AB..AJ
    ...sieveDerivedFields(27),
    actionTaken('AK'),
    ...testedByAndComments('AL', 'AM'),
  ],
};

// ---------------------------------------------------------------------------
// F03 — 3 Conditioned, A:M (13 columns), prefix AC
// ---------------------------------------------------------------------------
const conditioned: StageSchema = {
  stage: 'conditioned',
  ordinal: 3,
  title: 'Conditioned',
  sheetTab: '3 Conditioned',
  lastColumn: 'M',
  columnCount: 13,
  prefix: 'AC',
  description: 'Mash after conditioning, before pelleting',
  instruction:
    'Sample at the conditioner outlet, before the pellet die. Record the conditioner settings in use. Use the same batch no. as the ground material record. If that batch cannot be found, a documented exception is recorded. The unit for the steam pressure reading is not yet confirmed (bar or kg/cm²), so that value is recorded but never assessed against a limit.',
  frequency: 'To set',
  frequencyApproved: false,
  fields: [
    ...idDateTime(),
    {
      key: 'feed_type',
      columnLetter: 'D',
      sheetHeader: 'Feed type',
      label: 'Feed type',
      type: 'select',
      options: FEED_TYPE_OPTIONS,
      optionsListKey: 'feed_types',
      section: 'sample_details',
      required: 'registration',
    },
    {
      key: 'batch_no',
      columnLetter: 'E',
      sheetHeader: 'Batch no.',
      label: 'Batch no.',
      type: 'text',
      section: 'sample_details',
      required: 'registration',
      help: 'Same batch no. as the ground sample.',
    },
    {
      key: 'sampled_by',
      columnLetter: 'F',
      sheetHeader: 'Sampled by',
      label: 'Sampled by',
      type: 'select',
      options: SAMPLED_BY_OPTIONS,
      optionsListKey: 'samplers',
      section: 'sample_details',
      required: 'registration',
    },
    {
      key: 'steam_pressure_reading',
      columnLetter: 'G',
      sheetHeader: 'Steam pressure reading',
      label: 'Steam pressure reading',
      type: 'number',
      section: 'settings',
      required: 'registration',
      // The workbook `Limits` row 13 Unit cell literally reads "to confirm"
      // (bar or kg/cm² per its own note). Until an approved unit exists this
      // reading can never be assessed as conforming — PRD §5.3, R-02, UAT-07.
      unitConfirmed: false,
      min: 0,
      implausibleAbove: 100,
      decimals: 2,
      parameterKey: 'conditioned.steam_pressure',
      // The full sentence moved to the stage instruction when the settings
      // band went to two columns: a cell there is about 131px wide and this
      // ran to six lines in it, leaving a dead zone beside the field next to
      // it. Nothing is lost — `unitConfirmed: false` is what actually stops
      // the engine assessing it, and the instruction above the form says why
      // in full. This keeps the caveat where the figure is typed.
      help: 'Unit not confirmed; not assessed.',
    },
    {
      key: 'water_added_pct',
      columnLetter: 'H',
      sheetHeader: 'Water added (%)',
      label: 'Water added',
      type: 'number',
      section: 'settings',
      required: 'registration',
      unit: '%',
      unitConfirmed: true,
      min: 0,
      max: 100,
      decimals: 2,
      parameterKey: 'conditioned.water_added',
    },
    {
      key: 'mash_temperature_c',
      columnLetter: 'I',
      sheetHeader: 'Mash temperature (°C)',
      label: 'Mash temperature',
      type: 'number',
      section: 'test_results',
      required: 'testing',
      unit: '°C',
      unitConfirmed: true,
      min: 0,
      implausibleAbove: 300,
      decimals: 1,
      parameterKey: 'conditioned.temperature',
      help: HELP.temperature,
    },
    {
      key: 'moisture_pct',
      columnLetter: 'J',
      sheetHeader: 'Moisture (%)',
      label: 'Moisture',
      type: 'number',
      section: 'test_results',
      required: 'testing',
      unit: '%',
      unitConfirmed: true,
      min: 0,
      max: 100,
      decimals: 2,
      parameterKey: 'conditioned.moisture',
      help: HELP.moisture,
    },
    actionTaken('K'),
    ...testedByAndComments('L', 'M'),
  ],
};

// ---------------------------------------------------------------------------
// F04 — 4 Pellets, A:AO (41 columns), prefix AP
//
// THE SIEVE TEST AND THE DURABILITY TEST BOTH LIVE HERE NOW. The tab held
// four measurements — temperature, diameter, an action and a comment — and
// nothing about particle size, while the pellet is the product the plant
// actually sells and the one the durability tester was bought for. It now
// carries the same sieve block as `2 Ground`, `6 Crumble` and `7 Mash`, from
// the same generators, plus the drum speed and the two weighings the PDI is
// computed from.
// ---------------------------------------------------------------------------
const pellets: StageSchema = {
  stage: 'pellets',
  ordinal: 4,
  title: 'Pellets',
  sheetTab: '4 Pellets',
  lastColumn: 'AO',
  columnCount: 41,
  prefix: 'AP',
  description: 'Pellets after the die, before crumbling',
  instruction:
    'Sample at the pellet die outlet, before the crumbler. Use the same batch no. as the conditioned mash record. For durability, weigh the sample, tumble it, then weigh what is left whole; for particle size, weigh each empty sieve and weigh it again with what stayed on it.',
  frequency: 'To set',
  frequencyApproved: false,
  fields: [
    ...idDateTime(),
    {
      key: 'feed_type',
      columnLetter: 'D',
      sheetHeader: 'Feed type',
      label: 'Feed type',
      type: 'select',
      options: FEED_TYPE_OPTIONS,
      optionsListKey: 'feed_types',
      section: 'sample_details',
      required: 'registration',
    },
    {
      key: 'batch_no',
      columnLetter: 'E',
      sheetHeader: 'Batch no.',
      label: 'Batch no.',
      type: 'text',
      section: 'sample_details',
      required: 'registration',
      help: 'Same batch no. as the conditioned.',
    },
    {
      key: 'sampled_by',
      columnLetter: 'F',
      sheetHeader: 'Sampled by',
      label: 'Sampled by',
      type: 'select',
      options: SAMPLED_BY_OPTIONS,
      optionsListKey: 'samplers',
      section: 'sample_details',
      required: 'registration',
    },
    // G..J
    ...sieveTestSettings(6, { durabilityTester: true }),
    {
      key: 'pellet_temperature_c',
      columnLetter: 'K',
      sheetHeader: 'Pellet temperature (°C)',
      label: 'Pellet temperature',
      type: 'number',
      section: 'test_results',
      required: 'testing',
      unit: '°C',
      unitConfirmed: true,
      min: 0,
      implausibleAbove: 300,
      decimals: 1,
      parameterKey: 'pellets.temperature',
      help: HELP.temperature,
    },
    {
      key: 'pellet_diameter_mm',
      columnLetter: 'L',
      sheetHeader: 'Pellet diameter (mm)',
      label: 'Pellet diameter',
      type: 'number',
      section: 'test_results',
      required: 'testing',
      unit: 'mm',
      unitConfirmed: true,
      min: 0,
      implausibleAbove: 100,
      decimals: 2,
      parameterKey: 'pellets.pellet_diameter',
      help: HELP.size,
    },
    // M..O
    ...pdiFields(12),
    // P..AC
    ...sieveMassFields(15, 'optional'),
    // AD..AL
    ...sieveDerivedFields(29),
    actionTaken('AM'),
    ...testedByAndComments('AN', 'AO'),
  ],
};

// ---------------------------------------------------------------------------
// F05 — 5 Extruded soya, A:P (16 columns), prefix ES
// ---------------------------------------------------------------------------
const extrudedSoya: StageSchema = {
  stage: 'extruded_soya',
  ordinal: 5,
  title: 'Extruded Soya',
  sheetTab: '5 Extruded soya',
  lastColumn: 'P',
  columnCount: 16,
  prefix: 'ES',
  description: 'Full-fat soya after the extruder',
  instruction:
    'Sample at the end of every extrusion run. Record the extruder settings and the raw soya lot no. from the raw materials record. If the lot is not on file, an authorised traceability exception is recorded.',
  frequency: 'Every run',
  frequencyApproved: true,
  fields: [
    ...idDateTime(),
    {
      key: 'run_no',
      columnLetter: 'D',
      sheetHeader: 'Run no.',
      label: 'Run no.',
      type: 'text',
      section: 'sample_details',
      required: 'registration',
      help: 'Each run needs its own sample.',
    },
    {
      key: 'raw_soya_lot_no',
      columnLetter: 'E',
      sheetHeader: 'Raw soya lot no.',
      label: 'Raw soya lot no.',
      type: 'text',
      section: 'sample_details',
      required: 'registration',
      help: 'Links the run back to raw materials.',
    },
    {
      key: 'sampled_by',
      columnLetter: 'F',
      sheetHeader: 'Sampled by',
      label: 'Sampled by',
      type: 'select',
      options: SAMPLED_BY_OPTIONS,
      optionsListKey: 'samplers',
      section: 'sample_details',
      required: 'registration',
    },
    {
      key: 'crusher_roller_gap_mm',
      columnLetter: 'G',
      sheetHeader: 'Crusher roller gap (mm)',
      label: 'Crusher roller gap',
      type: 'number',
      section: 'settings',
      required: 'registration',
      unit: 'mm',
      unitConfirmed: true,
      min: 0,
      implausibleAbove: 100,
      decimals: 2,
      parameterKey: 'extruded_soya.crusher_roller_gap',
    },
    {
      key: 'steam_line_pct',
      columnLetter: 'H',
      sheetHeader: 'Steam line (%)',
      label: 'Steam line',
      type: 'number',
      section: 'settings',
      required: 'registration',
      unit: '%',
      unitConfirmed: true,
      min: 0,
      max: 100,
      decimals: 1,
      parameterKey: 'extruded_soya.steam_line',
    },
    {
      key: 'steam_line_temperature_c',
      columnLetter: 'I',
      sheetHeader: 'Steam line temperature (°C)',
      label: 'Steam line temperature',
      type: 'number',
      section: 'settings',
      required: 'registration',
      unit: '°C',
      unitConfirmed: true,
      min: 0,
      implausibleAbove: 400,
      decimals: 1,
      parameterKey: 'extruded_soya.steam_line_temperature',
    },
    {
      key: 'extruder_temperature_c',
      columnLetter: 'J',
      sheetHeader: 'Extruder temperature (°C)',
      label: 'Extruder temperature',
      type: 'number',
      section: 'settings',
      required: 'registration',
      unit: '°C',
      unitConfirmed: true,
      min: 0,
      implausibleAbove: 400,
      decimals: 1,
      parameterKey: 'extruded_soya.extruder_temperature',
    },
    {
      key: 'amount_ton_hr',
      columnLetter: 'K',
      sheetHeader: 'Amount (ton/hr)',
      label: 'Amount',
      type: 'number',
      section: 'settings',
      required: 'registration',
      unit: 'ton/hr',
      unitConfirmed: true,
      min: 0,
      implausibleAbove: 200,
      decimals: 2,
      parameterKey: 'extruded_soya.amount',
    },
    {
      key: 'moisture_pct',
      columnLetter: 'L',
      sheetHeader: 'Moisture (%)',
      label: 'Moisture',
      type: 'number',
      section: 'test_results',
      required: 'testing',
      unit: '%',
      unitConfirmed: true,
      min: 0,
      max: 100,
      decimals: 2,
      parameterKey: 'extruded_soya.moisture',
      help: HELP.moisture,
    },
    {
      key: 'urease_ph_rise',
      columnLetter: 'M',
      sheetHeader: 'Urease (pH rise)',
      label: 'Urease',
      type: 'number',
      section: 'test_results',
      required: 'testing',
      unit: 'pH rise',
      unitConfirmed: true,
      min: 0,
      implausibleAbove: 14,
      decimals: 3,
      parameterKey: 'extruded_soya.urease',
      help: HELP.urease,
    },
    {
      key: 'protein_solubility_pct',
      columnLetter: 'N',
      sheetHeader: 'Protein solubility (%)',
      label: 'Protein solubility',
      type: 'number',
      section: 'test_results',
      required: 'testing',
      unit: '%',
      unitConfirmed: true,
      min: 0,
      max: 100,
      decimals: 1,
      parameterKey: 'extruded_soya.protein_solubility',
      help: HELP.proteinSolubility,
    },
    ...testedByAndComments('O', 'P'),
  ],
};

// ---------------------------------------------------------------------------
// F06 — 6 Crumble, A:AO (41 columns), prefix CR
// ---------------------------------------------------------------------------
const crumble: StageSchema = {
  stage: 'crumble',
  ordinal: 6,
  title: 'Crumble',
  sheetTab: '6 Crumble',
  lastColumn: 'AO',
  columnCount: 41,
  prefix: 'CR',
  description: 'Finished crumble',
  instruction:
    'Sample finished crumble at the crumbler outlet. Record the roll gap in use.',
  frequency: 'To set',
  frequencyApproved: false,
  fields: [
    ...idDateTime(),
    {
      key: 'feed_type',
      columnLetter: 'D',
      sheetHeader: 'Feed type',
      label: 'Feed type',
      type: 'select',
      options: FEED_TYPE_OPTIONS,
      optionsListKey: 'feed_types',
      section: 'sample_details',
      required: 'registration',
    },
    {
      key: 'batch_no',
      columnLetter: 'E',
      sheetHeader: 'Batch no.',
      label: 'Batch no.',
      type: 'text',
      section: 'sample_details',
      required: 'registration',
    },
    {
      key: 'sampled_by',
      columnLetter: 'F',
      sheetHeader: 'Sampled by',
      label: 'Sampled by',
      type: 'select',
      options: SAMPLED_BY_OPTIONS,
      optionsListKey: 'samplers',
      section: 'sample_details',
      required: 'registration',
    },
    {
      key: 'crumbler_roll_gap_mm',
      columnLetter: 'G',
      sheetHeader: 'Crumbler roll gap (mm)',
      label: 'Crumbler roll gap',
      type: 'number',
      section: 'settings',
      required: 'registration',
      unit: 'mm',
      unitConfirmed: true,
      min: 0,
      implausibleAbove: 100,
      decimals: 2,
      parameterKey: 'crumble.roll_gap',
    },
    // H..K. The drum speed belongs on this tab more than on any other: the
    // tester's drum is what crumbles are tumbled in before they are weighed.
    ...sieveTestSettings(7, { durabilityTester: true }),
    {
      key: 'moisture_pct',
      columnLetter: 'L',
      sheetHeader: 'Moisture (%)',
      label: 'Moisture',
      type: 'number',
      section: 'test_results',
      required: 'testing',
      unit: '%',
      unitConfirmed: true,
      min: 0,
      max: 100,
      decimals: 2,
      parameterKey: 'crumble.moisture',
      help: HELP.moisture,
    },
    // `avg_particle_size_um` stood at I: a figure typed in from an analyser
    // reading, `testing` and therefore unreachable on a registration-only
    // form — no Crumble sample ever carried a value for it. It is now
    // computed, as `DGM (µm)`, from the weights below.
    //
    // M..O. `Pellet durability (PDI, %)` stood alone at M as a percentage the
    // operator keyed. It is still at the same place in the reading order but
    // it is now the THIRD of three columns: the two weighings that produce
    // it, then the percentage itself, computed. See `pdiFields`.
    ...pdiFields(12),
    {
      key: 'crumble_size_mm',
      columnLetter: 'P',
      sheetHeader: 'Crumble size (mm)',
      label: 'Crumble size',
      type: 'number',
      section: 'test_results',
      required: 'testing',
      unit: 'mm',
      unitConfirmed: true,
      min: 0,
      implausibleAbove: 100,
      decimals: 2,
      parameterKey: 'crumble.crumble_size',
      help: HELP.size,
    },
    // Q..AD
    ...sieveMassFields(16, 'optional'),
    // AE..AM
    ...sieveDerivedFields(30),
    ...testedByAndComments('AN', 'AO'),
  ],
};

// ---------------------------------------------------------------------------
// F07 — 7 Mash, A:AI (35 columns), prefix MS
// ---------------------------------------------------------------------------
const mash: StageSchema = {
  stage: 'mash',
  ordinal: 7,
  title: 'Mash',
  sheetTab: '7 Mash',
  lastColumn: 'AI',
  columnCount: 35,
  prefix: 'MS',
  description: 'Finished mash',
  instruction:
    'Sample finished mash at the mixer discharge, once per production run.',
  frequency: 'Once per production run',
  frequencyApproved: true,
  fields: [
    ...idDateTime(),
    {
      key: 'feed_type',
      columnLetter: 'D',
      sheetHeader: 'Feed type',
      label: 'Feed type',
      type: 'select',
      options: FEED_TYPE_OPTIONS,
      optionsListKey: 'feed_types',
      section: 'sample_details',
      required: 'registration',
    },
    {
      key: 'batch_no',
      columnLetter: 'E',
      sheetHeader: 'Batch no.',
      label: 'Batch no.',
      type: 'text',
      section: 'sample_details',
      required: 'registration',
      help: 'The production run it came from.',
    },
    {
      key: 'sampled_by',
      columnLetter: 'F',
      sheetHeader: 'Sampled by',
      label: 'Sampled by',
      type: 'select',
      options: SAMPLED_BY_OPTIONS,
      optionsListKey: 'samplers',
      section: 'sample_details',
      required: 'registration',
    },
    // G..I. `7 Mash` had no settings band at all until now: nothing about how
    // the mash was made was recorded on the tab. These three describe the
    // sieve test rather than the mixer, which is what the band means on every
    // other tab that has one. No drum speed: finished mash is not tumbled.
    ...sieveTestSettings(6, { durabilityTester: false }),
    {
      key: 'moisture_pct',
      // Kept first in the results band, ahead of the weights: the one result
      // on this tab that is not part of the sieve test.
      columnLetter: 'J',
      sheetHeader: 'Moisture (%)',
      label: 'Moisture',
      type: 'number',
      section: 'test_results',
      required: 'testing',
      unit: '%',
      unitConfirmed: true,
      min: 0,
      max: 100,
      decimals: 2,
      parameterKey: 'mash.moisture',
      help: HELP.moisture,
    },
    // `avg_particle_size_um` (H) and `size_spread_gsd` (I) stood here: two
    // figures typed in from an analyser reading, both `testing` and therefore
    // unreachable on a registration-only form — no Mash sample ever carried a
    // value for either. They return below as `DGM (µm)` and `Geometric
    // standard deviation`, computed from the weights rather than transcribed.
    // K..X
    ...sieveMassFields(10, 'optional'),
    // Y..AG
    ...sieveDerivedFields(24),
    ...testedByAndComments('AH', 'AI'),
  ],
};

// ---------------------------------------------------------------------------
// F08 — 8 DGM, A:AI (35 columns), prefix DG
//
// Granulometry standalone: a seven-sieve stack weighed on crumbled product,
// with no other measurement on the tab. Unlike the other seven tabs this one
// was AUTHORED rather than transcribed — it did not exist in the workbook
// until 2026-10-29 — so the direction of verification is the same but the
// history is not: the header strings were typed into the live workbook by
// hand, then READ BACK out of it and copied here. That read-back caught a
// real defect (the micro sign arrived as `¬µ`, because the clipboard carried
// UTF-8 bytes that Sheets decoded as Mac Roman), which is the whole reason
// the step exists.
//
// Its settings, weights and computed columns come from the same generators
// `2 Ground`, `6 Crumble` and `7 Mash` use — see THE SIEVE TEST above, which
// also explains why this tab keeps its three legacy setting keys while the
// other three do not.
// ---------------------------------------------------------------------------

const dgm: StageSchema = {
  stage: 'dgm',
  ordinal: 8,
  title: 'DGM',
  sheetTab: '8 DGM',
  lastColumn: 'AI',
  columnCount: 35,
  prefix: 'DG',
  description: 'Particle size by sieve analysis',
  instruction:
    'Run the sieve test on crumbled product. Weigh each empty sieve, then weigh it again with the sample retained on it.',
  frequency: 'To set',
  frequencyApproved: false,
  fields: [
    ...idDateTime(),
    {
      key: 'feed_type',
      columnLetter: 'D',
      sheetHeader: 'Feed type',
      label: 'Feed type',
      type: 'select',
      options: FEED_TYPE_OPTIONS,
      optionsListKey: 'feed_types',
      section: 'sample_details',
      required: 'registration',
    },
    {
      key: 'batch_no',
      columnLetter: 'E',
      sheetHeader: 'Batch no.',
      label: 'Batch no.',
      type: 'text',
      section: 'sample_details',
      required: 'registration',
    },
    {
      key: 'sampled_by',
      columnLetter: 'F',
      sheetHeader: 'Sampled by',
      label: 'Sampled by',
      type: 'select',
      options: SAMPLED_BY_OPTIONS,
      optionsListKey: 'samplers',
      section: 'sample_details',
      required: 'registration',
    },
    {
      key: 'mill_rpm',
      columnLetter: 'G',
      sheetHeader: 'Durability tester RPM',
      label: 'Durability tester RPM',
      type: 'number',
      section: 'settings',
      required: 'optional',
      min: 0,
      implausibleAbove: 10000,
      decimals: 0,
      // Deliberately NOT made conditional on a separate yes/no column. A
      // filled RPM already means "the Particle Durability Tester was used"
      // and a blank one means it was not, so the record answers the question
      // without a second field that could contradict it.
      help: 'Blank unless the tester was used.',
    },
    {
      key: 'mill_hz_position',
      columnLetter: 'H',
      sheetHeader: 'Sieve shaker frequency (Hz)',
      label: 'Sieve shaker frequency',
      type: 'number',
      unit: 'Hz',
      section: 'settings',
      required: 'optional',
      min: 0,
      implausibleAbove: 200,
      decimals: 0,
      defaultValue: '8',
      help: 'Usually 8 Hz.',
    },
    {
      key: 'grind_time',
      columnLetter: 'I',
      sheetHeader: 'Vibration time (min)',
      // NOT grind time, whatever the column WAS called. This is how long the
      // stack ran in the vibrator, which is a property of the sieve test and
      // not of how the product was made.
      label: 'Vibration time',
      type: 'number',
      unit: 'min',
      section: 'settings',
      required: 'optional',
      min: 0,
      implausibleAbove: 240,
      decimals: 0,
      defaultValue: '10',
      help: 'Usually 10 minutes.',
    },
    {
      key: 'sieve_series',
      columnLetter: 'J',
      sheetHeader: 'Sieve series',
      label: 'Sieve series',
      type: 'select',
      section: 'settings',
      // Unchanged from the day the column was created: the stored value is
      // still the preset's id and the sheet cell still receives its label.
      options: SIEVE_PRESETS.map((preset) => ({ value: preset.id, label: preset.label })),
      required: 'registration',
      /*
        HIDDEN, NOT REMOVED — see `FieldDef.hidden`.

        A dropdown with one option asked the operator, on every sieve test,
        to choose the only answer there is. The list cannot grow by
        configuration either: Kj is assigned by POSITION in the stack and
        104.14 is calibrated to this exact series, so adding a stack is a
        code change by design.

        So the question is gone from the form and the RECORD is not. Which
        stack a sample was weighed on is provenance: the day a second series
        exists, every record made before it has to say which one it was.
        Same column, same heading, same stored code, same text in the cell.
      */
      hidden: true,
      defaultValue: DEFAULT_SIEVE_PRESET.id,
      help: 'The sieve stack used.',
    },
    // K..X, the same fourteen weights the three inline sieve tabs carry.
    ...sieveMassFields(10, 'registration'),
    // Y..AG
    ...sieveDerivedFields(24),
    {
      key: 'tested_by_qo',
      columnLetter: 'AH',
      sheetHeader: 'Tested by (QO)',
      label: 'Tested by (QO)',
      type: 'select',
      options: TESTED_BY_OPTIONS,
      optionsListKey: 'testers',
      section: 'follow_up',
      // `registration`, not `testing` as on the other seven tabs: everything
      // on this form is captured in one submit, so a `testing` requiredness
      // would never be prompted for. See note 1 above.
      required: 'registration',
      help: 'The Quality Officer who actually carried out the test. If that is not you, an attestation is recorded.',
    },
    {
      key: 'comments',
      columnLetter: 'AI',
      sheetHeader: 'Comments',
      label: 'Comments',
      type: 'textarea',
      section: 'follow_up',
      required: 'optional',
    },
  ],
};

export const STAGE_SCHEMAS: Readonly<Record<Stage, StageSchema>> = {
  raw_materials: rawMaterials,
  ground,
  conditioned,
  pellets,
  extruded_soya: extrudedSoya,
  crumble,
  mash,
  dgm,
};

/**
 * The eight dashboard cards. Stages 1-7 are in the order fixed by Master
 * Prompt §2; DGM is eighth, matching its workbook tab.
 *
 * NOT compile-checked against `Stage` — this is a plain array, so a stage
 * added to `STAGE_SCHEMAS` and forgotten here disappears from the dashboard
 * and the phone home screen with no error. `tests/registry.test.ts` compares
 * the two.
 */
/**
 * The forms an operator may open, in order.
 *
 * `8 DGM` IS DELIBERATELY ABSENT, and absent is not the same as deleted. The
 * sieve test it existed to capture now sits inline on `2 Ground`, `6 Crumble`
 * and `7 Mash`, where the sample it describes is already being recorded, so a
 * standalone granulometry form would be a second place to put the same
 * measurement.
 *
 * The STAGE itself stays: it is still in `STAGES`, still in `STAGE_SCHEMAS`,
 * still in the `sample_stage` enum and still a tab in the workbook. Four
 * records were registered against it — DG-261029-01 and DG-261030-01/02/03 —
 * and this is a quality-management record set. A retired form must go on
 * rendering the records it took, or those records become unreadable rows in a
 * spreadsheet. `RETIRED_STAGES` is what `StageFormPage` refuses a NEW sample
 * on; everything that READS a sample is untouched.
 */
export const DASHBOARD_ORDER: readonly StageSchema[] = [
  rawMaterials,
  ground,
  conditioned,
  pellets,
  extrudedSoya,
  crumble,
  mash,
];

/**
 * Stages whose form is closed to new samples but whose records remain.
 *
 * Derived FROM `DASHBOARD_ORDER` rather than listed again, so a stage can
 * never be dropped from the dashboard while quietly staying reachable by URL.
 */
export const RETIRED_STAGES: readonly Stage[] = STAGES.filter(
  (stage) => !DASHBOARD_ORDER.some((schema) => schema.stage === stage),
);

export function isRetiredStage(stage: Stage): boolean {
  return RETIRED_STAGES.includes(stage);
}

/**
 * Every stage in workbook order, RETIRED ONES INCLUDED.
 *
 * ===========================================================================
 * WHY THIS IS NOT `DASHBOARD_ORDER`
 * ===========================================================================
 * `DASHBOARD_ORDER` answers "which forms may somebody open". This answers
 * "which stages may a record belong to", and the two stopped being the same
 * list the moment `8 DGM` was retired with four samples already registered
 * against it.
 *
 * Everything that READS records uses this one: the Samples filter, the
 * specification stage picker, the report breakdowns, the admin lists. Using
 * the dashboard list there would have made four real samples unfilterable and
 * dropped them out of every report — not by deleting anything, which would at
 * least be visible, but by quietly narrowing the question being asked.
 *
 * A retired stage therefore shows up as a row that is usually zero. That is
 * the correct cost: a figure that reads "0 today" is a true statement about a
 * closed form, while its absence would be a false statement about the record
 * set.
 */
export const RECORD_STAGE_ORDER: readonly StageSchema[] = [...STAGES]
  .map((stage) => STAGE_SCHEMAS[stage])
  .sort((a, b) => a.ordinal - b.ordinal);

export function getSchema(stage: Stage): StageSchema {
  return STAGE_SCHEMAS[stage];
}

export function getField(stage: Stage, key: string): FieldDef | undefined {
  return STAGE_SCHEMAS[stage].fields.find((f) => f.key === key);
}

/** All rows 1-4 are protected: 1-2 title/instruction, 3 merged bands, 4 headers. */
export const PROTECTED_HEADER_ROWS = 4;
/** Data starts at row 5 (`Read me` and the template's own layout). */
export const FIRST_DATA_ROW = 5;

/** Reference tabs that must be preserved and never written to. */
export const REFERENCE_TABS = ['Read me', 'Limits'] as const;

/**
 * Resolve the sample-ID prefix.
 *
 * Ground is the only stage whose prefix varies, and it is derived from the
 * STRUCTURED point code ('AM' | 'BC'), never by substring-matching the display
 * label — PRD §5.2. An unknown code is an error rather than a default, so a
 * bad enum can never silently mint an 'AM' identifier.
 */
export function resolvePrefix(
  stage: Stage,
  values: Readonly<Record<string, unknown>> = {},
): string {
  const schema = STAGE_SCHEMAS[stage];
  if (schema.prefix !== null) return schema.prefix;

  const point = values['sampling_point'];
  if (point === 'AM' || point === 'BC') return point;
  throw new Error(
    `Cannot resolve sample ID prefix for stage "${stage}": sampling_point must be "AM" or "BC", received ${JSON.stringify(point)}`,
  );
}

/**
 * Every prefix the system can issue. Used by the DB counter constraint.
 *
 * NOT derived from `STAGE_SCHEMAS` and not type-checked against it:
 * `StageSchema.prefix` is a plain `string | null`, so declaring a stage with a
 * prefix that is missing here compiles cleanly and then fails at runtime
 * inside identifier allocation. `tests/registry.test.ts` compares the two.
 *
 * 'DG' and not 'DGM': `sample_prefixes_shape` is
 * `check (prefix ~ '^[A-Z]{2}$')` — exactly two letters.
 */
export const ALL_PREFIXES = ['RM', 'AM', 'BC', 'AC', 'AP', 'ES', 'CR', 'MS', 'DG'] as const;
export type SamplePrefix = (typeof ALL_PREFIXES)[number];

/**
 * Is a field applicable given the current values? A non-applicable field
 * assesses as `not_applicable`, which is distinct from `not_tested`.
 */
export function isFieldApplicable(
  field: FieldDef,
  values: Readonly<Record<string, unknown>>,
): boolean {
  if (!field.appliesWhen) return true;
  const actual = values[field.appliesWhen.field];
  return field.appliesWhen.equals.includes(String(actual));
}

/** Fields required to leave Draft and allocate an ID, given current values. */
export function fieldsRequiredAt(
  stage: Stage,
  phase: 'registration' | 'testing' | 'review',
  values: Readonly<Record<string, unknown>>,
): readonly FieldDef[] {
  return STAGE_SCHEMAS[stage].fields.filter(
    (f) => f.required === phase && isFieldApplicable(f, values),
  );
}

/** Fields that can carry a conformity assessment. */
export function assessableFields(stage: Stage): readonly FieldDef[] {
  return STAGE_SCHEMAS[stage].fields.filter((f) => f.parameterKey !== undefined);
}

/** The adverse-observation fields whose "yes" forces a hold. */
export function adverseObservationFields(stage: Stage): readonly FieldDef[] {
  return STAGE_SCHEMAS[stage].fields.filter((f) => f.adverseValue !== undefined);
}
