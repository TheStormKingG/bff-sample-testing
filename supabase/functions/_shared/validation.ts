/**
 * Server-side payload validation, derived entirely from the form registry.
 *
 * Master Prompt §4: "All client-originating inputs are untrusted, including
 * names, email, roles, IDs, review flags, threshold values and purported
 * session identity." FR-008 requires requiredness by stage, types, units,
 * controlled options and safe string storage, with field-level feedback.
 *
 * Nothing here enumerates fields. Every rule is read from
 * `STAGE_SCHEMAS[stage].fields`, so adding a column to the registry
 * automatically extends validation, and no second list can fall out of step
 * with the first (NFR-006: "no magic column offsets buried throughout UI
 * code").
 *
 * What this module does NOT do: decide conformity. Hard bounds here are
 * physical impossibilities (a percentage above 100, a negative mass) which the
 * registry marks as `min`/`max`. Acceptance limits live in
 * `specification_versions` and are applied by `src/lib/assessment.ts`. Rule 7
 * of the build contract — never invent a numeric acceptance limit — is held by
 * that separation, not by a comment.
 *
 * PURE: no Deno, no npm/jsr, no I/O.
 */

import {
  STAGE_SCHEMAS,
  fieldsRequiredAt,
  isFieldApplicable,
  resolvePrefix,
} from '../../../src/forms/registry.ts';
import { STAGES, type FieldDef, type Stage } from '../../../src/forms/types.ts';
import { looksLikeFormula, toSheetRow } from '../../../src/forms/sheetMapping.ts';
import type { SampleValues } from '../../../src/forms/sheetMapping.ts';

/**
 * Narrow an untrusted stage string. Returns null rather than throwing, so a
 * bad stage becomes a 400 instead of a 500, and never an unchecked index into
 * `STAGE_SCHEMAS` (which `noUncheckedIndexedAccess` would otherwise let
 * through as `undefined` at runtime).
 */
export function parseStage(value: unknown): Stage | null {
  return typeof value === 'string' && (STAGES as readonly string[]).includes(value)
    ? (value as Stage)
    : null;
}

export type ValidationCode =
  | 'unknown_field'
  | 'required'
  | 'not_applicable'
  | 'not_a_number'
  | 'not_finite'
  | 'below_minimum'
  | 'above_maximum'
  | 'implausible_unconfirmed'
  | 'unknown_option'
  | 'not_a_string'
  | 'formula_like'
  | 'too_long'
  | 'bad_date'
  | 'bad_time'
  | 'serialisation_failed'
  | 'server_assigned';

export interface ValidationIssue {
  /** Registry field key, or `_payload` for a whole-payload problem. */
  readonly field: string;
  readonly code: ValidationCode;
  readonly message: string;
}

export type ValidationPhase = 'registration' | 'testing' | 'review';

export interface ValidateArgs {
  readonly stage: Stage;
  readonly phase: ValidationPhase;
  /** Raw, untrusted values keyed by registry field key. */
  readonly values: Readonly<Record<string, unknown>>;
  /**
   * Field keys whose `implausibleAbove` soft guard the operator has explicitly
   * confirmed. PRD §6.1 allows a configurable guard against "scientific
   * nonsense" while reserving operational bounds for process-owner approval,
   * so the guard asks rather than refuses.
   */
  readonly confirmedImplausible?: readonly string[];
}

export type ValidationResult =
  | { readonly ok: true; readonly values: SampleValues; readonly row: readonly string[] }
  | { readonly ok: false; readonly issues: readonly ValidationIssue[] };

/** Longest free-text cell accepted. Sheets itself allows 50 000 characters. */
export const MAX_TEXT_LENGTH = 2_000;

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^\d{2}:\d{2}$/;

/**
 * Is formula-like text legitimate in this field?
 *
 * `src/forms/sheetMapping.ts` permits it for narrative columns — a comment may
 * reasonably begin "- no issues seen" — and refuses it everywhere else. That
 * module keeps its own private key list; deriving the same answer from
 * `type === 'textarea'` avoids a second copy of the list. The two agree for
 * every field in the registry today, and a test asserts they still do, so a
 * new textarea field cannot quietly widen the exception.
 */
function allowsFormulaLikeText(field: FieldDef): boolean {
  return field.type === 'textarea';
}

