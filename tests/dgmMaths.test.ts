/**
 * The DGM granulometry maths, pinned to the source workbook.
 *
 * ===========================================================================
 * WHERE THE EXPECTED NUMBERS COME FROM
 * ===========================================================================
 * Every value in `WORKED_EXAMPLE` below was read out of `Cópia de DGM (2).xls`
 * (sheet `DGM_DPG`, Poli-Nutri Alimentos, saved 2019-08-19) by dumping the
 * stored cell values, and every formula was decompiled from the file's own BIFF
 * formula records rather than inferred from the numbers:
 *
 *     E = D − C                     retained = (sieve+sample) − empty sieve
 *     F = E × 100 / E17             R%, that sieve's share of total retained
 *     H = F × G                     R% × Kj
 *     G20 = H17 / 100               MF, fineness module
 *     G22 = 104.14 × 2^G20          DGM, micrometres
 *     G25 = SUM(F10:F11)/10         UI coarse, in units out of ten
 *     G26 = SUM(F12:F14)/10         UI average
 *     G27 = SUM(F15:F16)/10         UI fine
 *     G29 = STDEV(A31:A37)          DPG
 *     A31:A37 = Eᵢ × Bᵢ / 10000     mass × aperture ÷ 10 000
 *
 * So this file is a SPEC, not a characterisation of our own output: the oracle
 * is a third-party document that existed before any of this code. That
 * distinction is the whole point. A test whose expected values were produced by
 * running the implementation proves only that the implementation is
 * deterministic.
 *
 * ===========================================================================
 * THE ONE QUANTITY THAT HAS NO WORKBOOK ORACLE
 * ===========================================================================
 * `geometricStandardDeviation` is ours — the real, dimensionless GSD that the
 * workbook does not compute. There is no cell to compare it to, so asserting a
 * number this code produced would be asserting our code against our code.
 *
 * It is therefore pinned two ways instead:
 *
 *   1. A value derived BY HAND, by a separate route, with the arithmetic
 *      written out in `GSD_BY_HAND` below so a reader can check each step.
 *   2. The property that actually discriminates it from the legacy index:
 *      multiply every mass by k and a geometric standard deviation must not
 *      move, while the legacy DPG must scale by exactly k. That asymmetry is
 *      the reason §2.2 of the plan recommended showing both, so it is the
 *      thing most worth gating.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SIEVE_PRESET,
  DGM_CONSTANT,
  computeDgm,
  sievePresetById,
  SIEVE_PRESETS,
} from '../src/lib/dgm';

/**
 * Sheet `DGM_DPG`, rows 10–16 (the seven sieve positions) and the totals row 17.
 * 202 g of "BF", 7 August 2019 (serial 43684), RPM 0, Hz "Pos 8", 10 mins.
 */
const WORKED_EXAMPLE = {
  readings: [
    { tareGrams: 370, grossGrams: 370 }, // ABNT 5    4000 µm
    { tareGrams: 398, grossGrams: 444 }, // ABNT 10   2000 µm
    { tareGrams: 388, grossGrams: 472 }, // ABNT 16   1200 µm
    { tareGrams: 368, grossGrams: 430 }, // ABNT 30    600 µm
    { tareGrams: 362, grossGrams: 372 }, // ABNT 50    300 µm
    { tareGrams: 330, grossGrams: 330 }, // ABNT 400    38 µm
    { tareGrams: 330, grossGrams: 330 }, // Fundo       37 µm
  ],
  retainedGrams: [0, 46, 84, 62, 10, 0, 0], // column E
  retainedPercent: [
    0,
    22.77227722772277,
    41.584158415841586,
    30.693069306930692,
    4.9504950495049505,
    0,
    0,
  ], // column F
  kjProduct: [
    0,
    113.86138613861385,
    166.33663366336634,
    92.07920792079207,
    9.900990099009901,
    0,
    0,
  ], // column H
  dpgTerms: [0, 9.2, 10.08, 3.72, 0.3, 0, 0], // A31:A37
  totalRetainedGrams: 202, // E17
  totalRetainedPercent: 100, // F17
  kjProductTotal: 382.1782178217822, // H17
  finenessModule: 3.821782178217822, // G20
  dgmMicrons: 1472.6130536938736, // G22
  uniformityUnits: [2.277227722772277, 7.722772277227723, 0], // G25:G27
  uniformityPercent: [22.77227722772277, 77.22772277227723, 0], // H25:H27
  dpgLegacyIndex: 4.520676308442608, // G29
} as const;

