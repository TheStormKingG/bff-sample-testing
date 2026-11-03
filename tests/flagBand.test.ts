/**
 * Severity on the Flagged screen is derived, and a sample sits in one band.
 *
 * ===========================================================================
 * WHY THIS IS WORTH A TEST OF ITS OWN
 * ===========================================================================
 * This is the first thing in the application that RANKS quality problems.
 * Everything else states a fact — this result is outside its limit, this
 * material is on hold — and leaves the judgement to a person. A band is a
 * judgement, encoded, and shown to an operator deciding what to look at.
 *
 * Three properties make it defensible, and all three are checked here:
 *
 *   1. It is a pure function of state. There is no severity column, no
 *      dropdown and no way to mark something less serious than it is. Change
 *      the hold or the result and the band follows.
 *
 *   2. A sample is in exactly ONE band, the highest true of it. The three
 *      counts on the chips therefore add to the total, and a sample that is
 *      both on hold and out of limit is not counted twice.
 *
 *   3. A hold outranks an out-of-limit result. That mirrors the release
 *      rules, where "a hold outranks every permissive signal" — if the two
 *      disagreed, the screen would be ordering work by one rule while the
 *      system released material by another.
 */

import { describe, expect, it } from 'vitest';

import { flagBandOf } from '@/hooks/useSamples';
import type { SampleRow } from '@/hooks/useSamples';

function row(over: Partial<SampleRow> = {}): SampleRow {
  return {
    hold_active: false,
    outside_limit: false,
    capture_state: 'awaiting_results',
    ...over,
  } as SampleRow;
}

describe('flagBandOf', () => {
  it('calls material on hold critical', () => {
    expect(flagBandOf(row({ hold_active: true }))).toBe('critical');
  });

  it('calls an out-of-limit result high', () => {
    expect(flagBandOf(row({ outside_limit: true }))).toBe('high');
  });

  it('calls work that is merely outstanding other', () => {
    expect(flagBandOf(row())).toBe('other');
  });

  it('puts a sample that is BOTH on hold and out of limit in critical only', () => {
    /*
      The double-count this prevents. These two overlap in the data — a hold
      is often raised BECAUSE a result went outside its limit — so three
      independent predicates would count such a sample twice and the chips
      would add up to more than the list.
    */
    expect(flagBandOf(row({ hold_active: true, outside_limit: true }))).toBe('critical');
  });

  it('bands every combination into exactly one of the three', () => {
    const bands = new Set<string>();
    for (const hold of [true, false]) {
      for (const outside of [true, false]) {
        bands.add(flagBandOf(row({ hold_active: hold, outside_limit: outside })));
      }
    }
    // Every combination resolved, and to one of the three known names.
    expect([...bands].sort()).toEqual(['critical', 'high', 'other']);
  });

  it('ignores capture state once something is actually wrong', () => {
    /*
      A sample whose capture state says the work is finished can still be
      on hold, or still carry a reading outside its limit. The band follows
      what is wrong, not how far through the workflow the record is —
      banding on capture_state first would have filed both of these under
      "nothing outstanding".
    */
    expect(flagBandOf(row({ capture_state: 'reviewed', hold_active: true }))).toBe('critical');
    expect(flagBandOf(row({ capture_state: 'reviewed', outside_limit: true }))).toBe('high');
  });
});