function isBlank(value: unknown): boolean {
  // Zero is NOT blank (rule 8). Nor is `false`. Only absence and empty text.
  return value === null || value === undefined || value === '';
}

function validateNumber(
  field: FieldDef,
  raw: unknown,
  confirmed: ReadonlySet<string>,
  issues: ValidationIssue[],
): number | undefined {
  let value: number;
  if (typeof raw === 'number') {
    value = raw;
  } else if (typeof raw === 'string') {
    const text = raw.trim();
    // A lenient parse would accept "12abc" as 12 and "1e5" as 100000. Neither
    // is a measurement an operator meant to enter.
    if (!/^-?\d+(\.\d+)?$/.test(text)) {
      issues.push({
        field: field.key,
        code: 'not_a_number',
        message: `${field.label} must be a number. Received ${JSON.stringify(raw)}.`,
      });
      return undefined;
    }
    value = Number(text);
  } else {
    issues.push({
      field: field.key,
      code: 'not_a_number',
      message: `${field.label} must be a number.`,
    });
    return undefined;
  }

  if (!Number.isFinite(value)) {
    issues.push({
      field: field.key,
      code: 'not_finite',
      message: `${field.label} must be a finite number.`,
    });
    return undefined;
  }

  if (field.min !== undefined && value < field.min) {
    issues.push({
      field: field.key,
      code: 'below_minimum',
      message: `${field.label} cannot be less than ${field.min}${field.unit ? ` ${field.unit}` : ''}.`,
    });
  }
  if (field.max !== undefined && value > field.max) {
    issues.push({
      field: field.key,
      code: 'above_maximum',
      message: `${field.label} cannot be more than ${field.max}${field.unit ? ` ${field.unit}` : ''}.`,
    });
  }
  if (
    field.implausibleAbove !== undefined &&
    value > field.implausibleAbove &&
    !confirmed.has(field.key)
  ) {
    issues.push({
      field: field.key,
      code: 'implausible_unconfirmed',
      message: `${field.label} of ${value}${field.unit ? ` ${field.unit}` : ''} is much higher than usual. Check the reading, then confirm it to save.`,
    });
  }

  return value;
}

function validateText(field: FieldDef, raw: unknown, issues: ValidationIssue[]): string | undefined {
  if (typeof raw !== 'string') {
    issues.push({
      field: field.key,
      code: 'not_a_string',
      message: `${field.label} must be text.`,
    });
    return undefined;
  }
  if (raw.length > MAX_TEXT_LENGTH) {
    issues.push({
      field: field.key,
      code: 'too_long',
      message: `${field.label} is too long (maximum ${MAX_TEXT_LENGTH} characters).`,
    });
    return undefined;
  }
  if (!allowsFormulaLikeText(field) && looksLikeFormula(raw)) {
    issues.push({
      field: field.key,
      code: 'formula_like',
      message: `${field.label} cannot begin with = + - or @.`,
    });
    return undefined;
  }
  return raw;
}

/**
 * Validate a stage payload and, when it is clean, produce the operational row.
 *
 * Serialisation is part of validation on purpose: a payload that validates but
 * cannot be serialised would commit to the ledger and then dead-letter in the
 * outbox, which turns a correctable data-entry mistake into an administrator's
 * problem. So `toSheetRow` runs here, before the commit, and its refusal is a
 * validation failure.
 */
