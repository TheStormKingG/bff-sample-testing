/**
 * POST /approve-specification — approve or reject a proposed acceptance limit.
 *
 * FR-003 and PRD §7.3: a limit becomes assessable only after a two-person
 * approval, and an approved limit applies PROSPECTIVELY.
 *
 * Four controls, all server-side:
 *
 *  1. ONLY `spec.approve` AUTHORITY. A Quality Supervisor holds it as a base
 *     grant; a Quality Officer does not (it may only reach them through a
 *     recorded, time-bounded delegation); an Administrator never does — the
 *     administrator role carries no quality authority at all.
 *
 *  2. TWO-PERSON RULE. `approved_by` must differ from `proposed_by`. The
 *     attempt is audited before it is refused, because FR-002's acceptance
 *     criterion is a denial AND a logged event; an unlogged self-approval
 *     attempt is indistinguishable from one nobody tried.
 *
 *     The request body cannot name a second approver. `rpc.ts` carries
 *     `p_override_approved_by` for the general segregation-of-duties override,
 *     but accepting one HERE would let the actor assert that somebody else
 *     approved, which is the same self-approval wearing a second name. It is
 *     sent as null unconditionally, and the database's
 *     `specification_versions_two_person_approval` CHECK is the final backstop:
 *     a self-approved row cannot be stored whatever any code does.
 *
 *  3. PROSPECTIVE EFFECT. A version whose frozen `effective_from` is on a
 *     plant-local date BEFORE today is refused. `effective_from` is immutable
 *     once written, so the only way to approve a rule that would reach back
 *     over measurements already assessed is to approve a backdated proposal —
 *     and this refusal is what makes "newly approved limits never silently
 *     re-evaluate historical decisions" a check rather than a hope. Past
 *     assessments are immutable snapshots in `public.assessments`; a
 *     controlled reassessment is a separate, audited action.
 *
 *  4. ONLY A `proposed` VERSION IS DECIDABLE. In particular the 34 imported
 *     workbook entries carry `reference_only` and have no proposer, so they can
 *     never be approved through this endpoint. Promoting one means proposing a
 *     new version with a stated source — which is the only path by which a
 *     number becomes an acceptance limit (build rule 7).
 */

import { ApiError } from '../errors.ts';
import {
  callTransaction,
  readString,
  type MutationSpec,
} from '../adapters/mutation.ts';
import {
  RPC,
  type ApproveSpecificationResult,
  type ProposeSpecificationArgs,
  type SpecificationVersionResult,
  type SubmitSpecificationArgs,
} from '../rpc.ts';
import { recordAudit, requireSeparation } from '../adapters/authorize.ts';
import { assessableFields } from '../../../../src/forms/registry.ts';
import { STAGES, type Stage } from '../../../../src/forms/types.ts';
import { plantLocalDate, PLANT_TIME_ZONE } from '../../../../src/lib/time.ts';
import { SPEC_STATUSES } from '../../../../src/lib/assessment.ts';
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.47.10';

type Decision = 'approve' | 'reject';

/** The only status from which a decision may be taken. */
const DECIDABLE_STATUS = 'proposed';

interface SpecificationVersionRow {
  readonly id: string;
  readonly specification_id: string;
  readonly parameter_key: string;
  readonly stage: string;
  readonly version: number;
  readonly status: string;
  readonly effective_from: string;
  readonly proposed_by: string | null;
  readonly approved_by: string | null;
  readonly unit: string | null;
  readonly lower_bound: number | null;
  readonly upper_bound: number | null;
  readonly source_evidence: string;
  readonly workbook_entry_no: number | null;
}

function parseDecision(value: unknown): Decision | null {
  return value === 'approve' || value === 'reject' ? value : null;
}

async function readVersion(
  admin: SupabaseClient,
  id: string,
): Promise<SpecificationVersionRow> {
  const { data, error } = await admin
    .from('specification_versions')
    .select(
      'id,specification_id,parameter_key,stage,version,status,effective_from,proposed_by,approved_by,unit,lower_bound,upper_bound,source_evidence,workbook_entry_no',
    )
    .eq('id', id)
    .maybeSingle();
  if (error !== null) {
    throw new ApiError('internal', {
      internalDetail: `read specification_versions: ${error.message}`,
    });
  }
  if (data === null) throw new ApiError('not_found');
  return data as SpecificationVersionRow;
}

