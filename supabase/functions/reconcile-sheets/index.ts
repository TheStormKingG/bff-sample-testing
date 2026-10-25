/**
 * POST /reconcile-sheets — the self-healing pass.
 *
 * Master Prompt §7: "Reconcile sample IDs, revisions and payload checksums;
 * surface drift caused by direct human sheet edits instead of silently
 * overwriting important records." PRD FR-016 requires the process to be
 * documented and NFR-001 requires the request registry to be reconciled
 * against the operational rows.
 *
 * REPORTS, DOES NOT REPAIR — with exactly two exceptions, both of which are
 * unambiguous by construction:
 *
 *   `missing_row`     the ledger holds a sample, no sheet row carries its ID,
 *                     and nothing is queued. A sync event is re-queued, which
 *                     puts the decision back through the fenced writer where
 *                     `decideProjection` re-checks before appending. Note that
 *                     a row CONFIRMED and then deleted by hand is still only
 *                     re-queued here; the writer refuses to re-append it
 *                     (`confirmed_row_missing`) so a hand deletion surfaces as
 *                     a block rather than being quietly undone.
 *   `row_relocated`   the values agree and only the row number moved, because
 *                     somebody sorted the sheet. The stored mapping is updated.
 *                     Nothing in the sheet is written.
 *
 * Everything else — a cell edited directly, a duplicated identifier, a row
 * with no identifier, a row the system has never heard of — is REPORTED with a
 * recommended action for a named human. Every one of those has a reading in
 * which overwriting would destroy real work: a quality officer correcting a
 * figure in the sheet, an administrator mid-way through a manual fix, a row
 * moved during an edit. An ambiguous finding is never repaired.
 *
 * HEADERS FIRST. If row-4 headers have moved, every column index in the
 * comparison means something different and a cell-level diff is noise. So the
 * headers are verified before any comparison, and on a mismatch the function
 * reports the drift and compares nothing.
 *
 * THE LEASE. A repairing run takes the workbook lease with its fence, so it
 * cannot interleave with the writer. A `dryRun` takes no lease and writes
 * nothing at all, so a supervisor can read the report without blocking sync.
 *
 * DATABASE CONTRACT THIS FUNCTION DEPENDS ON (declared by name in
 * `_shared/rpc.ts`, which does not fix their argument lists):
 *
 *   rpc_read_ledger_for_stage(p_stage, p_limit, p_offset)       -> LedgerRow[]
 *   rpc_requeue_outbox_event(p_sample_uuid, p_owner, p_fence, p_reason)
 *   rpc_write_reconciliation_report(p_workbook_key, p_started_at,
 *                                  p_finished_at, p_total_findings,
 *                                  p_clean, p_report)
 *
 * The first is specified in `rpc.ts`'s own comment. The other two are named
 * there but not shaped; these are the argument lists this caller sends.
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
import { DEFAULT_LEASE_TTL_MS, validateFence, type FenceClaim } from '../_shared/lease.ts';
import { verifySchema } from '../_shared/headerCheck.ts';
import {
  buildReport,
  reconcileStage,
  type DriftFinding,
  type LedgerRecord,
  type ReconciliationSummary,
} from '../_shared/reconcile.ts';
import { rowHash } from '../_shared/hash.ts';
import { RPC, type LedgerRow } from '../_shared/rpc.ts';
import { STAGE_SCHEMAS } from '../../../src/forms/registry.ts';
import { STAGES, type Stage } from '../../../src/forms/types.ts';
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.47.10';

/** Ledger rows read per page. The template is 304 rows; nothing assumes 300. */
const LEDGER_PAGE = 200;
/** Pages per stage, so a corrupted count cannot spin forever. */
const MAX_LEDGER_PAGES = 50;
/** Sheet rows examined per stage in one run. */
const DEFAULT_SHEET_LIMIT = 500;
const MAX_SHEET_LIMIT = 2_000;

type Invoker =
  | { readonly kind: 'scheduler' }
  | { readonly kind: 'user'; readonly userId: string };

function parseStages(value: unknown): readonly Stage[] {
  if (value === undefined || value === null) return STAGES;
  if (!Array.isArray(value)) {
    throw new ApiError('bad_request', { message: '"stages" must be a list of stage keys.' });
  }
  const out: Stage[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || !(STAGES as readonly string[]).includes(entry)) {
      throw new ApiError('bad_request', {
        message: `"${String(entry)}" is not a known form.`,
        details: { allowed: STAGES },
      });
    }
    if (!out.includes(entry as Stage)) out.push(entry as Stage);
  }
  return out.length === 0 ? STAGES : out;
}

async function authoriseCaller(
  ctx: RequestContext,
  dryRun: boolean,
): Promise<Invoker> {
  if (isSchedulerRequest(ctx.request)) return { kind: 'scheduler' };

  const actor = await authenticate(ctx.bearerToken);
  // A reporting run needs only `sync.view`. A run that may re-queue work or
  // move a stored row mapping needs `sync.retry`.
  await requirePermission({
    actor,
    permission: dryRun ? 'sync.view' : 'sync.retry',
    action: 'reconcile_sheets',
    subjectType: 'sheet_sync',
    subjectId: WORKBOOK_KEY,
    appVersion: ctx.appVersion,
  });
  return { kind: 'user', userId: actor.userId };
}

