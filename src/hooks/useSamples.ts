/**
 * Sample search and the shared record-screen data contract.
 *
 * This module is the single place in the records slice that knows table names,
 * column names and select lists. Every other hook and page in the slice
 * imports them from here, so a schema correction is a one-file change rather
 * than a hunt through pages (PRD NFR-006).
 *
 * Reads go straight to PostgREST and are therefore constrained by RLS: a
 * pending account sees nothing because the policies say so, not because a
 * component hid a row (Master Prompt §4). Every MUTATION goes through an
 * authenticated Edge Function (see `FUNCTIONS`), never a direct table write.
 */

import { useCallback } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { SupabaseClient } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';
import { STAGES, type Stage } from '@/forms/types';
import { getSchema } from '@/forms/registry';
import { plantLocalDate } from '@/lib/time';
import {
  counted,
  unavailable,
  type CountSource,
  type SampleFact,
} from '@/lib/reportMetrics';
import type { CaptureState, Disposition } from '@/lib/workflow';
import {
  PERMISSIONS,
  can,
  type AuthorityContext,
  type Delegation,
  type Permission,
  type Role,
  type UserStatus,
} from '@/lib/roles';
import { useAccess } from '@/components/layout/accessContext';

/**
 * The generated `Database` types are produced from migrations owned by another
 * slice, so compiling against them here would couple this module to whatever
 * shape that generation happens to have at any moment. The rows this slice
 * reads are declared explicitly below instead and each query result is cast to
 * them once, at the boundary. A column that does not exist still fails loudly
 * — at request time, with the PostgREST message shown in the UI — rather than
 * silently returning something of the wrong shape.
 */
const db = supabase as unknown as SupabaseClient;

// ---------------------------------------------------------------------------
// Tables, functions and select lists
// ---------------------------------------------------------------------------

export const TABLES = {
  samples: 'samples',
  measurements: 'sample_measurements',
  links: 'sample_links',
  specificationVersions: 'specification_versions',
  auditEvents: 'audit_events',
  holds: 'holds',
  profiles: 'profiles',
  userRoles: 'user_roles',
  delegations: 'user_delegations',
  syncOutbox: 'sheet_sync_outbox',
  auditDeadLetters: 'audit_event_dead_letters',
} as const;

/**
 * Edge Functions this slice calls.
 *
 * Names are runtime strings, which is what made the original fault so
 * expensive: a name with no deployed function behind it cannot fail the build,
 * cannot fail the typecheck and cannot fail a unit test. It fails in the
 * plant, as an opaque transport error, on the one action the operator was
 * trying to perform. All five names here once pointed at nothing, so clearing
 * a hold, proposing or approving a limit, approving a pending account,
 * assigning a role, recording a delegation, retrying a failed sync job and
 * running schema verification each produced a network error instead of a
 * quality decision.
 *
 * EVERY VALUE BELOW IS NOW A DEPLOYED DIRECTORY under
 * `supabase/functions/<name>/index.ts`. Each one authenticates the caller from
 * the bearer token alone, re-checks authority against the database-loaded
 * permission matrix, claims an idempotency key, writes an audit event and
 * returns typed JSON errors. The multi-action names are routers whose action
 * vocabularies are declared once in `supabase/functions/_shared/actions.ts`,
 * with a total action -> permission table and no permissive default branch.
 *
 * Two of these capabilities already had single-purpose endpoints
 * (`set-disposition`, `approve-specification`). Rather than duplicate their
 * authority logic, the routers run THE SAME specs those endpoints run, which
 * now live in `supabase/functions/_shared/handlers/`. There is one
 * implementation of each quality decision in this codebase, whichever door it
 * is reached through.
 *
 * AN ADMINISTRATOR HOLDS NO QUALITY AUTHORITY THROUGH ANY OF THESE. The role
 * carries no `hold.*`, no `disposition.*`, no `spec.propose` and no
 * `spec.approve` (see `roles.ts`), so the permission tables refuse it; and
 * `admin-action` cannot be used to grant quality power either, because a
 * delegation may only pass on a permission the grantor already holds, and
 * `disposition.override_release` cannot be delegated through the API at all.
 */
