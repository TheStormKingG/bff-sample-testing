/**
 * POST /change-own-password — the holder replaces their own password.
 *
 * THIS FUNCTION IS DELIBERATELY UNLIKE EVERY OTHER WRITE ENDPOINT IN THE
 * PROJECT, and the difference is the feature rather than an oversight.
 *
 * Migration 0019 put a gate inside `public.require_permission`: while an
 * administrator-set password is outstanding, the account holds NO permission by
 * any route — PostgREST, Edge Function or RPC. This endpoint is the way out of
 * that state. Its caller therefore holds no permission BY CONSTRUCTION, which
 * rules out the pipeline every other mutation uses:
 *
 *  - IT DOES NOT CALL `require_permission`, IN SQL OR IN TYPESCRIPT, AND MUST
 *    NEVER BE "HARDENED" TO. At the moment this runs, `require_permission` is
 *    raising `BFF_PASSWORD_CHANGE_REQUIRED` for exactly this actor — that is
 *    the state the call exists to clear. A permission check here would make the
 *    only escape from the gate unreachable and lock every administrator-created
 *    account out of the system permanently, while every individual line looked
 *    prudent. `rpc_record_password_changed` carries the same warning in its own
 *    comment, because this is the kind of check a later reader adds by reflex.
 *
 *  - IT DOES NOT USE `runMutation`. That pipeline requires a `Permission` from
 *    the matrix (`MutationSpec.permission` is not optional) and would check it
 *    against an account that holds none. It also requires an `Idempotency-Key`,
 *    and `rpc_record_password_changed` is the one mutating RPC that never calls
 *    `claim_mutation`, so there is no claim for a key to be compared against.
 *    `changeOwnPassword` in `src/lib/supabase.ts` sends no key, which agrees.
 *
 *  - IT DOES NOT CALL `authenticate()`. That helper refuses any account whose
 *    status is not `active`, and a newly created account is `pending` until an
 *    administrator approves it. 0019 states explicitly that a pending account
 *    must be able to clear its temporary credential before it is approved, and
 *    `rpc_record_password_changed` has no status check for that reason. Using
 *    `authenticate()` here would make a capability the database deliberately
 *    grants unreachable through the only path that reaches it.
 *
 * WHAT STANDS IN THEIR PLACE. The bearer token is verified by
 * `auth.getUser(token)` — Supabase checks it against the project's JWKS, so a
 * forged or expired token fails there — and the uid it returns is the ONLY
 * identity this function acts on. There is no user id in the request body, no
 * parameter that could name one, and `rpc_record_password_changed` has no
 * target argument either. The worst a caller can do is change its own password.
 *
 * IDENTITY. `data.user.id` from the verified token, and nothing else. The body
 * carries one field: `newPassword`.
 *
 * DENO-ONLY.
 */

import { createClient } from 'npm:@supabase/supabase-js@2.47.10';

import { ApiError } from '../_shared/errors.ts';
import {
  jsonResponse,
  readJsonBody,
  serveFunction,
  type RequestContext,
} from '../_shared/adapters/http.ts';
import { adminClient, recordAudit } from '../_shared/adapters/authorize.ts';
import { callTransaction } from '../_shared/adapters/mutation.ts';
import { RPC, type RecordPasswordChangedArgs } from '../_shared/rpc.ts';
import { passwordIssues } from '../_shared/validation.ts';
import { readPlatformConfig } from '../_shared/adapters/env.ts';

/**
 * The audit action for a change to the holder's own password.
 *
 * The same string `rpc_record_password_changed` writes on success. It is used
 * here only with `outcome: 'denied'`, so the trail reads as attempts and
 * outcomes of one named act rather than as two unrelated vocabularies.
 */
const PASSWORD_CHANGED_ACTION = 'identity.password_changed';

type SameAsCurrent =
  | { readonly verdict: 'same' }
  | { readonly verdict: 'different' }
  /** The probe could not establish either answer. Detail is for the log only. */
  | { readonly verdict: 'inconclusive'; readonly detail: string };

