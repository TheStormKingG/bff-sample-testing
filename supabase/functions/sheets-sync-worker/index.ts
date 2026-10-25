/**
 * POST /sheets-sync-worker — the serialised, fenced writer for the operational
 * Google Sheet.
 *
 * Master Prompt §7. This entrypoint is deliberately thin: every decision it
 * makes is a pure function in `_shared/` that the unit suite exercises with no
 * network and no database. What lives here is only the wiring that cannot be
 * tested without Deno — reading secrets, building the real adapter, taking the
 * lease, and releasing it on the way out.
 *
 * THE ORDER, AND WHY.
 *
 *  0. REFUSE WITHOUT SECRETS. `SHEETS_SPREADSHEET_ID` and
 *     `GOOGLE_SERVICE_ACCOUNT_JSON` have no default and no fallback anywhere in
 *     this codebase (build rule 1). An unset id is a hard refusal, because the
 *     alternative — a default — is precisely the mechanism by which a
 *     misconfigured deployment would write into the preserved draft workbook.
 *     The response names the MISSING KEYS and never a value.
 *
 *  1. AUTHORISE THE CALLER. Either the scheduler's shared secret (compared in
 *     constant time, and unavailable when the secret is unset — there is no
 *     "allow when unconfigured" branch) or an authenticated user holding
 *     `sync.retry`. Never anonymous.
 *
 *  2. TAKE THE LEASE AND KEEP ITS FENCE. One lease per workbook. The fence is
 *     a monotonically increasing token issued by the database on every
 *     acquisition, including a takeover of a lapsed lease. Every subsequent
 *     write and every bookkeeping call carries it, and the SQL side rejects a
 *     token below the current one — so worker A, which stalled past its TTL
 *     and woke up believing it still holds the lease, has its late write
 *     refused. A lease alone cannot do that; only the fence can. `runSyncPass`
 *     renews per event, so a long queue cannot lapse half-way through.
 *
 *  3. VERIFY ROW-4 HEADERS BEFORE THE FIRST WRITE. Done here, in this
 *     invocation, for every stage present in the claimed batch — not merely
 *     "if the stored verification has gone stale". On any mismatch the
 *     workbook is latched as drifted and the pass stops without writing a
 *     single cell. Writing a 19-column row against headers that moved is a
 *     silently corrupted quality record, so this fails closed.
 *
 *     Because this check writes a fresh verification state covering those
 *     stages, `processEvent`'s own `needsVerification` call then finds nothing
 *     due and costs no extra Sheets reads. It remains the backstop for any
 *     stage this upfront pass did not cover.
 *
 *  4. PROCESS THE BATCH. `runSyncPass` -> `processEvent` locates every record
 *     by its immutable sample ID in column A before deciding anything, appends
 *     exactly one row on a first registration, updates that same row
 *     thereafter, relocates by identifier when the sheet has been sorted,
 *     reads every write back before calling it confirmed, treats a timeout as
 *     an UNKNOWN outcome that must reconcile before retrying, backs off with
 *     bounded jitter, and dead-letters to a visible `needs_attention` state.
 *     None of that is reimplemented here.
 *
 *  5. RELEASE THE LEASE. In a `finally`, and under the fence, so a release
 *     cannot steal a lease that has since moved on.
 *
 * WRITE SAFETY INVARIANTS THIS FUNCTION RELIES ON, STATED SO THEY ARE NOT
 * SILENTLY LOST:
 *
 *  - `valueInputOption` is `RAW` and nothing else (`SHEETS_VALUE_INPUT_OPTION`
 *    in `_shared/sheets.ts`). `USER_ENTERED` is FORBIDDEN because it parses
 *    each cell the way a human typing it would: a leading `=` becomes a live
 *    formula (PRD §6.1 formula injection), `1-2` becomes a date, `0005` loses
 *    its zeros, and a comment containing `+1 (592) 000-0000` becomes an
 *    arithmetic error. Two of those are data corruption and one is an
 *    injection vector, so the option is not configurable from a request.
 *  - Rows 1-4 are never written. `assertWritableRange` refuses a first row
 *    below `FIRST_DATA_ROW`, and `rangeForRow` refuses the same independently.
 *  - The "Read me" and "Limits" tabs are never written. `isWritableTab`
 *    permits only the seven operational tabs, so a range addressed at a
 *    reference tab is refused before a request is built.
 */

