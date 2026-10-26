/**
 * The database RPC contract these Edge Functions depend on.
 *
 * This file is the interface boundary between this slice (Edge Functions,
 * Sheets adapter, durable sync) and the migrations slice (`supabase/migrations`).
 * Every name, argument and return shape the functions call is declared here
 * once, so the SQL side has a single file to satisfy and a mismatch surfaces
 * as a typed `rpc_not_deployed` error rather than as a runtime surprise.
 *
 * Why RPCs and not table writes from the function? Two reasons, both from
 * Master Prompt §4/§5:
 *
 *  - Atomicity. Allocating the sample-ID sequence, inserting the sample,
 *    writing the audit event and enqueuing EXACTLY ONE outbox event have to
 *    happen in one transaction. A function issuing four REST calls cannot do
 *    that, and a crash between calls leaves a sample with no outbox event —
 *    an operational row that never appears in the sheet and that nothing
 *    retries.
 *
 *  - The serialized critical section. PRD §6.3 requires "an actual server-side
 *    serialized critical section" for sequence allocation. In Postgres that is
 *    a row lock or an advisory lock inside the function, not a read-then-write
 *    from the edge.
 *
 * Every RPC is `SECURITY DEFINER` and must therefore (a) take the actor from
 * its argument and re-derive authority from the database rather than trusting
 * it, and (b) have `EXECUTE` revoked from `PUBLIC` explicitly — a `SECURITY
 * DEFINER` function is granted to `PUBLIC` by default, and `ALTER DEFAULT
 * PRIVILEGES ... REVOKE` does not remove a grant that was never recorded as a
 * default. State the revoke per function.
 *
 * PURE: no Deno, no npm/jsr, no I/O. Names and types only.
 */

import type { Stage } from '../../../src/forms/types.ts';
import type { Disposition } from '../../../src/lib/workflow.ts';

/**
 * Every name below is DEFINED in `supabase/migrations/**`, and
 * `tests/rpcContract.test.ts` is what keeps that true: it fails on any name
 * declared here with no SQL function behind it, and on any argument this file
 * passes that the SQL function has no parameter for. Both halves matter — an
 * undefined function returns PostgREST PGRST202 and a mis-named argument
 * returns the same thing, so either one makes a mutating path dead in a way no
 * typecheck, build or unit test can see.
 *
 * Declare the full argument list for every RPC, never just the name. A named
 * RPC with no interface is what licenses the next caller to invent its
 * arguments: `rpc_retry_dead_lettered` was named here without one, and the
 * guess that followed passed a `p_sample_uuid` the function has never had.
 */
