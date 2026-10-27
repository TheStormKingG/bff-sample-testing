/**
 * POST /schema-verify — compare row 4 of each operational tab against the
 * registry contract, and report what was actually read.
 *
 * Master Prompt §7 and build rule 6: nothing may be written to a workbook
 * whose columns have moved, because a row written against shifted headers puts
 * a moisture reading in the protein column and reads back as a successful
 * sync. The check itself is `_shared/headerCheck.ts`; this endpoint is how the
 * admin panel runs it. `src/hooks/useAdmin.ts` already posted
 * `{ action: 'verify_headers' }` to a function that did not exist, so the
 * panel could never read a live header.
 *
 * THE RESPONSE SHAPE IS THE CALLER'S, NOT THIS FILE'S. `useSchemaVerification`
 * reads `{ spreadsheetConfigured, checkedAt, tabs[] }` with one entry per
 * stage, and its own comment states the rule this endpoint has to make true:
 * "when the worker is unreachable the panel still shows the EXPECTED contract
 * from the registry and says plainly that the live headers were not read —
 * NEVER that they matched." So:
 *
 *  - unconfigured, or the Google read failed: `ok: false` with an `error` on
 *    every tab and `checkedAt: null`. Returned as 200, because the hook treats
 *    a transport error as a thrown exception and would lose the distinction
 *    between "not configured" and "the service is broken";
 *  - read and matching: `ok: true` per tab with the instant it was read;
 *  - read and NOT matching: `ok: false` per tab with the mismatches.
 *
 * `ok: false` with `mismatches: []` and `error: null` is unreachable by
 * construction — a tab is clean, has mismatches, or was not read — which is
 * what stops an empty failure rendering as a pass.
 *
 * TWO PERMISSIONS, because observing drift and recording it are different
 * acts. `sync.view` is enough to ASK (the panel is read-only to its user), but
 * a mismatch LATCHES the workbook as drifted, which stops every sheet write in
 * the deployment — a denial of service if anyone could trigger it. So the
 * latch additionally requires `sync.retry`. A caller holding only `sync.view`
 * is told the truth about the headers and the latch is left to somebody who
 * can be accountable for it; the response says which happened.
 *
 * NO SPREADSHEET ID APPEARS IN ANY RESPONSE. The workbook is identified by
 * `WORKBOOK_KEY`, a stable label. `SHEETS_SPREADSHEET_ID` is an Edge Function
 * secret with no default and is never echoed, not even to an administrator
 * (build rule 1), and `spreadsheetConfigured` is a BOOLEAN by key name — not a
 * length, not a prefix.
 *
 * ===========================================================================
 * THE LATCH LIFTS ITSELF. THREE THINGS THIS FILE GOT WRONG, MEASURED.
 * ===========================================================================
 * An operator latched the workbook at 18:58 (a legacy A5 formula on all seven
 * tabs), cleared the formulas at 19:12, and every check after that returned
 * HTTP 500 with "Something went wrong. Nothing was saved." It took direct
 * database access to recover. Three separate defects, all here:
 *
 *  1. THE LATCH COULD NOT LIFT. The clean branch carried the stored flag
 *     forward — `schemaDrifted: previous.schemaDrifted` — so a repaired
 *     workbook stayed fenced forever with no supported way out.
 *
 *  2. THE LATCHED STATE THREW. That same write passed the seven freshly
 *     verified stages ALONGSIDE `schemaDrifted: true`, and
 *     `rpc_write_workbook_verification` refuses exactly that pair
 *     (BFF_DRIFT_WITH_VERIFIED_STAGES) because `verified_stages` is the
 *     worker's write permit and a fenced workbook has no writable tab. The
 *     raise became `ApiError('internal')` and a generic 500 that named
 *     neither the latch nor the tabs.
 *
 *  3. THE LEASE WAS NEVER RELEASED. The latching path took the lease and
 *     returned without giving it back; the row sat expired for twenty
 *     minutes. (It did not wedge anything — `rpc_acquire_sheet_lease` takes
 *     over an expired lease and bumps the fence, measured — but a lease held
 *     by a finished request is a lie the sync-health screen repeats.)
 *
 * So now: `_shared/driftRecovery.ts` decides what happens to the latch and is
 * the testable half; this file is the adapter. A clean read of every
 * operational tab LIFTS the latch through `rpc_clear_schema_drift`, which is
 * fenced and writes its own audit event. No code path here ever sends
 * `schemaDrifted: true` with a non-empty stage list. Every state write is
 * caught, so a blocked or latched workbook returns a readable answer instead
 * of a 500. And the lease is released in a `finally`, on every exit path.
 */

