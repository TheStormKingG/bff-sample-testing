/**
 * Specification-engine acceptance tests.
 *
 * Maps directly onto PRD §13 UAT-05, UAT-06, UAT-07 and UAT-08, and
 * Master Prompt §10.
 */
import { describe, it, expect } from 'vitest';
import {
  assess,
  holdTriggers,
  isUnitConfirmed,
  WORKBOOK_LIMIT_STATUSES,
  type MeasurementContext,
  type SpecificationRule,
} from '@/lib/assessment';

const COLLECTION = '2026-10-24T12:00:00.000Z';

function rule(overrides: Partial<SpecificationRule> = {}): SpecificationRule {
  return {
    id: 'rule-1',
    version: 1,
    parameterKey: 'conditioned.temperature',
    stage: 'conditioned',
    material: null,
    feedType: null,
    samplingPoint: null,
    testMethod: null,
    unit: '°C',
    lowerBound: 84,
    upperBound: 86,
    status: 'approved',
    effectiveFrom: '2026-01-01T00:00:00.000Z',
    effectiveTo: null,
    approvedBy: 'supervisor-uuid',
    ...overrides,
  };
}

function ctx(overrides: Partial<MeasurementContext> = {}): MeasurementContext {
  return {
    stage: 'conditioned',
    parameterKey: 'conditioned.temperature',
    value: 85,
    unit: '°C',
    unitConfirmed: true,
    applicable: true,
    collectionInstant: COLLECTION,
    ...overrides,
  };
}

describe('UAT-06: approved inclusive boundaries', () => {
  const rules = [rule()];

  it.each([
    [84, 'within_limit'],
    [85, 'within_limit'],
    [86, 'within_limit'],
    [83.9, 'outside_limit'],
    [86.1, 'outside_limit'],
  ] as const)('%s degC assesses as %s', (value, expected) => {
    expect(assess(ctx({ value }), rules).result).toBe(expected);
  });

  it('records the deciding rule id and version as evidence', () => {
    const a = assess(ctx({ value: 85 }), rules);
    expect(a.ruleId).toBe('rule-1');
    expect(a.ruleVersion).toBe(1);
    expect(a.lowerBound).toBe(84);
    expect(a.upperBound).toBe(86);
    expect(a.explanation).toContain('84 to 86');
  });

  it('treats a one-sided bound correctly', () => {
    const upperOnly = [rule({ lowerBound: null, upperBound: 20 })];
    expect(assess(ctx({ value: 20 }), upperOnly).result).toBe('within_limit');
    expect(assess(ctx({ value: 20.01 }), upperOnly).result).toBe('outside_limit');
    expect(assess(ctx({ value: 0 }), upperOnly).result).toBe('within_limit');

    const lowerOnly = [rule({ lowerBound: 70, upperBound: null })];
    expect(assess(ctx({ value: 70 }), lowerOnly).result).toBe('within_limit');
    expect(assess(ctx({ value: 69.99 }), lowerOnly).result).toBe('outside_limit');
  });
});

