/**
 * Server-side identity and authorisation. DENO-ONLY.
 *
 * Build rule 3: "Authorization is server-side. Hiding a UI button is not a
 * control." Build rule 4: "A new Google sign-in is 'pending' and sees NO data
 * until approved. Google login proves identity, it does not grant app
 * permission."
 *
 * Three separate steps, in this order, with no shortcut between them:
 *
 *   1. AUTHENTICATE. `auth.getUser(token)` is the ONLY source of the caller's
 *      identity. Nothing in the request body — no `email`, no `userId`, no
 *      `role` — is ever read as identity. The token is verified by Supabase
 *      against the project's JWKS, so a forged or expired one fails here.
 *
 *   2. LOAD AUTHORITY FROM THE DATABASE. Roles, account status and recorded
 *      delegations come from a privileged read keyed on the verified uid. A
 *      role claim inside a JWT would be a client-visible value and is not
 *      consulted.
 *
 *   3. CHECK THE PERMISSION, and log a denial. FR-002's acceptance criterion
 *      is "operator attempts to approve a limit or clear hold receive a denial
 *      and logged event", so the denial path writes an audit event before it
 *      returns. An unlogged denial is indistinguishable from an attack nobody
 *      noticed.
 */

import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.47.10';

import {
  can,
  ROLES,
  USER_STATUSES,
  type AuthorityContext,
  type Delegation,
  type Permission,
  type Role,
  type UserStatus,
} from '../../../../src/lib/roles.ts';
import { checkSeparationOfDuties } from '../../../../src/lib/roles.ts';
import { ApiError } from '../errors.ts';
import { RPC, type AuditFailureArgs, type AuthorityRow } from '../rpc.ts';
import {
  AUDIT_DEAD_LETTERED_EVENT,
  AUDIT_DEAD_LETTER_LOST_EVENT,
  AUDIT_WRITE_FAILED_EVENT,
  AUDIT_WRITE_THREW_EVENT,
  type AuditDelivery,
  type AuditFailureStage,
} from '../auditDelivery.ts';
import { readPlatformConfig } from './env.ts';

/** Service-role client. Bypasses RLS, so it is created per request, never exported. */
export function adminClient(): SupabaseClient {
  const config = readPlatformConfig();
  return createClient(config.supabaseUrl, config.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** Anon client carrying the caller's token. Reads are RLS-constrained. */
export function userClient(token: string): SupabaseClient {
  const config = readPlatformConfig();
  return createClient(config.supabaseUrl, config.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { authorization: `Bearer ${token}` } },
  });
}

export interface Actor {
  readonly userId: string;
  readonly email: string;
  readonly fullName: string | null;
  readonly authority: AuthorityContext;
}

function asRole(value: unknown): Role | null {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value)
    ? (value as Role)
    : null;
}

function asStatus(value: unknown): UserStatus {
  // An unrecognised status is treated as the most restrictive one. A typo in a
  // database row must not become an open door.
  return typeof value === 'string' && (USER_STATUSES as readonly string[]).includes(value)
    ? (value as UserStatus)
    : 'pending';
}

/**
 * Authenticate the caller and load their authority.
 *
 * Throws `unauthenticated` when the token is absent or rejected, and
 * `account_not_active` when identity is proven but the profile is not approved
 * — two distinct answers, because the second one is the pending-access screen
 * and the first is the sign-in screen.
 */
export async function authenticate(token: string | null): Promise<Actor> {
  if (token === null) {
    throw new ApiError('unauthenticated', { internalDetail: 'no bearer token presented' });
  }

  const admin = adminClient();
  const { data, error } = await admin.auth.getUser(token);
  if (error !== null || data.user === null) {
    throw new ApiError('unauthenticated', {
      internalDetail: error?.message ?? 'getUser returned no user',
    });
  }
  const user = data.user;

  const { data: rows, error: rpcError } = await admin.rpc(RPC.authorityContext, {
    p_user_id: user.id,
  });
  if (rpcError !== null) {
    throw new ApiError(rpcError.code === 'PGRST202' ? 'rpc_not_deployed' : 'internal', {
      internalDetail: `${RPC.authorityContext}: ${rpcError.message}`,
    });
  }

  const row = (Array.isArray(rows) ? rows[0] : rows) as AuthorityRow | null | undefined;
  if (row === null || row === undefined) {
    // Identity proven, no profile row yet: the first sign-in. Pending, and no
    // data at all until an administrator approves the account.
    throw new ApiError('account_not_active', {
      details: { status: 'pending' },
      internalDetail: `no profile row for ${user.id}`,
    });
  }

  const status = asStatus(row.status);
  const roles = (row.roles ?? [])
    .map(asRole)
    .filter((r): r is Role => r !== null);

  const delegations: Delegation[] = (row.delegations ?? [])
    .map((d) => {
      const permission = d.permission as Permission;
      return {
        permission,
        grantedBy: d.granted_by,
        effectiveFrom: d.effective_from,
        effectiveTo: d.effective_to,
      };
    });

  const authority: AuthorityContext = {
    userId: user.id,
    roles,
    status,
    delegations,
    now: new Date(),
  };

  if (status !== 'active') {
    throw new ApiError('account_not_active', { details: { status } });
  }

  return {
    userId: user.id,
    email: row.email ?? user.email ?? '',
    fullName: row.full_name,
    authority,
  };
}

export interface AuditArgs {
  readonly actorId: string | null;
  readonly action: string;
  readonly subjectType: string;
  readonly subjectId: string | null;
  readonly outcome: 'allowed' | 'denied' | 'error';
  readonly reason?: string | null;
  readonly before?: unknown;
  readonly after?: unknown;
  readonly appVersion: string;
}

