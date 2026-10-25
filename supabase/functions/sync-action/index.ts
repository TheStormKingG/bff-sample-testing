/**
 * POST /sync-action — put a failed or dead-lettered sheet write back in the
 * queue.
 *
 * Master Prompt §7 requires "a dead-letter/needs-attention state" and PRD §11
 * an administrator path out of it. The sync-health screen already had the
 * button; `src/hooks/useAdmin.ts` posted `{ action: 'retry', jobId }` to a
 * function that did not exist, so a dead-lettered job could only be rescued
 * with direct database access.
 *
 * WHICH RPC, AND WHY IT MATTERS. `rpc_requeue_outbox_event` has two overloads
 * and only one belongs here. The four-argument form is FENCED — it takes a
 * lease owner and fence, and `reconcile-sheets` is its caller. An
 * administrator pressing a button holds no lease and must not take one: a
 * lease held by a screen would block the worker for its whole TTL. The
 * three-argument form re-derives `sync.retry` from the actor in SQL and needs
 * no lease, and that is the one used here.
 *
 * `sync.retry` is held by the administrator and by no quality role, which is
 * the right split: re-queuing a sheet write is an operational act. It changes
 * NO quality fact — the ledger is already committed, the row content is
 * already decided, and the only thing a retry can alter is whether the Google
 * copy catches up. An administrator could not use this to accept material,
 * clear a hold or approve a limit, because none of those live in the outbox.
 *
 * WHAT A RETRY MUST NOT DO is write a second row. Both RPCs set
 * `reconcile_first` on the requeued event, so the next attempt READS the sheet
 * before it writes: a retry that skips the read-back is how one timeout
 * becomes two rows in the operational log. Nothing here writes to the sheet —
 * the worker holds the lease and does the writing — so nothing here claims the
 * sheet was written.
 */

import { ApiError } from '../_shared/errors.ts';
import { serveFunction, type RequestContext } from '../_shared/adapters/http.ts';
import {
  callTransaction,
  readInteger,
  readString,
  runMutation,
  type MutationSpec,
} from '../_shared/adapters/mutation.ts';
import {
  RPC,
  type RetryAuditDeadLettersArgs,
  type RetryAuditDeadLettersResult,
  type RetryDeadLetteredArgs,
} from '../_shared/rpc.ts';
import { recordAudit } from '../_shared/adapters/authorize.ts';
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.47.10';
import { WORKBOOK_KEY } from '../_shared/adapters/store.ts';
import {
  parseAction,
  SYNC_ACTIONS,
  SYNC_ACTION_PERMISSION,
  type SyncAction,
} from '../_shared/actions.ts';

/**
 * Upper bound on a bulk retry.
 *
 * Each requeued job consumes Sheets API quota, so an unbounded bulk retry
 * turns a backlog into a rate-limit incident and buries the original failure.
 * The caller may ask for fewer, never more.
 */
const MAX_BULK_RETRY = 200;
const DEFAULT_BULK_RETRY = 50;

/** `jobId` is what the sync-health screen sends; `eventId` is its API name. */
function readJobId(body: Record<string, unknown>): string | null {
  const jobId = body['jobId'] ?? body['eventId'];
  return typeof jobId === 'string' && jobId !== '' ? jobId : null;
}

/**
 * Which sample does this outbox job belong to?
 *
 * The screen lists jobs and sends a job id; `rpc_retry_dead_lettered` retries
 * by SAMPLE. The translation is a read here rather than a guess, and a job id
 * that resolves to nothing is `not_found` — never a silent widening to "retry
 * everything", which is what passing a null sample would do. That widening is
 * the dangerous failure: one button press meant for one job would re-queue the
 * whole dead-letter queue and spend the Sheets quota on it.
 */
async function sampleForJob(admin: SupabaseClient, jobId: string): Promise<string> {
  const { data, error } = await admin
    .from('sheet_sync_outbox')
    .select('event_id,sample_uuid')
    .eq('event_id', jobId)
    .maybeSingle();
  if (error !== null) {
    throw new ApiError('internal', { internalDetail: `read sheet_sync_outbox: ${error.message}` });
  }
  if (data === null) throw new ApiError('not_found');
  const row = data as { readonly sample_uuid: string | null };
  if (row.sample_uuid === null) {
    throw new ApiError('internal', {
      internalDetail: `sheet_sync_outbox ${jobId} has no sample_uuid`,
    });
  }
  return row.sample_uuid;
}

/**
 * None of these RPCs takes the idempotency envelope, and that is worth stating
 * because every other mutation in this codebase passes `p_idempotency_key` and
 * `p_payload_hash` down to its RPC.
 *
 * A retry is not a new quality record. `runMutation` has already claimed the
 * key, so pressing the button twice cannot queue the same work twice, and the
 * outbox transition is itself idempotent — requeuing an event already pending
 * is a no-op. Passing the envelope would imply the RPC writes a versioned
 * record, which it does not.
 */
