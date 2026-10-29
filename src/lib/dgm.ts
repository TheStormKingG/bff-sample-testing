/**
 * DGM granulometry — the sieve-analysis arithmetic, in one place.
 *
 * ===========================================================================
 * WHY THIS FILE HAS NO IMPORTS
 * ===========================================================================
 * These numbers are computed twice: in the browser while the operator types
 * (so a mis-keyed mass is caught at the bench), and on the server when the
 * sample is saved (which is the authoritative value that reaches the audit
 * trail and the workbook). Two implementations of one rule is this
 * codebase's recurring defect — each side internally consistent, nothing
 * comparing them — so there is exactly one implementation and both sides
 * import it.
 *
 * That is only possible because the file imports nothing. The Edge Functions
 * resolve `../../../src/lib/dgm.ts`, Vite resolves `./dgm`, and
 * `scripts/check-shared-module-imports.mjs` pulls this file into the
 * shared-module closure the moment a function imports it and then fails the
 * build if any specifier here is one Deno cannot resolve. Adding an import to
 * this file is therefore not a free action — keep it at zero.
 *
 * ===========================================================================
 * WHAT THE ARITHMETIC IS, AND WHOSE IT IS
 * ===========================================================================
 * Decompiled from the BIFF formula records of `Cópia de DGM (2).xls`
 * (Poli-Nutri Alimentos, 2005, last saved 2019-08-19), not inferred from the
 * numbers it happened to contain:
 *
 *     E = D − C                     retained = (sieve+sample) − empty sieve
 *     F = E × 100 / E17             R%, this sieve's share of total retained
 *     H = F × G                     R% × Kj
 *     G20 = H17 / 100               MF  — fineness module
 *     G22 = 104.14 × 2^G20          DGM — micrometres
 *     G25 = SUM(F10:F11)/10         UI coarse, in units out of ten
 *     G26 = SUM(F12:F14)/10         UI average
 *     G27 = SUM(F15:F16)/10         UI fine
 *     G29 = STDEV(A31:A37)          DPG
 *     A31:A37 = Eᵢ × Bᵢ / 10000     mass × aperture ÷ 10 000
 *
 * The operation ORDER below matches the sheet deliberately. `(e * 100) / total`
 * and `e * (100 / total)` are different doubles, and the reason this file can
 * promise bit-identical agreement with twenty years of archived records is
 * that it does the same two operations in the same order. Do not "simplify"
 * these expressions.
 *
 * ===========================================================================
 * TWO THINGS THE SHEET GETS WRONG, AND WHAT WE DO ABOUT THEM
 * ===========================================================================
 * 1. `Kj` is 6,5,4,3,2,1,0 assigned BY POSITION, never derived from the
 *    aperture. So MF, DGM and UI depend only on how mass distributes across
 *    seven positions — not on what those sieves actually are. Swap the 1200 µm
 *    sieve for a 1000 µm one and, for the same weights, DGM is identical.
 *    That is physically wrong, and `104.14` is an empirical constant
 *    calibrated to this exact ABNT series.
 *
 *    The decision (plan §2.1, option (a)) was to keep the formula untouched
 *    and offer sieve series only as whole named presets, so that every result
 *    stays comparable with the historical record. Every aperture is still
 *    stored with every sample, so that a later decision to compute a真 real
 *    aperture-aware module (ASAE S319) can recompute history rather than
 *    losing it.
 *
 * 2. `STDEV(Eᵢ × Bᵢ / 10000)` is called a "geometric standard deviation" on
 *    the sheet and is not one: it carries units (g·µm/10⁴), it includes empty
 *    sieves as zeros, and it scales linearly with how much sample was weighed
 *    — ×2 the sample gives ×2 the "DPG". Two identical grinds therefore get
 *    different numbers. It is reproduced exactly, because the lab's archive is
 *    full of it, but it is named `dpgLegacyIndex` rather than any word
 *    containing "deviation", and a real dimensionless GSD is computed beside
 *    it (plan §2.2, option (c)).
 */

/** The DGM conversion constant, empirical and calibrated to the ABNT series. */
export const DGM_CONSTANT = 104.14;

/** How many sieve positions a DGM record holds. Fixed by the stage schema. */
export const SIEVE_COUNT = 7;

/**
 * The rule used to bound the two open-ended bins when computing the real GSD.
 *
 * Stored with every record. The coarsest sieve has nothing above it and the pan
 * has nothing below it, so neither bin has a geometric mid-point until a
 * convention supplies one — and a convention is exactly the kind of thing that
 * gets changed later by someone who does not know it was ever chosen. A number
 * cannot carry its own provenance, so the basis is carried next to it.
 */
