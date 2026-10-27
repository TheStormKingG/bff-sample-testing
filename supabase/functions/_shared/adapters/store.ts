/**
 * Database side of the sync worker and the idempotency registry. DENO-ONLY.
 *
 * Every write here goes through an RPC declared in `_shared/rpc.ts` and
 * carries the worker's fence. The fence is re-checked IN SQL, not here: a
 * check in this file would be advisory, because the process doing the checking
 * is the same process whose staleness is in question. Only the database knows
 * the current fence.
 */

import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.47.10';

import { STAGES, type Stage } from '../../../../src/forms/types.ts';
import { ApiError } from '../errors.ts';
import type { VerificationState, SchemaProblem } from '../headerCheck.ts';
import type { FenceClaim, LeaseState } from '../lease.ts';
import type { OutboxEvent, OutboxEventKind, OutboxState, OutboxTransition } from '../outbox.ts';
import { OUTBOX_EVENT_KINDS, OUTBOX_STATES } from '../outbox.ts';
import type { ProjectionDecision } from '../projection.ts';
import type { SyncStore } from '../syncWorker.ts';
import {
  PGRST_FUNCTION_NOT_FOUND,
  RPC,
  type BeginIdempotentRow,
  type IdempotencyRow,
  type LeaseRow,
  type OutboxRow,
  type SampleProjectionRow,
  type SampleSyncStateRow,
  type WorkbookStateRow,
} from '../rpc.ts';
import type { IdempotencyRecord, IdempotencyState } from '../idempotency.ts';

function mapRpcError(name: string, error: { code?: string; message: string }): ApiError {
  if (error.code === PGRST_FUNCTION_NOT_FOUND) {
    return new ApiError('rpc_not_deployed', { internalDetail: `${name}: ${error.message}` });
  }
  return new ApiError('internal', { internalDetail: `${name}: ${error.message}` });
}

async function callRpc<T>(
  client: SupabaseClient,
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  const { data, error } = await client.rpc(name, args);
  if (error !== null) throw mapRpcError(name, error);
  return data as T;
}

function firstRow<T>(data: unknown): T | null {
  if (Array.isArray(data)) return (data[0] ?? null) as T | null;
  return (data ?? null) as T | null;
}

function asStage(value: unknown): Stage {
  if (typeof value === 'string' && (STAGES as readonly string[]).includes(value)) {
    return value as Stage;
  }
  throw new ApiError('internal', { internalDetail: `unknown stage ${String(value)}` });
}

function asKind(value: unknown): OutboxEventKind {
  if (typeof value === 'string' && (OUTBOX_EVENT_KINDS as readonly string[]).includes(value)) {
    return value as OutboxEventKind;
  }
  throw new ApiError('internal', { internalDetail: `unknown outbox kind ${String(value)}` });
}

function asOutboxState(value: unknown): OutboxState {
  if (typeof value === 'string' && (OUTBOX_STATES as readonly string[]).includes(value)) {
    return value as OutboxState;
  }
  throw new ApiError('internal', { internalDetail: `unknown outbox state ${String(value)}` });
}

function toLease(row: LeaseRow | null): LeaseState | null {
  if (row === null) return null;
  return {
    workbookKey: row.workbook_key,
    owner: row.owner,
    fence: row.fence,
    acquiredAt: row.acquired_at,
    expiresAt: row.expires_at,
  };
}

export function toOutboxEvent(row: OutboxRow): OutboxEvent {
  return {
    id: row.id,
    sampleUuid: row.sample_uuid,
    sampleId: row.sample_id,
    stage: asStage(row.stage),
    kind: asKind(row.kind),
    revision: row.revision,
    payloadHash: row.payload_hash,
    row: row.row ?? [],
    state: asOutboxState(row.state),
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    reconcileFirst: row.reconcile_first === true,
    lastError: row.last_error,
    confirmedRowNumber: row.confirmed_row_number,
    confirmedAt: row.confirmed_at,
    createdAt: row.created_at,
  };
}

