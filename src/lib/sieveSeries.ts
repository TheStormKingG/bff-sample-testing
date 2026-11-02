/**
 * The lab's own sieve table, as an administrator may correct it.
 *
 * ===========================================================================
 * WHAT IS EDITABLE, AND WHAT IS NOT
 * ===========================================================================
 * Three things per position: the ABNT designation, the aperture in
 * micrometres, and what the sieve weighs empty.
 *
 * Three things are NOT, and they are the three that make the arithmetic mean
 * what it means. `kj` is assigned by POSITION in the stack, `uiGroup` follows
 * the three SUM ranges the source workbook uses, and which position is the
 * pan is a fact about the equipment. `src/lib/dgm.ts` holds all three and
 * this module never touches them: an override changes the TABLE, never the
 * method.
 *
 * ===========================================================================
 * WHAT CHANGING AN APERTURE ACTUALLY MOVES — SAY THIS OUT LOUD
 * ===========================================================================
 * TWO of the nine computed figures follow an edit, and they are not the two
 * anybody guesses. `tests/sieveSeries.test.ts` pins this, and it corrected
 * this comment twice before it was right:
 *
 *   MOVES  — the geometric standard deviation and the DPG legacy index, both
 *            built on the per-bin geometric means, which are taken between
 *            each aperture and the one above it.
 *   STANDS — DGM, the fineness module and the three uniformity bands. `kj` is
 *            assigned by POSITION in the stack, the fineness module is the
 *            kj-weighted total, and DGM is `104.14 × 2 ** finenessModule`.
 *            None of them reads an aperture at all.
 *
 * That is not a bug to be fixed here; it is what the two families of figure
 * are. But an administrator who changes an aperture and watches DGM stand
 * still deserves to have been told in advance, which is why the admin screen
 * says it and why this comment exists.
 *
 * THE WORKBOOK'S COLUMN HEADINGS DO NOT MOVE EITHER. "ABNT 5 empty sieve (g)"
 * is the row-4 heading on four tabs, `verifyWorkbook()` compares it character
 * for character before any write, and it is authored in the registry rather
 * than derived from this table. A changed designation therefore shows on the
 * screen and in this table while the spreadsheet keeps the heading it was
 * created with. That divergence has to be closed by hand; the admin screen
 * names the headings to change.
 *
 * ===========================================================================
 * IT FAILS CLOSED, AND WHOLE
 * ===========================================================================
 * A stored value that cannot be read, or that breaks a rule below, yields the
 * DEFAULT series and a reason — never a half-applied table. Half of an
 * overridden stack would compute a figure from one lab's apertures and
 * another's tares and present it as a measurement.
 */

import {
  DEFAULT_SIEVE_PRESET,
  type SievePosition,
  type SievePreset,
} from './dgm.ts';

/** One row of the editable table. */
export interface SieveSeriesOverride {
  readonly abnt: string;
  readonly apertureMicrons: number;
  readonly tareDefaultGrams: number;
}

export interface SieveSeriesDocument {
  readonly version: 1;
  readonly positions: readonly SieveSeriesOverride[];
}

/** The `system_config` key this table is stored under. */
export const SIEVE_SERIES_CONFIG_KEY = 'sieve_series';

/** How many positions the stack has. Fixed by the method, not by the table. */
export const SIEVE_POSITION_COUNT = DEFAULT_SIEVE_PRESET.positions.length;

/**
 * The same typo guard the mass fields carry. A sieve plus nothing is a few
 * hundred grams; beyond two kilograms is a mis-keyed decimal point.
 */
const MAX_TARE_GRAMS = 2000;
const MAX_ABNT_LENGTH = 12;

export type SieveSeriesParse =
  | { readonly ok: true; readonly document: SieveSeriesDocument }
  | { readonly ok: false; readonly reason: string };

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Read a stored table, refusing anything that would change what a figure
 * means without saying so.
 */
