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
} from './types';

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

export const STAGE_SCHEMAS: Readonly<Record<Stage, StageSchema>> = {
  raw_materials: rawMaterials,
  ground,
  conditioned,
  pellets,
  extruded_soya: extrudedSoya,
  crumble,
  mash,
};

/** The seven dashboard cards, in the order fixed by Master Prompt §2. */
export const DASHBOARD_ORDER: readonly StageSchema[] = [
  rawMaterials,
  ground,
  conditioned,
  pellets,
  extrudedSoya,
  crumble,
  mash,
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

/** Every prefix the system can issue. Used by the DB counter constraint. */
export const ALL_PREFIXES = ['RM', 'AM', 'BC', 'AC', 'AP', 'ES', 'CR', 'MS'] as const;
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
