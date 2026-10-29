/**
 * Lifecycle COMPOSITION tests.
 *
 * Every other suite proves one module in isolation. This one proves they
 * compose: raw form state -> validation -> identity -> sheet row -> assessment
 * -> hold -> release gate -> disposition -> state transition, using only the
 * real exported APIs and no mocks of our own code.
 *
 * It is the closest thing to UAT-10 ("full lifecycle") that can run without a
 * Supabase project or a Google Sheet, and it is deliberately written against
 * the SEEDED PRODUCTION RULESET — an empty approved ruleset — because that is
 * the state the plant will actually start in: 0 of 34 workbook limits approved.
 *
 * What it does NOT prove, and must not be read as proving: that any server-side
 * RPC exists, that a row reaches the spreadsheet, or that RLS denies anything.
 * Those need a live project (see docs/uat-plan.md).
 */
import { describe, it, expect } from 'vitest';

import { STAGE_SCHEMAS, resolvePrefix, assessableFields, adverseObservationFields, isFieldApplicable } from '@/forms/registry';
import { toSheetRow, columnLetterToIndex } from '@/forms/sheetMapping';
import { parseStageValues, implausibleFindings } from '@/forms/zodSchema';
import { defaultStageValues, clearNonApplicable } from '@/forms/defaults';
import { formatSampleId } from '@/lib/sampleId';
import { fromPlantParts, plantLocalDate } from '@/lib/time';
import { assess, holdTriggers, type Assessment, type SpecificationRule } from '@/lib/assessment';
import { evaluateRelease, checkDisposition, checkTransition } from '@/lib/workflow';
import { type AuthorityContext, type Role } from '@/lib/roles';
import type { Stage } from '@/forms/types';

const actor = (roles: Role[], over: Partial<AuthorityContext> = {}): AuthorityContext => ({
  userId: `user-${roles.join('-') || 'none'}`,
  roles,
  status: 'active',
  ...over,
});

const operator = actor(['operator']);
const qo = actor(['quality_officer']);
const supervisor = actor(['quality_supervisor']);
const admin = actor(['administrator']);

/** The real starting state: no approved rules at all. */
const NO_APPROVED_RULES: readonly SpecificationRule[] = [];

/**
 * Assess every assessable field of a stage against a ruleset, the way the
 * server will. Returns the shape the release gate consumes.
 */
function assessAll(
  stage: Stage,
  payload: Readonly<Record<string, unknown>>,
  rules: readonly SpecificationRule[],
  collectionInstant: string,
): Array<{ fieldKey: string; label: string; required: boolean; assessment: Assessment }> {
  return assessableFields(stage).map((field) => {
    const held = payload[field.key];
    const numeric =
      held === undefined || held === null || held === ''
        ? null
        : typeof held === 'object'
          ? (held as { value: number }).value
          : Number(held);

    return {
      fieldKey: field.key,
      label: field.label,
      required: field.required === 'testing',
      assessment: assess(
        {
          stage,
          parameterKey: field.parameterKey!,
          value: numeric,
          unit: field.unit ?? null,
          unitConfirmed: field.unitConfirmed !== false,
          applicable: isFieldApplicable(field, payload),
          material: typeof payload['material'] === 'string' ? payload['material'] : null,
          samplingPoint: typeof payload['sampling_point'] === 'string' ? payload['sampling_point'] : null,
          collectionInstant,
        },
        rules,
      ),
    };
  });
}

function observationsFor(stage: Stage, payload: Readonly<Record<string, unknown>>) {
  return adverseObservationFields(stage).map((f) => ({
    fieldKey: f.key,
    label: f.label,
    value: typeof payload[f.key] === 'string' ? (payload[f.key] as string) : null,
    adverseValue: f.adverseValue!,
  }));
}

// ---------------------------------------------------------------------------

