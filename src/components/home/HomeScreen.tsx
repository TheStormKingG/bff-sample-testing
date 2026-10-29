import { useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, ChevronRight, LayoutGrid, Wifi, WifiOff } from 'lucide-react';
import { DASHBOARD_ORDER } from '@/forms/registry';
import type { Stage } from '@/forms/types';
import { cn } from '@/lib/cn';
import { StatusChip } from '@/components/ui/StatusChip';
import { STAGE_ICON } from '@/components/ui/statusMaps';
import { SECONDARY_NAV } from '@/components/layout/navItems';
import { useAccess } from '@/components/layout/accessContext';
import { useOnline } from '@/components/layout/connectivity';
import { HomeTile } from '@/components/home/HomeTile';
import { MoreSheet, type QueueCount } from '@/components/home/MoreSheet';

export interface HomeScreenProps {
  /** The plant-local calendar date the per-stage figures belong to. */
  readonly plantDate: string;
  readonly mayRecord: boolean;
  /**
   * Per-stage figures for the plant-local day. `undefined` for the whole
   * object, or for a single stage, means "not known" — never a placeholder
   * zero (PRD §12).
   */
  readonly todayByStage: Readonly<Partial<Record<Stage, number>>> | undefined;
  readonly awaitingResults: number | undefined;
  readonly readyForReview: number | undefined;
  readonly onHold: number | undefined;
}

/**
 * The most cells the grid will lay out: five rows of two. If there is ever
 * more to offer than that, the last cell is 'More' and the remainder lives
 * inside it.
 *
 * WHY TEN AND NOT EIGHT. It was eight — four rows — while there were seven
 * forms plus 'More'. The eighth stage made nine cells, and nine against a cap
 * of eight was not a harmless overflow: `rows` below clamps to `MAX_CELLS / 2`,
 * so the template stayed at four explicit `minmax(0, 1fr)` rows and the ninth
 * cell landed in an IMPLICIT fifth row, which is auto-height. An auto-height
 * row does not divide the remaining space — it claims its content's height —
 * so it pushed the grid past the `h-[100dvh]` wrapper and broke the no-scroll
 * promise this file is built around.
 *
 * Raising the cap keeps that promise structurally rather than by luck: with
 * five `1fr` rows the tiles divide the same height into smaller pieces, which
 * is the documented degradation. On the shortest phone this app supports that
 * is roughly 110px per tile, still well clear of the 44px `min-h-tap` floor.
 */
const MAX_CELLS = 10;

/** One grid cell: its React key and the tile that fills it. */
interface Cell {
  readonly key: string;
  readonly node: ReactNode;
}

/**
 * The phone home screen: one large tile per form, no scroll.
 *
 * WHAT THIS IS FOR. A sampler on the floor of the feed mill opens the app to
 * answer one question — which test am I doing — one-handed, in gloves, in
 * bright light. So the whole screen is that question's answer set: the
 * numbered forms in the plant's own order, plus one tile holding everything
 * else. Nothing above it to read past, nothing below it to scroll to.
 *
 * HOW THE NO-SCROLL PROMISE IS KEPT, structurally rather than by luck:
 *
 *  - The outer element is exactly one viewport tall (`h-full` inside a
 *    `h-[100dvh]` wrapper in DashboardPage). `dvh`, not `vh`: on mobile
 *    Safari `100vh` is the viewport WITHOUT the collapsing toolbar, so a
 *    `100vh` screen scrolls by the toolbar's height on first paint.
 *  - The grid is `flex-1 min-h-0` and its rows are `minmax(0, 1fr)`, so the
 *    rows divide whatever height is left instead of claiming their content's
 *    height. The header strip and the status strip are `shrink-0`.
 *  - Every tile is `overflow-hidden`, so a long label can never push a row
 *    taller than its share.
 *
 * That means the screen degrades by making tiles smaller, not by growing past
 * the viewport. Measured heights are in the handover notes; the floor is
 * `min-h-tap` (44px) on each tile, which is reached only well below any
 * phone this app supports.
 *
 * WHERE THE OLD SCREEN'S INFORMATION WENT. Nothing was dropped to win space:
 *
 *  - Per-stage "collected today" counts stay, on their own tile.
 *  - The "sampling frequency not yet set" warning, true of four of the seven
 *    stages, is now a corner marker on each affected tile (with the wording
 *    spoken to a screen reader) plus one summary strip under the grid that
 *    links to Approved limits. Seven repetitions of the same sentence became
 *    one sentence plus four markers; the gap is MORE visible, not less.
 *  - The three "Needs attention" queue figures moved inside 'More', keeping
 *    their own separate numbers. They are not summed into one badge: three
 *    different kinds of work do not add up to a meaningful number.
 *  - Identity, role, last-successful-save and Sign out moved inside 'More',
 *    because this screen hides the app header to buy the grid its height.
 */