/**
 * The GSD, worked by hand from the same four non-empty sieves.
 *
 * Each bin's representative diameter is the geometric mean of its own aperture
 * and the aperture of the sieve immediately ABOVE it:
 *
 *     d̄₂ = √(2000 × 4000) = 2828.42712474619   log₁₀ = 3.4515449934959727
 *     d̄₃ = √(1200 × 2000) = 1549.1933384829668 log₁₀ = 3.1897718…
 *     d̄₄ = √( 600 × 1200) =  848.5281374238570 log₁₀ = 2.9283958…
 *     d̄₅ = √( 300 ×  600) =  424.2640687119285 log₁₀ = 2.6276089…
 *
 *     Σ W           = 46 + 84 + 62 + 10 = 202
 *     Σ W·log d̄     = 46(3.4515450) + 84(3.1897718) + 62(2.9283958) + 10(2.6276089)
 *                   = 158.771070 + 267.940831 + 181.560540 + 26.276089 = 634.548530
 *     log d̄gw       = 634.548530 / 202 = 3.14132936
 *     d̄gw           = 10^3.14132936 ≈ 1385.0 µm
 *
 *     Σ W(log d̄ − log d̄gw)²
 *                   = 46(0.31021563)² + 84(0.04844244)²
 *                   + 62(−0.21293356)² + 10(−0.51372046)²
 *                   = 4.426733 + 0.197146 + 2.811137 + 2.639088 = 10.074104
 *     variance      = 10.074104 / 202 = 0.049871803
 *     sd of logs    = √0.049871803 = 0.22331996
 *     GSD           = 10^0.22331996 ≈ 1.6722
 *
 * Tolerance is loose on purpose: this is a hand computation to four or five
 * significant figures, and its job is to catch a wrong FORMULA, not to pin the
 * last bit of a double. The exactness claims in this file belong to the
 * workbook values above, which are a real oracle.
 */
const GSD_BY_HAND = 1.6722;
const GEOMETRIC_MEAN_BY_HAND = 1385.0;

/** Every mass scaled by k, preserving tare so only the retained mass moves. */
function scaleMasses(k: number) {
  return WORKED_EXAMPLE.readings.map((r) => ({
    tareGrams: r.tareGrams,
    grossGrams: r.tareGrams + (r.grossGrams - r.tareGrams) * k,
  }));
}