import {
  jsonResponse,
  readJsonBody,
  serveFunction,
  type RequestContext,
} from '../_shared/adapters/http.ts';
import { ApiError } from '../_shared/errors.ts';
import {
  isSchedulerRequest,
  REQUIRED_SHEETS_KEYS,
  sheetsConfigured,
} from '../_shared/adapters/env.ts';
import {
  adminClient,
  authenticate,
  recordAudit,
  requirePermission,
} from '../_shared/adapters/authorize.ts';
import { SupabaseSyncStore, WORKBOOK_KEY } from '../_shared/adapters/store.ts';
import { GoogleSheetsApiAdapter } from '../_shared/adapters/googleSheets.ts';
import { readInteger } from '../_shared/adapters/mutation.ts';
import {
  DEFAULT_LEASE_TTL_MS,
  validateFence,
  type FenceClaim,
} from '../_shared/lease.ts';
import { needsVerification, verifySchema } from '../_shared/headerCheck.ts';
import { LeaseLostError, runSyncPass, type WorkerLogRecord } from '../_shared/syncWorker.ts';
import { DEFAULT_BACKOFF } from '../_shared/backoff.ts';
import { SHEETS_VALUE_INPUT_OPTION } from '../_shared/sheets.ts';
import type { OutboxEvent } from '../_shared/outbox.ts';
import type { Stage } from '../../../src/forms/types.ts';
import { STAGE_SCHEMAS } from '../../../src/forms/registry.ts';

/** Events per invocation. Bounded so one pass cannot outlive the platform's limit. */
const DEFAULT_BATCH_LIMIT = 25;
const MAX_BATCH_LIMIT = 100;

/** Who the caller is, for the log and the audit event. */
type Invoker =
  | { readonly kind: 'scheduler' }
  | { readonly kind: 'user'; readonly userId: string };

async function authoriseCaller(ctx: RequestContext, appVersion: string): Promise<Invoker> {
  if (isSchedulerRequest(ctx.request)) return { kind: 'scheduler' };

  // Not the scheduler, so this must be a named person asking for a manual run.
  const actor = await authenticate(ctx.bearerToken);
  await requirePermission({
    actor,
    permission: 'sync.retry',
    action: 'run_sheets_sync',
    subjectType: 'sheet_sync',
    subjectId: WORKBOOK_KEY,
    appVersion,
  });
  return { kind: 'user', userId: actor.userId };
}

function batchLimit(body: Record<string, unknown>): number {
  const requested = readInteger(body, 'limit', { min: 1 });
  if (requested === null) return DEFAULT_BATCH_LIMIT;
  return Math.min(requested, MAX_BATCH_LIMIT);
}

/** Distinct stages in the claimed batch, in registry order. */
function stagesIn(events: readonly OutboxEvent[]): readonly Stage[] {
  const seen = new Set<Stage>();
  for (const event of events) seen.add(event.stage);
  return [...seen];
}