export const GSD_BASIS = 'series-ratio-top-bound/pan-excluded';

export type UiGroup = 'coarse' | 'average' | 'fine';

export interface SievePosition {
  /** The ABNT mesh designation as the lab writes it: '5', '400', 'Fundo'. */
  readonly abnt: string;
  readonly apertureMicrons: number;
  /** Kj — by position in the stack, never derived from the aperture. */
  readonly kj: number;
  readonly uiGroup: UiGroup;
  /** The pan retains everything finer than the sieve above it. */
  readonly isPan: boolean;
}

export interface SievePreset {
  readonly id: string;
  readonly label: string;
  /** Shown to the operator where the series matters. */
  readonly note: string;
  readonly positions: readonly SievePosition[];
}

export interface SieveReading {
  /** Mass of the empty sieve, grams. */
  readonly tareGrams: number;
  /** Mass of the sieve plus the sample retained on it, grams. */
  readonly grossGrams: number;
}

export interface SieveOutcome {
  readonly retainedGrams: number;
  /** Null when nothing at all was retained: R% is then 0/0. */
  readonly retainedPercent: number | null;
  readonly kjProduct: number | null;
}

export interface UiBands {
  readonly coarse: number | null;
  readonly average: number | null;
  readonly fine: number | null;
}

export type DgmStatus = 'computed' | 'no_mass_retained';

export interface DgmResult {
  readonly status: DgmStatus;
  readonly perSieve: readonly SieveOutcome[];
  readonly totalRetainedGrams: number;
  readonly totalRetainedPercent: number | null;
  readonly kjProductTotal: number | null;
  readonly finenessModule: number | null;
  readonly dgmMicrons: number | null;
  /** UI in units out of ten, as cells G25:G27. */
  readonly uniformityUnits: UiBands;
  /** UI as percentages, as cells H25:H27. */
  readonly uniformityPercent: UiBands;
  /** The intermediate column A31:A37, kept so the sheet can be checked by eye. */
  readonly dpgTerms: readonly number[];
  /** The sheet's STDEV. An index, not a statistic — see the header comment. */
  readonly dpgLegacyIndex: number;
  /** The real, dimensionless geometric standard deviation. */
  readonly geometricStandardDeviation: number | null;
  readonly geometricMeanDiameterMicrons: number | null;
  /** True when the pan held mass, so the GSD describes a truncated distribution. */
  readonly gsdTruncatedByPanMass: boolean;
  readonly gsdBasis: string;
}

/**
 * The series the source workbook uses, and the only one in service.
 *
 * Adding a preset is one entry in `SIEVE_PRESETS` — deliberately a code change
 * rather than a form the operator can fill in, because changing the stack
 * changes what MF and DGM mean and `104.14` is calibrated to this series.
 *
 * NOTE for whoever adds the second one: the `uiGroup` bands must follow the
 * three SUM ranges the sheet uses (positions 1-2, 3-5, 6-7), and the aperture
 * of position 6 vs 7 is an open question with the lab — the workbook's own
 * conversion table puts ABNT 400 at 37 µm and marks it as the pan, while the
 * DGM sheet uses 38 µm for ABNT 400 and 37 µm for the pan, which may be the
 * pan counted twice. The values below are the DGM sheet's, because the point
 * of preset (a) is that archived results stay reproducible.
 */
const ABNT_STANDARD: SievePreset = {
  id: 'abnt-standard-7',
  label: 'ABNT 5 / 10 / 16 / 30 / 50 / 400 / Fundo',
  note: 'The standard series. MF, DGM and UI are calibrated to it.',
  positions: [
    { abnt: '5', apertureMicrons: 4000, kj: 6, uiGroup: 'coarse', isPan: false },
    { abnt: '10', apertureMicrons: 2000, kj: 5, uiGroup: 'coarse', isPan: false },
    { abnt: '16', apertureMicrons: 1200, kj: 4, uiGroup: 'average', isPan: false },
    { abnt: '30', apertureMicrons: 600, kj: 3, uiGroup: 'average', isPan: false },
    { abnt: '50', apertureMicrons: 300, kj: 2, uiGroup: 'average', isPan: false },
    { abnt: '400', apertureMicrons: 38, kj: 1, uiGroup: 'fine', isPan: false },
    { abnt: 'Fundo', apertureMicrons: 37, kj: 0, uiGroup: 'fine', isPan: true },
  ],
};

export const SIEVE_PRESETS: readonly SievePreset[] = [ABNT_STANDARD];

export const DEFAULT_SIEVE_PRESET: SievePreset = ABNT_STANDARD;

