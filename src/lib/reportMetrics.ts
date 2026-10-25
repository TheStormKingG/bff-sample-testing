/**
 * Report metrics — a pure module, so every figure the plant sees is testable.
 *
 * Three rules shape the whole file.
 *
 * 1. A COUNT and an ABSENCE OF A COUNT are different values. Zero samples
 *    today is `0`; a query that did not run is `Insufficient data`. Collapsing
 *    the second into the first is the most convincing way to lie with a
 *    dashboard, so the input type makes it impossible to do by accident
 *    (PRD §12: "Display 'insufficient data' instead of misleading zero").
 *
 * 2. Every metric declares its numerator, denominator, timestamp convention
 *    and missing-data handling. The declaration travels with the number.
 *
 * 3. No sampling-adherence or overdue figure is produced for a stage whose
 *    frequency is not approved. Four of the seven stages read "To set" in the
 *    workbook, so a compliance percentage for them would be invented
 *    (FR-020, risk R-08).
 *
 * Reports are views of stored records, never a second set of records.
 */

import type { Stage } from '@/forms/types';
import { DASHBOARD_ORDER, getSchema } from '@/forms/registry';
import { PLANT_TIME_ZONE, plantLocalDate } from '@/lib/time';
import type { CaptureState, Disposition } from '@/lib/workflow';

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

/**
 * A number that was actually measured, or an explained absence.
 *
 * There is deliberately no way to express "0 because I could not look".
 */
export type CountSource =
  | { readonly available: true; readonly value: number }
  | { readonly available: false; readonly reason: string };

export function counted(value: number): CountSource {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`A count must be a non-negative integer, received ${value}`);
  }
  return { available: true, value };
}

export function countedFrom(rows: readonly unknown[]): CountSource {
  return { available: true, value: rows.length };
}

export function unavailable(reason: string): CountSource {
  return { available: false, reason };
}

export type MetricValue =
  | { readonly kind: 'count'; readonly value: number }
  | { readonly kind: 'insufficient_data'; readonly reason: string }
  /** The metric cannot exist yet, as distinct from being unmeasured. */
  | { readonly kind: 'not_produced'; readonly reason: string };

export function toMetricValue(source: CountSource): MetricValue {
  return source.available
    ? { kind: 'count', value: source.value }
    : { kind: 'insufficient_data', reason: source.reason };
}

export const INSUFFICIENT_DATA_TEXT = 'Insufficient data';
export const NOT_PRODUCED_TEXT = 'Not reported';

/** The exact text a widget shows. `0` is a real answer and prints as "0". */
export function renderMetric(value: MetricValue): string {
  switch (value.kind) {
    case 'count':
      return String(value.value);
    case 'insufficient_data':
      return INSUFFICIENT_DATA_TEXT;
    case 'not_produced':
      return NOT_PRODUCED_TEXT;
  }
}

export function isNumeric(value: MetricValue): value is { kind: 'count'; value: number } {
  return value.kind === 'count';
}

// ---------------------------------------------------------------------------
// Declarations
// ---------------------------------------------------------------------------

export interface MetricDefinition {
  readonly id: string;
  readonly label: string;
  readonly numerator: string;
  readonly denominator: string;
  readonly timestampConvention: string;
  readonly missingData: string;
}

export interface Metric {
  readonly definition: MetricDefinition;
  readonly value: MetricValue;
}

const PLANT_DAY_CONVENTION = `Plant-local calendar day in ${PLANT_TIME_ZONE}, taken from the recorded collection instant. A sample collected at 21:00 Guyana belongs to that Guyana day, not to the following UTC day.`;

export const METRIC_DEFINITIONS = {
  samples_today: {
    id: 'samples_today',
    label: 'Samples today',
    numerator: 'Registered samples whose plant-local collection date is the selected day.',
    denominator: 'None. This is a count, not a rate.',
    timestampConvention: PLANT_DAY_CONVENTION,
    missingData:
      'Drafts are excluded because a draft is not a collected sample. If the query cannot be read, the widget shows "Insufficient data" and never 0.',
  },
  awaiting_results: {
    id: 'awaiting_results',
    label: 'Waiting for test results',
    numerator:
      'Samples in capture state Registered, Awaiting results or Correction required.',
    denominator: 'None. This is a count, not a rate.',
    timestampConvention: 'Current capture state. No time window is applied.',
    missingData: 'An unreadable query shows "Insufficient data", never 0.',
  },
  ready_for_review: {
    id: 'ready_for_review',
    label: 'Ready for review',
    numerator: 'Samples in capture state Ready for review.',
    denominator: 'None. This is a count, not a rate.',
    timestampConvention: 'Current capture state. No time window is applied.',
    missingData: 'An unreadable query shows "Insufficient data", never 0.',
  },
  on_hold: {
    id: 'on_hold',
    label: 'On hold',
    numerator: 'Samples with an active quality hold.',
    denominator: 'None. This is a count, not a rate.',
    timestampConvention: 'Current hold state. A cleared hold is not counted.',
    missingData:
      'A hold counts whatever the measurements say, because a hold outranks every permissive signal. An unreadable query shows "Insufficient data".',
  },
  recently_updated: {
    id: 'recently_updated',
    label: 'Updated recently',
    numerator: 'Samples whose record changed within the stated window.',
    denominator: 'None. This is a count, not a rate.',
    timestampConvention:
      'Server update instant in UTC, compared against a window measured back from now. Displayed times are converted to plant-local.',
    missingData: 'An unreadable query shows "Insufficient data", never 0.',
  },
} as const satisfies Record<string, MetricDefinition>;

