/**
 * The DGM target: the first limit this system has ever drawn.
 *
 * Everything else here reports and declines to judge, because none of the 34
 * limits in the workbook is approved. A target has now been set deliberately,
 * and these tests hold the line between a TARGET and a DISPOSITION:
 *
 *  1. The stored document is whole or nothing, and a target that does not say
 *     where it came from is refused — because the screen prints the source
 *     beside the figures and a target with no origin reads as an approved
 *     specification.
 *
 *  2. The three-line stack is a number line. Sorting by value descending
 *     produces the within / coarser / finer layouts with no branch, and a
 *     sample sitting exactly on a limit stays inside the range.
 *
 *  3. The band on the chart is placed on the LOG of the apertures, because
 *     the axis is a sieve stack and not a ruler.
 *
 *  4. No judgement colour, and no verdict word, reaches a results screen even
 *     when a target IS set. Green marks the region aimed at; the sample's own
 *     figure stays the informational blue it has always been.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen, within } from '@testing-library/react';

import { DerivedResultsTable } from '@/components/form/DerivedResultsTable';
import { ParticleSizeChart } from '@/components/form/ParticleSizeChart';
import { RegistrationConfirmation } from '@/components/form/RegistrationConfirmation';
import { deriveSystemValues } from '@/forms/derived';
import { STAGE_SCHEMAS } from '@/forms/registry';
import { DEFAULT_SIEVE_PRESET } from '@/lib/dgm';
import {
  apertureIndex,
  dgmStanding,
  DGM_TARGET_STAGES,
  emptyDgmTargets,
  parseDgmTargets,
  type DgmTargetRange,
} from '@/lib/dgmTargets';

const GROUND_TARGET: DgmTargetRange = {
  lowerMicrons: 900,
  upperMicrons: 1200,
  basis: 'Pre-pelleting grind (Auburn 2025; Aviagen 2025).',
};

/** The workbook's worked example: DGM 1472.6131 µm, coarser than 900–1200. */
const WORKED: ReadonlyArray<readonly [number, number]> = [
  [370, 370], [398, 444], [388, 472], [368, 430], [362, 372], [330, 330], [330, 330],
];

function weighed(): Record<string, string> {
  const values: Record<string, string> = { sieve_series: 'abnt-standard-7' };
  WORKED.forEach(([tare, gross], i) => {
    values[`sieve${i + 1}_tare_g`] = String(tare);
    values[`sieve${i + 1}_gross_g`] = String(gross);
  });
  return values;
}

function stored(stage: 'dgm' | 'ground'): Record<string, string> {
  const derived = deriveSystemValues(stage, weighed());
  return Object.fromEntries(Object.entries(derived).filter(([, cell]) => cell.trim() !== ''));
}

// ---------------------------------------------------------------------------
// The stored document
// ---------------------------------------------------------------------------

