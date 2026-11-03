/**
 * What a specification rule applies to, in one line, for a reader.
 *
 * ===========================================================================
 * WHY THIS IS ITS OWN MODULE
 * ===========================================================================
 * It lived inside `SpecificationsPage.tsx` until 2026-11-03. It is a pure
 * function of a row, it is the only thing on the approval screen that says
 * what a rule covers, and it needed a test — and exporting a non-component
 * from a page module breaks fast refresh for the whole file, which the lint
 * rule `react-refresh/only-export-components` correctly objects to.
 */

import { grindPurposeLabel } from '@/forms/registry';
import type { SpecificationVersionRow } from '@/hooks/useSamples';

/**
 * Applicability, in the plant's own words. Blank means "any".
 *
 * The property this must hold, and the one `tests/scopedRuleDisplay.test.ts`
 * guards: two rules differing ONLY in scope produce DIFFERENT text. Four
 * Ground grind targets — corn and rice, for pelleted and for mashed feed —
 * differ in nothing else a reader can see, and rendering them identically
 * would put four indistinguishable rows in front of the person approving
 * them. Approving a limit you cannot tell from three others is not an
 * approval, so every dimension a rule pins down has to appear here.
 */
export function applicabilityText(rule: SpecificationVersionRow): string {
  const parts: string[] = [];
  if (rule.material !== null && rule.material !== '') parts.push(`material ${rule.material}`);
  if (rule.feed_type !== null && rule.feed_type !== '') parts.push(`feed type ${rule.feed_type}`);
  if (rule.sampling_point !== null && rule.sampling_point !== '') {
    parts.push(`sampling point ${rule.sampling_point}`);
  }
  if (rule.test_method !== null && rule.test_method !== '') {
    parts.push(`method ${rule.test_method}`);
  }
  /*
    The fifth dimension (0044), and the one this function omitted until
    2026-11-03 — the whole reason it moved out of the page and acquired a
    test. See the note above.
  */
  if (rule.grind_purpose !== null && rule.grind_purpose !== '') {
    parts.push(`grind for ${grindPurposeLabel(rule.grind_purpose)}`);
  }
  return parts.length === 0
    ? 'Any material, feed type, sampling point, method and grind'
    : parts.join(', ');
}