function toLedgerRecord(row: LedgerRow): LedgerRecord {
  return {
    sampleUuid: row.sample_uuid,
    sampleId: row.sample_id,
    stage: row.stage,
    revision: row.revision,
    row: row.row ?? [],
    confirmedRowNumber: row.confirmed_row_number,
    syncPending: row.sync_pending === true,
  };
}

/** Every ledger row for one stage, paged. */
async function readLedger(
  admin: SupabaseClient,
  stage: Stage,
): Promise<readonly LedgerRecord[]> {
  const out: LedgerRecord[] = [];
  for (let page = 0; page < MAX_LEDGER_PAGES; page++) {
    const { data, error } = await admin.rpc(RPC.readLedgerForStage, {
      p_stage: stage,
      p_limit: LEDGER_PAGE,
      p_offset: page * LEDGER_PAGE,
    });
    if (error !== null) {
      throw new ApiError(error.code === 'PGRST202' ? 'rpc_not_deployed' : 'internal', {
        internalDetail: `${RPC.readLedgerForStage}: ${error.message}`,
      });
    }
    const rows = (Array.isArray(data) ? data : []) as LedgerRow[];
    for (const row of rows) out.push(toLedgerRecord(row));
    if (rows.length < LEDGER_PAGE) return out;
  }
  // Reached the page ceiling. Reporting a partial comparison as complete would
  // be worse than refusing: a `missing_row` finding is only valid against a
  // ledger that was read in full.
  throw new ApiError('internal', {
    internalDetail: `${RPC.readLedgerForStage} exceeded ${MAX_LEDGER_PAGES} pages for ${stage}`,
  });
}

