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
 * ===========================================================================
 * ONE ROW, ONE PIECE OF TEXT
 * ===========================================================================
 * Icon on the left, name beside it, and nothing under it. The tile used to
 * stack icon over name over a second line — a per-stage "N today" count, or
 * "Records, limits, sign out" on More — and the owner asked for the second
 * line to go and the two remaining things to sit side by side.
 *
 * What that costs, stated rather than hidden: the per-stage collected-today
 * figure is no longer on the phone home screen. It is NOT lost from the
 * app — the wide dashboard still renders it per stage from the same query,
 * which is why `DashboardPage` still asks for it — but a sampler holding a
 * phone no longer sees it without opening the stage.
 *
 * The label is allowed two lines and clipped after that, because a row is
 * narrower than a full tile. `Conditioned` is the longest unbreakable word
 * any stage carries and it is what sets the floor: at 375px the text column
 * measures about 90px against its 85px, which fits, and below 360px it does
 * not, which is why the tile stacks again there. Measured, not assumed.
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
  flag,
  className,
}: HomeTileProps) {
  const body = (
    <>
      {/*
          The marker moved from the top-right corner to the bottom-right one
          when the tile became a row. In a row the label is vertically centred
          and runs to within a few pixels of the right edge, so a top-right
          marker would have needed a right gutter wide enough to clear it —
          and that gutter came out of the text column, which at 375px is
          already only wide enough for the longest stage name. The bottom-
          right corner of a row tile is empty.
      */}
      {flag !== undefined && (
        <AlertTriangle
          aria-hidden="true"
          className="absolute bottom-1.5 right-2 h-4 w-4 text-amber-700"
        />
      )}

      <span aria-hidden="true" className="relative shrink-0">
        <span className="neu-slot h-10 w-10">
          <Icon className="h-5 w-5 text-bff-700" />
        </span>
        {/*
            The form's number, badged on the slot rather than parked in the
            tile's top-left corner. A corner number needs a left gutter the
            icon must clear, and in a row layout that gutter is subtracted
            from the one thing that cannot spare it. Against the round slot
            the square corner is empty, so the number costs no width at all.
        */}
        {ordinal !== undefined && (
          <span className="absolute -left-0.5 -top-1 text-[0.6875rem] font-bold leading-none tabular text-bff-800">
            {ordinal}
          </span>
        )}
      </span>

      <span className="line-clamp-2 min-w-0 text-center text-[0.9375rem] font-semibold leading-tight text-slate-900 min-[360px]:text-left">
        {ordinal !== undefined && <span className="sr-only">Form {ordinal}: </span>}
        {label}
      </span>

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
  const shared = cn(
    'neu-tile h-full w-full min-h-tap min-w-tap items-center justify-center gap-1.5 px-2 py-3',
    // Side by side from 360px up, which covers every phone this is filled on
    // (the mill's is 390). Below that the row's text column is narrower than
    // the word `Conditioned` sets at this size, so the tile keeps the stacked
    // layout and gives the name the tile's whole width instead. Same rule as
    // `PairedFields`: the breakpoint is a measurement, not a preference.
    'min-[360px]:flex-row min-[360px]:justify-start min-[360px]:gap-2.5 min-[360px]:px-3',
    className,
  );

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