async function handler(ctx: RequestContext): Promise<Response> {
  const log = (record: WorkerLogRecord): void => {
    console.log(JSON.stringify({ fn: 'sheets-sync-worker', correlationId: ctx.correlationId, ...record }));
  };

  // 0. Configuration, before anything else. Nothing below can run without it,
  //    and a caller is told WHICH keys are absent so setup is actionable.
  if (!sheetsConfigured()) {
    const missing = REQUIRED_SHEETS_KEYS.filter((key) => {
      const value = Deno.env.get(key);
      return value === undefined || value.trim() === '';
    });
    throw new ApiError('configuration_missing', {
      message:
        'Google Sheets synchronisation is not configured. The worker refuses to run rather than fall back to a default spreadsheet.',
      // Names only. No value, no length, no prefix.
      details: { missing },
      internalDetail: `sheets-sync-worker refused: ${missing.join(', ')} unset`,
    });
  }

  const body = await readJsonBody(ctx.request);
  const invoker = await authoriseCaller(ctx, ctx.appVersion);
  const limit = batchLimit(body);

  const admin = adminClient();
  const store = new SupabaseSyncStore(admin);
  // `fromEnvironment` reads the secrets through `readSheetsConfig`, which
  // throws `SheetsConfigurationError` if any is unset. The explicit check above
  // runs first only so the refusal names every missing key at once instead of
  // surfacing as a generic configuration error.
  const adapter = GoogleSheetsApiAdapter.fromEnvironment();

  // 2. The lease. `correlationId` is this invocation's identity: an opaque
  //    per-run value, never a user, so two runs by the same person still
  //    contend correctly.
  const owner = ctx.correlationId;
  const lease = await store.acquireLease(owner, DEFAULT_LEASE_TTL_MS);
  if (lease === null) {
    throw new ApiError('lease_conflict', {
      internalDetail: 'acquireLease returned no row',
    });
  }

  const claim: FenceClaim = { owner: lease.owner, fence: lease.fence };

  // The acquisition may have been refused in favour of a live holder, in which
  // case the row we read back belongs to somebody else. Validate rather than
  // assume: an unchecked acquisition is how two workers both believe they won.
  const held = validateFence(lease, claim, new Date());
  if (!held.ok || lease.owner !== owner) {
    log({ event: 'lease_declined', reason: held.ok ? 'owner_mismatch' : held.reason });
    throw new ApiError('lease_conflict', {
      internalDetail: `lease held by another worker (fence ${lease.fence})`,
    });
  }

  try {
    const events = await store.claimBatch(claim, limit);

    if (events.length === 0) {
      log({ event: 'pass_empty', fence: claim.fence });
      return jsonResponse(
        {
          ok: true,
          invokedBy: invoker.kind,
          fence: claim.fence,
          claimed: 0,
          processed: 0,
          confirmed: 0,
          noop: 0,
          retrying: 0,
          deadLettered: 0,
          superseded: 0,
          schemaDrift: null,
          abortedBecause: null,
          valueInputOption: SHEETS_VALUE_INPUT_OPTION,
          message: 'Nothing was due. No Google Sheets call was made.',
        },
        { request: ctx.request },
      );
    }

    // 3. Headers, before the first write of THIS invocation.
    const stages = stagesIn(events);
    const verification = await store.readVerificationState();

    if (verification.schemaDrifted) {
      log({ event: 'pass_blocked', reason: 'schema_drifted_latched' });
      throw new ApiError('schema_drift', {
        details: {
          latched: true,
          tabs: stages.map((s) => STAGE_SCHEMAS[s].sheetTab),
        },
        internalDetail: 'workbook is latched as schema-drifted; an administrator must re-verify',
      });
    }

    // Forced for this invocation. `needsVerification` is still consulted so
    // the reason the check ran is recorded honestly in the log, but the read
    // happens either way before any cell is written.
    const wasDue = needsVerification(verification, stages, new Date());
    const read = await adapter.verifyWorkbook(stages);
    const schema = verifySchema(read.reading, stages);

    if (!schema.ok) {
      await store.markSchemaDrifted({ claim, problems: schema.problems });
      log({
        event: 'schema_drift_detected',
        stages,
        problems: schema.problems.map((p) => p.message),
      });
      await recordAudit({
        actorId: invoker.kind === 'user' ? invoker.userId : null,
        action: 'run_sheets_sync',
        subjectType: 'sheet_sync',
        subjectId: WORKBOOK_KEY,
        outcome: 'error',
        reason: 'schema_drift',
        after: { problems: schema.problems.map((p) => p.message) },
        appVersion: ctx.appVersion,
      });
      throw new ApiError('schema_drift', {
        details: {
          // Structured so the admin screen can show which column moved.
          problems: schema.problems,
          columnsCompared: schema.columnsCompared,
        },
        internalDetail: `headers mismatched for ${stages.join(', ')}; no row was written`,
      });
    }

    await store.writeVerificationState({
      lastVerifiedAt: new Date().toISOString(),
      verifiedStages: schema.verifiedStages,
      schemaDrifted: false,
    });
    log({
      event: 'headers_verified',
      wasDue,
      stages: schema.verifiedStages,
      columnsCompared: schema.columnsCompared,
    });

    // 4. The pass.
    const summary = await runSyncPass(
      {
        adapter,
        store,
        claim,
        now: () => new Date(),
        random: () => Math.random(),
        policy: DEFAULT_BACKOFF,
        log,
        // Left OFF. The optimisation would append without reading column A
        // first, and locating before deciding is the whole anti-duplication
        // design — a saved read is not worth a second operational row.
        allowAppendWithoutLocate: false,
      },
      events,
    );

    await recordAudit({
      actorId: invoker.kind === 'user' ? invoker.userId : null,
      action: 'run_sheets_sync',
      subjectType: 'sheet_sync',
      subjectId: WORKBOOK_KEY,
      outcome: summary.deadLettered > 0 ? 'error' : 'allowed',
      reason: summary.abortedBecause,
      after: {
        fence: claim.fence,
        processed: summary.processed,
        confirmed: summary.confirmed,
        deadLettered: summary.deadLettered,
      },
      appVersion: ctx.appVersion,
    });

    return jsonResponse(
      {
        ok: summary.abortedBecause === null,
        invokedBy: invoker.kind,
        fence: claim.fence,
        claimed: events.length,
        processed: summary.processed,
        confirmed: summary.confirmed,
        noop: summary.noop,
        retrying: summary.retrying,
        deadLettered: summary.deadLettered,
        superseded: summary.superseded,
        schemaDrift: null,
        abortedBecause: summary.abortedBecause,
        valueInputOption: SHEETS_VALUE_INPUT_OPTION,
        results: summary.results.map((r) => ({
          eventId: r.eventId,
          outcome: r.outcome.kind,
          state: r.transition.state,
          attempts: r.transition.attempts,
          located: r.located,
          wrote: r.wrote,
          rowNumber: r.transition.confirmedRowNumber,
          deadLettered: r.transition.deadLettered,
          // The projection's own reason, so "why did nothing happen" is
          // answerable from the response rather than only from the log.
          decision: r.decision === null ? null : r.decision.action,
          decisionReason: r.decision === null ? null : r.decision.reason,
        })),
        message:
          summary.deadLettered > 0
            ? `${summary.deadLettered} event(s) need attention and will not be retried automatically.`
            : `${summary.confirmed + summary.noop} row(s) confirmed in Google Sheets.`,
      },
      { request: ctx.request },
    );
  } catch (error) {
    if (error instanceof LeaseLostError) {
      log({ event: 'pass_aborted', reason: error.reason });
      // A lost lease means a newer worker owns the workbook. That is the fence
      // doing its job, not a failure to report as an internal error.
      throw new ApiError('lease_conflict', {
        details: { reason: error.reason },
        internalDetail: error.message,
      });
    }
    throw error;
  } finally {
    try {
      // Under the fence: the SQL side refuses a release from a stale token, so
      // this cannot free a lease that has already moved to another worker.
      // A failed release is logged and swallowed — the lease expires on its
      // own TTL, and throwing from `finally` would replace the real outcome
      // (including a successful pass) with a bookkeeping error.
      await store.releaseLease(claim);
    } catch (error) {
      log({
        event: 'lease_release_failed',
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

serveFunction({ name: 'sheets-sync-worker', methods: ['POST'] }, handler);
