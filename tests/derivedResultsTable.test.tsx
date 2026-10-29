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

const COMPUTED = {
  total_retained_g: '202.00',
  fineness_module: '3.821782',
  dgm_um: '1472.6131',
  ui_coarse_pct: '22.7723',
  ui_average_pct: '77.2277',
  ui_fine_pct: '0.0000',
  dpg_legacy_index: '4.520676',
  gsd: '1.672224',
  gsd_basis: 'series-ratio-top-bound/pan-excluded',
};

describe('a complete set of calculated results', () => {
  it('shows every computed column the registry declares', () => {
    render(<DerivedResultsTable stage="dgm" derived={COMPUTED} />);
    // Driven off the registry, not off a list in the test: this fails if the
    // component stops rendering a column that the tab carries.
    const expected = STAGE_SCHEMAS.dgm.fields.filter(
      (f) => f.type === 'system' && f.key !== 'sample_id' && f.key !== 'gsd_basis',
    );
    expect(expected.length).toBe(8);
    for (const field of expected) {
      expect(screen.getByText(field.label), `missing row for ${field.key}`).toBeInTheDocument();
    }
  });

  it('shows the values exactly as stored, without reformatting them', () => {
    render(<DerivedResultsTable stage="dgm" derived={COMPUTED} />);
    // The stored string IS the record — it is the same text that went into the
    // spreadsheet cell. Re-rounding it here would put a third number into
    // circulation.
    expect(screen.getByText('1472.6131')).toBeInTheDocument();
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

  it('passes no judgement on any value', () => {
    const { container } = render(<DerivedResultsTable stage="dgm" derived={COMPUTED} />);
    const text = container.textContent ?? '';
    // THE ASSERTION THAT MATTERS MOST IN THIS FILE.
    for (const word of [
      'pass',
      'fail',
      'within limit',
      'outside limit',
      'conform',
      'acceptable',
      'out of spec',
    ]) {
      expect(text.toLowerCase(), `the table used the word "${word}"`).not.toContain(word);
    }
    // And no status colour, which would say it without words.
    expect(container.querySelectorAll('.bg-green-50, .bg-red-50, .text-green-900')).toHaveLength(
      0,
    );
  });
});

describe('a sample on which nothing was retained', () => {
  // Every ratio is 0/0. The server writes a blank cell; the trigger in 0025
  // then stores no row at all, so the key is simply absent here.
  const UNDEFINED_RESULTS = {
    total_retained_g: '0.00',
    gsd_basis: '',
  };

  it('reads "Not calculated", never "Not measured" and never zero', () => {
    render(<DerivedResultsTable stage="dgm" derived={UNDEFINED_RESULTS} />);
    // Seven of the eight value rows have no answer.
    expect(screen.getAllByText('Not calculated')).toHaveLength(7);
    expect(screen.queryByText('Not measured')).toBeNull();
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
  it.each(STAGES.filter((s) => s !== 'dgm'))('renders nothing for %s', (stage) => {
    // Returning null rather than an empty card: a heading reading "Calculated
    // results" over no rows would suggest a calculation that failed.
    const { container } = render(<DerivedResultsTable stage={stage} derived={{}} />);
    expect(container.firstChild).toBeNull();
  });

  it('POSITIVE CONTROL: it does render something for dgm', () => {
    const { container } = render(<DerivedResultsTable stage="dgm" derived={COMPUTED} />);
    expect(container.firstChild).not.toBeNull();
  });
});
