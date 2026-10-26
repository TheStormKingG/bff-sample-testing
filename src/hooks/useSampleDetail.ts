/**
 * One sample, everything about it.
 *
 * Assessments are computed here from `src/lib/assessment.ts` against the
 * APPROVED rules in `specification_versions`. On the seeded production dataset
 * that set is empty, so every measurement comes back `not_assessable` — the
 * correct behaviour, not a defect (FR-009, UAT-05, risk R-01).
 *
 * The three concepts stay separate throughout: capture state (is the record
 * complete), assessment (is a measurement inside an approved limit) and
 * disposition (what an authorised person decided). Nothing here can produce an
 * acceptance; only `checkDisposition` can authorise one.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { SupabaseClient } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';
import type { FieldDef, Stage } from '@/forms/types';
import { getField, getSchema, isFieldApplicable } from '@/forms/registry';
import {
  assess,
  holdTriggers,
  type Assessment,
  type HoldTrigger,
  type MeasurementContext,
  type SpecificationRule,
} from '@/lib/assessment';
import { evaluateRelease, type ReleaseEvaluation } from '@/lib/workflow';
import { newIdempotencyKey } from '@/hooks/useRegisterSample';
import {
  FUNCTIONS,
  TABLES,
  SAMPLE_COLUMNS,
  SPECIFICATION_VERSION_COLUMNS,
  toSampleRow,
  toSpecificationVersionRow,
  type AuditEventRow,
  type MeasurementRow,
  type SampleDbRow,
  type SampleRow,
  type SpecificationVersionDbRow,
  type SpecificationVersionRow,
} from '@/hooks/useSamples';

const db = supabase as unknown as SupabaseClient;

/**
 * Whether a confirmed Google Sheets row is a precondition for release.
 *
 * Master Prompt §7 permits this as a gate but does not impose it, and no
 * Bounty Farm rule has been approved either way (PRD open questions). It is
 * therefore OFF, and turning it on is a recorded process-owner decision rather
 * than a code default that quietly blocks the plant.
 */
export const REQUIRE_SHEET_CONFIRMATION_FOR_RELEASE = false;

export interface HoldRow {
  readonly id: string;
  readonly sample_uuid: string;
  /**
   * DERIVED, not stored: a hold stands until somebody with clearing authority
   * records a `cleared_at`. See `toHoldRow` — that is the one place this is
   * computed, deliberately, because a second derivation could disagree and the
   * permissive answer releases held material.
   */
  readonly active: boolean;
  readonly trigger_kind: string | null;
  readonly field_key: string | null;
  /** The reason the hold was RAISED (`holds.raise_reason`). */
  readonly reason: string | null;
  /** A profile id, not a name: `holds` records no name. See `toHoldRow`. */
  readonly raised_by_name: string | null;
  readonly raised_at: string;
  /** A profile id, not a name: `holds` records no name. See `toHoldRow`. */
  readonly cleared_by_name: string | null;
  readonly cleared_at: string | null;
  readonly clear_reason: string | null;
}

/** One row of the measurement table: value, unit and its assessment. */
export interface MeasurementView {
  readonly field: FieldDef;
  /** Null means not measured. Zero is a real measured value. */
  readonly value: number | null;
  /** Exactly what the operator typed, so trailing zeros survive. */
  readonly displayText: string;
  readonly unit: string | null;
  /** Null when the field carries no specification parameter at all. */
  readonly assessment: Assessment | null;
  readonly applicable: boolean;
  /** Required before the sample can move to review. */
  readonly requiredForReview: boolean;
  readonly recordedByName: string | null;
  readonly recordedAt: string | null;
}

export interface SampleDetail {
  readonly sample: SampleRow;
  /** Every operator-visible field of the stage, in registry (column) order. */
  readonly allFields: readonly MeasurementView[];
  readonly measurements: readonly MeasurementView[];
  readonly observations: readonly MeasurementView[];
  readonly holds: readonly HoldRow[];
  readonly activeHold: HoldRow | null;
  readonly holdTriggers: readonly HoldTrigger[];
  readonly events: readonly AuditEventRow[];
  readonly upstream: readonly SampleRow[];
  readonly downstream: readonly SampleRow[];
  readonly missingLinkNote: string | null;
  readonly release: ReleaseEvaluation;
  readonly approvedRuleCount: number;
  readonly referenceRuleCount: number;
}