export const RPC = {
  registerSample: 'rpc_register_sample',
  updateResults: 'rpc_update_results',
  reviewSample: 'rpc_review_sample',
  setDisposition: 'rpc_set_disposition',
  approveSpecification: 'rpc_approve_specification',

  acquireSheetLease: 'rpc_acquire_sheet_lease',
  renewSheetLease: 'rpc_renew_sheet_lease',
  releaseSheetLease: 'rpc_release_sheet_lease',
  readSheetLease: 'rpc_read_sheet_lease',

  claimOutboxBatch: 'rpc_claim_outbox_batch',
  recordOutboxOutcome: 'rpc_record_outbox_outcome',
  confirmRowMapping: 'rpc_confirm_sheet_row',
  markSchemaDrifted: 'rpc_mark_schema_drifted',
  readWorkbookState: 'rpc_read_workbook_state',
  writeWorkbookVerification: 'rpc_write_workbook_verification',
  requeueOutboxEvent: 'rpc_requeue_outbox_event',
  retryDeadLettered: 'rpc_retry_dead_lettered',

  readSampleSyncState: 'rpc_read_sample_sync_state',
  readSampleProjectedRows: 'rpc_read_sample_projected_rows',
  readLedgerForStage: 'rpc_read_ledger_for_stage',
  writeReconciliationReport: 'rpc_write_reconciliation_report',

  authorityContext: 'rpc_authority_context',
  recordAuditEvent: 'rpc_record_audit_event',
  /**
   * Dead-letter for an audit event that could not be written. NOT a variant of
   * `rpc_record_audit_event`: it is called precisely when that one has already
   * failed, so it must reach a different table by a different statement, or it
   * fails for the same reason and records nothing.
   */
  recordAuditFailure: 'rpc_record_audit_failure',
  retryAuditDeadLetters: 'rpc_retry_audit_dead_letters',

  raiseHold: 'rpc_raise_hold',
  clearHold: 'rpc_clear_hold',
  proposeSpecification: 'rpc_propose_specification',
  submitSpecificationForReview: 'rpc_submit_specification_for_review',

  approveAccount: 'rpc_approve_account',
  setUserStatus: 'rpc_set_user_status',
  setUserRoles: 'rpc_set_user_roles',
  upsertControlledValue: 'rpc_upsert_controlled_value',
  grantDelegation: 'rpc_grant_delegation',
  revokeDelegation: 'rpc_revoke_delegation',
  recordAdminPasswordSet: 'rpc_record_admin_password_set',
  recordPasswordChanged: 'rpc_record_password_changed',
  readIdempotencyRecord: 'rpc_read_idempotency_record',
  beginIdempotentRequest: 'rpc_begin_idempotent_request',
  completeIdempotentRequest: 'rpc_complete_idempotent_request',
  healthSnapshot: 'rpc_health_snapshot',
} as const;

export type RpcName = (typeof RPC)[keyof typeof RPC];

/** Common envelope. `p_actor` is the uid the EDGE verified, never a body field. */
export interface RpcActorArgs {
  readonly p_actor: string;
  readonly p_idempotency_key: string;
  readonly p_payload_hash: string;
  /** Deployment version, recorded on the audit event (FR-016). */
  readonly p_app_version: string;
}

export interface RegisterSampleArgs extends RpcActorArgs {
  readonly p_stage: Stage;
  readonly p_prefix: string;
  /** Plant-local collection date, `YYYY-MM-DD`. The sequence key. */
  readonly p_collection_date: string;
  /** Plant-local collection time, `HH:mm`. */
  readonly p_collection_time: string;
  /** UTC instant of collection. */
  readonly p_collected_at: string;
  /** Validated, registry-keyed values. */
  readonly p_values: Record<string, unknown>;
  /** Serialised row with column A left blank; the RPC inserts the id. */
  readonly p_row: readonly string[];
  /** Upstream links recorded as declared, never inferred (PRD §6.4). */
  readonly p_links?: readonly { readonly kind: string; readonly reference: string }[];
  /** Free-text note kept in metadata, never in a legacy column. */
  readonly p_notes?: string | null;
}

export interface RegisterSampleResult {
  readonly sample_uuid: string;
  readonly sample_id: string;
  readonly revision: number;
  readonly capture_state: string;
  readonly outbox_event_id: string;
  readonly recorded_at: string;
}

export interface UpdateResultsArgs extends RpcActorArgs {
  readonly p_sample_uuid: string;
  readonly p_expected_revision: number;
  readonly p_values: Record<string, unknown>;
  readonly p_row: readonly string[];
  /** Mandatory when amending an already-reviewed value (FR-013). */
  readonly p_reason?: string | null;
  /** Attestation when the tester is not the signed-in user (PRD §6.1). */
  readonly p_tested_by_attestation?: string | null;
}

export interface MutationResult {
  readonly sample_uuid: string;
  readonly sample_id: string;
  readonly revision: number;
  readonly capture_state: string;
  readonly disposition: string;
  readonly outbox_event_id: string | null;
  readonly recorded_at: string;
  /** Hold triggers the transaction raised, for the response body. */
  readonly holds_raised?: readonly { readonly field_key: string; readonly detail: string }[];
  /**
   * The sample's CURRENT outbox state after this commit, so the response can
   * state the sync position honestly even when this particular change needed
   * no sheet write. Never inferred from the presence of an event id: an absent
   * event means "no new write queued", not "already confirmed".
   */
  readonly sheet_sync_state?: string | null;
  readonly sheet_confirmed_at?: string | null;
}

