/**
 * POST /update-results — add or amend test results on an EXISTING sample.
 *
 * FR-007: "append tests to an existing sample rather than duplicate it.
 * Acceptance: Quality Officer finds registered sample, adds results and
 * updates existing operational row."
 *
 * Two controls carry that requirement, and both are enforced here rather than
 * in the UI:
 *
 *  - The sample UUID is the subject. There is no code path by which this
 *    endpoint can create a sample, so a tester who reloads the page cannot
 *    produce a second log row for the same physical sample.
 *
 *  - `expectedRevision` is mandatory. A stale edit returns 409 with the
 *    current revision so the client can show a compare/refresh path
 *    (PRD §6.1, §11: "clear edit-state warnings when another user has changed
 *    the sample since it was opened").
 *
 * The outbox event this produces is a `results_recorded` event, which the
 * worker projects as an UPDATE to the row already carrying this sample ID —
 * relocating it by identifier first if the sheet has been sorted.
 */

import { ApiError } from '../_shared/errors.ts';
import { serveFunction, type RequestContext } from '../_shared/adapters/http.ts';
import {
  callTransaction,
  readString,
  readValues,
  requireExpectedRevision,
  runMutation,
} from '../_shared/adapters/mutation.ts';
import { parseStage, validateStagePayload } from '../_shared/validation.ts';
import { RPC, type MutationResult } from '../_shared/rpc.ts';
import { asOutboxState } from '../_shared/outbox.ts';
import { syncStatusFor } from '../_shared/syncStatus.ts';
import { recordAudit } from '../_shared/adapters/authorize.ts';
import { adverseObservationFields, STAGE_SCHEMAS } from '../../../src/forms/registry.ts';

function readConfirmed(body: Record<string, unknown>): readonly string[] {
  const raw = body['confirmedImplausible'];
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is string => typeof v === 'string');
}

async function handler(ctx: RequestContext): Promise<Response> {
  return await runMutation(ctx, {
    operation: 'update_results',
    permission: 'sample.enter_results',
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

      const stage = parseStage(body['stage']);
      if (stage === null) {
        throw new ApiError('bad_request', { message: 'An unknown form was submitted.' });
      }

      const values = readValues(body);

      // Results are validated at the TESTING phase, so a field that is only
      // mandatory once the laboratory has reported is required here and was
      // not required at registration (FR-005: a draft may be incomplete).
      const validation = validateStagePayload({
        stage,
        phase: 'testing',
        values,
        confirmedImplausible: readConfirmed(body),
      });
      if (!validation.ok) {
        throw new ApiError('validation_failed', { details: { issues: validation.issues } });
      }

      const reason = readString(body, 'reason', { maxLength: 2000 });
      const attestation = readString(body, 'testedByAttestation', { maxLength: 500 });

      const result = await callTransaction<MutationResult>(admin, RPC.updateResults, {
        p_actor: actor.userId,
        p_idempotency_key: idempotencyKey,
        p_payload_hash: payloadHash,
        p_app_version: appVersion,
        p_sample_uuid: sampleUuid,
        p_expected_revision: expectedRevision,
        p_values: validation.values,
        p_row: validation.row,
        p_reason: reason,
        p_tested_by_attestation: attestation,
      });

      /**
       * COMMIT POINT. Everything below this line runs against committed data,
       * so a throw past here is a reply that could not be built — never work
       * that did not happen (`_shared/commitOutcome.ts`).
       */
      markCommitted({
        sampleUuid: result.sample_uuid,
        sampleId: result.sample_id,
        stage,
        revision: result.revision,
        captureState: result.capture_state,
        disposition: result.disposition,
        recordedAt: result.recorded_at,
        outboxEventId: result.outbox_event_id,
      });

      await recordAudit({
        actorId: actor.userId,
        action: 'update_results',
        subjectType: 'sample',
        subjectId: sampleUuid,
        outcome: 'allowed',
        reason,
        after: { revision: result.revision, capture_state: result.capture_state },
        appVersion,
      });

      return {
        sampleUuid: result.sample_uuid,
        sampleId: result.sample_id,
        stage,
        sheetTab: STAGE_SCHEMAS[stage].sheetTab,
        revision: result.revision,
        captureState: result.capture_state,
        disposition: result.disposition,
        recordedAt: result.recorded_at,
        /**
         * Holds raised by the transaction, not by the client. An adverse
         * observation forces a hold regardless of numeric results (FR-010,
         * UAT-08), and the decision is made where the data commits.
         */
        holdsRaised: result.holds_raised ?? [],
        adverseObservationFields: adverseObservationFields(stage).map((f) => f.key),
        sheetSync: syncStatusFor({
          outboxState: asOutboxState(result.sheet_sync_state) ?? 'pending',
          confirmedAt: result.sheet_confirmed_at ?? null,
        }),
        outboxEventId: result.outbox_event_id,
      };
    },
  });
}

serveFunction({ name: 'update-results', methods: ['POST'] }, handler);