export function sievePresetById(id: string): SievePreset | undefined {
  return SIEVE_PRESETS.find((p) => p.id === id);
}

/** Excel's STDEV: the sample standard deviation, denominator n−1. */
function sampleStandardDeviation(values: readonly number[]): number {
  const n = values.length;
  if (n < 2) return 0;
  let sum = 0;
  for (const v of values) sum += v;
  const mean = sum / n;
  let squares = 0;
  for (const v of values) {
    const d = v - mean;
    squares += d * d;
  }
  return Math.sqrt(squares / (n - 1));
}

/**
 * The real geometric standard deviation, over the bins that have two bounds.
 *
 * Each sieve retains particles between its own aperture and the aperture of the
 * sieve above it, so the bin's representative diameter is the geometric mean of
 * the two. Two bins are open-ended and are handled by the rule named in
 * `GSD_BASIS`:
 *
 *   - the coarsest sieve has nothing above it, so the series is continued one
 *     step: d₀ = d₁ × (d₁ / d₂) — for the standard series, 4000 × 2 = 8000;
 *   - the pan has nothing below it, so it is EXCLUDED from the moments and its
 *     mass is reported as a truncation instead. Inventing a lower bound would
 *     put a fabricated number inside a quality record, and the fabrication
 *     would be invisible in the output.
 */
function geometricStatistics(
  positions: readonly SievePosition[],
  retained: readonly number[],
): {
  gsd: number | null;
  meanMicrons: number | null;
  truncated: boolean;
} {
  let truncated = false;
  const logs: number[] = [];
  const weights: number[] = [];

  for (let i = 0; i < positions.length; i++) {
    const position = positions[i];
    const mass = retained[i];
    if (position === undefined || mass === undefined) continue;

    if (position.isPan) {
      if (mass > 0) truncated = true;
      continue;
    }
    if (mass <= 0) continue;

    const lower = position.apertureMicrons;
    let upper: number;
    if (i === 0) {
      const next = positions[1];
      // Continue the series by its own ratio. With one position there is no
      // ratio to continue, so fall back to doubling, which is the ratio the
      // ABNT series mostly uses.
      const ratio =
        next !== undefined && next.apertureMicrons > 0 ? lower / next.apertureMicrons : 2;
      upper = lower * ratio;
    } else {
      const above = positions[i - 1];
      upper = above === undefined ? lower * 2 : above.apertureMicrons;
    }

    if (!(lower > 0) || !(upper > 0)) continue;
    logs.push(Math.log10(Math.sqrt(lower * upper)));
    weights.push(mass);
  }

  // A standard deviation over a single bin is zero by construction and says
  // nothing about uniformity. Reporting it would imply a measurement that was
  // never made.
  if (logs.length < 2) return { gsd: null, meanMicrons: null, truncated };

  let totalWeight = 0;
  for (const w of weights) totalWeight += w;
  if (!(totalWeight > 0)) return { gsd: null, meanMicrons: null, truncated };

  let weightedLogSum = 0;
  for (let i = 0; i < logs.length; i++) weightedLogSum += (weights[i] ?? 0) * (logs[i] ?? 0);
  const meanLog = weightedLogSum / totalWeight;

  let variance = 0;
  for (let i = 0; i < logs.length; i++) {
    const d = (logs[i] ?? 0) - meanLog;
    variance += (weights[i] ?? 0) * d * d;
  }
  variance /= totalWeight;

  return {
    gsd: Math.pow(10, Math.sqrt(variance)),
    meanMicrons: Math.pow(10, meanLog),
    truncated,
  };
}

/**
 * Compute every derived DGM value from seven pairs of masses.
 *
 * Throws rather than returning a result for anything that is a programming or
 * data-entry impossibility — a wrong number of sieves, a gross mass below its
 * own tare, a non-finite mass. An operator must be told, not handed a number
 * computed from a negative retained mass.
 */
