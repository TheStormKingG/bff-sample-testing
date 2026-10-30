/**
 * Initial and reset form state, derived from the registry.
 *
 * Two rules drive everything here:
 *
 *  1. A test result is NEVER pre-filled with 0 (PRD §11). Every control starts
 *     as an empty string, which the Zod layer reads as "not measured". Only the
 *     collection date and time are seeded, because the operator is standing at
 *     the sampling point when they open the form and "now" is nearly always
 *     right — and both remain correctable.
 *
 *  2. When a value stops applying, it is CLEARED rather than left in state.
 *     A stale BC moisture reading sitting in a hidden field would otherwise be
 *     submitted the moment some other code path stopped filtering it (UAT-02).
 */

import { STAGE_SCHEMAS, isFieldApplicable } from './registry';
import type { Stage } from './types';
import { toPlantParts } from '@/lib/time';
import type { StageFormValues } from './zodSchema';

/**
 * Every operator-editable key for the stage, blank.
 *
 * Conditional fields are included even when they do not currently apply, so
 * react-hook-form has a registered, controlled entry for each one and React
 * never switches an input between controlled and uncontrolled mid-edit.
 */
export function emptyStageValues(stage: Stage): StageFormValues {
  const values: StageFormValues = {};
  for (const field of STAGE_SCHEMAS[stage].fields) {
    // Column A is server-assigned; it is displayed, never edited.
    if (field.type === 'system') continue;
    values[field.key] = '';
  }
  return values;
}

/**
 * Blank state plus the current plant-local date and time.
 *
 * `now` is injectable so tests do not depend on the wall clock, and so a
 * caller can seed from a known collection instant. The date/time come from
 * `America/Guyana`, never the device locale: a tablet left on a default time
 * zone would otherwise file an evening sample under the following day and
 * corrupt the sample-ID sequence key (NFR-008).
 */
export function defaultStageValues(stage: Stage, now: Date = new Date()): StageFormValues {
  const values = emptyStageValues(stage);
  // Registry-declared starting points, before the clock. Only on a NEW form:
  // `hydrateStageValues` merges a stored record over this, so a value an
  // operator cleared stays cleared.
  for (const field of STAGE_SCHEMAS[stage].fields) {
    if (field.type === 'system') continue;
    if (field.defaultValue !== undefined) values[field.key] = field.defaultValue;
  }
  const { date, time } = toPlantParts(now);
  if ('collection_date' in values) values['collection_date'] = date;
  if ('collection_time' in values) values['collection_time'] = time;
  return values;
}

/**
 * Blank out every field that does not apply under the given values.
 *
 * Called when a value that governs applicability changes — today only
 * `sampling_point` on Ground. Returns a new object; the input is untouched.
 */
export function clearNonApplicable(stage: Stage, values: StageFormValues): StageFormValues {
  const next: StageFormValues = { ...values };
  for (const field of STAGE_SCHEMAS[stage].fields) {
    if (field.type === 'system') continue;
    if (!isFieldApplicable(field, values)) next[field.key] = '';
  }
  return next;
}

/**
 * The keys whose value decides whether some other field applies.
 *
 * Derived from the registry rather than hardcoded, so a new `appliesWhen`
 * elsewhere automatically gets the same clear-on-change behaviour.
 */
export function applicabilityGovernorKeys(stage: Stage): readonly string[] {
  const keys = new Set<string>();
  for (const field of STAGE_SCHEMAS[stage].fields) {
    if (field.appliesWhen) keys.add(field.appliesWhen.field);
  }
  return [...keys];
}

/**
 * Merge stored values over the defaults, keeping everything a string.
 *
 * A saved draft or a registered sample arrives as loosely-typed JSON. Numbers
 * are stringified through their `enteredText` where present, so reopening a
 * record shows exactly what the operator typed — `12.50`, not `12.5`.
 */
export function hydrateStageValues(
  stage: Stage,
  stored: Readonly<Record<string, unknown>> | null | undefined,
  now: Date = new Date(),
): StageFormValues {
  const values = defaultStageValues(stage, now);
  if (!stored) return values;

  for (const key of Object.keys(values)) {
    const raw = stored[key];
    if (raw === null || raw === undefined) continue;

    if (typeof raw === 'object') {
      // The `{ value, enteredText }` measurement shape.
      const entry = raw as { value?: unknown; enteredText?: unknown };
      if (typeof entry.enteredText === 'string') {
        values[key] = entry.enteredText;
      } else if (typeof entry.value === 'number' && Number.isFinite(entry.value)) {
        values[key] = String(entry.value);
      }
      continue;
    }

    if (typeof raw === 'number') {
      values[key] = Number.isFinite(raw) ? String(raw) : '';
      continue;
    }
    if (typeof raw === 'boolean') {
      values[key] = raw ? 'yes' : 'no';
      continue;
    }
    values[key] = String(raw);
  }

  return values;
}
