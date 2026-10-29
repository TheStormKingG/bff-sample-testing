/**
 * Administration data: user access, roles, delegations, controlled lists,
 * sync health, schema verification and the audit query.
 *
 * An Administrator has no quality authority anywhere in here. Approving a
 * specification, clearing a hold and releasing material are deliberately
 * absent from the admin surface because they are absent from the role
 * (Master Prompt §1, PRD §2).
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { SupabaseClient } from '@supabase/supabase-js';
import { supabase, edgeErrorMessage } from '@/lib/supabase';
import type { Stage } from '@/forms/types';
import { DASHBOARD_ORDER } from '@/forms/registry';
import { expectedHeaders, type HeaderMismatch } from '@/forms/sheetMapping';
import type { Permission, Role, UserStatus } from '@/lib/roles';
import { plantDayEnd, plantDayStart } from '@/lib/time';
import { FUNCTIONS, TABLES, type AuditEventRow } from '@/hooks/useSamples';
import { newIdempotencyKey } from '@/hooks/useRegisterSample';

const db = supabase as unknown as SupabaseClient;

/**
 * PostgREST carries an `in` filter in the query string, so one unbounded list
 * of uuids can outgrow a proxy's request-line limit. The two id lookups below
 * resolve in batches for that reason, not for database cost.
 */
const ID_BATCH = 100;

function batches<T>(values: readonly T[], size = ID_BATCH): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    out.push(values.slice(index, index + size));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Users, roles and delegations
// ---------------------------------------------------------------------------

export interface AdminUser {
  readonly id: string;
  readonly email: string | null;
  readonly full_name: string | null;
  readonly status: UserStatus;
  readonly created_at: string;
  readonly roles: readonly Role[];
  /**
   * When an administrator last typed a password for this account, and when the
   * holder last chose one themselves. Both are `timestamptz` on
   * `public.profiles` (migration 0019) and both are NULL for every account
   * that has only ever signed in with Google — NULL means "this never
   * happened", not "this happened at an unknown time".
   *
   * Neither is a credential. They are instants, and `authenticated` already
   * holds SELECT on `public.profiles`, so reading them here adds no privilege.
   */
  readonly password_set_by_admin_at: string | null;
  readonly password_changed_at: string | null;
  /**
   * Derived, not read: the contract's OUTSTANDING rule evaluated over the two
   * instants above. See `hasOutstandingPasswordChange`.
   *
   * THIS IS A LABEL, NOT A CONTROL. The gate is `public.must_change_password`,
   * reached by two separate chains: `public.require_permission` raises
   * `BFF_PASSWORD_CHANGE_REQUIRED` on the RPC and Edge Function route, and
   * since migration 0020 `public.is_active_user()` and
   * `public.has_permission()` return false on the row-level-security route.
   * Naming only the first — as this comment did — is what let an armed account
   * read and delete through PostgREST while every comment said it could not.
   * `must_change_password` itself is granted to `service_role` only, so the
   * browser cannot call it and this field is the honest best the client can
   * compute from columns it can read.
   */
  readonly password_change_outstanding: boolean;
}

/**
 * Is a forced password change outstanding for this account?
 *
 * The contract's rule: outstanding when `password_set_by_admin_at` is not null
 * AND (`password_changed_at` is null OR `password_changed_at <=
 * password_set_by_admin_at`). Written here as its contrapositive — the change
 * is cleared only by a self-chosen password STRICTLY LATER than the
 * administrator's — because that form is also the safe answer when either
 * instant cannot be parsed.
 *
 * PostgREST returns `timestamptz` as an ISO string whose offset and fractional
 * precision are not fixed, so the two values are compared as parsed instants
 * and never as strings: `2026-10-26T13:00:00+00:00` and
 * `2026-10-26T09:00:00-04:00` are the same moment and do not sort as equal.
 *
 * An unparseable value resolves to "outstanding". That direction is
 * deliberate and matches the asymmetry stated in migration 0019: reporting a
 * change that is in fact already done costs one needless screen, while
 * reporting a completed change that never happened tells an auditor an
 * administrator no longer knows a live password when they still might.
 */
export function hasOutstandingPasswordChange(account: {
  readonly password_set_by_admin_at: string | null;
  readonly password_changed_at: string | null;
}): boolean {
  if (account.password_set_by_admin_at === null) return false;
  if (account.password_changed_at === null) return true;
  const setByAdmin = Date.parse(account.password_set_by_admin_at);
  const chosenByHolder = Date.parse(account.password_changed_at);
  if (Number.isNaN(setByAdmin) || Number.isNaN(chosenByHolder)) return true;
  return chosenByHolder <= setByAdmin;
}

export interface AdminDelegation {
  readonly id: string;
  readonly user_id: string;
  readonly user_email: string | null;
  readonly permission: Permission;
  readonly granted_by: string | null;
  readonly granted_by_name: string | null;
  readonly effective_from: string;
  readonly effective_to: string | null;
  readonly reason: string | null;
  /**
   * `user_delegations` keeps a revoked row and stamps it, and
   * `rpc_revoke_delegation` REFUSES a second revocation
   * (`BFF_ALREADY_REVOKED`). Both are read because a list that shows every
   * delegation ever recorded without its revocation reads as live authority,
   * and because offering Revoke on a revoked row offers an act the server will
   * reject.
   */
  readonly revoked_at: string | null;
  readonly revoke_reason: string | null;
}