export function computeDgm(
  readings: readonly SieveReading[],
  preset: SievePreset = DEFAULT_SIEVE_PRESET,
): DgmResult {
  if (readings.length !== SIEVE_COUNT || preset.positions.length !== SIEVE_COUNT) {
    throw new Error(
      `A DGM record holds exactly seven sieve positions; received ${readings.length} reading(s) ` +
        `and a preset of ${preset.positions.length}. The sieve count is fixed by the stage ` +
        `schema, not by the payload, so a mismatch is a programming error.`,
    );
  }

  // Finiteness first. A NaN gross mass is not "below its tare" — every
  // comparison against NaN is false — so a check ordered the other way round
  // would let it through and produce NaN results.
  const retained: number[] = [];
  for (let i = 0; i < readings.length; i++) {
    const reading = readings[i];
    if (reading === undefined) throw new Error(`Sieve ${i + 1} has no reading.`);
    const { tareGrams, grossGrams } = reading;
    if (!Number.isFinite(tareGrams) || !Number.isFinite(grossGrams)) {
      throw new Error(
        `Sieve ${i + 1} (${preset.positions[i]?.abnt ?? '?'}): both masses must be a finite ` +
          `number. Received tare ${String(tareGrams)} and gross ${String(grossGrams)}.`,
      );
    }
    if (grossGrams < tareGrams) {
      throw new Error(
        `Sieve ${i + 1} (${preset.positions[i]?.abnt ?? '?'}): the sieve-plus-sample mass ` +
          `(${grossGrams} g) is less than the empty-sieve mass (${tareGrams} g), which would ` +
          `make the retained mass negative.`,
      );
    }
    retained.push(grossGrams - tareGrams);
  }

  // E17 — summed in position order, as the sheet does.
  let totalRetainedGrams = 0;
  for (const r of retained) totalRetainedGrams += r;

  // A31:A37 = Eᵢ × Bᵢ / 10000. Defined even when nothing was retained, because
  // it involves no division by the total.
  const dpgTerms = retained.map((mass, i) => {
    const aperture = preset.positions[i]?.apertureMicrons ?? 0;
    return (mass * aperture) / 10000;
  });
  const dpgLegacyIndex = sampleStandardDeviation(dpgTerms);

  const geometric = geometricStatistics(preset.positions, retained);

  if (totalRetainedGrams === 0) {
    // Every ratio is 0/0. There is no number to report, and reporting zero
    // would read as "measured, and it was zero" rather than "undefined".
    return {
      status: 'no_mass_retained',
      perSieve: retained.map((retainedGrams) => ({
        retainedGrams,
        retainedPercent: null,
        kjProduct: null,
      })),
      totalRetainedGrams: 0,
      totalRetainedPercent: null,
      kjProductTotal: null,
      finenessModule: null,
      dgmMicrons: null,
      uniformityUnits: { coarse: null, average: null, fine: null },
      uniformityPercent: { coarse: null, average: null, fine: null },
      dpgTerms,
      dpgLegacyIndex,
      geometricStandardDeviation: null,
      geometricMeanDiameterMicrons: null,
      gsdTruncatedByPanMass: geometric.truncated,
      gsdBasis: GSD_BASIS,
    };
  }

  // F = E × 100 / E17, then H = F × G. The order is the sheet's.
  const perSieve: SieveOutcome[] = retained.map((retainedGrams, i) => {
    const retainedPercent = (retainedGrams * 100) / totalRetainedGrams;
    const kj = preset.positions[i]?.kj ?? 0;
    return { retainedGrams, retainedPercent, kjProduct: retainedPercent * kj };
  });

  // H17, summed in position order.
  let kjProductTotal = 0;
  for (const s of perSieve) kjProductTotal += s.kjProduct ?? 0;

  // F17. Computed as the sheet does — SUM of column F, not hardcoded to 100 —
  // so that a change which breaks the ratio shows up here instead of being
  // masked by a constant.
  let totalRetainedPercent = 0;
  for (const s of perSieve) totalRetainedPercent += s.retainedPercent ?? 0;

  const finenessModule = kjProductTotal / 100;
  const dgmMicrons = DGM_CONSTANT * Math.pow(2, finenessModule);

  // H25:H27 are the band sums; G25:G27 are those divided by ten. Summing the
  // band first and dividing after is the sheet's order.
  const bandPercent = (group: UiGroup): number => {
    let sum = 0;
    for (let i = 0; i < perSieve.length; i++) {
      if (preset.positions[i]?.uiGroup === group) sum += perSieve[i]?.retainedPercent ?? 0;
    }
    return sum;
  };
  const coarsePercent = bandPercent('coarse');
  const averagePercent = bandPercent('average');
  const finePercent = bandPercent('fine');

  return {
    status: 'computed',
    perSieve,
    totalRetainedGrams,
    totalRetainedPercent,
    kjProductTotal,
    finenessModule,
    dgmMicrons,
    uniformityUnits: {
      coarse: coarsePercent / 10,
      average: averagePercent / 10,
      fine: finePercent / 10,
    },
    uniformityPercent: {
      coarse: coarsePercent,
      average: averagePercent,
      fine: finePercent,
    },
    dpgTerms,
    dpgLegacyIndex,
    geometricStandardDeviation: geometric.gsd,
    geometricMeanDiameterMicrons: geometric.meanMicrons,
    gsdTruncatedByPanMass: geometric.truncated,
    gsdBasis: GSD_BASIS,
  };
}