export type MetricId = keyof typeof METRIC_DEFINITIONS;

// ---------------------------------------------------------------------------
// Facts
// ---------------------------------------------------------------------------

/**
 * The minimum a sample contributes to a report. Deliberately not the database
 * row: a report must not depend on columns it does not use.
 */
export interface SampleFact {
  readonly id: string;
  readonly stage: Stage;
  /** ISO instant of collection. */
  readonly collectionInstant: string;
  readonly captureState: CaptureState;
  readonly disposition: Disposition;
  readonly holdActive: boolean;
  /** ISO instant the record last changed. */
  readonly updatedAt: string;
}

/** Capture states that mean "collected", i.e. not a draft and not voided. */
const COLLECTED_STATES: readonly CaptureState[] = [
  'registered',
  'awaiting_results',
  'ready_for_review',
  'reviewed',
  'correction_required',
];

const AWAITING_STATES: readonly CaptureState[] = [
  'registered',
  'awaiting_results',
  'correction_required',
];

export function isCollected(fact: SampleFact): boolean {
  return COLLECTED_STATES.includes(fact.captureState);
}

/** The plant-local day a collection instant falls in. */
export function plantDayOf(instantIso: string): string {
  const instant = new Date(instantIso);
  if (Number.isNaN(instant.getTime())) {
    throw new Error(`Invalid collection instant ${JSON.stringify(instantIso)}`);
  }
  return plantLocalDate(instant);
}

export function samplesOnPlantDay(
  facts: readonly SampleFact[],
  plantDate: string,
): readonly SampleFact[] {
  return facts.filter((f) => isCollected(f) && plantDayOf(f.collectionInstant) === plantDate);
}

// ---------------------------------------------------------------------------
// Widgets
// ---------------------------------------------------------------------------

export interface StageCount {
  readonly stage: Stage;
  readonly ordinal: number;
  readonly title: string;
  readonly value: MetricValue;
}

/**
 * Samples collected on one plant-local day, broken down by stage.
 *
 * `facts === null` means the query did not return, so EVERY stage reports
 * insufficient data. When the rows are present, a stage with none reports a
 * genuine 0 — the plant did not sample that stage today, which is information.
 */
export function samplesTodayByStage(
  facts: readonly SampleFact[] | null,
  plantDate: string,
  unavailableReason = 'The sample list could not be read, so today’s count is unknown.',
): readonly StageCount[] {
  if (facts === null) {
    return DASHBOARD_ORDER.map((schema) => ({
      stage: schema.stage,
      ordinal: schema.ordinal,
      title: schema.title,
      value: { kind: 'insufficient_data', reason: unavailableReason },
    }));
  }

  const today = samplesOnPlantDay(facts, plantDate);
  const tally = new Map<Stage, number>();
  for (const f of today) tally.set(f.stage, (tally.get(f.stage) ?? 0) + 1);

  return DASHBOARD_ORDER.map((schema) => ({
    stage: schema.stage,
    ordinal: schema.ordinal,
    title: schema.title,
    value: { kind: 'count', value: tally.get(schema.stage) ?? 0 },
  }));
}

export interface OperationsInput {
  /** Plant-local day the "today" widgets describe. */
  readonly plantDate: string;
  /** All collected samples needed for the day breakdown, or null if unread. */
  readonly todayFacts: readonly SampleFact[] | null;
  readonly awaitingResults: CountSource;
  readonly readyForReview: CountSource;
  readonly onHold: CountSource;
  readonly recentlyUpdated: CountSource;
  /** Window used for `recentlyUpdated`, stated in the metric declaration. */
  readonly recentWindowHours: number;
}

export interface OperationsReport {
  readonly plantDate: string;
  readonly samplesToday: Metric;
  readonly samplesTodayByStage: readonly StageCount[];
  readonly awaitingResults: Metric;
  readonly readyForReview: Metric;
  readonly onHold: Metric;
  readonly recentlyUpdated: Metric;
  readonly metrics: readonly Metric[];
}