function syncSpec(action: SyncAction): MutationSpec<Record<string, unknown>> {
  return {
    operation: `sync_action.${action}`,
    permission: SYNC_ACTION_PERMISSION[action],
    subjectType: action === 'retry' ? 'sheet_sync_event' : 'sheet_sync',
    subjectId: (body) => (action === 'retry' ? readJobId(body) : WORKBOOK_KEY),
    run: async ({ actor, admin, body, appVersion, markCommitted }) => {
      /**
       * A reason is RECORDED but not required, unlike every quality decision.
       * The sync-health retry button sends none, and refusing the request would
       * leave a dead-lettered job unrescuable through the only interface that
       * offers it — trading a silent failure for a blocked one. The actor, the
       * job and the instant are recorded either way, so the action stays
       * attributable; only the operator's wording is absent.
       */
      const supplied = readString(body, 'reason', { maxLength: 2000 });
      const reason =
        supplied === null || supplied.trim() === ''
          ? 'retry requested from the synchronisation health screen'
          : supplied;

      // ---- the audit trail's own recovery queue -------------------------

      if (action === 'retry_audit_dead_letters') {
        const limit = Math.min(
          readInteger(body, 'limit', { min: 1 }) ?? DEFAULT_BULK_RETRY,
          MAX_BULK_RETRY,
        );
        const args: RetryAuditDeadLettersArgs = { p_limit: limit };
        const result = await callTransaction<RetryAuditDeadLettersResult>(
          admin,
          RPC.retryAuditDeadLetters,
          args,
        );

        /** COMMIT POINT — see `_shared/commitOutcome.ts`. */
        markCommitted({
          ok: true,
          action,
          attempted: result.attempted,
          written: result.written,
          stillHeld: result.still_held,
        });

        await recordAudit({
          actorId: actor.userId,
          action: `sync_action.${action}`,
          subjectType: 'audit_dead_letter',
          subjectId: null,
          outcome: 'allowed',
          reason,
          after: {
            attempted: result.attempted,
            written: result.written,
            still_held: result.still_held,
            limit,
          },
          appVersion,
        });

        return {
          ok: true,
          action,
          attempted: result.attempted,
          written: result.written,
          /**
           * Still held after this pass. Non-zero is NOT a success with a
           * remainder: an event that failed to replay failed for the same
           * reason it failed the first time, so this number is the one an
           * administrator has to act on.
           */
          stillHeld: result.still_held,
          limit,
          message:
            result.attempted === 0
              ? 'There were no held audit events to replay.'
              : result.still_held === 0
                ? `${result.written} audit event(s) were written to the trail.`
                : `${result.written} of ${result.attempted} audit event(s) were written. ${result.still_held} could not be and are still held.`,
        };
      }

      // ---- the sheet outbox ---------------------------------------------

      const jobId = action === 'retry' ? readJobId(body) : null;
      if (action === 'retry' && jobId === null) {
        throw new ApiError('bad_request', {
          message: 'The job to retry must be named.',
          details: { field: 'jobId' },
        });
      }

      const sampleUuid = jobId === null ? null : await sampleForJob(admin, jobId);

      const args: RetryDeadLetteredArgs = {
        p_actor: actor.userId,
        p_app_version: appVersion,
        // Null means "every dead-lettered event", which is reached only by the
        // explicit bulk action — never by a job lookup that came back empty.
        p_sample_uuid: sampleUuid,
      };

      /** The RPC returns a bare integer: how many events it re-queued. */
      const requeued = await callTransaction<number>(admin, RPC.retryDeadLettered, args);

      /**
       * COMMIT POINT. Everything below this line runs against committed data,
       * so a throw past here is a reply that could not be built — never work
       * that did not happen (`_shared/commitOutcome.ts`).
       */
      markCommitted({ ok: true, action, jobId, sampleUuid, requeued });

      await recordAudit({
        actorId: actor.userId,
        action: `sync_action.${action}`,
        subjectType: action === 'retry' ? 'sheet_sync_event' : 'sheet_sync',
        subjectId: jobId ?? WORKBOOK_KEY,
        outcome: 'allowed',
        reason,
        after: { requeued, sample_uuid: sampleUuid, scope: jobId === null ? 'all' : 'sample' },
        appVersion,
      });

      return {
        ok: true,
        action,
        jobId,
        sampleUuid,
        /**
         * How many events were actually re-queued. ZERO IS A TRUE ANSWER and
         * is reported as one: a job already confirmed, superseded or in flight
         * is not retryable, and the administrator's intent is already
         * satisfied. `ok: true` with `requeued: 0` is the honest pair, which is
         * why this is a count rather than a boolean nobody would question.
         */
        requeued,
        message:
          requeued === 0
            ? 'There was nothing waiting to retry. A job already confirmed or superseded needs none.'
            : `${requeued} job(s) are queued to be written again. They are not in Google Sheets until the worker confirms each one.`,
      };
    },
  };
}

async function handler(ctx: RequestContext): Promise<Response> {
  return await runMutation(ctx, (body) => {
    const action = parseAction(body['action'], SYNC_ACTIONS);
    if (action === null) {
      throw new ApiError('bad_request', {
        message: 'An unknown synchronisation action was requested.',
        details: { field: 'action', allowed: SYNC_ACTIONS },
      });
    }
    return syncSpec(action);
  });
}

serveFunction({ name: 'sync-action', methods: ['POST'] }, handler);
