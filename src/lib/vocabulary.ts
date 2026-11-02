/**
 * The dropdown lists an administrator may change, resolved for one request.
 *
 * ===========================================================================
 * THE OPTION LIST IS THE VALIDATION CONTRACT, SO BOTH SIDES READ IT
 * ===========================================================================
 * A select in this system is not a convenience. `encodeEnum` refuses a code
 * it does not know, the server's `validateStagePayload` refuses one too, and
 * `assert_measurement_in_options` refuses one in SQL. That is three gates
 * agreeing, and they can only agree if they are looking at the same list.
 *
 * So a list that an administrator can edit has to be READ BY THE SERVER, not
 * only by the browser. A dropdown whose options came from a table the Edge
 * Function could not see would offer values the server then refused — the
 * operator would be told their own choice was invalid, which is the worst
 * possible way to fail.
 *
 * ===========================================================================
 * WHICH LISTS, AND WHY NOT THE OTHERS
 * ===========================================================================
 * Three: the feeds the mill makes, and the people who sample and test them.
 * They change when the product range or the payroll changes, which is not an
 * occasion for a deployment.
 *
 * The other four vocabularies in the database stay code-driven, and
 * `sampling_points` is the one worth stating out loud: its codes drive the
 * sample-ID PREFIX and the BC-only moisture rule, so a code an administrator
 * invented would have no prefix and no rule. `materials` and
 * `mill_screen_sizes` are small and physical; `suppliers` is free text on the
 * form. `FieldDef.optionsListKey` is the single place that records the
 * distinction, so this module never has to carry a list of exceptions.
 *
 * ===========================================================================
 * INACTIVE IS RETIRED
 * ===========================================================================
 * Every one of these three was FREE TEXT until 0036, so the database holds
 * values no operator should pick again. They live in the same table as
 * `active = false`: still legal, still encodable, shown on the record that
 * holds them and offered on no other. Retiring a value is therefore a toggle
 * on the admin screen, and `SelectOption.retired` is how the resolved list
 * carries that fact to the control that draws it.
 *
 * ===========================================================================
 * IT FAILS TO THE SHIPPED LIST, NEVER TO AN EMPTY ONE
 * ===========================================================================
 * `resolveOptions` falls back to the registry's own options when a list is
 * missing, unreadable or empty. That matters more than it looks: an empty
 * list would make a REQUIRED field impossible to fill, so a configuration
 * fault would stop the plant recording samples. The shipped list is the one
 * the application was tested against, so it is the right thing to fall back
 * to — exactly as `readSieveSeries` falls back to the built-in series.
 */

import type { FieldDef, SelectOption } from '../forms/types.ts';

/** The lists a form may take its options from. */
export const VOCABULARY_LIST_KEYS = ['feed_types', 'samplers', 'testers'] as const;
export type VocabularyListKey = (typeof VOCABULARY_LIST_KEYS)[number];

/** One row of one of those tables. */
export interface VocabularyEntry {
  readonly code: string;
  readonly label: string;
  readonly active: boolean;
  readonly sortOrder: number | null;
}

/**
 * The lists as they stand. Partial: a key that is absent means "not read",
 * which is not the same as "empty", and both fall back to the shipped list.
 */
export type VocabularyDocument = Readonly<Partial<Record<VocabularyListKey, readonly VocabularyEntry[]>>>;

export function isVocabularyListKey(value: string): value is VocabularyListKey {
  return (VOCABULARY_LIST_KEYS as readonly string[]).includes(value);
}

/**
 * Read rows into a document, dropping anything unusable rather than throwing.
 *
 * A malformed row is a configuration fault; refusing the whole request over
 * one would take the plant's record-keeping offline over a bad label. What it
 * must NOT do is silently produce an empty list for a field that needs one,
 * which is why `resolveOptions` treats empty as absent.
 */
export function parseVocabularyRows(
  rows: readonly {
    readonly code?: unknown;
    readonly label?: unknown;
    readonly active?: unknown;
    readonly sort_order?: unknown;
  }[],
): readonly VocabularyEntry[] {
  const out: VocabularyEntry[] = [];
  for (const row of rows) {
    const code = typeof row.code === 'string' ? row.code.trim() : '';
    if (code === '') continue;
    const label = typeof row.label === 'string' && row.label.trim() !== '' ? row.label.trim() : code;
    out.push({
      code,
      label,
      // A row with no `active` is treated as active: the column is NOT NULL
      // in every one of these tables, so an absent value means the read did
      // not ask for it rather than that the entry is retired.
      active: row.active === undefined || row.active === null ? true : row.active === true,
      sortOrder: typeof row.sort_order === 'number' ? row.sort_order : null,
    });
  }
  return out;
}

/** Sort key: the administrator's order, then the code, so it is stable. */
function inListOrder(a: VocabularyEntry, b: VocabularyEntry): number {
  const sa = a.sortOrder ?? Number.MAX_SAFE_INTEGER;
  const sb = b.sortOrder ?? Number.MAX_SAFE_INTEGER;
  if (sa !== sb) return sa - sb;
  return a.code.localeCompare(b.code);
}

/**
 * The options this field is validated, encoded and drawn against.
 *
 * PURE, and the single definition of that resolution: every gate calls this
 * rather than reaching for `field.options`, so the browser, the Edge
 * Function and the sheet encoder cannot be looking at different lists.
 */
export function resolveOptions(
  field: FieldDef,
  vocabulary: VocabularyDocument | null | undefined,
): readonly SelectOption[] {
  const shipped = field.options ?? [];
  const key = field.optionsListKey;
  if (key === undefined) return shipped;

  const entries = vocabulary?.[key];
  // Absent, unreadable or empty all mean the same thing here: there is no
  // administrator's list in force, so the shipped one applies. An empty list
  // on a required field would be a form nobody could submit.
  if (entries === undefined || entries.length === 0) return shipped;

  const resolved: SelectOption[] = [...entries]
    .sort(inListOrder)
    .map((entry) =>
      entry.active
        ? { value: entry.code, label: entry.label }
        : { value: entry.code, label: entry.label, retired: true },
    );

  /*
    Anything the SHIPPED list knows and the table does not is appended,
    retired.

    This is the safety net under an administrator deleting a row that records
    already hold — which the admin screen does not offer, but a direct
    database edit does. Without it, those records could not be written to the
    spreadsheet and would show an empty dropdown over a real answer.
  */
  const known = new Set(resolved.map((o) => o.value));
  for (const option of shipped) {
    if (!known.has(option.value)) resolved.push({ ...option, retired: true });
  }
  return resolved;
}

/**
 * The same field, carrying the list it is actually validated against.
 *
 * Used by the form so that every control — and every piece of code that
 * reads `field.options` downstream of it — sees the resolved list without a
 * second prop to thread and forget. A field whose list is code-driven is
 * returned unchanged, by identity, so this is free on the other 280 columns.
 */
export function withResolvedOptions(
  field: FieldDef,
  vocabulary: VocabularyDocument | null | undefined,
): FieldDef {
  if (field.optionsListKey === undefined) return field;
  return { ...field, options: resolveOptions(field, vocabulary) };
}