/**
 * Plain-language reason a version cannot be decided on, or null.
 *
 * Phrased per status, because "that rule cannot be approved" sends a
 * supervisor nowhere while "that rule is still a draft" tells them what to do.
 */
function undecidableReason(status: string): string | null {
  if (status === DECIDABLE_STATUS) return null;
  switch (status) {
    case 'draft':
      return 'That rule is still a draft. It must be submitted for review before it can be decided on.';
    case 'approved':
      return 'That rule is already approved. Supersede it with a new version instead of re-approving it.';
    case 'rejected':
      return 'That rule was already rejected. Propose a new version instead.';
    case 'superseded':
      return 'That rule has been superseded by a later version.';
    case 'reference_only':
      return 'That entry is a preserved workbook reference, not a proposed rule. It has no proposer, so it cannot satisfy the two-person approval. Propose a new rule, stating its source, to put a limit into effect.';
    default:
      return 'That rule is not in a state that can be decided on.';
  }
}

export const APPROVE_SPECIFICATION_SPEC: MutationSpec<Record<string, unknown>> = {
    operation: 'approve_specification',
    permission: 'spec.approve',
    subjectType: 'specification_version',
    subjectId: (body) =>
      typeof body['specificationVersionId'] === 'string' ? body['specificationVersionId'] : null,
    run: async ({
      actor,
      admin,
      body,
      idempotencyKey,
      payloadHash,
      appVersion,
      markCommitted,
    }) => {
      // Both spellings are accepted; neither is defaulted. `required: true` is
      // NOT passed to the first read, because it would throw before the
      // snake_case alternative could be considered.
      const versionId =
        readString(body, 'specificationVersionId') ??
        readString(body, 'specification_version_id');
      if (versionId === null) {
        throw new ApiError('validation_failed', {
          details: {
            issues: [
              {
                field: 'specificationVersionId',
                code: 'required',
                message: 'Which proposed rule is being decided on?',
              },
            ],
          },
        });
      }

      // The app's own client sends `action: 'approve' | 'reject'`; `decision`
      // is accepted as a synonym for a direct API caller.
      const decision = parseDecision(body['decision'] ?? body['action']);
      if (decision === null) {
        throw new ApiError('bad_request', {
          message: 'A decision of "approve" or "reject" is required.',
          details: { field: 'decision', allowed: ['approve', 'reject'] },
        });
      }

      // `p_reason` is not optional in the RPC contract, and a limit decision
      // with no stated basis cannot be defended in an audit.
      const reason = readString(body, 'reason', { maxLength: 2000 });
      if (reason === null || reason.trim() === '') {
        throw new ApiError('validation_failed', {
          details: {
            issues: [
              {
                field: 'reason',
                code: 'required',
                message:
                  decision === 'approve'
                    ? 'State the basis for approving this limit. It is recorded against your name.'
                    : 'State why this limit is being rejected. The proposer will see this.',
              },
            ],
          },
        });
      }

      const version = await readVersion(admin, versionId);

      // Defensive: a status this deployment does not know is not decidable.
      if (!(SPEC_STATUSES as readonly string[]).includes(version.status)) {
        throw new ApiError('internal', {
          internalDetail: `specification_version ${versionId} has unknown status ${version.status}`,
        });
      }

      const undecidable = undecidableReason(version.status);
      if (undecidable !== null) {
        throw new ApiError('validation_failed', {
          message: undecidable,
          details: { status: version.status, parameterKey: version.parameter_key },
        });
      }

      // TWO-PERSON RULE. Logged by `requireSeparation` before it throws.
      // `overrideApprovedBy` is null on purpose — see the file header.
      await requireSeparation({
        actor,
        action: 'approve_specification',
        subjectActorId: version.proposed_by,
        subjectId: versionId,
        overrideApprovedBy: null,
        appVersion,
      });

      // A proposed version must actually name a proposer, or the two-person
      // rule has nothing to compare against.
      if (version.proposed_by === null) {
        throw new ApiError('validation_failed', {
          message:
            'That rule records no proposer, so a second person cannot approve it. It must be proposed by a named user first.',
          details: { parameterKey: version.parameter_key },
        });
      }

      // PROSPECTIVE EFFECT, compared on plant-local dates.
      if (decision === 'approve') {
        const today = plantLocalDate(new Date());
        const effectiveDate = plantLocalDate(new Date(version.effective_from));
        if (effectiveDate < today) {
          await recordAudit({
            actorId: actor.userId,
            action: 'approve_specification',
            subjectType: 'specification_version',
            subjectId: versionId,
            outcome: 'denied',
            reason: 'effective_date_in_the_past',
            after: { effectiveFrom: effectiveDate, today },
            appVersion,
          });
          throw new ApiError('validation_failed', {
            message:
              `That rule would take effect from ${effectiveDate}, which has already passed. An approved limit applies from its effective date onwards and must never reach back over decisions already recorded. Propose the rule again with an effective date of ${today} or later.`,
            details: {
              effectiveFrom: effectiveDate,
              earliestAllowed: today,
              timeZone: PLANT_TIME_ZONE,
            },
          });
        }
      }

      const result = await callTransaction<ApproveSpecificationResult>(
        admin,
        RPC.approveSpecification,
        {
          p_actor: actor.userId,
          p_idempotency_key: idempotencyKey,
          p_payload_hash: payloadHash,
          p_app_version: appVersion,
          p_specification_version_id: versionId,
          p_decision: decision,
          p_reason: reason,
          p_override_approved_by: null,
        },
      );

      /**
       * COMMIT POINT. Everything below this line runs against committed data,
       * so a throw past here is a reply that could not be built — never work
       * that did not happen (`_shared/commitOutcome.ts`).
       */
      markCommitted({
        ok: true,
        specificationVersionId: result.specification_version_id,
        parameterKey: result.parameter_key,
        version: result.version,
        status: result.status,
        effectiveFrom: result.effective_from,
        appliesProspectivelyOnly: true,
        approvedBy: result.approved_by,
        recordedAt: result.recorded_at,
      });

      await recordAudit({
        actorId: actor.userId,
        action: 'approve_specification',
        subjectType: 'specification_version',
        subjectId: versionId,
        outcome: 'allowed',
        reason,
        before: { status: version.status, proposedBy: version.proposed_by },
        after: {
          status: result.status,
          version: result.version,
          parameterKey: result.parameter_key,
          effectiveFrom: result.effective_from,
          approvedBy: result.approved_by,
        },
        appVersion,
      });

      return {
        ok: true,
        specificationVersionId: result.specification_version_id,
        parameterKey: result.parameter_key,
        stage: version.stage,
        version: result.version,
        status: result.status,
        /**
         * Stated explicitly so no caller has to infer it: the rule decides
         * measurements from this instant forward only. Assessments already
         * recorded keep the rule version that decided them.
         */
        effectiveFrom: result.effective_from,
        appliesProspectivelyOnly: true,
        approvedBy: result.approved_by,
        proposedBy: version.proposed_by,
        recordedAt: result.recorded_at,
        message:
          decision === 'approve'
            ? `Approved. ${result.parameter_key} is assessable for samples collected from ${plantLocalDate(new Date(result.effective_from))} onwards. Decisions already recorded are unchanged.`
            : `Rejected. ${result.parameter_key} remains unassessable and no limit is in force.`,
      };
    },
};

