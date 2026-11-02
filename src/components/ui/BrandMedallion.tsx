import { BRAND_LOGO_SRC } from '@/components/ui/BrandMark';
import { cn } from '@/lib/cn';

/**
 * The farm's badge as a slowly turning coin.
 *
 * ===========================================================================
 * WHY THIS IS CSS AND NOT THE SUPPLIED VIDEO
 * ===========================================================================
 * The reference render is a 1280x720 h264 clip, and h264 has no alpha
 * channel: what looks like a transparent background in a player is a light
 * grey CHECKERBOARD painted into every frame. Sampled, the two squares sit at
 * roughly (246,249,247) and (222,225,222) — and the logo's own chicken is
 * white. Keying the lighter square out would have punched holes through the
 * bird, so there was no clean alpha asset to extract from it.
 *
 * It is therefore used as the MOTION reference, which is all it needed to be:
 * a coin turning on its vertical axis, showing a mirrored face as it passes
 * the back. That is reproduced here from the real 256px logo, which costs no
 * extra bytes, stays crisp at any pixel density, needs no video decode on a
 * phone in a feed mill, and — unlike an autoplaying `<video>` — cannot be
 * refused by an iOS power-saving setting and leave a black rectangle.
 *
 * ===========================================================================
 * HOW THE COIN IS BUILT
 * ===========================================================================
 * Three layers inside one `preserve-3d` box, which the browser then sorts by
 * depth for free:
 *
 *   front   translateZ(+3px)                  the logo
 *   rim     at z = 0, scaled a hair larger    a brushed-metal disc
 *   back    rotateY(180deg) translateZ(+3px)  the logo again, so it reads
 *                                             mirrored from behind, as it
 *                                             does in the reference
 *
 * The rim is hidden behind whichever face is toward the viewer and shows as a
 * silver crescent at the edge as the coin turns — which is what gives it
 * thickness without modelling a cylinder. `backface-visibility: hidden` on
 * both faces stops the front bleeding through once it has turned past 90°.
 *
 * ===========================================================================
 * IT STOPS WHEN ASKED
 * ===========================================================================
 * `motion-reduce:animate-none` leaves the coin resting face-on. A person who
 * has asked their device for less motion is often asking because motion makes
 * them ill, and a six-second loop in their eyeline for a whole shift is
 * exactly the case that setting exists for. Nothing is lost: at rest this is
 * the logo.
 */
export interface BrandMedallionProps {
  /** Rendered diameter in px. */
  readonly size?: number;
  readonly className?: string;
}

export function BrandMedallion({ size = 120, className }: BrandMedallionProps): JSX.Element {
  // `preserve-3d` is deliberately NOT on the faces. They have no 3D children,
  // and a replaced element that declares it can be flattened by the renderer
  // in ways that differ between browsers.
  const face = 'absolute inset-0 h-full w-full rounded-full [backface-visibility:hidden]';

  return (
    <div
      className={cn('shrink-0 [perspective:900px]', className)}
      style={{
        width: size,
        height: size,
        // THE SHADOW LIVES HERE, ON THE STATIC WRAPPER, and that is not a
        // style choice. A `filter` makes its element a containing block and
        // FLATTENS `transform-style: preserve-3d` to `flat`. Putting the
        // drop-shadow on the spinning box collapsed the three layers into
        // paint order, so the rim — the middle child — covered the logo and
        // the coin rendered as a plain silver disc. Caught in a screenshot,
        // not in a type.
        filter: 'drop-shadow(0 6px 10px rgb(15 23 42 / 0.18))',
      }}
      // Decorative: every screen that uses this also renders the company name
      // beside it in text, so announcing the image would say it twice.
      aria-hidden="true"
    >
      <div className="relative h-full w-full animate-medallion-spin [transform-style:preserve-3d] motion-reduce:animate-none">
        <img
          src={BRAND_LOGO_SRC}
          alt=""
          draggable={false}
          className={cn(face, 'select-none')}
          style={{ transform: 'translateZ(3px)' }}
        />
        {/*
          The edge. A flat disc at z = 0 between the two faces: invisible
          head-on, a silver crescent at a three-quarter turn. The gradient runs
          across the coin rather than around it, which is what brushed metal
          does under one light.
        */}
        <div
          className="absolute inset-0 rounded-full"
          style={{
            transform: 'scale(1.03)',
            background:
              'linear-gradient(100deg, #6b7280 0%, #e5e7eb 28%, #9ca3af 52%, #f3f4f6 74%, #6b7280 100%)',
          }}
        />
        <img
          src={BRAND_LOGO_SRC}
          alt=""
          draggable={false}
          className={cn(face, 'select-none')}
          style={{ transform: 'rotateY(180deg) translateZ(3px)' }}
        />
      </div>
    </div>
  );
}
