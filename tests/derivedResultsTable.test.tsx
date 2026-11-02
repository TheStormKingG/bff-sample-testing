/**
 * The calculated-results table says what was calculated, and nothing else.
 *
 * Three claims, each of which would be a quality-system defect if it failed:
 *
 *  1. It never implies a limit. None of the 34 entries on the workbook
 *     `Limits` tab is approved, so there is nothing for a DGM figure to be
 *     within or outside, and a tick, a colour or the word "pass" here would be
 *     an acceptance Bounty Farm never gave (FR-009, UAT-05).
 *
 *  2. A value that could not be calculated reads "Not calculated" — not "Not
 *     measured", which would blame an operator who measured everything asked
 *     of them, and not "0", which would assert a result. Every gross mass
 *     equal to its tare makes every share a 0/0; that is undefined, and it is
 *     the state the source spreadsheet silently renders as `#DIV/0!`.
 *
 *  3. Its rows come from the registry, so a column added to the tab appears
 *     without an edit here and a column removed cannot leave a stale row.
 */

import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { DerivedResultsTable } from '@/components/form/DerivedResultsTable';
import { STAGE_SCHEMAS } from '@/forms/registry';
import { STAGES } from '@/forms/types';
import { deriveSystemValues } from '@/forms/derived';

/**
 * The props are the SERVER'S OUTPUT, not a plausible imitation of it.
 *
 * These fixtures used to be typed by hand, and both were wrong in ways no
 * assertion could see. One carried a GSD of `1.672224`, a number the code has
 * never produced — close enough to the real `1.672121` to read as genuine,
 * and quoted out of this file as if it were a computed result. The other
 * described an all-zero sample as having exactly one stored value, so the
 * suite certified a screen the system cannot render while the screen it does
 * render went untested.
 *
 * So the fixture is now derived. `deriveSystemValues` is the same function
 * the Edge Function calls, and `asStored` then applies the rule that
 * `tg_record_derived_results` (0025) applies to its output: a blank cell
 * DELETES the row rather than storing a zero, so a blank key is simply
 * absent by the time a screen reads it.
 */
function asStored(masses: ReadonlyArray<readonly [number, number]>): Record<string, string> {
  const values: Record<string, unknown> = { sieve_series: 'abnt-standard-7' };
  masses.forEach(([tare, gross], i) => {
    values[`sieve${i + 1}_tare_g`] = String(tare);
    values[`sieve${i + 1}_gross_g`] = String(gross);
  });
  const derived = deriveSystemValues('dgm', values);
  return Object.fromEntries(Object.entries(derived).filter(([, cell]) => cell.trim() !== ''));
}

/** The workbook's worked example: 202 g of "BF". */
const WORKED: ReadonlyArray<readonly [number, number]> = [
  [370, 370], [398, 444], [388, 472], [368, 430], [362, 372], [330, 330], [330, 330],
];

const COMPUTED = asStored(WORKED);

