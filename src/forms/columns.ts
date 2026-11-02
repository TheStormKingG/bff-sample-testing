/**
 * Spreadsheet column letters, and nothing else.
 *
 * Extracted from `sheetMapping.ts` so the REGISTRY can use it. The registry
 * generates runs of columns — fourteen sieve masses, nine computed results —
 * from a starting position rather than from a hand-typed list of letters, and
 * it cannot import `sheetMapping.ts` to do the arithmetic because that module
 * imports the registry. A third module with no imports of its own breaks the
 * cycle and leaves ONE implementation, which is the point: two copies of
 * base-26 arithmetic that disagree beyond Z would put a column's header in one
 * place and its value in another.
 *
 * No imports, so the Edge Function toolchain resolves it unchanged
 * (scripts/check-shared-module-imports.mjs).
 */

const COLUMN_PATTERN = /^[A-Z]+$/;

/** `'A'` -> 0, `'Z'` -> 25, `'AA'` -> 26. */
export function columnLetterToIndex(letter: string): number {
  if (!COLUMN_PATTERN.test(letter)) {
    throw new Error(
      `Invalid column reference ${JSON.stringify(letter)}: expected uppercase letters such as "A" or "AA"`,
    );
  }
  let index = 0;
  for (const char of letter) {
    index = index * 26 + (char.charCodeAt(0) - 64);
  }
  return index - 1;
}

/** 0 -> `'A'`, 25 -> `'Z'`, 26 -> `'AA'`. */
export function indexToColumnLetter(index: number): string {
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(`Invalid column index ${index}: expected a non-negative integer`);
  }
  let letter = '';
  let n = index + 1;
  while (n > 0) {
    const remainder = (n - 1) % 26;
    letter = String.fromCharCode(65 + remainder) + letter;
    n = Math.floor((n - 1) / 26);
  }
  return letter;
}