export function parseSieveSeries(raw: unknown): SieveSeriesParse {
  let data: unknown = raw;
  if (typeof raw === 'string') {
    if (raw.trim() === '') return { ok: false, reason: 'The stored sieve table is empty.' };
    try {
      data = JSON.parse(raw);
    } catch {
      return { ok: false, reason: 'The stored sieve table is not readable JSON.' };
    }
  }
  if (typeof data !== 'object' || data === null) {
    return { ok: false, reason: 'The stored sieve table is not an object.' };
  }
  const doc = data as Record<string, unknown>;
  if (doc['version'] !== 1) {
    return { ok: false, reason: `Unsupported sieve table version ${String(doc['version'])}.` };
  }
  const positions = doc['positions'];
  if (!Array.isArray(positions) || positions.length !== SIEVE_POSITION_COUNT) {
    return {
      ok: false,
      // The count is fixed by the method: `kj` runs 6..0 by position and the
      // uniformity bands are three fixed SUM ranges over seven sieves.
      reason: `The sieve table must have exactly ${SIEVE_POSITION_COUNT} positions.`,
    };
  }

  const out: SieveSeriesOverride[] = [];
  for (let i = 0; i < positions.length; i++) {
    const entry = positions[i] as Record<string, unknown> | null;
    const at = `Position ${i + 1}`;
    if (typeof entry !== 'object' || entry === null) {
      return { ok: false, reason: `${at} is not an object.` };
    }
    const abnt = entry['abnt'];
    if (typeof abnt !== 'string' || abnt.trim() === '') {
      return { ok: false, reason: `${at} has no ABNT designation.` };
    }
    if (abnt.trim().length > MAX_ABNT_LENGTH) {
      return { ok: false, reason: `${at}'s ABNT designation is longer than ${MAX_ABNT_LENGTH} characters.` };
    }
    const aperture = entry['apertureMicrons'];
    if (!isFiniteNumber(aperture) || aperture <= 0) {
      return { ok: false, reason: `${at} has no usable aperture in µm.` };
    }
    const tare = entry['tareDefaultGrams'];
    if (!isFiniteNumber(tare) || tare < 0) {
      return { ok: false, reason: `${at} has no usable empty weight.` };
    }
    if (tare > MAX_TARE_GRAMS) {
      return { ok: false, reason: `${at}'s empty weight is above ${MAX_TARE_GRAMS} g, which is a mis-keyed decimal point.` };
    }
    out.push({ abnt: abnt.trim(), apertureMicrons: aperture, tareDefaultGrams: tare });
  }

  /*
    STRICTLY DESCENDING, and this is the rule that protects the arithmetic
    rather than the data entry. `computeDgm` takes each bin's geometric mean
    between its own aperture and the one above it. A series that does not fall
    coarse-to-fine produces a bin whose "mean diameter" lies outside the bin,
    and every figure built on it — DGM, the uniformity bands, the GSD — would
    be a number with no meaning, returned without complaint.
  */
  for (let i = 1; i < out.length; i++) {
    if (out[i]!.apertureMicrons >= out[i - 1]!.apertureMicrons) {
      return {
        ok: false,
        reason:
          `Position ${i + 1} (${out[i]!.apertureMicrons} µm) is not finer than position ${i} ` +
          `(${out[i - 1]!.apertureMicrons} µm). A sieve stack runs coarsest at the top.`,
      };
    }
  }

  return { ok: true, document: { version: 1, positions: out } };
}

/** The current table as a document, for seeding an editor or a config row. */
export function defaultSieveSeriesDocument(): SieveSeriesDocument {
  return {
    version: 1,
    positions: DEFAULT_SIEVE_PRESET.positions.map((p) => ({
      abnt: p.abnt,
      apertureMicrons: p.apertureMicrons,
      tareDefaultGrams: p.tareDefaultGrams,
    })),
  };
}

/**
 * The preset to compute with: the method's own structure, carrying the lab's
 * table. Positional — `kj`, `uiGroup` and `isPan` come from the preset at the
 * same index and are never read from the override.
 */
export function applySieveSeries(
  preset: SievePreset,
  document: SieveSeriesDocument | null,
): SievePreset {
  if (document === null) return preset;
  if (document.positions.length !== preset.positions.length) return preset;
  const positions: SievePosition[] = preset.positions.map((position, i) => {
    const override = document.positions[i]!;
    return {
      ...position,
      abnt: override.abnt,
      apertureMicrons: override.apertureMicrons,
      tareDefaultGrams: override.tareDefaultGrams,
    };
  });
  return { ...preset, positions };
}

/**
 * The row-4 headings that would no longer describe the stack after this edit.
 *
 * Shown to the administrator BEFORE they save, because the workbook keeps the
 * headings it was created with and `verifyWorkbook()` compares them character
 * for character. Nothing breaks — the headings are labels and the column
 * identity is its position — but a spreadsheet that says ABNT 5 while the lab
 * uses ABNT 6 is a divergence somebody has to close by hand.
 */
export function renamedPositions(
  before: SieveSeriesDocument,
  after: SieveSeriesDocument,
): readonly { readonly position: number; readonly from: string; readonly to: string }[] {
  const out: { position: number; from: string; to: string }[] = [];
  for (let i = 0; i < Math.min(before.positions.length, after.positions.length); i++) {
    const was = before.positions[i]!.abnt;
    const now = after.positions[i]!.abnt;
    if (was !== now) out.push({ position: i + 1, from: was, to: now });
  }
  return out;
}