/**
 * Dead-letter an audit event whose write failed.
 *
 * Must not call `recordAudit`, and must not reach the same RPC: it runs
 * because that RPC has already failed. It is the last durable step, so it
 * swallows nothing silently — a failure here returns `lost`, which the caller
 * logs under its own event name.
 */
async function deadLetterAudit(
  args: AuditArgs,
  stage: AuditFailureStage,
  detail: string,
): Promise<AuditDelivery> {
  try {
    const admin = adminClient();
    const { error } = await admin.rpc(RPC.recordAuditFailure, {
      p_actor: args.actorId,
      p_action: args.action,
      p_subject_type: args.subjectType,
      p_subject_id: args.subjectId,
      p_outcome: args.outcome,
      p_reason: args.reason ?? null,
      p_before: args.before ?? null,
      p_after: args.after ?? null,
      p_app_version: args.appVersion,
      p_failure_detail: detail,
      p_failure_stage: stage,
    } satisfies AuditFailureArgs);

    if (error !== null) {
      return { state: 'lost', detail: `${detail}; dead letter also failed: ${error.message}` };
    }
    return { state: 'dead_lettered', detail };
  } catch (error) {
    return {
      state: 'lost',
      detail: `${detail}; dead letter threw: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

/**
 * Write an audit event with the service-role client. Never throws upward.
 *
 * The availability argument for catching is unchanged (see
 * `_shared/auditDelivery.ts`): a failed audit write must not turn a correct
 * denial into a 500. What changed is that the failure now has somewhere to go.
 * A write that fails is dead-lettered to a durable row carrying the whole
 * event, and `/health`'s detail tier counts those rows beside the outbox
 * counts, so "the denial was logged" and "the denial was logged nowhere" are
 * finally different observable states.
 *
 * The return value says which happened. Callers on the hot path may ignore it
 * — the point of the catch is that they need not branch — but it is returned
 * rather than discarded so a caller that wants to say more in its own log can,
 * and so a test can assert the three outcomes.
 */
export async function recordAudit(args: AuditArgs): Promise<AuditDelivery> {
  let delivery: AuditDelivery;

  try {
    const admin = adminClient();
    const { error } = await admin.rpc(RPC.recordAuditEvent, {
      p_actor: args.actorId,
      p_action: args.action,
      p_subject_type: args.subjectType,
      p_subject_id: args.subjectId,
      p_outcome: args.outcome,
      p_reason: args.reason ?? null,
      p_before: args.before ?? null,
      p_after: args.after ?? null,
      p_app_version: args.appVersion,
    });

    if (error === null) return { state: 'delivered' };

    console.error(
      JSON.stringify({
        event: AUDIT_WRITE_FAILED_EVENT,
        action: args.action,
        subjectType: args.subjectType,
        subjectId: args.subjectId,
        outcome: args.outcome,
        detail: error.message,
      }),
    );
    delivery = await deadLetterAudit(args, 'rpc_error', error.message);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(
      JSON.stringify({
        event: AUDIT_WRITE_THREW_EVENT,
        action: args.action,
        subjectType: args.subjectType,
        subjectId: args.subjectId,
        outcome: args.outcome,
        detail,
      }),
    );
    delivery = await deadLetterAudit(args, 'threw', detail);
  }

  console.error(
    JSON.stringify({
      event:
        delivery.state === 'dead_lettered'
          ? AUDIT_DEAD_LETTERED_EVENT
          : AUDIT_DEAD_LETTER_LOST_EVENT,
      action: args.action,
      subjectType: args.subjectType,
      subjectId: args.subjectId,
      detail: delivery.state === 'delivered' ? null : delivery.detail,
    }),
  );

  return delivery;
}

/**
 * Require a permission, logging the denial.
 *
 * The permission matrix itself is `src/lib/roles.ts`, which is unit-tested and
 * mirrored by `role_permissions` in the migrations. This function is the
 * enforcement point; the matrix is the policy.
 */
export async function requirePermission(args: {
  readonly actor: Actor;
  readonly permission: Permission;
  readonly action: string;
  readonly subjectType: string;
  readonly subjectId: string | null;
  readonly appVersion: string;
}): Promise<void> {
  if (can(args.actor.authority, args.permission)) return;

  await recordAudit({
    actorId: args.actor.userId,
    action: args.action,
    subjectType: args.subjectType,
    subjectId: args.subjectId,
    outcome: 'denied',
    reason: `missing permission ${args.permission}`,
    after: { roles: args.actor.authority.roles, permission: args.permission },
    appVersion: args.appVersion,
  });

  throw new ApiError('forbidden', {
    details: { permission: args.permission },
    internalDetail: `${args.actor.userId} lacks ${args.permission}`,
  });
}

/** Require segregation of duties, logging the denial. */
export async function requireSeparation(args: {
  readonly actor: Actor;
  readonly action: 'approve_specification' | 'review_exception' | 'approve_access';
  readonly subjectActorId: string | null;
  readonly subjectId: string | null;
  readonly overrideApprovedBy?: string | null;
  readonly appVersion: string;
}): Promise<void> {
  const failure = checkSeparationOfDuties({
    action: args.action,
    actorId: args.actor.userId,
    subjectActorId: args.subjectActorId,
    overrideApprovedBy: args.overrideApprovedBy ?? null,
  });
  if (failure === null) return;

  await recordAudit({
    actorId: args.actor.userId,
    action: args.action,
    subjectType: 'separation_of_duties',
    subjectId: args.subjectId,
    outcome: 'denied',
    reason: failure,
    appVersion: args.appVersion,
  });

  throw new ApiError('separation_of_duties', { details: { failure } });
}
