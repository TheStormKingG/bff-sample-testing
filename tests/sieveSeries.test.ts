/**
 * The lab's sieve table: what it may say, and what it may not.
 *
 * The rules here are not data-entry politeness. Each one protects a figure
 * that would otherwise be computed from a table that cannot describe a real
 * stack, and returned without complaint.
 */

import { describe, expect, it } from 'vitest';

import {
  applySieveSeries,
  defaultSieveSeriesDocument,
  parseSieveSeries,
  renamedPositions,
  SIEVE_POSITION_COUNT,
} from '@/lib/sieveSeries';
import { DEFAULT_SIEVE_PRESET, computeDgm, type SieveReading } from '@/lib/dgm';

function doc(overrides: Partial<Record<number, Record<string, unknown>>> = {}): unknown {
  const base = defaultSieveSeriesDocument();
  return {
    version: 1,
    positions: base.positions.map((p, i) => ({ ...p, ...(overrides[i] ?? {}) })),
  };
}

describe('reading a stored sieve table', () => {
  it('accepts the table the application ships with', () => {
    const parsed = parseSieveSeries(JSON.stringify(defaultSieveSeriesDocument()));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.document.positions).toHaveLength(SIEVE_POSITION_COUNT);
    expect(parsed.document.positions[0]?.tareDefaultGrams).toBe(370);
  });

  it('refuses a stack that does not run coarsest to finest', () => {
    // THE RULE THAT PROTECTS THE ARITHMETIC. `computeDgm` takes each bin's
    // geometric mean between its own aperture and the one above it, so a
    // series that does not fall produces a bin whose mean diameter lies
    // outside the bin — and every figure built on it would be meaningless
    // and look entirely normal.
    const parsed = parseSieveSeries(doc({ 1: { apertureMicrons: 9000 } }));
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toContain('coarsest at the top');
  });

  it('refuses two sieves with the same aperture', () => {
    const parsed = parseSieveSeries(doc({ 1: { apertureMicrons: 4000 } }));
    expect(parsed.ok).toBe(false);
  });

  it.each([
    ['a missing designation', { 0: { abnt: '  ' } }],
    ['a negative empty weight', { 0: { tareDefaultGrams: -1 } }],
    ['an empty weight past the typo guard', { 0: { tareDefaultGrams: 2001 } }],
    ['an aperture of zero', { 5: { apertureMicrons: 0 } }],
    ['an aperture that is not a number', { 5: { apertureMicrons: 'fine' } }],
  ])('refuses %s', (_label, override) => {
    expect(parseSieveSeries(doc(override as never)).ok).toBe(false);
  });

  it('refuses a table that is not as wide as the method', () => {
    // The count is fixed by the method: kj runs 6..0 by position and the
    // uniformity bands are three SUM ranges over seven sieves.
    const short = defaultSieveSeriesDocument();
    const parsed = parseSieveSeries({ version: 1, positions: short.positions.slice(0, 6) });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toContain(`exactly ${SIEVE_POSITION_COUNT}`);
  });

  it.each([
    ['unreadable JSON', '{nope'],
    ['an empty value', '   '],
    ['an unsupported version', JSON.stringify({ version: 2, positions: [] })],
  ])('refuses %s rather than guessing', (_label, raw) => {
    expect(parseSieveSeries(raw).ok).toBe(false);
  });
});