describe('the default sieve preset is the workbook series', () => {
  it('is seven positions with Kj 6..0 assigned by position', () => {
    // Kj comes from the stack POSITION, never from the aperture — which is why
    // §2.1 of the plan rejected editable apertures. If this ever becomes
    // aperture-derived, MF/DGM/UI stop being comparable with every historical
    // record and this assertion is the tripwire.
    expect(DEFAULT_SIEVE_PRESET.positions).toHaveLength(7);
    expect(DEFAULT_SIEVE_PRESET.positions.map((p) => p.kj)).toEqual([6, 5, 4, 3, 2, 1, 0]);
  });

  it('carries the apertures and labels the workbook uses', () => {
    expect(DEFAULT_SIEVE_PRESET.positions.map((p) => p.apertureMicrons)).toEqual([
      4000, 2000, 1200, 600, 300, 38, 37,
    ]);
    expect(DEFAULT_SIEVE_PRESET.positions.map((p) => p.abnt)).toEqual([
      '5',
      '10',
      '16',
      '30',
      '50',
      '400',
      'Fundo',
    ]);
  });

  it('groups the UI bands the way the three SUM ranges do, not the way the row labels sit', () => {
    // G25 = SUM(F10:F11) -> positions 1-2, G26 = SUM(F12:F14) -> 3-5,
    // G27 = SUM(F15:F16) -> 6-7. The `I` column's "Thick"/"Average"/"Fine"
    // captions sit at rows 10, 13 and 15, which looks like a different
    // grouping until you notice they are placed at the top or middle of their
    // own band. The formulas are what the sheet actually reports, so the
    // formulas are what we reproduce.
    expect(DEFAULT_SIEVE_PRESET.positions.map((p) => p.uiGroup)).toEqual([
      'coarse',
      'coarse',
      'average',
      'average',
      'average',
      'fine',
      'fine',
    ]);
  });

  it('marks exactly one position as the pan', () => {
    // The pan has no lower bound, so it cannot carry a geometric mid-point.
    // Everything about the GSD's honesty depends on knowing which one it is.
    expect(DEFAULT_SIEVE_PRESET.positions.filter((p) => p.isPan)).toHaveLength(1);
    expect(DEFAULT_SIEVE_PRESET.positions[6]?.isPan).toBe(true);
  });

  it('is resolvable by id, and every preset is the same length as the stage schema allows', () => {
    expect(sievePresetById(DEFAULT_SIEVE_PRESET.id)).toBe(DEFAULT_SIEVE_PRESET);
    // §7.3: the number of sieves is fixed by the stage schema, not the payload.
    // A preset with a different COUNT is not expressible without a second
    // stage, so no preset may ever have one.
    for (const preset of SIEVE_PRESETS) {
      expect(preset.positions, `preset "${preset.id}" changes the sieve count`).toHaveLength(7);
    }
  });

  it('uses the workbook constant for the DGM conversion', () => {
    // 104.14 is empirical and calibrated to this exact ABNT series. It is
    // named rather than inlined so that it is impossible to change it without
    // the change being visible in a diff.
    expect(DGM_CONSTANT).toBe(104.14);
  });
});

