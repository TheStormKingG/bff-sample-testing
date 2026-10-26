/**
 * Raising and clearing a quality hold, as their own audited actions.
 *
 * `src/lib/workflow.ts` fails closed: accepting a HELD sample is refused until
 * the hold is cleared "by its own audited action". Nothing provided that
 * action. `set-disposition` deliberately refuses to be the way out — it
 * demands `hold.clear` before letting a disposition end a hold, and it has no
 * decision that clears a hold and leaves the disposition undetermined,
 * because `undetermined` is a sample's initial state rather than something
 * anybody decides. So a held sample had no lawful exit at all.
 *
 * TWO SPECS, NOT ONE WITH A FLAG. Raising answers to `hold.raise` and clearing
 * to `hold.clear`, and those are held by different roles: a quality officer
 * can stop material and cannot restart it; clearing sits with the supervisor
 * unless a recorded delegation says otherwise. One entry point taking the
 * state as data would invite a caller to pass it, and the permission check
 * would then depend on a body field. An ADMINISTRATOR can do neither — the
 * role holds no `hold.*` permission — and there is no branch here that treats
 * one specially, which is the point: the matrix is the policy.
 *
 * Both require a written reason and an `expectedRevision`. A hold is a quality
 * decision, so an unexplained one is not accepted; and a hold raised against a
 * sample that has moved since the operator opened it is a stale edit rather
 * than a decision about the current state (PRD §6.1).
 *
 * DENO-ONLY: reached through `adapters/mutation.ts`.
 */

import { ApiError } from '../errors.ts';
import {
  callTransaction,
  readString,
  requireExpectedRevision,
  type MutationSpec,
} from '../adapters/mutation.ts';
import { RPC, type HoldArgs, type HoldResult } from '../rpc.ts';
import { recordAudit } from '../adapters/authorize.ts';

export type HoldAction = 'raise_hold' | 'clear_hold';

/**
 * The operation each hold action's RPC hands `claim_mutation`.
 *
 * See `MutationSpec.claimOperation`. Checked against the migrations by
 * `tests/idempotencyOperationContract.test.ts`.
 */
const HOLD_ACTION_CLAIM_OPERATION: Readonly<Record<HoldAction, string>> = {
  raise_hold: 'raise_hold',
  clear_hold: 'clear_hold',
};

export function holdSpec(action: HoldAction): MutationSpec<Record<string, unknown>> {
  const raising = action === 'raise_hold';

  return {
    operation: `sample_action.${action}`,
    // `rpc_raise_hold` / `rpc_clear_hold` hand `claim_mutation` the bare name
    // (0015:377, :483). Without this the pre-claim and the RPC's re-claim
    // disagreed and every hold action was refused. See `claimOperation`.
    //
    // Spelled as a map rather than `action` directly, even though the two
    // happen to coincide today: the handler's action vocabulary and the RPC's
    // operation vocabulary are separate namespaces that merely overlap here
    // (in `admin.ts` they do not overlap at all), and an identifier that
    // silently tracks one of them is how the two drifted apart in the first
    // place. It is also what lets the contract test resolve the value.
    claimOperation: HOLD_ACTION_CLAIM_OPERATION[action],
    /**
     * The permission IS the control here, so it is the pipeline's own gate
     * rather than a second check inside `run`: `runMutation` authorises before
     * the endpoint's work begins and audits the denial (FR-002), and there is
     * no later information that could change which permission is needed.
     */
    permission: raising ? 'hold.raise' : 'hold.clear',
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

      const reason = readString(body, 'reason', { maxLength: 2000 });
      if (reason === null || reason.trim() === '') {
        throw new ApiError('validation_failed', {
          details: {
            issues: [
              {
                field: 'reason',
                code: 'required',
                message: raising
                  ? 'Say why this material is being held. It is recorded in the sample history against your name.'
                  : 'Say on what basis the hold is being cleared. It is recorded in the sample history against your name.',
              },
            ],
          },
        });
      }

      // The field the hold is about, when it came from an adverse observation
      // (FR-010). Optional, and never used to decide authority.
      const fieldKey = readString(body, 'fieldKey', { maxLength: 200 });

      const args: HoldArgs = {
        p_actor: actor.userId,
        p_idempotency_key: idempotencyKey,
        p_payload_hash: payloadHash,
        p_app_version: appVersion,
        p_sample_uuid: sampleUuid,
        p_expected_revision: expectedRevision,
        p_reason: reason,
        p_field_key: fieldKey,
      };

      const result = await callTransaction<HoldResult>(
        admin,
        raising ? RPC.raiseHold : RPC.clearHold,
        args,
      );

      /**
       * COMMIT POINT. Everything below this line runs against committed data,
       * so a throw past here is a reply that could not be built — never work
       * that did not happen (`_shared/commitOutcome.ts`).
       */
      markCommitted({
        ok: true,
        action,
        sampleUuid: result.sample_uuid,
        sampleId: result.sample_id,
        revision: result.revision,
        captureState: result.capture_state,
        disposition: result.disposition,
        holdActive: result.hold_active,
        recordedAt: result.recorded_at,
      });

      await recordAudit({
        actorId: actor.userId,
        action: `sample_action.${action}`,
        subjectType: 'sample',
        subjectId: sampleUuid,
        outcome: 'allowed',
        reason,
        after: {
          action,
          hold_active: result.hold_active,
          revision: result.revision,
          field_key: fieldKey,
        },
        appVersion,
      });

      return {
        ok: true,
        action,
        sampleUuid: result.sample_uuid,
        sampleId: result.sample_id,
        revision: result.revision,
        captureState: result.capture_state,
        disposition: result.disposition,
        /**
         * Read back from the transaction, never assumed from the action. A
         * sample carrying a second, unrelated hold is STILL held after this
         * one is cleared, and reporting otherwise would be a false green of
         * exactly the kind build rule 6 forbids — worse here than for a sheet
         * label, because it would invite an acceptance.
         */
        holdActive: result.hold_active,
        recordedAt: result.recorded_at,
        message: raising
          ? 'The sample is on quality hold.'
          : result.hold_active
            ? 'This hold was cleared. The sample is still held by another hold.'
            : 'The hold has been cleared.',
      };
    },
  };
}