describe('UAT-05: missing or unapproved limits never pass', () => {
  it('returns not_assessable when no rule exists', () => {
    const a = assess(ctx(), []);
    expect(a.result).toBe('not_assessable');
    expect(a.reason).toBe('no_approved_rule');
  });

  it('ignores a rule that is merely proposed', () => {
    const a = assess(ctx(), [rule({ status: 'proposed' })]);
    expect(a.result).toBe('not_assessable');
    expect(a.reason).toBe('no_approved_rule');
  });

  it('ignores a reference_only rule imported from the Limits tab', () => {
    // All 34 workbook entries import at this status, including the four
    // marked "Set". None may drive an assessment.
    const a = assess(ctx(), [rule({ status: 'reference_only' })]);
    expect(a.result).toBe('not_assessable');
  });

  it('ignores a rule flagged approved but with no recorded approver', () => {
    // Status and approver must agree; one without the other is a data defect
    // that must fail closed rather than silently assess.
    const a = assess(ctx(), [rule({ status: 'approved', approvedBy: null })]);
    expect(a.result).toBe('not_assessable');
    expect(a.reason).toBe('no_approved_rule');
  });

  it('ignores a rule not yet effective at the collection instant', () => {
    const a = assess(ctx(), [rule({ effectiveFrom: '2026-12-01T00:00:00.000Z' })]);
    expect(a.result).toBe('not_assessable');
  });

  it('ignores a rule that had already expired', () => {
    const a = assess(ctx(), [rule({ effectiveTo: '2026-06-01T00:00:00.000Z' })]);
    expect(a.result).toBe('not_assessable');
  });

  it('returns not_assessable when an approved rule carries no bounds', () => {
    const a = assess(ctx(), [rule({ lowerBound: null, upperBound: null })]);
    expect(a.result).toBe('not_assessable');
    expect(a.reason).toBe('rule_has_no_bounds');
  });

  it('never returns within_limit for any unapproved status', () => {
    for (const status of ['draft', 'proposed', 'rejected', 'superseded', 'reference_only'] as const) {
      const a = assess(ctx({ value: 85 }), [rule({ status })]);
      expect(a.result, status).not.toBe('within_limit');
    }
  });

  it('every workbook limit status is distinct from an approved spec status', () => {
    // The live Limits tab contains four status strings, including the
    // undocumented "To set with Polinutri". None is an approval.
    expect(WORKBOOK_LIMIT_STATUSES).toHaveLength(4);
    expect(WORKBOOK_LIMIT_STATUSES).toContain('To set with Polinutri');
    expect(WORKBOOK_LIMIT_STATUSES).not.toContain('approved');
  });
});

describe('UAT-07: unconfirmed units can never pass', () => {
  it('blocks assessment when the field unit is unconfirmed', () => {
    // Steam pressure: the Limits tab's Unit cell literally reads "to confirm"
    // even though the row is marked Set with bounds 2.2-2.8.
    const steam = ctx({
      parameterKey: 'conditioned.steam_pressure',
      value: 2.5,
      unit: null,
      unitConfirmed: false,
    });
    const steamRule = rule({
      parameterKey: 'conditioned.steam_pressure',
      unit: 'to confirm',
      lowerBound: 2.2,
      upperBound: 2.8,
    });
    const a = assess(steam, [steamRule]);
    expect(a.result).toBe('not_assessable');
    expect(a.reason).toBe('unit_not_confirmed');
  });

  it('blocks a value that sits inside the working range', () => {
    // 2.5 is squarely inside 2.2-2.8. Without the unit gate this would read
    // as a pass, which is exactly the failure R-02 warns about.
    const a = assess(
      ctx({ parameterKey: 'conditioned.steam_pressure', value: 2.5, unit: null, unitConfirmed: false }),
      [rule({ parameterKey: 'conditioned.steam_pressure', unit: 'to confirm', lowerBound: 2.2, upperBound: 2.8 })],
    );
    expect(a.result).not.toBe('within_limit');
  });

  it('blocks assessment when the RULE unit is unconfirmed but the field is fine', () => {
    const a = assess(ctx({ value: 85 }), [rule({ unit: 'to confirm' })]);
    expect(a.result).toBe('not_assessable');
    expect(a.reason).toBe('unit_mismatch');
  });

  it('blocks a unit mismatch rather than converting silently', () => {
    const a = assess(ctx({ unit: '°F', value: 185 }), [rule({ unit: '°C' })]);
    expect(a.result).toBe('not_assessable');
    expect(a.reason).toBe('unit_mismatch');
  });

  it.each([null, undefined, '', '  ', 'to confirm', 'TO CONFIRM', 'TBC', 'unknown'])(
    'treats %s as an unconfirmed unit',
    (u) => {
      expect(isUnitConfirmed(u as string | null)).toBe(false);
    },
  );

  it.each(['°C', '%', 'mm', 'ppb', 'µm', 'ton/hr', 'pH rise'])('treats %s as confirmed', (u) => {
    expect(isUnitConfirmed(u)).toBe(true);
  });
});