export interface ReviewSampleArgs extends RpcActorArgs {
  readonly p_sample_uuid: string;
  readonly p_expected_revision: number;
  readonly p_outcome: 'reviewed' | 'correction_required';
  readonly p_reason?: string | null;
  /**
   * The client's assessment claims, for comparison ONLY. The transaction
   * re-evaluates every measurement against the approved ruleset and raises
   * `BFF_ASSESSMENT_STALE` on disagreement, so a client cannot submit
   * `within_limit` for a measurement that has no approved rule.
   */
  readonly p_claimed_assessments: readonly {
    readonly field_key: string;
    readonly result: string;
  }[];
}

export interface SetDispositionArgs extends RpcActorArgs {
  readonly p_sample_uuid: string;
  readonly p_expected_revision: number;
  readonly p_decision: Disposition;
  readonly p_reason: string;
  /** True when the decision is recorded as an authorised override. */
  readonly p_records_override: boolean;
}

export interface ApproveSpecificationArgs extends RpcActorArgs {
  readonly p_specification_version_id: string;
  readonly p_decision: 'approve' | 'reject';
  readonly p_reason: string;
  /** A second approver's id when an override of self-approval was recorded. */
  readonly p_override_approved_by?: string | null;
}

export interface ApproveSpecificationResult {
  readonly specification_version_id: string;
  readonly parameter_key: string;
  readonly status: string;
  readonly version: number;
  readonly effective_from: string;
  readonly approved_by: string | null;
  readonly recorded_at: string;
}

export interface LeaseArgs {
  readonly p_workbook_key: string;
  readonly p_owner: string;
  readonly p_ttl_ms: number;
}

export interface LeaseRow {
  readonly workbook_key: string;
  readonly owner: string;
  readonly fence: number;
  readonly acquired_at: string;
  readonly expires_at: string;
}

export interface ClaimOutboxArgs {
  readonly p_workbook_key: string;
  readonly p_owner: string;
  readonly p_fence: number;
  readonly p_limit: number;
}

export interface OutboxRow {
  readonly id: string;
  readonly sample_uuid: string;
  readonly sample_id: string;
  readonly stage: Stage;
  readonly kind: string;
  readonly revision: number;
  readonly payload_hash: string;
  readonly row: readonly string[];
  readonly state: string;
  readonly attempts: number;
  readonly next_attempt_at: string | null;
  readonly reconcile_first: boolean;
  readonly last_error: string | null;
  readonly confirmed_row_number: number | null;
  readonly confirmed_at: string | null;
  readonly created_at: string;
}

export interface WorkbookStateRow {
  readonly workbook_key: string;
  readonly last_verified_at: string | null;
  readonly verified_stages: readonly Stage[];
  readonly schema_drifted: boolean;
  readonly schema_problems: unknown;
  readonly last_reconciled_at: string | null;
}

/** `rpc_read_sample_sync_state(p_sample_uuid)`. One row per sample, or none. */
export interface SampleSyncStateRow {
  readonly sample_uuid: string;
  readonly stage: Stage;
  /** Highest revision whose row was written AND read back. */
  readonly confirmed_revision: number | null;
  /** Row number of that verified write. */
  readonly confirmed_row_number: number | null;
  readonly confirmed_at: string | null;
  readonly confirmed_payload_hash: string | null;
}

/** `rpc_read_sample_projected_rows(p_sample_uuid)`. */
export interface ReadSampleProjectedRowsArgs {
  readonly p_sample_uuid: string;
}