/**
 * Is the proposed password the one the account already has?
 *
 * ESTABLISHED BY ATTEMPTING A SIGN-IN, because that is the only check that
 * tests what GoTrue actually stores. Comparing the submitted string against
 * anything this function could read would compare it against a bcrypt hash we
 * cannot reverse — and bcrypt ignores everything past the 72nd byte, so even a
 * string comparison of two long passwords could call them different when the
 * stored credential is identical. A sign-in asks the question the attacker's
 * route would ask.
 *
 * WHY IT MATTERS ENOUGH TO SPEND A ROUND TRIP. A "change" that re-sets the same
 * temporary password clears the forced-change flag while leaving the credential
 * the administrator typed in force. The control would report success and change
 * nothing, which is worse than not having it: the account would read as
 * attributable to one person when two people can sign in as it.
 *
 * THE PROBE CLIENT IS NEVER SIGNED OUT, deliberately. A successful probe
 * returns a session, and the reflex is to call `signOut()` — but this client's
 * default scope is GLOBAL, which revokes every session that account holds,
 * including the browser session of the person currently changing their
 * password. They would be thrown out mid-change. The client is created with
 * `persistSession: false`, so its tokens exist only in this request's memory
 * and are discarded when it returns; nothing is written anywhere and nothing
 * is transmitted onward.
 */