// ---------------------------------------------------------------------------
// What Postgres returns, and how it maps onto the shapes this slice exports
// ---------------------------------------------------------------------------
/*
 * The exported interfaces are the contract the pages compile against. The
 * interfaces below are what the tables actually hold. They used to be assumed
 * identical, and a `.select()` string that had drifted from the schema is how
 * a screen came to error in front of an operator: the string is checked by
 * nothing the build runs. So the two shapes are now written out separately and
 * joined by one explicit mapping function per table, which is also the only
 * place a derivation or a missing column can hide.
 *
 * Every select list below stays an INLINE LITERAL.
 * `scripts/check-frontend-schema.py` can only read inline literals, so
 * hoisting one into a `const SELECT = '...'` would remove the call site from
 * the check while leaving the risk exactly where it was.
 */

interface MeasurementDbRow {
  readonly id: string;
  readonly sample_uuid: string;
  readonly field_key: string;
  readonly numeric_value: number | null;
  readonly text_value: string | null;
  readonly entered_text: string | null;
  readonly unit: string | null;
  readonly recorded_by: string | null;
  readonly recorded_at: string | null;
}

function toMeasurementRow(stage: Stage, row: MeasurementDbRow): MeasurementRow {
  return {
    id: row.id,
    sample_uuid: row.sample_uuid,
    field_key: row.field_key,
    // Not a column and not missing data: the parameter key is a property of
    // the FIELD, held once in `src/forms/registry.ts`. Storing it per reading
    // would be a second copy that can disagree with the registry.
    parameter_key: getField(stage, row.field_key)?.parameterKey ?? null,
    numeric_value: row.numeric_value,
    text_value: row.text_value,
    entered_text: row.entered_text,
    unit: row.unit,
    // An id, not a name: `sample_measurements` records `recorded_by` only.
    // The id is passed through rather than nulled because `MeasurementTable`
    // drops the actor entirely when this is null, and a quality record that
    // silently loses who took the reading is worse than one showing an
    // identifier. A `profiles.display_name` join is the real fix.
    recorded_by_name: row.recorded_by,
    recorded_at: row.recorded_at,
  };
}

interface HoldDbRow {
  readonly id: string;
  readonly sample_uuid: string;
  readonly trigger_kind: string | null;
  readonly field_key: string | null;
  readonly raise_reason: string | null;
  readonly raised_by: string;
  readonly raised_at: string;
  readonly cleared_by: string | null;
  readonly cleared_at: string | null;
  readonly clear_reason: string | null;
}

function toHoldRow(row: HoldDbRow): HoldRow {
  return {
    id: row.id,
    sample_uuid: row.sample_uuid,
    // THE definition of an active hold, and the only one in this slice.
    // `holds` stores no flag: the hold stands until a `cleared_at` is written
    // by someone with clearing authority. Getting this wrong permissively
    // would drop the banner on held material, so it is computed once, here,
    // and every reader goes through `HoldRow.active`.
    active: row.cleared_at === null,
    trigger_kind: row.trigger_kind,
    field_key: row.field_key,
    // `raise_reason`, never `clear_reason`: this field is why the hold exists.
    reason: row.raise_reason,
    // Ids, not names: `holds` carries no name columns. Nulling these would
    // make `HoldBanner` print "Not recorded" for an actor the database
    // requires and has recorded, which is a false statement on an alert
    // banner. Shown as an identifier until a `profiles` join exists.
    raised_by_name: row.raised_by,
    raised_at: row.raised_at,
    cleared_by_name: row.cleared_by,
    cleared_at: row.cleared_at,
    clear_reason: row.clear_reason,
  };
}

interface AuditEventDbRow {
  readonly event_uuid: string;
  readonly sample_uuid: string | null;
  readonly actor_id: string | null;
  readonly actor_email: string | null;
  readonly action: string;
  readonly reason: string | null;
  readonly before_payload: unknown;
  readonly after_payload: unknown;
  readonly occurred_at: string;
  readonly deployment_version: string | null;
}