export function buildOperationsReport(input: OperationsInput): OperationsReport {
  const byStage = samplesTodayByStage(input.todayFacts, input.plantDate);

  const samplesTodayValue: MetricValue =
    input.todayFacts === null
      ? {
          kind: 'insufficient_data',
          reason: 'The sample list could not be read, so today’s count is unknown.',
        }
      : { kind: 'count', value: samplesOnPlantDay(input.todayFacts, input.plantDate).length };

  const samplesToday: Metric = {
    definition: METRIC_DEFINITIONS.samples_today,
    value: samplesTodayValue,
  };
  const awaitingResults: Metric = {
    definition: METRIC_DEFINITIONS.awaiting_results,
    value: toMetricValue(input.awaitingResults),
  };
  const readyForReview: Metric = {
    definition: METRIC_DEFINITIONS.ready_for_review,
    value: toMetricValue(input.readyForReview),
  };
  const onHold: Metric = {
    definition: METRIC_DEFINITIONS.on_hold,
    value: toMetricValue(input.onHold),
  };
  const recentlyUpdated: Metric = {
    definition: {
      ...METRIC_DEFINITIONS.recently_updated,
      label: `Updated in the last ${input.recentWindowHours} hours`,
      numerator: `Samples whose record changed in the last ${input.recentWindowHours} hours.`,
    },
    value: toMetricValue(input.recentlyUpdated),
  };

  return {
    plantDate: input.plantDate,
    samplesToday,
    samplesTodayByStage: byStage,
    awaitingResults,
    readyForReview,
    onHold,
    recentlyUpdated,
    metrics: [samplesToday, awaitingResults, readyForReview, onHold, recentlyUpdated],
  };
}

/** Counts derived locally from a page of facts, for the worklist headers. */
export function countAwaitingResults(facts: readonly SampleFact[]): number {
  return facts.filter((f) => AWAITING_STATES.includes(f.captureState)).length;
}

export function countReadyForReview(facts: readonly SampleFact[]): number {
  return facts.filter((f) => f.captureState === 'ready_for_review').length;
}

export function countOnHold(facts: readonly SampleFact[]): number {
  return facts.filter((f) => f.holdActive).length;
}

export function countUpdatedSince(facts: readonly SampleFact[], sinceIso: string): number {
  const since = new Date(sinceIso).getTime();
  if (Number.isNaN(since)) throw new Error(`Invalid window start ${JSON.stringify(sinceIso)}`);
  return facts.filter((f) => new Date(f.updatedAt).getTime() >= since).length;
}

// ---------------------------------------------------------------------------
// Sampling adherence — refused where the frequency is not approved
// ---------------------------------------------------------------------------

export type AdherenceResult =
  | {
      readonly kind: 'available';
      readonly stage: Stage;
      readonly percent: number;
      readonly numerator: number;
      readonly denominator: number;
      readonly frequency: string;
    }
  | {
      readonly kind: 'not_produced';
      readonly stage: Stage;
      readonly reason: string;
      readonly frequency: string;
    }
  | {
      readonly kind: 'insufficient_data';
      readonly stage: Stage;
      readonly reason: string;
      readonly frequency: string;
    };

/** Is a sampling-adherence figure legitimate for this stage at all? */
export function adherenceIsReportable(stage: Stage): boolean {
  return getSchema(stage).frequencyApproved;
}

/**
 * Sampling adherence for one stage.
 *
 * Refuses outright when the workbook states the frequency as "To set" — four
 * of seven stages — even if a denominator is supplied, because the denominator
 * would then be measuring against a target nobody approved. The refusal is not
 * "insufficient data": more data would not make the figure legitimate.
 */
export function samplingAdherence(args: {
  readonly stage: Stage;
  readonly samplesTaken: CountSource;
  /** Expected sampling events (loads, runs, production runs) in the period. */
  readonly expectedEvents: CountSource;
}): AdherenceResult {
  const schema = getSchema(args.stage);

  if (!schema.frequencyApproved) {
    return {
      kind: 'not_produced',
      stage: args.stage,
      frequency: schema.frequency,
      reason: `The sampling frequency for ${schema.title} is recorded in the workbook as "${schema.frequency}". No adherence or overdue figure is reported for this stage, because there is no approved target to measure against.`,
    };
  }

  if (!args.samplesTaken.available) {
    return {
      kind: 'insufficient_data',
      stage: args.stage,
      frequency: schema.frequency,
      reason: args.samplesTaken.reason,
    };
  }
  if (!args.expectedEvents.available) {
    return {
      kind: 'insufficient_data',
      stage: args.stage,
      frequency: schema.frequency,
      reason: args.expectedEvents.reason,
    };
  }
  if (args.expectedEvents.value === 0) {
    return {
      kind: 'insufficient_data',
      stage: args.stage,
      frequency: schema.frequency,
      reason: `No ${schema.frequency.toLowerCase()} events were recorded for the period, so there is nothing to measure adherence against.`,
    };
  }

  const numerator = args.samplesTaken.value;
  const denominator = args.expectedEvents.value;
  return {
    kind: 'available',
    stage: args.stage,
    numerator,
    denominator,
    percent: (numerator / denominator) * 100,
    frequency: schema.frequency,
  };
}

/** Stages for which an adherence figure may legitimately be shown. */
export function reportableAdherenceStages(): readonly Stage[] {
  return DASHBOARD_ORDER.filter((s) => s.frequencyApproved).map((s) => s.stage);
}

/** Stages for which adherence is deliberately withheld, with the reason. */
export function withheldAdherenceStages(): readonly {
  stage: Stage;
  title: string;
  frequency: string;
}[] {
  return DASHBOARD_ORDER.filter((s) => !s.frequencyApproved).map((s) => ({
    stage: s.stage,
    title: s.title,
    frequency: s.frequency,
  }));
}