describe('UAT-10: raw-material intake, gate to disposition', () => {
  const COLLECTION_DATE = '2026-10-24';
  const COLLECTION_TIME = '08:15';
  const instant = fromPlantParts(COLLECTION_DATE, COLLECTION_TIME).toISOString();

  const registrationValues: Record<string, string> = {
    collection_date: COLLECTION_DATE,
    collection_time: COLLECTION_TIME,
    material: 'soya',
    supplier: 'Acme Grain',
    delivery_or_lot_no: 'LOT-5512',
    truck_or_container_no: 'GAB 1234',
    quantity_received_t: '27.5',
    sampled_by: 'A. Persaud',
    mould_seen: 'yes', // the adverse observation that drives the whole flow
    insects_seen: 'no',
    foreign_matter_seen: 'no',
    bad_smell: 'no',
  };

  it('a fresh draft is incomplete yet valid as a draft (FR-005)', () => {
    const draft = defaultStageValues('raw_materials', new Date(instant));
    const parsed = parseStageValues('raw_materials', 'draft', draft);
    expect(parsed.ok).toBe(true);
  });

  it('the same incomplete draft is NOT valid for registration', () => {
    const draft = defaultStageValues('raw_materials', new Date(instant));
    const parsed = parseStageValues('raw_materials', 'registration', draft);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      // The operator is told which fields, not just "invalid".
      expect(Object.keys(parsed.errors).length).toBeGreaterThan(0);
      expect(parsed.errors).toHaveProperty('supplier');
    }
  });

  it('a complete registration validates, and allocates the documented identifier', () => {
    const parsed = parseStageValues('raw_materials', 'registration', registrationValues);
    expect(parsed.ok).toBe(true);

    const prefix = resolvePrefix('raw_materials', registrationValues);
    expect(prefix).toBe('RM');
    // The sequence comes from the database in production; here we assert the
    // FORMAT contract the workbook Read me tab documents.
    const id = formatSampleId('RM', plantLocalDate(new Date(instant)), 1);
    expect(id).toBe('RM-261024-01');
  });

  it('the validated payload maps to exactly the 19 intended columns (UAT-01)', () => {
    const parsed = parseStageValues('raw_materials', 'registration', registrationValues);
    if (!parsed.ok) throw new Error('registration should validate');

    const row = toSheetRow('raw_materials', 'RM-261024-01', parsed.values);
    expect(row).toHaveLength(19);
    expect(row[columnLetterToIndex('A')]).toBe('RM-261024-01');
    expect(row[columnLetterToIndex('D')]).toBe('Soya'); // code -> workbook label
    expect(row[columnLetterToIndex('H')]).toBe('27.5');
    expect(row[columnLetterToIndex('N')]).toBe('Yes'); // mould seen
    // Results not yet entered: blank, NOT zero.
    expect(row[columnLetterToIndex('J')]).toBe('');
    expect(row[columnLetterToIndex('K')]).toBe('');
  });

  it('a real zero aflatoxin result is recorded as 0, not as missing', () => {
    const withResults = { ...registrationValues, moisture_pct: '11.8', aflatoxin_ppb: '0', tested_by_qo: 'R. Singh' };
    const parsed = parseStageValues('raw_materials', 'testing', withResults);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const row = toSheetRow('raw_materials', 'RM-261024-01', parsed.values);
    expect(row[columnLetterToIndex('K')]).toBe('0');
    // ...and the assessment treats it as a measured value, not an absent one.
    const assessments = assessAll('raw_materials', parsed.values, NO_APPROVED_RULES, instant);
    const afla = assessments.find((a) => a.fieldKey === 'aflatoxin_ppb')!;
    expect(afla.assessment.result).not.toBe('not_tested');
  });

  it('with no approved limits, every measurement is Not Assessable (UAT-05)', () => {
    const withResults = { ...registrationValues, moisture_pct: '11.8', aflatoxin_ppb: '3.2', tested_by_qo: 'R. Singh' };
    const parsed = parseStageValues('raw_materials', 'testing', withResults);
    if (!parsed.ok) throw new Error('testing payload should validate');

    const assessments = assessAll('raw_materials', parsed.values, NO_APPROVED_RULES, instant);
    const measured = assessments.filter((a) => a.assessment.result !== 'not_tested');
    expect(measured.length).toBeGreaterThan(0);
    for (const a of measured) {
      expect(a.assessment.result, a.fieldKey).toBe('not_assessable');
      expect(a.assessment.reason, a.fieldKey).toBe('no_approved_rule');
    }
    // Nothing anywhere produced a pass.
    expect(assessments.some((a) => a.assessment.result === 'within_limit')).toBe(false);
  });

  it('mould = Yes raises a hold even though no numeric result is out of limit (UAT-08)', () => {
    const withResults = { ...registrationValues, moisture_pct: '11.8', aflatoxin_ppb: '3.2', tested_by_qo: 'R. Singh' };
    const parsed = parseStageValues('raw_materials', 'testing', withResults);
    if (!parsed.ok) throw new Error('testing payload should validate');

    const assessments = assessAll('raw_materials', parsed.values, NO_APPROVED_RULES, instant);
    expect(assessments.some((a) => a.assessment.result === 'outside_limit')).toBe(false);

    const triggers = holdTriggers({
      observations: observationsFor('raw_materials', parsed.values),
      assessments: assessments.map((a) => ({ fieldKey: a.fieldKey, label: a.label, assessment: a.assessment })),
    });
    expect(triggers).toHaveLength(1);
    expect(triggers[0]!.kind).toBe('adverse_observation');
    expect(triggers[0]!.fieldKey).toBe('mould_seen');
  });

  it('the release gate blocks, and names every reason (FR-010)', () => {
    const withResults = { ...registrationValues, moisture_pct: '11.8', aflatoxin_ppb: '3.2', tested_by_qo: 'R. Singh' };
    const parsed = parseStageValues('raw_materials', 'testing', withResults);
    if (!parsed.ok) throw new Error('testing payload should validate');

    const evaluation = evaluateRelease({
      holdActive: true,
      holdDetail: 'Mould seen on intake.',
      assessments: assessAll('raw_materials', parsed.values, NO_APPROVED_RULES, instant),
      requireSheetConfirmation: false,
      sheetConfirmed: true,
    });

    expect(evaluation.cleanAcceptAvailable).toBe(false);
    expect(evaluation.blockers.some((b) => b.kind === 'active_hold')).toBe(true);
    expect(evaluation.blockers.some((b) => b.kind === 'not_assessable')).toBe(true);
  });

  it('nobody can accept the held load, and the administrator least of all (UAT-09)', () => {
    const evaluation = evaluateRelease({
      holdActive: true,
      holdDetail: 'Mould seen on intake.',
      assessments: [],
      requireSheetConfirmation: false,
      sheetConfirmed: true,
    });

    // A technical administrator has no quality authority at all.
    expect(checkDisposition({ decision: 'accepted', actor: admin, evaluation, reason: 'urgent' }).denial)
      .toBe('not_authorised');
    // An operator likewise.
    expect(checkDisposition({ decision: 'accepted', actor: operator, evaluation, reason: 'looks fine' }).denial)
      .toBe('not_authorised');
    // Even a supervisor must clear the hold through its own audited action.
    expect(checkDisposition({ decision: 'accepted', actor: supervisor, evaluation, reason: 'proceed' }).denial)
      .toBe('hold_must_be_cleared_first');
    // The safe direction stays open.
    expect(checkDisposition({ decision: 'rejected', actor: supervisor, evaluation, reason: 'Mould on intake; load refused.' }).allowed)
      .toBe(true);
  });

  it('the capture state machine matches the authority model end to end', () => {
    expect(checkTransition({ from: 'draft', to: 'registered', actor: operator }).allowed).toBe(true);
    // An operator registers but does not test.
    expect(checkTransition({ from: 'awaiting_results', to: 'ready_for_review', actor: operator }).denial)
      .toBe('not_authorised');
    expect(checkTransition({ from: 'awaiting_results', to: 'ready_for_review', actor: qo }).allowed).toBe(true);
    // An administrator cannot review.
    expect(checkTransition({ from: 'ready_for_review', to: 'reviewed', actor: admin }).denial)
      .toBe('not_authorised');
    expect(checkTransition({ from: 'ready_for_review', to: 'reviewed', actor: qo }).allowed).toBe(true);
  });
});

