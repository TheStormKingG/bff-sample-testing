/**
 * POST /set-disposition — record what an authorised person decided about the
 * material.
 *
 * FR-012 and PRD §6.2: capture state, assessment and disposition are three
 * separate things, and only a named authorised actor can produce a
 * disposition. Nothing in this endpoint can manufacture an acceptance.
 *
 * The authority rules enforced here are the ones in `src/lib/workflow.ts`
 * (`checkDisposition`), re-applied server-side because build rule 3 says a
 * hidden UI button is not a control:
 *
 *   - An ADMINISTRATOR cannot accept, reject, rework or release. The
 *     administrator role holds no `disposition.*` and no `hold.*` permission
 *     at all (src/lib/roles.ts), so `requirePermission` denies it and logs the
 *     attempt. There is no special-case branch for it, which is the point: the
 *     matrix is the policy.
 *   - A QUALITY OFFICER may RAISE a hold (`hold.raise`) but not clear one
 *     (`hold.clear`).
 *   - ACCEPTING a held sample is refused outright. The hold must be cleared by
 *     `hold.clear` authority through its own audited action first; an
 *     acceptance is never a back door around hold-clearing authority.
 *   - Accepting over outstanding findings requires `disposition.override_release`,
 *     which NO role holds as a base grant — it is delegation-only — and the
 *     decision is then recorded as an OVERRIDE, never as a clean acceptance.
 *   - Every decision requires a written reason.
 *
 * WHERE THE DECISION INPUTS COME FROM.
 *
 * The release evaluation is built from STORED STATE read here with the
 * service-role client — the sample's `hold_flag`, its current measurements and
 * their stored assessment results — and not from anything in the request body.
 * A client that claimed "no outstanding findings" would otherwise turn an
 * override into a clean acceptance, which is the single most damaging lie this
 * endpoint could be told. The transaction re-evaluates the same question under
 * its own lock and raises `BFF_FORBIDDEN` if it disagrees, so this read is the
 * early, explainable refusal and the RPC is the authority.
 *
 * `undetermined` is not accepted as a decision. It is the initial state of a
 * sample, not something anybody decides, and `checkDisposition` maps it to no
 * permission at all — so accepting it here would let any signed-in user move a
 * held sample out of `on_hold` with no hold-clearing authority.
 */

import { ApiError } from '../errors.ts';
import {
  callTransaction,
  readString,
  requireExpectedRevision,
  type MutationSpec,
} from '../adapters/mutation.ts';
import { RPC, type MutationResult, type SampleSyncStateRow } from '../rpc.ts';
import { asOutboxState } from '../outbox.ts';
import { syncStatusFor } from '../syncStatus.ts';
import { recordAudit, requirePermission } from '../adapters/authorize.ts';
import { optionalEnv } from '../adapters/env.ts';
import { assessableFields, isFieldApplicable, STAGE_SCHEMAS } from '../../../../src/forms/registry.ts';
import { STAGES, type Stage } from '../../../../src/forms/types.ts';
import {
  checkDisposition,
  DISPOSITIONS,
  DISPOSITION_LABELS,
  evaluateRelease,
  type Disposition,
  type ReleaseEvaluation,
} from '../../../../src/lib/workflow.ts';
import {
  ASSESSMENT_RESULTS,
  type Assessment,
  type AssessmentReason,
  type AssessmentResult,
} from '../../../../src/lib/assessment.ts';
import type { Permission } from '../../../../src/lib/roles.ts';
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.47.10';

/**
 * Decision -> permission, mirroring DISPOSITION_PERMISSION in
 * src/lib/workflow.ts. It is restated rather than imported because that
 * constant is private to the module; the authority test below is
 * `checkDisposition` itself, and this map only picks which permission to name
 * in the audit event when the check fails.
 */
const DECISION_PERMISSION: Readonly<Record<Exclude<Disposition, 'undetermined'>, Permission>> = {
  on_hold: 'hold.raise',
  accepted: 'disposition.accept',
  rejected: 'disposition.reject',
  rework_required: 'disposition.rework',
  released_by_authorized_override: 'disposition.override_release',
};

/**
 * Decisions that take a sample OUT of a hold.
 *
 * Moving a held sample to any of these ends the hold, so it needs
 * hold-clearing authority in addition to the disposition permission. Without
 * this, a Quality Officer holding only `hold.raise` and a delegated
 * `disposition.reject` could retire a hold they are not authorised to clear.
 */
const CLEARS_A_HOLD: readonly Disposition[] = ['accepted', 'rejected', 'rework_required', 'released_by_authorized_override'];

