/**
 * The distribution chart reports where the mass fell, and passes no judgement.
 *
 * The chart is the easiest place in this application to imply an assessment
 * nobody made: a shaded band, a target line, a red segment or a title with the
 * word "good" would all read as a verdict, and none of the 34 entries on the
 * workbook `Limits` tab is approved. So the same constraint the calculated
 * results table carries is enforced here, against the same vocabulary.
 */

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ParticleSizeChart } from '@/components/form/ParticleSizeChart';
import { computeDgm, DEFAULT_SIEVE_PRESET } from '@/lib/dgm';

/** The workbook's worked example: 202 g of "BF". */
const WORKED: ReadonlyArray<readonly [number, number]> = [
  [370, 370], [398, 444], [388, 472], [368, 430], [362, 372], [330, 330], [330, 330],
];

function values(masses: ReadonlyArray<readonly [number, number]>): Record<string, string> {
  const v: Record<string, string> = { sieve_series: 'abnt-standard-7' };
  masses.forEach(([tare, gross], i) => {
    v[`sieve${i + 1}_tare_g`] = String(tare);
    v[`sieve${i + 1}_gross_g`] = String(gross);
  });
  return v;
}

describe('the particle size distribution', () => {
  it('names the sieve that held most of the sample, in the title', () => {
    render(<ParticleSizeChart values={values(WORKED)} />);
    // Knaflic's takeaway title: the sentence a reader would write down, not
    // the words "Distribution Chart".
    expect(
      screen.getByRole('heading', { name: /Most of this sample stayed on the 1200 µm sieve/ }),
    ).toBeInTheDocument();
  });

  it('annotates the modal share with the figure the computation produced', () => {
    const { container } = render(<ParticleSizeChart values={values(WORKED)} />);
    // Derived, not typed: the label must be whatever computeDgm says, so a
    // change to the arithmetic cannot leave a stale number on the picture.
    const expected = computeDgm(
      WORKED.map(([tareGrams, grossGrams]) => ({ tareGrams, grossGrams })),
      DEFAULT_SIEVE_PRESET,
    );
    const peak = Math.max(
      ...expected.perSieve.map((s) => s.retainedPercent ?? 0),
    );
    expect(container.textContent).toContain(`${peak.toFixed(1)}%`);
  });

  it('describes every bin for a reader who cannot see it', () => {
    render(<ParticleSizeChart values={values(WORKED)} />);
    const description = screen.getByRole('img').getAttribute('aria-labelledby');
    expect(description).toContain('psd-desc');
    const desc = document.getElementById('psd-desc')?.textContent ?? '';
    // Seven bins, each with its own number. A chart whose only accessible
    // form is "chart" hands a screen-reader user nothing.
    for (const aperture of [4000, 2000, 1200, 600, 300, 38]) {
      expect(desc, `${aperture} µm missing from the description`).toContain(String(aperture));
    }
    expect(desc).toMatch(/per cent/);
  });

  it('passes no judgement', () => {
    const { container } = render(<ParticleSizeChart values={values(WORKED)} />);
    const JUDGEMENT_HUES =
      /\b(?:fill|stroke|bg|text|border)-(red|green|amber|yellow|orange|emerald|rose|lime)-\d{2,3}\b/;
    const coloured = [...container.querySelectorAll('*')]
      .map((el) => el.getAttribute('class') ?? '')
      .filter((cls) => JUDGEMENT_HUES.test(cls));
    expect(coloured, 'a judgement-bearing colour reached the chart').toEqual([]);

    const spoken = [...container.querySelectorAll('*')]
      .flatMap((el) => [el.getAttribute('aria-label'), el.getAttribute('title')])
      .filter((v): v is string => v !== null);
    const text = [container.textContent ?? '', ...spoken].join(' ').toLowerCase();
    for (const word of [
      'pass', 'fail', 'within limit', 'outside limit', 'within spec', 'out of spec',
      'conform', 'acceptable', 'rejected', 'approved', 'target', 'too coarse', 'too fine',
    ]) {
      expect(text, `the chart used the word "${word}"`).not.toContain(word);
    }
  });

  it('draws nothing from an incomplete weighing', () => {
    // A chart of six sieves is a chart of a different sample. Returning null
    // is the honest answer; drawing the five that are present is not.
    const partial = values(WORKED);
    delete partial['sieve4_gross_g'];
    const { container } = render(<ParticleSizeChart values={partial} />);
    expect(container.firstChild).toBeNull();
  });

  it('draws nothing when nothing was retained', () => {
    // Every share is 0/0. A flat line along zero would look like a measured
    // distribution rather than an absent one.
    const nothing = values(WORKED.map(([t]) => [t, t] as const));
    const { container } = render(<ParticleSizeChart values={nothing} />);
    expect(container.firstChild).toBeNull();
  });

  it('POSITIVE CONTROL: it does draw for a complete weighing', () => {
    const { container } = render(<ParticleSizeChart values={values(WORKED)} />);
    expect(container.firstChild).not.toBeNull();
    expect(container.querySelector('svg')).not.toBeNull();
  });
});
