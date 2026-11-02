/**
 * The DGM range the lab is aiming at, per form, as an administrator sets it.
 *
 * ===========================================================================
 * THIS IS THE FIRST LIMIT IN THE APPLICATION. READ THIS BEFORE EXTENDING IT.
 * ===========================================================================
 * Everything else in this system reports and refuses to judge. `Limits` in the
 * workbook holds 34 figures and not one of them is approved, so
 * `DerivedResultsTable` carries "no pass, no fail, no colour, no chip" in its
 * own header and `ParticleSizeChart` carried "there is no band to shade".
 * That was correct while nobody had set a target.
 *
 * A target has now been set, deliberately, by the owner of the system, and
 * these are the three properties that keep it honest:
 *
 *   1. IT IS STORED, NOT COMPILED. The figures live in `system_config` and are
 *      written only by `rpc_set_dgm_target_ranges` under `user.manage`, which
 *      audits the whole document before and after. "What was the target when
 *      that sample was tested" is answerable from the trail. A number hidden
 *      in a source file would have had no such answer — see
 *      migration 0034's header for why that mattered enough to build an RPC.
 *
 *   2. IT IS A TARGET, NOT A DISPOSITION. Nothing here releases, rejects,
 *      holds or flags a sample. It shades a region of a chart and orders
 *      three numbers on a card. The words on screen say "target range", never
 *      "pass", and the sample's own figure keeps the informational blue it has
 *      always had rather than turning red when it falls outside — because the
 *      grind being coarse is information for the miller, not a verdict on the
 *      feed.
 *
 *   3. A STAGE WITH NO RANGE SHOWS NO BAND. `ranges` is partial on purpose.
 *      The published guidance this was seeded from covers the grind before
 *      pelleting and mash feed; it gives no geometric-mean target for a
 *      finished crumble or pellet, which the literature defines by sieve cut
 *      instead. Those two ship unset, and the screen asks for a figure rather
 *      than inventing one that would appear as a green acceptance band on a
 *      quality record.
 *
 * ===========================================================================
 * IT CHANGES NO STORED FIGURE
 * ===========================================================================
 * Nothing in this module is an input to `computeDgm` or to anything the
 * server writes. No Edge Function reads it. Changing a range re-colours the
 * screen and nothing else, which is why — unlike the sieve table — there is
 * no server-side reader and no risk of the browser and the server computing
 * from different documents.
 */

import { STAGE_SCHEMAS } from '../forms/registry.ts';
import { STAGES, type Stage } from '../forms/types.ts';

/** One form's target, in micrometres. */
export interface DgmTargetRange {
  readonly lowerMicrons: number;
  readonly upperMicrons: number;
  /**
   * Where the two figures came from, in the administrator's own words. Shown
   * beside them on the results screen, because a target with no stated origin
   * is an assertion the reader cannot check.
   */
  readonly basis: string;
}

export interface DgmTargetDocument {
  readonly version: 1;
  /**
   * Partial BY DESIGN. A stage missing from this map has no target, and the
   * screens show the DGM exactly as they did before this feature existed.
   */
  readonly ranges: Readonly<Partial<Record<Stage, DgmTargetRange>>>;
}

/** The `system_config` key this document is stored under. */
export const DGM_TARGETS_CONFIG_KEY = 'dgm_target_ranges';

/**
 * The stages a target may be set for: the five that carry a sieve stack and
 * therefore produce a DGM at all.
 *
 * Derived rather than typed out, so a sixth sieve tab cannot be added to the
 * registry and silently be ineligible for a target. `sieve1_tare_g` is the
 * marker because it is the first column of the stack on every tab that has
 * one.
 */
export const DGM_TARGET_STAGES: readonly Stage[] = STAGES.filter((stage) =>
  STAGE_SCHEMAS[stage].fields.some((field) => field.key === 'sieve1_tare_g'),
);

/**
 * A micrometre figure beyond which a target is a mis-keyed decimal point.
 * The coarsest sieve in service is 4000 µm; 20 mm is five times the top of
 * the stack and nothing a grind could be measured against.
 */
const MAX_MICRONS = 20000;
const MAX_BASIS_LENGTH = 300;

export type DgmTargetParse =
  | { readonly ok: true; readonly document: DgmTargetDocument }
  | { readonly ok: false; readonly reason: string };

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isStage(value: string): value is Stage {
  return (STAGES as readonly string[]).includes(value);
}

/**
 * Read a stored document, refusing anything that would paint a band nobody
 * could defend.
 *
 * Like `parseSieveSeries`, this is whole-or-nothing: half a document would
 * leave one form showing a target and another showing none for no reason a
 * reader could see.
 */
