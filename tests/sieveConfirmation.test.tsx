/**
 * After a sieve test is submitted, the operator sees the figures and the curve
 * — on every tab that takes one, not only on the tab they were built for.
 *
 * ===========================================================================
 * WHY THIS NEEDED ITS OWN FILE
 * ===========================================================================
 * `DerivedResultsTable` and `ParticleSizeChart` are stage-agnostic by
 * construction, and that is precisely why nothing was asserting they appear
 * on `2 Ground`, `6 Crumble` and `7 Mash`. Both are rendered behind a guard
 * on the confirmation screen:
 *
 *   derived !== undefined && Object.keys(derived).length > 0   -> the table
 *   submittedValues !== undefined                              -> the chart
 *
 * and the chart then returns null of its own accord unless EVERY mass is
 * present and the preset resolves. Four conditions, none of them named after
 * a stage, all of them silently satisfiable or not. A stage that reached this
 * screen with no table and no chart would look like a successful save with
 * nothing to show for it, which is the one outcome the sieve test exists to
 * avoid — the calculated figures ARE the result the operator came for.
 *
 * The numbers are the worked example `tests/dgmMaths.test.ts` pins against
 * the source workbook, so a chart drawn from different arithmetic fails here
 * as well as there.
 */

import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';

import { RegistrationConfirmation } from '@/components/form/RegistrationConfirmation';
import { deriveSystemValues } from '@/forms/derived';
import { DEFAULT_SIEVE_PRESET } from '@/lib/dgm';
import type { Stage } from '@/forms/types';

/** The worked example from `Cópia de DGM (2).xls`: 202 g of "BF". */
const MASSES: ReadonlyArray<readonly [number, number]> = [
  [370, 370],
  [398, 444],
  [388, 472],
  [368, 430],
  [362, 372],
  [330, 330],
  [330, 330],
];

function weighed(): Record<string, string> {
  const values: Record<string, string> = { sieve_series: DEFAULT_SIEVE_PRESET.id };
  MASSES.forEach(([tare, gross], i) => {
    values[`sieve${i + 1}_tare_g`] = String(tare);
    values[`sieve${i + 1}_gross_g`] = String(gross);
  });
  return values;
}

const SIEVE_STAGES: readonly Stage[] = ['ground', 'crumble', 'mash', 'dgm'];

function show(stage: Stage, values: Record<string, string>) {
  // `derived` is taken from the REAL derivation rather than hand-written, so
  // this cannot pass against figures the server would never produce.
  const derived = deriveSystemValues(stage, values);
  return render(
    <RegistrationConfirmation
      stage={stage}
      sampleId="AM-261102-01"
      registeredAt="2026-11-02T13:30:00Z"
      captureState="registered"
      derived={derived}
      submittedValues={values}
    />,
  );
}

describe.each(SIEVE_STAGES)('%s: a weighed sample shows its results', (stage) => {
  it('shows the calculated figures', () => {
    show(stage, weighed());
    const heading = screen.getByText('Calculated results');
    const card = heading.closest('section');
    expect(card).not.toBeNull();
    // The two the operator came for, at the values the workbook gives.
    expect(within(card as HTMLElement).getByText('1472.6131')).toBeInTheDocument();
    expect(within(card as HTMLElement).getByText('3.821782')).toBeInTheDocument();
  });

  it('draws the distribution, and says what it shows in words', () => {
    show(stage, weighed());
    // The chart's title states the finding rather than the chart type, so it
    // is also the assertion that the curve was drawn from THIS sample.
    expect(screen.getByText(/Most of this sample stayed on the 1200 µm sieve/)).toBeInTheDocument();
    const figure = screen.getByRole('img');
    expect(figure.tagName.toLowerCase()).toBe('svg');
    // Seven points, one per sieve position, the peak drawn larger.
    expect(figure.querySelectorAll('circle')).toHaveLength(DEFAULT_SIEVE_PRESET.positions.length);
  });
});

describe('a sample registered before the lab ran the test', () => {
  it.each(['ground', 'crumble', 'mash'] as const)(
    'shows neither a results card nor a chart for %s',
    (stage) => {
      // The ordinary case on these three tabs: the weights are optional, so a
      // sample taken at the mill carries none. A "Calculated results" heading
      // over nine rows of "Not calculated", or an empty axis, would both read
      // as a failed computation rather than a test nobody has run yet.
      show(stage, { feed_type: 'Broiler starter' });
      expect(screen.queryByText('Calculated results')).toBeNull();
      expect(screen.queryByRole('img')).toBeNull();
    },
  );
});

describe('a half-finished weighing draws nothing', () => {
  it('refuses to plot a curve from three sieves of seven', () => {
    // `ParticleSizeChart` returns null unless every mass is present: a curve
    // drawn through the sieves that happen to be filled is a different
    // sample's distribution, and it would look entirely plausible.
    const partial = weighed();
    for (let n = 4; n <= 7; n++) {
      delete partial[`sieve${n}_tare_g`];
      delete partial[`sieve${n}_gross_g`];
    }
    show('ground', partial);
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.queryByText('Calculated results')).toBeNull();
  });
});
