/**
 * The action vocabularies of the four action-router endpoints, and the
 * permission each action answers to.
 *
 * WHERE THESE NAMES COME FROM. They are not chosen here. `src/hooks` already
 * calls five Edge Functions, and each call site multiplexes several actions
 * onto one function name: `useSampleDetail` sends `SampleActionKind`
 * (review | request_correction | raise_hold | clear_hold | disposition) to one
 * endpoint, `useSpecifications` sends propose | submit_review | approve |
 * reject to another, `useAdmin` sends seven administrative actions to a third,
 * `{ action: 'retry' }` to a fourth and `{ action: 'verify_headers' }` to a
 * fifth. None of the five functions existed, so all of it failed as an opaque
 * transport error.
 *
 * The vocabulary therefore had to be READ OFF THE CALLERS rather than
 * invented: a router that accepted a tidier set of names would have replaced
 * one broken call with a different broken call — a 400 instead of a 404 — and
 * the hooks that send these strings belong to another slice. Two of the five
 * named capabilities already had real endpoints (`set-disposition`,
 * `approve-specification`); those actions are served by the SAME specs those
 * endpoints run, imported from `_shared/handlers/`, so there is exactly one
 * implementation of each quality decision and no second copy to diverge.
 *
 * THE TABLES ARE TOTAL. Each is `Record<Action, Permission>` over a closed
 * union, so a new action cannot compile until somebody names the permission it
 * needs. There is no default branch and no action maps to "no permission
 * required" — the failure this forestalls is the usual one for permission
 * tables, where the member nobody classified reaches a permissive default. An
 * unrecognised action string is refused as `bad_request` by `parseAction`
 * BEFORE any authority question is asked, so an unknown action can never be
 * the one that skips the check.
 *
 * WHAT IS DELIBERATELY ABSENT. No table grants an administrator any quality
 * authority. `administrator` holds `sample.view`, `user.manage`,
 * `user.approve_access`, `sync.view`, `sync.retry`, `audit.view` and
 * `report.view` (src/lib/roles.ts), so it is refused `raise_hold`,
 * `clear_hold`, every disposition, `spec.propose` and `spec.approve` by the
 * same matrix that governs the existing endpoints. Nothing here can change
 * that, because the mapping is data rather than code.
 *
 * PURE: no Deno, no npm/jsr, no I/O.
 */

import type { Permission } from '../../../src/lib/roles.ts';

// ---------------------------------------------------------------------------
// sample-action
// ---------------------------------------------------------------------------

/**
 * `SampleActionKind` in `src/hooks/useSampleDetail.ts`, exactly.
 *
 * `review` and `request_correction` are two actions here and ONE outcome
 * parameter on the review RPC, so the router derives the outcome from the
 * action rather than reading it from the body: the call site sends no
 * `outcome` field, and a router that required one would reject every review.
 */
export const SAMPLE_ACTIONS = [
  'review',
  'request_correction',
  'raise_hold',
  'clear_hold',
  'disposition',
] as const;
export type SampleAction = (typeof SAMPLE_ACTIONS)[number];

/**
 * `disposition` maps to `sample.view` HERE and is then re-checked against the
 * decision-specific permission inside the disposition spec itself — exactly as
 * the `set-disposition` endpoint does, because which permission a disposition
 * needs is not knowable until the decision is parsed. It is the one action
 * whose real authority test is not in this table, and the spec's own
 * `requirePermission` call is that test.
 *
 * Raising and clearing a hold are separate permissions and that is the whole
 * control: a quality officer holds `hold.raise` and NOT `hold.clear`, so they
 * can stop material and cannot restart it.
 */
export const SAMPLE_ACTION_PERMISSION: Readonly<Record<SampleAction, Permission>> = {
  review: 'sample.review',
  request_correction: 'sample.review',
  raise_hold: 'hold.raise',
  clear_hold: 'hold.clear',
  disposition: 'sample.view',
};

// ---------------------------------------------------------------------------
// specification-action
// ---------------------------------------------------------------------------

/** `'propose' | SpecificationDecision` in `src/hooks/useSpecifications.ts`. */
export const SPECIFICATION_ACTIONS = [
  'propose',
  'submit_review',
  'approve',
  'reject',
] as const;
export type SpecificationAction = (typeof SPECIFICATION_ACTIONS)[number];