export const FUNCTIONS = {
  /**
   * Sample decisions: `review`, `request_correction`, `raise_hold`,
   * `clear_hold`, `disposition`. Routed to the review, hold and disposition
   * specs; the last is the same spec `set-disposition` runs.
   */
  sampleAction: 'sample-action',
  /**
   * `propose`, `submit_review`, `approve`, `reject`. The last two are the same
   * spec `approve-specification` runs, so the segregation-of-duties check that
   * stops a proposer approving their own rule cannot be bypassed by coming in
   * through here.
   */
  specificationAction: 'specification-action',
  /**
   * `approve_access`, `deny_access`, `set_status`, `set_roles`,
   * `create_delegation`, `revoke_delegation`, `upsert_controlled_value`.
   */
  adminAction: 'admin-action',
  /** `retry` one job, or `retry_dead_lettered` in bulk. Needs `sync.retry`. */
  syncAction: 'sync-action',
  /**
   * `verify_headers`. Reading the headers needs `sync.view`; LATCHING the
   * workbook as drifted — which stops every sheet write in the deployment —
   * additionally needs `sync.retry`, and the response says which happened.
   */
  schemaVerify: 'schema-verify',

  /**
   * The single-purpose endpoints, for callers that want one operation rather
   * than a router. Same specs, same authority, their own operation names in
   * the request registry.
   */
  registerSample: 'register-sample',
  updateResults: 'update-results',
  reviewSample: 'review-sample',
  setDisposition: 'set-disposition',
  approveSpecification: 'approve-specification',
  health: 'health',
} as const;

/**
 * The sample select list.
 *
 * It is one string LITERAL, not an array joined at runtime, because
 * supabase-js resolves the shape of `data` by parsing this very string at
 * the type level. `Array.prototype.join` returns the widened `string` type,
 * which the parser cannot read, so every query built from it inferred the
 * parser's failure branch instead of a row — and the failure was invisible
 * until something tried to use the result. Keep it a literal, and keep it in
 * step with `SampleRow` below.
 */
export const SAMPLE_COLUMNS =
  'id,sample_id,stage,sampling_point,material,feed_type,supplier,lot_no,batch_no,run_no,collection_local_date,collection_local_time,collection_instant,registered_by,registered_by_name,revision,capture_state,disposition,hold_active,sync_state,sheet_confirmed_at,created_at,updated_at' as const;

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

/**
 * Sheets synchronisation state.
 *
 * Only `confirmed` may ever be presented as being in Google Sheets. Every
 * other value is a form of "recorded securely, sync outstanding" — Master
 * Prompt §7 forbids a false green save state.
 */
export const SYNC_STATES = [
  'not_queued',
  'pending',
  'in_progress',
  'confirmed',
  'failed',
  'dead_letter',
] as const;
export type SyncState = (typeof SYNC_STATES)[number];