async function isSameAsCurrentPassword(
  email: string,
  candidate: string,
): Promise<SameAsCurrent> {
  const config = readPlatformConfig();
  const probe = createClient(config.supabaseUrl, config.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  try {
    const { error } = await probe.auth.signInWithPassword({ email, password: candidate });
    if (error === null) return { verdict: 'same' };

    // Wrong password, or no such account: either way the candidate is not the
    // credential in force. GoTrue answers `invalid_credentials` for both.
    const code = typeof error.code === 'string' ? error.code : '';
    if (code === 'invalid_credentials' || /invalid login credentials/i.test(error.message)) {
      return { verdict: 'different' };
    }

    // Anything else — rate limiting, an unconfirmed address, a 5xx — did not
    // answer the question. Reported as such rather than guessed at, because
    // both guesses are harmful: "different" would let the control be defeated
    // by a burst of requests, and "same" would refuse a legitimate change.
    return { verdict: 'inconclusive', detail: `${code || 'no_code'}: ${error.message}` };
  } catch (cause) {
    return {
      verdict: 'inconclusive',
      detail: cause instanceof Error ? cause.message : String(cause),
    };
  }
}

async function handler(ctx: RequestContext): Promise<Response> {
  const body = await readJsonBody(ctx.request);

  if (ctx.bearerToken === null) {
    throw new ApiError('unauthenticated', { internalDetail: 'no bearer token presented' });
  }

  // 1. IDENTITY, from the token and nothing else.
  const admin = adminClient();
  const { data, error } = await admin.auth.getUser(ctx.bearerToken);
  if (error !== null || data.user === null) {
    throw new ApiError('unauthenticated', {
      internalDetail: error?.message ?? 'getUser returned no user',
    });
  }
  const user = data.user;

  // 2. POLICY, enforced here and not only in the browser. The same rules the
  //    administrator's temporary password is held to — one policy, in
  //    `_shared/validation.ts`, so the two cannot drift.
  const issues = passwordIssues('newPassword', body['newPassword']);
  if (issues.length > 0) {
    throw new ApiError('validation_failed', { details: { issues } });
  }
  const newPassword = body['newPassword'] as string;

  // 3. THE NEW PASSWORD MUST NOT BE THE OLD ONE.
  const email = typeof user.email === 'string' ? user.email.trim() : '';
  if (email === '') {
    // `tg_handle_new_auth_user` refuses to provision an identity without an
    // address, so this is a state the schema forbids. Refuse rather than skip
    // the check: skipping it is how the control becomes decorative.
    throw new ApiError('internal', {
      message:
        'Your password could not be changed because this account has no email address on record. Ask an administrator to check it.',
      internalDetail: `no email on auth user ${user.id}`,
    });
  }

  const sameness = await isSameAsCurrentPassword(email, newPassword);

  if (sameness.verdict === 'same') {
    // Audited. This is not a typo — it is an attempt, successful or not, to
    // satisfy the forced change without actually changing the credential, and
    // FR-002's principle is that a refusal nobody can see is indistinguishable
    // from one that never happened.
    await recordAudit({
      actorId: user.id,
      action: PASSWORD_CHANGED_ACTION,
      subjectType: 'profile',
      subjectId: user.id,
      outcome: 'denied',
      reason: 'the proposed password is the one already in force',
      appVersion: ctx.appVersion,
    });
    throw new ApiError('validation_failed', {
      message:
        'That is the password the account already has. Choose a different one — the point of the change is that nobody else knows it.',
      details: {
        issues: [
          {
            field: 'newPassword',
            code: 'unchanged',
            message: 'That is the password this account already has.',
          },
        ],
      },
      internalDetail: `change-own-password refused for ${user.id}: unchanged`,
    });
  }

  if (sameness.verdict === 'inconclusive') {
    // FAIL CLOSED, BUT RECOVERABLY. Nothing has been written, so the holder can
    // simply try again — which is why refusing is safe here and letting it
    // through would not be.
    throw new ApiError('rate_limited', {
      message:
        'Your password has NOT been changed. It could not be checked against the current one just now. Wait a moment and try again.',
      internalDetail: `sameness probe inconclusive for ${user.id}: ${sameness.detail}`,
    });
  }

  // 4. THE CREDENTIAL FIRST, THE RECORD SECOND, and that order is a control.
  //    The two writes are not in one transaction, so one can land without the
  //    other, and the two orders fail in opposite directions:
  //
  //      record first: if the password write then fails, the forced change is
  //      CLEARED while the administrator's temporary password is still in
  //      force. The gate reports itself satisfied and the account is running on
  //      a credential two people know. That is the exact hole 0019 exists to
  //      close.
  //
  //      password first: if the record then fails, the holder's own new
  //      password works and the gate is still armed. Nobody else knows the
  //      credential, so attribution is intact; the cost is that the holder is
  //      asked again.
  //
  //    So the record is never written before the credential it describes.
  const applied = await admin.auth.admin.updateUserById(user.id, { password: newPassword });
  if (applied.error !== null) {
    throw new ApiError('internal', {
      message:
        'Your password has NOT been changed. Please try again; if it keeps failing, ask an administrator to set you a new temporary password.',
      internalDetail: `updateUserById ${user.id}: ${applied.error.message}`,
    });
  }

  // 5. RECORD IT, which is what clears the gate.
  const args: RecordPasswordChangedArgs = {
    p_actor: user.id,
    p_app_version: ctx.appVersion,
  };

  // Retried ONCE. The call is idempotent — it stamps `password_changed_at` with
  // `now()` and writes one audit event — so a second attempt cannot do damage,
  // and at this point the holder's password has already changed: a transient
  // failure here leaves them gated with no way to retry the whole operation,
  // because the second attempt would be refused by step 3 as unchanged. One
  // cheap retry removes most of that window.
  let recordedAt: string;
  try {
    recordedAt = await callTransaction<string>(admin, RPC.recordPasswordChanged, args);
  } catch (firstFailure) {
    try {
      recordedAt = await callTransaction<string>(admin, RPC.recordPasswordChanged, args);
    } catch (secondFailure) {
      // Honest about a half-done job. The password HAS changed, so "nothing was
      // saved" would be a lie that sends the holder to use a password that no
      // longer works.
      throw new ApiError('internal', {
        message:
          'Your new password is now in force — sign in with it. The record of the change could not be written, so you may be asked to change it again; if you are, choose a different password, because this one is now the current one.',
        internalDetail:
          `${RPC.recordPasswordChanged} failed twice for ${user.id} AFTER the password was changed: ` +
          `${firstFailure instanceof Error ? firstFailure.message : String(firstFailure)} / ` +
          `${secondFailure instanceof Error ? secondFailure.message : String(secondFailure)}`,
      });
    }
  }

  return jsonResponse(
    {
      ok: true,
      recordedAt,
      message:
        'Your password has been changed. It is now the only one that works for this account.',
    },
    { request: ctx.request, status: 200 },
  );
}

serveFunction({ name: 'change-own-password', methods: ['POST'] }, handler);
