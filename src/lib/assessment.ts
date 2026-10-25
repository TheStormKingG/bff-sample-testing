/**
 * Specification evaluation.
 *
 * The one rule this module exists to enforce: a measurement is `within_limit`
 * only when exactly one APPROVED, EFFECTIVE, UNIT-COMPATIBLE, CONTEXT-MATCHED
 * rule says so. Every other situation — no rule, several equally applicable
 * rules, an unapproved rule, an unconfirmed unit, a rule with no bounds —
 * returns `not_assessable`. It never returns `within_limit`.
 *
 * As of the 2026-10-24 workbook read, 0 of the 34 `Limits` entries are
 * approved, so on the seeded production dataset EVERY measurement assesses as
 * `not_assessable`. That is the correct and intended behaviour, not a defect
 * (PRD §7, FR-009, UAT-05, risk R-01).
 *
 * The engine deliberately does NOT read the `Limits` tab at evaluation time.
 * That tab warns in its own row 2 that "the test tabs read these cells by
 * their position", so a single inserted row would silently re-point every
 * limit. Rules come from `specification_versions`, keyed by a stable
 * `parameter_key` (PRD §7.1: "No spreadsheet row number may be used as a
 * primary rule key").
 */

import type { Stage } from '../forms/types.ts';

export const ASSESSMENT_RESULTS = [
  'within_limit',
  'outside_limit',
  'not_assessable',
  'not_tested',
  'not_applicable',
] as const;
export type AssessmentResult = (typeof ASSESSMENT_RESULTS)[number];

/** Why an assessment came out as it did. Stored as immutable evidence. */
export type AssessmentReason =
  | 'within_approved_bounds'
  | 'outside_approved_bounds'
  | 'field_not_applicable'
  | 'no_result_recorded'
  | 'value_not_finite'
  | 'unit_not_confirmed'
  | 'no_approved_rule'
  | 'ambiguous_rules'
  | 'unit_mismatch'
  | 'rule_has_no_bounds';

export const SPEC_STATUSES = [
  'draft',
  'proposed',
  'approved',
  'rejected',
  'superseded',
  /** Imported from the workbook `Limits` tab for reference. Never assessable. */
  'reference_only',
] as const;
export type SpecStatus = (typeof SPEC_STATUSES)[number];

/**
 * The four status strings found in the live workbook `Limits` tab. The fourth
 * (`To set with Polinutri`) is not documented in the PRD and was discovered in
 * the 2026-10-24 read. None of them maps to `approved`.
 */
export const WORKBOOK_LIMIT_STATUSES = [
  'To set',
  'Set',
  'Confirm with Polinutri',
  'To set with Polinutri',
] as const;
export type WorkbookLimitStatus = (typeof WORKBOOK_LIMIT_STATUSES)[number];

export interface SpecificationRule {
  readonly id: string;
  readonly version: number;
  readonly parameterKey: string;
  readonly stage: Stage;
  /** Applicability filters. `null` means "applies regardless". */
  readonly material: string | null;
  readonly feedType: string | null;
  readonly samplingPoint: string | null;
  readonly testMethod: string | null;
  /** Approved unit. `null` when the source states no confirmed unit. */
  readonly unit: string | null;
  readonly lowerBound: number | null;
  readonly upperBound: number | null;
  readonly status: SpecStatus;
  /** ISO instant from which the rule applies. */
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  /** Null unless a supervisor approved it. An unapproved rule cannot assess. */
  readonly approvedBy: string | null;
}

export interface MeasurementContext {
  readonly stage: Stage;
  readonly parameterKey: string;
  /** Null means not measured. Zero is a real measured value. */
  readonly value: number | null;
  /** Unit of the recorded measurement, from the registry. */
  readonly unit: string | null;
  /** False when the registry marks the field's unit as unconfirmed. */
  readonly unitConfirmed: boolean;
  /** False when the field does not apply (e.g. BC moisture at AM). */
  readonly applicable: boolean;
  readonly material?: string | null;
  readonly feedType?: string | null;
  readonly samplingPoint?: string | null;
  readonly testMethod?: string | null;
  /** Plant collection instant; rule effectivity is evaluated against this. */
  readonly collectionInstant: string;
}

export interface Assessment {
  readonly result: AssessmentResult;
  readonly reason: AssessmentReason;
  /** Immutable evidence of which rule version decided this. */
  readonly ruleId: string | null;
  readonly ruleVersion: number | null;
  readonly lowerBound: number | null;
  readonly upperBound: number | null;
  readonly unit: string | null;
  /** How many approved candidate rules matched, for diagnosis. */
  readonly candidateCount: number;
  /** Human-readable explanation shown beside the result. */
  readonly explanation: string;
}