/** The three columns a uuid can be resolved to a readable person with. */
interface ProfileNameRow {
  readonly id: string;
  readonly email: string | null;
  readonly display_name: string | null;
}

interface ProfileRow {
  readonly id: string;
  readonly email: string | null;
  readonly display_name: string | null;
  readonly status: UserStatus;
  readonly created_at: string;
  readonly password_set_by_admin_at: string | null;
  readonly password_changed_at: string | null;
}

/**
 * NO SIGN-IN AND NO LAST-ACTIVITY INSTANT IS READ HERE, DELIBERATELY.
 *
 * `profiles` has no sign-in timestamp at all. It does have `last_seen_at`
 * (`0001_identity.sql`, nullable, no default), and this hook used to pipe that
 * column to a field the screen printed as "last signed in". NOTHING WRITES IT:
 * no migration, trigger, RPC body, Edge Function or frontend path assigns it.
 * Checked three ways — a repository-wide grep for the name (declaration and
 * this file only), `pg_trigger` on `public.profiles` (just
 * `profiles_set_updated_at`), and every `pg_proc.prosrc` in the database (no
 * match) — and in `bff_migration_check` the column is NULL on every row. The
 * label therefore read "last signed in Never" for an account that was signed
 * in at that moment.
 *
 * It was removed rather than filled because both ways to fill it are worse
 * than silence. Mirroring GoTrue's `auth.users.last_sign_in_at` cannot even be
 * created against the verification database (that column does not exist in the
 * local auth shim, so the migration would fail `verify-migrations.sh`) and
 * would couple a public migration to an internal auth table. Writing the
 * column from the request path is per-request activity telemetry rather than a
 * sign-in time, and it would fire `profiles_set_updated_at` on every page
 * load, so `updated_at` would stop meaning "this record was changed" — in a
 * system whose audit trail is a regulated artefact. The client's own session
 * does carry a sign-in instant, but only for the viewer, never for the other
 * accounts this list is reviewing.
 *
 * Nor is one required: PRD §81's `_Users` register asks for the last ACCESS
 * REVIEW, not the last sign-in, and "when did this person last act" is already
 * answered under audit by `audit_events`, searchable on the Audit tab.
 */
export async function fetchAdminUsers(): Promise<readonly AdminUser[]> {
  const [profileRes, roleRes] = await Promise.all([
    db
      .from(TABLES.profiles)
      .select(
        'id,email,display_name,status,created_at,password_set_by_admin_at,password_changed_at',
      )
      .order('created_at', { ascending: false }),
    db.from(TABLES.userRoles).select('user_id,role'),
  ]);
  if (profileRes.error) throw new Error(profileRes.error.message);
  if (roleRes.error) throw new Error(roleRes.error.message);

  const roleMap = new Map<string, Role[]>();
  for (const r of (roleRes.data ?? []) as { user_id: string; role: Role }[]) {
    const list = roleMap.get(r.user_id);
    if (list) list.push(r.role);
    else roleMap.set(r.user_id, [r.role]);
  }

  return ((profileRes.data ?? []) as ProfileRow[]).map((p) => ({
    id: p.id,
    email: p.email,
    full_name: p.display_name,
    status: p.status,
    created_at: p.created_at,
    roles: roleMap.get(p.id) ?? [],
    password_set_by_admin_at: p.password_set_by_admin_at,
    password_changed_at: p.password_changed_at,
    password_change_outstanding: hasOutstandingPasswordChange(p),
  }));
}

export function useAdminUsers() {
  return useQuery({ queryKey: ['admin', 'users'], queryFn: fetchAdminUsers, staleTime: 15_000 });
}

type DelegationRow = Omit<AdminDelegation, 'user_email' | 'granted_by_name'>;

export function useAdminDelegations() {
  return useQuery({
    queryKey: ['admin', 'delegations'],
    queryFn: async (): Promise<readonly AdminDelegation[]> => {
      const { data, error } = await db
        .from(TABLES.delegations)
        .select(
          'id,user_id,permission,granted_by,effective_from,effective_to,reason,revoked_at,revoke_reason',
        )
        .order('effective_from', { ascending: false });
      if (error) throw new Error(await edgeErrorMessage(error, 'the service'));
      const rows = (data ?? []) as DelegationRow[];

      // `user_delegations` stores uuids and nothing else, so the holder's email
      // and the granting administrator's name come from a second read of
      // `profiles`. A delegation nobody can read is a delegation nobody
      // reviews, and the alternative here would be inventing a name.
      const ids = [
        ...new Set(
          rows
            .flatMap((r) => [r.user_id, r.granted_by])
            .filter((v): v is string => v !== null),
        ),
      ];
      const people = new Map<string, ProfileNameRow>();
      for (const batch of batches(ids)) {
        const res = await db.from(TABLES.profiles).select('id,email,display_name').in('id', batch);
        if (res.error) throw new Error(res.error.message);
        for (const person of (res.data ?? []) as ProfileNameRow[]) {
          people.set(person.id, person);
        }
      }

      return rows.map((r) => ({
        ...r,
        // Null where no profile row answers for the id: the screen then shows
        // the uuid, which is true, rather than a plausible name that is not.
        user_email: people.get(r.user_id)?.email ?? null,
        granted_by_name:
          r.granted_by === null ? null : (people.get(r.granted_by)?.display_name ?? null),
      }));
    },
    staleTime: 15_000,
  });
}