describe('absence, applicability and non-finite values', () => {
  it('reports a missing result as not_tested, never as a limit decision', () => {
    const a = assess(ctx({ value: null }), [rule()]);
    expect(a.result).toBe('not_tested');
    expect(a.reason).toBe('no_result_recorded');
  });

  it('assesses a real zero rather than treating it as missing', () => {
    const a = assess(
      ctx({ parameterKey: 'raw_materials.aflatoxin', stage: 'raw_materials', value: 0, unit: 'ppb' }),
      [rule({ parameterKey: 'raw_materials.aflatoxin', stage: 'raw_materials', unit: 'ppb', lowerBound: null, upperBound: 20 })],
    );
    expect(a.result).toBe('within_limit');
  });

  it('reports a non-applicable field as not_applicable (UAT-02)', () => {
    const a = assess(ctx({ applicable: false }), [rule()]);
    expect(a.result).toBe('not_applicable');
    expect(a.reason).toBe('field_not_applicable');
  });

  it('settles applicability before absence', () => {
    const a = assess(ctx({ applicable: false, value: null }), [rule()]);
    expect(a.result).toBe('not_applicable');
  });

  it('refuses a non-finite value', () => {
    expect(assess(ctx({ value: NaN }), [rule()]).reason).toBe('value_not_finite');
    expect(assess(ctx({ value: Infinity }), [rule()]).reason).toBe('value_not_finite');
  });
});

describe('rule matching: context, specificity and ambiguity', () => {
  it('does not apply a rule from another stage or parameter', () => {
    expect(assess(ctx(), [rule({ stage: 'pellets' })]).result).toBe('not_assessable');
    expect(assess(ctx(), [rule({ parameterKey: 'pellets.temperature' })]).result).toBe('not_assessable');
  });

  it('matches a material-specific rule only for that material', () => {
    const corn = rule({
      parameterKey: 'raw_materials.moisture',
      stage: 'raw_materials',
      material: 'corn',
      unit: '%',
      lowerBound: null,
      upperBound: 14,
    });
    const base = ctx({
      parameterKey: 'raw_materials.moisture',
      stage: 'raw_materials',
      unit: '%',
      value: 13,
    });
    expect(assess({ ...base, material: 'corn' }, [corn]).result).toBe('within_limit');
    expect(assess({ ...base, material: 'rice' }, [corn]).result).toBe('not_assessable');
    // A sample with no material recorded must not inherit a material rule.
    expect(assess({ ...base, material: null }, [corn]).result).toBe('not_assessable');
  });

  it('prefers the more specific rule over a wildcard', () => {
    const wildcard = rule({ id: 'wild', material: null, lowerBound: 80, upperBound: 90 });
    const specific = rule({ id: 'specific', material: 'corn', lowerBound: 84, upperBound: 86 });
    const a = assess(ctx({ value: 83, material: 'corn' }), [wildcard, specific]);
    expect(a.ruleId).toBe('specific');
    expect(a.result).toBe('outside_limit');
  });

  it('refuses to choose between two equally applicable rules', () => {
    const a = assess(ctx(), [rule({ id: 'a' }), rule({ id: 'b', upperBound: 90 })]);
    expect(a.result).toBe('not_assessable');
    expect(a.reason).toBe('ambiguous_rules');
    expect(a.candidateCount).toBe(2);
  });

  it('is case-insensitive on applicability filters but not permissive', () => {
    const r = rule({ material: 'Corn', parameterKey: 'raw_materials.moisture', stage: 'raw_materials', unit: '%' });
    const base = ctx({ parameterKey: 'raw_materials.moisture', stage: 'raw_materials', unit: '%', value: 85 });
    expect(assess({ ...base, material: 'corn' }, [r]).candidateCount).toBe(1);
    expect(assess({ ...base, material: 'soya' }, [r]).candidateCount).toBe(0);
  });

  it('distinguishes AM from BC rules by sampling point', () => {
    const amRule = rule({
      parameterKey: 'ground.avg_particle_size',
      stage: 'ground',
      samplingPoint: 'AM',
      unit: 'µm',
      lowerBound: 850,
      upperBound: 950,
    });
    const base = ctx({
      parameterKey: 'ground.avg_particle_size',
      stage: 'ground',
      unit: 'µm',
      value: 900,
    });
    expect(assess({ ...base, samplingPoint: 'AM' }, [amRule]).result).toBe('within_limit');
    expect(assess({ ...base, samplingPoint: 'BC' }, [amRule]).result).toBe('not_assessable');
  });
});

