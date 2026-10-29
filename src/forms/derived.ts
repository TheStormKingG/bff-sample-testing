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
 * Seven of the eight stages have no entry and get `{}` without allocating.
 */

import { computeDgm, sievePresetById, DEFAULT_SIEVE_PRESET, type SieveReading } from '../lib/dgm.ts';
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
  throw new Error(`Field "${key}" is required to compute the DGM results and was not usable.`);
}

/**
 * The DGM outputs, as spreadsheet cells.
 *
 * Returns `{}` rather than throwing when a mass is missing: requiredness is
 * the validator's job and it has already run, so the only way to arrive here
 * incomplete is a phase that does not require the masses. Writing partial
 * arithmetic would be worse than writing nothing.
 */
function deriveDgm(values: CleanValues): Record<string, string> {
  const schema = STAGE_SCHEMAS.dgm;
  const readings: SieveReading[] = [];
  for (let n = 1; n <= 7; n++) {
    const tareKey = `sieve${n}_tare_g`;
    const grossKey = `sieve${n}_gross_g`;
    if (values[tareKey] === undefined || values[grossKey] === undefined) return {};
    readings.push({
      tareGrams: numberAt(values, tareKey),
      grossGrams: numberAt(values, grossKey),
    });
  }

  const presetId = typeof values['sieve_series'] === 'string' ? values['sieve_series'] : '';
  const preset = sievePresetById(presetId) ?? DEFAULT_SIEVE_PRESET;

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

  // Every key must be a real column on the tab, or `toSheetRow` would ignore
  // it and the value would vanish with no error anywhere. Checked against the
  // registry rather than against this file's own list.
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

const DERIVERS: Partial<Record<Stage, (values: CleanValues) => Record<string, string>>> = {
  dgm: deriveDgm,
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
export function deriveSystemValues(stage: Stage, values: CleanValues): Record<string, string> {
  const derive = DERIVERS[stage];
  if (derive === undefined) return {};
  return derive(values);
}
