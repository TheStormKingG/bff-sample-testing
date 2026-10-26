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

import { ApiError, isApiError } from '../errors.ts';
import { callTransaction, readString, type MutationSpec } from '../adapters/mutation.ts';
import {
  RPC,
  type AdminActionResult,
  type ApproveAccountArgs,
  type ControlledValueArgs,
  type ControlledValueResult,
  type DelegationResult,
  type GrantDelegationArgs,
  type RecordAdminPasswordSetArgs,
  type RecordAdminPasswordSetResult,
  type RevokeDelegationArgs,
  type RoleAssignmentArgs,
  type SetUserStatusArgs,
} from '../rpc.ts';
import { recordAudit, requireSeparation } from '../adapters/authorize.ts';
import {
  ADMIN_ACTION_PERMISSION,
  delegationGrantRefusal,
  PASSWORD_SETTING_ADMIN_ACTIONS,
  type AdminAction,
} from '../actions.ts';
import { normaliseEmail, passwordIssues } from '../validation.ts';
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.47.10';
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

/**
 * Does this action hand an account a password somebody else chose?
 *
 * Reads the list in `_shared/actions.ts` rather than repeating the two names,
 * so the constant that migration 0019's `c_operations` array is compared
 * against is the same constant this branch is selected by. A named set that
 * nothing reads is free to drift from the code it claims to describe.
 */
function isPasswordSettingAction(
  action: AdminAction,
): action is 'create_account' | 'set_password' {
  return (PASSWORD_SETTING_ADMIN_ACTIONS as readonly string[]).includes(action);
}

/**
 * A password nobody will ever be told.
 *
 * Used as the credential a brand-new account is created with, so that the
 * account exists — and can therefore have its forced change armed — before the
 * password the administrator typed is live on it. 32 random bytes, base64url,
 * 43 characters: inside the policy's own bounds, and derived from nothing the
 * caller sent.
 */