describe('the worked example reproduces the workbook exactly', () => {
  const result = computeDgm(WORKED_EXAMPLE.readings, DEFAULT_SIEVE_PRESET);

  it('is a defined result', () => {
    expect(result.status).toBe('computed');
  });

  it('retained mass per sieve = gross − tare', () => {
    expect(result.perSieve.map((s) => s.retainedGrams)).toEqual(WORKED_EXAMPLE.retainedGrams);
    expect(result.totalRetainedGrams).toBe(WORKED_EXAMPLE.totalRetainedGrams);
  });

  it('R% per sieve matches column F to the last bit', () => {
    // Exact equality, not a tolerance. Note what this does and does not prove:
    // on THIS data `(e * 100) / total` and `e * (100 / total)` give identical
    // doubles, so this assertion does not by itself gate the operation ORDER.
    // A mutation run confirmed that — reassociating the expression left all 29
    // tests green. The ordering claim is gated by `OPERATION_ORDER_FIXTURE`
    // below instead, which is what that mutation survived its way into
    // existence.
    expect(result.perSieve.map((s) => s.retainedPercent)).toEqual(
      WORKED_EXAMPLE.retainedPercent,
    );
    expect(result.totalRetainedPercent).toBe(WORKED_EXAMPLE.totalRetainedPercent);
  });

  it('Kj × R% per sieve matches column H, and its total matches H17', () => {
    expect(result.perSieve.map((s) => s.kjProduct)).toEqual(WORKED_EXAMPLE.kjProduct);
    expect(result.kjProductTotal).toBe(WORKED_EXAMPLE.kjProductTotal);
  });

  it('MF matches G20', () => {
    expect(result.finenessModule).toBe(WORKED_EXAMPLE.finenessModule);
  });

  it('DGM matches G22', () => {
    // 104.14 × 2^MF. `Math.pow` and Excel's `^` are both the platform's
    // transcendental, so this is the one workbook value allowed a tolerance —
    // and it is a tolerance of a few ULPs, not a loose one.
    expect(result.dgmMicrons).toBeCloseTo(WORKED_EXAMPLE.dgmMicrons, 10);
  });

  it('UI matches G25:G27 in units and H25:H27 in per cent', () => {
    expect([
      result.uniformityUnits.coarse,
      result.uniformityUnits.average,
      result.uniformityUnits.fine,
    ]).toEqual(WORKED_EXAMPLE.uniformityUnits);
    expect([
      result.uniformityPercent.coarse,
      result.uniformityPercent.average,
      result.uniformityPercent.fine,
    ]).toEqual(WORKED_EXAMPLE.uniformityPercent);
  });

  it('the UI bands sum to ten units / one hundred per cent', () => {
    const units =
      (result.uniformityUnits.coarse ?? NaN) +
      (result.uniformityUnits.average ?? NaN) +
      (result.uniformityUnits.fine ?? NaN);
    expect(units).toBeCloseTo(10, 10);
  });

  it('the DPG intermediate terms match A31:A37', () => {
    expect(result.dpgTerms).toEqual(WORKED_EXAMPLE.dpgTerms);
  });

  it('DPG matches G29', () => {
    // Excel STDEV is the sample standard deviation (n−1). Tolerance because
    // the summation order inside STDEV is not specified by the file.
    expect(result.dpgLegacyIndex).toBeCloseTo(WORKED_EXAMPLE.dpgLegacyIndex, 10);
  });
});

/**
 * A second fixture whose only job is to gate the ORDER of two operations.
 *
 * WHY IT EXISTS. The worked example above asserts R% to the last bit, and a
 * comment used to claim that this pinned the sheet's operation order. A
 * mutation run refuted it: rewriting `(e * 100) / total` as
 * `e * (100 / total)` left every one of the 29 assertions green, because on
 * 202 g those two expressions happen to agree in every bit. The claim was
 * true of the code and not of the test.
 *
 * So: integer masses summing to 66 g, where all seven positions disagree
 * between the two orderings. Integer masses with integer tares also means
 * `(tare + mass) - tare === mass` exactly, so the fixture tests the arithmetic
 * and not the representability of its own inputs.
 *
 * THE ORACLE. There is no workbook page for 66 g, so the expected values below
 * were produced by evaluating the decompiled formulas directly — `(e*100)/t`,
 * `F × Kj`, summed in position order — in a standalone script, not by running
 * this module. That keeps the independence that matters: if `src/lib/dgm.ts`
 * computed these by a different route, these numbers would not have changed.
 */
const OPERATION_ORDER_FIXTURE = {
  tares: [370, 398, 388, 368, 362, 330, 330],
  retained: [3, 3, 3, 3, 3, 3, 48],
  total: 66,
  retainedPercent: [
    4.545454545454546,
    4.545454545454546,
    4.545454545454546,
    4.545454545454546,
    4.545454545454546,
    4.545454545454546,
    72.72727272727273,
  ],
  kjProduct: [
    27.272727272727273,
    22.72727272727273,
    18.181818181818183,
    13.636363636363637,
    9.090909090909092,
    4.545454545454546,
    0,
  ],
  kjProductTotal: 95.45454545454547,
  // Not 100. F17 is a SUM on the sheet, and the sum of seven rounded ratios
  // need not land on the round number — see the assertion below.
  totalRetainedPercent: 100.00000000000001,
  finenessModule: 0.9545454545454547,
  dgmMicrons: 201.82008622415495,
  dpgTerms: [1.2, 0.6, 0.36, 0.18, 0.09, 0.0114, 0.1776],
  dpgLegacyIndex: 0.4126926978480996,
} as const;

