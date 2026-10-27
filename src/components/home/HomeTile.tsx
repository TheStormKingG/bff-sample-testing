import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/cn';

export interface HomeTileProps {
  /**
   * The form's number in the plant's own sequence, 1-7. The factory refers to
   * these logs by number, so it is shown rather than implied by position.
   * Omitted for the 'More' tile, which is not one of the seven.
   */
  readonly ordinal?: number;
  readonly label: string;
  readonly icon: LucideIcon;
  /** A route, for a tile that navigates. Mutually exclusive with `onClick`. */
  readonly to?: string;
  /** A handler, for a tile that opens something in place. */
  readonly onClick?: () => void;
  /** One short line under the label — a count, or a state word. */
  readonly meta?: ReactNode;
  /** Tone for `meta`. 'warn' is amber-800 (6.4:1 on this surface). */
  readonly metaTone?: 'normal' | 'warn';
  /**
   * A known gap in the record, e.g. no approved sampling frequency. Rendered
   * as a corner marker PLUS this wording for a screen reader — never as
   * colour alone (PRD §11).
   */
  readonly flag?: string;
  readonly className?: string;
}

/**
 * One large app-icon-style tile on the phone home screen.
 *
 * Accessibility notes, because this is the style that usually loses them:
 *
 *  - The tile IS the control, and it fills its grid cell. The 44pt minimum is
 *    a floor the layout clears by a wide margin (measured ~163x159pt on a
 *    375x812 screen); nothing here sets a width or a height, so the tile can
 *    only ever be as large as the grid gives it.
 *  - Every text colour used is >= 4.5:1 on the `neu-base` surface.
 *    `text-slate-500` measures 4.31:1 there and is deliberately absent.
 *  - The focus ring is restored by `.neu-tile:focus-visible` in
 *    src/styles/index.css, not deleted the way neumorphic designs usually
 *    delete it.
 *  - The visible number is `aria-hidden` and re-spoken as "Form N:" so the
 *    spoken order matches the seen order without reading "1 1".
 */
export function HomeTile({
  ordinal,
  label,
  icon: Icon,
  to,
  onClick,
  meta,
  metaTone = 'normal',
  flag,
  className,
}: HomeTileProps) {
  const body = (
    <>
      {ordinal !== undefined && (
        <span
          aria-hidden="true"
          className="absolute left-2.5 top-2 text-sm font-bold tabular text-bff-800"
        >
          {ordinal}
        </span>
      )}

      {flag !== undefined && (
        <AlertTriangle
          aria-hidden="true"
          className="absolute right-2 top-2 h-4 w-4 text-amber-700"
        />
      )}

      <span aria-hidden="true" className="neu-slot h-12 w-12">
        <Icon className="h-6 w-6 text-bff-700" />
      </span>

      <span className="mt-2 px-1 text-center text-[0.9375rem] font-semibold leading-tight text-slate-900">
        {ordinal !== undefined && <span className="sr-only">Form {ordinal}: </span>}
        {label}
      </span>

      {meta !== undefined && (
        <span
          className={cn(
            'mt-0.5 px-1 text-center text-xs font-medium leading-tight',
            metaTone === 'warn' ? 'text-amber-800' : 'text-slate-600',
          )}
        >
          {meta}
        </span>
      )}

      {/* Spoken last, so a screen reader announces WHICH form before the
          caveat about it. The corner marker above carries the same fact
          visually; neither stands alone, because colour alone may not carry
          meaning (PRD section 11). */}
      {flag !== undefined && <span className="sr-only">. {flag}</span>}
    </>
  );

  // `min-h-tap`/`min-w-tap` are a backstop, not the sizing mechanism: on any
  // viewport this screen supports the grid cell is far larger. They exist so
  // that a future change which squeezes the grid fails visibly rather than
  // quietly producing an unhittable target.
  const shared = cn('neu-tile h-full w-full min-h-tap min-w-tap px-2 py-3', className);

  if (to !== undefined) {
    return (
      <Link to={to} className={shared}>
        {body}
      </Link>
    );
  }

  return (
    // No `aria-expanded`/`aria-controls`: this opens a modal dialog, which
    // takes focus and is announced on arrival. A control pointing at an id
    // that only exists while the dialog is mounted would be a broken
    // reference for most of the screen's life.
    <button type="button" onClick={onClick} aria-haspopup="dialog" className={shared}>
      {body}
    </button>
  );
}
