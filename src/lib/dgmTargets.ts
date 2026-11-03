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

import { type Stage } from '../forms/types.ts';

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

/*
  ===========================================================================
  WHAT USED TO BE HERE, AND WHY IT IS NOT
  ===========================================================================
  A `system_config` key, a `DGM_TARGET_STAGES` list and a 110-line
  `parseDgmTargets` that read a stored JSON document and refused anything it
  could not defend — a stage that is not a stage, a figure beyond 20 mm, a
  range the wrong way round, a target with no stated source.

  All of it existed because the band had nowhere else to live: before 0041 a
  computed result could not be assessed, so the only way to get a range onto
  a chart was an administrator setting that bypassed the specification
  workflow. Every rule that parser enforced by hand, the specification schema
  now enforces as a constraint — bounds ordered, source evidence non-empty,
  the stage a real enum value — and it adds the ones a parser could not:
  proposed by one person, approved by a different one, versioned, dated.

  So the document is gone and `useDgmTargets` reads approved rules instead.
  What remains below is the DISPLAY side, which never cared where the figures
  came from: a range, where a sample sits against it, and how to place a
  micrometre figure on a categorical sieve axis.
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