describe('the order of operations is the sheet’s, and is gated', () => {
  const readings = OPERATION_ORDER_FIXTURE.tares.map((tareGrams, i) => ({
    tareGrams,
    grossGrams: tareGrams + (OPERATION_ORDER_FIXTURE.retained[i] ?? 0),
  }));
  const result = computeDgm(readings, DEFAULT_SIEVE_PRESET);

  it('is a fixture whose inputs round-trip exactly, so it tests arithmetic and not representation', () => {
    expect(result.perSieve.map((s) => s.retainedGrams)).toEqual([...OPERATION_ORDER_FIXTURE.retained]);
    expect(result.totalRetainedGrams).toBe(OPERATION_ORDER_FIXTURE.total);
  });

  it('is a fixture on which the two orderings really do disagree', () => {
    // THE CONTROL. Without this, the assertion below could pass on data where
    // the orderings agree — which is exactly the hole this fixture was added
    // to close. Asserting that the wrong answer is actually different is what
    // makes the right answer meaningful.
    const inverse = 100 / OPERATION_ORDER_FIXTURE.total;
    const reassociated = OPERATION_ORDER_FIXTURE.retained.map((e) => e * inverse);
    const disagreeing = OPERATION_ORDER_FIXTURE.retainedPercent.filter(
      (expected, i) => expected !== reassociated[i],
    ).length;
    expect(disagreeing).toBe(7);
  });

  it('computes R% as (E × 100) / total, not E × (100 / total)', () => {
    expect(result.perSieve.map((s) => s.retainedPercent)).toEqual([
      ...OPERATION_ORDER_FIXTURE.retainedPercent,
    ]);
  });

  it('matches the rest of the chain too', () => {
    expect(result.perSieve.map((s) => s.kjProduct)).toEqual([...OPERATION_ORDER_FIXTURE.kjProduct]);
    expect(result.kjProductTotal).toBe(OPERATION_ORDER_FIXTURE.kjProductTotal);
    expect(result.finenessModule).toBe(OPERATION_ORDER_FIXTURE.finenessModule);
    expect(result.dgmMicrons).toBeCloseTo(OPERATION_ORDER_FIXTURE.dgmMicrons, 10);
    expect(result.dpgTerms).toEqual([...OPERATION_ORDER_FIXTURE.dpgTerms]);
    expect(result.dpgLegacyIndex).toBeCloseTo(OPERATION_ORDER_FIXTURE.dpgLegacyIndex, 12);
  });

  it('reports F17 as the sum it is, not as a hardcoded 100', () => {
    // The sheet's F17 is `SUM(F10:F16)`, and here that sum is
    // 100.00000000000001. Hardcoding 100 would be tidier and would hide a
    // broken ratio, so the total is summed and this fixture pins the fact that
    // it is allowed not to be round.
    expect(result.totalRetainedPercent).toBe(OPERATION_ORDER_FIXTURE.totalRetainedPercent);
    expect(result.totalRetainedPercent).not.toBe(100);
  });
});