function unknowablePassword(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Refuse an address that already has an account, by name rather than by 500.
 *
 * Checked against `public.profiles`, which is keyed `unique (lower(email))`
 * and is written by `tg_handle_new_auth_user` from `auth.users` — so it is a
 * faithful index of which addresses have accounts, and it is readable with the
 * client this function already holds. `auth.admin` offers no lookup-by-address
 * in this client version, and `listUsers` is paginated, so a scan would be
 * both slower and wrong on the second page.
 *
 * This is a check, not a guarantee: two administrators creating the same
 * address at the same moment both pass it. That is why `createUser`'s own
 * duplicate error is mapped to the SAME refusal below. The pre-check exists to
 * make the common case a clear 422 instead of an opaque database error, and
 * the error mapping exists because the pre-check cannot be atomic.
 */
async function refuseIfAddressTaken(admin: SupabaseClient, email: string): Promise<void> {
  const { data, error } = await admin
    .from('profiles')
    .select('id')
    .eq('email', email)
    .maybeSingle();

  if (error !== null) {
    throw new ApiError('internal', {
      internalDetail: `profiles lookup for ${email}: ${error.message}`,
    });
  }
  if (data !== null) {
    throw new ApiError('validation_failed', {
      message:
        'That email address already has an account. Use Reset password on the existing account instead of creating a second one.',
      details: {
        issues: [
          {
            field: 'email',
            code: 'already_exists',
            message: 'That email address already has an account.',
          },
        ],
      },
      internalDetail: `create_account refused: ${email} already provisioned`,
    });
  }
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

/**
 * The body keys of this endpoint that carry a credential.
 *
 * Declared rather than inferred, and declared for ALL admin actions rather
 * than only the two that use it: a per-action list would have to be kept in
 * step with `isPasswordSettingAction`, and the cost of naming a key an action
 * never sends is nothing — `requestPayloadHash` withholds only keys that are
 * actually present.
 *
 * `temporaryPassword` is the only one today. `newPassword` is NOT here because
 * it never reaches this endpoint: `change-own-password` has its own function
 * and does not go through `runMutation` at all, so no digest of it is ever
 * written. That is checked, not assumed, by `tests/payloadSecrets.test.ts`,
 * which derives the whole set of credential-shaped body keys from the tree.
 */
const ADMIN_SECRET_BODY_KEYS: readonly string[] = ['temporaryPassword'];

/**
 * Report the two writes of a password action truthfully when the FIRST of them
 * has already landed.
 *
 * `create_account` does three things that are not in one transaction:
 * `createUser`, then the arming RPC, then `updateUserById`. If the arming RPC
 * fails, the `auth.users` row and its profile EXIST. The generic message for
 * an `internal` error is "Something went wrong. Nothing was saved." — which at
 * that point is false, and false in the most expensive direction: it tells the
 * administrator to try again, the retry hits `refuseIfAddressTaken`, and they
 * are told the address already has an account they were just told was not
 * created.
 *
 * WHAT THIS MESSAGE MAY AND MAY NOT SAY. It states only what is OBSERVED — the
 * account exists, it is not armed, no password the administrator chose was
 * set — and the remedy. It does NOT name a cause. More than one thing produces
 * this state (a transient database error, a refused self-target, an idempotency
 * conflict, an unapplied migration), and a message that picks one would send
 * the reader to fix the wrong thing with the system's own authority behind it.
 * The cause IS available: the original error's code and `internalDetail` reach
 * the server log through `toLogRecord`, which is where a cause belongs under
 * this project's error policy.
 *
 * THE ORIGINAL CODE IS PRESERVED. A `forbidden` stays a 403 and a
 * `rpc_not_deployed` stays itself, so only the operator-facing sentence
 * changes; replacing the code would make a self-target refusal look like a
 * server fault.
 */
function reportArmingFailure(
  action: AdminAction,
  createdEmail: string | null,
  cause: unknown,
): unknown {
  // No account was created on this path, so every existing message is already
  // true and must not be touched.
  if (createdEmail === null) return cause;

  const observed =
    `The account for ${createdEmail} WAS created, but the record that forces a ` +
    'password change could not be written. No password has been set on it, so ' +
    'nobody can sign in to it and it is not usable yet. Use Reset password on ' +
    'that account to arm it and set a temporary password — do not create a ' +
    'second account for this person, and do not hand out the password you just ' +
    'typed, because it was never applied.';

  if (!isApiError(cause)) {
    return new ApiError('internal', {
      message: observed,
      internalDetail:
        `${RPC.recordAdminPasswordSet} failed for a just-created account (${action}): ` +
        (cause instanceof Error ? cause.message : String(cause)),
      cause,
    });
  }

  return new ApiError(cause.code, {
    message: observed,
    details: cause.details,
    internalDetail:
      `${RPC.recordAdminPasswordSet} failed for a just-created account (${action}): ` +
      `${cause.code}: ${cause.internalDetail ?? cause.message}`,
    cause,
  });
}

export function adminSpec(action: AdminAction): MutationSpec<Record<string, unknown>> {
  return {
    operation: `admin_action.${action}`,
    secretBodyKeys: ADMIN_SECRET_BODY_KEYS,
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

      // ---- credentials ---------------------------------------------------
      //
      // THE ORDER OF THE TWO WRITES IS THE WHOLE CONTROL, and it is the
      // reverse of the obvious one. Both actions do two things that are NOT in
      // one transaction — write a credential to `auth.users` through the admin
      // API, and record in `public.profiles` that an administrator set it —
      // so one of them can succeed while the other fails, and the two possible
      // orders leave opposite states behind:
      //
      //   set the password first, then arm: if arming fails, an administrator
      //   knows a live password on an account with NO forced change. Both of
      //   them can sign in as that person and nothing recorded under it names
      //   one of them. That is precisely the hole this feature exists to
      //   close, and it would be left open by a transient database error.
      //
      //   arm first, then set the password: if setting fails, the account is
      //   gated and its OLD credential (or, for a new account, one nobody has
      //   ever seen) is what still works. Nobody gains anything; somebody has
      //   to retry. Attribution is never in doubt.
      //
      // So the invariant is: THE CREDENTIAL AN ADMINISTRATOR KNOWS NEVER GOES
      // LIVE ON AN ACCOUNT THAT IS NOT ALREADY ARMED. Every statement below is
      // ordered to hold it.
      //
      // WHY IT CANNOT INSTEAD BE UNDONE. The tempting alternative is to set
      // the password first and delete the account if arming fails. That is
      // impossible in this schema, verified by execution rather than by
      // reading: `profiles_id_fkey` is ON DELETE RESTRICT, so the `auth.users`
      // row cannot be deleted while its profile exists, and
      // `audit_events_actor_id_fkey` is ON DELETE RESTRICT, so the profile
      // cannot be deleted while the `identity.provisioned` event that
      // `tg_handle_new_auth_user` wrote for it exists. Account creation here is
      // irreversible by design — denial is a status change to `disabled`, not
      // a delete — so the dangerous state has to be unreachable, not
      // reversible.
      //
      // For `create_account` that requires one extra step: the account is
      // created with a password NOBODY is told, which is what lets it exist —
      // and be armed — before the administrator's chosen temporary password is
      // live on it.
      //
      // WHERE THE CREDENTIAL GOES, LAYER BY LAYER. The previous version of this
      // comment said "NO PASSWORD IS AUDITED, LOGGED OR RETURNED", which was
      // true of every layer it named and MISSED ONE. The missing layer was the
      // payload hash — a one-way digest, which is why it read as the mitigation
      // rather than as a store. It was an unsalted single round of sha256 over
      // an object containing the plaintext, written to a column `authenticated`
      // can SELECT. So the list is now exhaustive and per-layer, because a
      // clean verdict with no enumeration behind it certifies only that nobody
      // looked:
      //
      //   idempotency_requests.payload_hash   WITHHELD. `requestPayloadHash`
      //       (`_shared/hash.ts`) drops `temporaryPassword` before hashing, by
      //       shape and by the `secretBodyKeys` declaration above.
      //   idempotency_requests.response       the object returned at the foot
      //       of this branch. Ids, status, timestamp, message. No credential.
      //   audit_events.after / .reason        `must_change_password`, status
      //       and, for a new account, the address and display name. The reason
      //       is the administrator's own typed text.
      //   markCommitted summary               ids and timestamps only.
      //   ApiError.details                    validation issue CODES and
      //       messages; `passwordIssues` quotes no part of the value, by rule.
      //   ApiError.internalDetail             server log only; every template
      //       below interpolates an id or a provider message, never the
      //       credential.
      //   the HTTP access log (`adapters/http.ts`)  function name, correlation
      //       id, status, duration. Never a body.
      //   auth.users                          the credential itself, bcrypt,
      //       which is the point.
      //
      // The two calls that are HANDED the plaintext are `createUser` (an
      // unknowable value, not the administrator's) and `updateUserById`. The
      // arming RPC is never told what the credential is.

      if (isPasswordSettingAction(action)) {
        // Validated BEFORE anything is written, so a password that breaks the
        // policy costs nothing and leaves nothing behind.
        const issues = passwordIssues('temporaryPassword', body['temporaryPassword']);
        if (issues.length > 0) {
          throw new ApiError('validation_failed', { details: { issues } });
        }
        const temporaryPassword = body['temporaryPassword'] as string;

        let targetUserId: string;
        let createdEmail: string | null = null;
        let createdDisplayName: string | null = null;

        if (action === 'create_account') {
          const parsedEmail = normaliseEmail(body['email']);
          if (!parsedEmail.ok) {
            throw new ApiError('validation_failed', {
              details: { issues: [parsedEmail.issue] },
            });
          }
          // Required rather than defaulted. The provisioning trigger falls back
          // to the address's local part when `full_name` is blank, so an
          // omitted display name would silently produce an account called
          // "j.persaud" on every quality record it ever signs. Refusing is the
          // honest answer; the administrator knows the person's name.
          const displayName = readString(body, 'displayName', {
            required: true,
            maxLength: 200,
          })!;
          if (displayName.trim() === '') {
            throw new ApiError('validation_failed', {
              details: {
                issues: [
                  {
                    field: 'displayName',
                    code: 'required',
                    message: 'The name of the person this account belongs to is required.',
                  },
                ],
              },
            });
          }

          await refuseIfAddressTaken(admin, parsedEmail.email);

          const created = await admin.auth.admin.createUser({
            email: parsedEmail.email,
            // Not the administrator's password — see the ordering note above.
            password: unknowablePassword(),
            // TRUE because there is no SMTP in this project. An unconfirmed
            // user could never confirm: GoTrue would have to deliver a link,
            // and the shared sender does not reach this plant. The account
            // would be dead on arrival, and the administrator would be told it
            // was created.
            email_confirm: true,
            // What makes `tg_handle_new_auth_user` derive a real display name
            // instead of the email's local part. Verified against the trigger
            // by execution: `full_name` in `raw_user_meta_data` lands in
            // `profiles.display_name`.
            user_metadata: { full_name: displayName.trim() },
          });

          if (created.error !== null) {
            const detail = created.error.message;
            // A duplicate that slipped past the pre-check — two administrators
            // at once, or an `auth.users` row with no profile. Same refusal,
            // so the two routes are indistinguishable to the caller.
            if (/already|exist|registered|duplicate/i.test(detail)) {
              throw new ApiError('validation_failed', {
                message:
                  'That email address already has an account. Use Reset password on the existing account instead of creating a second one.',
                details: {
                  issues: [
                    {
                      field: 'email',
                      code: 'already_exists',
                      message: 'That email address already has an account.',
                    },
                  ],
                },
                internalDetail: `createUser refused ${parsedEmail.email}: ${detail}`,
              });
            }
            throw new ApiError('internal', {
              message: 'The account could not be created. Nothing was saved. Please try again.',
              internalDetail: `createUser ${parsedEmail.email}: ${detail}`,
            });
          }
          if (created.data.user === null) {
            throw new ApiError('internal', {
              message: 'The account could not be created. Nothing was saved. Please try again.',
              internalDetail: 'createUser returned no user and no error',
            });
          }

          targetUserId = created.data.user.id;
          createdEmail = parsedEmail.email;
          createdDisplayName = displayName.trim();
        } else {
          targetUserId = readString(body, 'userId', { required: true })!;
        }

        // ARM. `rpc_record_admin_password_set` re-derives `user.manage` from
        // the actor, refuses a self-target through `assert_administers_other`,
        // demands the reason, and writes
        // `identity.password_set_by_administrator`. From the moment it commits,
        // `require_permission` withholds every permission from this account by
        // every route until the holder chooses their own password.
        const args: RecordAdminPasswordSetArgs = {
          ...envelope,
          p_target_user: targetUserId,
          p_reason: reason,
        };
        // Wrapped, because for `create_account` the account already exists at
        // this line and the default `internal` message says nothing was saved.
        // See `reportArmingFailure`: observed state only, original code kept.
        let armed: RecordAdminPasswordSetResult;
        try {
          armed = await callTransaction<RecordAdminPasswordSetResult>(
            admin,
            RPC.recordAdminPasswordSet,
            args,
          );
        } catch (cause) {
          throw reportArmingFailure(action, createdEmail, cause);
        }

        // Only now does the administrator's own password become live.
        const applied = await admin.auth.admin.updateUserById(targetUserId, {
          password: temporaryPassword,
        });
        if (applied.error !== null) {
          // The arming committed and this did not, which is the safe half of
          // the pair. The message has to say so precisely: `internal`'s
          // default text is "Nothing was saved", and that is now false.
          throw new ApiError('internal', {
            message:
              action === 'create_account'
                ? 'The account was created and is required to choose a new password, but the temporary password could not be set, so nobody can sign in to it yet. Use Reset password on that account to set one.'
                : 'That account is now required to choose a new password, but the new temporary password could not be set, so the previous one still works. Try Reset password again.',
            internalDetail: `updateUserById ${targetUserId}: ${applied.error.message}`,
          });
        }

        /** COMMIT POINT — see `_shared/commitOutcome.ts`. */
        markCommitted({
          ok: true,
          action,
          userId: armed.target_user,
          status: armed.status,
          recordedAt: armed.recorded_at,
        });

        await recordAudit({
          actorId: actor.userId,
          action: `admin_action.${action}`,
          subjectType: 'user',
          subjectId: targetUserId,
          outcome: 'allowed',
          reason,
          after: {
            // No credential, and none is available to put here.
            must_change_password: true,
            status: armed.status,
            ...(createdEmail === null
              ? {}
              : { email: createdEmail, display_name: createdDisplayName }),
          },
          appVersion,
        });

        return {
          ok: true,
          action,
          userId: armed.target_user,
          status: armed.status,
          recordedAt: armed.recorded_at,
          message:
            action === 'create_account'
              ? 'The account has been created and must choose a new password at first sign-in. Give the person the temporary password directly — nothing is emailed. The account still needs to be approved before it can see anything.'
              : 'The temporary password is set. The holder must choose a new one before they can do anything, and until they do, this account has no authority.',
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