/**
 * `workbookKey` is a STABLE LABEL for the workbook, not the spreadsheet id.
 *
 * The lease row is readable by any administrator through the sync-health
 * screen, and the spreadsheet id is an Edge Function secret (build rule 1).
 * Keying the lease on a hash-free constant keeps the secret out of a
 * user-visible table while still giving one lease per deployment target.
 */
export const WORKBOOK_KEY = 'operational-workbook';

export class SupabaseSyncStore implements SyncStore {
  constructor(
    private readonly admin: SupabaseClient,
    private readonly workbookKey: string = WORKBOOK_KEY,
  ) {}

  async acquireLease(owner: string, ttlMs: number): Promise<LeaseState | null> {
    const data = await callRpc<unknown>(this.admin, RPC.acquireSheetLease, {
      p_workbook_key: this.workbookKey,
      p_owner: owner,
      p_ttl_ms: ttlMs,
    });
    return toLease(firstRow<LeaseRow>(data));
  }

  async readLease(): Promise<LeaseState | null> {
    const data = await callRpc<unknown>(this.admin, RPC.readSheetLease, {
      p_workbook_key: this.workbookKey,
    });
    return toLease(firstRow<LeaseRow>(data));
  }

  async renewLease(claim: FenceClaim): Promise<LeaseState | null> {
    const data = await callRpc<unknown>(this.admin, RPC.renewSheetLease, {
      p_workbook_key: this.workbookKey,
      p_owner: claim.owner,
      p_fence: claim.fence,
      p_ttl_ms: 60_000,
    });
    return toLease(firstRow<LeaseRow>(data));
  }

  async releaseLease(claim: FenceClaim): Promise<void> {
    await callRpc(this.admin, RPC.releaseSheetLease, {
      p_workbook_key: this.workbookKey,
      p_owner: claim.owner,
      p_fence: claim.fence,
    });
  }

  async claimBatch(claim: FenceClaim, limit: number): Promise<OutboxEvent[]> {
    const data = await callRpc<unknown>(this.admin, RPC.claimOutboxBatch, {
      p_workbook_key: this.workbookKey,
      p_owner: claim.owner,
      p_fence: claim.fence,
      p_limit: limit,
    });
    const rows = (Array.isArray(data) ? data : []) as OutboxRow[];
    return rows.map(toOutboxEvent);
  }

  async readVerificationState(): Promise<VerificationState> {
    const data = await callRpc<unknown>(this.admin, RPC.readWorkbookState, {
      p_workbook_key: this.workbookKey,
    });
    const row = firstRow<WorkbookStateRow>(data);
    if (row === null) {
      return { lastVerifiedAt: null, verifiedStages: [], schemaDrifted: false };
    }
    return {
      lastVerifiedAt: row.last_verified_at,
      verifiedStages: (row.verified_stages ?? []).filter((s): s is Stage =>
        (STAGES as readonly string[]).includes(s),
      ),
      schemaDrifted: row.schema_drifted === true,
    };
  }

  async writeVerificationState(state: VerificationState): Promise<void> {
    await callRpc(this.admin, RPC.writeWorkbookVerification, {
      p_workbook_key: this.workbookKey,
      p_last_verified_at: state.lastVerifiedAt,
      p_verified_stages: state.verifiedStages,
      p_schema_drifted: state.schemaDrifted,
    });
  }

  async markSchemaDrifted(args: {
    readonly claim: FenceClaim;
    readonly problems: readonly SchemaProblem[];
  }): Promise<void> {
    await callRpc(this.admin, RPC.markSchemaDrifted, {
      p_workbook_key: this.workbookKey,
      p_owner: args.claim.owner,
      p_fence: args.claim.fence,
      p_problems: args.problems,
    });
  }

