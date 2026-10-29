/**
 * POST /register-sample — allocate an immutable identifier and persist the
 * first operational row, in one transaction with its outbox event.
 *
 * FR-006: "create unique durable sample identifiers and persist first data
 * row. Acceptance: concurrent registration yields unique IDs and retried
 * request returns original registration."
 *
 * The identifier is NOT allocated here. `rpc_register_sample` allocates it
 * inside the transaction against `sample_id_counters`, keyed on
 * (prefix, plant-local collection date), under a row lock. Master Prompt §5
 * forbids computing the sequence "by COUNTIF, scanning last row or frontend
 * counters", all three of which are read-then-write races. This function's job
 * is to establish WHICH counter to contend on — which is why it resolves the
 * prefix from the structured sampling-point code and the collection date from
 * plant-local time rather than from the server's UTC calendar day.
 */

import { fromPlantParts, PLANT_TIME_ZONE } from '../../../src/lib/time.ts';
import { STAGE_SCHEMAS } from '../../../src/forms/registry.ts';
import { ApiError } from '../_shared/errors.ts';
import { serveFunction, type RequestContext } from '../_shared/adapters/http.ts';
import {
  callTransaction,
  readValues,
  runMutation,
  readString,
} from '../_shared/adapters/mutation.ts';
import { parseStage, validateStagePayload, prefixFor } from '../_shared/validation.ts';
import { RPC, type RegisterSampleResult } from '../_shared/rpc.ts';
import { syncStatusFor } from '../_shared/syncStatus.ts';
import { recordAudit } from '../_shared/adapters/authorize.ts';
import { resolveWaitUntil } from '../_shared/syncKick.ts';
import { kickSyncWorker } from '../_shared/adapters/syncKickAdapter.ts';

interface LinkInput {
  readonly kind: string;
  readonly reference: string;
}

/**
 * Upstream links are recorded exactly as declared. PRD §6.4: "A missing
 * upstream link is a recorded exception, not silent inference" — so nothing
 * here guesses a batch relationship from a matching number.
 */
function readLinks(body: Record<string, unknown>): readonly LinkInput[] {
  const raw = body['links'];
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new ApiError('bad_request', { message: '"links" must be a list.' });
  }
  return raw.map((entry, i) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new ApiError('bad_request', { message: `links[${i}] must be an object.` });
    }
    const record = entry as Record<string, unknown>;
    const kind = record['kind'];
    const reference = record['reference'];
    if (typeof kind !== 'string' || kind === '' || typeof reference !== 'string' || reference === '') {
      throw new ApiError('bad_request', {
        message: `links[${i}] needs a "kind" and a "reference".`,
      });
    }
    return { kind, reference };
  });
}

function readConfirmed(body: Record<string, unknown>): readonly string[] {
  const raw = body['confirmedImplausible'];
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is string => typeof v === 'string');
}

