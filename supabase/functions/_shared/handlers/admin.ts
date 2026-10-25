/**
 * Accounts, roles, delegations and the controlled vocabularies.
 *
 * FR-001: "a new Google sign-in is pending and sees NO data until approved."
 * Approving that account is the most consequential administrative act in the
 * system, and `src/hooks/useAdmin.ts` posted seven such actions to a function
 * that did not exist — so no account could be approved, no role assigned, no
 * delegation recorded, and no controlled list maintained.
 *
 * WHAT AN ADMINISTRATOR CANNOT DO HERE, structurally rather than by a check:
 *
 *  - No action in this module touches a sample, a measurement, a disposition,
 *    a hold or a specification. The vocabulary (`_shared/actions.ts`) contains
 *    none, so there is no code path to get wrong.
 *  - `create_delegation` cannot manufacture quality authority. The grantor
 *    must already hold the permission being handed over, so `user.manage` —
 *    which an administrator has, and which carries no quality power — can
 *    never widen the quality surface. `disposition.override_release` is
 *    refused outright: no role holds it, nothing in the matrix says who may
 *    create that delegation, and the honest answer to an unspecified authority
 *    question is to refuse rather than let the administrator decide.
 *  - Nobody approves their own access, and nobody delegates to themselves.
 *
 * IDENTITY. The acting user is `actor.userId`, from the JWT `runMutation`
 * verified. `userId` in the body is only ever a SUBJECT: no argument here can
 * nominate who is acting, what role they hold, or that somebody else approved
 * the action.
 *
 * DENO-ONLY: reached through `adapters/mutation.ts`.
 */

import { ApiError } from '../errors.ts';
import { callTransaction, readString, type MutationSpec } from '../adapters/mutation.ts';
import {
  RPC,
  type AdminActionResult,
  type ApproveAccountArgs,
  type ControlledValueArgs,
  type ControlledValueResult,
  type DelegationResult,
  type GrantDelegationArgs,
  type RevokeDelegationArgs,
  type RoleAssignmentArgs,
  type SetUserStatusArgs,
} from '../rpc.ts';
import { recordAudit, requireSeparation } from '../adapters/authorize.ts';
import {
  ADMIN_ACTION_PERMISSION,
  delegationGrantRefusal,
  type AdminAction,
} from '../actions.ts';
import {
  can,
  PERMISSIONS,
  ROLES,
  USER_STATUSES,
  type Permission,
  type Role,
  type UserStatus,
} from '../../../../src/lib/roles.ts';

function parseRole(value: unknown): Role | null {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value)
    ? (value as Role)
    : null;
}

function parseStatus(value: unknown): UserStatus | null {
  return typeof value === 'string' && (USER_STATUSES as readonly string[]).includes(value)
    ? (value as UserStatus)
    : null;
}

function parsePermission(value: unknown): Permission | null {
  return typeof value === 'string' && (PERMISSIONS as readonly string[]).includes(value)
    ? (value as Permission)
    : null;
}

/**
 * The roles the caller wants the account to hold.
 *
 * An absent list means "do not change the roles"; an EMPTY list means "hold
 * none". Those are different instructions and are kept different: collapsing
 * them would make `set_roles` with an empty array a silent no-op, so an
 * administrator who meant to strip every role would be told it worked.
 */
function readRoles(body: Record<string, unknown>): readonly Role[] | null {
  const raw = body['roles'];
  if (raw === undefined || raw === null) return null;
  if (!Array.isArray(raw)) {
    throw new ApiError('bad_request', { message: '"roles" must be a list of role names.' });
  }
  const roles: Role[] = [];
  for (const entry of raw) {
    const role = parseRole(entry);
    if (role === null) {
      throw new ApiError('validation_failed', {
        details: {
          issues: [{ field: 'roles', code: 'unknown_role', message: 'That role does not exist.' }],
        },
      });
    }
    roles.push(role);
  }
  return roles;
}