  /**
   * Lift the drift latch, and report how many recorded problems went with it.
   *
   * FENCED, like `markSchemaDrifted`. The SQL refuses unless `verifiedStages`
   * names every operational stage, so this method cannot be used to unfence a
   * workbook nobody has read: the caller must have verified all of it in the
   * same request. A non-zero return means a latch really was standing.
   */
  async clearSchemaDrift(args: {
    readonly claim: FenceClaim;
    readonly actorId: string | null;
    readonly verifiedAt: string;
    readonly verifiedStages: readonly Stage[];
  }): Promise<number> {
    const data = await callRpc<unknown>(this.admin, RPC.clearSchemaDrift, {
      p_workbook_key: this.workbookKey,
      p_owner: args.claim.owner,
      p_fence: args.claim.fence,
      p_actor: args.actorId,
      p_verified_at: args.verifiedAt,
      p_verified_stages: args.verifiedStages,
    });
    return typeof data === 'number' ? data : 0;
  }

  /**
   * One read serves both `latestConfirmedRevision` and `confirmedRowNumber`,
   * cached per event so processing one event costs one query rather than two.
   * The cache is per worker invocation and is cleared when the sample changes.
   */
  private syncStateCache: { uuid: string; row: SampleSyncStateRow | null } | null = null;

  private async sampleSyncState(sampleUuid: string): Promise<SampleSyncStateRow | null> {
    if (this.syncStateCache !== null && this.syncStateCache.uuid === sampleUuid) {
      return this.syncStateCache.row;
    }
    const data = await callRpc<unknown>(this.admin, RPC.readSampleSyncState, {
      p_sample_uuid: sampleUuid,
    });
    const row = firstRow<SampleSyncStateRow>(data);
    this.syncStateCache = { uuid: sampleUuid, row };
    return row;
  }

  async latestConfirmedRevision(sampleUuid: string): Promise<number | null> {
    return (await this.sampleSyncState(sampleUuid))?.confirmed_revision ?? null;
  }

  async confirmedRowNumber(sampleUuid: string): Promise<number | null> {
    return (await this.sampleSyncState(sampleUuid))?.confirmed_row_number ?? null;
  }

  /**
   * Projection history, cached per sample for the same reason as the sync
   * state: `projectedRowsFor` and `confirmedRow` are two questions about one
   * result, and processing one event must not cost two queries.
   */
  private projectionCache: { uuid: string; rows: readonly SampleProjectionRow[] } | null = null;

  private async projections(sampleUuid: string): Promise<readonly SampleProjectionRow[]> {
    if (this.projectionCache !== null && this.projectionCache.uuid === sampleUuid) {
      return this.projectionCache.rows;
    }
    const data = await callRpc<unknown>(this.admin, RPC.readSampleProjectedRows, {
      p_sample_uuid: sampleUuid,
    });
    const rows = (Array.isArray(data) ? data : []) as readonly SampleProjectionRow[];
    this.projectionCache = { uuid: sampleUuid, rows };
    return rows;
  }

  async projectedRowsFor(sampleUuid: string): Promise<readonly (readonly string[])[]> {
    return (await this.projections(sampleUuid))
      .map((r) => r.projected_row)
      .filter((row): row is readonly string[] => Array.isArray(row));
  }

  async confirmedProjectedRow(sampleUuid: string): Promise<readonly string[] | null> {
    const found = (await this.projections(sampleUuid)).find((r) => r.was_confirmed === true);
    return found !== undefined && Array.isArray(found.projected_row) ? found.projected_row : null;
  }

  async recordOutcome(args: {
    readonly claim: FenceClaim;
    readonly event: OutboxEvent;
    readonly transition: OutboxTransition;
    readonly decision: ProjectionDecision | null;
  }): Promise<void> {
    await callRpc(this.admin, RPC.recordOutboxOutcome, {
      p_event_id: args.event.id,
      p_owner: args.claim.owner,
      p_fence: args.claim.fence,
      p_state: args.transition.state,
      p_attempts: args.transition.attempts,
      p_next_attempt_at: args.transition.nextAttemptAt,
      p_reconcile_first: args.transition.reconcileFirst,
      p_last_error: args.transition.lastError,
      p_confirmed_row_number: args.transition.confirmedRowNumber,
      p_confirmed_at: args.transition.confirmedAt,
      p_dead_lettered: args.transition.deadLettered,
      p_decision: args.decision,
    });
  }