describe('UAT-08: adverse observations force a hold regardless of numbers', () => {
  const within = assess(ctx({ value: 85 }), [rule()]);

  it('mould seen = Yes raises a hold even when every number is within limit', () => {
    expect(within.result).toBe('within_limit');
    const triggers = holdTriggers({
      observations: [
        { fieldKey: 'mould_seen', label: 'Mould seen?', value: 'yes', adverseValue: 'yes' },
        { fieldKey: 'insects_seen', label: 'Insects seen?', value: 'no', adverseValue: 'yes' },
      ],
      assessments: [{ fieldKey: 'mash_temperature_c', label: 'Mash temperature', assessment: within }],
    });
    expect(triggers).toHaveLength(1);
    expect(triggers[0]!.kind).toBe('adverse_observation');
    expect(triggers[0]!.fieldKey).toBe('mould_seen');
  });

  it.each(['mould_seen', 'insects_seen', 'foreign_matter_seen', 'bad_smell'])(
    '%s = Yes raises a hold',
    (fieldKey) => {
      const triggers = holdTriggers({
        observations: [{ fieldKey, label: fieldKey, value: 'yes', adverseValue: 'yes' }],
        assessments: [],
      });
      expect(triggers).toHaveLength(1);
    },
  );

  it('raises no hold when all observations are No and all numbers pass', () => {
    const triggers = holdTriggers({
      observations: [{ fieldKey: 'mould_seen', label: 'Mould seen?', value: 'no', adverseValue: 'yes' }],
      assessments: [{ fieldKey: 'mash_temperature_c', label: 'Mash temperature', assessment: within }],
    });
    expect(triggers).toHaveLength(0);
  });

  it('does not raise a hold from an unanswered observation', () => {
    const triggers = holdTriggers({
      observations: [{ fieldKey: 'mould_seen', label: 'Mould seen?', value: null, adverseValue: 'yes' }],
      assessments: [],
    });
    expect(triggers).toHaveLength(0);
  });

  it('raises a hold on an approved out-of-limit result', () => {
    const outside = assess(ctx({ value: 95 }), [rule()]);
    expect(outside.result).toBe('outside_limit');
    const triggers = holdTriggers({
      observations: [],
      assessments: [{ fieldKey: 'mash_temperature_c', label: 'Mash temperature', assessment: outside }],
    });
    expect(triggers).toHaveLength(1);
    expect(triggers[0]!.kind).toBe('outside_approved_limit');
  });

  it('does NOT raise a hold merely because a result is not assessable', () => {
    // not_assessable blocks automatic acceptance — a different control,
    // enforced by the release gate — but it is not itself a finding.
    const na = assess(ctx(), []);
    expect(na.result).toBe('not_assessable');
    const triggers = holdTriggers({
      observations: [],
      assessments: [{ fieldKey: 'mash_temperature_c', label: 'Mash temperature', assessment: na }],
    });
    expect(triggers).toHaveLength(0);
  });
});

describe('the seeded production ruleset assesses nothing', () => {
  it('no measurement can pass when every imported limit is reference_only', () => {
    // The real seed state as of 2026-10-24: 34 entries, 0 approved.
    const imported: SpecificationRule[] = [
      rule({ id: 's13', parameterKey: 'conditioned.steam_pressure', unit: 'to confirm', lowerBound: 2.2, upperBound: 2.8, status: 'reference_only', approvedBy: null }),
      rule({ id: 's14', parameterKey: 'conditioned.water_added', unit: '%', lowerBound: 0.5, upperBound: 1, status: 'reference_only', approvedBy: null }),
      rule({ id: 's15', parameterKey: 'conditioned.temperature', unit: '°C', lowerBound: 84, upperBound: 86, status: 'reference_only', approvedBy: null }),
      rule({ id: 's27', parameterKey: 'crumble.roll_gap', stage: 'crumble', unit: 'mm', lowerBound: 1.2, upperBound: 1.8, status: 'reference_only', approvedBy: null }),
    ];
    for (const value of [84, 85, 86, 2.5, 0.7, 1.5]) {
      expect(assess(ctx({ value }), imported).result).toBe('not_assessable');
    }
  });
});