import { ApiError } from '../_shared/errors.ts';
import {
  jsonResponse,
  readJsonBody,
  serveFunction,
  type RequestContext,
} from '../_shared/adapters/http.ts';
import { isSchedulerRequest, sheetsConfigured } from '../_shared/adapters/env.ts';
import {
  adminClient,
  authenticate,
  recordAudit,
  requirePermission,
} from '../_shared/adapters/authorize.ts';
import { SupabaseSyncStore, WORKBOOK_KEY } from '../_shared/adapters/store.ts';
import { GoogleSheetsApiAdapter } from '../_shared/adapters/googleSheets.ts';
import { verifySchema, type SchemaProblem } from '../_shared/headerCheck.ts';
import { runDriftRecovery } from '../_shared/driftRecovery.ts';
import { can } from '../../../src/lib/roles.ts';
import {
  parseAction,
  SCHEMA_DRIFT_LATCH_PERMISSION,
  SCHEMA_VERIFY_ACTIONS,
  SCHEMA_VERIFY_ACTION_PERMISSION,
} from '../_shared/actions.ts';
import { STAGE_SCHEMAS } from '../../../src/forms/registry.ts';
import { STAGES, type Stage } from '../../../src/forms/types.ts';
import type { HeaderMismatch } from '../../../src/forms/sheetMapping.ts';

/** Fixed operator-facing sentence. No probe here ever renders an exception. */
const READ_FAILED =
  'The live column headings could not be read. Quote the reference below to an administrator.';
const NOT_CONFIGURED =
  'Google Sheets synchronisation is not configured, so the live column headings were not read.';

interface TabVerification {
  readonly stage: Stage;
  readonly sheetTab: string;
  readonly ok: boolean;
  readonly checkedAt: string | null;
  readonly mismatches: readonly HeaderMismatch[];
  readonly error: string | null;
}

/**
 * One row per stage, in registry order, whatever happened.
 *
 * The panel renders the expected contract from the registry for every tab, so
 * a response that omitted the tabs it could not read would make them vanish
 * from the screen rather than show as unread.
 */
function unreadTabs(message: string): readonly TabVerification[] {
  return STAGES.map((stage) => ({
    stage,
    sheetTab: STAGE_SCHEMAS[stage].sheetTab,
    ok: false,
    checkedAt: null,
    mismatches: [],
    error: message,
  }));
}

/**
 * Turn the verification's problem list into per-tab rows.
 *
 * A `header_mismatch` problem carries the column and both strings, so it maps
 * onto `HeaderMismatch` exactly. Every other problem kind — a missing tab, a
 * legacy ID formula in A5, a stage that was not read — has no column, so it is
 * reported in `error` rather than squeezed into a mismatch with empty fields
 * that would render as "expected '' got ''".
 */