interface SampleRow {
  readonly id: string;
  readonly sample_id: string | null;
  readonly stage: string;
  readonly revision: number;
  readonly capture_state: string;
  readonly disposition: string;
  readonly hold_flag: boolean;
}

interface MeasurementRow {
  readonly field_key: string;
  readonly numeric_value: number | null;
  readonly text_value: string | null;
  readonly entered_text: string | null;
  readonly unit: string | null;
  readonly assessment_result: string | null;
  readonly assessment_reason: string | null;
  readonly rule_id: string | null;
  readonly rule_version: number | null;
}

function parseDecision(value: unknown): Disposition | null {
  return typeof value === 'string' && (DISPOSITIONS as readonly string[]).includes(value)
    ? (value as Disposition)
    : null;
}

function parseStageValue(value: unknown): Stage | null {
  return typeof value === 'string' && (STAGES as readonly string[]).includes(value)
    ? (value as Stage)
    : null;
}

function asAssessmentResult(value: unknown): AssessmentResult | null {
  return typeof value === 'string' && (ASSESSMENT_RESULTS as readonly string[]).includes(value)
    ? (value as AssessmentResult)
    : null;
}

/**
 * Turn a stored measurement row into the `Assessment` shape the release gate
 * reads.
 *
 * Fails CLOSED in both unusual directions. A row with no stored assessment, or
 * with a result this deployment does not recognise, becomes `not_assessable` —
 * which is a BLOCKER, so an unreadable evidence row pushes the decision toward
 * requiring an override rather than away from it.
 */
function storedAssessment(row: MeasurementRow | undefined, label: string): Assessment {
  if (row === undefined) {
    return {
      result: 'not_tested',
      reason: 'no_result_recorded',
      ruleId: null,
      ruleVersion: null,
      lowerBound: null,
      upperBound: null,
      unit: null,
      candidateCount: 0,
      explanation: `${label} has no recorded result.`,
    };
  }

  const result = asAssessmentResult(row.assessment_result);
  if (result === null) {
    return {
      result: 'not_assessable',
      reason: 'no_approved_rule',
      ruleId: row.rule_id,
      ruleVersion: row.rule_version,
      lowerBound: null,
      upperBound: null,
      unit: row.unit,
      candidateCount: 0,
      explanation:
        `${label} carries no readable assessment, so it cannot be treated as conforming.`,
    };
  }

  return {
    result,
    // The database constrains reason to agree with result, so the stored value
    // is used as-is; an absent one only happens on a row written before the
    // assessment engine ran, which the `not_assessable` default covers.
    reason: (row.assessment_reason ?? 'no_approved_rule') as AssessmentReason,
    ruleId: row.rule_id,
    ruleVersion: row.rule_version,
    lowerBound: null,
    upperBound: null,
    unit: row.unit,
    candidateCount: 0,
    explanation: `${label}: recorded assessment is ${result.replace(/_/g, ' ')}.`,
  };
}

/** The value a field holds, for `isFieldApplicable`. */
function valueOf(row: MeasurementRow | undefined): unknown {
  if (row === undefined) return undefined;
  if (row.entered_text !== null) return row.entered_text;
  if (row.text_value !== null) return row.text_value;
  return row.numeric_value ?? undefined;
}

async function readSample(admin: SupabaseClient, sampleUuid: string): Promise<SampleRow> {
  const { data, error } = await admin
    .from('samples')
    .select('id,sample_id,stage,revision,capture_state,disposition,hold_flag')
    .eq('id', sampleUuid)
    .maybeSingle();
  if (error !== null) {
    throw new ApiError('internal', { internalDetail: `read samples: ${error.message}` });
  }
  if (data === null) throw new ApiError('not_found');
  return data as SampleRow;
}

async function readMeasurements(
  admin: SupabaseClient,
  sampleUuid: string,
): Promise<Map<string, MeasurementRow>> {
  const { data, error } = await admin
    .from('sample_measurements')
    .select(
      'field_key,numeric_value,text_value,entered_text,unit,assessment_result,assessment_reason,rule_id,rule_version',
    )
    .eq('sample_uuid', sampleUuid);
  if (error !== null) {
    throw new ApiError('internal', { internalDetail: `read sample_measurements: ${error.message}` });
  }
  const map = new Map<string, MeasurementRow>();
  for (const row of (data ?? []) as MeasurementRow[]) map.set(row.field_key, row);
  return map;
}

