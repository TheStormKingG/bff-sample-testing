/**
 * Report metric tests.
 *
 * Three claims carry the weight of the whole reporting surface:
 *
 *   1. A measured zero and an unmeasured count are different values, and the
 *      second must never render as "0".
 *   2. The plant-local day boundary is resolved in America/Guyana, so a 21:00
 *      sample stays in its own Guyana day instead of migrating to the next
 *      UTC day.
 *   3. No sampling-adherence figure is produced for a stage whose frequency is
 *      unapproved — not even when a denominator is handed to the function.
 */

import { describe, expect, it } from 'vitest';

import {
  adherenceIsReportable,
  buildOperationsReport,
  countAwaitingResults,
  countOnHold,
  countReadyForReview,
  countUpdatedSince,
  counted,
  countedFrom,
  INSUFFICIENT_DATA_TEXT,
  isNumeric,
  METRIC_DEFINITIONS,
  NOT_PRODUCED_TEXT,
  plantDayOf,
  renderMetric,
  reportableAdherenceStages,
  samplesOnPlantDay,
  samplesTodayByStage,
  samplingAdherence,
  toMetricValue,
  unavailable,
  withheldAdherenceStages,
  type SampleFact,
} from '@/lib/reportMetrics';
import { DASHBOARD_ORDER } from '@/forms/registry';
import { STAGES, type Stage } from '@/forms/types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function fact(overrides: Partial<SampleFact> & { id: string }): SampleFact {
  return {
    stage: 'raw_materials',
    collectionInstant: '2026-10-24T14:00:00.000Z',
    captureState: 'registered',
    disposition: 'undetermined',
    holdActive: false,
    updatedAt: '2026-10-24T14:05:00.000Z',
    ...overrides,
  };
}

const EMPTY_OPERATIONS = {
  plantDate: '2026-10-24',
  recentWindowHours: 24,
} as const;

// ---------------------------------------------------------------------------
// 1. Measured zero vs absent count
// ---------------------------------------------------------------------------

