/**
 * Types for the central form-schema registry.
 *
 * One registry, keyed by stage and stable field key, is the single source of
 * truth for: the UI form, client validation, server validation, the Google
 * Sheets column mapping and the specification-parameter linkage. PRD NFR-006
 * forbids "magic column offsets buried throughout UI code", so no module may
 * hardcode a column index or sheet name — everything derives from here.
 */

export const STAGES = [
  'raw_materials',
  'ground',
  'conditioned',
  'pellets',
  'extruded_soya',
  'crumble',
  'mash',
  // Eighth, and last in the workbook. `dgm` is granulometry — a sieve stack
  // weighed on crumbled product. Its order here is the tab order and the
  // dashboard order, and the array POSITION is relied on by nothing: the
  // ordinal is declared per stage. Adding a member here is a compile error in
  // every exhaustive `Record<Stage, …>`, which is the intended early warning.
  'dgm',
] as const;

export type Stage = (typeof STAGES)[number];

/**
 * Row-3 merged band labels, read verbatim from the live workbook on
 * 2026-10-24. The PRD §3.2 form sections (A Sample Details, B Machine
 * Settings, C Test Results, D Review/Action) map onto these one-to-one.
 * Tabs 1, 4 and 7 carry no `settings` band, which matches those stages
 * having no machine-setting columns.
 */
export const SECTIONS = ['sample_details', 'settings', 'test_results', 'follow_up'] as const;
export type Section = (typeof SECTIONS)[number];

export const SECTION_LABELS: Record<Section, string> = {
  sample_details: 'Sample details',
  settings: 'Settings when sampled',
  test_results: 'Test results',
  follow_up: 'Follow-up',
};

export type FieldType =
  | 'system' // assigned by the server; never operator-editable (column A)
  | 'text'
  | 'textarea'
  | 'number'
  | 'date'
  | 'time'
  | 'select'
  | 'yesno';

/**
 * When a field becomes mandatory. PRD §5 preamble: "'Required' below means
 * required for the *specified workflow stage*, not necessarily for initial
 * draft creation". A draft may be incomplete (FR-005).
 */
export type Requiredness =
  | 'system' // server-assigned
  | 'registration' // required to leave Draft and allocate a sample ID
  | 'testing' // required to move Awaiting Results -> Ready for Review
  | 'review' // required to record a review outcome
  | 'optional';

export interface SelectOption {
  /** Stable code persisted in the database. Never the display text. */
  readonly value: string;
  /** Text shown in the UI and written to the sheet cell. */
  readonly label: string;
}

/** Condition under which a field applies at all (e.g. BC-only moisture). */
export interface AppliesWhen {
  readonly field: string;
  readonly equals: readonly string[];
}

export interface FieldDef {
  /** Stable key. Persisted. Never renamed without a migration. */
  readonly key: string;
  /** Workbook column letter. Verified against the live sheet 2026-10-24. */
  readonly columnLetter: string;
  /**
   * Row-4 header text, verbatim from the live workbook. `verifyWorkbook()`
   * compares these against the sheet before any write is allowed; a mismatch
   * fails closed (Master Prompt §3, PRD §4.3).
   */
  readonly sheetHeader: string;
  /** UI label. Usually identical to the header; production vocabulary is kept. */
  readonly label: string;
  readonly type: FieldType;
  readonly section: Section;
  readonly required: Requiredness;

  /** Unit shown beside the input. Absent for dimensionless values such as GSD. */
  readonly unit?: string;
  /**
   * False when the source workbook does not state an approved unit. The only
   * such field is `3 Conditioned` steam pressure, whose `Limits` Unit cell
   * contains the literal string "to confirm". A measurement whose unit is
   * unconfirmed can never be assessed as conforming (PRD §5.3, UAT-07).
   */
  readonly unitConfirmed?: boolean;

  readonly options?: readonly SelectOption[];

  /**
   * Hard bounds. These are physical or logical impossibilities only — a
   * percentage above 100, a negative mass — never operational acceptance
   * limits. Violations are rejected.
   */
  readonly min?: number;
  readonly max?: number;
  /**
   * Soft data-entry guard. A value beyond this is almost certainly a typo, so
   * the UI asks the operator to confirm, but the value is accepted if
   * confirmed. PRD §6.1 permits "configurable upper bounds" to block
   * "scientific nonsense" while reserving operational bounds for process-owner
   * approval. This NEVER contributes to a conformity assessment.
   */
  readonly implausibleAbove?: number;
  /** Decimal places to preserve on display. Entered precision is never truncated. */
  readonly decimals?: number;

  /** Inline help. Taken verbatim from the workbook `Read me` tab where available. */
  readonly help?: string;
  readonly placeholder?: string;

  /**
   * Links this measurement to a specification parameter. Only fields with a
   * parameterKey can ever be assessed; fields without one are recorded only.
   */
  readonly parameterKey?: string;

  /**
   * For yes/no observations, the answer that triggers an immediate quality
   * hold regardless of numeric results (Master Prompt §6, FR-010, UAT-08).
   */
  readonly adverseValue?: 'yes' | 'no';

  /** Field applies only when another field holds one of these values. */
  readonly appliesWhen?: AppliesWhen;
}

export interface StageSchema {
  readonly stage: Stage;
  /**
   * Dashboard ordinal, 1-8. Stages 1-7 are fixed by Master Prompt §2 and
   * PRD §3.1; 8 is DGM, added later. Mirrored by
   * `stage_definitions.ordinal`, whose CHECK constraint bounds the range —
   * so this number is not free-form, and widening it is a migration.
   */
  readonly ordinal: number;
  /** Short dashboard label. */
  readonly title: string;
  /** Exact Google Sheets tab name. The API addressing key. */
  readonly sheetTab: string;
  /** Last column letter of the legacy range. */
  readonly lastColumn: string;
  /** Expected column count. Asserted in tests against the field list. */
  readonly columnCount: number;
  /**
   * Sample-ID prefix. `null` for Ground, whose prefix is AM or BC depending on
   * the structured sampling-point code — derived via `resolvePrefix()`, never
   * by substring-matching display text (PRD §5.2).
   */
  readonly prefix: string | null;
  /** One-line process description for the dashboard card. */
  readonly description: string;
  /** Where and when to take the sample. From the workbook row-2 instruction. */
  readonly instruction: string;
  /** Sampling frequency as stated in the workbook `Read me` tab. */
  readonly frequency: string;
  /**
   * False when the workbook states the frequency as "To set". Five of eight
   * stages are unset — the original four plus DGM, whose frequency the lab
   * has not stated — so no overdue flag or sampling-adherence KPI may be
   * computed for them (FR-020, risk R-08).
   */
  readonly frequencyApproved: boolean;
  readonly fields: readonly FieldDef[];
}

/** A yes/no answer. Stored as a code, written to the sheet as Yes/No. */
export const YES_NO_OPTIONS: readonly SelectOption[] = [
  { value: 'yes', label: 'Yes' },
  { value: 'no', label: 'No' },
] as const;