function toAuditEventRow(row: AuditEventDbRow): AuditEventRow {
  return {
    // `audit_events` is keyed by `seq` with `event_uuid` as its stable public
    // identifier; the uuid is what a reader can quote back.
    id: row.event_uuid,
    sample_uuid: row.sample_uuid,
    actor_id: row.actor_id,
    // No name column. The email identifies the actor truthfully, and
    // `AuditTimeline` would otherwise print "Actor not recorded" against an
    // event whose actor the audit row does record.
    actor_name: row.actor_email,
    action: row.action,
    reason: row.reason,
    prior_values: row.before_payload,
    new_values: row.after_payload,
    occurred_at: row.occurred_at,
    app_version: row.deployment_version,
  };
}

/**
 * A `sample_links` row as stored.
 *
 * DIRECTION IS CARRIED BY `link_type`, read relative to `from_sample` — not by
 * the column order. `register_sample` writes (`upstream`, from = the sample
 * being registered, to = the sample it came from), so the `to_sample` of an
 * `upstream` row is that sample's UPSTREAM. Reading `from_sample` as "the
 * upstream one" would reverse every traceability chain on the screen while
 * still rendering cleanly, which is worse than failing to load.
 *
 * `to_sample` is null on exactly one kind of row — a `traceability_exception`,
 * which records that no counterpart could be identified, and why. A recorded
 * exception and an absent row are different facts and are stored differently
 * (PRD section 6.4), so this type is kept local rather than mapped onto
 * `SampleLinkRow`, whose non-null `downstream_sample_uuid` cannot hold one.
 */
interface SampleLinkDbRow {
  readonly id: string;
  readonly link_type: 'upstream' | 'downstream' | 'traceability_exception';
  readonly from_sample: string;
  readonly to_sample: string | null;
  readonly relationship: string;
  readonly match_basis: string | null;
  readonly exception_reason: string | null;
}

function toRule(row: SpecificationVersionRow): SpecificationRule {
  return {
    id: row.id,
    version: row.version,
    parameterKey: row.parameter_key,
    stage: row.stage,
    material: row.material,
    feedType: row.feed_type,
    samplingPoint: row.sampling_point,
    testMethod: row.test_method,
    unit: row.unit,
    lowerBound: row.lower_bound,
    upperBound: row.upper_bound,
    // `assess()` admits only 'approved' with a recorded approver, so a
    // reference_only row passed through here still cannot decide anything.
    status: row.status as SpecificationRule['status'],
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
    approvedBy: row.approved_by,
  };
}

/**
 * The value map `isFieldApplicable` and the sample-ID prefix rules read.
 * Sample columns are included because applicability keys off `sampling_point`,
 * which lives on the sample rather than in a measurement row.
 */
function buildValueMap(
  sample: SampleRow,
  measurements: readonly MeasurementRow[],
): Record<string, unknown> {
  const values: Record<string, unknown> = {
    sampling_point: sample.sampling_point,
    material: sample.material,
    feed_type: sample.feed_type,
    supplier: sample.supplier,
    batch_no: sample.batch_no,
    lot_no: sample.lot_no,
    run_no: sample.run_no,
  };
  for (const m of measurements) {
    values[m.field_key] = m.numeric_value ?? m.text_value ?? null;
  }
  return values;
}

function viewFor(
  field: FieldDef,
  sample: SampleRow,
  row: MeasurementRow | undefined,
  values: Record<string, unknown>,
  rules: readonly SpecificationRule[],
): MeasurementView {
  const applicable = isFieldApplicable(field, values);
  const numeric = row?.numeric_value ?? null;
  const text = row?.text_value ?? null;
  const entered = row?.entered_text ?? null;

  const displayText =
    entered !== null && entered !== ''
      ? entered
      : numeric !== null
        ? String(numeric)
        : (text ?? '');

  const unit = row?.unit ?? field.unit ?? null;

  let assessment: Assessment | null = null;
  if (field.parameterKey !== undefined) {
    const ctx: MeasurementContext = {
      stage: sample.stage,
      parameterKey: field.parameterKey,
      value: numeric,
      unit,
      // The registry flags an unconfirmed unit; absent means confirmed.
      unitConfirmed: field.unitConfirmed !== false,
      applicable,
      material: sample.material,
      feedType: sample.feed_type,
      samplingPoint: sample.sampling_point,
      testMethod: null,
      collectionInstant: sample.collection_instant,
    };
    assessment = assess(ctx, rules);
  }

  return {
    field,
    value: numeric,
    displayText,
    unit,
    assessment,
    applicable,
    requiredForReview: field.required === 'testing' && applicable,
    recordedByName: row?.recorded_by_name ?? null,
    recordedAt: row?.recorded_at ?? null,
  };
}

