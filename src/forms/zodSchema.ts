/**
 * Registry-driven Zod validation.
 *
 * One builder produces the validation schema for any (stage, workflow phase)
 * pair by reading `registry.ts`. There is no per-stage hand-written field list
 * here and no column index anywhere (PRD NFR-006): add a field to the registry
 * and it is validated, rendered and serialized without touching this file.
 *
 * THE CENTRAL DISTINCTION THIS MODULE ENFORCES
 *
 *   A HARD BOUND (`min` / `max`) is a physical or logical impossibility — a
 *   negative mass, a percentage above 100. Violating one is a rejected input.
 *
 *   A SOFT GUARD (`implausibleAbove`) is a typo filter. It NEVER fails
 *   validation. `implausibleFindings()` reports it so the UI can ask the
 *   operator "that looks unusually high — is it correct?", and a confirmed
 *   value is accepted unchanged.
 *
 *   An OPERATIONAL ACCEPTANCE LIMIT is neither. It lives only in
 *   `specification_versions`, is applied only by `assessment.ts`, and must
 *   never appear in this file in any form. 0 of the 34 workbook `Limits`
 *   entries are approved, so nothing here may imply otherwise.
 *
 * Form state holds the operator's RAW TEXT for every control, so `12.50` keeps
 * its trailing zero — that zero states the instrument's resolution and is part
 * of the record. The schema emits `{ value, enteredText }` for measurements,
 * which is the shape `toSheetRow` already preserves verbatim.
 */

import { z } from 'zod';

import {
  STAGE_SCHEMAS,
  fieldsRequiredAt,
  isFieldApplicable,
} from './registry';
import { looksLikeFormula, type MeasurementValue } from './sheetMapping';
import type { FieldDef, Stage } from './types';

/** The workflow phase whose requiredness set applies to this submission. */
export type FormPhase = 'draft' | 'registration' | 'testing' | 'review';

/**
 * Raw form state. Every control — including measurements — holds a string,
 * because that is the only representation that cannot silently lose entered
 * precision or turn an empty box into a zero.
 */
export type StageFormValues = Record<string, string>;

/** A validated measurement: the parsed number plus the text as typed. */
export interface MeasurementEntry {
  readonly value: number;
  readonly enteredText: string;
}

/**
 * Validated submission payload. Assignable to `SampleValues`, so it can be
 * handed straight to `toSheetRow`. Fields that are blank or non-applicable are
 * ABSENT rather than present-and-null.
 */
export type StageSubmitValues = Record<string, MeasurementValue>;

export type StageZodSchema = z.ZodType<StageSubmitValues, z.ZodTypeDef, unknown>;

/**
 * Free-text columns where a leading `-` or `+` is legitimate prose.
 *
 * This set MIRRORS `FREEFORM_TEXT_KEYS` in `sheetMapping.ts`, which is not
 * exported. The two must agree: if validation accepted formula-like text that
 * the sheet encoder refuses, the sample would pass the form and then fail at
 * write time with no field to point the operator at.
 */
const FREEFORM_TEXT_KEYS: ReadonlySet<string> = new Set(['comments', 'action_taken']);

/**
 * A plain decimal as a plant operator types it: `12`, `12.5`, `.5`, `12.`, `-3`.
 *
 * Exponent notation (`1e5`) is refused. It is a valid JS number but nobody
 * enters it on a plant keypad, so its only realistic origin is a mis-keyed
 * value, and accepting it would let a typo become a four-order-of-magnitude
 * quality record.
 */
const DECIMAL_TEXT = /^-?(?:\d+(?:\.\d*)?|\.\d+)$/;
const DATE_TEXT = /^\d{4}-\d{2}-\d{2}$/;
const TIME_TEXT = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Requiredness is CUMULATIVE along the capture state machine: a sample cannot
 * be ready for review while its registration fields are blank. `draft` requires
 * nothing at all (FR-005) but still refuses a malformed value, so a draft can
 * never hold text that would fail on submission.
 */
const PHASE_CHAIN: Record<FormPhase, readonly ('registration' | 'testing' | 'review')[]> = {
  draft: [],
  registration: ['registration'],
  testing: ['registration', 'testing'],
  review: ['registration', 'testing', 'review'],
};

/** Keys the given phase makes mandatory, honouring conditional applicability. */
export function requiredFieldKeys(
  stage: Stage,
  phase: FormPhase,
  values: Readonly<Record<string, unknown>>,
): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const p of PHASE_CHAIN[phase]) {
    for (const field of fieldsRequiredAt(stage, p, values)) keys.add(field.key);
  }
  return keys;
}

/** Operator-editable fields for this stage and these values, in registry order. */
export function editableFields(
  stage: Stage,
  values: Readonly<Record<string, unknown>>,
): readonly FieldDef[] {
  return STAGE_SCHEMAS[stage].fields.filter(
    // `system` is column A, assigned by the server at registration. It is shown
    // read-only after the fact and is never part of the submitted payload.
    (f) => f.type !== 'system' && isFieldApplicable(f, values),
  );
}

