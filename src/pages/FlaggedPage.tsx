/**
 * Flagged: everything that needs a person, on one screen.
 *
 * ===========================================================================
 * WHY THIS REPLACED THREE SCREENS
 * ===========================================================================
 * Holds, Awaiting Results and Reviews were three lists of the same table
 * asking three questions about the same work. Somebody wanting to know "what
 * needs me?" had to open all three and hold the answer in their head, and
 * nothing anywhere said how the three related — so the most serious item in
 * the mill could be the third row of the third list.
 *
 * ===========================================================================
 * THE BANDS, AND WHAT THEY ARE NOT
 * ===========================================================================
 *   Critical  the material is on hold — it has been stopped
 *   High      a recorded result is outside an approved limit
 *   Other     results are still to be entered, or a review is waiting
 *
 * Severity is DERIVED from those states and stored nowhere (`flagBandOf`).
 * There is no severity column, no dropdown and no way to mark something less
 * serious than it is; change the hold or the result and the band follows.
 *
 * It is also NOT a priority queue, and the wording avoids saying so. The
 * bands describe what is true of the sample, not what to do first — "a hold
 * outranks every permissive signal" is a release rule, not a work order, and
 * a screen that told an operator which sample to attend to next would be
 * making a supervisor's decision for them.
 *
 * A sample sits in exactly ONE band, the highest that is true of it, so the
 * three counts add to the total and nothing is counted twice.
 */

import { useState } from 'react';

import {
  PAGE_SIZE,
  useFlagged,
  useFlaggedCounts,
  type FlagBand,
} from '@/hooks/useSamples';
import {
  Card,
  EmptyState,
  ErrorNotice,
  LoadingBlock,
  PageHeader,
} from '@/components/records/common';
import { SampleTable } from '@/components/records/SampleTable';
import { Pagination } from '@/components/records/Pagination';
import { cn } from '@/lib/cn';

type Band = FlagBand | 'all';

const BANDS: readonly {
  readonly id: Band;
  readonly label: string;
  /** What makes a sample appear under this chip, in the plant's words. */
  readonly rule: string;
}[] = [
  {
    id: 'all',
    label: 'All',
    rule: 'Every sample that needs somebody: on hold, outside an approved limit, or waiting for results or a review.',
  },
  {
    id: 'critical',
    label: 'Critical',
    rule: 'The material is on quality hold. A hold stops the material until somebody authorised clears it; clearing a hold is not by itself an acceptance.',
  },
  {
    id: 'high',
    label: 'High',
    rule: 'A recorded result on this sample is outside an approved limit. Nothing has been stopped automatically — what to do about it is a person’s decision.',
  },
  {
    id: 'other',
    label: 'Other',
    rule: 'Results are still to be entered, or the sample is ready for a quality review. Neither is a fault; both are work somebody is expected to do.',
  },
];

export default function FlaggedPage() {
  const [band, setBand] = useState<Band>('all');
  const [page, setPage] = useState(0);
  const counts = useFlaggedCounts();
  const list = useFlagged(band, page);

  const chosen = BANDS.find((b) => b.id === band)!;

  /**
   * `undefined` for a count that is not known yet or whose query failed —
   * never a placeholder zero. "Nothing needs you" is the single most
   * reassuring thing this screen can say and it must never say it by
   * accident (PRD section 12).
   */
  const countFor = (id: Band): number | undefined => {
    if (counts.data === undefined) return undefined;
    return id === 'all' ? counts.data.all : counts.data[id];
  };

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Flagged"
        description="Holds, out-of-limit results, and work waiting on somebody."
      />

      <div className="flex flex-wrap gap-2" role="group" aria-label="Filter by what is wrong">
        {BANDS.map((b) => {
          const count = countFor(b.id);
          const active = b.id === band;
          return (
            <button
              key={b.id}
              type="button"
              aria-pressed={active}
              onClick={() => {
                setBand(b.id);
                // A page number from the previous band means nothing in this
                // one, and page 3 of a one-page band renders as empty.
                setPage(0);
              }}
              className={cn(
                'inline-flex min-h-tap items-center gap-2 rounded-full border px-4 py-2 text-sm font-semibold',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-700 focus-visible:ring-offset-2',
                active
                  ? 'border-blue-800 bg-blue-800 text-white'
                  : 'border-slate-300 bg-neu-base text-slate-800 shadow-neu-sm',
              )}
            >
              {b.label}
              <span className={cn('tabular', active ? 'text-white' : 'text-slate-600')}>
                {count === undefined ? (
                  <>
                    <span aria-hidden="true">—</span>
                    <span className="sr-only">count not available</span>
                  </>
                ) : (
                  count
                )}
              </span>
            </button>
          );
        })}
      </div>

      {counts.isError ? (
        <ErrorNotice
          error={counts.error}
          what="the flagged counts"
          onRetry={() => void counts.refetch()}
        />
      ) : null}

      <Card description={chosen.rule}>
        {list.isPending ? (
          <LoadingBlock label="Loading flagged samples" />
        ) : list.isError ? (
          <ErrorNotice
            error={list.error}
            what="Flagged samples"
            onRetry={() => void list.refetch()}
          />
        ) : list.data.rows.length === 0 ? (
          <EmptyState
            title={
              band === 'all'
                ? 'Nothing needs attention.'
                : `Nothing is in the ${chosen.label.toLowerCase()} band.`
            }
            hint="A sample appears here the moment a hold is raised, a result falls outside an approved limit, or results or a review are outstanding."
          />
        ) : (
          <div className="flex flex-col gap-4">
            {list.isFetching ? (
              <p role="status" className="text-sm text-slate-600">
                Updating…
              </p>
            ) : null}
            <SampleTable rows={list.data.rows} />
            {/*
              Paged only for `all` and `critical`. The other two bands are
              narrowed from the flagged page after it is read, so a page
              number would count rows this screen filtered out and the
              control would skip over work. The chip count is the honest
              total for those bands and comes from the server.
            */}
            {band === 'all' || band === 'critical' ? (
              <Pagination
                page={page}
                pageSize={PAGE_SIZE}
                total={list.data.total}
                totalUnknown={list.data.totalUnknown}
                rowsOnPage={list.data.rows.length}
                onPageChange={setPage}
                busy={list.isFetching}
              />
            ) : null}
          </div>
        )}
      </Card>
    </div>
  );
}