describe('UAT-02: AM and BC compose differently all the way to the sheet', () => {
  const instant = fromPlantParts('2026-10-24', '09:30').toISOString();

  const groundBase: Record<string, string> = {
    collection_date: '2026-10-24',
    collection_time: '09:30',
    material_or_feed_type: 'Broiler starter',
    batch_or_bin_no: 'B-4471',
    sampled_by: 'A. Persaud',
    mill_screen_size_mm: '5',
    hammer_distance_mm: '12',
  };

  it('AM yields the AM prefix and never writes BC moisture, even if a stale value is held', () => {
    const stale = {
      ...groundBase,
      sampling_point: 'AM',
      avg_particle_size_um: '880',
      size_spread_gsd: '2.1',
      moisture_pct_bc: '12.4', // left over from a BC entry before switching
      tested_by_qo: 'R. Singh',
    };

    expect(resolvePrefix('ground', stale)).toBe('AM');

    const cleared = clearNonApplicable('ground', stale);
    const parsed = parseStageValues('ground', 'testing', cleared);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    // Stripped from the payload entirely, not submitted as null.
    expect(parsed.values).not.toHaveProperty('moisture_pct_bc');

    const row = toSheetRow('ground', 'AM-261024-01', parsed.values);
    expect(row[columnLetterToIndex('L')]).toBe('');

    // And it assesses as Not Applicable — distinct from Not Tested.
    const assessments = assessAll('ground', parsed.values, NO_APPROVED_RULES, instant);
    const bc = assessments.find((a) => a.fieldKey === 'moisture_pct_bc')!;
    expect(bc.assessment.result).toBe('not_applicable');
  });

  it('BC yields the BC prefix and requires moisture at testing', () => {
    const withoutMoisture = {
      ...groundBase,
      sampling_point: 'BC',
      avg_particle_size_um: '720',
      size_spread_gsd: '2.4',
      tested_by_qo: 'R. Singh',
    };

    expect(resolvePrefix('ground', withoutMoisture)).toBe('BC');

    const missing = parseStageValues('ground', 'testing', withoutMoisture);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.errors).toHaveProperty('moisture_pct_bc');

    const complete = parseStageValues('ground', 'testing', { ...withoutMoisture, moisture_pct_bc: '12.4' });
    expect(complete.ok).toBe(true);
    if (!complete.ok) return;
    const row = toSheetRow('ground', 'BC-261024-01', complete.values);
    expect(row[columnLetterToIndex('L')]).toBe('12.4');
  });

  it('the two points write to the same tab but never to each other\'s columns', () => {
    const am = parseStageValues('ground', 'testing', {
      ...groundBase, sampling_point: 'AM', avg_particle_size_um: '880', size_spread_gsd: '2.1', tested_by_qo: 'R. Singh',
    });
    const bc = parseStageValues('ground', 'testing', {
      ...groundBase, sampling_point: 'BC', avg_particle_size_um: '720', size_spread_gsd: '2.4', moisture_pct_bc: '12.4', tested_by_qo: 'R. Singh',
    });
    if (!am.ok || !bc.ok) throw new Error('both should validate');

    const amRow = toSheetRow('ground', 'AM-261024-01', am.values);
    const bcRow = toSheetRow('ground', 'BC-261024-01', bc.values);
    expect(amRow).toHaveLength(15);
    expect(bcRow).toHaveLength(15);
    expect(amRow[columnLetterToIndex('D')]).toBe('AM after mill');
    expect(bcRow[columnLetterToIndex('D')]).toBe('BC before conditioning');
  });
});