export type AdminActionKind =
  | 'approve_access'
  | 'deny_access'
  | 'set_status'
  | 'set_roles'
  | 'create_delegation'
  | 'revoke_delegation'
  | 'upsert_controlled_value'
  /** Migration 0019: an administrator makes an account with a temporary password. */
  | 'create_account'
  /** Migration 0019: an administrator replaces a forgotten password with a temporary one. */
  | 'set_password';

export interface AdminActionInput {
  readonly action: AdminActionKind;
  readonly userId?: string;
  readonly status?: UserStatus;
  readonly roles?: readonly Role[];
  readonly permission?: Permission;
  readonly effectiveFrom?: string;
  readonly effectiveTo?: string | null;
  readonly delegationId?: string;
  readonly listKey?: string;
  readonly value?: string;
  readonly label?: string;
  readonly active?: boolean;
  /** `create_account` only. */
  readonly email?: string;
  /**
   * `create_account` only. It is sent as `displayName` because
   * `tg_handle_new_auth_user` derives `profiles.display_name` from
   * `raw_user_meta_data->>'full_name'` first, so an account created without a
   * name provisions itself with the email local part instead of the person.
   */
  readonly displayName?: string;
  /**
   * THERE IS DELIBERATELY NO `temporaryPassword` FIELD HERE.
   *
   * It used to be one, and that is what put a plaintext credential in the
   * MutationCache for five minutes. Everything in this interface becomes
   * `mutation.state.variables`, which the cache retains until a
   * garbage-collection timer removes it, so the credential travels outside the
   * input instead: the caller calls `stashTemporaryPassword(key, password)`
   * and `useAdminAction` takes it out when it builds the body. See the block
   * comment above `stashTemporaryPassword` for why `reset()` could not do the
   * job it was given.
   */
  readonly reason: string;
  /**
   * The key the server replays a retry under.
   *
   * Optional, and generated per call when absent, which is what every existing
   * caller relies on. A caller that must be able to retry the SAME act — one
   * carrying a credential it cannot regenerate, for instance — passes its own
   * key so the second request replays the first outcome instead of performing
   * a second act (PRD §10.3).
   */
  readonly idempotencyKey?: string;
}

export interface AdminActionResult {
  readonly ok: boolean;
  readonly message: string;
}

/**
 * The request body for one administrative action.
 *
 * Extracted from `useAdminAction` so the wire names can be asserted by a test
 * without a network or a mocked client. Those names are the contract between
 * this file and `supabase/functions/_shared/handlers/admin.ts`, and this
 * project's three worst outages were all a name that differed across exactly
 * such a boundary.
 *
 * A field is included only when the caller supplied one. That is not tidiness:
 * `readRoles` on the server distinguishes an ABSENT `roles` ("leave the roles
 * alone") from an EMPTY one ("hold no roles"), and `upsert_controlled_value`
 * distinguishes an absent `active` from `false`. Sending `undefined` would be
 * dropped by `JSON.stringify` anyway; building the body explicitly makes the
 * distinction visible rather than incidental.
 */
export function adminActionBody(
  input: AdminActionInput,
  idempotencyKey: string,
  /**
   * The plaintext credential, passed as an argument rather than read out of
   * `input`, so this function stays pure and the credential's only route into
   * a request is the one place that takes it out of the stash.
   */
  temporaryPassword?: string,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    action: input.action,
    reason: input.reason,
    // The header below is the primary carrier; this is the documented fallback
    // for a proxy that strips custom headers. `NON_PAYLOAD_KEYS` in
    // `adapters/mutation.ts` excludes it from the payload hash, so sending
    // both cannot manufacture an idempotency conflict.
    idempotencyKey,
  };
  if (input.userId !== undefined) body['userId'] = input.userId;
  if (input.status !== undefined) body['status'] = input.status;
  if (input.roles !== undefined) body['roles'] = [...input.roles];
  if (input.permission !== undefined) body['permission'] = input.permission;
  if (input.effectiveFrom !== undefined) body['effectiveFrom'] = input.effectiveFrom;
  if (input.effectiveTo !== undefined) body['effectiveTo'] = input.effectiveTo;
  if (input.delegationId !== undefined) body['delegationId'] = input.delegationId;
  if (input.listKey !== undefined) body['listKey'] = input.listKey;
  if (input.value !== undefined) body['value'] = input.value;
  if (input.label !== undefined) body['label'] = input.label;
  if (input.active !== undefined) body['active'] = input.active;
  if (input.email !== undefined) body['email'] = input.email;
  if (input.displayName !== undefined) body['displayName'] = input.displayName;
  if (temporaryPassword !== undefined) body['temporaryPassword'] = temporaryPassword;
  return body;
}

/**
 * Does this action carry a plaintext credential?
 *
 * Keyed on the ACTION rather than on the presence of a field, so a payload
 * that should have carried a password and did not is still treated as
 * credential-bearing — and is refused rather than sent incomplete.
 */
export function carriesCredential(action: AdminActionKind): boolean {
  return action === 'create_account' || action === 'set_password';
}