export function parseDgmTargets(raw: unknown): DgmTargetParse {
  let data: unknown = raw;
  if (typeof raw === 'string') {
    if (raw.trim() === '') return { ok: false, reason: 'The stored DGM targets are empty.' };
    try {
      data = JSON.parse(raw);
    } catch {
      return { ok: false, reason: 'The stored DGM targets are not readable JSON.' };
    }
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return { ok: false, reason: 'The stored DGM targets are not an object.' };
  }
  const doc = data as Record<string, unknown>;
  if (doc['version'] !== 1) {
    return { ok: false, reason: `Unsupported DGM target version ${String(doc['version'])}.` };
  }
  const ranges = doc['ranges'];
  if (typeof ranges !== 'object' || ranges === null || Array.isArray(ranges)) {
    return { ok: false, reason: 'The stored DGM targets need a ranges object.' };
  }

  const out: Partial<Record<Stage, DgmTargetRange>> = {};
  for (const [key, value] of Object.entries(ranges as Record<string, unknown>)) {
    if (!isStage(key)) {
      return { ok: false, reason: `"${key}" is not a form in this system.` };
    }
    // A target on a form with no sieve stack would never be drawn, so it is
    // refused rather than stored: a setting that has no effect is worse than
    // no setting, because somebody will set it and believe it is in force.
    if (!DGM_TARGET_STAGES.includes(key)) {
      return { ok: false, reason: `The ${key} form has no sieve test, so it produces no DGM.` };
    }
    if (value === null || value === undefined) continue;
    if (typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, reason: `The target for ${key} is not an object.` };
    }
    const entry = value as Record<string, unknown>;
    const lower = entry['lowerMicrons'];
    const upper = entry['upperMicrons'];
    if (!isFiniteNumber(lower) || lower <= 0) {
      return { ok: false, reason: `The target for ${key} has no usable lower figure in µm.` };
    }
    if (!isFiniteNumber(upper) || upper <= 0) {
      return { ok: false, reason: `The target for ${key} has no usable upper figure in µm.` };
    }
    /*
      STRICTLY INCREASING, and the error says which way round they go. An
      inverted pair would not fail — it would silently shade a band of zero
      width and report every sample as outside it, which looks like a result.
    */
    if (upper <= lower) {
      return {
        ok: false,
        reason:
          `The target for ${key} has its upper figure (${upper} µm) at or below its lower ` +
          `figure (${lower} µm). The lower figure is the finer grind.`,
      };
    }
    if (upper > MAX_MICRONS) {
      return {
        ok: false,
        reason: `The target for ${key} is above ${MAX_MICRONS} µm, which is a mis-keyed decimal point.`,
      };
    }
    const basis = entry['basis'];
    if (typeof basis !== 'string' || basis.trim() === '') {
      return {
        ok: false,
        // Enforced rather than encouraged: the screen prints this next to the
        // figures, and a target shown with no origin invites a reader to take
        // it for an approved specification.
        reason: `The target for ${key} does not say where its figures came from.`,
      };
    }
    if (basis.trim().length > MAX_BASIS_LENGTH) {
      return {
        ok: false,
        reason: `The source note for ${key} is longer than ${MAX_BASIS_LENGTH} characters.`,
      };
    }
    out[key] = {
      lowerMicrons: lower,
      upperMicrons: upper,
      basis: basis.trim(),
    };
  }

  return { ok: true, document: { version: 1, ranges: out } };
}

/**
 * Where a micrometre figure sits along the sieve axis, as a fractional
 * position in the stack.
 *
 * The plot spaces the seven positions evenly, so position 0 is the coarsest
 * sieve and position 6 the pan, whatever their apertures are. A figure
 * between two of them is placed by interpolating on the LOG of the two
 * apertures, because a sieve series is approximately geometric: on the
 * shipped stack 1200 µm and 600 µm are adjacent, and linear interpolation
 * would put their midpoint 900 µm at 0.50 while the stack itself puts it at
 * 0.42. Half a sieve width of error in where a target's edge is drawn.
 *
 * CLAMPED at both ends and `null` when the whole figure is off the stack, so
 * a caller cannot draw a band outside the plot or collapsed onto its edge.
 * Exported because this is the one piece of arithmetic in the figure and a
 * drawing is a poor place to check it; `tests/dgmTargets.test.ts` drives it
 * directly.
 */
export function apertureIndex(
  apertures: readonly number[],
  microns: number,
): number | null {
  if (apertures.length === 0 || !Number.isFinite(microns) || microns <= 0) return null;
  const coarsest = apertures[0]!;
  const finest = apertures[apertures.length - 1]!;
  if (microns >= coarsest) return 0;
  if (microns <= finest) return apertures.length - 1;
  for (let i = 0; i < apertures.length - 1; i++) {
    const upper = apertures[i]!;
    const lower = apertures[i + 1]!;
    if (microns <= upper && microns > lower) {
      const span = Math.log(upper) - Math.log(lower);
      // Two positions of equal aperture cannot happen in a stored series —
      // `parseSieveSeries` refuses a stack that does not fall strictly — but
      // a zero span here would be a division by zero in a drawing.
      if (span <= 0) return i;
      return i + (Math.log(upper) - Math.log(microns)) / span;
    }
  }
  return null;
}

/** Where a figure sits against its target. */
export type DgmStanding = 'below' | 'within' | 'above';

/**
 * INCLUSIVE at both ends. A sample at exactly 1200 µm against a 900–1200
 * target is within it: the figures are the edges of the acceptable region,
 * not the first unacceptable values, and a reader seeing "1200.0" reported as
 * above a 1200 limit would reasonably think the screen was broken.
 */
export function dgmStanding(dgmMicrons: number, range: DgmTargetRange): DgmStanding {
  if (dgmMicrons < range.lowerMicrons) return 'below';
  if (dgmMicrons > range.upperMicrons) return 'above';
  return 'within';
}

export const DGM_STANDING_LABELS: Readonly<Record<DgmStanding, string>> = {
  below: 'Finer than the target range',
  within: 'Within the target range',
  // "Coarser", not "too coarse". The screen reports where the grind sits; the
  // miller decides what that means for the batch in front of them.
  above: 'Coarser than the target range',
};

/** An empty document, for a deployment that has never set a target. */
export function emptyDgmTargets(): DgmTargetDocument {
  return { version: 1, ranges: {} };
}
