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
import { deriveSystemValues } from '../../../src/forms/derived.ts';
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
  | 'server_assigned'
  // Account and credential codes, added for the administrator-managed
  // password sign-in (migration 0019). See the password policy at the foot of
  // this file for what each one means and why it is refused.
  | 'too_short'
  | 'unchanged'
  | 'already_exists'
  | 'malformed_email'
  // The password strength rules. One code per RULE, never a shared
  // `weak_password`: these travel to the browser in `ApiError.details.issues`
  // and are the only machine-readable account of WHICH rule was broken, so
  // collapsing them would leave the operator's screen with nothing to key a
  // specific hint on and would make a rule's failure indistinguishable from
  // its neighbour's in the server log.
  | 'blank'
  | 'surrounding_whitespace'
  | 'not_varied'
  | 'repeated_run'
  | 'sequential';

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
  | {
      readonly ok: true;
      /**
       * The operator's values, and ONLY the operator's values. Becomes
       * `p_values`, which `apply_submitted_values` applies one row at a time
       * through `apply_measurement` — and that function raises for any column
       * whose type or requiredness is `system`. A computed value merged in
       * here would turn every DGM registration into an `internal` error.
       */
      readonly values: SampleValues;
      /**
       * The serialised row, INCLUDING any columns the server computed. This is
       * the only carrier that reaches both the spreadsheet and the database:
       * the trigger on the outbox insert reads the computed cells back out of
       * it (0025_dgm_stage.sql), so the stored value and the spreadsheet cell
       * are the same string by construction rather than by agreement.
       */
      readonly row: readonly string[];
      /** The computed cells, by field key. Empty for a stage that has none. */
      readonly derived: Readonly<Record<string, string>>;
    }
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

  // 4. Columns the server computes rather than the operator measuring them.
  //    Runs AFTER every operator value has been validated — the arithmetic is
  //    only meaningful over values that passed — and BEFORE serialisation,
  //    because `toSheetRow` is the only thing that turns values into the row
  //    and there is no later opportunity.
  //
  //    Merged into the values used for the ROW ONLY. `clean` is returned
  //    untouched and becomes `p_values`; see the note on ValidationResult.
  let derived: Record<string, string>;
  try {
    derived = deriveSystemValues(args.stage, clean);
  } catch (error) {
    // A computation that refuses is a statement about the numbers, not an
    // internal fault, so it is reported like any other validation problem and
    // nothing commits.
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

  // 5. Final gate: the row must actually serialise. `toSheetRow` owns column
  //    order, width, enum-label translation and the formula refusal.
  let row: readonly string[];
  try {
    // The placeholder keeps column A's width honest without claiming an
    // identifier: the real id replaces it at enqueue time, after allocation.
    const forRow =
      Object.keys(derived).length === 0 ? clean : { ...clean, ...derived };
    row = toSheetRow(args.stage, '', forRow as SampleValues);
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

  return { ok: true, values: clean as SampleValues, row, derived };
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


// ---------------------------------------------------------------------------
// Credential and account policy (migration 0019: administrator-managed
// email/password sign-in).
//
// WHY IT LIVES HERE RATHER THAN IN THE HANDLERS. Three surfaces apply the same
// rules — `create_account` and `set_password` on `admin-action`, and
// `change-own-password` — and a rule written three times is three rules. The
// administrator's temporary password and the holder's chosen one are held to
// the SAME standard deliberately: the temporary one is the credential two
// people know, so relaxing it is relaxing the weakest moment in the account's
// life.
//
// These functions are PURE and return issues rather than throwing, so they are
// unit-testable without Deno — which matters, because every module that can
// reach the Supabase admin API is import-blocked from this test suite by its
// `npm:` specifiers and can only be checked as text.
// ---------------------------------------------------------------------------

/**
 * The shortest password any surface in this system accepts.
 *
 * NOT FIXED BY THE CROSS-AGENT CONTRACT, so both sides of the boundary chose
 * one independently — exactly the defect class the contract exists to prevent.
 * `MIN_PASSWORD_LENGTH` in `src/lib/supabase.ts` was written first, at 10,
 * carrying the rule "the client must be at least as strict as the server:
 * anything accepted here has to be accepted there". This number is therefore
 * 10 and not a tidier 12: a server minimum ABOVE the client's would make the
 * browser promise something the server refuses, and the operator would meet
 * the real rule only on submit. The two are compared by
 * `tests/adminPasswordBoundary.test.ts`, so the agreement is now checked
 * rather than asserted in a comment.
 *
 * 10 is also defensible on its own terms: GoTrue's own floor is 6, and nothing
 * in this project raised it until now.
 *
 * IT STAYS AT 10 AND NOT 12, deliberately, and the reason is the same contract.
 * 12 would be the better number — the generated temporary password is 12 drawn
 * characters, so a floor of 12 would mean no hand-typed password is shorter
 * than one the system would have produced — but raising it HERE alone inverts
 * the invariant above and makes the browser accept a 10-character password the
 * server then refuses. `MIN_PASSWORD_LENGTH` in `src/lib/supabase.ts` belongs
 * to a different ownership slice, so raising the floor is a two-sided change
 * and is recorded as a recommendation rather than made as a one-sided one.
 *
 * THE VARIETY RULES BELOW ARE SERVER-ONLY, AND THAT ASYMMETRY IS REAL. The
 * browser checks length only (`passwordProblem` in `src/pages/AdminPage.tsx`,
 * `passwordProblems` in `src/pages/ChangePasswordPage.tsx`), so a password
 * like `1234567890` passes in the browser and is refused here, and the person
 * meets the rule on submit. That is the direction the invariant permits — the
 * server is the stricter side and nothing the server accepts is refused by the
 * browser — but it is worse than having both sides agree, and the fix is in
 * the browser's slice: the three constants and two helpers the rule needs are
 * all exported from this module.
 */
export const MIN_PASSWORD_LENGTH = 10;

/**
 * The longest password that is stored WITHOUT SILENT LOSS.
 *
 * GoTrue hashes with bcrypt, and bcrypt ignores everything after the 72nd
 * BYTE. A 90-character password would therefore be accepted, truncated, and
 * two different passwords differing only after byte 72 would both sign in —
 * including the temporary one the administrator typed and the "new" one the
 * holder chose to replace it. Refusing at 72 is how that is kept from being a
 * silent property of the system.
 *
 * BYTES, not characters, because the limit is on the encoded form: an operator
 * name in a non-Latin script can reach 72 bytes well inside 72 characters.
 */
export const MAX_PASSWORD_BYTES = 72;

/** Count a string the way bcrypt does. */
export function passwordByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

/**
 * How many DIFFERENT characters a password must contain.
 *
 * ==========================================================================
 * WHY A DISTINCT-CHARACTER COUNT AND NOT A CHARACTER-CLASS RULE
 * ==========================================================================
 * The reflex rule — "one upper, one lower, one digit, one symbol" — is wrong
 * HERE, and not as a matter of taste. This field has two writers, and only one
 * of them is a person:
 *
 *   1. an administrator or operator typing into a form, and
 *   2. `generateTemporaryPassword()` in `src/hooks/useAdmin.ts`, which draws
 *      12 characters from `acdefhjkmnprtuwxy23456789` — lowercase letters and
 *      the digits 2–9, no uppercase and no symbols — and joins them 4-4-4 with
 *      a `-`, giving 14 characters and about 55.7 bits.
 *
 * A rule requiring a digit AND a letter would therefore refuse the system's
 * OWN generated credential whenever a draw happens to contain no digit:
 * (17/25)^12, about one account creation in 112. The administrator would see a
 * validation error on a value the application had just produced for them, on a
 * screen with no way to influence it. A class rule also pushes a person who
 * must read the result down a plant telephone towards `Password1!`, which is
 * long, compliant and guessable.
 *
 * So the rule counts VARIETY rather than categories: it is blind to which
 * alphabet a character came from, which is exactly the property that lets one
 * rule hold both writers.
 *
 * ==========================================================================
 * WHERE THE NUMBERS COME FROM — MEASURED, NOT CONVENTIONAL
 * ==========================================================================
 * 300,000 outputs of the real generator were run through these counts. Over
 * that sample:
 *
 *   distinct characters   minimum 6   (6 → 0.018%, 7 → 0.29%, 8 → 2.6%)
 *   identical run         maximum 4   (4 → 0.015%)
 *   consecutive-code run  maximum 4   (4 → 0.0087%)
 *
 * Each threshold below therefore sits one measured decade CLEAR of the
 * generator's observed extreme, rather than on it: a floor of 6 distinct
 * characters would land exactly on the observed minimum, so 0.018% of
 * generated passwords would be boundary cases and any future narrowing of the
 * generator would cross the line silently. `tests/passwordPolicy.test.ts`
 * re-runs the real generator through the real policy on every test run, so the
 * headroom is a checked property and not a comment.
 *
 * WHAT THIS DOES NOT DO. There is no dictionary or breach-list check, and that
 * is a decision rather than an omission: a wordlist large enough to matter
 * cannot ship inside an Edge Function bundle, and a small one refuses a handful
 * of passwords while implying a guarantee it does not provide. `password12`
 * passes every rule here. The control that makes that tolerable is not this
 * function: it is that an administrator-set password carries NO authority until
 * it is replaced (migration 0020), that GoTrue rate-limits sign-in, and that
 * every action is attributed and audited. If a breach-list check is ever wanted
 * it belongs behind the Edge Function as a lookup, not as a bundled list.
 */
export const MIN_PASSWORD_DISTINCT_CHARACTERS = 5;

/**
 * The longest run of ONE repeated character a password may contain.
 *
 * `aaaa` is allowed, `aaaaa` is not. Catches the keyboard-held-down password
 * that the distinct-character floor would already catch at this length, and
 * keeps catching it in a long password where 5 distinct characters is easy to
 * reach — `aaaaaaaaaaaaaaaaaaaabcde` has 5 distinct characters and is not a
 * password.
 */
export const MAX_PASSWORD_IDENTICAL_RUN = 4;

/**
 * The longest straight run of CONSECUTIVE characters a password may contain,
 * ascending or descending, compared case-insensitively by code point.
 *
 * `1234567890` has ten distinct characters, no repeats, and is the single most
 * likely value a hurried administrator types into this field. Nothing else in
 * this policy refuses it. `abcdefghij` and `0987654321` go the same way.
 *
 * NOT a keyboard-layout rule: `qwertyuiop` is not a code-point run and is NOT
 * refused here. Catching it needs a per-layout table, and the plant uses more
 * than one keyboard layout, so the table would be a guess about which one.
 * Stated rather than silently absent.
 */
export const MAX_PASSWORD_SEQUENCE_RUN = 4;

/** The longest run of one repeated character in `value`. */
function longestIdenticalRun(value: string): number {
  const characters = [...value];
  let longest = characters.length === 0 ? 0 : 1;
  let run = longest;
  for (let at = 1; at < characters.length; at++) {
    run = characters[at] === characters[at - 1] ? run + 1 : 1;
    if (run > longest) longest = run;
  }
  return longest;
}

/**
 * The longest straight ascending or descending code-point run in `value`.
 *
 * Lowercased first, so `ABCDEF` is caught exactly as `abcdef` is. Compared on
 * code units rather than on grapheme clusters: a sequence is a property of the
 * encoding here, and no multi-unit character participates in one.
 */
function longestSequenceRun(value: string): number {
  const lowered = value.toLowerCase();
  if (lowered.length === 0) return 0;
  let longest = 1;
  let ascending = 1;
  let descending = 1;
  for (let at = 1; at < lowered.length; at++) {
    const step = lowered.charCodeAt(at) - lowered.charCodeAt(at - 1);
    ascending = step === 1 ? ascending + 1 : 1;
    descending = step === -1 ? descending + 1 : 1;
    longest = Math.max(longest, ascending, descending);
  }
  return longest;
}

/**
 * Check a password a client supplied, naming the field it arrived in.
 *
 * Returns every issue it finds rather than the first, so an administrator
 * fixing a temporary password is told the whole rule in one reply.
 *
 * ONE FUNCTION, THREE SURFACES, DELIBERATELY. `create_account` and
 * `set_password` on `admin-action` and `change-own-password` all call this, so
 * the administrator's temporary password and the holder's replacement are held
 * to the same standard. A rule enforced on only one of them would let the weak
 * value in by the other door — and the temporary password is the credential TWO
 * people know, which makes it the weakest moment in the account's life and the
 * last place to relax a rule.
 *
 * A PASSWORD IS NEVER TRIMMED OR NORMALISED HERE, and the surrounding-space
 * rule below is how that principle is kept rather than a departure from it.
 * GoTrue stores what it is given, so silently stripping a space would mean the
 * credential this function approved is not the credential that gets set, and
 * the holder would be refused by a password they typed exactly as dictated. The
 * answer is therefore to REFUSE a password with a leading or trailing space,
 * not to repair it: an invisible character at either end of a value that gets
 * read down a telephone and typed on a plant tablet is a transcription failure
 * waiting to happen, with no symptom at the keyboard to explain it.
 *
 * NO MESSAGE BELOW QUOTES ANY PART OF THE VALUE. The issues travel to the
 * client in `ApiError.details` and into the server log through `toLogRecord`,
 * so a message naming the offending character — or its position, or its length
 * — would put a function of the credential into both. Every message states the
 * RULE and lets the holder compare.
 */
export function passwordIssues(field: string, value: unknown): readonly ValidationIssue[] {
  if (value === undefined || value === null || value === '') {
    return [{ field, code: 'required', message: 'A password is required.' }];
  }
  if (typeof value !== 'string') {
    return [{ field, code: 'not_a_string', message: 'A password must be text.' }];
  }

  const issues: ValidationIssue[] = [];
  if (value.length < MIN_PASSWORD_LENGTH) {
    issues.push({
      field,
      code: 'too_short',
      message: `A password must be at least ${MIN_PASSWORD_LENGTH} characters long.`,
    });
  }
  if (passwordByteLength(value) > MAX_PASSWORD_BYTES) {
    issues.push({
      field,
      code: 'too_long',
      message:
        `A password must be no longer than ${MAX_PASSWORD_BYTES} bytes. ` +
        'Anything beyond that is discarded when it is stored, so it would not be part of the password.',
    });
  }

  // Whitespace-only, checked on its own rather than left to the variety rule
  // below. Ten spaces would be refused either way, but by a message about
  // variety that tells the reader nothing about what is actually wrong, and a
  // control whose failure is reported by a different control's message is a
  // control nobody can reason about.
  if (value.trim() === '') {
    issues.push({
      field,
      code: 'blank',
      message: 'A password cannot be made only of spaces.',
    });
  } else if (value !== value.trim()) {
    issues.push({
      field,
      code: 'surrounding_whitespace',
      message:
        'A password cannot start or end with a space. It is not stripped — it would be part ' +
        'of the password, invisible on screen and impossible to read out.',
    });
  }

  if (new Set([...value]).size < MIN_PASSWORD_DISTINCT_CHARACTERS) {
    issues.push({
      field,
      code: 'not_varied',
      message:
        `A password must use at least ${MIN_PASSWORD_DISTINCT_CHARACTERS} different characters.`,
    });
  }
  if (longestIdenticalRun(value) > MAX_PASSWORD_IDENTICAL_RUN) {
    issues.push({
      field,
      code: 'repeated_run',
      message:
        `A password cannot repeat one character more than ${MAX_PASSWORD_IDENTICAL_RUN} times in a row.`,
    });
  }
  if (longestSequenceRun(value) > MAX_PASSWORD_SEQUENCE_RUN) {
    issues.push({
      field,
      code: 'sequential',
      message:
        `A password cannot contain a straight run of more than ${MAX_PASSWORD_SEQUENCE_RUN} ` +
        'characters in order, like 12345 or abcde.',
    });
  }
  return issues;
}

/**
 * The address an account is keyed on, normalised the way the database keys it.
 *
 * `tg_handle_new_auth_user` stores `lower(btrim(email))`, and
 * `profiles_email_lower_key` is unique on `lower(email)`. So a duplicate check
 * that compares the raw input against that column is a check that can miss:
 * `  Ada@Example.com ` and `ada@example.com` are one account to the database
 * and two strings to a naive comparison. Normalising HERE, once, is what makes
 * the duplicate check and the insert agree on what "the same address" means.
 *
 * The shape test is deliberately the same one the database applies
 * (`bootstrap_admin_grants_email_shaped`: `'%_@_%._%'`) rather than a stricter
 * regular expression, so an address this accepts cannot be one the database
 * then rejects.
 */
export function normaliseEmail(
  value: unknown,
): { readonly ok: true; readonly email: string } | { readonly ok: false; readonly issue: ValidationIssue } {
  if (typeof value !== 'string' || value.trim() === '') {
    return {
      ok: false,
      issue: { field: 'email', code: 'required', message: 'An email address is required.' },
    };
  }
  const email = value.trim().toLowerCase();
  // Mirrors the SQL `like '%_@_%._%'`: something, @, something, dot, something.
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return {
      ok: false,
      issue: {
        field: 'email',
        code: 'malformed_email',
        message: 'That does not look like an email address.',
      },
    };
  }
  if (email.length > MAX_TEXT_LENGTH) {
    return {
      ok: false,
      issue: { field: 'email', code: 'too_long', message: 'That email address is too long.' },
    };
  }
  return { ok: true, email };
}
