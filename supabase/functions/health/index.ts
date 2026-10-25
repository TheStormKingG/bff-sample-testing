/**
 * GET|POST /health — is the system up, is it installed, and is the Google
 * Sheets copy keeping up?
 *
 * TWO TIERS, and the split is the whole design of this file.
 *
 * The BASIC answer needs no privileged caller. A health endpoint that demands
 * a role cannot answer the one question it exists for — "is the deployment
 * alive?" — at the moment that matters, which is when sign-in is the thing
 * that is broken. So an unauthenticated caller gets liveness, the deployment
 * version, the clock (UTC and plant-local, because a wrong timezone is a real
 * failure mode here) and whether the database answers and has the migrations
 * applied. Nothing else.
 *
 * The DETAILED answer — which secrets are configured, schema-verification
 * state, outbox and dead-letter counts, reconciliation timestamps, the writer
 * lease, and an optional live Google probe — requires either the scheduler's
 * shared secret or an authenticated user holding `sync.view`. That is operational
 * intelligence: it tells a reader how far behind the sheet copy is, whether a
 * credential is installed, and whether a worker is mid-pass.
 *
 * WHAT NEVER APPEARS IN A RESPONSE FROM HERE:
 *
 *  - Any secret VALUE, and nothing derived from one. `presenceReport()` returns
 *    booleans by key NAME; not a length, not a prefix, not a fingerprint — a
 *    key length alone identifies which credential is installed. The
 *    spreadsheet id in particular is an Edge Function secret with no default
 *    (build rule 1) and is never echoed, not even to a privileged caller.
 *  - Any internal error detail. A failing probe reports a BOOLEAN and a fixed
 *    operator-facing sentence; the exception text, the driver message and the
 *    stack go to the server log against this request's correlation id, which
 *    the caller may quote. A health endpoint is the most-polled and
 *    least-authenticated surface in the deployment, so it is the worst place
 *    to render an exception.
 *
 * This endpoint never writes anything, and it never claims a Google Sheets
 * state it did not measure: when the Sheets probe is not run, `sheets` is
 * reported as `not_probed` — never as reachable (build rule 6's principle:
 * no green that was not observed).
 */

import {
  jsonResponse,
  serveFunction,
  type RequestContext,
} from '../_shared/adapters/http.ts';
import {
  isSchedulerRequest,
  presenceReport,
  sheetsConfigured,
} from '../_shared/adapters/env.ts';
import { adminClient, authenticate } from '../_shared/adapters/authorize.ts';
import { SupabaseSyncStore, WORKBOOK_KEY } from '../_shared/adapters/store.ts';
import { GoogleSheetsApiAdapter } from '../_shared/adapters/googleSheets.ts';
import { RPC, PGRST_FUNCTION_NOT_FOUND, type HealthSnapshotRow } from '../_shared/rpc.ts';
import { auditHealth, auditProblems } from '../_shared/auditDelivery.ts';
import { can } from '../../../src/lib/roles.ts';
import { formatPlantDateTimeLabelled, PLANT_TIME_ZONE, plantLocalDate } from '../../../src/lib/time.ts';

/** Fixed operator-facing sentences. No probe ever renders an exception. */
const PROBE_FAILED = 'The check could not be completed. Quote the reference below to an administrator.';

type DatabaseState = 'reachable' | 'unreachable';
type SheetsState = 'reachable' | 'unreachable' | 'not_configured' | 'not_probed';

interface DatabaseProbe {
  readonly state: DatabaseState;
  /** True only when the RPC contract this app depends on is actually present. */
  readonly migrationsApplied: boolean;
  readonly snapshot: HealthSnapshotRow | null;
}

/**
 * One call answers three questions: does the database answer, are the
 * migrations applied, and what are the sync counts.
 *
 * `PGRST202` is the interesting case — the database is up but
 * `rpc_health_snapshot` is not in the schema cache, which means the migrations
 * have not been applied. Reporting that as "unreachable" would send an
 * administrator to the network when the answer is `supabase db push`.
 */