/** A unit string that names no dimension cannot be compared against anything. */
const UNCONFIRMED_UNIT_TOKENS = ['to confirm', 'tbc', 'unconfirmed', 'unknown', ''];

export function isUnitConfirmed(unit: string | null | undefined): boolean {
  if (unit === null || unit === undefined) return false;
  return !UNCONFIRMED_UNIT_TOKENS.includes(unit.trim().toLowerCase());
}

function ruleIsApproved(rule: SpecificationRule): boolean {
  // Both conditions required: a row can carry status 'approved' only together
  // with a recorded approver, and an approver alone is not enough.
  return rule.status === 'approved' && rule.approvedBy !== null;
}

function ruleIsEffective(rule: SpecificationRule, instant: string): boolean {
  const t = new Date(instant).getTime();
  if (Number.isNaN(t)) return false;
  if (new Date(rule.effectiveFrom).getTime() > t) return false;
  if (rule.effectiveTo !== null && new Date(rule.effectiveTo).getTime() <= t) return false;
  return true;
}

/**
 * Specificity score: how many applicability filters the rule actually pins
 * down. A corn-specific moisture rule (score 1) beats a rule that applies to
 * any material (score 0). Two rules at the SAME top score are "equally
 * applicable" and therefore ambiguous (PRD §7.2 step 2).
 */
function specificity(rule: SpecificationRule): number {
  let score = 0;
  if (rule.material !== null) score++;
  if (rule.feedType !== null) score++;
  if (rule.samplingPoint !== null) score++;
  if (rule.testMethod !== null) score++;
  return score;
}

function filterMatches(ruleValue: string | null, ctxValue: string | null | undefined): boolean {
  if (ruleValue === null) return true; // wildcard
  if (ctxValue === null || ctxValue === undefined) return false;
  return ruleValue.toLowerCase() === ctxValue.toLowerCase();
}

function ruleApplies(rule: SpecificationRule, ctx: MeasurementContext): boolean {
  return (
    rule.parameterKey === ctx.parameterKey &&
    rule.stage === ctx.stage &&
    filterMatches(rule.material, ctx.material) &&
    filterMatches(rule.feedType, ctx.feedType) &&
    filterMatches(rule.samplingPoint, ctx.samplingPoint) &&
    filterMatches(rule.testMethod, ctx.testMethod)
  );
}

const EMPTY = {
  ruleId: null,
  ruleVersion: null,
  lowerBound: null,
  upperBound: null,
  unit: null,
  candidateCount: 0,
} as const;

/**
 * Assess one measurement against the approved ruleset.
 *
 * Order matters. Applicability and absence are settled before any rule lookup,
 * so a missing result can never be reported as a limit decision.
 */