export interface SampleRow {
  readonly id: string;
  /** Null while the record is still a draft: a draft reserves no official ID. */
  readonly sample_id: string | null;
  readonly stage: Stage;
  readonly sampling_point: string | null;
  readonly material: string | null;
  readonly feed_type: string | null;
  readonly supplier: string | null;
  readonly lot_no: string | null;
  readonly batch_no: string | null;
  readonly run_no: string | null;
  /** Plant-local collection date, `YYYY-MM-DD`. The sample-ID sequence key. */
  readonly collection_local_date: string;
  /** Plant-local collection time, `HH:mm`. */
  readonly collection_local_time: string;
  /** Full UTC instant of collection. */
  readonly collection_instant: string;
  readonly registered_by: string | null;
  readonly registered_by_name: string | null;
  readonly revision: number;
  readonly capture_state: CaptureState;
  readonly disposition: Disposition;
  readonly hold_active: boolean;
  readonly sync_state: SyncState;
  readonly sheet_confirmed_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface MeasurementRow {
  readonly id: string;
  readonly sample_uuid: string;
  readonly field_key: string;
  readonly parameter_key: string | null;
  /** Null means not measured. Zero is a real measured value. */
  readonly numeric_value: number | null;
  readonly text_value: string | null;
  /** The characters the operator typed, so entered precision survives. */
  readonly entered_text: string | null;
  readonly unit: string | null;
  readonly recorded_by_name: string | null;
  readonly recorded_at: string | null;
}

export interface SpecificationVersionRow {
  readonly id: string;
  readonly specification_id: string | null;
  readonly version: number;
  readonly parameter_key: string;
  readonly stage: Stage;
  readonly material: string | null;
  readonly feed_type: string | null;
  readonly sampling_point: string | null;
  readonly test_method: string | null;
  readonly unit: string | null;
  readonly lower_bound: number | null;
  readonly upper_bound: number | null;
  readonly status: string;
  readonly effective_from: string;
  readonly effective_to: string | null;
  readonly proposed_by: string | null;
  readonly proposed_by_name: string | null;
  readonly approved_by: string | null;
  readonly approved_by_name: string | null;
  readonly approved_at: string | null;
  readonly source_note: string | null;
  /** `Limits` tab entry number 1-34, for the reference listing only. */
  readonly workbook_entry_no: number | null;
  /** Verbatim `Limits` status: To set / Set / Confirm with Polinutri / ... */
  readonly workbook_status: string | null;
  readonly sample_label: string | null;
  readonly test_label: string | null;
}

export interface AuditEventRow {
  readonly id: string;
  readonly sample_uuid: string | null;
  readonly actor_id: string | null;
  readonly actor_name: string | null;
  readonly action: string;
  readonly reason: string | null;
  readonly prior_values: unknown;
  readonly new_values: unknown;
  readonly occurred_at: string;
  readonly app_version: string | null;
}

export interface SampleLinkRow {
  readonly id: string;
  readonly upstream_sample_uuid: string;
  readonly downstream_sample_uuid: string;
  readonly link_type: string | null;
  readonly note: string | null;
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

/**
 * Testing status is derived from the capture state rather than stored twice.
 * A second stored column would be a second truth that can disagree.
 */
export const TESTING_STATUSES = ['any', 'awaiting', 'results_in', 'reviewed'] as const;
export type TestingStatus = (typeof TESTING_STATUSES)[number];

export const TESTING_STATUS_LABELS: Record<TestingStatus, string> = {
  any: 'Any testing status',
  awaiting: 'Waiting for test results',
  results_in: 'Results entered, not yet reviewed',
  reviewed: 'Reviewed',
};

const TESTING_STATUS_STATES: Record<TestingStatus, readonly CaptureState[]> = {
  any: [],
  awaiting: ['registered', 'awaiting_results', 'correction_required'],
  results_in: ['ready_for_review'],
  reviewed: ['reviewed'],
};

export interface SampleFilters {
  /** Free text matched against sample ID, batch, lot and run number. */
  readonly text: string;
  readonly stages: readonly Stage[];
  /** Plant-local collection dates, inclusive. Empty string means unbounded. */
  readonly fromDate: string;
  readonly toDate: string;
  readonly material: string;
  readonly supplier: string;
  readonly captureStates: readonly CaptureState[];
  readonly holdOnly: boolean;
  readonly testingStatus: TestingStatus;
}

export const EMPTY_FILTERS: SampleFilters = {
  text: '',
  stages: [],
  fromDate: '',
  toDate: '',
  material: '',
  supplier: '',
  captureStates: [],
  holdOnly: false,
  testingStatus: 'any',
};

export const PAGE_SIZE = 25;

/**
 * PostgREST composes `or=(a.ilike.*x*,b.ilike.*x*)` from a comma-separated
 * list, so a comma, parenthesis or wildcard inside the user's term would
 * change the shape of the filter rather than be matched literally. Strip them;
 * none of them appears in a sample ID, batch, lot or run number.
 */
function sanitiseSearchTerm(raw: string): string {
  return raw.replace(/[,()*%\\]/g, ' ').trim();
}

/**
 * The capture states a filter pair admits.
 *
 * `null` means "do not constrain the column"; an empty array means "no state
 * can satisfy both filters", which is a real answer and not the same thing.
 */
export function resolveCaptureStateFilter(filters: SampleFilters): CaptureState[] | null {
  const explicit = filters.captureStates;
  const derived = TESTING_STATUS_STATES[filters.testingStatus];

  if (explicit.length === 0 && derived.length === 0) return null;
  if (explicit.length === 0) return [...derived];
  if (derived.length === 0) return [...explicit];

  const allowed = new Set<CaptureState>(derived);
  return explicit.filter((s) => allowed.has(s));
}

export interface SampleListResult {
  readonly rows: readonly SampleRow[];
  readonly total: number;
  /** True when the server reported no total, so paging cannot be sized. */
  readonly totalUnknown: boolean;
}

export async function fetchSampleList(
  filters: SampleFilters,
  page: number,
  pageSize: number = PAGE_SIZE,
): Promise<SampleListResult> {
  let query = db
    .from(TABLES.samples)
    .select(SAMPLE_COLUMNS, { count: 'exact' })
    .order('collection_instant', { ascending: false })
    .order('created_at', { ascending: false });

  const term = sanitiseSearchTerm(filters.text);
  if (term.length > 0) {
    query = query.or(
      [
        `sample_id.ilike.%${term}%`,
        `batch_no.ilike.%${term}%`,
        `lot_no.ilike.%${term}%`,
        `run_no.ilike.%${term}%`,
      ].join(','),
    );
  }

  if (filters.stages.length > 0) query = query.in('stage', [...filters.stages]);

  // Plant-local date columns, so a 21:00 Guyana sample filters into its own
  // local day and never into the following UTC day.
  if (filters.fromDate) query = query.gte('collection_local_date', filters.fromDate);
  if (filters.toDate) query = query.lte('collection_local_date', filters.toDate);

  if (filters.material) query = query.eq('material', filters.material);
  if (filters.supplier) query = query.ilike('supplier', `%${sanitiseSearchTerm(filters.supplier)}%`);
  if (filters.holdOnly) query = query.eq('hold_active', true);

  // Capture state and testing status both constrain `capture_state`, so they
  // are INTERSECTED. An empty intersection must return nothing; applying no
  // filter at all would return everything, which is the opposite answer.
  const selected = resolveCaptureStateFilter(filters);
  if (selected !== null) {
    if (selected.length === 0) {
      return { rows: [], total: 0, totalUnknown: false };
    }
    query = query.in('capture_state', selected);
  }

  const from = page * pageSize;
  const { data, error, count } = await query.range(from, from + pageSize - 1);
  if (error) throw new Error(error.message);

  return {
    rows: (data ?? []) as SampleRow[],
    total: count ?? 0,
    totalUnknown: count === null || count === undefined,
  };
}

export function useSampleList(filters: SampleFilters, page: number) {
  return useQuery({
    queryKey: ['samples', 'list', filters, page],
    queryFn: () => fetchSampleList(filters, page),
    // Keeps the previous page on screen while the next one loads, so the table
    // does not collapse to an empty state between pages.
    placeholderData: keepPreviousData,
    staleTime: 15_000,
  });
}

/** Worklist queries. Each is the same data, filtered by the work it needs. */
export function useWorklist(kind: 'awaiting' | 'review' | 'holds', page: number) {
  const filters: SampleFilters =
    kind === 'holds'
      ? { ...EMPTY_FILTERS, holdOnly: true }
      : kind === 'review'
        ? { ...EMPTY_FILTERS, captureStates: ['ready_for_review'] }
        : { ...EMPTY_FILTERS, captureStates: ['registered', 'awaiting_results', 'correction_required'] };

  return useQuery({
    queryKey: ['samples', 'worklist', kind, page],
    queryFn: () => fetchSampleList(filters, page),
    placeholderData: keepPreviousData,
    staleTime: 15_000,
  });
}

/**
 * Every matching sample plus its measurements, for the CSV export.
 *
 * Capped and paged rather than issued as one unbounded query; the cap is
 * reported so the file can say it was truncated instead of looking complete.
 */
export async function fetchSamplesForExport(
  filters: SampleFilters,
  limit: number,
): Promise<{
  rows: readonly SampleRow[];
  measurementsBySample: ReadonlyMap<string, readonly MeasurementRow[]>;
  truncated: boolean;
}> {
  const rows: SampleRow[] = [];
  const chunk = 500;
  let page = 0;
  let truncated = false;

  for (;;) {
    const result = await fetchSampleList(filters, page, chunk);
    rows.push(...result.rows);
    if (result.rows.length < chunk) break;
    if (rows.length >= limit) {
      truncated = true;
      break;
    }
    page += 1;
  }

  const capped = rows.slice(0, limit);
  if (rows.length > capped.length) truncated = true;

  const measurementsBySample = new Map<string, MeasurementRow[]>();
  // PostgREST limits URL length, so the `in` list is sent in batches.
  for (let i = 0; i < capped.length; i += 200) {
    const ids = capped.slice(i, i + 200).map((r) => r.id);
    if (ids.length === 0) continue;
    const { data, error } = await db
      .from(TABLES.measurements)
      .select(
        'id,sample_uuid,field_key,parameter_key,numeric_value,text_value,entered_text,unit,recorded_by_name,recorded_at',
      )
      .in('sample_uuid', ids);
    if (error) throw new Error(error.message);
    for (const m of (data ?? []) as MeasurementRow[]) {
      const list = measurementsBySample.get(m.sample_uuid);
      if (list) list.push(m);
      else measurementsBySample.set(m.sample_uuid, [m]);
    }
  }

  return { rows: capped, measurementsBySample, truncated };
}

/** Distinct material codes present in the data, for the filter dropdown. */
export function useMaterialOptions() {
  return useQuery({
    queryKey: ['samples', 'materials'],
    queryFn: async (): Promise<readonly string[]> => {
      const { data, error } = await db
        .from(TABLES.samples)
        .select('material')
        .not('material', 'is', null)
        .limit(1000);
      if (error) throw new Error(error.message);
      const seen = new Set<string>();
      for (const row of (data ?? []) as { material: string | null }[]) {
        if (row.material) seen.add(row.material);
      }
      return [...seen].sort();
    },
    staleTime: 5 * 60_000,
  });
}

// ---------------------------------------------------------------------------
// Authority of the signed-in user
// ---------------------------------------------------------------------------

export interface CurrentUser {
  readonly id: string;
  readonly email: string | null;
  readonly fullName: string | null;
  readonly status: UserStatus;
  readonly roles: readonly Role[];
  readonly delegations: readonly Delegation[];
}

interface DelegationRow {
  readonly permission: Permission;
  readonly granted_by: string | null;
  readonly effective_from: string;
  readonly effective_to: string | null;
}

async function fetchDelegations(userId: string): Promise<readonly Delegation[]> {
  const { data, error } = await db
    .from(TABLES.delegations)
    .select('permission,granted_by,effective_from,effective_to')
    .eq('user_id', userId);
  if (error) throw new Error(error.message);

  const known = new Set<string>(PERMISSIONS);
  return ((data ?? []) as DelegationRow[])
    // An unrecognised permission string is dropped rather than trusted. Fail
    // closed: a typo or a future permission must not widen what is offered.
    .filter((d) => known.has(d.permission))
    .map((d) => ({
      permission: d.permission,
      grantedBy: d.granted_by ?? 'unknown',
      effectiveFrom: d.effective_from,
      effectiveTo: d.effective_to,
    }));
}

/**
 * The signed-in user's authority, for UX gating only.
 *
 * Identity, roles and status come from the shell's `useAccess()`, so there is
 * one answer in the app to "who is this". This hook adds the one thing that
 * context deliberately omits: the user's RECORDED DELEGATIONS.
 *
 * `useProfile` leaves them out on the reasoning that omitting a grant can only
 * hide a control, which is the safe direction. That holds everywhere except
 * here: `disposition.override_release` is delegation-ONLY, so without the
 * delegation row `can()` is false for everybody and the override-release path
 * — which the disposition dialog has to be able to offer, and to label as an
 * override — would be unreachable UI. The delegation table is read, not
 * trusted: a row the permission list does not recognise is discarded, and the
 * server re-decides every action regardless. Hiding a button is not a control
 * (Master Prompt section 1).
 *
 * While the delegations are still loading, authority falls back to roles
 * alone, so the screen never briefly offers more than it can justify.
 */
export function useAuthority() {
  const access = useAccess();
  const profile = access.profile;

  const query = useQuery({
    queryKey: ['delegations', profile.id],
    queryFn: () => fetchDelegations(profile.id),
    staleTime: 60_000,
  });

  const delegations = query.data ?? [];

  const user: CurrentUser = {
    id: profile.id,
    email: profile.email,
    fullName: profile.fullName,
    status: profile.status,
    roles: profile.roles,
    delegations,
  };

  const authority: AuthorityContext = {
    userId: profile.id,
    roles: profile.roles,
    status: profile.status,
    delegations,
  };

  const allows = useCallback(
    (permission: Permission): boolean => can(authority, permission),
    // `authority` is rebuilt each render from primitives; the delegation list
    // identity is what actually changes the answer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [profile.id, profile.status, profile.roles, delegations],
  );

  return {
    user,
    authority,
    allows,
    /** True while delegated authority is still unknown. */
    delegationsLoading: query.isPending,
    delegationsError: query.error,
  };
}

// ---------------------------------------------------------------------------
// Shared presentation helpers
// ---------------------------------------------------------------------------

export const SYNC_STATE_LABELS: Record<SyncState, string> = {
  not_queued: 'Recorded securely, Google Sheets sync not queued',
  pending: 'Recorded securely, Google Sheets sync pending',
  in_progress: 'Recorded securely, Google Sheets sync in progress',
  confirmed: 'Confirmed in Google Sheets',
  failed: 'Recorded securely, Google Sheets sync failed',
  dead_letter: 'Recorded securely, Google Sheets sync needs attention',
};

/** Only one state may ever be shown as present in the operational sheet. */
export function isSheetConfirmed(state: SyncState): boolean {
  return state === 'confirmed';
}

/**
 * The deployment version, for the export watermark and the audit footer.
 *
 * Read from `import.meta.env` directly rather than through `@/lib/env`, so
 * that importing this module never triggers configuration validation — a
 * missing version degrades to "unknown" instead of throwing.
 */
export function appVersion(): string {
  return import.meta.env.VITE_APP_VERSION ?? 'unknown';
}

export function stageTitle(stage: Stage): string {
  return getSchema(stage).title;
}

export function isStage(value: string): value is Stage {
  return (STAGES as readonly string[]).includes(value);
}

/** Describe a sample's source identity in the vocabulary of its own form. */
export function sourceSummary(row: SampleRow): string {
  const parts: string[] = [];
  if (row.material) parts.push(row.material);
  if (row.feed_type) parts.push(row.feed_type);
  if (row.supplier) parts.push(row.supplier);
  if (row.lot_no) parts.push(`Lot ${row.lot_no}`);
  if (row.batch_no) parts.push(`Batch ${row.batch_no}`);
  if (row.run_no) parts.push(`Run ${row.run_no}`);
  if (row.sampling_point) parts.push(row.sampling_point);
  return parts.length > 0 ? parts.join(' · ') : 'No source details recorded';
}

// ---------------------------------------------------------------------------
// Report data
// ---------------------------------------------------------------------------

/** How far back "updated recently" looks. Stated in the metric declaration. */
export const RECENT_WINDOW_HOURS = 24;

/**
 * Count rows matching a filter without transferring them.
 *
 * Returns a `CountSource`, so a query that FAILED is distinguishable from one
 * that legitimately counted zero. The reporting module refuses to render the
 * first as "0" (PRD section 12).
 */
async function countRows(
  build: (q: ReturnType<typeof buildCountQuery>) => ReturnType<typeof buildCountQuery>,
  describeFailure: string,
): Promise<CountSource> {
  const { count, error } = await build(buildCountQuery());
  if (error) return unavailable(`${describeFailure}: ${error.message}`);
  if (count === null || count === undefined) {
    return unavailable(`${describeFailure}: the server did not report a total.`);
  }
  return counted(count);
}

function buildCountQuery() {
  return db.from(TABLES.samples).select('id', { count: 'exact', head: true });
}

const COLLECTED_CAPTURE_STATES: readonly CaptureState[] = [
  'registered',
  'awaiting_results',
  'ready_for_review',
  'reviewed',
  'correction_required',
];

export interface OperationsReportData {
  readonly plantDate: string;
  readonly todayFacts: readonly SampleFact[] | null;
  readonly awaitingResults: CountSource;
  readonly readyForReview: CountSource;
  readonly onHold: CountSource;
  readonly recentlyUpdated: CountSource;
  readonly recentWindowHours: number;
}

/**
 * The five MVP operations widgets.
 *
 * Each count is issued as its own query so one failure does not take the
 * others' numbers with it — and a failed one reports its reason rather than a
 * zero.
 */
export function useOperationsReport() {
  return useQuery({
    queryKey: ['reports', 'operations'],
    queryFn: async (): Promise<OperationsReportData> => {
      const plantDate = plantLocalDate(new Date());
      const since = new Date(Date.now() - RECENT_WINDOW_HOURS * 60 * 60_000).toISOString();

      // The day breakdown needs rows, not a count, because it is grouped by
      // stage. Filtered on the plant-LOCAL date column, so a 21:00 Guyana
      // sample counts in its own Guyana day.
      const todayPromise = db
        .from(TABLES.samples)
        .select('id,stage,collection_instant,capture_state,disposition,hold_active,updated_at')
        .eq('collection_local_date', plantDate)
        .in('capture_state', [...COLLECTED_CAPTURE_STATES])
        .limit(2000);

      const [today, awaitingResults, readyForReview, onHold, recentlyUpdated] = await Promise.all([
        todayPromise,
        countRows(
          (q) => q.in('capture_state', ['registered', 'awaiting_results', 'correction_required']),
          'The waiting-for-results count could not be read',
        ),
        countRows(
          (q) => q.eq('capture_state', 'ready_for_review'),
          'The ready-for-review count could not be read',
        ),
        countRows((q) => q.eq('hold_active', true), 'The on-hold count could not be read'),
        countRows(
          (q) => q.gte('updated_at', since),
          'The recently-updated count could not be read',
        ),
      ]);

      const todayFacts: readonly SampleFact[] | null = today.error
        ? null
        : ((today.data ?? []) as {
            id: string;
            stage: Stage;
            collection_instant: string;
            capture_state: CaptureState;
            disposition: Disposition;
            hold_active: boolean;
            updated_at: string;
          }[]).map((row) => ({
            id: row.id,
            stage: row.stage,
            collectionInstant: row.collection_instant,
            captureState: row.capture_state,
            disposition: row.disposition,
            holdActive: row.hold_active,
            updatedAt: row.updated_at,
          }));

      return {
        plantDate,
        todayFacts,
        awaitingResults,
        readyForReview,
        onHold,
        recentlyUpdated,
        recentWindowHours: RECENT_WINDOW_HOURS,
      };
    },
    staleTime: 30_000,
  });
}