async function handler(ctx: RequestContext): Promise<Response> {
  const startedAt = new Date().toISOString();

  if (!sheetsConfigured()) {
    const missing = REQUIRED_SHEETS_KEYS.filter((key) => {
      const value = Deno.env.get(key);
      return value === undefined || value.trim() === '';
    });
    throw new ApiError('configuration_missing', {
      message:
        'Google Sheets synchronisation is not configured, so there is nothing to reconcile against.',
      details: { missing },
    });
  }

  const body = await readJsonBody(ctx.request);
  const dryRun = body['dryRun'] === true;
  const invoker = await authoriseCaller(ctx, dryRun);
  const stages = parseStages(body['stages']);
  const sheetLimit = Math.min(
    readInteger(body, 'limit', { min: 1 }) ?? DEFAULT_SHEET_LIMIT,
    MAX_SHEET_LIMIT,
  );

  const admin = adminClient();
  const store = new SupabaseSyncStore(admin);
  const adapter = GoogleSheetsApiAdapter.fromEnvironment();

  // The lease, for a repairing run only.
  let claim: FenceClaim | null = null;
  if (!dryRun) {
    const lease = await store.acquireLease(ctx.correlationId, DEFAULT_LEASE_TTL_MS);
    if (lease === null) {
      throw new ApiError('lease_conflict', { internalDetail: 'acquireLease returned no row' });
    }
    const candidate: FenceClaim = { owner: lease.owner, fence: lease.fence };
    const held = validateFence(lease, candidate, new Date());
    if (!held.ok || lease.owner !== ctx.correlationId) {
      throw new ApiError('lease_conflict', {
        internalDetail: 'the workbook lease is held by another worker',
      });
    }
    claim = candidate;
  }

  try {
    // 1. Headers. Nothing is compared against a workbook whose columns moved.
    const read = await adapter.verifyWorkbook(stages);
    const schema = verifySchema(read.reading, stages);
    if (!schema.ok) {
      if (claim !== null) {
        await store.markSchemaDrifted({ claim, problems: schema.problems });
      }
      return jsonResponse(
        {
          ok: false,
          dryRun,
          invokedBy: invoker.kind,
          startedAt,
          finishedAt: new Date().toISOString(),
          comparisonRan: false,
          schemaProblems: schema.problems,
          stages: [],
          totalFindings: 0,
          requeued: 0,
          mappingsUpdated: 0,
          clean: false,
          message:
            'The Google Sheet column headings no longer match the system, so no comparison was made. Nothing was changed. An administrator must check the workbook.',
        },
        { request: ctx.request, status: 200 },
      );
    }

    // 2. Compare, stage by stage. The ledger pages are kept so the repair
    //    step below needs no second read of the same rows.
    const summaries: ReconciliationSummary[] = [];
    const ledgerByStage = new Map<Stage, readonly LedgerRecord[]>();
    for (const stage of stages) {
      const ledger = await readLedger(admin, stage);
      ledgerByStage.set(stage, ledger);
      const sheet = await adapter.readForReconciliation(stage, { limit: sheetLimit });
      summaries.push(
        reconcileStage({
          stage,
          ledger,
          sheetRows: sheet.rows,
          blankIdRows: sheet.blankIdRows,
        }),
      );
    }

    const report = buildReport(summaries, startedAt, new Date().toISOString());

    // 3. The two unambiguous repairs. Skipped entirely on a dry run.
    let requeued = 0;
    let mappingsUpdated = 0;
    const repairFailures: string[] = [];

    if (claim !== null) {
      for (const entry of report.requeue) {
        const { error } = await admin.rpc(RPC.requeueOutboxEvent, {
          p_sample_uuid: entry.sampleUuid,
          p_owner: claim.owner,
          p_fence: claim.fence,
          p_reason: `Reconciliation found no row for ${entry.sampleId} in "${STAGE_SCHEMAS[entry.stage].sheetTab}".`,
        });
        if (error !== null) {
          // Reported, not thrown: one sample that cannot be re-queued must not
          // discard the findings for every other sample in the run.
          repairFailures.push(`${entry.sampleId}: could not re-queue`);
          continue;
        }
        requeued++;
      }

      const relocations: DriftFinding[] = summaries
        .flatMap((s) => s.findings)
        .filter((f) => f.kind === 'row_relocated' && f.action === 'update_row_mapping');

      for (const finding of relocations) {
        const rowNumber = finding.rowNumbers[0];
        if (rowNumber === undefined || finding.sampleUuid === null) continue;
        const record = (ledgerByStage.get(finding.stage) ?? []).find(
          (r) => r.sampleUuid === finding.sampleUuid,
        );
        if (record === undefined) continue;
        const width = STAGE_SCHEMAS[finding.stage].columnCount;
        try {
          await store.confirmRowMapping({
            claim,
            sampleUuid: record.sampleUuid,
            stage: finding.stage,
            rowNumber,
            revision: record.revision,
            // The values agreed — that is what made this a relocation rather
            // than a cell mismatch — so the ledger row's hash is the hash of
            // what the sheet holds.
            payloadHash: rowHash(record.row, width),
            confirmedAt: new Date().toISOString(),
          });
          mappingsUpdated++;
        } catch (error) {
          repairFailures.push(
            `${record.sampleId}: could not update the stored row mapping (${
              error instanceof ApiError ? error.code : 'error'
            })`,
          );
        }
      }

      const { error: reportError } = await admin.rpc(RPC.writeReconciliationReport, {
        p_workbook_key: WORKBOOK_KEY,
        p_started_at: report.startedAt,
        p_finished_at: report.finishedAt,
        p_total_findings: report.totalFindings,
        p_clean: report.clean,
        p_report: report,
      });
      if (reportError !== null) {
        repairFailures.push('the reconciliation report could not be recorded');
      }
    }

    await recordAudit({
      actorId: invoker.kind === 'user' ? invoker.userId : null,
      action: 'reconcile_sheets',
      subjectType: 'sheet_sync',
      subjectId: WORKBOOK_KEY,
      outcome: report.clean && repairFailures.length === 0 ? 'allowed' : 'error',
      reason: report.clean ? null : `${report.totalFindings} finding(s)`,
      after: {
        dryRun,
        stages,
        totalFindings: report.totalFindings,
        requeued,
        mappingsUpdated,
      },
      appVersion: ctx.appVersion,
    });

    return jsonResponse(
      {
        ok: repairFailures.length === 0,
        dryRun,
        invokedBy: invoker.kind,
        startedAt: report.startedAt,
        finishedAt: report.finishedAt,
        comparisonRan: true,
        schemaProblems: [],
        stages: summaries.map((s) => ({
          stage: s.stage,
          sheetTab: STAGE_SCHEMAS[s.stage].sheetTab,
          ledgerRecords: s.ledgerRecords,
          sheetRows: s.sheetRows,
          matched: s.matched,
          clean: s.clean,
          findings: s.findings,
        })),
        totalFindings: report.totalFindings,
        requeued,
        mappingsUpdated,
        /** Findings a named human must resolve. Never repaired here. */
        needsHuman: summaries
          .flatMap((s) => s.findings)
          .filter((f) => f.action !== 'update_row_mapping' && f.action !== 'none')
          .map((f) => ({
            kind: f.kind,
            stage: f.stage,
            sheetTab: STAGE_SCHEMAS[f.stage].sheetTab,
            sampleId: f.sampleId,
            rowNumbers: f.rowNumbers,
            action: f.action,
            message: f.message,
            differences: f.differences,
          })),
        repairFailures,
        clean: report.clean,
        message: report.clean
          ? 'The system record and the Google Sheet agree.'
          : `${report.totalFindings} difference(s) found. ${requeued} sync event(s) re-queued, ${mappingsUpdated} row mapping(s) updated; the rest need a person to look at them.`,
      },
      { request: ctx.request },
    );
  } finally {
    if (claim !== null) {
      try {
        await store.releaseLease(claim);
      } catch (error) {
        console.error(
          JSON.stringify({
            fn: 'reconcile-sheets',
            correlationId: ctx.correlationId,
            event: 'lease_release_failed',
            detail: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    }
  }
}

serveFunction({ name: 'reconcile-sheets', methods: ['POST'] }, handler);