/**
 * One row this system has projected for a sample, from an outbox event that
 * was CLAIMED at least once. Newest revision first.
 *
 * The writer compares the row currently in the sheet against this set: a row
 * matching none of them holds content this system did not write, which is a
 * hand edit and is refused rather than overwritten
 * (`ProjectionInput.priorProjections`).
 */
export interface SampleProjectionRow {
  readonly payload_revision: number;
  /** The event whose write was verified by a read-back. At most one is true. */
  readonly was_confirmed: boolean;
  readonly projected_row: readonly string[];
}

/** `rpc_read_ledger_for_stage(p_stage, p_limit, p_offset)`. */
export interface LedgerRow {
  readonly sample_uuid: string;
  readonly sample_id: string;
  readonly stage: Stage;
  readonly revision: number;
  readonly row: readonly string[];
  readonly confirmed_row_number: number | null;
  readonly sync_pending: boolean;
}

/** `rpc_authority_context(p_user_id)`. */
export interface AuthorityContextArgs {
  readonly p_user_id: string;
}

export interface AuthorityRow {
  readonly user_id: string;
  readonly email: string;
  readonly full_name: string | null;
  readonly status: string;
  readonly roles: readonly string[];
  readonly delegations: readonly {
    readonly permission: string;
    readonly granted_by: string;
    readonly effective_from: string;
    readonly effective_to: string | null;
  }[];
}

/**
 * `rpc_begin_idempotent_request(p_key, p_operation, p_actor, p_payload_hash,
 * p_stale_after_ms)`.
 *
 * Must be atomic: insert the row, or — only when the stored row has the SAME
 * actor and payload hash and is either `failed` or an `in_progress` older than
 * `p_stale_after_ms` — take it over. Returns the authoritative row either way,
 * with `claimed` true only if this caller now owns it. The edge function
 * re-runs `decideIdempotency` against the returned row when `claimed` is
 * false, so the policy stays in one tested place and this RPC supplies only
 * the atomicity that a read-then-write from the edge cannot.
 */