describe('UAT-07: the unconfirmed steam-pressure unit survives the whole chain', () => {
  const instant = fromPlantParts('2026-10-24', '10:00').toISOString();

  const conditioned: Record<string, string> = {
    collection_date: '2026-10-24',
    collection_time: '10:00',
    feed_type: 'Broiler starter',
    batch_no: 'B-4471',
    sampled_by: 'A. Persaud',
    steam_pressure_reading: '2.5', // squarely inside the workbook's 2.2-2.8
    water_added_pct: '0.7',
    mash_temperature_c: '85',
    moisture_pct: '13.1',
    tested_by_qo: 'R. Singh',
  };

  it('a reading inside the vendor working range still cannot be assessed', () => {
    const parsed = parseStageValues('conditioned', 'testing', conditioned);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    // Even if someone wrongly approves a bounded rule, the unconfirmed unit
    // gate refuses before any comparison happens.
    const wronglyApproved: SpecificationRule[] = [
      {
        id: 'bad', version: 1, parameterKey: 'conditioned.steam_pressure', stage: 'conditioned',
        material: null, feedType: null, samplingPoint: null, testMethod: null,
        unit: 'to confirm', lowerBound: 2.2, upperBound: 2.8,
        status: 'approved', effectiveFrom: '2026-01-01T00:00:00.000Z', effectiveTo: null,
        approvedBy: 'supervisor-uuid',
      },
    ];

    const assessments = assessAll('conditioned', parsed.values, wronglyApproved, instant);
    const steam = assessments.find((a) => a.fieldKey === 'steam_pressure_reading')!;
    expect(steam.assessment.result).toBe('not_assessable');
    expect(steam.assessment.reason).toBe('unit_not_confirmed');
    // The value is still recorded faithfully.
    const row = toSheetRow('conditioned', 'AC-261024-01', parsed.values);
    expect(row[columnLetterToIndex('G')]).toBe('2.5');
  });

  it('85 degC assesses only once a properly-united rule is approved (UAT-06)', () => {
    const parsed = parseStageValues('conditioned', 'testing', conditioned);
    if (!parsed.ok) throw new Error('should validate');

    const approvedTemp: SpecificationRule[] = [
      {
        id: 'temp', version: 1, parameterKey: 'conditioned.temperature', stage: 'conditioned',
        material: null, feedType: null, samplingPoint: null, testMethod: null,
        unit: '°C', lowerBound: 84, upperBound: 86,
        status: 'approved', effectiveFrom: '2026-01-01T00:00:00.000Z', effectiveTo: null,
        approvedBy: 'supervisor-uuid',
      },
    ];

    const before = assessAll('conditioned', parsed.values, NO_APPROVED_RULES, instant)
      .find((a) => a.fieldKey === 'mash_temperature_c')!;
    expect(before.assessment.result).toBe('not_assessable');

    const after = assessAll('conditioned', parsed.values, approvedTemp, instant)
      .find((a) => a.fieldKey === 'mash_temperature_c')!;
    expect(after.assessment.result).toBe('within_limit');
    expect(after.assessment.ruleId).toBe('temp');

    // Steam pressure is unaffected: approving one parameter does not leak.
    const steam = assessAll('conditioned', parsed.values, approvedTemp, instant)
      .find((a) => a.fieldKey === 'steam_pressure_reading')!;
    expect(steam.assessment.result).toBe('not_assessable');
  });
});