describe('a complete set of calculated results', () => {
  it('shows every computed column the registry declares', () => {
    render(<DerivedResultsTable stage="dgm" derived={COMPUTED} />);
    // Driven off the registry, not off a list in the test: this fails if the
    // component stops rendering a column that the tab carries.
    //
    // `dgm_um` is excluded from the ROW sweep and asserted separately below,
    // because it is no longer a row. It was lifted into its own block at the
    // top of the card — it is the figure the miller changes the mill for and
    // the only one with a range to be read against. Excluding it here without
    // the assertion that follows would let it vanish silently.
    const expected = STAGE_SCHEMAS.dgm.fields.filter(
      (f) =>
        f.type === 'system' &&
        f.key !== 'sample_id' &&
        f.key !== 'gsd_basis' &&
        f.key !== 'dgm_um',
    );
    expect(expected.length).toBe(7);
    for (const field of expected) {
      expect(screen.getByText(field.label), `missing row for ${field.key}`).toBeInTheDocument();
    }
  });

  it('lifts DGM out of the list into its own block at the top', () => {
    const { container } = render(<DerivedResultsTable stage="dgm" derived={COMPUTED} />);
    const block = screen.getByRole('heading', { name: /Average particle size \(DGM\)/ });
    expect(within(block.parentElement as HTMLElement).getByText('1472.6131 µm'))
      .toBeInTheDocument();

    // ...and it is FIRST. A block that rendered after the list would not be
    // the change that was asked for, and no assertion above would notice.
    const heading = screen.getByRole('heading', { name: /Calculated results/ });
    const sections = [...container.querySelectorAll('h4, dl')];
    expect(sections[0]?.tagName.toLowerCase()).toBe('h4');
    expect(heading.compareDocumentPosition(block) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBeTruthy();
  });

  it('shows the values exactly as stored, without reformatting them', () => {
    render(<DerivedResultsTable stage="dgm" derived={COMPUTED} />);
    // The stored string IS the record — it is the same text that went into the
    // spreadsheet cell. Re-rounding it here would put a third number into
    // circulation. That holds for DGM in its new block too: it gains a unit
    // and not a single digit of rounding.
    expect(screen.getByText('1472.6131 µm')).toBeInTheDocument();
    expect(screen.getByText('3.821782')).toBeInTheDocument();
    expect(screen.getByText('0.0000')).toBeInTheDocument();
  });

  it('shows the GSD basis as a footnote, not as a result row', () => {
    render(<DerivedResultsTable stage="dgm" derived={COMPUTED} />);
    const list = screen.getByRole('heading', { name: /Calculated results/ }).parentElement;
    expect(list).not.toBeNull();
    // Present on the screen...
    expect(screen.getByText(/series-ratio-top-bound\/pan-excluded/)).toBeInTheDocument();
    // ...but not as a labelled result beside the numbers.
    expect(screen.queryByText('GSD basis')).toBeNull();
  });

  it('says plainly that nobody typed these', () => {
    render(<DerivedResultsTable stage="dgm" derived={COMPUTED} />);
    expect(screen.getByText(/Nobody types these/i)).toBeInTheDocument();
  });

  it('passes no judgement on any value when no target has been set', () => {
    const { container } = render(<DerivedResultsTable stage="dgm" derived={COMPUTED} />);

    // THE ASSERTION THAT MATTERS MOST IN THIS FILE — and it was written from
    // an imagined violation rather than from this codebase's own vocabulary.
    // It forbade three CSS classes while the project renders adverse state in
    // amber far more often than in anything it listed, so the nearest-to-hand
    // way to put a verdict on this table was precisely the way the gate could
    // not see. A `bg-amber-50 text-amber-900` wrapper survived it untouched.
    //
    // So the colour rule is now a FAMILY denylist, not a class list: no
    // judgement-bearing hue may appear anywhere in this subtree, however the
    // utility is spelled and whatever shade is chosen.
    const JUDGEMENT_HUES = /\b(?:bg|text|border|ring|from|to|via)-(red|green|amber|yellow|orange|emerald|rose|lime)-\d{2,3}\b/;
    const coloured = [...container.querySelectorAll('*')]
      .map((el) => el.getAttribute('class') ?? '')
      .filter((cls) => JUDGEMENT_HUES.test(cls));
    expect(coloured, 'a judgement-bearing colour reached the calculated results').toEqual([]);

    // And the words. `textContent` cannot see an accessible name, so the
    // sweep reads the attributes too — a verdict in an aria-label is a
    // verdict, and it is the one a sighted reviewer never finds.
    const spoken = [...container.querySelectorAll('*')]
      .flatMap((el) => [el.getAttribute('aria-label'), el.getAttribute('title')])
      .filter((v): v is string => v !== null);
    const text = [container.textContent ?? '', ...spoken].join(' ').toLowerCase();
    for (const word of [
      'pass',
      'fail',
      'within limit',
      'outside limit',
      'within spec',
      'outside spec',
      'out of spec',
      'conform',
      'compliant',
      'acceptable',
      'rejected',
      'approved',
      'satisfactory',
    ]) {
      expect(text, `the table used the word "${word}"`).not.toContain(word);
    }
  });
});

describe('a sample on which nothing was retained', () => {
  /**
   * Every gross mass equals its tare, so every share is a 0/0.
   *
   * NOT every figure, though — and that is the whole point of this block.
   * Two survive, for two different reasons, and the screen has to tell them
   * apart from each other AND from the six that did not:
   *
   *   total_retained_g  "0.00"      a MEASUREMENT that really is zero
   *   dpg_legacy_index  "0.000000"  a CALCULATION that really is zero
   *
   * The legacy index is STDEV(Eᵢ × Bᵢ / 10000) over retained GRAMS, not over
   * ratios, so it never divides by the total. The standard deviation of seven
   * zeros is exactly zero — defined, not undefined — which is why
   * `dpgLegacyIndex` is typed `number` while every quotient beside it is
   * `number | null`. Rendering it as "Not calculated" would be as wrong as
   * rendering the six quotients as "0".
   */
  const UNDEFINED_RESULTS = asStored(WORKED.map(([tare]) => [tare, tare] as const));

  it('is the state the server actually produces, not an imagined one', () => {
    // Pins the shape the rest of this block reasons about. If the derivation
    // ever starts blanking the legacy index, or stops blanking a quotient,
    // this fails here rather than silently changing what the tests below mean.
    expect(Object.keys(UNDEFINED_RESULTS).sort()).toEqual([
      'dpg_legacy_index',
      'total_retained_g',
    ]);
  });

  it('reads "Not calculated", never "Not measured" and never zero', () => {
    render(<DerivedResultsTable stage="dgm" derived={UNDEFINED_RESULTS} />);
    // Six of the eight value rows have no answer; the other two do.
    expect(screen.getAllByText('Not calculated')).toHaveLength(6);
    expect(screen.queryByText('Not measured')).toBeNull();
  });

  it('shows the legacy index as the zero it is, not as an absence', () => {
    render(<DerivedResultsTable stage="dgm" derived={UNDEFINED_RESULTS} />);
    const label = STAGE_SCHEMAS.dgm.fields.find((f) => f.key === 'dpg_legacy_index')?.label;
    expect(label).toBeDefined();
    const row = screen.getByText(label as string).closest('div');
    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).getByText('0.000000')).toBeInTheDocument();
    expect(within(row as HTMLElement).queryByText('Not calculated')).toBeNull();
  });

  it('still shows the total, which really was measured and really is zero', () => {
    render(<DerivedResultsTable stage="dgm" derived={UNDEFINED_RESULTS} />);
    const row = screen.getByText('Total retained').closest('div');
    expect(row).not.toBeNull();
    // THE DISTINCTION. A zero that was measured is shown as a zero; a ratio
    // that is undefined is shown as absent. Collapsing the two is the defect.
    expect(within(row as HTMLElement).getByText('0.00')).toBeInTheDocument();
  });

  it('omits the basis footnote when there is no GSD to describe', () => {
    render(<DerivedResultsTable stage="dgm" derived={UNDEFINED_RESULTS} />);
    expect(screen.queryByText(/Geometric standard deviation basis/)).toBeNull();
  });
});

