import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { DASHBOARD_ORDER } from '@/forms/registry';
import { STAGES, type Stage } from '@/forms/types';
import { CAPTURE_STATES, type CaptureState, type Disposition } from '@/lib/workflow';
import { plantDayEnd, plantDayStart, plantLocalDate } from '@/lib/time';
import { supabase } from '@/lib/supabase';
import { cn } from '@/lib/cn';
import { PageHeader } from '@/components/records/common';
import { useAccess } from '@/components/layout/accessContext';
import ReportsPage from '@/pages/ReportsPage';

/**
 * Cross-slice contract: the ledger table and columns this dashboard counts.
 * The Supabase migrations own their definition; naming them once here keeps
 * the queries out of the markup (PRD NFR-006).
 */
const SAMPLES_TABLE = 'samples';
const COL_STAGE = 'stage';
const COL_CAPTURE_STATE = 'capture_state';
const COL_DISPOSITION = 'disposition';
/** The UTC instant the sample was collected. Stored UTC, read plant-local. */
const COL_COLLECTED_AT = 'collected_at';

const stageRowSchema = z.object({ stage: z.string() });

interface DashboardCounts {
  /** Non-draft, non-void samples collected during the plant-local day. */
  readonly todayByStage: Readonly<Record<Stage, number>>;
  readonly awaitingResults: number;
  readonly readyForReview: number;
  readonly onHold: number;
  /**
   * Samples carrying at least one out-of-limit measurement (0047).
   *
   * Overlaps `onHold` and is deliberately not summed with it: a sample can
   * be both, and the two answer different questions — one is a decision to
   * stop material, the other an observation about a reading.
   */
  readonly outsideLimits: number;
}

/**
 * Count what is actually stored.
 *
 * The day boundary is the plant's, not the server's. A sample taken at 21:00
 * in Guyana is UTC the following day, and counting it as tomorrow's work would
 * make every evening shift's figures wrong (PRD NFR-008, Master Prompt
 * section 5) — so the window is built from `plantDayStart`/`plantDayEnd`.
 *
 * Drafts and voided records are excluded. FR-005 is explicit that a draft is
 * "not counted as collected"; it is work in progress, not a sample.
 *
 * Every error is rethrown rather than defaulted to zero. A failed count that
 * renders as "0 today" is worse than no number at all, because it reads as a
 * quiet morning instead of a broken query.
 */
async function fetchDashboardCounts(plantDate: string): Promise<DashboardCounts> {
  const from = plantDayStart(plantDate).toISOString();
  const to = plantDayEnd(plantDate).toISOString();

  // Derived from the state list rather than written out, so a new capture
  // state is counted by default and only an explicit exclusion hides it.
  const countedStates: CaptureState[] = CAPTURE_STATES.filter(
    (state) => state !== 'draft' && state !== 'voided',
  );
  const awaitingResultsState: CaptureState = 'awaiting_results';
  const readyForReviewState: CaptureState = 'ready_for_review';
  const onHoldDisposition: Disposition = 'on_hold';

  const [today, awaiting, review, holds, outside] = await Promise.all([
    supabase
      .from(SAMPLES_TABLE)
      .select(COL_STAGE)
      .gte(COL_COLLECTED_AT, from)
      .lt(COL_COLLECTED_AT, to)
      .in(COL_CAPTURE_STATE, countedStates),
    supabase
      .from(SAMPLES_TABLE)
      .select(COL_STAGE, { count: 'exact', head: true })
      .eq(COL_CAPTURE_STATE, awaitingResultsState),
    supabase
      .from(SAMPLES_TABLE)
      .select(COL_STAGE, { count: 'exact', head: true })
      .eq(COL_CAPTURE_STATE, readyForReviewState),
    supabase
      .from(SAMPLES_TABLE)
      .select(COL_STAGE, { count: 'exact', head: true })
      .eq(COL_DISPOSITION, onHoldDisposition),
    /*
      Samples carrying an out-of-limit result (0047).

      Counted separately from holds and NOT added to them, because the two
      overlap: a sample can be both. Showing "holds + outside limits" as one
      figure would double-count those, and showing them as two figures that
      do not add up is the honest shape — each answers a different question.
    */
    supabase
      .from(SAMPLES_TABLE)
      .select(COL_STAGE, { count: 'exact', head: true })
      .eq('outside_limit_flag', true),
  ]);

  for (const result of [today, awaiting, review, holds, outside]) {
    if (result.error !== null) {
      throw new Error(`Could not read the sample counts: ${result.error.message}`);
    }
  }

  // Written out rather than built from STAGES so that adding a stage is a
  // compile error here instead of a silently missing card figure. It worked:
  // adding `dgm` broke this line before it broke anything a user would see.
  const todayByStage: Record<Stage, number> = {
    raw_materials: 0,
    ground: 0,
    conditioned: 0,
    pellets: 0,
    extruded_soya: 0,
    crumble: 0,
    mash: 0,
    dgm: 0,
  };
  for (const row of z.array(stageRowSchema).parse(today.data ?? [])) {
    // A stage value the registry does not know is ignored rather than counted
    // under a guessed heading: the tab set is a fixed contract.
    const stage = STAGES.find((s) => s === row.stage);
    if (stage !== undefined) todayByStage[stage] += 1;
  }

  return {
    todayByStage,
    awaitingResults: awaiting.count ?? 0,
    readyForReview: review.count ?? 0,
    onHold: holds.count ?? 0,
    outsideLimits: outside.count ?? 0,
  };
}

type CountState =
  { readonly kind: 'ready'; readonly value: number } | { readonly kind: 'unavailable' };