/** Is the sample's current revision confirmed in the sheet? */
async function sheetConfirmed(
  admin: SupabaseClient,
  sampleUuid: string,
  revision: number,
): Promise<boolean> {
  const { data, error } = await admin.rpc(RPC.readSampleSyncState, { p_sample_uuid: sampleUuid });
  if (error !== null) {
    // A sync-state read failure must not be reported as "confirmed".
    return false;
  }
  const row = (Array.isArray(data) ? data[0] : data) as SampleSyncStateRow | null | undefined;
  const confirmed = row?.confirmed_revision ?? null;
  return confirmed !== null && confirmed >= revision;
}

/**
 * Build the release evaluation from stored state.
 *
 * On the seeded production dataset every assessable measurement is
 * `not_assessable`, because 0 of the 34 workbook limits are approved. So this
 * returns blockers for essentially every sample, `cleanAcceptAvailable` is
 * false, and an acceptance therefore needs the delegation-only override. That
 * is the specified behaviour (FR-009, UAT-05, risk R-01), not a defect.
 */
async function buildEvaluation(
  admin: SupabaseClient,
  sample: SampleRow,
  stage: Stage,
): Promise<ReleaseEvaluation> {
  const measurements = await readMeasurements(admin, sample.id);

  const values: Record<string, unknown> = {};
  for (const [key, row] of measurements) {
    const value = valueOf(row);
    if (value !== undefined) values[key] = value;
  }

  const assessments = assessableFields(stage)
    .filter((field) => isFieldApplicable(field, values))
    .map((field) => {
      const row = measurements.get(field.key);
      return {
        fieldKey: field.key,
        label: field.label,
        // A field whose requiredness is `testing` must carry a result before
        // the material can be released cleanly.
        required: field.required === 'testing',
        assessment: storedAssessment(row, field.label),
      };
    });

  const requireSheetConfirmation =
    optionalEnv('REQUIRE_SHEET_CONFIRMATION_FOR_RELEASE', 'false').trim().toLowerCase() === 'true';

  return evaluateRelease({
    holdActive: sample.hold_flag === true,
    holdDetail: 'The sample is on quality hold.',
    assessments,
    requireSheetConfirmation,
    sheetConfirmed: requireSheetConfirmation
      ? await sheetConfirmed(admin, sample.id, sample.revision)
      : false,
  });
}