describe('the legacy DPG index is not a standard deviation, and the test says so', () => {
  it('scales linearly with sample mass — the defect that motivated showing a real GSD', () => {
    // §2.2: two identical grinds give different "DPG" if one used twice the
    // sample. This is the measurement that established it, kept as a gate so
    // nobody later "fixes" the legacy index into something else without the
    // change being deliberate.
    const base = computeDgm(WORKED_EXAMPLE.readings, DEFAULT_SIEVE_PRESET);
    for (const k of [2, 10]) {
      const scaled = computeDgm(scaleMasses(k), DEFAULT_SIEVE_PRESET);
      expect(scaled.dpgLegacyIndex).toBeCloseTo(base.dpgLegacyIndex * k, 8);
    }
  });

  it('leaves MF, DGM and UI unchanged under the same scaling', () => {
    // R% is a ratio, so everything derived from it is already scale-free. This
    // is the control for the assertion above: it shows the scaling test
    // discriminates, rather than every output moving together.
    const base = computeDgm(WORKED_EXAMPLE.readings, DEFAULT_SIEVE_PRESET);
    const scaled = computeDgm(scaleMasses(10), DEFAULT_SIEVE_PRESET);
    expect(scaled.finenessModule ?? NaN).toBeCloseTo(base.finenessModule ?? NaN, 12);
    expect(scaled.dgmMicrons ?? NaN).toBeCloseTo(base.dgmMicrons ?? NaN, 8);
    expect(scaled.uniformityPercent.average ?? NaN).toBeCloseTo(
      base.uniformityPercent.average ?? NaN,
      12,
    );
  });
});

describe('the real geometric standard deviation', () => {
  const result = computeDgm(WORKED_EXAMPLE.readings, DEFAULT_SIEVE_PRESET);

  it('matches the hand computation', () => {
    expect(result.geometricStandardDeviation).not.toBeNull();
    expect(result.geometricStandardDeviation ?? NaN).toBeCloseTo(GSD_BY_HAND, 3);
  });

  it('reports a geometric mean diameter alongside it', () => {
    expect(result.geometricMeanDiameterMicrons ?? NaN).toBeCloseTo(GEOMETRIC_MEAN_BY_HAND, 0);
  });

  it('is invariant under mass scaling, which is what makes it comparable', () => {
    // THE DISCRIMINATING PROPERTY. The oracle here is dimensional analysis, not
    // our own output: a geometric standard deviation of a distribution is
    // dimensionless and cannot depend on how much of the sample was weighed.
    for (const k of [2, 10, 0.5]) {
      const scaled = computeDgm(scaleMasses(k), DEFAULT_SIEVE_PRESET);
      expect(scaled.geometricStandardDeviation ?? NaN).toBeCloseTo(
        result.geometricStandardDeviation ?? NaN,
        10,
      );
    }
  });

  it('is flagged as truncated when the pan holds mass, and not when it does not', () => {
    // The pan has no lower aperture, so a bin mean for it would be invented.
    // The honest answer is to exclude it from the moments and say that the
    // distribution was truncated — never to silently pick a bound.
    expect(result.gsdTruncatedByPanMass).toBe(false);

    const withPanMass = WORKED_EXAMPLE.readings.map((r, i) =>
      i === 6 ? { tareGrams: r.tareGrams, grossGrams: r.tareGrams + 25 } : r,
    );
    const truncated = computeDgm(withPanMass, DEFAULT_SIEVE_PRESET);
    expect(truncated.gsdTruncatedByPanMass).toBe(true);
    expect(truncated.geometricStandardDeviation).not.toBeNull();
  });

  it('extrapolates the top sieve upper bound from the series ratio, and says which rule it used', () => {
    // The coarsest sieve has nothing above it, so its bin has no upper bound
    // either. The rule chosen is to continue the series: d₀ = d₁ × (d₁/d₂),
    // i.e. 4000 × (4000/2000) = 8000. It is named in the result so that a
    // record written years ago can be recomputed under the rule it was
    // actually computed with — this value cannot be read back off a number.
    expect(result.gsdBasis).toBe('series-ratio-top-bound/pan-excluded');
  });

  it('is null when fewer than two bounded bins hold mass', () => {
    // A standard deviation over one bin is zero by construction and means
    // nothing. Reporting it would imply a uniformity the test did not measure.
    const oneBin = WORKED_EXAMPLE.readings.map((r, i) =>
      i === 2 ? { tareGrams: r.tareGrams, grossGrams: r.tareGrams + 50 } : { tareGrams: r.tareGrams, grossGrams: r.tareGrams },
    );
    const result1 = computeDgm(oneBin, DEFAULT_SIEVE_PRESET);
    expect(result1.geometricStandardDeviation).toBeNull();
  });
});