export function assess(
  ctx: MeasurementContext,
  rules: readonly SpecificationRule[],
): Assessment {
  if (!ctx.applicable) {
    return {
      ...EMPTY,
      result: 'not_applicable',
      reason: 'field_not_applicable',
      explanation: 'This test does not apply to the selected sampling point.',
    };
  }

  if (ctx.value === null || ctx.value === undefined) {
    return {
      ...EMPTY,
      result: 'not_tested',
      reason: 'no_result_recorded',
      explanation: 'No result has been recorded yet.',
    };
  }

  if (!Number.isFinite(ctx.value)) {
    return {
      ...EMPTY,
      result: 'not_assessable',
      reason: 'value_not_finite',
      explanation: 'The recorded value is not a finite number.',
    };
  }

  // The unconfirmed-unit gate runs BEFORE rule lookup. The workbook's only
  // `Set` steam-pressure rule has the literal unit "to confirm", so a lookup
  // would otherwise find a bounded rule and compare against it (UAT-07, R-02).
  if (!ctx.unitConfirmed || !isUnitConfirmed(ctx.unit)) {
    return {
      ...EMPTY,
      result: 'not_assessable',
      reason: 'unit_not_confirmed',
      explanation:
        'The unit for this measurement is not confirmed, so it cannot be compared against a limit.',
    };
  }

  const candidates = rules
    .filter((r) => ruleApplies(r, ctx))
    .filter(ruleIsApproved)
    .filter((r) => ruleIsEffective(r, ctx.collectionInstant));

  if (candidates.length === 0) {
    return {
      ...EMPTY,
      result: 'not_assessable',
      reason: 'no_approved_rule',
      explanation:
        'No approved limit applies to this test, so conformity cannot be decided.',
    };
  }

  const topScore = Math.max(...candidates.map(specificity));
  const mostSpecific = candidates.filter((r) => specificity(r) === topScore);

  if (mostSpecific.length > 1) {
    return {
      ...EMPTY,
      candidateCount: mostSpecific.length,
      result: 'not_assessable',
      reason: 'ambiguous_rules',
      explanation: `${mostSpecific.length} equally applicable approved limits were found. Ambiguity must be resolved by Quality before this test can be assessed.`,
    };
  }

  const rule = mostSpecific[0]!;
  const base = {
    ruleId: rule.id,
    ruleVersion: rule.version,
    lowerBound: rule.lowerBound,
    upperBound: rule.upperBound,
    unit: rule.unit,
    candidateCount: 1,
  };

  // No conversion table exists, so unit equivalence means unit equality. An
  // approved conversion would be a reviewed change, not an inference here.
  if (!isUnitConfirmed(rule.unit) || rule.unit!.trim().toLowerCase() !== ctx.unit!.trim().toLowerCase()) {
    return {
      ...base,
      result: 'not_assessable',
      reason: 'unit_mismatch',
      explanation: `The approved limit is expressed in ${rule.unit ?? 'an unconfirmed unit'} but the result was recorded in ${ctx.unit}.`,
    };
  }

  if (rule.lowerBound === null && rule.upperBound === null) {
    return {
      ...base,
      result: 'not_assessable',
      reason: 'rule_has_no_bounds',
      explanation: 'The approved rule records no limit on either side.',
    };
  }

  // Bounds are INCLUSIVE (PRD §7.2 step 5, UAT-06: 84 and 86 are Within).
  const belowLower = rule.lowerBound !== null && ctx.value < rule.lowerBound;
  const aboveUpper = rule.upperBound !== null && ctx.value > rule.upperBound;

  if (belowLower || aboveUpper) {
    return {
      ...base,
      result: 'outside_limit',
      reason: 'outside_approved_bounds',
      explanation: `${ctx.value} ${rule.unit} is outside the approved limit of ${describeBounds(rule)}.`,
    };
  }

  return {
    ...base,
    result: 'within_limit',
    reason: 'within_approved_bounds',
    explanation: `${ctx.value} ${rule.unit} is within the approved limit of ${describeBounds(rule)}.`,
  };
}

export function describeBounds(rule: {
  lowerBound: number | null;
  upperBound: number | null;
  unit: string | null;
}): string {
  const u = rule.unit ? ` ${rule.unit}` : '';
  if (rule.lowerBound !== null && rule.upperBound !== null) {
    return `${rule.lowerBound} to ${rule.upperBound}${u}`;
  }
  if (rule.lowerBound !== null) return `at least ${rule.lowerBound}${u}`;
  if (rule.upperBound !== null) return `at most ${rule.upperBound}${u}`;
  return 'no limit set';
}

export const ASSESSMENT_LABELS: Record<AssessmentResult, string> = {
  within_limit: 'Within limit',
  outside_limit: 'Outside limit',
  not_assessable: 'Not assessable',
  not_tested: 'Not tested',
  not_applicable: 'Not applicable',
};

/**
 * Does this set of assessments plus observations require a quality hold?
 *
 * Master Prompt §6: any adverse visual observation forces a hold "regardless
 * of numeric results", and an approved out-of-limit finding creates one.
 * `not_assessable` does NOT create a hold — it blocks automatic ACCEPTANCE,
 * which is a different control and is enforced by the workflow module.
 */
export interface HoldTrigger {
  readonly kind: 'adverse_observation' | 'outside_approved_limit';
  readonly fieldKey: string;
  readonly detail: string;
}

export function holdTriggers(args: {
  readonly observations: readonly { fieldKey: string; label: string; value: string | null; adverseValue: string }[];
  readonly assessments: readonly { fieldKey: string; label: string; assessment: Assessment }[];
}): HoldTrigger[] {
  const triggers: HoldTrigger[] = [];

  for (const o of args.observations) {
    if (o.value !== null && o.value.toLowerCase() === o.adverseValue.toLowerCase()) {
      triggers.push({
        kind: 'adverse_observation',
        fieldKey: o.fieldKey,
        detail: `${o.label} answered Yes.`,
      });
    }
  }

  for (const a of args.assessments) {
    if (a.assessment.result === 'outside_limit') {
      triggers.push({
        kind: 'outside_approved_limit',
        fieldKey: a.fieldKey,
        detail: `${a.label}: ${a.assessment.explanation}`,
      });
    }
  }

  return triggers;
}