function normalizeToText(raw: unknown): string {
  if (raw === null || raw === undefined) return '';
  if (typeof raw === 'string') return raw.trim();
  if (typeof raw === 'number') return Number.isFinite(raw) ? String(raw) : '';
  if (typeof raw === 'boolean') return raw ? 'yes' : 'no';
  return String(raw).trim();
}

function missingMessage(field: FieldDef): string {
  switch (field.type) {
    case 'yesno':
      return 'Answer Yes or No';
    case 'select':
      return 'Choose one of the options';
    case 'number':
      return 'Enter a value';
    case 'date':
      return 'Enter the date';
    case 'time':
      return 'Enter the time';
    default:
      return 'Fill this in';
  }
}

/** Effective hard bounds. A percentage is 0-100 whatever the registry says. */
function hardBounds(field: FieldDef): { min?: number; max?: number } {
  const bounds: { min?: number; max?: number } = {};
  if (field.min !== undefined) bounds.min = field.min;
  if (field.max !== undefined) bounds.max = field.max;
  if (field.unit === '%') {
    // Belt and braces: every current % field already carries 0/100, but a
    // percentage added later without them must still be bounded.
    bounds.min = Math.max(bounds.min ?? 0, 0);
    bounds.max = Math.min(bounds.max ?? 100, 100);
  }
  return bounds;
}

type FieldSchema = z.ZodType<MeasurementValue | undefined, z.ZodTypeDef, unknown>;