  async confirmRowMapping(args: {
    readonly claim: FenceClaim;
    readonly sampleUuid: string;
    readonly stage: Stage;
    readonly rowNumber: number;
    readonly revision: number;
    readonly payloadHash: string;
    readonly confirmedAt: string;
  }): Promise<void> {
    await callRpc(this.admin, RPC.confirmRowMapping, {
      p_sample_uuid: args.sampleUuid,
      p_owner: args.claim.owner,
      p_fence: args.claim.fence,
      p_stage: args.stage,
      p_row_number: args.rowNumber,
      p_revision: args.revision,
      p_payload_hash: args.payloadHash,
      p_confirmed_at: args.confirmedAt,
    });
    // The cached sync state is now stale for this sample. A duplicate delivery
    // of the same event later in the batch must see the confirmed row, or it
    // would re-decide the projection from pre-write state.
    if (this.syncStateCache?.uuid === args.sampleUuid) this.syncStateCache = null;
    // Same for the projection history: this call is what makes one of those
    // events `was_confirmed`, and the hand-edit guard's message diffs against
    // that row. A stale cache here would make a second event in the same batch
    // report the wrong cells as hand-edited.
    if (this.projectionCache?.uuid === args.sampleUuid) this.projectionCache = null;
  }
}

// ---------------------------------------------------------------------------
// Idempotency registry
// ---------------------------------------------------------------------------

function asIdempotencyState(value: unknown): IdempotencyState {
  return value === 'succeeded' || value === 'failed' ? value : 'in_progress';
}

export class IdempotencyStore {
  constructor(private readonly admin: SupabaseClient) {}

  async read(key: string, operation: string): Promise<IdempotencyRecord | null> {
    const data = await callRpc<unknown>(this.admin, RPC.readIdempotencyRecord, {
      p_key: key,
      p_operation: operation,
    });
    const row = firstRow<IdempotencyRow>(data);
    if (row === null) return null;
    return {
      key: row.key,
      operation: row.operation,
      actorId: row.actor_id,
      payloadHash: row.payload_hash,
      state: asIdempotencyState(row.state),
      response: row.response,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /**
   * Claim the key.
   *
   * Returns the record that WON the race. Two concurrent requests with the
   * same key both call this; the RPC inserts on conflict-do-nothing and
   * returns the stored row, so the loser sees the winner's record and goes
   * down the `in_progress` or `replay` path instead of running the operation
   * twice. The decision itself stays in the pure `decideIdempotency`.
   */
  async begin(args: {
    readonly key: string;
    readonly operation: string;
    readonly actorId: string;
    readonly payloadHash: string;
    readonly staleAfterMs: number;
  }): Promise<{ readonly claimed: boolean; readonly record: IdempotencyRecord }> {
    const data = await callRpc<unknown>(this.admin, RPC.beginIdempotentRequest, {
      p_key: args.key,
      p_operation: args.operation,
      p_actor: args.actorId,
      p_payload_hash: args.payloadHash,
      p_stale_after_ms: args.staleAfterMs,
    });
    const row = firstRow<BeginIdempotentRow>(data);
    if (row === null) {
      throw new ApiError('internal', {
        internalDetail: `${RPC.beginIdempotentRequest} returned no row`,
      });
    }
    return {
      claimed: row.claimed === true,
      record: {
        key: row.key,
        operation: row.operation,
        actorId: row.actor_id,
        payloadHash: row.payload_hash,
        state: asIdempotencyState(row.state),
        response: row.response,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      },
    };
  }

  async complete(args: {
    readonly key: string;
    readonly operation: string;
    readonly actorId: string;
    readonly state: 'succeeded' | 'failed';
    readonly response: unknown;
  }): Promise<void> {
    await callRpc(this.admin, RPC.completeIdempotentRequest, {
      p_key: args.key,
      p_operation: args.operation,
      p_actor: args.actorId,
      p_state: args.state,
      p_response: args.response,
    });
  }
}