// ---------------------------------------------------------------------------
// Proposing a rule, and submitting a proposal for review
// ---------------------------------------------------------------------------

/**
 * Neither spec below can put a limit in force.
 *
 * `propose` writes a DRAFT and `submit_review` moves it to PROPOSED. Only
 * `APPROVE_SPECIFICATION_SPEC` above sets `approved`, and only it enforces
 * segregation of duties. Keeping the three apart under two permissions is what
 * stops `spec.propose` becoming a route to `spec.approve`: there is no
 * statement in either spec below that writes an approved status, so no bug in
 * them can make a measurement assessable.
 *
 * NO LIMIT IS INVENTED HERE. The bounds are whatever the proposer typed; this
 * code neither defaults nor derives them. A proposal with BOTH bounds absent
 * is accepted and recorded as reference-only — a real thing in this plant's
 * workbook, where 0 of the 34 `Limits` rows are approved and entry 13's unit
 * is the literal string "to confirm" — and a reference-only rule can never
 * assess a measurement (`src/lib/assessment.ts`). What it must never do is
 * quietly become a one-sided numeric limit.
 */

/**
 * A proposed numeric bound.
 *
 * Absent, null and empty-string all mean "no bound on this side", which is a
 * legitimate one-sided limit. ZERO IS A REAL BOUND and must survive: a maximum
 * of 0 is how "none detected" is expressed for a contaminant, so `0` can never
 * be folded into "missing".
 */