// ---------------------------------------------------------------------------
// The credential hand-off
//
// WHY A STASH AND NOT A FIELD ON THE MUTATION INPUT
//
// `useMutation` keeps the variables it was called with in the MutationCache,
// and the previous design put the plaintext password among them and then
// "scrubbed" it by calling `reset()`. That does not work, and the reason
// generalises: a release API is a claim about a REFERENCE, not about memory.
// `MutationObserver.reset()` in @tanstack/query-core is
//
//     reset() { this.#currentMutation?.removeObserver(this);
//               this.#currentMutation = void 0; }
//
// — it detaches the observer and never touches the Mutation's state. The
// Mutation stays in the cache with `state.variables` intact and is removed by
// a garbage-collection TIMER `gcTime` later (five minutes by default;
// `src/lib/queryClient.ts` sets `gcTime` for queries only). So the credential
// outlived the request by five minutes, and the test defending the scrub was a
// regex over this file's own source text for the `reset()` call — an assertion
// that the remedy was WRITTEN, never that it worked, and one that passes a
// mutation probe by construction.
//
// A value never stored needs no scrub. So the credential does not travel in
// the mutation input at all: the caller stashes it against the idempotency key
// it has already generated, and `useAdminAction` takes it out — read AND
// delete — at the moment it builds the request body. What stays in the
// MutationCache is the action, the target and the written reason.
//
// The stash is module-scoped rather than React state because the value must
// not be reachable from a component's props, context or devtools tree. It is
// bounded by construction: `take` deletes, and `clearTemporaryPassword` exists
// for the path where the act is abandoned before any request is built.
// ---------------------------------------------------------------------------

const temporaryPasswordStash = new Map<string, string>();

/**
 * Hold a plaintext temporary password until its request body is built.
 *
 * Keyed on the idempotency key, which the caller must already have generated
 * for the same act — so the key that makes the request replayable is also what
 * ties the credential to it, and there is no second identifier to keep in step.
 */
export function stashTemporaryPassword(idempotencyKey: string, password: string): void {
  temporaryPasswordStash.set(idempotencyKey, password);
}

/** Read and remove. Called once, by the mutation function, and never twice. */
function takeTemporaryPassword(idempotencyKey: string): string | undefined {
  const password = temporaryPasswordStash.get(idempotencyKey);
  temporaryPasswordStash.delete(idempotencyKey);
  return password;
}

/**
 * Drop a stashed credential for an act that was abandoned.
 *
 * Needed because the stash happens when the form is submitted and the request
 * is built only after the reason dialog is confirmed. Cancelling that dialog
 * means no mutation function ever runs, so nothing would otherwise delete the
 * entry.
 */
export function clearTemporaryPassword(idempotencyKey: string): void {
  temporaryPasswordStash.delete(idempotencyKey);
}

/**
 * How many credentials are waiting to be sent. Exported for the test that
 * asserts the stash empties, because "read and delete" is a claim about state
 * and a claim about state is settled by reading it back.
 */
export function temporaryPasswordStashSize(): number {
  return temporaryPasswordStash.size;
}

/**
 * Every administrative action, through one Edge Function with a written reason.
 *
 * THE IDEMPOTENCY KEY IS NOT OPTIONAL ON THE WIRE. `runMutation` refuses any
 * request without one before it does anything else — "Every save must carry an
 * Idempotency-Key header so a retry cannot create a second record" — so the
 * seven actions this hook already posted were being refused with `bad_request`
 * for want of a key no caller sent. A key is therefore generated here when the
 * caller does not supply one, and sent both as the header and as the
 * documented body fallback, exactly as `useRegisterSample` does.
 *
 * WHAT HAPPENS TO A TEMPORARY PASSWORD. It never enters the mutation input, so
 * it is never in `mutation.state.variables` and there is nothing in the
 * MutationCache to scrub. The caller stashes it against the idempotency key it
 * generated for the same act; the mutation function below takes it out — read
 * and delete — builds the body with it, and the local `const` dies with the
 * call. The earlier design put it in the input and called `reset()`
 * afterwards, which detaches the observer and leaves the Mutation's state
 * untouched in the cache for `gcTime`; the block comment above
 * `stashTemporaryPassword` has the measurement.
 *
 * A credential-bearing action with NO stashed credential is refused here rather
 * than sent incomplete. The server would refuse it anyway, with a message about
 * a missing field; refusing it at the point the stash is read names the real
 * cause, which is a caller that did not stash.
 */
export function useAdminAction() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: AdminActionInput): Promise<AdminActionResult> => {
      const key = input.idempotencyKey ?? newIdempotencyKey();
      const credential = takeTemporaryPassword(key);
      if (carriesCredential(input.action) && credential === undefined) {
        throw new Error(
          'The temporary password for this action was not available when the request was ' +
            'built, so nothing was sent and nothing was changed. Type or generate the ' +
            'password again.',
        );
      }
      const { data, error } = await db.functions.invoke(FUNCTIONS.adminAction, {
        body: adminActionBody(input, key, credential),
        headers: { 'Idempotency-Key': key },
      });
      if (error) throw new Error(await edgeErrorMessage(error, FUNCTIONS.adminAction));
      const result = data as AdminActionResult | null;
      if (!result) throw new Error('The server returned no result. Nothing was changed.');
      if (!result.ok) throw new Error(result.message);
      return result;
    },
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['admin'] });
      void client.invalidateQueries({ queryKey: ['authority'] });
    },
  });
}

// ---------------------------------------------------------------------------
// Temporary passwords
//
// An administrator types a temporary password, then READS IT ALOUD or writes it
// on paper for somebody standing in front of them. Everything below is shaped
// by that single fact, which is why the alphabet is smaller than the keyboard
// and why nothing here keeps a copy.
// ---------------------------------------------------------------------------