export const DISPOSITION_SPEC: MutationSpec<Record<string, unknown>> = {
    operation: 'set_disposition',
    // The pipeline's static gate is the minimum any caller needs. The
    // DECISION-SPECIFIC permission is checked below, once the decision is
    // known, and its denial is audited there.
    permission: 'sample.view',
    subjectType: 'sample',
    subjectId: (body) => (typeof body['sampleUuid'] === 'string' ? body['sampleUuid'] : null),
    run: async ({
      actor,
      admin,
      body,
      idempotencyKey,
      payloadHash,
      appVersion,
      markCommitted,
    }) => {
      const sampleUuid = readString(body, 'sampleUuid', { required: true })!;
      const expectedRevision = requireExpectedRevision(body);

      // `decision` is the name the app's own client uses; `disposition` is
      // accepted as a synonym so a direct API caller is not tripped by it.
      const decision = parseDecision(body['decision'] ?? body['disposition']);
      if (decision === null) {
        throw new ApiError('bad_request', {
          message: 'A disposition decision is required.',
          details: {
            field: 'decision',
            allowed: DISPOSITIONS.filter((d) => d !== 'undetermined'),
          },
        });
      }
      if (decision === 'undetermined') {
        throw new ApiError('bad_request', {
          message:
            '"Undetermined" is the state a sample starts in, not a decision. Record on hold, accepted, rejected, rework required or an authorised override release.',
        });
      }

      const reason = readString(body, 'reason', { maxLength: 2000 });
      if (reason === null || reason.trim() === '') {
        throw new ApiError('validation_failed', {
          details: {
            issues: [
              {
                field: 'reason',
                code: 'required',
                message:
                  'Say on what basis this decision was made. It is recorded in the sample history against your name.',
              },
            ],
          },
        });
      }

      // 1. The decision-specific permission, logged on denial (FR-002). An
      //    administrator holds none of these and is refused here.
      const permission = DECISION_PERMISSION[decision];
      await requirePermission({
        actor,
        permission,
        action: 'set_disposition',
        subjectType: 'sample',
        subjectId: sampleUuid,
        appVersion,
      });

      // 2. Stored state. Nothing below reads an evaluation from the body.
      const sample = await readSample(admin, sampleUuid);
      const stage = parseStageValue(sample.stage);
      if (stage === null) {
        throw new ApiError('internal', {
          internalDetail: `sample ${sampleUuid} carries unknown stage ${sample.stage}`,
        });
      }

      // Fail fast on a stale edit before spending the evaluation reads, and
      // return the current revision so the client can offer a compare.
      if (sample.revision !== expectedRevision) {
        throw new ApiError('revision_conflict', {
          details: { currentRevision: sample.revision, expectedRevision },
        });
      }

      // 3. Clearing a hold needs hold-clearing authority, whatever disposition
      //    permission the actor holds.
      if (sample.hold_flag === true && CLEARS_A_HOLD.includes(decision)) {
        await requirePermission({
          actor,
          permission: 'hold.clear',
          action: 'set_disposition',
          subjectType: 'sample',
          subjectId: sampleUuid,
          appVersion,
        });
      }

      const evaluation = await buildEvaluation(admin, sample, stage);

      // 4. The full authority test, from the same module the UI uses.
      const check = checkDisposition({ decision, actor: actor.authority, evaluation, reason });
      if (!check.allowed) {
        await recordAudit({
          actorId: actor.userId,
          action: 'set_disposition',
          subjectType: 'sample',
          subjectId: sampleUuid,
          outcome: 'denied',
          reason: check.denial ?? 'disposition_refused',
          after: { decision, blockers: evaluation.blockers.map((b) => b.kind) },
          appVersion,
        });

        const code =
          check.denial === 'not_authorised' || check.denial === 'override_not_authorised'
            ? 'forbidden'
            : 'validation_failed';
        throw new ApiError(code, {
          message: check.message ?? 'That decision cannot be recorded.',
          details: {
            denial: check.denial ?? null,
            decision,
            blockers: evaluation.blockers,
          },
          internalDetail: `${actor.userId} ${decision} refused: ${check.denial ?? 'unknown'}`,
        });
      }

      // 5. Commit. `p_records_override` is derived here from stored state and
      //    re-derived by the transaction; a disagreement is the transaction's
      //    to raise, because only it holds the row lock.
      const result = await callTransaction<MutationResult>(admin, RPC.setDisposition, {
        p_actor: actor.userId,
        p_idempotency_key: idempotencyKey,
        p_payload_hash: payloadHash,
        p_app_version: appVersion,
        p_sample_uuid: sampleUuid,
        p_expected_revision: expectedRevision,
        p_decision: decision,
        p_reason: reason,
        p_records_override: check.recordsOverride,
      });

      /**
       * COMMIT POINT. Everything below this line runs against committed data,
       * so a throw past here is a reply that could not be built — never work
       * that did not happen (`_shared/commitOutcome.ts`).
       */
      markCommitted({
        ok: true,
        sampleUuid: result.sample_uuid,
        sampleId: result.sample_id,
        stage,
        revision: result.revision,
        captureState: result.capture_state,
        disposition: result.disposition,
        decision,
        recordsOverride: check.recordsOverride,
        recordedAt: result.recorded_at,
        outboxEventId: result.outbox_event_id,
      });

      await recordAudit({
        actorId: actor.userId,
        action: 'set_disposition',
        subjectType: 'sample',
        subjectId: sampleUuid,
        outcome: 'allowed',
        reason,
        before: {
          disposition: sample.disposition,
          capture_state: sample.capture_state,
          revision: sample.revision,
          hold_flag: sample.hold_flag,
        },
        after: {
          disposition: result.disposition,
          revision: result.revision,
          // Recorded explicitly: an override must never read back as a clean
          // acceptance in the audit trail.
          records_override: check.recordsOverride,
          blockers: evaluation.blockers.map((b) => b.kind),
        },
        appVersion,
      });

      return {
        ok: true,
        sampleUuid: result.sample_uuid,
        sampleId: result.sample_id,
        stage,
        sheetTab: STAGE_SCHEMAS[stage].sheetTab,
        revision: result.revision,
        captureState: result.capture_state,
        disposition: result.disposition,
        decision,
        /** True when this is recorded as an authorised override release. */
        recordsOverride: check.recordsOverride,
        blockers: evaluation.blockers,
        recordedAt: result.recorded_at,
        holdsRaised: result.holds_raised ?? [],
        message: check.recordsOverride
          ? `Recorded as an authorised override: ${DISPOSITION_LABELS[decision]}.`
          : `Recorded: ${DISPOSITION_LABELS[decision]}.`,
        sheetSync: syncStatusFor({
          outboxState: asOutboxState(result.sheet_sync_state),
          confirmedAt: result.sheet_confirmed_at ?? null,
        }),
        outboxEventId: result.outbox_event_id,
      };
    },
};
