import { cn } from '@/lib/cn';

/**
 * The Bounty Farm mark, and the one place that knows where the file is.
 *
 * ===========================================================================
 * WHY THE PATH IS BUILT AND NOT WRITTEN
 * ===========================================================================
 * The app is served from `/FeedQualityApp/`, not from the domain root, so a
 * literal `/bounty-farm-logo.png` resolves to `bountyfarmltd.com/bounty-farm-
 * logo.png` and 404s. `import.meta.env.BASE_URL` is the same single source
 * `.github/base-path` feeds into the build (see `tests/basePath.test.ts`), so
 * the mark follows the app wherever it is mounted and cannot be the one asset
 * that breaks when the base path moves.
 *
 * ===========================================================================
 * WHY IT IS A COMPONENT AND NOT AN <img> IN THREE PLACES
 * ===========================================================================
 * It appears on the sign-in screen, in the header of every signed-in screen,
 * and on the access-pending screen — which between them are every screen this
 * application has. Three copies would be three chances for one of them to
 * keep a stale filename, a wrong alt text, or a size that makes the header
 * jump on load.
 *
 * ===========================================================================
 * THE ALT TEXT, AND WHEN IT IS EMPTY
 * ===========================================================================
 * `alt` is empty whenever the mark sits beside the words "BFF Sample Testing",
 * because the logo and the wordmark then say the same thing and a screen
 * reader announcing both reads "Bounty Farm Limited link BFF Sample Testing".
 * It carries real alt text only where it stands alone. That is the W3C rule
 * for a logo adjacent to its own name, not a preference.
 *
 * `width`/`height` are set so the box is reserved before the file loads: the
 * header is the first thing painted, and a mark that pops in afterwards
 * shoves the page down under the operator's thumb (Core Web Vitals, CLS).
 */
/**
 * Where the logo file is, built once. See the note above on why it is not a
 * literal: under `/FeedQualityApp/` a leading-slash path resolves to the
 * domain root and 404s.
 */
export const BRAND_LOGO_SRC = `${import.meta.env.BASE_URL}bounty-farm-logo.png`;

export interface BrandMarkProps {
  /** Rendered size in px. The file is 256px square, so 64 is the honest cap. */
  readonly size?: number;
  /**
   * True when the words "BFF Sample Testing" are rendered beside this mark,
   * which makes the image decorative. Defaults to decorative, because that is
   * the commoner case and the failure it causes — a missing announcement — is
   * less bad than a doubled one.
   */
  readonly labelled?: boolean;
  readonly className?: string;
}

export function BrandMark({
  size = 36,
  labelled = true,
  className,
}: BrandMarkProps): JSX.Element {
  return (
    <img
      src={BRAND_LOGO_SRC}
      alt={labelled ? '' : 'Bounty Farm Limited'}
      aria-hidden={labelled ? 'true' : undefined}
      width={size}
      height={size}
      // `shrink-0` because the header truncates the wordmark beside it at
      // 320px; the mark must not be what gives way, or it squashes to an oval.
      className={cn('shrink-0 select-none', className)}
      style={{ width: size, height: size }}
      draggable={false}
    />
  );
}