export function validateStagePayload(args: ValidateArgs): ValidationResult {
  const schema = STAGE_SCHEMAS[args.stage];
  const issues: ValidationIssue[] = [];
  const confirmed = new Set(args.confirmedImplausible ?? []);
  const byKey = new Map<string, FieldDef>(schema.fields.map((f) => [f.key, f]));
  const clean: Record<string, unknown> = {};

  // 1. Refuse anything not in the registry. An unknown key is either a client
  //    bug or an attempt to smuggle a value past the column mapping; either
  //    way, silently dropping it would hide the problem.
  for (const key of Object.keys(args.values)) {
    if (!byKey.has(key)) {
      issues.push({
        field: key,
        code: 'unknown_field',
        message: `"${key}" is not a field on the ${schema.title} form.`,
      });
    }
  }

  // 2. Per-field checks, in registry order so the error summary reads in the
  //    same order as the form.
  for (const field of schema.fields) {
    const raw = args.values[field.key];

    if (field.type === 'system') {
      // Column A is assigned by the server. A client-supplied sample ID is
      // never trusted, not even when it is correct.
      if (!isBlank(raw)) {
        issues.push({
          field: field.key,
          code: 'server_assigned',
          message: `${field.label} is assigned by the system and cannot be supplied.`,
        });
      }
      continue;
    }

    const applicable = isFieldApplicable(field, args.values);
    if (!applicable) {
      if (!isBlank(raw)) {
        issues.push({
          field: field.key,
          code: 'not_applicable',
          message: `${field.label} does not apply to the selected sampling point and must be left blank.`,
        });
      }
      continue;
    }

    if (isBlank(raw)) continue;

    switch (field.type) {
      case 'number': {
        const value = validateNumber(field, raw, confirmed, issues);
        if (value !== undefined) {
          // Keep the operator's own text so entered precision survives: "2.50"
          // states the instrument's resolution and must not become "2.5".
          clean[field.key] =
            typeof raw === 'string' ? { value, enteredText: raw.trim() } : value;
        }
        break;
      }
      case 'select':
      case 'yesno': {
        const code = typeof raw === 'string' ? raw : String(raw);
        const option = field.options?.find((o) => o.value === code);
        if (option === undefined) {
          const allowed = (field.options ?? []).map((o) => o.value).join(', ');
          issues.push({
            field: field.key,
            code: 'unknown_option',
            message: `${field.label} must be one of: ${allowed}.`,
          });
        } else {
          clean[field.key] = option.value;
        }
        break;
      }
      case 'date': {
        const text = validateText(field, raw, issues);
        if (text !== undefined) {
          if (!DATE_PATTERN.test(text)) {
            issues.push({
              field: field.key,
              code: 'bad_date',
              message: `${field.label} must be a date in YYYY-MM-DD form.`,
            });
          } else {
            clean[field.key] = text;
          }
        }
        break;
      }
      case 'time': {
        const text = validateText(field, raw, issues);
        if (text !== undefined) {
          if (!TIME_PATTERN.test(text)) {
            issues.push({
              field: field.key,
              code: 'bad_time',
              message: `${field.label} must be a time in HH:mm form, 24-hour.`,
            });
          } else {
            clean[field.key] = text;
          }
        }
        break;
      }
      case 'text':
      case 'textarea': {
        const text = validateText(field, raw, issues);
        if (text !== undefined) clean[field.key] = text;
        break;
      }
    }
  }

  // 3. Requiredness for this phase, evaluated against the CLEANED values so a
  //    conditional field is judged by the sampling point that actually passed
  //    validation, not by whatever the client claimed.
  for (const field of fieldsRequiredAt(args.stage, args.phase, clean)) {
    if (field.type === 'system') continue;
    if (isBlank(clean[field.key])) {
      issues.push({
        field: field.key,
        code: 'required',
        message: `${field.label} is required before this can be saved.`,
      });
    }
  }

  if (issues.length > 0) return { ok: false, issues };

  // 4. Final gate: the row must actually serialise. `toSheetRow` owns column
  //    order, width, enum-label translation and the formula refusal.
  let row: readonly string[];
  try {
    // The placeholder keeps column A's width honest without claiming an
    // identifier: the real id replaces it at enqueue time, after allocation.
    row = toSheetRow(args.stage, '', clean as SampleValues);
  } catch (error) {
    return {
      ok: false,
      issues: [
        {
          field: '_payload',
          code: 'serialisation_failed',
          message: error instanceof Error ? error.message : String(error),
        },
      ],
    };
  }

  return { ok: true, values: clean as SampleValues, row };
}

/**
 * Resolve the sample-ID prefix for a validated payload.
 *
 * Wrapped rather than re-implemented: `resolvePrefix` throws for an
 * unresolvable Ground sampling point, and an unhandled throw inside a request
 * handler would become a 500 for what is really a validation failure.
 */
export function prefixFor(
  stage: Stage,
  values: Readonly<Record<string, unknown>>,
): { readonly ok: true; readonly prefix: string } | { readonly ok: false; readonly issue: ValidationIssue } {
  try {
    return { ok: true, prefix: resolvePrefix(stage, values) };
  } catch (error) {
    return {
      ok: false,
      issue: {
        field: 'sampling_point',
        code: 'unknown_option',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}