/**
 * Characters deliberately NOT in a generated temporary password, each with the
 * pair it is confusable with. Exported so the test asserts the exclusion
 * against this table rather than against a second hard-coded list.
 *
 * Only VISUAL and HANDWRITTEN confusions are removed from the alphabet.
 * Spoken confusion — "d" against "t", "m" against "n" — cannot be fixed by
 * deleting characters, because almost every English letter name rhymes with
 * another one and an alphabet stripped of all of them has nothing left. It is
 * fixed instead by `spellTemporaryPassword`, which gives the administrator a
 * word per character to read out.
 *
 * There is NO UPPERCASE at all. "Capital" versus "small" is one more thing to
 * say, hear and get wrong on a phone, it doubles the number of visual
 * confusions, and it costs a shift keypress per character on a plant tablet.
 */
export const TEMPORARY_PASSWORD_EXCLUSIONS: Readonly<Record<string, string>> = {
  b: 'reads as 6 or 8',
  g: 'reads as 9, and as q',
  i: 'reads as 1, l or j',
  l: 'reads as 1 or i',
  o: 'reads as 0',
  q: 'reads as 9, and as g',
  s: 'reads as 5',
  v: 'written by hand, reads as u',
  z: 'reads as 2',
  '0': 'reads as o, and is said "oh"',
  '1': 'reads as l, i or 7',
};

/** The 25 characters a generated temporary password is drawn from. */
export const TEMPORARY_PASSWORD_ALPHABET = 'acdefhjkmnprtuwxy23456789';

/** Random characters per password, and how many per spoken group. */
export const TEMPORARY_PASSWORD_LENGTH = 12;
export const TEMPORARY_PASSWORD_GROUP = 4;

/** The one character in a generated password that is not in the alphabet. */
export const TEMPORARY_PASSWORD_SEPARATOR = '-';

/**
 * A word for each character, so a password can be read down a plant telephone.
 *
 * Letters use the NATO spelling alphabet, which is what a radio-trained or
 * aviation-trained listener already expects, and digits are spelled as words
 * because "five" and "nine" collide in noise where "fife" and "niner" do not.
 */
const SPOKEN: Readonly<Record<string, string>> = {
  a: 'alfa',
  c: 'charlie',
  d: 'delta',
  e: 'echo',
  f: 'foxtrot',
  h: 'hotel',
  j: 'juliett',
  k: 'kilo',
  m: 'mike',
  n: 'november',
  p: 'papa',
  r: 'romeo',
  t: 'tango',
  u: 'uniform',
  w: 'whiskey',
  x: 'x-ray',
  y: 'yankee',
  '2': 'two',
  '3': 'three',
  '4': 'four',
  '5': 'fife',
  '6': 'six',
  '7': 'seven',
  '8': 'eight',
  '9': 'niner',
  [TEMPORARY_PASSWORD_SEPARATOR]: 'dash',
};

/**
 * One temporary password, generated from the operating system's CSPRNG.
 *
 * `crypto.getRandomValues` and NOTHING ELSE. `Math.random` is seeded from
 * values an attacker can often reconstruct and is specified nowhere as
 * unpredictable; a password drawn from it is a password somebody else can
 * draw again. Where the API is absent the generator REFUSES rather than
 * degrading — the same choice `newIdempotencyKey` makes, and for a stronger
 * reason: a predictable idempotency key duplicates a record, a predictable
 * temporary password hands over an account. A plant tablet on a plain-http LAN
 * is an insecure context, where `crypto.randomUUID` is absent but
 * `getRandomValues` is not, so this depends only on the latter.
 *
 * REJECTION SAMPLED, not `byte % 25`. 256 is not a multiple of 25, so the
 * modulo of a uniform byte favours the first six characters of the alphabet by
 * 6/5. 250 is the largest multiple of 25 below 256, so bytes 250–255 are
 * discarded and every character is equally likely.
 *
 * STRENGTH. 25 characters, 12 draws: 25^12 ≈ 5.96 × 10^16, about 55.7 bits.
 * Grouped 4-4-4 by `TEMPORARY_PASSWORD_SEPARATOR`, which is part of the
 * password and must be typed; it is there because a 12-character run read
 * aloud loses its place and three groups of four does not.
 */
export function generateTemporaryPassword(): string {
  const source = globalThis.crypto;
  if (source === undefined || typeof source.getRandomValues !== 'function') {
    throw new Error(
      'This browser does not provide a secure random number generator, so no temporary ' +
        'password was generated. Type one yourself, long and unguessable, or open the ' +
        'application over https where the generator is available. Nothing was created.',
    );
  }

  const alphabet = TEMPORARY_PASSWORD_ALPHABET;
  const limit = Math.floor(256 / alphabet.length) * alphabet.length;
  const picked: string[] = [];
  // Drawn one block at a time rather than one byte at a time: a rejected byte
  // must be replaced, and asking for a fresh block is cheaper than a syscall
  // per character.
  while (picked.length < TEMPORARY_PASSWORD_LENGTH) {
    const bytes = source.getRandomValues(new Uint8Array(TEMPORARY_PASSWORD_LENGTH));
    for (const byte of bytes) {
      if (byte >= limit) continue;
      picked.push(alphabet[byte % alphabet.length]!);
      if (picked.length === TEMPORARY_PASSWORD_LENGTH) break;
    }
  }

  const groups: string[] = [];
  for (let at = 0; at < picked.length; at += TEMPORARY_PASSWORD_GROUP) {
    groups.push(picked.slice(at, at + TEMPORARY_PASSWORD_GROUP).join(''));
  }
  return groups.join(TEMPORARY_PASSWORD_SEPARATOR);
}

/**
 * A password as words to say out loud, e.g. `k3-mn` → "kilo, three, dash, mike,
 * november".
 *
 * A character with no spoken word — which only a hand-typed password can
 * contain — is returned quoted rather than dropped, because a readout missing a
 * character is a readout that fails at the keyboard with no clue why.
 */