/*
 * `samples` rows go through `toSampleRow` from `useSamples.ts` rather than
 * being cast here. That translation is not a rename: it routes ONE
 * `source_reference` column onto lot / batch / run by stage, prefers a
 * supplier label over its code, and refuses to resolve an unknown sync state
 * to `confirmed`. A second copy of those decisions in this file would be a
 * second answer that can disagree about which identifier a reader is looking
 * at, on a record whose point is traceability.
 */
async function fetchSampleRows(ids: readonly string[]): Promise<SampleRow[]> {
  if (ids.length === 0) return [];
  const { data, error } = await db.from(TABLES.samples).select(SAMPLE_COLUMNS).in('id', [...ids]);
  if (error) throw new Error(error.message);
  return ((data ?? []) as SampleDbRow[]).map(toSampleRow);
}

export async function fetchSampleDetail(sampleUuid: string): Promise<SampleDetail> {
  const sampleRes = await db
    .from(TABLES.samples)
    .select(SAMPLE_COLUMNS)
    .eq('id', sampleUuid)
    .maybeSingle();
  if (sampleRes.error) throw new Error(sampleRes.error.message);
  const sampleDbRow = sampleRes.data as SampleDbRow | null;
  const sample = sampleDbRow === null ? null : toSampleRow(sampleDbRow);
  if (!sample) throw new Error('That sample could not be found, or you are not permitted to see it.');

  const [measurementRes, specRes, holdRes, eventRes, linkRes] = await Promise.all([
    db
      .from(TABLES.measurements)
      .select(
        'id,sample_uuid,field_key,numeric_value,text_value,entered_text,unit,recorded_by,recorded_at',
      )
      .eq('sample_uuid', sampleUuid),
    db
      .from(TABLES.specificationVersions)
      .select(SPECIFICATION_VERSION_COLUMNS)
      .eq('stage', sample.stage),
    db
      .from(TABLES.holds)
      .select(
        'id,sample_uuid,trigger_kind,field_key,raise_reason,raised_by,raised_at,cleared_by,cleared_at,clear_reason',
      )
      .eq('sample_uuid', sampleUuid)
      .order('raised_at', { ascending: false }),
    db
      .from(TABLES.auditEvents)
      .select(
        'event_uuid,sample_uuid,actor_id,actor_email,action,reason,before_payload,after_payload,occurred_at,deployment_version',
      )
      .eq('sample_uuid', sampleUuid)
      .order('occurred_at', { ascending: false })
      .limit(200),
    db
      .from(TABLES.links)
      .select('id,link_type,from_sample,to_sample,relationship,match_basis,exception_reason')
      .or(`from_sample.eq.${sampleUuid},to_sample.eq.${sampleUuid}`),
  ]);

  if (measurementRes.error) throw new Error(measurementRes.error.message);
  if (specRes.error) throw new Error(specRes.error.message);
  if (holdRes.error) throw new Error(holdRes.error.message);
  if (eventRes.error) throw new Error(eventRes.error.message);
  if (linkRes.error) throw new Error(linkRes.error.message);

  const measurementRows = ((measurementRes.data ?? []) as MeasurementDbRow[]).map((row) =>
    toMeasurementRow(sample.stage, row),
  );
  const specRows = ((specRes.data ?? []) as SpecificationVersionDbRow[]).map(
    toSpecificationVersionRow,
  );
  const holds = ((holdRes.data ?? []) as HoldDbRow[]).map(toHoldRow);
  const events = ((eventRes.data ?? []) as AuditEventDbRow[]).map(toAuditEventRow);
  const links = (linkRes.data ?? []) as SampleLinkDbRow[];

  const rules = specRows.map(toRule);
  const approvedRuleCount = specRows.filter(
    (r) => r.status === 'approved' && r.approved_by !== null,
  ).length;
  const referenceRuleCount = specRows.filter((r) => r.status === 'reference_only').length;

  const byKey = new Map<string, MeasurementRow>();
  for (const m of measurementRows) byKey.set(m.field_key, m);
  const values = buildValueMap(sample, measurementRows);

  const schema = getSchema(sample.stage);
  const views = schema.fields
    .filter((f) => f.type !== 'system')
    .map((f) => viewFor(f, sample, byKey.get(f.key), values, rules));

  const measurements = views.filter((v) => v.field.parameterKey !== undefined);
  const observations = views.filter((v) => v.field.adverseValue !== undefined);

  const triggers = holdTriggers({
    observations: observations.map((v) => ({
      fieldKey: v.field.key,
      label: v.field.label,
      value: v.displayText === '' ? null : v.displayText,
      adverseValue: v.field.adverseValue ?? 'yes',
    })),
    assessments: measurements
      .filter((v): v is MeasurementView & { assessment: Assessment } => v.assessment !== null)
      .map((v) => ({ fieldKey: v.field.key, label: v.field.label, assessment: v.assessment })),
  });

  // Ordered newest-first above, so this is the most recent uncleared hold.
  const activeHold = holds.find((h) => h.active) ?? null;

  const release = evaluateRelease({
    // Two sources on purpose, combined with OR. The sample's own flag and an
    // uncleared `holds` row should agree; if they ever do not, the release gate
    // must take the restrictive answer, because the permissive one releases
    // material that something in the record says is held.
    holdActive: sample.hold_active || activeHold !== null,
    holdDetail: activeHold?.reason ?? undefined,
    assessments: measurements
      .filter((v): v is MeasurementView & { assessment: Assessment } => v.assessment !== null)
      .map((v) => ({
        fieldKey: v.field.key,
        label: v.field.label,
        required: v.requiredForReview,
        assessment: v.assessment,
      })),
    requireSheetConfirmation: REQUIRE_SHEET_CONFIRMATION_FOR_RELEASE,
    sheetConfirmed: sample.sync_state === 'confirmed',
  });

  // `link_type` names the role of `to_sample` relative to `from_sample`, so a
  // single row places this sample on one side or the other depending on which
  // column it appears in. Nothing writes `downstream` today; it is read under
  // the same convention rather than dropped, because a real link silently
  // ignored looks identical to a missing one on the screen.
  const upstreamIds: string[] = [];
  const downstreamIds: string[] = [];
  for (const l of links) {
    if (l.to_sample === null) continue; // a recorded exception, not a link
    if (l.link_type === 'upstream') {
      if (l.from_sample === sampleUuid) upstreamIds.push(l.to_sample);
      else if (l.to_sample === sampleUuid) downstreamIds.push(l.from_sample);
    } else if (l.link_type === 'downstream') {
      if (l.from_sample === sampleUuid) downstreamIds.push(l.to_sample);
      else if (l.to_sample === sampleUuid) upstreamIds.push(l.from_sample);
    }
  }

  const [upstream, downstream] = await Promise.all([
    fetchSampleRows(upstreamIds),
    fetchSampleRows(downstreamIds),
  ]);

  // PRD §6.4: a missing upstream link is a RECORDED exception, never an
  // inferred match. Where the registrar recorded why no counterpart could be
  // identified, that stored reason is shown in preference to the generic
  // sentence: it names what could not be resolved, which is the fact an
  // auditor needs. Stage 1 legitimately has no upstream.
  const exceptionReasons = links
    .filter((l) => l.link_type === 'traceability_exception' && l.from_sample === sampleUuid)
    .map((l) => l.exception_reason)
    .filter((reason): reason is string => reason !== null && reason.trim() !== '');

  const missingLinkNote =
    exceptionReasons.length > 0
      ? exceptionReasons.join(' ')
      : upstream.length === 0 && sample.stage !== 'raw_materials'
        ? 'No upstream sample is linked to this record. That is a traceability exception to resolve, not a match the system can infer.'
        : null;

  return {
    sample,
    allFields: views,
    measurements,
    observations,
    holds,
    activeHold,
    holdTriggers: triggers,
    events,
    upstream,
    downstream,
    missingLinkNote,
    release,
    approvedRuleCount,
    referenceRuleCount,
  };
}