describe('reading a stored set of targets', () => {
  const good = {
    version: 1,
    ranges: { ground: { lowerMicrons: 900, upperMicrons: 1200, basis: 'Auburn 2025.' } },
  };

  it('accepts a document with a target on one form and none on the others', () => {
    const parsed = parseDgmTargets(good);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.document.ranges.ground?.upperMicrons).toBe(1200);
    // PARTIAL IS THE POINT. Two of the five sieve forms ship with no target
    // because the published guidance gives none for a finished pellet, and a
    // parser that demanded all five would have forced a figure to be invented.
    expect(parsed.document.ranges.pellets).toBeUndefined();
  });

  it('accepts the same document as a JSON string, which is how it is stored', () => {
    const parsed = parseDgmTargets(JSON.stringify(good));
    expect(parsed.ok).toBe(true);
  });

  it('accepts an empty set, which is a deployment that has set no target', () => {
    const parsed = parseDgmTargets({ version: 1, ranges: {} });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(Object.keys(parsed.document.ranges)).toEqual([]);
  });

  it.each([
    ['not JSON', '{nope'],
    ['an array', [] as unknown],
    ['the wrong version', { version: 2, ranges: {} }],
    ['no ranges object', { version: 1 }],
    ['a form that does not exist', { version: 1, ranges: { fermenter: { lowerMicrons: 1, upperMicrons: 2, basis: 'x' } } }],
    // A target on a form with no sieve stack would never be drawn. A setting
    // that silently has no effect is worse than no setting.
    ['a form with no sieve test', { version: 1, ranges: { conditioned: { lowerMicrons: 900, upperMicrons: 1200, basis: 'x' } } }],
    ['a negative figure', { version: 1, ranges: { ground: { lowerMicrons: -1, upperMicrons: 1200, basis: 'x' } } }],
    ['a figure that is not a number', { version: 1, ranges: { ground: { lowerMicrons: '900', upperMicrons: 1200, basis: 'x' } } }],
    ['an absurd figure', { version: 1, ranges: { ground: { lowerMicrons: 900, upperMicrons: 999999, basis: 'x' } } }],
    ['no stated source', { version: 1, ranges: { ground: { lowerMicrons: 900, upperMicrons: 1200, basis: '  ' } } }],
  ])('refuses %s', (_name, raw) => {
    expect(parseDgmTargets(raw).ok).toBe(false);
  });

  it('refuses an inverted pair, which would shade a band of no width', () => {
    // The dangerous one: it does not crash and it does not look wrong. Every
    // sample would read as outside a range the chart draws as a hairline.
    const parsed = parseDgmTargets({
      version: 1,
      ranges: { ground: { lowerMicrons: 1200, upperMicrons: 900, basis: 'x' } },
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toMatch(/lower figure is the finer grind/);
  });

  it('refuses a pair that is equal, for the same reason', () => {
    expect(
      parseDgmTargets({
        version: 1,
        ranges: { ground: { lowerMicrons: 1000, upperMicrons: 1000, basis: 'x' } },
      }).ok,
    ).toBe(false);
  });

  it('offers an empty document as the failure state, never a built-in range', () => {
    // A fallback range would put a figure on a quality record that no
    // administrator set, which is the one thing this feature must not do.
    expect(emptyDgmTargets().ranges).toEqual({});
  });
});

describe('which forms may carry a target', () => {
  it('is derived from the registry, not from a list', () => {
    expect([...DGM_TARGET_STAGES]).toEqual(['ground', 'pellets', 'crumble', 'mash', 'dgm']);
  });

  it('is exactly the forms that weigh a sieve stack', () => {
    for (const stage of DGM_TARGET_STAGES) {
      expect(
        STAGE_SCHEMAS[stage].fields.some((f) => f.key === 'sieve1_tare_g'),
        `${stage} has no sieve test`,
      ).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Where a figure sits
// ---------------------------------------------------------------------------

describe('standing against a target', () => {
  it.each([
    [899.9, 'below'],
    [900, 'within'],
    [1050, 'within'],
    [1200, 'within'],
    [1200.1, 'above'],
  ])('%s µm against 900–1200 is %s', (value, expected) => {
    expect(dgmStanding(value as number, GROUND_TARGET)).toBe(expected);
  });

  it('counts both edges as inside, so a figure on a limit is not reported outside it', () => {
    // A reader who sees "1200.0" reported as above a 1200 limit concludes the
    // screen is broken, and they are right to.
    expect(dgmStanding(GROUND_TARGET.lowerMicrons, GROUND_TARGET)).toBe('within');
    expect(dgmStanding(GROUND_TARGET.upperMicrons, GROUND_TARGET)).toBe('within');
  });
});

// ---------------------------------------------------------------------------
// Placing a figure on a sieve axis
// ---------------------------------------------------------------------------

describe('placing a micrometre figure on the sieve axis', () => {
  const APERTURES = DEFAULT_SIEVE_PRESET.positions.map((p) => p.apertureMicrons);

  it('puts a sieve exactly on its own position', () => {
    APERTURES.forEach((aperture, i) => {
      expect(apertureIndex(APERTURES, aperture)).toBeCloseTo(i, 6);
    });
  });

  it('interpolates on the log of the apertures, not linearly', () => {
    // 900 µm sits between the 1200 µm sieve (position 2) and the 600 µm one
    // (position 3). Linear interpolation puts it at 2.50; the stack puts it
    // at 2 + ln(1200/900)/ln(1200/600) = 2.415. Half a sieve width of error
    // in where the edge of a target band is drawn.
    const placed = apertureIndex(APERTURES, 900);
    expect(placed).toBeCloseTo(2 + Math.log(1200 / 900) / Math.log(2), 6);
    expect(placed).not.toBeCloseTo(2.5, 2);
  });

  it('clamps a figure that is off either end of the stack', () => {
    expect(apertureIndex(APERTURES, 99999)).toBe(0);
    expect(apertureIndex(APERTURES, 1)).toBe(APERTURES.length - 1);
  });

  it('returns nothing for input a drawing cannot use', () => {
    expect(apertureIndex([], 900)).toBeNull();
    expect(apertureIndex(APERTURES, 0)).toBeNull();
    expect(apertureIndex(APERTURES, Number.NaN)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The stack of three
// ---------------------------------------------------------------------------

function lines(container: HTMLElement): string[] {
  return [...container.querySelectorAll('li')].map((li) =>
    (li.textContent ?? '').replace(/\s+/g, ' ').trim(),
  );
}

describe('the DGM block', () => {
  it('reads coarse to fine: the sample above both limits when it is coarser', () => {
    // 1472.6131 against 900–1200.
    const { container } = render(
      <DerivedResultsTable stage="dgm" derived={stored('dgm')} target={GROUND_TARGET} />,
    );
    expect(lines(container)).toEqual([
      'This sample1472.6131 µm',
      'Upper limit1200 µm',
      'Lower limit900 µm',
    ]);
    expect(screen.getByText('Coarser than the target range.')).toBeInTheDocument();
  });

  it('puts the sample between the limits when it is within them', () => {
    const { container } = render(
      <DerivedResultsTable
        stage="dgm"
        derived={stored('dgm')}
        target={{ ...GROUND_TARGET, lowerMicrons: 1200, upperMicrons: 2000 }}
      />,
    );
    expect(lines(container)).toEqual([
      'Upper limit2000 µm',
      'This sample1472.6131 µm',
      'Lower limit1200 µm',
    ]);
    expect(screen.getByText('Within the target range.')).toBeInTheDocument();
  });

  it('puts the sample below both limits when it is finer', () => {
    const { container } = render(
      <DerivedResultsTable
        stage="dgm"
        derived={stored('dgm')}
        target={{ ...GROUND_TARGET, lowerMicrons: 2000, upperMicrons: 3000 }}
      />,
    );
    expect(lines(container)).toEqual([
      'Upper limit3000 µm',
      'Lower limit2000 µm',
      'This sample1472.6131 µm',
    ]);
    expect(screen.getByText('Finer than the target range.')).toBeInTheDocument();
  });

  it('keeps a sample sitting exactly on the upper limit underneath it', () => {
    // The tie case. The stack is sorted descending and the seed order is
    // [upper, sample, lower], so a stable sort leaves the limit above — which
    // has to agree with `dgmStanding`, where both edges are inside.
    const { container } = render(
      <DerivedResultsTable
        stage="dgm"
        derived={{ dgm_um: '1200.0000' }}
        target={GROUND_TARGET}
      />,
    );
    expect(lines(container)).toEqual([
      'Upper limit1200 µm',
      'This sample1200.0000 µm',
      'Lower limit900 µm',
    ]);
    expect(screen.getByText('Within the target range.')).toBeInTheDocument();
  });

  it('shows the sample alone, with no limits and no standing, when no target is set', () => {
    const { container } = render(<DerivedResultsTable stage="dgm" derived={stored('dgm')} />);
    expect(lines(container)).toEqual(['This sample1472.6131 µm']);
    expect(screen.queryByText(/target range/i)).toBeNull();
  });

  it('prints where the figures came from, beside them', () => {
    render(<DerivedResultsTable stage="dgm" derived={stored('dgm')} target={GROUND_TARGET} />);
    expect(screen.getByText(/Auburn 2025; Aviagen 2025/)).toBeInTheDocument();
    // And says, in the same breath, what it is not.
    expect(screen.getByText(/not an approved specification/)).toBeInTheDocument();
  });

  it('still shows the block, reading "Not calculated", when there is no figure', () => {
    const { container } = render(
      <DerivedResultsTable
        stage="dgm"
        derived={{ total_retained_g: '0.00' }}
        target={GROUND_TARGET}
      />,
    );
    // The target belongs to the FORM, so it is shown whether or not this
    // sample produced a figure; the sample's own line says it did not.
    expect(lines(container)).toEqual([
      'Upper limit1200 µm',
      'Lower limit900 µm',
      'This sampleNot calculated',
    ]);
  });
});

describe('a target is still not a verdict', () => {
  const JUDGEMENT_HUES =
    /\b(?:bg|text|border|ring|from|to|via)-(red|amber|yellow|orange|rose|lime)-\d{2,3}\b/;

  it('uses green for the region aimed at and never a warning colour', () => {
    const { container } = render(
      <DerivedResultsTable stage="dgm" derived={stored('dgm')} target={GROUND_TARGET} />,
    );
    const classes = [...container.querySelectorAll('*')].map(
      (el) => el.getAttribute('class') ?? '',
    );
    // The sample is COARSER than the target here — the case that would tempt
    // an implementation into amber. Nothing may turn amber, or red, ever.
    expect(classes.filter((c) => JUDGEMENT_HUES.test(c))).toEqual([]);
    expect(classes.some((c) => /bg-green-100/.test(c))).toBe(true);
  });

  it('keeps the sample blue when it falls outside, not red', () => {
    render(<DerivedResultsTable stage="dgm" derived={stored('dgm')} target={GROUND_TARGET} />);
    const line = screen.getByText('This sample').closest('li');
    expect(line?.getAttribute('class')).toMatch(/bg-blue-100/);
  });

  it('never uses a word that would assert an acceptance', () => {
    const { container } = render(
      <DerivedResultsTable stage="dgm" derived={stored('dgm')} target={GROUND_TARGET} />,
    );
    const text = (container.textContent ?? '').toLowerCase();
    for (const word of [
      'pass',
      'fail',
      'within limit',
      'outside limit',
      'within spec',
      'out of spec',
      'conform',
      'compliant',
      'acceptable',
      'rejected',
      'satisfactory',
    ]) {
      expect(text, `the block used the word "${word}"`).not.toContain(word);
    }
    // "approved" appears exactly once, and only in the sentence that DENIES
    // one. This is the assertion that stops the denial being deleted and the
    // word reappearing in a claim.
    expect(text.match(/approved/g) ?? []).toHaveLength(1);
    expect(text).toContain('not an approved specification');
  });
});

// ---------------------------------------------------------------------------
// The band on the chart
// ---------------------------------------------------------------------------

describe('the target band on the particle-size chart', () => {
  function chart(target: DgmTargetRange | null) {
    const { container } = render(<ParticleSizeChart values={weighed()} target={target} />);
    return container.querySelector('svg') as SVGSVGElement;
  }

  it('draws nothing green when no target is set', () => {
    const svg = chart(null);
    expect(svg.querySelector('rect')).toBeNull();
    expect(svg.querySelectorAll('line[stroke-dasharray]')).toHaveLength(0);
  });

  it('shades the range and marks this sample’s own average', () => {
    const svg = chart(GROUND_TARGET);
    const band = svg.querySelector('rect');
    expect(band).not.toBeNull();
    expect(band?.getAttribute('class')).toMatch(/fill-green-100/);
    expect(Number(band?.getAttribute('width'))).toBeGreaterThan(0);

    // The marker is what stops the band making a claim about the CURVE. The
    // target is on the geometric mean; the curve is a distribution.
    const marker = svg.querySelector('line[stroke-dasharray]');
    expect(marker).not.toBeNull();
    expect(svg.textContent).toContain('DGM 1473 µm');
  });

  it('puts the coarse edge of the band to the left of the fine edge', () => {
    // The axis runs coarsest-first, so the UPPER figure in µm is the LEFT
    // edge. Getting this backwards would draw a band of negative width, which
    // SVG renders as nothing at all — a silent disappearance.
    const svg = chart(GROUND_TARGET);
    const band = svg.querySelector('rect') as SVGRectElement;
    const x = Number(band.getAttribute('x'));
    const width = Number(band.getAttribute('width'));
    const marker = svg.querySelector('line[stroke-dasharray]') as SVGLineElement;
    // 1472 µm is coarser than the whole band, so its mark is to the LEFT.
    expect(Number(marker.getAttribute('x1'))).toBeLessThan(x);
    expect(width).toBeGreaterThan(10);
  });

  it('draws no band for a target that lies entirely off the stack', () => {
    // Clamping would paint a sliver against the frame, which reads as a band
    // at the edge of the chart rather than as a band off the end of it.
    const svg = chart({ lowerMicrons: 6000, upperMicrons: 9000, basis: 'x' });
    expect(svg.querySelector('rect')).toBeNull();
  });

  it('says the range and the standing in words, for a reader who cannot see it', () => {
    render(<ParticleSizeChart values={weighed()} target={GROUND_TARGET} />);
    expect(screen.getByText(/900 to 1200 µm/)).toBeInTheDocument();
    const description = document.querySelector('desc');
    expect(description?.textContent).toMatch(/Target range 900 to 1200 micrometres/);
    expect(description?.textContent).toMatch(/coarser than the target range/i);
  });
});

// ---------------------------------------------------------------------------
// The buttons under the confirmation
// ---------------------------------------------------------------------------

describe('the navigation under a registration', () => {
  it('keeps all three on one row, each an equal third', () => {
    const { container } = render(
      <RegistrationConfirmation
        stage="ground"
        sampleId="GR-261102-01"
        registeredAt="2026-11-02T13:30:00Z"
        captureState="registered"
        onEnterResults={() => {}}
        onRegisterAnother={() => {}}
        onDone={() => {}}
      />,
    );
    const row = screen.getByText('Back to forms').parentElement as HTMLElement;
    expect(within(row).getAllByRole('button')).toHaveLength(3);

    // `flex-wrap` is what put "Back to forms" alone on a second line directly
    // under the primary action, where the thumb already was.
    expect(row.className).toContain('flex-nowrap');
    expect(row.className).not.toContain('flex-wrap');

    for (const button of within(row).getAllByRole('button')) {
      // `basis-0` with `flex-1` is what makes them equal thirds rather than
      // thirds of whatever is left after the longest label; `min-w-0` is what
      // lets a flex item be narrower than its own text.
      expect(button.className).toContain('flex-1');
      expect(button.className).toContain('basis-0');
      expect(button.className).toContain('min-w-0');
    }
    expect(container).toBeTruthy();
  });

  it('still holds its shape when only two of the three are offered', () => {
    render(
      <RegistrationConfirmation
        stage="ground"
        sampleId="GR-261102-01"
        registeredAt="2026-11-02T13:30:00Z"
        captureState="registered"
        onRegisterAnother={() => {}}
        onDone={() => {}}
      />,
    );
    const row = screen.getByText('Back to forms').parentElement as HTMLElement;
    expect(within(row).getAllByRole('button')).toHaveLength(2);
    expect(row.className).toContain('flex-nowrap');
  });
});

// ---------------------------------------------------------------------------
// The reader's cache after a write
// ---------------------------------------------------------------------------

describe('saving a setting drops the cache the screens read it from', () => {
  it('names the query keys that both configuration writers have to invalidate', () => {
    // A behaviour test would need a live QueryClient and a mocked Edge call
    // to assert one line; this reads the line instead, and it is the line
    // that matters: both settings are read with an hour's staleTime, so a
    // missing invalidation leaves the administrator looking at the document
    // they just replaced — which is how it behaved when first deployed.
    const source = readFileSync(
      join(process.cwd(), 'src', 'hooks', 'useAdmin.ts'),
      'utf8',
    );
    const onSuccess = source.slice(source.indexOf('onSuccess:'));
    for (const [action, key] of [
      ['set_sieve_series', 'sieve-series'],
      ['set_dgm_target_ranges', 'dgm-target-ranges'],
    ]) {
      const branch = onSuccess.indexOf(`input.action === '${action}'`);
      expect(branch, `${action} does not invalidate anything`).toBeGreaterThan(-1);
      expect(onSuccess.slice(branch, branch + 200)).toContain(`'${key}'`);
    }

    // And the keys are the ones the hooks actually use, read from the hooks
    // rather than retyped here — a pair of matching strings in two files is
    // exactly the shape that drifts.
    expect(
      readFileSync(join(process.cwd(), 'src', 'hooks', 'useDgmTargets.ts'), 'utf8'),
    ).toContain("queryKey: ['dgm-target-ranges']");
    expect(
      readFileSync(join(process.cwd(), 'src', 'hooks', 'useSieveSeries.ts'), 'utf8'),
    ).toContain("queryKey: ['sieve-series']");
  });
});