async function handler(ctx: RequestContext): Promise<Response> {
  return await runMutation(ctx, {
    operation: 'register_sample',
    permission: 'sample.register',
    subjectType: 'sample',
    run: async ({
      actor,
      admin,
      body,
      idempotencyKey,
      payloadHash,
      appVersion,
      markCommitted,
    }) => {
      const stage = parseStage(body['stage']);
      if (stage === null) {
        throw new ApiError('bad_request', { message: 'An unknown form was submitted.' });
      }

      const values = readValues(body);
      const validation = validateStagePayload({
        stage,
        phase: 'registration',
        values,
        confirmedImplausible: readConfirmed(body),
      });
      if (!validation.ok) {
        throw new ApiError('validation_failed', { details: { issues: validation.issues } });
      }

      const prefix = prefixFor(stage, validation.values as Record<string, unknown>);
      if (!prefix.ok) {
        throw new ApiError('validation_failed', { details: { issues: [prefix.issue] } });
      }

      // Validation has already proved these are present and well formed for
      // the registration phase; the casts are reading back our own output.
      const collectionDate = String(validation.values['collection_date']);
      const collectionTime = String(validation.values['collection_time']);

      // Plant-local wall clock -> UTC instant. Stored separately from the
      // local pair, per NFR-008, so neither representation is derived at
      // display time from a device locale.
      let collectedAt: Date;
      try {
        collectedAt = fromPlantParts(collectionDate, collectionTime);
      } catch {
        throw new ApiError('validation_failed', {
          details: {
            issues: [
              {
                field: 'collection_time',
                code: 'bad_time',
                message: `That date and time could not be read as ${PLANT_TIME_ZONE} local time.`,
              },
            ],
          },
        });
      }

      const result = await callTransaction<RegisterSampleResult>(admin, RPC.registerSample, {
        p_actor: actor.userId,
        p_idempotency_key: idempotencyKey,
        p_payload_hash: payloadHash,
        p_app_version: appVersion,
        p_stage: stage,
        p_prefix: prefix.prefix,
        p_collection_date: collectionDate,
        p_collection_time: collectionTime,
        p_collected_at: collectedAt.toISOString(),
        p_values: validation.values,
        p_row: validation.row,
        p_links: readLinks(body),
        p_notes: readString(body, 'notes', { maxLength: 2000 }),
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
        recordedAt: result.recorded_at,
        outboxEventId: result.outbox_event_id,
      });

      await recordAudit({
        actorId: actor.userId,
        action: 'register_sample',
        subjectType: 'sample',
        subjectId: result.sample_uuid,
        outcome: 'allowed',
        after: { sample_id: result.sample_id, stage, revision: result.revision },
        appVersion,
      });

      /**
       * NUDGE THE SYNC WORKER. Best effort, after the fact, never awaited.
       *
       * The row is queued at this point and nothing in this codebase drains
       * the queue — `docs/setup.md` section 7 records that gap as D-18 — so
       * without this the operator watches "Google Sheets sync pending" until
       * somebody invokes the worker by hand.
       *
       * `resolveWaitUntil` is feature-detected rather than assumed, because
       * `EdgeRuntime` appears nowhere else in this codebase and a bare
       * reference would throw a ReferenceError on a path where the sample is
       * ALREADY COMMITTED — telling the operator their save failed when it
       * did not.
       *
       * When the runtime offers no post-response hook the kick is not
       * dispatched AT ALL, rather than started and killed mid-flight: a fetch
       * torn down halfway can leave the worker's 60-second lease leaked, and
       * a leaked lease blocks every other runner. Not kicking is strictly
       * better than kicking unsafely.
       *
       * THIS IS NOT A SCHEDULER. A transient failure re-queues the event for
       * an instant in the future, and nothing edge-triggered fires then. The
       * periodic runner is still required; see the README section this commit
       * adds.
       */
      const waitUntil = resolveWaitUntil(globalThis as unknown as Record<string, unknown>);
      if (waitUntil !== null) {
        waitUntil(
          kickSyncWorker({
            correlationId: ctx.correlationId,
            outboxEventId: result.outbox_event_id ?? null,
          }),
        );
      }

      return {
        sampleUuid: result.sample_uuid,
        sampleId: result.sample_id,
        stage,
        sheetTab: STAGE_SCHEMAS[stage].sheetTab,
        revision: result.revision,
        captureState: result.capture_state,
        recordedAt: result.recorded_at,
        collection: {
          plantLocalDate: collectionDate,
          plantLocalTime: collectionTime,
          instant: collectedAt.toISOString(),
          timeZone: PLANT_TIME_ZONE,
        },
        // The row is queued, never written here. Saying anything else would be
        // the false green that build rule 6 forbids.
        sheetSync: syncStatusFor({ outboxState: 'pending' }),
        outboxEventId: result.outbox_event_id,
        // The columns the server computed, so the confirmation screen can show
        // the operator their results without a second request. These are the
        // SAME strings that went into the projected row and that the outbox
        // trigger stored, not a recomputation — a screen that recomputed could
        // disagree with the record it is confirming.
        derived: validation.derived,
      };
    },
  });
}

serveFunction({ name: 'register-sample', methods: ['POST'] }, handler);