async function probeDatabase(correlationId: string): Promise<DatabaseProbe> {
  try {
    const admin = adminClient();
    const { data, error } = await admin.rpc(RPC.healthSnapshot, {});
    if (error !== null) {
      if (error.code === PGRST_FUNCTION_NOT_FOUND) {
        return { state: 'reachable', migrationsApplied: false, snapshot: null };
      }
      console.error(
        JSON.stringify({
          fn: 'health',
          correlationId,
          event: 'health_snapshot_failed',
          detail: error.message,
        }),
      );
      return { state: 'unreachable', migrationsApplied: false, snapshot: null };
    }
    const row = (Array.isArray(data) ? data[0] : data) as HealthSnapshotRow | null | undefined;
    return {
      state: 'reachable',
      migrationsApplied: true,
      snapshot: row ?? null,
    };
  } catch (error) {
    console.error(
      JSON.stringify({
        fn: 'health',
        correlationId,
        event: 'health_database_threw',
        detail: error instanceof Error ? error.message : String(error),
      }),
    );
    return { state: 'unreachable', migrationsApplied: false, snapshot: null };
  }
}

/** Is the caller allowed the operational detail? */
async function callerIsPrivileged(ctx: RequestContext): Promise<boolean> {
  if (isSchedulerRequest(ctx.request)) return true;
  if (ctx.bearerToken === null) return false;
  try {
    const actor = await authenticate(ctx.bearerToken);
    return can(actor.authority, 'sync.view');
  } catch {
    // An unauthenticated, pending or suspended caller simply gets the basic
    // answer. A failed sign-in must not turn a liveness check into an error:
    // the one time this endpoint matters most is when auth itself is broken.
    return false;
  }
}

