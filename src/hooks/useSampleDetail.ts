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
import type { FieldDef } from '@/forms/types';
import { getSchema, isFieldApplicable } from '@/forms/registry';
import {
  assess,
  holdTriggers,
  type Assessment,
  type HoldTrigger,
  type MeasurementContext,
  type SpecificationRule,
} from '@/lib/assessment';
import { evaluateRelease, type ReleaseEvaluation } from '@/lib/workflow';
import {
  FUNCTIONS,
  TABLES,
  SAMPLE_COLUMNS,
  type AuditEventRow,
  type MeasurementRow,
  type SampleLinkRow,
  type SampleRow,
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
  readonly active: boolean;
  readonly trigger_kind: string | null;
  readonly field_key: string | null;
  readonly reason: string | null;
  readonly raised_by_name: string | null;
  readonly raised_at: string;
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

async function fetchSampleRows(ids: readonly string[]): Promise<SampleRow[]> {
  if (ids.length === 0) return [];
  const { data, error } = await db.from(TABLES.samples).select(SAMPLE_COLUMNS).in('id', [...ids]);
  if (error) throw new Error(error.message);
  return (data ?? []) as SampleRow[];
}

export async function fetchSampleDetail(sampleUuid: string): Promise<SampleDetail> {
  const sampleRes = await db
    .from(TABLES.samples)
    .select(SAMPLE_COLUMNS)
    .eq('id', sampleUuid)
    .maybeSingle();
  if (sampleRes.error) throw new Error(sampleRes.error.message);
  const sample = sampleRes.data as SampleRow | null;
  if (!sample) throw new Error('That sample could not be found, or you are not permitted to see it.');

  const [measurementRes, specRes, holdRes, eventRes, linkRes] = await Promise.all([
    db
      .from(TABLES.measurements)
      .select(
        'id,sample_uuid,field_key,parameter_key,numeric_value,text_value,entered_text,unit,recorded_by_name,recorded_at',
      )
      .eq('sample_uuid', sampleUuid),
    db
      .from(TABLES.specificationVersions)
      .select(
        'id,specification_id,version,parameter_key,stage,material,feed_type,sampling_point,test_method,unit,lower_bound,upper_bound,status,effective_from,effective_to,proposed_by,proposed_by_name,approved_by,approved_by_name,approved_at,source_note,workbook_entry_no,workbook_status,sample_label,test_label',
      )
      .eq('stage', sample.stage),
    db
      .from(TABLES.holds)
      .select(
        'id,sample_uuid,active,trigger_kind,field_key,reason,raised_by_name,raised_at,cleared_by_name,cleared_at,clear_reason',
      )
      .eq('sample_uuid', sampleUuid)
      .order('raised_at', { ascending: false }),
    db
      .from(TABLES.auditEvents)
      .select('id,sample_uuid,actor_id,actor_name,action,reason,prior_values,new_values,occurred_at,app_version')
      .eq('sample_uuid', sampleUuid)
      .order('occurred_at', { ascending: false })
      .limit(200),
    db
      .from(TABLES.links)
      .select('id,upstream_sample_uuid,downstream_sample_uuid,link_type,note')
      .or(`upstream_sample_uuid.eq.${sampleUuid},downstream_sample_uuid.eq.${sampleUuid}`),
  ]);

  if (measurementRes.error) throw new Error(measurementRes.error.message);
  if (specRes.error) throw new Error(specRes.error.message);
  if (holdRes.error) throw new Error(holdRes.error.message);
  if (eventRes.error) throw new Error(eventRes.error.message);
  if (linkRes.error) throw new Error(linkRes.error.message);

  const measurementRows = (measurementRes.data ?? []) as MeasurementRow[];
  const specRows = (specRes.data ?? []) as SpecificationVersionRow[];
  const holds = (holdRes.data ?? []) as HoldRow[];
  const events = (eventRes.data ?? []) as AuditEventRow[];
  const links = (linkRes.data ?? []) as SampleLinkRow[];

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

  const activeHold = holds.find((h) => h.active) ?? null;

  const release = evaluateRelease({
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

  const upstreamIds = links
    .filter((l) => l.downstream_sample_uuid === sampleUuid)
    .map((l) => l.upstream_sample_uuid);
  const downstreamIds = links
    .filter((l) => l.upstream_sample_uuid === sampleUuid)
    .map((l) => l.downstream_sample_uuid);

  const [upstream, downstream] = await Promise.all([
    fetchSampleRows(upstreamIds),
    fetchSampleRows(downstreamIds),
  ]);

  // PRD §6.4: a missing upstream link is a recorded exception, never an
  // inferred match. Stage 1 legitimately has no upstream.
  const missingLinkNote =
    upstream.length === 0 && sample.stage !== 'raw_materials'
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
      return (data ?? null) as SampleRow | null;
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
      const { data, error } = await db.functions.invoke(FUNCTIONS.sampleAction, { body: input });
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