/**
 * An ISO instant from the body, or the fallback.
 *
 * An unparseable date is refused rather than stored. `delegationActive`
 * compares dates, and an invalid one makes every comparison false — which
 * silently disables the delegation instead of reporting the bad input, so the
 * administrator would see a delegation listed and the holder would have no
 * authority.
 */
function readInstant(
  body: Record<string, unknown>,
  key: string,
  fallback: string | null,
): string | null {
  const raw = readString(body, key, { maxLength: 40 });
  if (raw === null) return fallback;
  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) {
    throw new ApiError('validation_failed', {
      details: {
        issues: [{ field: key, code: 'not_a_date', message: `${key} must be a date and time.` }],
      },
    });
  }
  return new Date(parsed).toISOString();
}

function requireReason(body: Record<string, unknown>): string {
  const reason = readString(body, 'reason', { maxLength: 2000 });
  if (reason === null || reason.trim() === '') {
    throw new ApiError('validation_failed', {
      details: {
        issues: [
          {
            field: 'reason',
            code: 'required',
            message: 'Say why this change is being made. It is recorded against your name.',
          },
        ],
      },
    });
  }
  return reason;
}

export function adminSpec(action: AdminAction): MutationSpec<Record<string, unknown>> {
  return {
    operation: `admin_action.${action}`,
    /**
     * The permission for THIS action, from the total table. `runMutation`
     * checks it before any work and audits the denial, so there is no
     * action-independent gate that a new action could slip through.
     */
    permission: ADMIN_ACTION_PERMISSION[action],
    subjectType: action === 'upsert_controlled_value' ? 'controlled_value' : 'user',
    subjectId: (body) => {
      if (action === 'upsert_controlled_value') {
        return typeof body['listKey'] === 'string' ? body['listKey'] : null;
      }
      if (action === 'revoke_delegation') {
        return typeof body['delegationId'] === 'string' ? body['delegationId'] : null;
      }
      return typeof body['userId'] === 'string' ? body['userId'] : null;
    },
    run: async ({
      actor,
      admin,
      body,
      idempotencyKey,
      payloadHash,
      appVersion,
      markCommitted,
    }) => {
      const reason = requireReason(body);
      const envelope = {
        p_actor: actor.userId,
        p_idempotency_key: idempotencyKey,
        p_payload_hash: payloadHash,
        p_app_version: appVersion,
      } as const;

      // ---- controlled vocabularies -------------------------------------

      if (action === 'upsert_controlled_value') {
        const listKey = readString(body, 'listKey', { required: true, maxLength: 100 })!;
        const value = readString(body, 'value', { required: true, maxLength: 200 })!;
        const args: ControlledValueArgs = {
          ...envelope,
          p_list_key: listKey,
          p_value: value,
          p_label: readString(body, 'label', { maxLength: 300 }),
          // Absent means "leave it as it is"; the RPC decides, not a default
          // invented here that could silently reactivate a retired entry.
          p_active: typeof body['active'] === 'boolean' ? body['active'] : null,
          p_reason: reason,
        };
        const result = await callTransaction<ControlledValueResult>(
          admin,
          RPC.upsertControlledValue,
          args,
        );

        /** COMMIT POINT — see `_shared/commitOutcome.ts`. */
        markCommitted({
          ok: true,
          action,
          listKey: result.list_key,
          value: result.value,
          active: result.active,
          recordedAt: result.recorded_at,
        });

        await recordAudit({
          actorId: actor.userId,
          action: `admin_action.${action}`,
          subjectType: 'controlled_value',
          subjectId: `${result.list_key}:${result.value}`,
          outcome: 'allowed',
          reason,
          after: { list_key: result.list_key, value: result.value, active: result.active },
          appVersion,
        });

        return {
          ok: true,
          action,
          listKey: result.list_key,
          value: result.value,
          label: result.label,
          active: result.active,
          recordedAt: result.recorded_at,
          message: result.active
            ? 'The list entry is available for selection.'
            : 'The list entry has been retired. Records that already use it are unchanged.',
        };
      }

      // ---- delegations --------------------------------------------------

      if (action === 'revoke_delegation') {
        const delegationId = readString(body, 'delegationId', { required: true })!;
        const args: RevokeDelegationArgs = {
          ...envelope,
          p_delegation_id: delegationId,
          p_reason: reason,
        };
        const result = await callTransaction<DelegationResult>(admin, RPC.revokeDelegation, args);

        /** COMMIT POINT — see `_shared/commitOutcome.ts`. */
        markCommitted({
          ok: true,
          action,
          delegationId: result.delegation_id,
          userId: result.target_user,
          permission: result.permission,
          recordedAt: result.recorded_at,
        });

        await recordAudit({
          actorId: actor.userId,
          action: `admin_action.${action}`,
          subjectType: 'delegation',
          subjectId: delegationId,
          outcome: 'allowed',
          reason,
          after: { permission: result.permission, target_user: result.target_user },
          appVersion,
        });

        return {
          ok: true,
          action,
          delegationId: result.delegation_id,
          userId: result.target_user,
          permission: result.permission,
          effectiveTo: result.effective_to,
          recordedAt: result.recorded_at,
          message: 'The delegation has been withdrawn.',
        };
      }

      if (action === 'create_delegation') {
        const userId = readString(body, 'userId', { required: true })!;
        const permission = parsePermission(body['permission']);
        if (permission === null) {
          throw new ApiError('bad_request', {
            message: 'A known permission must be named for a delegation.',
            details: { field: 'permission' },
          });
        }

        const refusal = delegationGrantRefusal({
          permission,
          // From the ACTOR'S OWN authority, loaded from the database against
          // the verified uid — never from the request.
          grantorHoldsPermission: can(actor.authority, permission),
          grantorId: actor.userId,
          targetUserId: userId,
        });
        if (refusal !== null) {
          await recordAudit({
            actorId: actor.userId,
            action: `admin_action.${action}`,
            subjectType: 'delegation',
            subjectId: userId,
            outcome: 'denied',
            reason: refusal,
            after: { permission, target_user: userId },
            appVersion,
          });
          throw new ApiError('forbidden', {
            message:
              refusal === 'permission_not_delegatable_through_api'
                ? 'This authority cannot be delegated through the application. It must be recorded directly by the database custodian, so that granting it is itself a controlled change.'
                : refusal === 'self_delegation'
                  ? 'You cannot delegate an authority to yourself.'
                  : 'You cannot delegate an authority you do not hold yourself.',
            details: { denial: refusal, permission },
            internalDetail: `${actor.userId} create_delegation ${permission} refused: ${refusal}`,
          });
        }

        const effectiveFrom = readInstant(body, 'effectiveFrom', new Date().toISOString())!;
        const effectiveTo = readInstant(body, 'effectiveTo', null);
        if (effectiveTo !== null && Date.parse(effectiveTo) <= Date.parse(effectiveFrom)) {
          throw new ApiError('validation_failed', {
            details: {
              issues: [
                {
                  field: 'effectiveTo',
                  code: 'window_inverted',
                  message: 'The end of the delegation must be after its start.',
                },
              ],
            },
          });
        }

        const args: GrantDelegationArgs = {
          ...envelope,
          p_target_user: userId,
          p_permission: permission,
          p_effective_from: effectiveFrom,
          p_effective_to: effectiveTo,
          p_reason: reason,
        };
        const result = await callTransaction<DelegationResult>(admin, RPC.grantDelegation, args);

        /** COMMIT POINT — see `_shared/commitOutcome.ts`. */
        markCommitted({
          ok: true,
          action,
          delegationId: result.delegation_id,
          userId: result.target_user,
          permission: result.permission,
          effectiveFrom: result.effective_from,
          effectiveTo: result.effective_to,
          recordedAt: result.recorded_at,
        });

        await recordAudit({
          actorId: actor.userId,
          action: `admin_action.${action}`,
          subjectType: 'delegation',
          subjectId: result.delegation_id,
          outcome: 'allowed',
          reason,
          after: {
            permission: result.permission,
            target_user: result.target_user,
            effective_from: result.effective_from,
            effective_to: result.effective_to,
          },
          appVersion,
        });

        return {
          ok: true,
          action,
          delegationId: result.delegation_id,
          userId: result.target_user,
          permission: result.permission,
          effectiveFrom: result.effective_from,
          effectiveTo: result.effective_to,
          recordedAt: result.recorded_at,
          message: 'The delegation has been recorded.',
        };
      }

      // ---- accounts and roles -------------------------------------------

      const userId = readString(body, 'userId', { required: true })!;

      if (action === 'approve_access' || action === 'deny_access') {
        // Nobody decides their own access. Same check and same failure
        // vocabulary as the specification self-approval guard.
        await requireSeparation({
          actor,
          action: 'approve_access',
          subjectActorId: userId,
          subjectId: userId,
          appVersion,
        });
      }

      let rpcName: string;
      let args: ApproveAccountArgs | SetUserStatusArgs | RoleAssignmentArgs;
      let detail: Record<string, unknown>;

      switch (action) {
        case 'approve_access': {
          const roles = readRoles(body) ?? [];
          rpcName = RPC.approveAccount;
          args = { ...envelope, p_target_user: userId, p_reason: reason, p_roles: roles };
          detail = { roles };
          break;
        }
        case 'deny_access': {
          /**
           * Denial is a status change to `disabled`, not a delete. A pending
           * account that was refused is a record somebody may have to account
           * for later, and FR-001's gate is already "anything but active sees
           * nothing", so a disabled account reads nothing.
           */
          rpcName = RPC.setUserStatus;
          args = {
            ...envelope,
            p_target_user: userId,
            p_status: 'disabled',
            p_reason: reason,
          };
          detail = { status: 'disabled', denied: true };
          break;
        }
        case 'set_status': {
          const status = parseStatus(body['status']);
          if (status === null) {
            throw new ApiError('bad_request', {
              message: 'A known account status must be named.',
              details: { field: 'status', allowed: USER_STATUSES },
            });
          }
          if (userId === actor.userId && status !== 'active') {
            // Not a quality control, but a reliable way to leave a deployment
            // with no reachable administrator.
            throw new ApiError('bad_request', {
              message: 'You cannot suspend or disable your own account.',
            });
          }
          rpcName = RPC.setUserStatus;
          args = { ...envelope, p_target_user: userId, p_status: status, p_reason: reason };
          detail = { status };
          break;
        }
        case 'set_roles': {
          const roles = readRoles(body);
          if (roles === null) {
            throw new ApiError('bad_request', {
              message: 'The roles this account should hold must be listed.',
              details: { field: 'roles', allowed: ROLES },
            });
          }
          rpcName = RPC.setUserRoles;
          args = { ...envelope, p_target_user: userId, p_roles: roles, p_reason: reason };
          detail = { roles };
          break;
        }
      }

      const result = await callTransaction<AdminActionResult>(admin, rpcName, args);

      /** COMMIT POINT — see `_shared/commitOutcome.ts`. */
      markCommitted({
        ok: true,
        action,
        userId: result.target_user,
        status: result.status,
        recordedAt: result.recorded_at,
      });

      await recordAudit({
        actorId: actor.userId,
        action: `admin_action.${action}`,
        subjectType: 'user',
        subjectId: userId,
        outcome: 'allowed',
        reason,
        after: { ...detail, status: result.status, roles: result.roles },
        appVersion,
      });

      return {
        ok: true,
        action,
        userId: result.target_user,
        status: result.status,
        roles: result.roles,
        recordedAt: result.recorded_at,
        message:
          action === 'approve_access'
            ? 'The account has been approved.'
            : action === 'deny_access'
              ? 'The account has been refused and can see nothing.'
              : action === 'set_status'
                ? `The account status is now ${result.status}.`
                : 'The roles for this account have been updated.',
      };
    },
  };
}