export function spellTemporaryPassword(password: string): string {
  return [...password]
    .map((character) => SPOKEN[character] ?? `"${character}"`)
    .join(', ');
}

// ---------------------------------------------------------------------------
// Controlled lists
// ---------------------------------------------------------------------------

export interface ControlledValue {
  readonly id: string;
  readonly list_key: string;
  readonly value: string;
  readonly label: string;
  readonly active: boolean;
  readonly sort_order: number | null;
}

interface VocabularyRow {
  readonly code: string;
  readonly label: string;
  readonly active: boolean;
  readonly sort_order: number | null;
}

/**
 * The vocabulary is five tables of `(code, label, sort_order, active)`, not one
 * keyed table, so `list_key` is not a stored column — it is which table a row
 * came from. The literals below are the five values
 * `rpc_upsert_controlled_value` branches on, so a value the screen sends back
 * lands in the list it was read from; renaming one here would silently route an
 * edit to the wrong vocabulary. Listed alphabetically, which is the order the
 * screen's groups used to arrive in.
 */
const VOCABULARY_SOURCES = [
  {
    listKey: 'feed_types',
    read: () =>
      db
        .from('feed_types')
        .select('code,label,sort_order,active')
        .order('sort_order', { ascending: true, nullsFirst: false }),
  },
  {
    listKey: 'materials',
    read: () =>
      db
        .from('materials')
        .select('code,label,sort_order,active')
        .order('sort_order', { ascending: true, nullsFirst: false }),
  },
  {
    listKey: 'mill_screen_sizes',
    read: () =>
      db
        .from('mill_screen_sizes')
        .select('code,label,sort_order,active')
        .order('sort_order', { ascending: true, nullsFirst: false }),
  },
  {
    listKey: 'sampling_points',
    read: () =>
      db
        .from('sampling_points')
        .select('code,label,sort_order,active')
        .order('sort_order', { ascending: true, nullsFirst: false }),
  },
  {
    listKey: 'suppliers',
    read: () =>
      db
        .from('suppliers')
        .select('code,label,sort_order,active')
        .order('sort_order', { ascending: true, nullsFirst: false }),
  },
] as const;

export function useControlledValues() {
  return useQuery({
    queryKey: ['admin', 'controlled-values'],
    queryFn: async (): Promise<readonly ControlledValue[]> => {
      const responses = await Promise.all(VOCABULARY_SOURCES.map((source) => source.read()));
      const out: ControlledValue[] = [];
      responses.forEach((response, index) => {
        if (response.error) throw new Error(response.error.message);
        const { listKey } = VOCABULARY_SOURCES[index]!;
        for (const row of (response.data ?? []) as VocabularyRow[]) {
          out.push({
            // `code` is the key within its own table; the list it belongs to is
            // prefixed so one id stays unique across the five flattened here.
            id: `${listKey}:${row.code}`,
            list_key: listKey,
            value: row.code,
            label: row.label,
            active: row.active,
            sort_order: row.sort_order,
          });
        }
      });
      // An empty list is an answer: the screen says the matching field accepts
      // free text until the list is configured.
      return out;
    },
    staleTime: 60_000,
  });
}

// ---------------------------------------------------------------------------
// Sync health
// ---------------------------------------------------------------------------