/**
 * A number, or an honest dash.
 *
 * There is no third rendering. Until the query has resolved, and if it fails,
 * the figure is simply not known and the markup says so to a screen reader
 * too — never a placeholder zero (PRD section 12).
 */
function CountValue({
  state,
  unit,
  className,
}: {
  readonly state: CountState;
  readonly unit: string;
  readonly className?: string;
}) {
  if (state.kind === 'unavailable') {
    return (
      <span className={className}>
        <span aria-hidden="true">—</span>
        <span className="sr-only">Count not available</span>
      </span>
    );
  }
  return (
    <span className={cn('tabular', className)}>
      {state.value}
      <span className="sr-only"> {unit}</span>
    </span>
  );
}


/**
 * The quality overview and the reports, as two tabs of one screen.
 *
 * ===========================================================================
 * WHAT MOVED OFF THIS PAGE
 * ===========================================================================
 * It used to be the application's front door: the seven stage cards, the
 * queue figures, a records panel, and a different layout on a phone. The
 * stage cards are Home's job now, the queues are Flagged's, and the bottom
 * bar is the records panel. What is left is the two things a supervisor
 * opens this screen FOR — how the day looks, and the reports behind it.
 *
 * Reports is a tab here rather than a sixth item in the bar because a figure
 * and the report that explains it are the same subject; splitting them put
 * two taps between a number and its basis.
 *
 * ===========================================================================
 * A FIGURE IS NEVER INVENTED
 * ===========================================================================
 * Every tile reads through `CountValue`, which renders a dash and says
 * "count not available" to a screen reader when a query has not resolved or
 * has failed. A placeholder zero on this screen would read as "nothing is
 * wrong", which is the one wrong answer that looks like good news.
 */

type DashboardTab = 'overview' | 'reports';

const DASHBOARD_TABS: readonly { readonly id: DashboardTab; readonly label: string }[] = [
  { id: 'overview', label: 'Quality overview' },
  { id: 'reports', label: 'Reports' },
];

function OverviewTab() {
  const { profile } = useAccess();
  const plantDate = useMemo(() => plantLocalDate(new Date()), []);

  const counts = useQuery({
    queryKey: ['dashboard-counts', plantDate],
    queryFn: () => fetchDashboardCounts(plantDate),
    enabled: profile.status === 'active',
  });

  const data = counts.data;
  const countOf = (value: number | undefined): CountState =>
    value === undefined ? { kind: 'unavailable' } : { kind: 'ready', value };

  const collectedToday =
    data === undefined
      ? undefined
      : STAGES.reduce((total, stage) => total + data.todayByStage[stage], 0);

  const tiles = [
    { key: 'today', label: 'Samples today', state: countOf(collectedToday), unit: 'samples collected today' },
    { key: 'awaiting', label: 'Awaiting results', state: countOf(data?.awaitingResults), unit: 'samples awaiting results' },
    { key: 'holds', label: 'Active holds', state: countOf(data?.onHold), unit: 'samples on hold' },
    { key: 'review', label: 'Pending review', state: countOf(data?.readyForReview), unit: 'samples ready for review' },
    { key: 'outside', label: 'Outside limits', state: countOf(data?.outsideLimits), unit: 'samples with a result outside an approved limit' },
  ];

  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm text-slate-600">
        Counts are for samples collected on{' '}
        <span className="tabular font-medium text-slate-700">{plantDate}</span> (Guyana local
        time) unless the tile says otherwise. Drafts are not counted.
        {counts.isError && ' Counts could not be loaded.'}
      </p>

      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {tiles.map((tile) => (
          <li
            key={tile.key}
            className="flex flex-col gap-1 rounded-2xl bg-neu-base p-4 shadow-neu-sm"
          >
            <CountValue
              state={tile.state}
              unit={tile.unit}
              className="text-3xl font-bold text-slate-900"
            />
            <span className="text-sm font-medium leading-tight text-slate-700">{tile.label}</span>
          </li>
        ))}
      </ul>

      {/*
        "Active holds" and "Outside limits" deliberately do not add up to
        anything, and no total is offered. A sample can be both, so a sum
        would double-count it; and the two are different facts — one is a
        decision somebody made to stop material, the other is an observation
        about a reading.
      */}
      <section aria-labelledby="by-stage-heading" className="flex flex-col gap-3">
        <h2 id="by-stage-heading" className="text-lg font-semibold text-slate-900">
          Collected today, by stage
        </h2>
        <ul className="flex flex-col gap-2">
          {DASHBOARD_ORDER.map((schema) => (
            <li key={schema.stage} className="flex items-baseline justify-between gap-3 border-b border-slate-100 pb-2 last:border-b-0">
              <span className="text-base text-slate-800">
                {schema.ordinal}. {schema.title}
              </span>
              <CountValue
                state={countOf(data?.todayByStage[schema.stage])}
                unit={`samples collected today for ${schema.title}`}
                className="text-lg font-semibold text-slate-900"
              />
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

export function DashboardPage() {
  const [tab, setTab] = useState<DashboardTab>('overview');

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="Dashboard" description="Feed Factory quality figures and reports." />

      <div className="flex flex-wrap gap-2" role="tablist" aria-label="Dashboard sections">
        {DASHBOARD_TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            onClick={() => setTab(item.id)}
            className={cn(
              'min-h-tap rounded-full border px-4 py-2 text-sm font-semibold',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-700 focus-visible:ring-offset-2',
              tab === item.id
                ? 'border-blue-800 bg-blue-800 text-white'
                : 'border-slate-300 bg-neu-base text-slate-800 shadow-neu-sm',
            )}
          >
            {item.label}
          </button>
        ))}
      </div>

      {tab === 'overview' ? <OverviewTab /> : <ReportsPage />}
    </div>
  );
}

export default DashboardPage;