export function useSampleDetail(sampleUuid: string | undefined) {
  return useQuery({
    queryKey: ['sample', sampleUuid],
    queryFn: () => fetchSampleDetail(sampleUuid as string),
    enabled: typeof sampleUuid === 'string' && sampleUuid.length > 0,
    // Quality decisions must never be shown from stale cache as current.
    staleTime: 0,
    refetchOnWindowFocus: true,
  });
}

/** Resolve a human sample ID (`RM-261024-01`) to its UUID. */
export function useSampleByHumanId(sampleId: string | undefined) {
  return useQuery({
    queryKey: ['sample', 'by-human-id', sampleId],
    queryFn: async (): Promise<SampleRow | null> => {
      const { data, error } = await db
        .from(TABLES.samples)
        .select(SAMPLE_COLUMNS)
        .eq('sample_id', sampleId as string)
        .maybeSingle();
      if (error) throw new Error(error.message);
      const row = data as SampleDbRow | null;
      return row === null ? null : toSampleRow(row);
    },
    enabled: typeof sampleId === 'string' && sampleId.length > 0,
  });
}

// ---------------------------------------------------------------------------
// Mutations — every one is an authenticated Edge Function call
// ---------------------------------------------------------------------------

export type SampleActionKind =
  | 'review'
  | 'request_correction'
  | 'raise_hold'
  | 'clear_hold'
  | 'disposition';

