/**
 * A rule's scope is visible on the screen that approves it.
 *
 * ===========================================================================
 * WHY THIS FILE EXISTS
 * ===========================================================================
 * Migration 0044 gave the engine a fifth applicability dimension and 0045
 * made two differently-scoped rules approvable at once. The first real use of
 * it is four Ground grind targets — corn and rice, for pelleted and for
 * mashed feed — which differ in nothing a reader can see except their bounds.
 *
 * `applicabilityText` is the one line on the specifications screen that says
 * what a rule applies to, and it ignored `grind_purpose` until 2026-11-03.
 * The consequence was not cosmetic: an approver would have been shown four
 * rows for one parameter, each saying "Any material, feed type, sampling
 * point and method", and asked to approve them one at a time. Approving a
 * limit you cannot distinguish from three others is not an approval.
 *
 * So the assertion here is not about wording. It is that two rules differing
 * only in scope produce different text — which is the property the screen
 * needs and the one a future edit to that function could silently break.
 */

import { describe, expect, it } from 'vitest';

import { applicabilityText } from '@/lib/specificationScope';
import { grindPurposeLabel } from '@/forms/registry';
import type { SpecificationVersionRow } from '@/hooks/useSamples';

/** A proposed rule, unscoped, with only the fields this function reads. */
function rule(overrides: Partial<SpecificationVersionRow> = {}): SpecificationVersionRow {
  return {
    id: 'r1',
    specification_id: 's1',
    version: 1,
    parameter_key: 'ground.avg_particle_size',
    stage: 'ground',
    material: null,
    feed_type: null,
    sampling_point: null,
    test_method: null,
    grind_purpose: null,
    unit: 'µm',
    lower_bound: 1200,
    upper_bound: 1300,
    status: 'proposed',
    effective_from: '2026-11-03T00:00:00.000Z',
    effective_to: null,
    proposed_by: 'p1',
    approved_by: null,
    approved_at: null,
    decision_reason: null,
    source_evidence: 'test',
    workbook_entry_no: null,
    workbook_status: null,
    ...overrides,
  } as SpecificationVersionRow;
}

const GROUND_PURPOSES = ['corn_pelleted', 'rice_pelleted', 'corn_mashed', 'rice_mashed'] as const;

describe('a rule scoped to a grind purpose says so', () => {
  it('names the purpose in the plant\'s words, not the code', () => {
    const text = applicabilityText(rule({ grind_purpose: 'corn_pelleted' }));
    expect(text).toContain('Corn for pelletized feed');
    // The code itself is not what an approver should be reading.
    expect(text).not.toContain('corn_pelleted');
  });

  it('gives each of the four grind targets its own line', () => {
    /*
      THE ACTUAL REQUIREMENT. These four rules are identical but for their
      purpose, and they are the set that will sit on the approval screen
      together. If `applicabilityText` drops the dimension they collapse to
      one string, and this set has size 1.
    */
    const texts = GROUND_PURPOSES.map((p) => applicabilityText(rule({ grind_purpose: p })));
    expect(new Set(texts).size).toBe(GROUND_PURPOSES.length);
    for (const purpose of GROUND_PURPOSES) {
      expect(applicabilityText(rule({ grind_purpose: purpose }))).toContain(
        grindPurposeLabel(purpose),
      );
    }
  });

  it('INSTRUMENT: the assertion above fails if the dimension is ignored', () => {
    /*
      The control. Four rules that genuinely share a scope MUST collapse to
      one string — which is what the test above would see if the dimension
      were dropped again. Without this, a `applicabilityText` that returned a
      unique string per call for some unrelated reason (an id, a counter)
      would satisfy the set-size assertion while telling the reader nothing.
    */
    const same = GROUND_PURPOSES.map(() => applicabilityText(rule({ grind_purpose: null })));
    expect(new Set(same).size).toBe(1);
  });
});

describe('the other four dimensions still show, and "any" still reads as any', () => {
  it('names a material-scoped rule', () => {
    // The three raw-material moisture limits are scoped this way.
    expect(applicabilityText(rule({ material: 'corn' }))).toContain('material corn');
  });

  it('describes a rule scoped on nothing as applying to anything', () => {
    const text = applicabilityText(rule());
    expect(text).toMatch(/^Any /);
    // Grind is named among them, so the sentence does not quietly omit a
    // dimension the rule genuinely does not constrain.
    expect(text).toContain('grind');
  });

  it('lists every dimension a rule pins down, including grind', () => {
    const text = applicabilityText(
      rule({
        material: 'corn',
        feed_type: 'Starter',
        sampling_point: 'BC',
        test_method: 'sieve',
        grind_purpose: 'rice_mashed',
      }),
    );
    for (const fragment of [
      'material corn',
      'feed type Starter',
      'sampling point BC',
      'method sieve',
      'Rice for mashed feed',
    ]) {
      expect(text).toContain(fragment);
    }
  });
});