describe('the all-zero sample, which the plan flagged as having no honest answer', () => {
  const nothingRetained = WORKED_EXAMPLE.readings.map((r) => ({
    tareGrams: r.tareGrams,
    grossGrams: r.tareGrams,
  }));
  const result = computeDgm(nothingRetained, DEFAULT_SIEVE_PRESET);

  it('does not divide by zero and does not report a fabricated number', () => {
    // §7.4: every gross equal to its tare makes R% a 0/0. There is no number
    // to report, so every ratio-derived output is null and the status says why.
    // The alternative — writing no row at all — is what
    // `sample_results_complete` reads as an incomplete test that blocks review,
    // so the distinction has to be carried in the value, not in its absence.
    expect(result.status).toBe('no_mass_retained');
    expect(result.finenessModule).toBeNull();
    expect(result.dgmMicrons).toBeNull();
    expect(result.uniformityPercent.coarse).toBeNull();
    expect(result.geometricStandardDeviation).toBeNull();
    expect(result.totalRetainedGrams).toBe(0);
  });

  it('still reports every per-sieve retained mass, because those were measured', () => {
    // The masses are measurements and are not in doubt; only the ratios are
    // undefined. Blanking the measured column too would lose real data.
    expect(result.perSieve.map((s) => s.retainedGrams)).toEqual([0, 0, 0, 0, 0, 0, 0]);
    expect(result.perSieve.every((s) => s.retainedPercent === null)).toBe(true);
  });
});

describe('refusals', () => {
  it('refuses a reading count that does not match the preset', () => {
    // §7.3: the sieve count is fixed by the stage schema. A mismatch is a
    // programming error, not a data error, and must not silently compute over
    // a short array.
    expect(() => computeDgm(WORKED_EXAMPLE.readings.slice(0, 6), DEFAULT_SIEVE_PRESET)).toThrow(
      /seven/i,
    );
  });

  it('refuses a gross mass below its tare', () => {
    // Negative retained mass is physically impossible and would silently make
    // R% negative and the total wrong. The operator needs to be told, not
    // given a number.
    const bad = WORKED_EXAMPLE.readings.map((r, i) =>
      i === 3 ? { tareGrams: 400, grossGrams: 300 } : r,
    );
    expect(() => computeDgm(bad, DEFAULT_SIEVE_PRESET)).toThrow(/less than|below|negative/i);
  });

  it('refuses a non-finite mass', () => {
    const bad = WORKED_EXAMPLE.readings.map((r, i) =>
      i === 0 ? { tareGrams: 370, grossGrams: Number.NaN } : r,
    );
    expect(() => computeDgm(bad, DEFAULT_SIEVE_PRESET)).toThrow(/finite|number/i);
  });
});

/**
 * The two rules that `gsd_basis` names, gated as rules.
 *
 * `GSD_BASIS` is the string 'series-ratio-top-bound/pan-excluded', stored in
 * column AG with every sample so an archived result can be read back under the
 * convention that produced it. It makes two promises, and until now a reader
 * had only the constant's own text that either was kept: the pan-loaded
 * fixture asserted the truncation FLAG and that the GSD was non-null, never a
 * value, and the test named for the top-bound rule asserted `gsdBasis` itself
 * — the exported constant, which cannot move when the rule it names changes.
 *
 * Deleting the pan `continue` moved a real sample's GSD by 105% with the suite
 * green; replacing the extrapolated top bound with the bare aperture moved
 * another by 9%. Both left column AG asserting the discarded convention to an
 * auditor.
 *
 * These are written as PROPERTIES, not pinned numbers. There is no workbook
 * oracle for the GSD, so an expected value could only be this code's own
 * output; a property is what the basis string actually claims, and it is
 * derivable by hand.
 */