describe('stages with nothing to calculate', () => {
  it.each(STAGES)('renders nothing for %s when nothing was computed', (stage) => {
    // Returning null rather than an empty card: a heading reading "Calculated
    // results" over nine rows of "Not calculated" asserts a calculation that
    // reads as a failure, when in fact none was attempted.
    //
    // Now EVERY stage, not just the four without computed columns. `2 Ground`,
    // `6 Crumble` and `7 Mash` gained the sieve test with OPTIONAL weights, so
    // a sample registered at the mill before the lab has run the test is the
    // ordinary case on three of the eight tabs rather than an impossible one.
    const { container } = render(<DerivedResultsTable stage={stage} derived={{}} />);
    expect(container.firstChild).toBeNull();
  });

  it('still renders for a sieve tab once one figure exists', () => {
    // The boundary: one computed value is enough, on a stage whose other
    // eight are undefined. Without this the rule above could be satisfied by
    // a component that never renders for these stages at all.
    const { container } = render(
      <DerivedResultsTable stage="ground" derived={{ total_retained_g: '0.00' }} />,
    );
    expect(container.firstChild).not.toBeNull();
    expect(screen.getByText('Total retained')).toBeInTheDocument();
    expect(screen.getAllByText('Not calculated')).toHaveLength(7);
  });

  it('POSITIVE CONTROL: it does render something for dgm', () => {
    const { container } = render(<DerivedResultsTable stage="dgm" derived={COMPUTED} />);
    expect(container.firstChild).not.toBeNull();
  });
});