export interface SampleActionInput {
  readonly action: SampleActionKind;
  readonly sampleUuid: string;
  /** Optimistic concurrency: the server rejects a stale write (PRD §6.1). */
  readonly expectedRevision: number;
  readonly reason?: string;
  /** For `disposition`. */
  readonly decision?: string;
  /** True when the caller has been told the decision records an override. */
  readonly acknowledgedOverride?: boolean;
  readonly fieldKey?: string;
  /**
   * The key the server replays a retry under.
   *
   * NOT OPTIONAL ON THE WIRE, only in this type. `runMutation` resolves
   * `ctx.idempotencyKey ?? body['idempotencyKey'] ?? body['idempotency_key']`
   * and refuses the request with `bad_request` if none of the three is a valid
   * key — and it does so BEFORE `authenticate()`, before the permission check
   * and before the handler runs. This hook sent none at all, so every sample
   * decision it posted was refused at that first line: not "a replay could
   * duplicate a record", but "the review, the hold, the correction request and
   * the disposition never worked". `useAdminAction` carries a comment
   * recording the identical discovery for the administrative actions.
   *
   * A key is therefore generated per call when the caller supplies none, which
   * is what every existing call site relies on. A caller that must be able to
   * retry THE SAME act — one the operator has already been told succeeded, say
   * — passes its own key, so the second request replays the first outcome
   * instead of performing a second act (PRD §10.3).
   */
  readonly idempotencyKey?: string;
}

export interface SampleActionResult {
  readonly ok: boolean;
  readonly sampleUuid: string;
  readonly revision: number;
  readonly message: string;
}

/**
 * The server is the authority. A denial here is reported verbatim rather than
 * reworded, because the wording carries the reason an auditor needs.
 */
export function useSampleAction() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: SampleActionInput): Promise<SampleActionResult> => {
      // Generated here rather than in the component, so no call site can omit
      // it. `newIdempotencyKey` throws where the browser has no secure random
      // source; inside the mutation function that becomes a reported failure
      // naming the cause, instead of a throw out of a click handler.
      const { idempotencyKey, ...rest } = input;
      const key = idempotencyKey ?? newIdempotencyKey();
      const { data, error } = await db.functions.invoke(FUNCTIONS.sampleAction, {
        // The header is the primary carrier; the body field is the documented
        // fallback for a proxy that strips custom headers. `NON_PAYLOAD_KEYS`
        // in `adapters/mutation.ts` excludes `idempotencyKey` from the payload
        // hash, so sending both cannot manufacture an idempotency conflict.
        body: { ...rest, idempotencyKey: key },
        headers: { 'Idempotency-Key': key },
      });
      if (error) throw new Error(error.message);
      const result = data as SampleActionResult | null;
      if (!result) throw new Error('The server returned no result. The action was not recorded.');
      if (!result.ok) throw new Error(result.message);
      return result;
    },
    onSuccess: (result) => {
      void client.invalidateQueries({ queryKey: ['sample', result.sampleUuid] });
      void client.invalidateQueries({ queryKey: ['samples'] });
      void client.invalidateQueries({ queryKey: ['reports'] });
    },
  });
}
