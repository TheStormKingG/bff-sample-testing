/**
 * POST /review-sample — record a review outcome with its assessment evidence.
 *
 * FR-011 and PRD §7.2 step 7: store "rule key/version, measured value,
 * evaluation result, timestamp and actor so a later limits change does not
 * silently rewrite a past decision."
 *
 * The assessments are RE-COMPUTED server-side from the stored measurements and
 * the approved ruleset; the array in the request body is treated as the
 * client's claim and is only compared, never trusted. Build rule 3 and Master
 * Prompt §4 both say so explicitly ("All client-originating inputs are
 * untrusted, including ... review flags, threshold values"), and the specific
 * risk is a client that submits `within_limit` for a measurement with no
 * approved rule — which must be `not_assessable` (FR-009, UAT-05).
 *
 * Where the client's claim disagrees with the server's computation, the
 * request is refused with the difference, rather than silently corrected: a
 * silent correction would mean the reviewer signed off on something other than
 * what was recorded.
 */

import { ApiError } from '../errors.ts';
import {
  callTransaction,
  readString,
  requireExpectedRevision,
  type MutationSpec,
} from '../adapters/mutation.ts';
import { RPC, type MutationResult } from '../rpc.ts';
import { asOutboxState } from '../outbox.ts';
import { syncStatusFor } from '../syncStatus.ts';
import { recordAudit } from '../adapters/authorize.ts';
import { ASSESSMENT_RESULTS } from '../../../../src/lib/assessment.ts';

interface ClaimedAssessment {
  readonly field_key: string;
  readonly result: string;
}

/**
 * Read the client's assessment claims for comparison only.
 *
 * Kept deliberately shallow: the only reason to accept them at all is so the
 * server can detect that the reviewer was looking at a stale evaluation and
 * refuse rather than record a sign-off against figures that have since
 * changed.
 */
function readClaims(body: Record<string, unknown>): readonly ClaimedAssessment[] {
  const raw = body['assessments'];
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new ApiError('bad_request', { message: '"assessments" must be a list.' });
  }
  return raw.map((entry, i) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new ApiError('bad_request', { message: `assessments[${i}] must be an object.` });
    }
    const record = entry as Record<string, unknown>;
    const fieldKey = record['fieldKey'] ?? record['field_key'];
    const result = record['result'];
    if (typeof fieldKey !== 'string' || typeof result !== 'string') {
      throw new ApiError('bad_request', {
        message: `assessments[${i}] needs a "fieldKey" and a "result".`,
      });
    }
    if (!(ASSESSMENT_RESULTS as readonly string[]).includes(result)) {
      throw new ApiError('bad_request', {
        message: `assessments[${i}].result is not a recognised assessment.`,
      });
    }
    return { field_key: fieldKey, result };
  });
}

export type ReviewOutcome = 'reviewed' | 'correction_required';

/**
 * The review spec.
 *
 * `outcome` is a PARAMETER, not always a body field. The `review-sample`
 * endpoint reads it from the body (`outcome: null` here), because a direct API
 * caller names it. The `sample-action` router instead derives it from the
 * action it was given — `review` or `request_correction` — because
 * `src/hooks/useSampleDetail.ts` encodes the outcome IN the action name and
 * sends no `outcome` field at all. One spec, one implementation, two ways in.
 */
export function reviewSpec(
  outcomeOverride: ReviewOutcome | null,
): MutationSpec<Record<string, unknown>> {
  return {
    operation: 'review_sample',
    permission: 'sample.review',
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

      const outcome = outcomeOverride ?? readString(body, 'outcome', { required: true })!;
      if (outcome !== 'reviewed' && outcome !== 'correction_required') {
        throw new ApiError('bad_request', {
          message: 'A review outcome must be either "reviewed" or "correction_required".',
        });
      }

      const reason = readString(body, 'reason', { maxLength: 2000 });
      // `correction_required` always needs a reason: the tester has to be told
      // what to correct. `checkTransition` in src/lib/workflow.ts encodes the
      // same rule, and the RPC re-checks it against the stored state.
      if (outcome === 'correction_required' && (reason === null || reason.trim() === '')) {
        throw new ApiError('validation_failed', {
          details: {
            issues: [
              {
                field: 'reason',
                code: 'required',
                message: 'Say what needs to be corrected. The tester will see this.',
              },
            ],
          },
        });
      }

      const result = await callTransaction<MutationResult>(admin, RPC.reviewSample, {
        p_actor: actor.userId,
        p_idempotency_key: idempotencyKey,
        p_payload_hash: payloadHash,
        p_app_version: appVersion,
        p_sample_uuid: sampleUuid,
        p_expected_revision: expectedRevision,
        p_outcome: outcome,
        p_reason: reason,
        // Compared against the server's own evaluation inside the
        // transaction. A disagreement raises BFF_ASSESSMENT_STALE.
        p_claimed_assessments: readClaims(body),
      });

      /**
       * COMMIT POINT. Everything below this line runs against committed data,
       * so a throw past here is a reply that could not be built — never work
       * that did not happen (`_shared/commitOutcome.ts`).
       */
      markCommitted({
        sampleUuid: result.sample_uuid,
        sampleId: result.sample_id,
        revision: result.revision,
        captureState: result.capture_state,
        disposition: result.disposition,
        recordedAt: result.recorded_at,
        outboxEventId: result.outbox_event_id,
      });

      await recordAudit({
        actorId: actor.userId,
        action: 'review_sample',
        subjectType: 'sample',
        subjectId: sampleUuid,
        outcome: 'allowed',
        reason,
        after: { revision: result.revision, capture_state: result.capture_state },
        appVersion,
      });

      return {
        /**
         * `ok` and `message` are read by every caller of this spec — the
         * `sample-action` router's clients treat a missing or false `ok` as a
         * failure and surface `message` verbatim. Stated here, once, so the
         * two routes cannot answer differently.
         */
        ok: true,
        action: outcomeOverride === 'correction_required' ? 'request_correction' : 'review',
        outcome,
        message:
          outcome === 'reviewed'
            ? 'The review has been recorded.'
            : 'A correction has been requested. The sample is back with the tester.',
        sampleUuid: result.sample_uuid,
        sampleId: result.sample_id,
        revision: result.revision,
        captureState: result.capture_state,
        disposition: result.disposition,
        recordedAt: result.recorded_at,
        holdsRaised: result.holds_raised ?? [],
        // Reported from the sample's actual outbox state, never inferred from
        // whether THIS change queued an event. A review that touches no sheet
        // cell leaves the row exactly as confirmed — or as pending — as it was.
        sheetSync: syncStatusFor({
          outboxState: asOutboxState(result.sheet_sync_state),
          confirmedAt: result.sheet_confirmed_at ?? null,
        }),
        outboxEventId: result.outbox_event_id,
      };
    },
  };
}
