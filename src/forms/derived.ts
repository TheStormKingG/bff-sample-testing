/**
 * Columns the server computes, for the stages that have any.
 *
 * ===========================================================================
 * WHERE THIS SITS, AND WHY
 * ===========================================================================
 * `validateStagePayload` calls this between checking the operator's values and
 * serialising the row. That position is forced, not chosen: `toSheetRow` runs
 * INSIDE the validator (the row must be provably serialisable before anything
 * commits), so anything a handler computes after the validator returns is in
 * neither `p_values` nor `p_row` and reaches neither the database nor the
 * spreadsheet.
 *
 * The result is merged into the values used for the ROW ONLY. It is
 * deliberately NOT merged into `values`, which becomes `p_values` and is
 * applied by `apply_submitted_values` — that path calls `apply_measurement`,
 * which raises for any field whose type or requiredness is `system`
 * (0008_assessment_engine.sql:386). Computed values are stored instead by the
 * trigger on the outbox insert, which reads them back out of the projected
 * row; see 0025_dgm_stage.sql.
 *
 * ===========================================================================
 * WHY A MAP KEYED BY STAGE RATHER THAN A SWITCH IN THE VALIDATOR
 * ===========================================================================
 * `validation.ts` states its own rule in its header: "Nothing here enumerates
 * fields. Every rule is read from `STAGE_SCHEMAS[stage].fields`." A `switch`
 * on stage in the validator would be the first exception to that and would
 * invite the second. One lookup in a table, declared here beside the
 * arithmetic, keeps the validator stage-agnostic and keeps this knowledge in
 * one file.
 *
 * Four of the eight stages have no entry and get `{}` without allocating.
 */

import {
  computeDgm,
  sievePresetById,
  DEFAULT_SIEVE_PRESET,
  SIEVE_COUNT,
  type SieveReading,
} from '../lib/dgm.ts';
import { applySieveSeries, type SieveSeriesDocument } from '../lib/sieveSeries.ts';
import { STAGE_SCHEMAS } from './registry.ts';
import type { Stage } from './types.ts';

/** What the operator sent, after validation: text, numbers, or {value, enteredText}. */
type CleanValues = Readonly<Record<string, unknown>>;

/**
 * Decimal places written to the spreadsheet for each computed column.
 *
 * Fixed, not trimmed. A computed number has no instrument precision to state —
 * which is the whole reason the rest of this system preserves the operator's
 * keystrokes verbatim — so the honest thing is a precision chosen once, here,
 * and applied the same way every time. Generous enough that nothing a lab
 * would compare is lost, and the same string comes back from recomputing the
 * stored masses.
 */
const DECIMALS: Readonly<Record<string, number>> = {
  total_retained_g: 2,
  fineness_module: 6,
  dgm_um: 4,
  ui_coarse_pct: 4,
  ui_average_pct: 4,
  ui_fine_pct: 4,
  dpg_legacy_index: 6,
  gsd: 6,
  // One place, which is what the column it replaces carried as a typed-in
  // figure and what every published durability table prints.
  pellet_durability_pdi_pct: 1,
};

/** A number as it will appear in the cell, or '' when there is no answer. */
function cell(key: string, value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '';
  const places = DECIMALS[key] ?? 4;
  const text = value.toFixed(places);
  // `encodeText` refuses a cell beginning with '=', '+', '-' or '@' for any
  // field outside FREEFORM_TEXT_KEYS, and every column here is outside it. No
  // DGM output can be negative — masses are refused below their tare, so every
  // ratio and every mean is non-negative — but relying on that silently would
  // turn a future arithmetic change into a confusing "formula-like text"
  // refusal at serialisation time rather than a statement about the number.
  if (text.startsWith('-')) {
    throw new Error(
      `Computed column "${key}" came out negative (${text}), which no DGM output can be. ` +
        `Refusing to write it rather than recording an impossible result.`,
    );
  }
  return text;
}