function numberFieldSchema(field: FieldDef, required: boolean): FieldSchema {
  const { min, max } = hardBounds(field);
  return z.unknown().transform((raw, ctx): MeasurementEntry | undefined => {
    // A non-finite number arriving as an actual number — not as text — is
    // rejected rather than normalized away. Letting NaN fall through to the
    // empty-string branch would file garbage as "not measured", conflating a
    // broken input with a deliberate blank (PRD §6.1) and hiding the upstream
    // bug that produced it.
    if (typeof raw === 'number' && !Number.isFinite(raw)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Enter a real number' });
      return z.NEVER;
    }

    const text = normalizeToText(raw);

    // An empty box is NOT measured. It must never become 0 (PRD §6.1).
    if (text === '') {
      if (required) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: missingMessage(field) });
        return z.NEVER;
      }
      return undefined;
    }

    if (!DECIMAL_TEXT.test(text)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Enter numbers only, for example 12.5',
      });
      return z.NEVER;
    }

    const value = Number(text);
    // Rejects NaN and +/-Infinity. The regex already excludes the literal
    // words, but a hostile payload can reach this schema without the form.
    if (!Number.isFinite(value)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Enter a real number' });
      return z.NEVER;
    }

    if (min !== undefined && value < min) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: min === 0 ? 'Cannot be less than zero' : `Cannot be less than ${min}`,
      });
      return z.NEVER;
    }
    if (max !== undefined && value > max) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Cannot be more than ${max}`,
      });
      return z.NEVER;
    }

    // `implausibleAbove` is deliberately NOT checked here. It is a soft typo
    // guard surfaced by `implausibleFindings()` and confirmed by the operator;
    // treating it as a validation failure would make it an unapproved
    // operational limit, which PRD §6.1 reserves to the process owner.

    // 0 reaches here unchanged: it is a real measured value, not a blank.
    return { value, enteredText: text };
  });
}

function enumFieldSchema(field: FieldDef, required: boolean): FieldSchema {
  const options = field.options ?? [];
  const allowed = options.map((o) => o.value);
  return z.unknown().transform((raw, ctx): string | undefined => {
    const text = normalizeToText(raw);
    if (text === '') {
      if (required) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: missingMessage(field) });
        return z.NEVER;
      }
      return undefined;
    }
    if (allowed.length === 0) {
      // A controlled field with no option list is a registry defect, not an
      // operator error. Fail loudly rather than storing an unconstrained code.
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `No options are configured for "${field.label}"`,
      });
      return z.NEVER;
    }
    if (!allowed.includes(text)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Choose one of the options',
      });
      return z.NEVER;
    }
    // The CODE is stored, never the display label (PRD §6.1).
    return text;
  });
}

function textFieldSchema(field: FieldDef, required: boolean): FieldSchema {
  const freeform = FREEFORM_TEXT_KEYS.has(field.key);
  return z.unknown().transform((raw, ctx): string | undefined => {
    const text = normalizeToText(raw);
    if (text === '') {
      if (required) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: missingMessage(field) });
        return z.NEVER;
      }
      return undefined;
    }
    if (!freeform && looksLikeFormula(text)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Cannot start with = + - or @. Remove the first character.',
      });
      return z.NEVER;
    }
    return text;
  });
}

function dateFieldSchema(field: FieldDef, required: boolean): FieldSchema {
  return z.unknown().transform((raw, ctx): string | undefined => {
    const text = normalizeToText(raw);
    if (text === '') {
      if (required) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: missingMessage(field) });
        return z.NEVER;
      }
      return undefined;
    }
    if (!DATE_TEXT.test(text)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Use the date picker' });
      return z.NEVER;
    }
    // Reject 2026-02-30: the pattern matches but the day does not exist.
    const [y, m, d] = text.split('-').map(Number);
    const probe = new Date(Date.UTC(y ?? 0, (m ?? 1) - 1, d ?? 1));
    if (
      probe.getUTCFullYear() !== y ||
      probe.getUTCMonth() + 1 !== m ||
      probe.getUTCDate() !== d
    ) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'That date does not exist' });
      return z.NEVER;
    }
    return text;
  });
}

function timeFieldSchema(field: FieldDef, required: boolean): FieldSchema {
  return z.unknown().transform((raw, ctx): string | undefined => {
    const text = normalizeToText(raw);
    if (text === '') {
      if (required) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: missingMessage(field) });
        return z.NEVER;
      }
      return undefined;
    }
    if (!TIME_TEXT.test(text)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Use 24-hour time, for example 14:30',
      });
      return z.NEVER;
    }
    return text;
  });
}

function fieldSchema(field: FieldDef, required: boolean): FieldSchema {
  switch (field.type) {
    case 'number':
      return numberFieldSchema(field, required);
    case 'select':
    case 'yesno':
      return enumFieldSchema(field, required);
    case 'date':
      return dateFieldSchema(field, required);
    case 'time':
      return timeFieldSchema(field, required);
    case 'text':
    case 'textarea':
      return textFieldSchema(field, required);
    case 'system':
      // Never reached: `editableFields` filters column A out before this point.
      // Kept so adding a FieldType cannot compile without a decision here.
      return textFieldSchema(field, false);
    default: {
      const exhaustive: never = field.type;
      throw new Error(`Unhandled field type ${String(exhaustive)}`);
    }
  }
}

/**
 * Build the validation schema for one stage at one phase.
 *
 * `values` is the CURRENT form state: conditional applicability is resolved
 * against it, so a field that does not apply right now is absent from the
 * schema entirely. That is what makes a stale BC moisture reading unable to
 * reach the server after the operator switches to AM (UAT-02) — the key is
 * stripped rather than submitted as null-but-required.
 */
export function buildStageSchema(
  stage: Stage,
  phase: FormPhase,
  values: Readonly<Record<string, unknown>> = {},
): StageZodSchema {
  const required = requiredFieldKeys(stage, phase, values);
  const shape: Record<string, FieldSchema> = {};

  for (const field of editableFields(stage, values)) {
    shape[field.key] = fieldSchema(field, required.has(field.key));
  }

  // `z.object` strips unknown keys, so a value left over from a previously
  // applicable field cannot survive into the payload.
  return z.object(shape).transform((parsed): StageSubmitValues => {
    const out: StageSubmitValues = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (value !== undefined) out[key] = value;
    }
    return out;
  });
}

export type StageParseResult =
  | { readonly ok: true; readonly values: StageSubmitValues }
  | { readonly ok: false; readonly errors: Readonly<Record<string, string>> };

/**
 * Validate raw form state, returning either the payload or one message per
 * field key. Used by tests and by any non-react-hook-form caller.
 */
export function parseStageValues(
  stage: Stage,
  phase: FormPhase,
  raw: Readonly<Record<string, unknown>>,
): StageParseResult {
  const result = buildStageSchema(stage, phase, raw).safeParse(raw);
  if (result.success) return { ok: true, values: result.data };

  const errors: Record<string, string> = {};
  for (const issue of result.error.issues) {
    const key = issue.path[0];
    if (typeof key !== 'string') continue;
    // First message per field wins, matching what the UI shows beside an input.
    if (errors[key] === undefined) errors[key] = issue.message;
  }
  return { ok: false, errors };
}

export interface ImplausibleFinding {
  readonly field: FieldDef;
  readonly entered: string;
  readonly value: number;
  readonly threshold: number;
}

/**
 * Measurements above their soft guard, for the confirmation dialog.
 *
 * This is the ONLY consumer of `implausibleAbove`. A finding here is a question
 * for the operator, never a rejection and never an assessment: a confirmed
 * value is recorded exactly as typed.
 */
export function implausibleFindings(
  stage: Stage,
  values: Readonly<Record<string, MeasurementValue>>,
): readonly ImplausibleFinding[] {
  const findings: ImplausibleFinding[] = [];
  for (const field of STAGE_SCHEMAS[stage].fields) {
    const threshold = field.implausibleAbove;
    if (threshold === undefined) continue;
    const held = values[field.key];
    if (held === null || held === undefined || held === '') continue;

    const value = typeof held === 'object' ? held.value : Number(held);
    const entered = typeof held === 'object' ? held.enteredText : String(held);
    if (!Number.isFinite(value) || value <= threshold) continue;

    findings.push({ field, entered, value, threshold });
  }
  return findings;
}