export interface BeginIdempotentRow {
  readonly claimed: boolean;
  readonly key: string;
  readonly operation: string;
  readonly actor_id: string;
  readonly payload_hash: string;
  readonly state: string;
  readonly response: unknown;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface IdempotencyRow {
  readonly key: string;
  readonly operation: string;
  readonly actor_id: string;
  readonly payload_hash: string;
  readonly state: string;
  readonly response: unknown;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface AuditEventArgs {
  readonly p_actor: string | null;
  readonly p_action: string;
  readonly p_subject_type: string;
  readonly p_subject_id: string | null;
  readonly p_outcome: 'allowed' | 'denied' | 'error';
  readonly p_reason?: string | null;
  readonly p_before?: unknown;
  readonly p_after?: unknown;
  readonly p_app_version: string;
}

/**
 * `rpc_record_audit_failure(...)` — the audit dead letter.
 *
 * Carries the WHOLE original event, not a counter, so the trail can be
 * replayed once the cause is fixed. A count alone would tell an administrator
 * that N events were lost and nothing about what they said.
 *
 * `p_failure_stage` distinguishes a returned error from a thrown one, which
 * are different faults: the first means the database answered and refused, the
 * second that it was never reached.
 *
 * Every field of `AuditEventArgs` is repeated by VALUE rather than by
 * extending it. These two RPCs are allowed to diverge — `rpc_record_audit_event`
 * is owned by the migrations slice and is being written now — and a shared
 * `extends` would silently propagate a change there into this table's
 * signature.
 */
export interface AuditFailureArgs {
  readonly p_actor: string | null;
  readonly p_action: string;
  readonly p_subject_type: string;
  readonly p_subject_id: string | null;
  readonly p_outcome: 'allowed' | 'denied' | 'error';
  readonly p_reason: string | null;
  readonly p_before: unknown;
  readonly p_after: unknown;
  readonly p_app_version: string;
  /** Why the audit write failed. Never an exception trace. */
  readonly p_failure_detail: string;
  readonly p_failure_stage: 'rpc_error' | 'threw';
}

/**
 * `rpc_raise_hold` / `rpc_clear_hold`.
 *
 * Hold raising and hold clearing are two RPCs, not one with a flag, because
 * they answer to two different permissions (`hold.raise` and `hold.clear`) and
 * a single entry point invites a caller to pass the state as data. A reason is
 * mandatory on both: PRD §6.2 requires every quality decision to carry one.
 */
export interface HoldArgs extends RpcActorArgs {
  readonly p_sample_uuid: string;
  readonly p_expected_revision: number;
  readonly p_reason: string;
  /** Field the hold is about, when it came from an adverse observation. */
  readonly p_field_key?: string | null;
}

export interface HoldResult {
  readonly sample_uuid: string;
  readonly sample_id: string | null;
  readonly revision: number;
  readonly capture_state: string;
  readonly disposition: string;
  readonly hold_active: boolean;
  readonly recorded_at: string;
}

/** `rpc_propose_specification`. Creates a DRAFT version; never approves it. */
export interface ProposeSpecificationArgs extends RpcActorArgs {
  readonly p_parameter_key: string;
  readonly p_stage: Stage;
  readonly p_material: string | null;
  readonly p_feed_type: string | null;
  readonly p_sampling_point: string | null;
  readonly p_test_method: string | null;
  readonly p_unit: string | null;
  /**
   * Numeric acceptance limits. Either bound may be null (a one-sided limit).
   * A proposal with BOTH null is a reference-only entry and can never assess.
   */
  readonly p_lower_bound: number | null;
  readonly p_upper_bound: number | null;
  readonly p_reason: string;
}

/** `rpc_submit_specification_for_review(p_specification_version_id, ...)`. */
export interface SubmitSpecificationArgs extends RpcActorArgs {
  readonly p_specification_version_id: string;
  readonly p_reason: string;
}

export interface SpecificationVersionResult {
  readonly specification_version_id: string;
  readonly parameter_key: string;
  readonly stage: Stage;
  readonly version: number;
  readonly status: string;
  readonly proposed_by: string | null;
  readonly recorded_at: string;
}

/**
 * Administration RPCs.
 *
 * `p_target_user` is the account being administered and is ALWAYS distinct
 * from `p_actor`, which the edge took from the verified token. No
 * administration RPC may read the acting identity from its own arguments.
 */
export interface ApproveAccountArgs extends RpcActorArgs {
  readonly p_target_user: string;
  readonly p_reason: string;
  /** Roles granted at approval. May be empty: approval is not a role grant. */
  readonly p_roles: readonly string[];
}

export interface SetUserStatusArgs extends RpcActorArgs {
  readonly p_target_user: string;
  readonly p_status: 'pending' | 'active' | 'suspended' | 'disabled';
  readonly p_reason: string;
}

/**
 * `rpc_set_user_roles` — the account's roles become EXACTLY this list.
 *
 * Declarative, not incremental, and that is deliberate: `src/hooks/useAdmin.ts`
 * sends the whole intended set (`set_roles`), and an add/remove pair would make
 * the result depend on the order two concurrent administrators happened to
 * arrive in. An EMPTY list is a valid instruction meaning "hold no roles".
 */
export interface RoleAssignmentArgs extends RpcActorArgs {
  readonly p_target_user: string;
  readonly p_roles: readonly string[];
  readonly p_reason: string;
}

/**
 * `rpc_upsert_controlled_value` — maintain a controlled vocabulary entry
 * (materials, feed types, suppliers, sampling points, mill screen sizes).
 *
 * `p_active` is nullable because absent means "leave it as it is". An entry is
 * RETIRED rather than deleted: records already referencing it must keep
 * resolving, so deactivation only removes it from future selection.
 */
export interface ControlledValueArgs extends RpcActorArgs {
  readonly p_list_key: string;
  readonly p_value: string;
  readonly p_label: string | null;
  readonly p_active: boolean | null;
  readonly p_reason: string;
}

export interface ControlledValueResult {
  readonly list_key: string;
  readonly value: string;
  readonly label: string | null;
  readonly active: boolean;
  readonly recorded_at: string;
}

/**
 * `rpc_grant_delegation`.
 *
 * This is the ONLY way `disposition.override_release` can ever be held, since
 * no role carries it as a base grant (`src/lib/roles.ts`
 * DELEGATION_ONLY_PERMISSIONS). `p_granted_by` is deliberately absent: the
 * grantor is `p_actor`, from the verified token, so a body cannot nominate
 * somebody else as the authority behind a delegation.
 */
export interface GrantDelegationArgs extends RpcActorArgs {
  readonly p_target_user: string;
  readonly p_permission: string;
  readonly p_effective_from: string;
  readonly p_effective_to: string | null;
  readonly p_reason: string;
}

export interface RevokeDelegationArgs extends RpcActorArgs {
  readonly p_delegation_id: string;
  readonly p_reason: string;
}

export interface AdminActionResult {
  readonly target_user: string;
  readonly status: string;
  readonly roles: readonly string[];
  readonly recorded_at: string;
}

/**
 * `rpc_record_admin_password_set` (0019) — record that an administrator set
 * another account a password it did not choose, which ARMS the forced change.
 *
 * NO PASSWORD ARGUMENT, and that is the design rather than an omission. The
 * credential is written to `auth.users` through the Supabase admin API by the
 * Edge Function; this records only THAT it happened and WHEN. A `p_password`
 * here would put a cleartext credential into the Postgres statement log, into
 * `pg_stat_statements` and within reach of every later `before`/`after` audit
 * payload, in exchange for nothing the quality record needs.
 *
 * THE IDEMPOTENCY KEY IS LOAD-BEARING ACROSS A BOUNDARY. `runMutation` claims
 * the key first, recording the operation as `admin_action.<action>`
 * (`adminSpec` in `_shared/handlers/admin.ts`). The function then reads that
 * stored operation back and refuses any key whose operation is not one of the
 * two password-setting endpoints. So BOTH sides must spell the action the same
 * way, and `tests/adminPasswordBoundary.test.ts` is what compares them —
 * `rpc_set_user_roles` is unreachable through its own endpoint today for
 * exactly this reason, and nothing noticed because nothing compared the two.
 */
export interface RecordAdminPasswordSetArgs extends RpcActorArgs {
  readonly p_target_user: string;
  /** Mandatory. The function refuses a blank one with BFF_REASON_REQUIRED. */
  readonly p_reason: string;
}

export interface RecordAdminPasswordSetResult {
  readonly target_user: string;
  /** The TARGET's account status — `pending` for a freshly created account. */
  readonly status: string;
  readonly recorded_at: string;
}

/**
 * `rpc_record_password_changed` (0019) — record that the holder set their own
 * password, which clears an outstanding administrator-set credential.
 *
 * DOES NOT EXTEND `RpcActorArgs`, deliberately. The SQL function takes exactly
 * `(p_actor, p_app_version)`: it never calls `claim_mutation`, so it has no
 * `p_idempotency_key` and no `p_payload_hash` parameter. Inheriting the
 * envelope would declare two arguments the function has no parameter for, and
 * PostgREST sends named arguments — so every call would come back as PGRST202,
 * the same symptom as the function not existing at all. `RetryDeadLetteredArgs`
 * below is standalone for the same reason.
 *
 * There is NO target parameter. The account whose password changed is the
 * actor, so no argument exists that could aim this at somebody else.
 *
 * Returns the recorded instant as a bare `timestamptz`, not a row.
 */
export interface RecordPasswordChangedArgs {
  readonly p_actor: string;
  readonly p_app_version: string;
}

export interface DelegationResult {
  readonly delegation_id: string;
  readonly target_user: string;
  readonly permission: string;
  readonly effective_from: string;
  readonly effective_to: string | null;
  readonly recorded_at: string;
}

/**
 * `rpc_retry_audit_dead_letters(p_limit)` — replay held audit events.
 *
 * The other half of the audit dead letter. A durable row that records a lost
 * audit event makes the loss visible; this is how the trail is actually
 * repaired once the cause is fixed. Without it the dead letter would be a
 * graveyard, and "the denial was logged" would stay false for ever.
 */
export interface RetryAuditDeadLettersArgs {
  readonly p_limit: number;
}

export interface RetryAuditDeadLettersResult {
  readonly attempted: number;
  readonly written: number;
  /** Still held after this pass: either the limit capped it, or it failed again. */
  readonly still_held: number;
}

/**
 * `rpc_requeue_outbox_event(p_sample_uuid, p_owner, p_fence, p_reason)`.
 *
 * FENCED and worker-facing: it takes a lease owner and fence, so only a caller
 * holding the workbook lease may use it, and it is keyed by SAMPLE rather than
 * by outbox event. `reconcile-sheets` is its caller. An administrator's retry
 * button is NOT, because a screen cannot hold a lease — one taken by a button
 * would block the worker for its whole TTL.
 */
export interface RequeueOutboxArgs {
  readonly p_sample_uuid: string;
  readonly p_owner: string;
  readonly p_fence: number;
  readonly p_reason: string;
}

/**
 * `rpc_retry_dead_lettered(p_actor, p_app_version, p_sample_uuid default null)`
 * returns the integer count retried.
 *
 * The ADMINISTRATOR-facing retry: it re-derives `sync.retry` from the actor in
 * SQL and needs no lease. With a sample it retries that sample's dead-lettered
 * events; with null, every one.
 *
 * An earlier version of this interface declared `p_reason` and `p_limit`,
 * neither of which the function has — invented because the RPC was named here
 * without being typed. That is the whole reason every RPC above carries its
 * argument list: a name alone licenses the next caller to guess, and the guess
 * fails as PGRST202 at run time, where no typecheck or unit test can see it.
 */
export interface RetryDeadLetteredArgs {
  readonly p_actor: string;
  readonly p_app_version: string;
  /** Null retries EVERY dead-lettered event, not none. */
  readonly p_sample_uuid: string | null;
}

export interface HealthSnapshotRow {
  readonly outbox_pending: number;
  readonly outbox_retrying: number;
  readonly outbox_needs_attention: number;
  readonly outbox_confirmed_24h: number;
  readonly oldest_pending_at: string | null;
  readonly last_confirmed_at: string | null;
  readonly last_reconciled_at: string | null;
  readonly schema_drifted: boolean;
  readonly lease_owner: string | null;
  readonly lease_expires_at: string | null;
  readonly lease_fence: number | null;
  /**
   * Audit events held in the dead letter because their write failed.
   *
   * OPTIONAL, and that is deliberate rather than lax. A deployment whose
   * `rpc_health_snapshot` predates this field must be reported as "the count
   * is not available", never as zero — see `_shared/auditDelivery.ts`. Typing
   * it as `number` would make the absent case unrepresentable and the first
   * thing any reader would write is `?? 0`, which is the false clean.
   */
  readonly audit_dead_letters?: number | string | null;
  readonly audit_dead_letter_oldest_at?: string | null;
}

/**
 * PostgREST codes we must distinguish from a generic failure.
 * `PGRST202` is "function not found in schema cache", i.e. the migrations are
 * not applied — a configuration fault, not a bad request.
 */
export const PGRST_FUNCTION_NOT_FOUND = 'PGRST202';
/** Unique violation: the idempotency key was taken between read and insert. */
export const PG_UNIQUE_VIOLATION = '23505';
/** Raised by the RPCs for a stale `expectedRevision`. */
export const PG_REVISION_CONFLICT = 'P0001';