function toTabs(
  stages: readonly Stage[],
  problems: readonly SchemaProblem[],
  verified: readonly Stage[],
  checkedAt: string,
): readonly TabVerification[] {
  const cleared = new Set(verified);
  return stages.map((stage) => {
    const mine = problems.filter((p) => p.stage === stage);
    const mismatches: HeaderMismatch[] = mine
      .filter((p) => p.kind === 'header_mismatch' && p.columnLetter !== undefined)
      .map((p) => ({
        stage,
        columnLetter: p.columnLetter as string,
        expected: p.expected ?? '',
        actual: p.actual ?? '',
      }));
    const others = mine.filter((p) => p.kind !== 'header_mismatch');
    return {
      stage,
      sheetTab: STAGE_SCHEMAS[stage].sheetTab,
      ok: cleared.has(stage) && mine.length === 0,
      checkedAt,
      mismatches,
      error: others.length === 0 ? null : others.map((p) => p.message).join(' '),
    };
  });
}

async function handler(ctx: RequestContext): Promise<Response> {
  const body = await readJsonBody(ctx.request);
  const action = parseAction(body['action'] ?? 'verify_headers', SCHEMA_VERIFY_ACTIONS);
  if (action === null) {
    throw new ApiError('bad_request', {
      message: 'An unknown verification action was requested.',
      details: { field: 'action', allowed: SCHEMA_VERIFY_ACTIONS },
    });
  }
  const clearRequested = action === 'clear_drift';

  // Identity from the token, or the scheduler's shared secret. Never a body
  // field: a run that can latch drift must be attributable.
  let actorId: string | null = null;
  let mayLatch = false;
  if (isSchedulerRequest(ctx.request)) {
    mayLatch = true;
  } else {
    const actor = await authenticate(ctx.bearerToken);
    await requirePermission({
      actor,
      permission: SCHEMA_VERIFY_ACTION_PERMISSION[action],
      action: `schema_verify.${action}`,
      subjectType: 'sheet_sync',
      subjectId: WORKBOOK_KEY,
      appVersion: ctx.appVersion,
    });
    actorId = actor.userId;
    mayLatch = can(actor.authority, SCHEMA_DRIFT_LATCH_PERMISSION);
  }

  if (!sheetsConfigured()) {
    return jsonResponse(
      {
        ok: false,
        action,
        workbookKey: WORKBOOK_KEY,
        spreadsheetConfigured: false,
        checkedAt: null,
        drifted: false,
        driftLatched: false,
        driftLifted: false,
        problemsCleared: null,
        tabs: unreadTabs(NOT_CONFIGURED),
        affectedTabs: [],
        message: NOT_CONFIGURED,
        whatToDo:
          'An administrator must configure the Google Sheets connection before the live headings can be read.',
        correlationId: ctx.correlationId,
      },
      { request: ctx.request },
    );
  }

  const admin = adminClient();
  const store = new SupabaseSyncStore(admin);

  let reading;
  try {
    reading = await GoogleSheetsApiAdapter.fromEnvironment().verifyWorkbook(STAGES);
  } catch (error) {
    // The adapter's own message goes to the server log against this request's
    // correlation id; the caller gets a fixed sentence and NO claim about the
    // headers (build rule 6: no green that was not observed).
    console.error(
      JSON.stringify({
        fn: 'schema-verify',
        correlationId: ctx.correlationId,
        event: 'workbook_read_failed',
        detail: error instanceof Error ? error.message : String(error),
      }),
    );
    return jsonResponse(
      {
        ok: false,
        action,
        workbookKey: WORKBOOK_KEY,
        spreadsheetConfigured: true,
        checkedAt: null,
        drifted: false,
        driftLatched: false,
        driftLifted: false,
        problemsCleared: null,
        tabs: unreadTabs(READ_FAILED),
        affectedTabs: [],
        message: READ_FAILED,
        whatToDo:
          clearRequested
            ? 'The block cannot be cleared without reading the live workbook. Try again; if it persists, quote the reference below to an administrator.'
            : 'Try again. If it persists, quote the reference below to an administrator.',
        correlationId: ctx.correlationId,
      },
      { request: ctx.request },
    );
  }

  const schema = verifySchema(reading.reading, STAGES);
  const checkedAt = new Date().toISOString();
  const previous = await store.readVerificationState();

  /**
   * The decision, the write and the operator's sentence all live in
   * `_shared/driftRecovery.ts`, and so does the lease handling. It is decided
   * from the live reading and the stored flag ONLY: nothing a caller sends
   * reaches it — `ok` and `verifiedStages` come out of `verifySchema` over
   * what was just read from the workbook, and `mayLatch` comes from the token.
   * That is what makes a lifted latch a CONSEQUENCE of a passing read rather
   * than a request, and it is why the sequence is in a module a test can load
   * rather than inline here.
   *
   * `runDriftRecovery` does not throw. A latched, blocked or contended
   * workbook comes back as a state with a sentence, so this endpoint returns
   * 200 and a readable answer where it used to return a generic 500.
   */
  const outcome = await runDriftRecovery(
    {
      store,
      correlationId: ctx.correlationId,
      actorId,
      now: () => new Date(),
      log: (record) =>
        console.error(
          JSON.stringify({
            fn: 'schema-verify',
            correlationId: ctx.correlationId,
            event: record.event,
            detail: record.detail,
          }),
        ),
    },
    {
      verification: schema,
      requiredStages: STAGES,
      previouslyDrifted: previous.schemaDrifted,
      mayLatch,
      clearRequested,
      checkedAt,
    },
  );
  const plan = outcome.plan;
  const explanation = outcome.explanation;
  const drifted = outcome.drifted;

  await recordAudit({
    actorId,
    action: `schema_verify.${action}`,
    subjectType: 'sheet_sync',
    subjectId: WORKBOOK_KEY,
    outcome: 'allowed',
    reason: schema.ok ? 'schema_verified' : 'schema_mismatch_observed',
    after: {
      verifiedStages: schema.verifiedStages,
      columnsCompared: schema.columnsCompared,
      problemKinds: schema.problems.map((p) => p.kind),
      latchPlan: plan.action,
      driftLatched: outcome.driftLatched,
      driftLifted: outcome.driftLifted,
      problemsCleared: outcome.problemsCleared,
      stateWriteFailed: outcome.stateWriteFailed,
      alreadyDrifted: previous.schemaDrifted,
    },
    appVersion: ctx.appVersion,
  });

  return jsonResponse(
    {
      ok: schema.ok,
      action,
      workbookKey: WORKBOOK_KEY,
      spreadsheetConfigured: true,
      checkedAt,
      /**
       * True when this workbook is fenced off — from THIS check or an earlier
       * one. `ok: true` with `drifted: true` is still a real combination: the
       * columns match now and writing is stopped because the caller could not
       * lift the latch. It is no longer PERMANENT, which is the whole change.
       */
      drifted,
      /** Whether THIS run recorded the stop, as opposed to merely seeing it. */
      driftLatched: outcome.driftLatched,
      /** Whether THIS run lifted an earlier stop, having re-read the workbook. */
      driftLifted: outcome.driftLifted,
      /** Recorded divergences that were cleared with the latch, if any. */
      problemsCleared: outcome.problemsCleared,
      /** The plan, named, so the admin screen and the audit event agree. */
      latchPlan: plan.action,
      /** A state write did not land. The headings below were still read. */
      stateWriteFailed: outcome.stateWriteFailed,
      verifiedStages: schema.verifiedStages,
      columnsCompared: schema.columnsCompared,
      tabs: toTabs(STAGES, schema.problems, schema.verifiedStages, checkedAt),
      /** The tabs a person has to go and look at. Empty when nothing is wrong. */
      affectedTabs: explanation.affectedTabs,
      message: explanation.message,
      /** The next action, in plain words. Never "try again" for a real block. */
      whatToDo: explanation.whatToDo,
      correlationId: ctx.correlationId,
    },
    { request: ctx.request },
  );
}

serveFunction({ name: 'schema-verify', methods: ['POST'] }, handler);