export interface SyncJobRow {
  readonly id: string;
  readonly sample_uuid: string | null;
  readonly sample_id: string | null;
  readonly stage: Stage | null;
  readonly intended_tab: string | null;
  readonly payload_revision: number | null;
  readonly attempt_count: number;
  readonly state: string;
  readonly next_retry_at: string | null;
  readonly last_error: string | null;
  readonly last_confirmed_at: string | null;
  readonly reconciliation_status: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface SyncHealth {
  readonly jobs: readonly SyncJobRow[];
  readonly counts: Readonly<Record<string, number>>;
  /** Jobs that need a human: failed or dead-lettered. */
  readonly needsAttention: readonly SyncJobRow[];
}

interface SyncOutboxRow {
  readonly event_id: string;
  readonly sample_uuid: string | null;
  readonly target_tab: string | null;
  readonly payload_revision: number | null;
  readonly attempt_count: number;
  readonly state: string;
  readonly next_retry_at: string | null;
  readonly last_error: string | null;
  readonly confirmed_at: string | null;
  readonly reconciliation_status: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

interface SampleLabelRow {
  readonly id: string;
  readonly sample_id: string | null;
  readonly stage: Stage | null;
}

export function useSyncHealth() {
  return useQuery({
    queryKey: ['admin', 'sync-health'],
    queryFn: async (): Promise<SyncHealth> => {
      const { data, error } = await db
        .from(TABLES.syncOutbox)
        .select(
          'event_id,sample_uuid,target_tab,payload_revision,attempt_count,state,next_retry_at,last_error,confirmed_at,reconciliation_status,created_at,updated_at',
        )
        .order('updated_at', { ascending: false })
        .limit(200);
      if (error) throw new Error(await edgeErrorMessage(error, 'the service'));

      const rows = (data ?? []) as SyncOutboxRow[];

      // Neither the sample ID nor the stage is on the outbox — both live on
      // `samples`, reached by `sample_uuid`. This screen exists to tell an
      // administrator WHICH record is missing from the workbook, and the table
      // renders a missing `sample_id` as "Not linked to a sample", so dropping
      // the lookup would not blank the column, it would make it lie.
      const uuids = [
        ...new Set(rows.map((r) => r.sample_uuid).filter((v): v is string => v !== null)),
      ];
      const identified = new Map<string, SampleLabelRow>();
      for (const batch of batches(uuids)) {
        const res = await db.from(TABLES.samples).select('id,sample_id,stage').in('id', batch);
        if (res.error) throw new Error(res.error.message);
        for (const sample of (res.data ?? []) as SampleLabelRow[]) {
          identified.set(sample.id, sample);
        }
      }

      const jobs: SyncJobRow[] = rows.map((r) => {
        const sample = r.sample_uuid === null ? undefined : identified.get(r.sample_uuid);
        return {
          id: r.event_id,
          sample_uuid: r.sample_uuid,
          sample_id: sample?.sample_id ?? null,
          stage: sample?.stage ?? null,
          intended_tab: r.target_tab,
          payload_revision: r.payload_revision,
          attempt_count: r.attempt_count,
          state: r.state,
          next_retry_at: r.next_retry_at,
          last_error: r.last_error,
          last_confirmed_at: r.confirmed_at,
          reconciliation_status: r.reconciliation_status,
          created_at: r.created_at,
          updated_at: r.updated_at,
        };
      });
      const counts: Record<string, number> = {};
      for (const j of jobs) counts[j.state] = (counts[j.state] ?? 0) + 1;

      return {
        jobs,
        counts,
        needsAttention: jobs.filter((j) => j.state === 'failed' || j.state === 'dead_letter'),
      };
    },
    staleTime: 10_000,
  });
}

// ---------------------------------------------------------------------------
// Audit dead letters
//
// A failed audit write is caught deliberately in
// `_shared/adapters/authorize.ts`: a denial must not become a 500 just because
// the event could not be recorded. But a swallowed error with no consumer is
// indistinguishable from no error at all, and FR-002's acceptance criterion is
// that an unauthorised attempt receives a denial AND a logged event. The
// database now keeps the whole original event in `audit_event_dead_letters`
// rather than a counter, so the trail can be replayed once the cause is fixed.
//
// This hook is the human end of that path. Without it the rows accumulate
// where only a database query would find them, which is the same invisibility
// the dead-letter table was created to remove.
// ---------------------------------------------------------------------------

export interface AuditDeadLetterRow {
  readonly id: string;
  readonly received_at: string;
  readonly action: string;
  readonly subject_type: string;
  readonly subject_id: string | null;
  readonly outcome: string;
  readonly reason: string | null;
  /** 'rpc_error' = the database refused; 'threw' = it was never reached. */
  readonly failure_stage: string;
  readonly failure_detail: string;
  readonly state: string;
  readonly attempts: number;
  readonly last_error: string | null;
  readonly replayed_at: string | null;
}

export interface AuditDeadLetters {
  readonly rows: readonly AuditDeadLetterRow[];
  /** Still unrecovered. These are the ones that mean the trail has a gap. */
  readonly held: readonly AuditDeadLetterRow[];
  readonly oldestHeldAt: string | null;
}

export function useAuditDeadLetters() {
  return useQuery({
    queryKey: ['admin', 'audit-dead-letters'],
    queryFn: async (): Promise<AuditDeadLetters> => {
      const { data, error } = await db
        .from(TABLES.auditDeadLetters)
        .select(
          'id,received_at,action,subject_type,subject_id,outcome,reason,failure_stage,failure_detail,state,attempts,last_error,replayed_at',
        )
        .order('received_at', { ascending: false })
        .limit(200);
      if (error) throw new Error(await edgeErrorMessage(error, 'the service'));

      const rows = (data ?? []) as AuditDeadLetterRow[];
      const held = rows.filter((r) => r.state === 'held');
      // Ascending by received_at, so the last held row in a descending list is
      // the oldest one still outstanding.
      const oldestHeldAt = held.length > 0 ? held[held.length - 1]!.received_at : null;
      return { rows, held, oldestHeldAt };
    },
    staleTime: 10_000,
  });
}

/**
 * Retry one dead-lettered sync job.
 *
 * THE IDEMPOTENCY KEY IS NOT OPTIONAL ON THE WIRE, and this hook sent none.
 * `sync-action/index.ts` reasons from a key that never arrived — "`runMutation`
 * has already claimed the key, so pressing the button twice cannot queue the
 * same work twice" — but `runMutation` resolves the key and refuses the request
 * with `bad_request` before it authenticates anybody, so the real consequence
 * was not a double retry: it was that the retry button on the sync-health
 * screen did nothing at all, and a dead-lettered job was unrescuable through
 * the only interface that offers it.
 *
 * The key is generated per call, NOT derived from `jobId`. A job-derived key
 * would be permanent, so a legitimate second attempt on the same job — the
 * first retry having failed again — would replay the stale outcome and report
 * a success that did not happen. `SyncTab` disables the button for the job it
 * is retrying, which is where a double press belongs.
 */
export function useSyncRetry() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      jobId: string;
      /** Supplied only by a caller that must replay one specific attempt. */
      idempotencyKey?: string;
    }): Promise<AdminActionResult> => {
      const key = input.idempotencyKey ?? newIdempotencyKey();
      const { data, error } = await db.functions.invoke(FUNCTIONS.syncAction, {
        // Header first, body as the documented fallback for a proxy that
        // strips custom headers.
        body: { action: 'retry', jobId: input.jobId, idempotencyKey: key },
        headers: { 'Idempotency-Key': key },
      });
      if (error) throw new Error(await edgeErrorMessage(error, FUNCTIONS.syncAction));
      const result = data as AdminActionResult | null;
      if (!result) throw new Error('The server returned no result. The job was not retried.');
      if (!result.ok) throw new Error(result.message);
      return result;
    },
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['admin', 'sync-health'] });
      void client.invalidateQueries({ queryKey: ['samples'] });
    },
  });
}