describe('applying the table to the method', () => {
  it('overrides the table and nothing structural', () => {
    const parsed = parseSieveSeries(doc({ 0: { abnt: '6', apertureMicrons: 4200, tareDefaultGrams: 375 } }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const applied = applySieveSeries(DEFAULT_SIEVE_PRESET, parsed.document);
    const first = applied.positions[0]!;
    expect(first.abnt).toBe('6');
    expect(first.apertureMicrons).toBe(4200);
    expect(first.tareDefaultGrams).toBe(375);

    // kj, the uniformity band and which position is the pan belong to the
    // METHOD. An override changes the table, never the method.
    DEFAULT_SIEVE_PRESET.positions.forEach((original, i) => {
      expect(applied.positions[i]?.kj).toBe(original.kj);
      expect(applied.positions[i]?.uiGroup).toBe(original.uiGroup);
      expect(applied.positions[i]?.isPan).toBe(original.isPan);
    });
  });

  it('leaves the preset alone when there is no stored table', () => {
    expect(applySieveSeries(DEFAULT_SIEVE_PRESET, null)).toBe(DEFAULT_SIEVE_PRESET);
  });

  it('moves the GSD and NOTHING else, which is what the screen must say', () => {
    /*
      THE WARNING ON THE ADMIN SCREEN IS BUILT ON THIS, so it is asserted
      rather than believed — and the first version of that warning was WRONG
      until this test was written. It said changing an aperture moves DGM.
      It does not:

          finenessModule = kjProductTotal / 100        -- kj is POSITIONAL
          dgmMicrons     = 104.14 * 2 ** finenessModule

      DGM is a function of the fineness module, which is a function of the
      position in the stack; so are the three uniformity bands. What the
      apertures DO feed is the per-bin geometric means, and through them the
      geometric standard deviation AND the DPG legacy index — which was the
      second thing this test corrected, the first guess having put DPG on the
      positional side with MF.

      An administrator told "this will move DGM" would go looking for a
      change that never comes; one told "this changes nothing" would miss the
      two figures it does change.
    */
    const masses: ReadonlyArray<readonly [number, number]> = [
      [370, 370], [398, 444], [388, 472], [368, 430], [362, 372], [330, 330], [330, 330],
    ];
    const readings: SieveReading[] = masses.map(([t, g]) => ({ tareGrams: t, grossGrams: g }));

    const before = computeDgm(readings, DEFAULT_SIEVE_PRESET);
    const parsed = parseSieveSeries(doc({ 2: { apertureMicrons: 1400 } }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const after = computeDgm(readings, applySieveSeries(DEFAULT_SIEVE_PRESET, parsed.document));

    expect(after.geometricStandardDeviation).not.toBe(before.geometricStandardDeviation);

    expect(after.dpgLegacyIndex).not.toBe(before.dpgLegacyIndex);

    expect(after.dgmMicrons).toBe(before.dgmMicrons);
    expect(after.finenessModule).toBe(before.finenessModule);
    expect(after.uniformityPercent).toEqual(before.uniformityPercent);
  });

  it('moves nothing at all when only an empty weight changes on paper', () => {
    // The tare in the TABLE is a form default. The figures are computed from
    // the masses the operator submitted, so editing the table never restates
    // a sample that has already been recorded.
    const readings: SieveReading[] = [
      [370, 370], [398, 444], [388, 472], [368, 430], [362, 372], [330, 330], [330, 330],
    ].map(([t, g]) => ({ tareGrams: t!, grossGrams: g! }));

    const parsed = parseSieveSeries(doc({ 0: { tareDefaultGrams: 999 } }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    expect(computeDgm(readings, applySieveSeries(DEFAULT_SIEVE_PRESET, parsed.document))).toEqual(
      computeDgm(readings, DEFAULT_SIEVE_PRESET),
    );
  });
});

describe('what the administrator is warned about', () => {
  it('names every position whose designation changed', () => {
    const before = defaultSieveSeriesDocument();
    const after = parseSieveSeries(doc({ 0: { abnt: '6' }, 4: { abnt: '55' } }));
    expect(after.ok).toBe(true);
    if (!after.ok) return;

    expect(renamedPositions(before, after.document)).toEqual([
      { position: 1, from: '5', to: '6' },
      { position: 5, from: '50', to: '55' },
    ]);
  });

  it('says nothing when only the weights moved', () => {
    // The ordinary edit: a sieve was replaced and weighs 4 g more. It carries
    // no consequence for the workbook headings, so it must not be dressed up
    // as though it does.
    const before = defaultSieveSeriesDocument();
    const after = parseSieveSeries(doc({ 0: { tareDefaultGrams: 374 } }));
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(renamedPositions(before, after.document)).toEqual([]);
  });
});
