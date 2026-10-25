/**
 * Payload and row hashing.
 *
 * Two distinct hashes, deliberately not interchangeable:
 *
 *  - `payloadHash(x)` hashes a REQUEST, and backs the idempotency contract:
 *    same key + same payload replays the stored result, same key + different
 *    payload is a conflict (PRD §10.3, Master Prompt §10).
 *
 *  - `rowHash(cells)` hashes a SHEET ROW as 19/15/13/11/16 strings, and backs
 *    idempotent projection: after an unknown outcome the worker re-reads the
 *    row and compares it against what it meant to write, so a Google timeout
 *    that actually succeeded resolves to a no-op instead of a second row
 *    (Master Prompt §7).
 *
 * Both are prefixed with the algorithm so a future change is a visible,
 * migratable value rather than a silent re-interpretation of stored digests.
 *
 * PURE: no Deno, no npm/jsr, no I/O.
 */

import { canonicalise } from './canonical.ts';
import { sha256Hex } from './sha256.ts';

export const HASH_PREFIX = 'sha256:';

/** Digest of a request payload. Stored in `idempotency_requests.payload_hash`. */
export function payloadHash(payload: unknown): string {
  return HASH_PREFIX + sha256Hex(canonicalise(payload));
}

/**
 * Normalise a sheet row to exactly `width` cells.
 *
 * The Sheets API truncates trailing empty cells on read, so a row written as
 * 19 cells ending in three blanks comes back as 16. Comparing the raw arrays
 * would report a difference that does not exist and trigger a pointless
 * rewrite on every single pass. Only TRAILING absence is normalised: an
 * interior blank is real data ("not measured") and is preserved, because
 * rule 8 forbids conflating blank with zero.
 */
export function normaliseRow(
  cells: readonly (string | null | undefined)[],
  width: number,
): string[] {
  if (!Number.isInteger(width) || width <= 0) {
    throw new Error(`Row width must be a positive integer, received ${width}`);
  }
  const out: string[] = [];
  for (let i = 0; i < width; i++) {
    out.push(cells[i] ?? '');
  }
  return out;
}

/** Digest of an operational row, normalised to the stage's column count. */
export function rowHash(
  cells: readonly (string | null | undefined)[],
  width: number,
): string {
  return HASH_PREFIX + sha256Hex(canonicalise(normaliseRow(cells, width)));
}

/**
 * Do these two rows carry the same operational content?
 *
 * Compared cell by cell after width normalisation rather than by digest, so a
 * caller that wants to show the operator WHICH column drifted can use
 * `rowDifferences` without recomputing anything.
 */
export function rowsEqual(
  a: readonly (string | null | undefined)[],
  b: readonly (string | null | undefined)[],
  width: number,
): boolean {
  const left = normaliseRow(a, width);
  const right = normaliseRow(b, width);
  for (let i = 0; i < width; i++) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}

export interface CellDifference {
  readonly index: number;
  readonly expected: string;
  readonly actual: string;
}

/** Every differing column, for a drift report an administrator can read. */
export function rowDifferences(
  expected: readonly (string | null | undefined)[],
  actual: readonly (string | null | undefined)[],
  width: number,
): CellDifference[] {
  const left = normaliseRow(expected, width);
  const right = normaliseRow(actual, width);
  const diffs: CellDifference[] = [];
  for (let i = 0; i < width; i++) {
    if (left[i] !== right[i]) {
      diffs.push({ index: i, expected: left[i]!, actual: right[i]! });
    }
  }
  return diffs;
}