describe('the soft implausibility guard never becomes a limit', () => {
  it('an implausibly high value validates, and only raises a question', () => {
    const values: Record<string, string> = {
      collection_date: '2026-10-24',
      collection_time: '11:00',
      feed_type: 'Broiler finisher',
      batch_no: 'B-4472',
      sampled_by: 'A. Persaud',
      moisture_pct: '13.0',
      avg_particle_size_um: '99999', // beyond implausibleAbove (10000)
      size_spread_gsd: '2.2',
      tested_by_qo: 'R. Singh',
    };

    const parsed = parseStageValues('mash', 'testing', values);
    // Crucially: NOT a validation failure. A soft guard must never reject.
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const findings = implausibleFindings('mash', parsed.values);
    expect(findings.map((f) => f.field.key)).toContain('avg_particle_size_um');

    // Once confirmed, it is written exactly as typed.
    const row = toSheetRow('mash', 'MS-261024-01', parsed.values);
    expect(row[columnLetterToIndex('H')]).toBe('99999');
  });

  it('a physically impossible percentage IS rejected', () => {
    const parsed = parseStageValues('mash', 'testing', {
      collection_date: '2026-10-24', collection_time: '11:00', feed_type: 'x', batch_no: 'y',
      sampled_by: 'z', moisture_pct: '101', avg_particle_size_um: '700',
      size_spread_gsd: '2.2', tested_by_qo: 'q',
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.errors).toHaveProperty('moisture_pct');
  });
});

describe('entered precision survives validation and mapping', () => {
  it('a trailing zero the operator typed reaches the sheet cell', () => {
    const parsed = parseStageValues('conditioned', 'testing', {
      collection_date: '2026-10-24', collection_time: '10:00', feed_type: 'x', batch_no: 'y',
      sampled_by: 'z', steam_pressure_reading: '2.50', water_added_pct: '0.70',
      mash_temperature_c: '84.0', moisture_pct: '13.10', tested_by_qo: 'q',
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const row = toSheetRow('conditioned', 'AC-261024-02', parsed.values);
    expect(row[columnLetterToIndex('I')]).toBe('84.0');
    expect(row[columnLetterToIndex('G')]).toBe('2.50');
    expect(row[columnLetterToIndex('J')]).toBe('13.10');
  });
});

describe('every stage composes without throwing', () => {
  it('a minimal registration payload maps to a correctly-sized row on every tab', () => {
    const instant = fromPlantParts('2026-10-24', '12:00').toISOString();
    let checked = 0;

    for (const stage of Object.keys(STAGE_SCHEMAS) as Stage[]) {
      const schema = STAGE_SCHEMAS[stage];
      const values: Record<string, string> = {
        collection_date: '2026-10-24',
        collection_time: '12:00',
        sampling_point: 'BC', // only meaningful for ground; ignored elsewhere
      };
      // Fill every registration-required field with a plausible value.
      for (const f of schema.fields) {
        if (f.required !== 'registration') continue;
        if (values[f.key] !== undefined) continue;
        if (f.type === 'number') values[f.key] = '1';
        else if (f.type === 'select' || f.type === 'yesno') values[f.key] = f.options![0]!.value;
        else if (f.type === 'text' || f.type === 'textarea') values[f.key] = 'x';
      }

      const parsed = parseStageValues(stage, 'registration', values);
      expect(parsed.ok, `${stage}: ${JSON.stringify(parsed.ok ? {} : parsed.errors)}`).toBe(true);
      if (!parsed.ok) continue;

      const prefix = resolvePrefix(stage, values);
      const id = formatSampleId(prefix as never, '2026-10-24', 1);
      const row = toSheetRow(stage, id, parsed.values);
      expect(row, stage).toHaveLength(schema.columnCount);
      expect(row[0], stage).toBe(id);

      // Nothing can assess, because nothing is approved.
      const assessments = assessAll(stage, parsed.values, NO_APPROVED_RULES, instant);
      expect(assessments.some((a) => a.assessment.result === 'within_limit'), stage).toBe(false);
      checked++;
    }

    // Asserted coverage, not implied by the loop. Stated both ways on purpose:
    // the first fails if a stage stops composing, the second if a stage is
    // removed from the registry and the first silently follows it down.
    expect(checked).toBe(Object.keys(STAGE_SCHEMAS).length);
    expect(checked).toBe(8);
  });
});