/**
 * `approve` and `reject` need `spec.approve`; proposing needs `spec.propose`.
 * A quality officer holds only the second, so the officer who proposes a limit
 * cannot put it in force — and `approve-specification`'s segregation-of-duties
 * check additionally stops a supervisor approving their own proposal.
 */
export const SPECIFICATION_ACTION_PERMISSION: Readonly<
  Record<SpecificationAction, Permission>
> = {
  propose: 'spec.propose',
  submit_review: 'spec.propose',
  approve: 'spec.approve',
  reject: 'spec.approve',
};

// ---------------------------------------------------------------------------
// admin-action
// ---------------------------------------------------------------------------

/** `AdminActionKind` in `src/hooks/useAdmin.ts`, exactly. */
export const ADMIN_ACTIONS = [
  'approve_access',
  'deny_access',
  'set_status',
  'set_roles',
  'create_delegation',
  'revoke_delegation',
  'upsert_controlled_value',
] as const;
export type AdminAction = (typeof ADMIN_ACTIONS)[number];

/**
 * Access decisions answer to `user.approve_access`; everything else to
 * `user.manage`. FR-001 makes account approval the gate that turns a proven
 * identity into an account that can see anything at all, so it is the one
 * administrative act with its own permission.
 *
 * `deny_access` is here deliberately: refusing an account is as much a
 * decision as approving one and is audited the same way.
 *
 * Note what `user.manage` does NOT buy: `create_delegation` is bounded by
 * `delegationGrantRefusal` below, so it cannot be used to mint quality
 * authority.
 */
/**
 * The operation name each admin action's RPC hands `claim_mutation`.
 *
 * THIS IS A CONTRACT WITH THE SQL, NOT A LABEL. `runMutation` claims the
 * idempotency key before calling the RPC; the RPC claims the same key again
 * from inside Postgres; `claim_mutation` raises
 * `BFF_IDEMPOTENCY_CONFLICT: operation_mismatch` if the two names differ. Every
 * admin action used to send `admin_action.<action>` while its RPC claimed a
 * bare literal, so EVERY administrator action was refused before it did any
 * work — proved by execution, with the control that the identical call with
 * matching names is accepted.
 *
 * Note that the two sides do not even share a vocabulary: `approve_access` is
 * served by `rpc_approve_account`, and both `deny_access` and `set_status` are
 * served by `rpc_set_user_status`. That is why the audit record keeps the
 * specific `admin_action.<action>` name — an audit trail that cannot tell a
 * denial from a status change is worse than one that can — and only the
 * registry uses the name below.
 *
 * `tests/idempotencyOperationContract.test.ts` checks every entry here against
 * the literal actually present in the migrations. Add an action without adding
 * it here and that test fails rather than the plant finding out.
 */
export const ADMIN_ACTION_CLAIM_OPERATION: Readonly<Record<AdminAction, string>> = {
  approve_access: 'approve_account',
  deny_access: 'set_user_status',
  set_status: 'set_user_status',
  set_roles: 'set_user_roles',
  create_delegation: 'grant_delegation',
  revoke_delegation: 'revoke_delegation',
  upsert_controlled_value: 'upsert_controlled_value',
};

export const ADMIN_ACTION_PERMISSION: Readonly<Record<AdminAction, Permission>> = {
  approve_access: 'user.approve_access',
  deny_access: 'user.approve_access',
  set_status: 'user.manage',
  set_roles: 'user.manage',
  create_delegation: 'user.manage',
  revoke_delegation: 'user.manage',
  upsert_controlled_value: 'user.manage',
};

// ---------------------------------------------------------------------------
// sync-action
// ---------------------------------------------------------------------------

/**
 * `useSyncRetry` sends `{ action: 'retry', jobId }`. `retry_dead_lettered` is
 * the bulk form, which no current call site uses but the recovery runbook
 * does.
 */
export const SYNC_ACTIONS = [
  'retry',
  'retry_dead_lettered',
  'retry_audit_dead_letters',
] as const;
export type SyncAction = (typeof SYNC_ACTIONS)[number];

/**
 * `sync.retry`, not `sync.view`. Both WRITE: they move an outbox row back into
 * the queue. A read permission must never authorise a write, and `sync.view`
 * is held by the quality officer, who has no operational mandate over the
 * workbook queue.
 */