async function handler(ctx: RequestContext): Promise<Response> {
  const now = new Date();
  const privileged = await callerIsPrivileged(ctx);
  const db = await probeDatabase(ctx.correlationId);

  const basic = {
    /** `ok` means alive and installed. It says nothing about sync backlog. */
    status: db.state === 'reachable' && db.migrationsApplied ? 'ok' : 'unavailable',
    version: ctx.appVersion,
    time: {
      utc: now.toISOString(),
      plantLocal: formatPlantDateTimeLabelled(now),
      plantLocalDate: plantLocalDate(now),
      timeZone: PLANT_TIME_ZONE,
    },
    database: db.state,
    migrationsApplied: db.migrationsApplied,
    correlationId: ctx.correlationId,
  };

  if (!privileged) {
    return jsonResponse(
      {
        ...basic,
        detail: 'restricted',
        message:
          db.state === 'reachable' && db.migrationsApplied
            ? 'The system is running.'
            : 'The system is running but is not fully installed. An administrator must finish setup.',
      },
      { request: ctx.request },
    );
  }

  // ---- privileged detail ---------------------------------------------------

  // Booleans by key name. Never a value.
  const configuration = presenceReport();

  let verification: {
    lastVerifiedAt: string | null;
    verifiedStages: readonly string[];
    schemaDrifted: boolean;
    read: boolean;
  } = { lastVerifiedAt: null, verifiedStages: [], schemaDrifted: false, read: false };

  if (db.state === 'reachable' && db.migrationsApplied) {
    try {
      const store = new SupabaseSyncStore(adminClient());
      const state = await store.readVerificationState();
      verification = {
        lastVerifiedAt: state.lastVerifiedAt,
        verifiedStages: state.verifiedStages,
        schemaDrifted: state.schemaDrifted,
        read: true,
      };
    } catch (error) {
      console.error(
        JSON.stringify({
          fn: 'health',
          correlationId: ctx.correlationId,
          event: 'verification_state_unreadable',
          detail: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  // The Google probe costs an API call, so it is opt-in. Not probing is
  // reported as `not_probed`, never as reachable.
  let sheets: { state: SheetsState; latencyMs: number | null; message: string } = {
    state: sheetsConfigured() ? 'not_probed' : 'not_configured',
    latencyMs: null,
    message: sheetsConfigured()
      ? 'Google Sheets was not contacted by this check.'
      : 'Google Sheets synchronisation is not configured, so no workbook is being written.',
  };

  const wantSheetsProbe =
    new URL(ctx.request.url).searchParams.get('probeSheets') === 'true' ||
    ctx.request.headers.get('x-probe-sheets') === 'true';

  if (wantSheetsProbe && sheetsConfigured()) {
    try {
      const probe = await GoogleSheetsApiAdapter.fromEnvironment().healthCheck();
      if (probe.reachable) {
        sheets = {
          state: 'reachable',
          latencyMs: probe.latencyMs,
          message: 'Google Sheets answered.',
        };
      } else {
        console.error(
          JSON.stringify({
            fn: 'health',
            correlationId: ctx.correlationId,
            event: 'sheets_probe_failed',
            // The adapter's own message, server-side only.
            detail: probe.error,
          }),
        );
        sheets = { state: 'unreachable', latencyMs: null, message: PROBE_FAILED };
      }
    } catch (error) {
      console.error(
        JSON.stringify({
          fn: 'health',
          correlationId: ctx.correlationId,
          event: 'sheets_probe_threw',
          detail: error instanceof Error ? error.message : String(error),
        }),
      );
      sheets = { state: 'unreachable', latencyMs: null, message: PROBE_FAILED };
    }
  }

  const snapshot = db.snapshot;

  // Counts are reported as `null` when they were not read, never as 0. A zero
  // dead-letter count that was never measured is the worst possible answer
  // this endpoint could give.
  const sync = {
    read: snapshot !== null,
    pending: snapshot?.outbox_pending ?? null,
    retrying: snapshot?.outbox_retrying ?? null,
    /** The dead-letter queue. Anything above zero needs a person. */
    needsAttention: snapshot?.outbox_needs_attention ?? null,
    confirmedLast24h: snapshot?.outbox_confirmed_24h ?? null,
    oldestPendingAt: snapshot?.oldest_pending_at ?? null,
    lastConfirmedAt: snapshot?.last_confirmed_at ?? null,
  };

  const reconciliation = {
    read: snapshot !== null,
    lastReconciledAt: snapshot?.last_reconciled_at ?? null,
  };

  const lease = {
    workbookKey: WORKBOOK_KEY,
    // A holder is an opaque invocation id, not a person.
    held: (snapshot?.lease_owner ?? null) !== null,
    expiresAt: snapshot?.lease_expires_at ?? null,
    fence: snapshot?.lease_fence ?? null,
  };

  /**
   * The audit trail's own delivery state.
   *
   * `recordAudit` catches a failed write so a correct denial is still
   * returned, which means nothing upstream of here can report the failure.
   * This is its consumer: a non-zero count means FR-002's "denial AND logged
   * event" was only half met, and an UNAVAILABLE count means this deployment
   * could not tell either way — reported as a problem, not as zero.
   */
  const audit = auditHealth({
    snapshotRead: snapshot !== null,
    deadLetters: snapshot?.audit_dead_letters,
    oldestDeadLetterAt: snapshot?.audit_dead_letter_oldest_at,
  });

  const deadLettered = sync.needsAttention;
  const schemaDrifted = verification.schemaDrifted || (snapshot?.schema_drifted ?? false);

  const problems: string[] = [];
  if (basic.status !== 'ok') problems.push('The database is unreachable or the migrations are not applied.');
  if (!configuration['SHEETS_SPREADSHEET_ID']) {
    problems.push('SHEETS_SPREADSHEET_ID is not set, so the sync worker refuses to run.');
  }
  if (!configuration['GOOGLE_SERVICE_ACCOUNT_JSON']) {
    problems.push('GOOGLE_SERVICE_ACCOUNT_JSON is not set, so the sync worker refuses to run.');
  }
  if (!configuration['SYNC_SCHEDULER_SECRET']) {
    problems.push('SYNC_SCHEDULER_SECRET is not set, so scheduled synchronisation cannot be invoked.');
  }
  if (schemaDrifted) {
    problems.push('The workbook is marked as schema-drifted and writing is stopped.');
  }
  if (deadLettered !== null && deadLettered > 0) {
    problems.push(`${deadLettered} synchronisation job(s) need attention.`);
  }
  if (sheets.state === 'unreachable') problems.push('Google Sheets did not answer.');
  if (!verification.read && basic.status === 'ok') {
    problems.push('The schema-verification state could not be read.');
  }
  // Only reported once the deployment is installed: before that, "the audit
  // counter is unavailable" is a restatement of "the migrations are missing"
  // and would double-count the same fault.
  if (basic.status === 'ok') problems.push(...auditProblems(audit));

  return jsonResponse(
    {
      ...basic,
      detail: 'full',
      configuration,
      schemaVerification: {
        read: verification.read,
        lastVerifiedAt: verification.lastVerifiedAt,
        verifiedStages: verification.verifiedStages,
        drifted: schemaDrifted,
      },
      sheets,
      sync,
      /**
       * Beside `sync`, because they are the same kind of fact about two
       * different durable queues: how much of the record has not reached where
       * it must end up. `deadLetters` is `null` whenever it was not measured.
       */
      audit: {
        read: audit.read,
        state: audit.state,
        deadLetters: audit.deadLetters,
        oldestDeadLetterAt: audit.oldestDeadLetterAt,
        message: audit.message,
      },
      reconciliation,
      lease,
      problems,
      message:
        problems.length === 0
          ? 'The system is running and the Google Sheets copy is up to date.'
          : problems.join(' '),
    },
    { request: ctx.request },
  );
}

serveFunction({ name: 'health', methods: ['GET', 'POST'] }, handler);