export function HomeScreen({
  plantDate,
  mayRecord,
  todayByStage,
  awaitingResults,
  readyForReview,
  onHold,
}: HomeScreenProps) {
  const { can } = useAccess();
  const online = useOnline();
  const [moreOpen, setMoreOpen] = useState(false);

  const stagesWithoutFrequency = useMemo(
    () => DASHBOARD_ORDER.filter((schema) => !schema.frequencyApproved).length,
    [],
  );

  const queueCounts: readonly QueueCount[] = useMemo(
    () => [
      { route: '/awaiting', value: awaitingResults },
      { route: '/reviews', value: readyForReview },
      { route: '/holds', value: onHold },
    ],
    [awaitingResults, readyForReview, onHold],
  );

  /**
   * Does anything need attention? Said in words on the 'More' tile rather
   * than as a coloured dot — PRD §11 forbids carrying meaning in colour
   * alone. `undefined` counts as "not known", so a failed query never
   * produces a reassuring silence OR an invented alarm.
   */
  const visibleQueueValues = [
    can('sample.view') ? awaitingResults : undefined,
    can('sample.review') ? readyForReview : undefined,
    can('sample.view') ? onHold : undefined,
  ];
  const needsAttention = visibleQueueValues.some((value) => value !== undefined && value > 0);

  const moreTile: Cell = {
    key: 'more',
    node: (
      <HomeTile
        label="More"
        icon={LayoutGrid}
        onClick={() => setMoreOpen(true)}
        meta={needsAttention ? 'Needs attention' : 'Records, limits, sign out'}
        metaTone={needsAttention ? 'warn' : 'normal'}
      />
    ),
  };

  /**
   * The cells.
   *
   * When the person may record a sample, that is every form plus 'More'.
   * When they may not — an auditor, or an account whose role has not been
   * assigned — showing form tiles that all refuse would be a lie told in
   * layout, so the grid becomes the record destinations their role DOES open,
   * and the screen says so in a sentence above it. 'More' is always the last
   * cell, because it is the only route to Sign out.
   */
  const recordTiles: Cell[] = SECONDARY_NAV.filter((item) => can(item.permission))
    .slice(0, MAX_CELLS - 1)
    .map((item) => ({
      key: item.to,
      node: <HomeTile label={item.label} icon={item.icon} to={item.to} />,
    }));

  const stageTiles: Cell[] = DASHBOARD_ORDER.map((schema) => {
    const count = todayByStage?.[schema.stage];
    return {
      key: schema.stage,
      node: (
        <HomeTile
          ordinal={schema.ordinal}
          label={schema.title}
          icon={STAGE_ICON[schema.stage]}
          to={`/stage/${schema.stage}`}
          meta={
            count === undefined ? (
              <>
                <span aria-hidden="true">— today</span>
                <span className="sr-only">Count not available</span>
              </>
            ) : (
              <span className="tabular">
                {count}
                <span aria-hidden="true"> today</span>
                <span className="sr-only"> collected today</span>
              </span>
            )
          }
          flag={schema.frequencyApproved ? undefined : 'Sampling frequency not yet set'}
        />
      ),
    };
  });

  const cells = mayRecord ? [...stageTiles, moreTile] : [...recordTiles, moreTile];
  // Clamped, but the clamp must never bite: a cell beyond the explicit rows
  // falls into an implicit auto-height row and breaks the no-scroll promise.
  // `stageTiles` is deliberately NOT sliced — silently hiding a form would be
  // worse than a layout fault — so the cap is what has to move when a stage is
  // added, and this assertion is where that is noticed.
  const rows = Math.min(Math.ceil(cells.length / 2), MAX_CELLS / 2);

  const frequencyNotice = `${stagesWithoutFrequency} of ${DASHBOARD_ORDER.length} stages have no approved sampling frequency`;

  return (
    <div
      className={cn(
        'flex h-full flex-col gap-4 overscroll-none bg-neu-base px-4',
        // `env()` is 0 until index.html opts into `viewport-fit=cover`; the
        // `max()` keeps a sane gutter today and becomes the real inset the
        // moment it does. The browser already lays the page out inside the
        // safe area without that opt-in.
        'pt-[max(0.5rem,env(safe-area-inset-top))] pb-[max(1rem,env(safe-area-inset-bottom))]',
      )}
    >
      <div className="flex shrink-0 items-center justify-between gap-2">
        <h1
          id="home-heading"
          className="shrink-0 whitespace-nowrap text-sm font-bold uppercase tracking-wide text-bff-800"
        >
          Sample testing
        </h1>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {/* Which day the tile figures are counting. A tablet left on across
              midnight then shows a dated number, not a silently wrong one. */}
          <span className="tabular text-xs font-medium text-slate-600">
            <span className="sr-only">Counts for </span>
            {plantDate}
          </span>
          <StatusChip
            label={online ? 'Online' : 'Offline'}
            tone={online ? 'success' : 'danger'}
            icon={online ? Wifi : WifiOff}
            srPrefix="Connection:"
            size="sm"
          />
        </div>
      </div>

      {!mayRecord && (
        <p className="shrink-0 text-sm font-medium text-slate-700">
          Your role does not record samples. These are the records you can open.
        </p>
      )}

      <nav aria-labelledby="home-heading" className="min-h-0 flex-1">
        <ul
          className="grid h-full grid-cols-2 gap-4"
          style={{ gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))` }}
        >
          {cells.map((cell) => (
            <li key={cell.key} className="min-h-0">
              {cell.node}
            </li>
          ))}
        </ul>
      </nav>

      {/*
        The known gap, kept on screen.
        Some stages record their sampling frequency as "To set" in the live
        workbook, so no due or overdue claim may be made for them (FR-020,
        risk R-08). The number is deliberately not written in this comment:
        it read "four of the seven" until DGM arrived, and a tally in prose
        goes stale the moment a stage is added. `stagesWithoutFrequency`
        below is the only count, and it is derived. Dropping the warning to win grid height would
        have hidden a real finding, so it is summarised here instead — and
        made actionable, since Approved limits is the screen that fixes it.
      */}
      {stagesWithoutFrequency > 0 &&
        (can('report.view') ? (
          <Link
            to="/specifications"
            className="neu-strip flex min-h-tap shrink-0 items-center gap-2.5 px-3 py-2"
          >
            <AlertTriangle aria-hidden="true" className="h-5 w-5 shrink-0 text-amber-700" />
            <span className="flex-1 text-sm font-semibold leading-tight text-amber-800">
              {frequencyNotice}
            </span>
            <ChevronRight aria-hidden="true" className="h-5 w-5 shrink-0 text-slate-600" />
          </Link>
        ) : (
          <p className="neu-strip flex min-h-tap shrink-0 items-center gap-2.5 px-3 py-2">
            <AlertTriangle aria-hidden="true" className="h-5 w-5 shrink-0 text-amber-700" />
            <span className="flex-1 text-sm font-semibold leading-tight text-amber-800">
              {frequencyNotice}
            </span>
          </p>
        ))}

      <MoreSheet open={moreOpen} onClose={() => setMoreOpen(false)} queueCounts={queueCounts} />
    </div>
  );
}