describe('a measured zero is not the same value as an absent count', () => {
  it('renders a real zero as "0"', () => {
    expect(renderMetric(toMetricValue(counted(0)))).toBe('0');
    expect(renderMetric(toMetricValue(countedFrom([])))).toBe('0');
  });

  it('renders an absent count as insufficient data, never as 0', () => {
    const value = toMetricValue(unavailable('The hold query timed out.'));
    expect(value.kind).toBe('insufficient_data');
    expect(renderMetric(value)).toBe(INSUFFICIENT_DATA_TEXT);
    expect(renderMetric(value)).not.toBe('0');
  });

  it('keeps the reason an absent count carried, so the UI can explain itself', () => {
    const value = toMetricValue(unavailable('Row level security denied the read.'));
    expect(value).toEqual({
      kind: 'insufficient_data',
      reason: 'Row level security denied the read.',
    });
  });

  it('distinguishes the two in a full operations report', () => {
    const measured = buildOperationsReport({
      ...EMPTY_OPERATIONS,
      todayFacts: [],
      awaitingResults: counted(0),
      readyForReview: counted(0),
      onHold: counted(0),
      recentlyUpdated: counted(0),
    });

    expect(renderMetric(measured.samplesToday.value)).toBe('0');
    expect(renderMetric(measured.awaitingResults.value)).toBe('0');
    expect(renderMetric(measured.onHold.value)).toBe('0');
    expect(measured.metrics.every((m) => isNumeric(m.value))).toBe(true);

    const unread = buildOperationsReport({
      ...EMPTY_OPERATIONS,
      todayFacts: null,
      awaitingResults: unavailable('not read'),
      readyForReview: unavailable('not read'),
      onHold: unavailable('not read'),
      recentlyUpdated: unavailable('not read'),
    });

    expect(renderMetric(unread.samplesToday.value)).toBe(INSUFFICIENT_DATA_TEXT);
    expect(unread.metrics.every((m) => m.value.kind === 'insufficient_data')).toBe(true);
    for (const m of unread.metrics) {
      expect(renderMetric(m.value)).not.toBe('0');
    }
  });

  it('reports every stage as insufficient data when the day query did not return', () => {
    const rows = samplesTodayByStage(null, '2026-10-24');
    expect(rows).toHaveLength(7);
    for (const row of rows) {
      expect(row.value.kind).toBe('insufficient_data');
      expect(renderMetric(row.value)).toBe(INSUFFICIENT_DATA_TEXT);
    }
  });

  it('reports a genuine zero per stage when the rows were read and none matched', () => {
    const rows = samplesTodayByStage([], '2026-10-24');
    expect(rows).toHaveLength(7);
    for (const row of rows) {
      expect(row.value).toEqual({ kind: 'count', value: 0 });
      expect(renderMetric(row.value)).toBe('0');
    }
  });

  it('refuses to accept a negative or fractional count as measured', () => {
    expect(() => counted(-1)).toThrow();
    expect(() => counted(1.5)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// 2. The plant-local day boundary
// ---------------------------------------------------------------------------

describe('the plant-local day boundary is America/Guyana, not UTC', () => {
  // Guyana is UTC-04:00, so 21:00 on 24 October is 01:00 UTC on 25 October.
  const nightShift = '2026-10-25T01:00:00.000Z';

  it('files a 21:00 Guyana sample in the Guyana day it was taken', () => {
    expect(plantDayOf(nightShift)).toBe('2026-10-24');
    expect(plantDayOf(nightShift)).not.toBe('2026-10-25');
  });

  it('counts that sample in the 24th and not in the 25th', () => {
    const facts = [fact({ id: 'a', collectionInstant: nightShift })];

    expect(samplesOnPlantDay(facts, '2026-10-24')).toHaveLength(1);
    expect(samplesOnPlantDay(facts, '2026-10-25')).toHaveLength(0);

    const twentyFourth = buildOperationsReport({
      plantDate: '2026-10-24',
      recentWindowHours: 24,
      todayFacts: facts,
      awaitingResults: counted(1),
      readyForReview: counted(0),
      onHold: counted(0),
      recentlyUpdated: counted(1),
    });
    expect(renderMetric(twentyFourth.samplesToday.value)).toBe('1');

    const twentyFifth = buildOperationsReport({
      plantDate: '2026-10-25',
      recentWindowHours: 24,
      todayFacts: facts,
      awaitingResults: counted(1),
      readyForReview: counted(0),
      onHold: counted(0),
      recentlyUpdated: counted(1),
    });
    expect(renderMetric(twentyFifth.samplesToday.value)).toBe('0');
  });

  it('keeps the two sides of midnight apart', () => {
    // 23:59 Guyana on the 24th, and 00:01 Guyana on the 25th.
    expect(plantDayOf('2026-10-25T03:59:00.000Z')).toBe('2026-10-24');
    expect(plantDayOf('2026-10-25T04:01:00.000Z')).toBe('2026-10-25');
  });

  it('attributes the night-shift sample to the right stage column', () => {
    const facts = [
      fact({ id: 'a', stage: 'mash', collectionInstant: nightShift }),
      fact({ id: 'b', stage: 'mash', collectionInstant: '2026-10-24T18:00:00.000Z' }),
      fact({ id: 'c', stage: 'pellets', collectionInstant: '2026-10-25T05:00:00.000Z' }),
    ];
    const rows = samplesTodayByStage(facts, '2026-10-24');
    const mash = rows.find((r) => r.stage === 'mash');
    const pellets = rows.find((r) => r.stage === 'pellets');

    expect(mash?.value).toEqual({ kind: 'count', value: 2 });
    expect(pellets?.value).toEqual({ kind: 'count', value: 0 });
  });

  it('states the plant time zone in the samples-today declaration', () => {
    expect(METRIC_DEFINITIONS.samples_today.timestampConvention).toContain('America/Guyana');
  });

  it('rejects an unparseable instant rather than guessing a day', () => {
    expect(() => plantDayOf('not-a-date')).toThrow();
  });

  it('excludes drafts and voided records from a collected-sample count', () => {
    const facts = [
      fact({ id: 'draft', captureState: 'draft' }),
      fact({ id: 'void', captureState: 'voided' }),
      fact({ id: 'real', captureState: 'reviewed' }),
    ];
    expect(samplesOnPlantDay(facts, '2026-10-24')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 3. No adherence figure for an unapproved frequency
// ---------------------------------------------------------------------------

describe('sampling adherence is withheld where the frequency is unapproved', () => {
  const UNAPPROVED: readonly Stage[] = ['ground', 'conditioned', 'pellets', 'crumble'];
  const APPROVED: readonly Stage[] = ['raw_materials', 'extruded_soya', 'mash'];

  it('matches the workbook: four of the seven stages have no approved frequency', () => {
    const withheld = withheldAdherenceStages().map((s) => s.stage);
    expect(withheld).toHaveLength(4);
    expect([...withheld].sort()).toEqual([...UNAPPROVED].sort());
    expect([...reportableAdherenceStages()].sort()).toEqual([...APPROVED].sort());
    expect(withheld.length + reportableAdherenceStages().length).toBe(STAGES.length);
  });

  it('produces no percentage for an unapproved stage even when given a denominator', () => {
    for (const stage of UNAPPROVED) {
      expect(adherenceIsReportable(stage)).toBe(false);

      const result = samplingAdherence({
        stage,
        samplesTaken: counted(8),
        expectedEvents: counted(10),
      });

      expect(result.kind).toBe('not_produced');
      expect(result).not.toHaveProperty('percent');
      if (result.kind !== 'not_produced') throw new Error('expected a refusal');
      expect(result.reason).toContain('To set');
      expect(result.reason).toContain('no approved target');
    }
  });

  it('calls the refusal "not produced", not "insufficient data"', () => {
    // More data cannot make the figure legitimate, so the two states must not
    // be conflated: one invites a retry, the other requires an approval.
    const result = samplingAdherence({
      stage: 'crumble',
      samplesTaken: counted(10),
      expectedEvents: counted(10),
    });
    expect(result.kind).toBe('not_produced');
    if (result.kind === 'not_produced') {
      expect(renderMetric({ kind: 'not_produced', reason: result.reason })).toBe(NOT_PRODUCED_TEXT);
    }
  });

  it('computes adherence for an approved frequency when both sides are measured', () => {
    const result = samplingAdherence({
      stage: 'raw_materials',
      samplesTaken: counted(9),
      expectedEvents: counted(12),
    });
    expect(result.kind).toBe('available');
    if (result.kind === 'available') {
      expect(result.numerator).toBe(9);
      expect(result.denominator).toBe(12);
      expect(result.percent).toBeCloseTo(75);
      expect(result.frequency).toBe('Every load');
    }
  });

  it('reports insufficient data, not 100%, when an approved stage has no denominator', () => {
    const noDenominator = samplingAdherence({
      stage: 'extruded_soya',
      samplesTaken: counted(4),
      expectedEvents: unavailable('The number of extrusion runs is not recorded in the app.'),
    });
    expect(noDenominator.kind).toBe('insufficient_data');

    const zeroDenominator = samplingAdherence({
      stage: 'mash',
      samplesTaken: counted(0),
      expectedEvents: counted(0),
    });
    expect(zeroDenominator.kind).toBe('insufficient_data');
    expect(zeroDenominator).not.toHaveProperty('percent');
  });
});

// ---------------------------------------------------------------------------
// Declarations and local tallies
// ---------------------------------------------------------------------------

describe('every metric declares how it is built', () => {
  it('names a numerator, denominator, timestamp convention and missing-data rule', () => {
    for (const definition of Object.values(METRIC_DEFINITIONS)) {
      expect(definition.numerator.length).toBeGreaterThan(10);
      expect(definition.denominator.length).toBeGreaterThan(3);
      expect(definition.timestampConvention.length).toBeGreaterThan(10);
      expect(definition.missingData.length).toBeGreaterThan(10);
    }
  });

  it('carries the declaration alongside the number in the report', () => {
    const report = buildOperationsReport({
      ...EMPTY_OPERATIONS,
      todayFacts: [],
      awaitingResults: counted(3),
      readyForReview: counted(1),
      onHold: counted(2),
      recentlyUpdated: counted(4),
    });
    for (const metric of report.metrics) {
      expect(metric.definition.id.length).toBeGreaterThan(0);
      expect(metric.definition.missingData).toContain('Insufficient data');
    }
  });

  it('states the recent window in the metric it describes', () => {
    const report = buildOperationsReport({
      plantDate: '2026-10-24',
      recentWindowHours: 48,
      todayFacts: [],
      awaitingResults: counted(0),
      readyForReview: counted(0),
      onHold: counted(0),
      recentlyUpdated: counted(0),
    });
    expect(report.recentlyUpdated.definition.label).toContain('48');
    expect(report.recentlyUpdated.definition.numerator).toContain('48');
  });

  it('covers all seven dashboard stages in the day breakdown', () => {
    const rows = samplesTodayByStage([], '2026-10-24');
    expect(rows.map((r) => r.stage)).toEqual(DASHBOARD_ORDER.map((s) => s.stage));
    expect(rows.map((r) => r.ordinal)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });
});

describe('local tallies over a page of facts', () => {
  const facts: readonly SampleFact[] = [
    fact({ id: '1', captureState: 'registered' }),
    fact({ id: '2', captureState: 'awaiting_results' }),
    fact({ id: '3', captureState: 'correction_required' }),
    fact({ id: '4', captureState: 'ready_for_review' }),
    fact({ id: '5', captureState: 'reviewed', holdActive: true }),
    fact({ id: '6', captureState: 'draft' }),
  ];

  it('counts the three states that mean "waiting for results"', () => {
    expect(countAwaitingResults(facts)).toBe(3);
  });

  it('counts ready-for-review separately from awaiting results', () => {
    expect(countReadyForReview(facts)).toBe(1);
  });

  it('counts a hold on a reviewed sample, because a hold outranks the review', () => {
    expect(countOnHold(facts)).toBe(1);
  });

  it('counts updates inside a window and rejects a bad window start', () => {
    expect(countUpdatedSince(facts, '2026-10-24T14:00:00.000Z')).toBe(6);
    expect(countUpdatedSince(facts, '2026-10-24T15:00:00.000Z')).toBe(0);
    expect(() => countUpdatedSince(facts, 'nonsense')).toThrow();
  });
});
