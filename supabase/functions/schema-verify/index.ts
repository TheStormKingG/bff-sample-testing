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
import { DEFAULT_LEASE_TTL_MS, validateFence, type FenceClaim } from '../_shared/lease.ts';
import { verifySchema, type SchemaProblem } from '../_shared/headerCheck.ts';
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
        tabs: unreadTabs(NOT_CONFIGURED),
        message: NOT_CONFIGURED,
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
        tabs: unreadTabs(READ_FAILED),
        message: READ_FAILED,
        correlationId: ctx.correlationId,
      },
      { request: ctx.request },
    );
  }

  const schema = verifySchema(reading.reading, STAGES);
  const checkedAt = new Date().toISOString();
  const previous = await store.readVerificationState();

  let driftLatched = false;
  if (!schema.ok && mayLatch) {
    /**
     * Latching is fenced in SQL, so it needs the workbook lease: the fence is
     * what stops a slow run that lost the workbook overwriting a newer
     * worker's verdict. A lease we cannot take is NOT a reason to withhold the
     * finding — the headers are reported either way, and `driftLatched` says
     * whether the stop was recorded.
     */
    const lease = await store.acquireLease(ctx.correlationId, DEFAULT_LEASE_TTL_MS);
    if (lease !== null && lease.owner === ctx.correlationId) {
      const claim: FenceClaim = { owner: lease.owner, fence: lease.fence };
      if (validateFence(lease, claim, new Date()).ok) {
        await store.markSchemaDrifted({ claim, problems: schema.problems });
        driftLatched = true;
      }
    }
    if (!driftLatched) {
      console.error(
        JSON.stringify({
          fn: 'schema-verify',
          correlationId: ctx.correlationId,
          event: 'schema_drift_not_latched',
          detail: 'the workbook lease is held elsewhere; drift was observed but not recorded',
        }),
      );
    }
  }

  if (schema.ok) {
    /**
     * `schemaDrifted` is carried forward, never cleared by a clean run.
     *
     * The latch exists so a workbook seen to be wrong stays fenced until a
     * person looks at it. A later clean read would otherwise silently unfence
     * it — and the likeliest reason for a clean read after a drift is that the
     * workbook was repaired badly or a different subset was checked, not that
     * all is well.
     */
    await store.writeVerificationState({
      lastVerifiedAt: checkedAt,
      verifiedStages: schema.verifiedStages,
      schemaDrifted: previous.schemaDrifted,
    });
  }

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
      driftLatched,
      alreadyDrifted: previous.schemaDrifted,
    },
    appVersion: ctx.appVersion,
  });

  const drifted = previous.schemaDrifted || !schema.ok;

  return jsonResponse(
    {
      ok: schema.ok,
      action,
      workbookKey: WORKBOOK_KEY,
      spreadsheetConfigured: true,
      checkedAt,
      /**
       * True when this workbook is fenced off — from THIS check or an earlier
       * one. A clean check does not clear an earlier latch, so `ok: true` with
       * `drifted: true` is a real and important combination: the columns match
       * now and writing is still stopped.
       */
      drifted,
      /** Whether THIS run recorded the stop, as opposed to merely seeing it. */
      driftLatched,
      verifiedStages: schema.verifiedStages,
      columnsCompared: schema.columnsCompared,
      tabs: toTabs(STAGES, schema.problems, schema.verifiedStages, checkedAt),
      message: schema.ok
        ? previous.schemaDrifted
          ? 'The column headings match the system, but this workbook is still marked as drifted from an earlier check. An administrator must clear that before writing resumes.'
          : 'The column headings match the system.'
        : driftLatched
          ? 'The Google Sheet column headings no longer match the system. Writing has been stopped until an administrator checks the workbook.'
          : 'The Google Sheet column headings no longer match the system. The stop could not be recorded by this check — an administrator with synchronisation rights must run it again.',
      correlationId: ctx.correlationId,
    },
    { request: ctx.request },
  );
}

serveFunction({ name: 'schema-verify', methods: ['POST'] }, handler);