describe('the basis string is kept, not merely asserted', () => {
  /** The worked example, with `pan` grams added to position 7 and nothing else. */
  function withPan(pan: number) {
    return WORKED_EXAMPLE.readings.map((r, i) =>
      i === 6 ? { tareGrams: r.tareGrams, grossGrams: r.tareGrams + pan } : r,
    );
  }

  it('PAN-EXCLUDED: loading the pan cannot move the GSD at all', () => {
    // The rule the basis string names. If the pan ever joins the moments this
    // fails immediately, for every pan mass, without anyone having to know
    // what the right number would be.
    const dry = computeDgm(withPan(0), DEFAULT_SIEVE_PRESET);
    for (const pan of [1, 25, 500]) {
      const loaded = computeDgm(withPan(pan), DEFAULT_SIEVE_PRESET);
      expect(
        loaded.geometricStandardDeviation ?? NaN,
        `${pan} g in the pan moved a pan-excluded GSD`,
      ).toBeCloseTo(dry.geometricStandardDeviation ?? NaN, 12);
      expect(loaded.geometricMeanDiameterMicrons ?? NaN).toBeCloseTo(
        dry.geometricMeanDiameterMicrons ?? NaN,
        9,
      );
    }
  });

  it('CONTROL: that pan mass is real, and the record does report it', () => {
    // Guards the test above from passing because the mass never arrived: the
    // excluded pan must still change the total, the fineness module and the
    // truncation flag. Only the GSD is allowed to ignore it.
    const dry = computeDgm(withPan(0), DEFAULT_SIEVE_PRESET);
    const loaded = computeDgm(withPan(25), DEFAULT_SIEVE_PRESET);
    expect(loaded.totalRetainedGrams).toBe(dry.totalRetainedGrams + 25);
    expect(loaded.finenessModule).not.toBeCloseTo(dry.finenessModule ?? NaN, 6);
    expect(loaded.gsdTruncatedByPanMass).toBe(true);
    expect(dry.gsdTruncatedByPanMass).toBe(false);
  });

  it('TOP-BOUND: the coarsest bin is bounded by the series ratio, not by its own aperture', () => {
    // Equal mass on the two coarsest sieves and nothing else, which is the
    // smallest fixture that produces a GSD at all — one loaded bin returns
    // null by design, because a deviation over a single bin is zero by
    // construction and says nothing about uniformity.
    //
    // BY HAND. Sieve 1 is 4000 µm, sieve 2 is 2000 µm, so the series ratio is
    // 2 and the bins are [4000, 8000) and [2000, 4000). Their geometric
    // midpoints are 4000√2 and 2000√2, and with equal weights the geometric
    // mean of the two is sqrt(4000√2 × 2000√2) = sqrt(16 000 000) = EXACTLY
    // 4000 µm. The round number is the point: it falls out of the series
    // continuation and nothing else.
    //
    // Collapse the top bin to [4000, 4000] — the mutation that survived — and
    // the answer becomes sqrt(4000 × 2000√2) = 3363.59 µm.
    const topTwo = WORKED_EXAMPLE.readings.map((r, i) =>
      i === 0 || i === 1
        ? { tareGrams: r.tareGrams, grossGrams: r.tareGrams + 100 }
        : { tareGrams: r.tareGrams, grossGrams: r.tareGrams },
    );
    const result = computeDgm(topTwo, DEFAULT_SIEVE_PRESET);
    expect(result.geometricMeanDiameterMicrons ?? NaN).toBeCloseTo(4000, 6);
    // Named separately so a failure says which rule broke rather than only
    // that a tolerance was missed.
    expect(
      result.geometricMeanDiameterMicrons ?? NaN,
      'the top bin was bounded by its own aperture instead of the series ratio',
    ).not.toBeCloseTo(Math.sqrt(4000 * 2000 * Math.SQRT2), 1);
  });
});