// ---------------------------------------------------------------------------
// Schema verification
// ---------------------------------------------------------------------------

/** One tab's row-4 header check, as reported by the sync worker. */
export interface TabVerification {
  readonly stage: Stage;
  readonly sheetTab: string;
  readonly ok: boolean;
  readonly checkedAt: string | null;
  readonly mismatches: readonly HeaderMismatch[];
  readonly error: string | null;
}

export interface SchemaVerificationReport {
  readonly spreadsheetConfigured: boolean;
  readonly checkedAt: string | null;
  readonly tabs: readonly TabVerification[];
}

/**
 * Ask the privileged worker to compare the live row-4 headers against the
 * registry contract.
 *
 * The browser cannot do this itself: it holds no Google credential, by design.
 * When the worker is unreachable the panel still shows the EXPECTED contract
 * from the registry and says plainly that the live headers were not read —
 * never that they matched.
 */
export function useSchemaVerification() {
  return useQuery({
    queryKey: ['admin', 'schema-verification'],
    queryFn: async (): Promise<SchemaVerificationReport> => {
      const { data, error } = await db.functions.invoke(FUNCTIONS.schemaVerify, {
        body: { action: 'verify_headers' },
      });
      if (error) throw new Error(await edgeErrorMessage(error, FUNCTIONS.schemaVerify));
      const report = data as SchemaVerificationReport | null;
      if (!report) throw new Error('The verification service returned no result.');
      return report;
    },
    // A header check costs a Sheets API call; do not poll it.
    staleTime: 5 * 60_000,
    retry: false,
  });
}

/** The contract the app will enforce, available with no network at all. */
export function expectedHeaderContract(): readonly {
  stage: Stage;
  sheetTab: string;
  columnCount: number;
  headers: readonly string[];
}[] {
  return DASHBOARD_ORDER.map((schema) => ({
    stage: schema.stage,
    sheetTab: schema.sheetTab,
    columnCount: schema.columnCount,
    headers: expectedHeaders(schema.stage),
  }));
}

// ---------------------------------------------------------------------------
// Audit query
// ---------------------------------------------------------------------------

export interface AuditQuery {
  readonly actor: string;
  readonly action: string;
  /** Plant-local dates, inclusive. */
  readonly fromDate: string;
  readonly toDate: string;
}

export const EMPTY_AUDIT_QUERY: AuditQuery = { actor: '', action: '', fromDate: '', toDate: '' };

interface AuditEventDbRow {
  readonly event_uuid: string;
  readonly sample_uuid: string | null;
  readonly actor_id: string | null;
  readonly actor_email: string | null;
  readonly action: string;
  readonly reason: string | null;
  readonly before_payload: unknown;
  readonly after_payload: unknown;
  readonly occurred_at: string;
  readonly deployment_version: string | null;
}

export function useAuditEvents(query: AuditQuery, page: number, pageSize = 50) {
  return useQuery({
    queryKey: ['admin', 'audit', query, page],
    queryFn: async (): Promise<{ rows: readonly AuditEventRow[]; total: number }> => {
      let q = db
        .from(TABLES.auditEvents)
        .select(
          'event_uuid,sample_uuid,actor_id,actor_email,action,reason,before_payload,after_payload,occurred_at,deployment_version',
          { count: 'exact' },
        )
        .order('occurred_at', { ascending: false });

      const actor = query.actor.replace(/[,()*%\\]/g, ' ').trim();
      // The person filter searches the email, the only text identity the table
      // records. A search for a surname still matches most addresses, but a
      // display name that differs from the address will not be found here.
      if (actor) q = q.ilike('actor_email', `%${actor}%`);
      if (query.action) q = q.eq('action', query.action);
      // The filter dates are plant-local calendar days, but `occurred_at` is a
      // UTC instant, so the day is converted to its instant bounds. Comparing
      // a Guyana date against a UTC timestamp directly would shift every
      // boundary by four hours.
      if (query.fromDate) q = q.gte('occurred_at', plantDayStart(query.fromDate).toISOString());
      if (query.toDate) q = q.lt('occurred_at', plantDayEnd(query.toDate).toISOString());

      const from = page * pageSize;
      const { data, error, count } = await q.range(from, from + pageSize - 1);
      if (error) throw new Error(await edgeErrorMessage(error, 'the service'));

      const rows: AuditEventRow[] = ((data ?? []) as AuditEventDbRow[]).map((r) => ({
        id: r.event_uuid,
        sample_uuid: r.sample_uuid,
        actor_id: r.actor_id,
        // There is no actor_name column: the table keeps `actor_id` and
        // `actor_email`. The timeline prints this field as the person, and
        // renders null as "Actor not recorded" — which would be false, since
        // the actor IS recorded. So it carries the email, never a name built
        // from one.
        actor_name: r.actor_email,
        action: r.action,
        reason: r.reason,
        prior_values: r.before_payload,
        new_values: r.after_payload,
        occurred_at: r.occurred_at,
        app_version: r.deployment_version,
      }));
      return { rows, total: count ?? 0 };
    },
    staleTime: 10_000,
  });
}