function readBound(source: Record<string, unknown>, key: string): number | null {
  const value = source[key];
  if (value === undefined || value === null || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) {
    throw new ApiError('validation_failed', {
      details: {
        issues: [{ field: key, code: 'not_a_number', message: `${key} must be a number.` }],
      },
    });
  }
  return n;
}

function parseStageValue(value: unknown): Stage | null {
  return typeof value === 'string' && (STAGES as readonly string[]).includes(value)
    ? (value as Stage)
    : null;
}

/**
 * The proposal payload.
 *
 * `src/hooks/useSpecifications.ts` nests it under `proposal`; a direct API
 * caller is likelier to send the fields at the top level. Both are read, the
 * nested form first, so neither caller has to change.
 */
function proposalSource(body: Record<string, unknown>): Record<string, unknown> {
  const nested = body['proposal'];
  if (typeof nested === 'object' && nested !== null && !Array.isArray(nested)) {
    return nested as Record<string, unknown>;
  }
  return body;
}

/**
 * Is this parameter one the registry actually assesses for this stage?
 *
 * A rule proposed against a key no form collects could never be applied, so it
 * is refused rather than stored as an orphan nobody will ever notice. The
 * registry is the authority for what exists; nothing here invents a parameter.
 */
function assertKnownParameter(stage: Stage, parameterKey: string): void {
  if (assessableFields(stage).some((field) => field.parameterKey === parameterKey)) return;
  throw new ApiError('validation_failed', {
    details: {
      issues: [
        {
          field: 'parameterKey',
          code: 'unknown_parameter',
          message: 'That test is not one this form records, so no limit can be set for it.',
        },
      ],
    },
  });
}

export const PROPOSE_SPECIFICATION_SPEC: MutationSpec<Record<string, unknown>> = {
  operation: 'specification_action.propose',
  // `rpc_propose_specification` claims 'propose_specification' (0015:622).
  claimOperation: 'propose_specification',
  permission: 'spec.propose',
  subjectType: 'specification_version',
  subjectId: () => null,
  run: async ({ actor, admin, body, idempotencyKey, payloadHash, appVersion, markCommitted }) => {
    const source = proposalSource(body);

    const stage = parseStageValue(source['stage']);
    if (stage === null) {
      throw new ApiError('bad_request', {
        message: 'A valid form must be named for a proposed limit.',
        details: { field: 'stage', allowed: STAGES },
      });
    }

    const parameterKey = readString(source, 'parameterKey', { required: true, maxLength: 200 })!;
    assertKnownParameter(stage, parameterKey);

    const reason = readString(source, 'reason', { maxLength: 2000 }) ??
      readString(body, 'reason', { maxLength: 2000 });
    if (reason === null || reason.trim() === '') {
      throw new ApiError('validation_failed', {
        details: {
          issues: [
            {
              field: 'reason',
              code: 'required',
              message:
                'Say what this limit is based on — the standard, supplier specification or internal decision.',
            },
          ],
        },
      });
    }

    const lowerBound = readBound(source, 'lowerBound');
    const upperBound = readBound(source, 'upperBound');
    if (lowerBound !== null && upperBound !== null && lowerBound > upperBound) {
      throw new ApiError('validation_failed', {
        details: {
          issues: [
            {
              field: 'lowerBound',
              code: 'range_inverted',
              message: 'The minimum cannot be greater than the maximum.',
            },
          ],
        },
      });
    }

    const args: ProposeSpecificationArgs = {
      p_actor: actor.userId,
      p_idempotency_key: idempotencyKey,
      p_payload_hash: payloadHash,
      p_app_version: appVersion,
      p_parameter_key: parameterKey,
      p_stage: stage,
      p_material: readString(source, 'material', { maxLength: 200 }),
      p_feed_type: readString(source, 'feedType', { maxLength: 200 }),
      p_sampling_point: readString(source, 'samplingPoint', { maxLength: 200 }),
      p_test_method: readString(source, 'testMethod', { maxLength: 500 }),
      p_unit: readString(source, 'unit', { maxLength: 100 }),
      p_lower_bound: lowerBound,
      p_upper_bound: upperBound,
      p_reason: reason,
    };

    const result = await callTransaction<SpecificationVersionResult>(
      admin,
      RPC.proposeSpecification,
      args,
    );

    /** COMMIT POINT — see `_shared/commitOutcome.ts`. */
    markCommitted({
      ok: true,
      action: 'propose',
      specificationVersionId: result.specification_version_id,
      parameterKey: result.parameter_key,
      version: result.version,
      status: result.status,
      recordedAt: result.recorded_at,
    });

    await recordAudit({
      actorId: actor.userId,
      action: 'specification_action.propose',
      subjectType: 'specification_version',
      subjectId: result.specification_version_id,
      outcome: 'allowed',
      reason,
      after: {
        parameter_key: parameterKey,
        stage,
        version: result.version,
        status: result.status,
        // Recorded as proposed, so the trail shows what was asked for even if
        // the proposal is later rejected.
        lower_bound: lowerBound,
        upper_bound: upperBound,
      },
      appVersion,
    });

    const referenceOnly = lowerBound === null && upperBound === null;

    return {
      ok: true,
      action: 'propose',
      specificationVersionId: result.specification_version_id,
      parameterKey: result.parameter_key,
      stage: result.stage,
      version: result.version,
      status: result.status,
      proposedBy: result.proposed_by,
      lowerBound,
      upperBound,
      /**
       * True when neither bound was given. Such an entry documents a test
       * without constraining it and can never assess a measurement.
       */
      referenceOnly,
      /** Stated rather than inferred: a proposal changes nothing assessable. */
      assessableNow: false,
      recordedAt: result.recorded_at,
      message: referenceOnly
        ? 'Recorded for reference. With no minimum and no maximum it sets no limit, so results stay unassessable until a limit is proposed and approved.'
        : 'Recorded as a proposal. It is not in force, and no measurement is assessed against it until an authorised approver accepts it.',
    };
  },
};