export const SYNC_ACTION_PERMISSION: Readonly<Record<SyncAction, Permission>> = {
  retry: 'sync.retry',
  retry_dead_lettered: 'sync.retry',
  /**
   * Replaying held AUDIT events, not sheet jobs — and `sync.retry` is named
   * here with a caveat rather than silently.
   *
   * The permission matrix has no audit-recovery permission: `audit.view` is a
   * read, and nothing in it grants writing to the trail. `sync.retry` is the
   * only write-shaped operational permission an administrator holds, and the
   * action has the same shape as the outbox retry — drain a durable recovery
   * queue, change no quality fact. Replaying a held audit event cannot alter a
   * decision; it only writes down a decision that was already made. If the
   * matrix later gains an audit-recovery permission this row should move to
   * it, which is why the reasoning is recorded here and not inferred.
   */
  retry_audit_dead_letters: 'sync.retry',
};

// ---------------------------------------------------------------------------
// schema-verify
// ---------------------------------------------------------------------------

/** `useSchemaVerification` sends `{ action: 'verify_headers' }`. */
export const SCHEMA_VERIFY_ACTIONS = ['verify_headers'] as const;
export type SchemaVerifyAction = (typeof SCHEMA_VERIFY_ACTIONS)[number];

/**
 * `sync.view` is enough to ASK for a header check, because the panel that runs
 * it is read-only from the operator's point of view — but recording the result
 * is not, and the endpoint separates the two: a mismatch latches the workbook
 * as drifted, which stops every sheet write in the deployment, and THAT step
 * additionally requires `sync.retry`. Granting the whole action to
 * `sync.retry` would stop a quality officer seeing whether the columns match;
 * granting the latch to `sync.view` would let one halt synchronisation.
 */
export const SCHEMA_VERIFY_ACTION_PERMISSION: Readonly<
  Record<SchemaVerifyAction, Permission>
> = {
  verify_headers: 'sync.view',
};

/** Permission required to record drift, as distinct from observing it. */
export const SCHEMA_DRIFT_LATCH_PERMISSION: Permission = 'sync.retry';

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Narrow an untrusted action string against a closed list.
 *
 * Returns `null` for anything else, including a near-miss and a value that is
 * a valid action of a DIFFERENT router. The caller turns `null` into
 * `bad_request` before authorising, so an unrecognised action is refused by
 * the vocabulary rather than reaching a permission lookup with no entry for it.
 */
export function parseAction<T extends string>(
  value: unknown,
  allowed: readonly T[],
): T | null {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : null;
}

/**
 * Permissions that may never be delegated through the HTTP API.
 *
 * `disposition.override_release` is held by NO role as a base grant — it is
 * delegation-only by design (`DELEGATION_ONLY_PERMISSIONS` in
 * src/lib/roles.ts), which is what makes an override release traceable to a
 * named, recorded decision rather than to a role.
 *
 * Who may CREATE that delegation is not stated anywhere in the permission
 * matrix, and the honest answer to an unspecified authority question is to
 * refuse. The alternative — letting `user.manage` do it — would mean an
 * administrator, who holds no quality authority at all, could mint release
 * authority and hand it to somebody: the "an Administrator is not
 * automatically a quality-release approver" rule read backwards. So the API
 * refuses with an explanation, and the first such delegation has to be
 * recorded by the database custodian.
 */
export const UNDELEGATABLE_PERMISSIONS: readonly Permission[] = [
  'disposition.override_release',
];

/**
 * The grant rule for every other permission: the grantor must already hold
 * what they are handing over, and may not hand it to themselves.
 *
 * An actor cannot delegate authority they do not have, so `user.manage` alone
 * never widens the quality surface.
 *
 * Returned as a reason string rather than a boolean so the endpoint can put
 * the actual ground of refusal into the audit event.
 */
export function delegationGrantRefusal(args: {
  readonly permission: Permission;
  readonly grantorHoldsPermission: boolean;
  readonly grantorId: string;
  readonly targetUserId: string;
}): string | null {
  if (UNDELEGATABLE_PERMISSIONS.includes(args.permission)) {
    return 'permission_not_delegatable_through_api';
  }
  if (args.grantorId === args.targetUserId) {
    return 'self_delegation';
  }
  if (!args.grantorHoldsPermission) {
    return 'grantor_does_not_hold_permission';
  }
  return null;
}