/** Read a validated numeric field back out of the cleaned values. */
function numberAt(values: CleanValues, key: string): number {
  const raw = values[key];
  if (typeof raw === 'number') return raw;
  if (typeof raw === 'object' && raw !== null && 'value' in raw) {
    const v = (raw as { value: unknown }).value;
    if (typeof v === 'number') return v;
  }
  if (typeof raw === 'string' && raw.trim() !== '') {
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
  }
  throw new Error(`Field "${key}" is required to compute the sieve results and was not usable.`);
}

/**
 * The sieve-test outputs for one stage, as spreadsheet cells.
 *
 * Returns `{}` rather than throwing when a mass is missing: requiredness is
 * the validator's job and it has already run, so the only way to arrive here
 * incomplete is a phase that does not require the masses. Writing partial
 * arithmetic would be worse than writing nothing.
 */
function deriveSieveTest(
  stage: Stage,
  values: CleanValues,
  series: SieveSeriesDocument | null,
): Record<string, string> {
  const readings: SieveReading[] = [];
  for (let n = 1; n <= SIEVE_COUNT; n++) {
    const tareKey = `sieve${n}_tare_g`;
    const grossKey = `sieve${n}_gross_g`;
    if (values[tareKey] === undefined || values[grossKey] === undefined) return {};
    readings.push({
      tareGrams: numberAt(values, tareKey),
      grossGrams: numberAt(values, grossKey),
    });
  }

  const presetId = typeof values['sieve_series'] === 'string' ? values['sieve_series'] : '';
  /*
    The METHOD comes from the preset — kj by position, the three uniformity
    bands, which position is the pan. The TABLE comes from the lab, through
    `system_config.sieve_series`, so a re-calibrated aperture reaches the
    stored figures and not only the screen. `applySieveSeries` is positional
    and overrides nothing structural; a null table leaves the preset alone.
  */
  const preset = applySieveSeries(sievePresetById(presetId) ?? DEFAULT_SIEVE_PRESET, series);

  const result = computeDgm(readings, preset);

  const out: Record<string, string> = {
    total_retained_g: cell('total_retained_g', result.totalRetainedGrams),
    fineness_module: cell('fineness_module', result.finenessModule),
    dgm_um: cell('dgm_um', result.dgmMicrons),
    ui_coarse_pct: cell('ui_coarse_pct', result.uniformityPercent.coarse),
    ui_average_pct: cell('ui_average_pct', result.uniformityPercent.average),
    ui_fine_pct: cell('ui_fine_pct', result.uniformityPercent.fine),
    dpg_legacy_index: cell('dpg_legacy_index', result.dpgLegacyIndex),
    gsd: cell('gsd', result.geometricStandardDeviation),
    // Text, not a number: it records WHICH convention bounded the two
    // open-ended bins. Blank when there is no GSD to describe, so the cell
    // never claims a basis for a figure that was not produced.
    gsd_basis: result.geometricStandardDeviation === null ? '' : result.gsdBasis,
  };

  return assertComputedColumns(stage, out);
}

/**
 * Every computed key must be a real `system` column on the tab.
 *
 * A key that is not a column is silently dropped by `toSheetRow` and the
 * value vanishes with no error anywhere; a key that is a column but is not
 * `system` is one an operator could submit and the server would overwrite
 * without saying so. Checked against the registry rather than against any
 * list kept in this file, so a column that moves tab cannot leave a stale
 * copy behind here.
 */
function assertComputedColumns(
  stage: Stage,
  out: Record<string, string>,
): Record<string, string> {
  const schema = STAGE_SCHEMAS[stage];
  for (const key of Object.keys(out)) {
    const field = schema.fields.find((f) => f.key === key);
    if (field === undefined) {
      throw new Error(`Computed key "${key}" is not a column on the ${schema.title} tab.`);
    }
    if (field.type !== 'system') {
      throw new Error(
        `Computed key "${key}" is declared "${field.type}" rather than "system", so an ` +
          `operator could submit it and the server would overwrite them silently.`,
      );
    }
  }
  return out;
}

