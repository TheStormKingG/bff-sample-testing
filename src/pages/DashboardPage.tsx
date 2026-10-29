import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ClipboardX, Eye, Hourglass, ShieldAlert } from 'lucide-react';
import { z } from 'zod';
import { DASHBOARD_ORDER } from '@/forms/registry';
import { STAGES, type Stage } from '@/forms/types';
import { CAPTURE_STATES, type CaptureState, type Disposition } from '@/lib/workflow';
import { plantDayEnd, plantDayStart, plantLocalDate } from '@/lib/time';
import { supabase } from '@/lib/supabase';
import { cn } from '@/lib/cn';
import { EmptyState } from '@/components/ui/EmptyState';
import { STAGE_ICON } from '@/components/ui/statusMaps';
import { SecondaryNav } from '@/components/layout/SecondaryNav';
import { useIsPhone } from '@/components/layout/viewport';
import { HomeScreen } from '@/components/home/HomeScreen';
import { useAccess } from '@/components/layout/accessContext';

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

  const [today, awaiting, review, holds] = await Promise.all([
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
  ]);

  for (const result of [today, awaiting, review, holds]) {
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

export function DashboardPage() {
  const { profile, can } = useAccess();
  const isPhone = useIsPhone();

  // The plant-local calendar date the figures belong to, computed once per
  // render and shown on screen, so a tablet left open across midnight shows a
  // dated figure rather than a silently wrong "today".
  const plantDate = useMemo(() => plantLocalDate(new Date()), []);

  const mayRecord = can('sample.draft');

  const counts = useQuery({
    queryKey: ['dashboard-counts', plantDate],
    queryFn: () => fetchDashboardCounts(plantDate),
    // A pending or suspended profile never renders this page, but the gate is
    // repeated here so no query can be issued without an approved profile.
    enabled: profile.status === 'active',
  });

  const data = counts.data;
  /** `undefined` covers both "not resolved yet" and "the query failed". */
  const countOf = (value: number | undefined): CountState =>
    value === undefined ? { kind: 'unavailable' } : { kind: 'ready', value };

  const queues = [
    {
      key: 'awaiting',
      to: '/awaiting',
      label: 'Awaiting results',
      icon: Hourglass,
      state: countOf(data?.awaitingResults),
      visible: can('sample.view'),
    },
    {
      key: 'review',
      to: '/reviews',
      label: 'Ready for review',
      icon: Eye,
      state: countOf(data?.readyForReview),
      visible: can('sample.review'),
    },
    {
      key: 'holds',
      to: '/holds',
      label: 'On hold',
      icon: ShieldAlert,
      state: countOf(data?.onHold),
      visible: can('sample.view'),
    },
  ].filter((queue) => queue.visible);

  /*
   * TWO LAYOUTS, ONE QUERY, ONE TREE.
   *
   * Below `sm` (640px) the home screen is the eight-tile grid; at `sm` and up
   * it is the existing dashboard, unchanged. The split is at `sm` and not
   * higher because the no-scroll problem is a PHONE problem: eight
   * finger-sized targets plus the app shell will not fit in 812px of height,
   * while the plant tablet this app also runs on has 1138px and room for the
   * stage descriptions, the queue section and the records panel. Collapsing a
   * 1280px desktop to eight big tiles would remove information from the
   * quality officer at a desk to solve a problem they do not have.
   *
   * Exactly ONE of the two is rendered — see `useIsPhone` for why hiding one
   * with CSS is not an option here.
   */
  if (isPhone) {
    return (
      <div className="h-[100dvh]">
        <HomeScreen
          plantDate={plantDate}
          mayRecord={mayRecord}
          todayByStage={data?.todayByStage}
          awaitingResults={data?.awaitingResults}
          readyForReview={data?.readyForReview}
          onHold={data?.onHold}
        />
      </div>
    );
  }

  return (
    <div className="space-y-10">
      <section aria-labelledby="forms-heading">
        <h1 id="forms-heading" className="text-2xl font-bold tracking-tight text-slate-900">
          Sample testing
        </h1>
        <p className="mt-1 text-base text-slate-600">
          {mayRecord
            ? 'Choose the test you are doing.'
            : 'The seven sample testing logs used in the feed factory.'}
        </p>
        <p className="mt-1 text-sm text-slate-600">
          Counts are for samples collected on{' '}
          <span className="tabular font-medium text-slate-700">{plantDate}</span> (Guyana local
          time). Drafts are not counted.
          {counts.isError && ' Counts could not be loaded.'}
        </p>

        {mayRecord ? (
          <ul className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {DASHBOARD_ORDER.map((schema) => {
              const Icon = STAGE_ICON[schema.stage];
              return (
                <li key={schema.stage}>
                  <Link
                    to={`/stage/${schema.stage}`}
                    className={cn(
                      'flex h-full min-h-[9.5rem] flex-col gap-2 rounded-2xl border border-slate-200 bg-white p-4 shadow-neu-sm transition-[transform,box-shadow] duration-150 ease-out active:scale-[0.99] active:shadow-neu-pressed',
                      'hover:border-bff-500 hover:bg-bff-50',
                    )}
                  >
                    <span className="flex items-center gap-3">
                      <span
                        aria-hidden="true"
                        className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-bff-100 text-lg font-bold text-bff-800"
                      >
                        {schema.ordinal}
                      </span>
                      <Icon aria-hidden="true" className="h-8 w-8 shrink-0 text-bff-700" />
                    </span>
                    <span className="block text-lg font-semibold leading-tight text-slate-900">
                      {/* The ordinal is decorative above; it is repeated in the
                          accessible name so the spoken order matches the seen
                          order (Master Prompt section 2). */}
                      <span className="sr-only">Form {schema.ordinal}: </span>
                      {schema.title}
                    </span>
                    <span className="block text-sm text-slate-600">{schema.description}</span>
                    <span className="mt-auto flex items-baseline justify-between gap-2 border-t border-slate-100 pt-2">
                      <span className="text-sm text-slate-600">Collected today</span>
                      <CountValue
                        state={countOf(data?.todayByStage[schema.stage])}
                        unit={`samples collected today for ${schema.title}`}
                        className="text-xl font-bold text-slate-900"
                      />
                    </span>
                    {!schema.frequencyApproved && (
                      // Verified in the live workbook: four of the seven
                      // stages record their sampling frequency as "To set", so
                      // no due or overdue claim may be made for them
                      // (FR-020, risk R-08).
                      <span className="block text-xs text-amber-800">
                        Sampling frequency not yet set
                      </span>
                    )}
                  </Link>
                </li>
              );
            })}
          </ul>
        ) : (
          <EmptyState
            className="mt-5 rounded-xl border border-slate-200"
            icon={ClipboardX}
            title="Your role does not record samples"
            description="You can search records, review queues and open reports from the list below."
          />
        )}
      </section>

      {queues.length > 0 && (
        <section aria-labelledby="queues-heading">
          <h2
            id="queues-heading"
            className="text-sm font-semibold uppercase tracking-wide text-slate-600"
          >
            Needs attention
          </h2>
          <ul className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
            {queues.map((queue) => (
              <li key={queue.key}>
                <Link
                  to={queue.to}
                  className="flex min-h-tap items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white px-4 py-3 shadow-neu-sm transition-[transform,box-shadow] duration-150 ease-out hover:border-bff-300 active:scale-[0.99] active:shadow-neu-pressed"
                >
                  <span className="flex items-center gap-3">
                    <queue.icon aria-hidden="true" className="h-5 w-5 text-slate-500" />
                    <span className="font-medium text-slate-900">{queue.label}</span>
                  </span>
                  <CountValue
                    state={queue.state}
                    unit={`samples ${queue.label.toLowerCase()}`}
                    className="text-xl font-bold text-slate-900"
                  />
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <SecondaryNav variant="panel" />
    </div>
  );
}

export default DashboardPage;
