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
  type FieldDef,
  type Stage,
  type StageSchema,
  YES_NO_OPTIONS,
} from './types.ts';
// The sieve series and its apertures live with the arithmetic that consumes
// them, so the registry reads them rather than restating them. `dgm.ts` has no
// imports of its own, which is what keeps it safe for the Edge Function
// toolchain too (scripts/check-shared-module-imports.mjs).
import { DEFAULT_SIEVE_PRESET, SIEVE_PRESETS } from '../lib/dgm.ts';

const MATERIAL_OPTIONS = [
  { value: 'corn', label: 'Corn' },
  { value: 'rice', label: 'Rice' },
  { value: 'soya', label: 'Soya' },
  { value: 'other', label: 'Other' },
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
    help: 'The date the sample was taken, in Guyana local time.',
  },
  {
    key: 'collection_time',
    columnLetter: 'C',
    sheetHeader: 'Time',
    label: 'Time',
    type: 'time',
    section: 'sample_details',
    required: 'registration',
    help: 'The time the sample was taken, in Guyana local time.',
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
    type: 'text',
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
  help: 'What was done about the result. Required when the sample is placed on hold.',
});

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
      help: '"Other" needs a manual specification review before the load is assessed.',
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
      help: 'Traceability key. For soya this is the lot the extruded soya record links back to.',
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
      type: 'text',
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
// F02 — 2 Ground, A:O (15 columns), prefix AM or BC from the point code
// ---------------------------------------------------------------------------
const ground: StageSchema = {
  stage: 'ground',
  ordinal: 2,
  title: 'Ground',
  sheetTab: '2 Ground',
  lastColumn: 'O',
  columnCount: 15,
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
      help: 'AM is after the mill. BC is before the conditioner. This choice sets the sample ID prefix and whether moisture applies.',
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
      help: 'This batch number links the sample forward to the conditioned mash record.',
    },
    {
      key: 'sampled_by',
      columnLetter: 'G',
      sheetHeader: 'Sampled by',
      label: 'Sampled by',
      type: 'text',
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
      help: 'The screen fitted to the mill when the sample was taken. 5 or 7 mm, as in the source log.',
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
    {
      key: 'avg_particle_size_um',
      columnLetter: 'J',
      sheetHeader: 'Average particle size (µm)',
      label: 'Average particle size',
      type: 'number',
      section: 'test_results',
      required: 'testing',
      unit: 'µm',
      unitConfirmed: true,
      min: 0,
      implausibleAbove: 10000,
      decimals: 1,
      parameterKey: 'ground.avg_particle_size',
      help: HELP.particleSize,
    },
    {
      key: 'size_spread_gsd',
      columnLetter: 'K',
      sheetHeader: 'Size spread (GSD)',
      label: 'Size spread (GSD)',
      type: 'number',
      section: 'test_results',
      required: 'testing',
      // Dimensionless by definition; the workbook `Limits` Unit cell is blank.
      min: 0,
      implausibleAbove: 100,
      decimals: 2,
      parameterKey: 'ground.size_spread_gsd',
      help: HELP.gsd,
    },
    {
      key: 'moisture_pct_bc',
      columnLetter: 'L',
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
    actionTaken('M'),
    ...testedByAndComments('N', 'O'),
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
    'Sample at the conditioner outlet, before the pellet die. Record the conditioner settings in use. Use the same batch no. as the ground material record.',
  frequency: 'To set',
  frequencyApproved: false,
  fields: [
    ...idDateTime(),
    {
      key: 'feed_type',
      columnLetter: 'D',
      sheetHeader: 'Feed type',
      label: 'Feed type',
      type: 'text',
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
      help: 'Use the same batch number as the ground material sample. If the batch cannot be found, a documented exception is recorded.',
    },
    {
      key: 'sampled_by',
      columnLetter: 'F',
      sheetHeader: 'Sampled by',
      label: 'Sampled by',
      type: 'text',
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
      help: 'The unit for this reading is not yet confirmed (bar or kg/cm²), so the value is recorded but never assessed against a limit.',
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
// F04 — 4 Pellets, A:K (11 columns), prefix AP
// ---------------------------------------------------------------------------
const pellets: StageSchema = {
  stage: 'pellets',
  ordinal: 4,
  title: 'Pellets',
  sheetTab: '4 Pellets',
  lastColumn: 'K',
  columnCount: 11,
  prefix: 'AP',
  description: 'Pellets after the die, before crumbling',
  instruction:
    'Sample at the pellet die outlet, before the crumbler. Use the same batch no. as the conditioned mash record.',
  frequency: 'To set',
  frequencyApproved: false,
  fields: [
    ...idDateTime(),
    {
      key: 'feed_type',
      columnLetter: 'D',
      sheetHeader: 'Feed type',
      label: 'Feed type',
      type: 'text',
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
      help: 'Use the same batch number as the conditioned mash sample.',
    },
    {
      key: 'sampled_by',
      columnLetter: 'F',
      sheetHeader: 'Sampled by',
      label: 'Sampled by',
      type: 'text',
      section: 'sample_details',
      required: 'registration',
    },
    {
      key: 'pellet_temperature_c',
      columnLetter: 'G',
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
      columnLetter: 'H',
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
    actionTaken('I'),
    ...testedByAndComments('J', 'K'),
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
    'Sample at the end of every extrusion run. Record the extruder settings and the raw soya lot no. from the raw materials record.',
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
      help: 'Each extrusion run needs its own sample, even when the raw soya lot is unchanged.',
    },
    {
      key: 'raw_soya_lot_no',
      columnLetter: 'E',
      sheetHeader: 'Raw soya lot no.',
      label: 'Raw soya lot no.',
      type: 'text',
      section: 'sample_details',
      required: 'registration',
      help: 'This links the run back to the raw materials record. If the lot is not on file, an authorised traceability exception is recorded.',
    },
    {
      key: 'sampled_by',
      columnLetter: 'F',
      sheetHeader: 'Sampled by',
      label: 'Sampled by',
      type: 'text',
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
// F06 — 6 Crumble, A:M (13 columns), prefix CR
// ---------------------------------------------------------------------------
const crumble: StageSchema = {
  stage: 'crumble',
  ordinal: 6,
  title: 'Crumble',
  sheetTab: '6 Crumble',
  lastColumn: 'M',
  columnCount: 13,
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
      type: 'text',
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
      type: 'text',
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
    {
      key: 'moisture_pct',
      columnLetter: 'H',
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
    {
      key: 'avg_particle_size_um',
      columnLetter: 'I',
      sheetHeader: 'Average particle size (µm)',
      label: 'Average particle size',
      type: 'number',
      section: 'test_results',
      required: 'testing',
      unit: 'µm',
      unitConfirmed: true,
      min: 0,
      implausibleAbove: 10000,
      decimals: 1,
      parameterKey: 'crumble.avg_particle_size',
      help: HELP.particleSize,
    },
    {
      key: 'pellet_durability_pdi_pct',
      columnLetter: 'J',
      sheetHeader: 'Pellet durability (PDI, %)',
      label: 'Pellet durability (PDI)',
      type: 'number',
      section: 'test_results',
      required: 'testing',
      unit: '%',
      unitConfirmed: true,
      min: 0,
      max: 100,
      decimals: 1,
      parameterKey: 'crumble.pellet_durability_pdi',
      help: HELP.pdi,
    },
    {
      key: 'crumble_size_mm',
      columnLetter: 'K',
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
    ...testedByAndComments('L', 'M'),
  ],
};

// ---------------------------------------------------------------------------
// F07 — 7 Mash, A:K (11 columns), prefix MS
// ---------------------------------------------------------------------------
const mash: StageSchema = {
  stage: 'mash',
  ordinal: 7,
  title: 'Mash',
  sheetTab: '7 Mash',
  lastColumn: 'K',
  columnCount: 11,
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
      type: 'text',
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
      help: 'The mixing or production run this mash came from.',
    },
    {
      key: 'sampled_by',
      columnLetter: 'F',
      sheetHeader: 'Sampled by',
      label: 'Sampled by',
      type: 'text',
      section: 'sample_details',
      required: 'registration',
    },
    {
      key: 'moisture_pct',
      columnLetter: 'G',
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
    {
      key: 'avg_particle_size_um',
      columnLetter: 'H',
      sheetHeader: 'Average particle size (µm)',
      label: 'Average particle size',
      type: 'number',
      section: 'test_results',
      required: 'testing',
      unit: 'µm',
      unitConfirmed: true,
      min: 0,
      implausibleAbove: 10000,
      decimals: 1,
      parameterKey: 'mash.avg_particle_size',
      help: HELP.particleSize,
    },
    {
      key: 'size_spread_gsd',
      columnLetter: 'I',
      sheetHeader: 'Size spread (GSD)',
      label: 'Size spread (GSD)',
      type: 'number',
      section: 'test_results',
      required: 'testing',
      min: 0,
      implausibleAbove: 100,
      decimals: 2,
      parameterKey: 'mash.size_spread_gsd',
      help: HELP.gsd,
    },
    ...testedByAndComments('J', 'K'),
  ],
};

// ---------------------------------------------------------------------------
// F08 — 8 DGM, A:AI (35 columns), prefix DG
//
// Granulometry: a seven-sieve stack weighed on crumbled product. Unlike the
// other seven tabs this one was AUTHORED rather than transcribed — the tab did
// not exist in the workbook until 2026-10-29 — so the direction of verification
// is the same but the history is not: the header strings below were typed into
// the live workbook by hand, then READ BACK out of it and copied here. That
// read-back caught a real defect (the micro sign arrived as `¬µ`, because the
// clipboard carried UTF-8 bytes that Sheets decoded as Mac Roman), which is the
// whole reason the step exists.
//
// THREE THINGS THAT LOOK LIKE CHOICES AND ARE NOT:
//
//  1. The sieve masses are `registration`, not `testing`. There is no
//     results-entry screen in this application — `StageFormPage` hardcodes
//     `phase="registration"` — so a `testing` field can be left blank forever
//     with nothing to prompt for it. A DGM test is one bench event anyway: the
//     weighing IS the test, so everything is captured in one submit.
//
//  2. The nine derived columns are `type: 'system'`, exactly like column A.
//     They have to be: `apply_measurement` raises
//     "Column % is assigned by the server and cannot be submitted" for any
//     field whose type OR requiredness is `system`, so a computed value can
//     never be a `sample_measurements` row. They are serialised into the sheet
//     from values the Edge Function injects after validation, and stored in
//     `sample_derived_results`. `validateStagePayload` refuses a client-supplied
//     value for any of them with `server_assigned`, so an operator cannot forge
//     a fineness module.
//
//  3. Nothing here carries a `parameterKey`. With 0 of 34 workbook limits
//     approved, a parameter key buys no assessment and `release_blockers`
//     already treats `not_assessable` as a blocker. Adding one would imply an
//     acceptance limit exists (PRD FR-009, UAT-05) when none does.
// ---------------------------------------------------------------------------

/**
 * The 14 sieve mass columns, K..X, generated from the preset so the ABNT
 * labels and the apertures cannot drift from the arithmetic that consumes
 * them. `src/lib/dgm.ts` is the single definition of the series; this reads it.
 *
 * The pan is named "Pan" rather than by its ABNT designation, because the
 * workbook's own conversion table puts ABNT 400 at 37 µm and marks it as the
 * pan, while the DGM sheet uses 38 µm for ABNT 400 and 37 µm for `Fundo` —
 * possibly the pan counted twice. Until the lab settles that, calling the last
 * position "Pan" says what is physically there without asserting a mesh.
 */
const sieveMassFields = (): FieldDef[] => {
  const tareLetters = ['K', 'M', 'O', 'Q', 'S', 'U', 'W'];
  const grossLetters = ['L', 'N', 'P', 'R', 'T', 'V', 'X'];
  return DEFAULT_SIEVE_PRESET.positions.flatMap((position, i): FieldDef[] => {
    const n = i + 1;
    const name = position.isPan ? 'Pan' : `ABNT ${position.abnt}`;
    const tareHeader = position.isPan ? 'Pan empty (g)' : `${name} empty sieve (g)`;
    const grossHeader = position.isPan ? 'Pan + sample (g)' : `${name} sieve + sample (g)`;
    const aperture = `Aperture ${position.apertureMicrons} µm.`;
    const common = {
      type: 'number',
      section: 'test_results',
      required: 'registration',
      unit: 'g',
      unitConfirmed: true,
      min: 0,
      // A sieve plus a full sample is a few hundred grams. Beyond two
      // kilograms is a mis-keyed decimal point, which the operator confirms
      // rather than the system refusing — it is a typo guard, never a limit.
      implausibleAbove: 2000,
      decimals: 2,
    } as const;
    return [
      {
        ...common,
        key: `sieve${n}_tare_g`,
        columnLetter: tareLetters[i]!,
        sheetHeader: tareHeader,
        label: position.isPan ? 'Pan empty' : `${name} empty sieve`,
        help: `${aperture} Weigh the sieve before any sample is added.`,
      },
      {
        ...common,
        key: `sieve${n}_gross_g`,
        columnLetter: grossLetters[i]!,
        sheetHeader: grossHeader,
        label: position.isPan ? 'Pan + sample' : `${name} sieve + sample`,
        help: `${aperture} Weigh the same sieve again with whatever stayed on it.`,
      },
    ];
  });
};

/** The nine server-computed columns, Y..AG. */
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
      type: 'text',
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
      type: 'text',
      section: 'sample_details',
      required: 'registration',
    },
    {
      key: 'mill_rpm',
      columnLetter: 'G',
      sheetHeader: 'Mill RPM',
      label: 'Mill RPM',
      type: 'number',
      section: 'settings',
      required: 'optional',
      min: 0,
      implausibleAbove: 10000,
      decimals: 0,
      help: 'The mill speed when the product was made, if it is known.',
    },
    {
      key: 'mill_hz_position',
      columnLetter: 'H',
      sheetHeader: 'Mill Hz or position',
      label: 'Mill Hz or position',
      type: 'text',
      section: 'settings',
      required: 'optional',
      help: 'The source sheet records either a frequency or a position setting here.',
    },
    {
      key: 'grind_time',
      columnLetter: 'I',
      sheetHeader: 'Grind time',
      label: 'Grind time',
      type: 'text',
      section: 'settings',
      required: 'optional',
    },
    {
      key: 'sieve_series',
      columnLetter: 'J',
      sheetHeader: 'Sieve series',
      label: 'Sieve series',
      type: 'select',
      section: 'settings',
      required: 'registration',
      // Derived from the arithmetic module rather than re-listed, so a preset
      // can never exist in one file and not the other. Individual apertures
      // are deliberately NOT editable: Kj is assigned by POSITION in the
      // stack and 104.14 is calibrated to this exact series, so a changed
      // aperture would move no number while silently changing what the number
      // means. Changing the stack is adding a preset, which is a code change.
      options: SIEVE_PRESETS.map((preset) => ({ value: preset.id, label: preset.label })),
      help: 'The stack of sieves used. The apertures are fixed by the series and are shown on each weight below.',
    },
    ...sieveMassFields(),
    derivedField(
      'total_retained_g',
      'Y',
      'Total retained (g)',
      'Total retained',
      'The sum of what stayed on every sieve. Worked out by the system.',
    ),
    derivedField(
      'fineness_module',
      'Z',
      'Fineness module (MF)',
      'Fineness module (MF)',
      'How coarse the grind is overall. Worked out by the system from the weights.',
    ),
    derivedField(
      'dgm_um',
      'AA',
      'DGM (µm)',
      'DGM',
      'Average geometric diameter in micrometres. Worked out by the system.',
    ),
    derivedField(
      'ui_coarse_pct',
      'AB',
      'UI coarse (%)',
      'UI coarse',
      'Share of the sample on the two coarsest sieves. Worked out by the system.',
    ),
    derivedField(
      'ui_average_pct',
      'AC',
      'UI average (%)',
      'UI average',
      'Share of the sample on the three middle sieves. Worked out by the system.',
    ),
    derivedField(
      'ui_fine_pct',
      'AD',
      'UI fine (%)',
      'UI fine',
      'Share of the sample on the finest sieve and the pan. Worked out by the system.',
    ),
    derivedField(
      'dpg_legacy_index',
      'AE',
      'DPG legacy index',
      'DPG legacy index',
      'The spreadsheet’s own DPG figure, reproduced exactly so old records still compare. It is an index, not a standard deviation: it carries units and it doubles if you weigh twice as much sample, so it can only be compared between samples of equal mass.',
    ),
    derivedField(
      'gsd',
      'AF',
      'Geometric standard deviation',
      'Geometric standard deviation',
      'How even the grind is, as a proper dimensionless figure. Unlike the DPG index this does not change with how much sample was weighed.',
    ),
    derivedField(
      'gsd_basis',
      'AG',
      'GSD basis',
      'GSD basis',
      'Which convention produced the figure beside it. Recorded because the coarsest sieve has nothing above it and the pan has nothing below it, so both bins need a stated rule that a number cannot carry by itself.',
    ),
    {
      key: 'tested_by_qo',
      columnLetter: 'AH',
      sheetHeader: 'Tested by (QO)',
      label: 'Tested by (QO)',
      type: 'text',
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
export const DASHBOARD_ORDER: readonly StageSchema[] = [
  rawMaterials,
  ground,
  conditioned,
  pellets,
  extrudedSoya,
  crumble,
  mash,
  dgm,
];

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