export const SUBMIT_SPECIFICATION_SPEC: MutationSpec<Record<string, unknown>> = {
  operation: 'specification_action.submit_review',
  // `rpc_submit_specification_for_review` claims this (0015:776).
  claimOperation: 'submit_specification_for_review',
  permission: 'spec.propose',
  subjectType: 'specification_version',
  subjectId: (body) =>
    typeof body['specificationVersionId'] === 'string' ? body['specificationVersionId'] : null,
  run: async ({ actor, admin, body, idempotencyKey, payloadHash, appVersion, markCommitted }) => {
    const versionId = readString(body, 'specificationVersionId', { required: true })!;
    const reason = readString(body, 'reason', { maxLength: 2000 });
    if (reason === null || reason.trim() === '') {
      throw new ApiError('validation_failed', {
        details: {
          issues: [
            {
              field: 'reason',
              code: 'required',
              message: 'Say what this limit is based on before sending it for approval.',
            },
          ],
        },
      });
    }

    const args: SubmitSpecificationArgs = {
      p_actor: actor.userId,
      p_idempotency_key: idempotencyKey,
      p_payload_hash: payloadHash,
      p_app_version: appVersion,
      p_specification_version_id: versionId,
      p_reason: reason,
    };

    const result = await callTransaction<SpecificationVersionResult>(
      admin,
      RPC.submitSpecificationForReview,
      args,
    );

    /** COMMIT POINT — see `_shared/commitOutcome.ts`. */
    markCommitted({
      ok: true,
      action: 'submit_review',
      specificationVersionId: result.specification_version_id,
      parameterKey: result.parameter_key,
      version: result.version,
      status: result.status,
      recordedAt: result.recorded_at,
    });

    await recordAudit({
      actorId: actor.userId,
      action: 'specification_action.submit_review',
      subjectType: 'specification_version',
      subjectId: versionId,
      outcome: 'allowed',
      reason,
      after: { status: result.status, version: result.version },
      appVersion,
    });

    return {
      ok: true,
      action: 'submit_review',
      specificationVersionId: result.specification_version_id,
      parameterKey: result.parameter_key,
      stage: result.stage,
      version: result.version,
      status: result.status,
      proposedBy: result.proposed_by,
      assessableNow: false,
      recordedAt: result.recorded_at,
      message:
        'Submitted for review. It is not in force, and no measurement is assessed against it until an authorised approver accepts it.',
    };
  },
};