/**
 * Pellet durability, from the two weighings.
 *
 *     PDI (%) = whole pellets after tumbling / sample before tumbling x 100
 *
 * `{}` when either weighing is absent, for the same reason `deriveSieveTest`
 * returns `{}`: requiredness is the validator's job and it has already run,
 * so arriving here without both weights means a phase or a sample that does
 * not carry this test.
 *
 * TWO THINGS THIS DELIBERATELY DOES NOT DO.
 *
 * It does not clamp. A result above 100% is impossible — nothing leaves a
 * tumbler heavier than it entered — so it means one of the two weighings is
 * wrong, and the useful thing to put in front of the operator is the
 * contradiction, beside the two numbers that produced it, not a tidy 100.0
 * that hides which figure to re-check.
 *
 * It does not guess at a missing "before". The method's 500 g is seeded as a
 * DEFAULT on the input, where the operator can see it and change it, rather
 * than assumed here, where they could not. A blank before-weight yields no
 * percentage at all, which is the honest answer to "divided by what?".
 */
function derivePdi(stage: Stage, values: CleanValues): Record<string, string> {
  if (values['pdi_before_g'] === undefined || values['pdi_after_g'] === undefined) return {};
  const before = numberAt(values, 'pdi_before_g');
  const after = numberAt(values, 'pdi_after_g');
  // Not an error: 0 g in is a mis-keyed field, and a division by it would
  // produce Infinity, which `cell` renders as ''. Returning nothing says the
  // same thing without relying on that.
  if (before <= 0) return {};
  return assertComputedColumns(stage, {
    pellet_durability_pdi_pct: cell('pellet_durability_pdi_pct', (after / before) * 100),
  });
}

/**
 * Both tests on one tab.
 *
 * `4 Pellets` and `6 Crumble` carry the sieve test AND the durability test,
 * and the two are independent: a sample can be tumbled without the stack
 * being weighed, or weighed without being tumbled. Merging two derivers that
 * each return `{}` on their own missing inputs gives exactly that, and keeps
 * each piece of arithmetic in one place.
 */
function deriveSieveAndPdi(
  stage: Stage,
  values: CleanValues,
  series: SieveSeriesDocument | null,
): Record<string, string> {
  return { ...deriveSieveTest(stage, values, series), ...derivePdi(stage, values) };
}

/**
 * The stages whose columns the server fills in.
 *
 * All five carry the same sieve test and therefore the same nine computed
 * columns, so they share one implementation parameterised by stage rather
 * than five copies that could disagree about what a fineness module is. Two
 * of them also carry the durability test, which is a separate measurement
 * with its own inputs, so they get the pair. The
 * per-stage lookup is still a TABLE and not a `switch` in the validator:
 * `validation.ts` states in its own header that "nothing here enumerates
 * fields", and a `switch` on stage there would be the first exception to that
 * and would invite the second.
 */
const DERIVERS: Partial<
  Record<
    Stage,
    (stage: Stage, values: CleanValues, series: SieveSeriesDocument | null) => Record<string, string>
  >
> = {
  ground: deriveSieveTest,
  pellets: deriveSieveAndPdi,
  crumble: deriveSieveAndPdi,
  mash: deriveSieveTest,
  dgm: deriveSieveTest,
};

/** Does this stage have columns the server fills in? */
export function hasDerivedColumns(stage: Stage): boolean {
  return DERIVERS[stage] !== undefined;
}

/**
 * The server-computed cells for a stage, keyed by field key. `{}` for a stage
 * that has none, and for a payload that does not carry what the computation
 * needs.
 */
export function deriveSystemValues(
  stage: Stage,
  values: CleanValues,
  series: SieveSeriesDocument | null = null,
): Record<string, string> {
  const derive = DERIVERS[stage];
  if (derive === undefined) return {};
  return derive(stage, values, series);
}
