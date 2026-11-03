/**
 * How red each urease reference dish is, sealed to the file it was read from.
 *
 * ===========================================================================
 * WHAT THIS IS AND WHAT IT IS NOT
 * ===========================================================================
 * Produced on 2026-11-02 by `scripts/measure-urease-dishes.py`, which is the
 * script the photograph-to-assessment mapping in `src/forms/registry.ts` was
 * DECIDED from. The four files arrived in the reverse of the order they
 * belong in, and nothing but a measurement would have caught that.
 *
 * It is not a measurement taken at test time. Decoding WebP needs an image
 * library this repository does not have and does not otherwise need, so the
 * measurement runs by hand and this file records the result beside the
 * SHA-256 of the exact bytes it came from.
 *
 * That makes `tests/qualitativeUrease.test.tsx` a SEAL rather than a
 * re-derivation, and the distinction is worth being honest about: the suite
 * cannot tell you that `under-cooked.webp` is redder than
 * `over-cooked.webp`. It can tell you that the file called
 * `under-cooked.webp` today is byte-for-byte the file that was measured at
 * 57.14% — so a photograph swapped, replaced or reordered fails loudly
 * instead of leaving stale evidence describing a file that is gone.
 *
 * Re-run the script and replace these lines whenever a dish photograph
 * changes. Do not edit a number here by hand: the hash is what stops that
 * being possible without being noticed.
 */

export interface UreaseDishEvidence {
  /** Path under `public/`, matching the gallery entry's `image`. */
  readonly image: string;
  readonly sha256: string;
  /** Share of the dish that is strongly red, as a percentage. */
  readonly redPercent: number;
}

/** In gallery order: over cooked to under cooked. */
export const UREASE_DISH_EVIDENCE: readonly UreaseDishEvidence[] = [
  { image: 'urease/over-cooked.webp', sha256: '1d884f9bb0cfcd5be5956caf8b38bd080d70c89cb09a30a5560570e4deaf0bf8', redPercent: 0.0121 },
  { image: 'urease/properly-cooked-slight.webp', sha256: '006ea9b667849de4c4a79fa7dbef058e6bee9501e389b5a80ed16e42f8e808d0', redPercent: 3.5403 },
  { image: 'urease/properly-cooked-moderate.webp', sha256: '674c95dae718961306c963fa56b9f7fa7f9bced667ed2ce00287fb67f4d7e9b8', redPercent: 6.9260 },
  { image: 'urease/under-cooked.webp', sha256: 'fc2b41b772fc0e78a22aae37325a43e0e0b24d7c050fbe46909ede475d1014e6', redPercent: 57.1380 },
];
