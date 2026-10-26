/**
 * The signed-in user's app profile: approval status and role memberships.
 *
 * This hook decides what the UI OFFERS. It does not decide what the user may
 * do — RLS and the Edge Functions do, on every request, from `auth.uid()`.
 * Master Prompt section 4: all client-originating input is untrusted,
 * "including names, email, roles, IDs, review flags, threshold values and
 * purported session identity". So the rows read here are validated rather
 * than trusted, and every ambiguity resolves to less access, not more.
 */

import { useCallback, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { supabase } from '@/lib/supabase';
import {
  ROLES,
  USER_STATUSES,
  can as hasPermission,
  type AuthorityContext,
  type Permission,
  type Role,
  type UserStatus,
} from '@/lib/roles';

/**
 * Cross-slice contract. These are the ledger tables and columns this hook
 * reads; the Supabase migrations own their definition. Named here once so a
 * rename is a single edit rather than a hunt through component code
 * (PRD NFR-006).
 */
const PROFILES_TABLE = 'profiles';
const USER_ROLES_TABLE = 'user_roles';

/**
 * The columns read from `profiles`.
 *
 * Written inline at the `.select()` call site as a literal, because
 * `scripts/check-frontend-schema.py` resolves a bare constant as well as a
 * literal but supabase-js's type-level parser only reads a literal — see the
 * note on `SAMPLE_COLUMNS` in `useSamples.ts` for what happens when a select
 * list is widened to `string`.
 *
 * `password_set_by_admin_at` and `password_changed_at` arrive from migration
 * 0019. Both are readable by `authenticated`: the `profiles_select_self`
 * policy is `id = auth.uid()` with no status condition, so an account that
 * owes a forced password change can still read its own two timestamps — which
 * is what makes the redirect below possible at all. Neither column is a
 * credential; they are instants.
 */
const profileRowSchema = z.object({
  id: z.string(),
  email: z.string().nullish(),
  display_name: z.string().nullish(),
  status: z.string().nullish(),
  password_set_by_admin_at: z.string().nullish(),
  password_changed_at: z.string().nullish(),
});

const roleRowSchema = z.object({ role: z.string() });

/**
 * Is a forced password change outstanding for this account?
 *
 * THIS IS A COPY OF A SERVER RULE, AND IT IS NOT THE ENFORCEMENT. The
 * authority is `public.must_change_password(uuid)` in migration 0019, read by
 * `public.require_permission` on the RPC and Edge Function route and — since
 * migration 0020 — by `public.is_active_user()` and `public.has_permission()`
 * on the row-level-security route. Both are needed: before 0020 the policies
 * never consulted the credential, so the permission was withheld from the
 * Edge Functions and granted by PostgREST. That function is granted to
 * `service_role` only, so the
 * browser cannot call it and has to compute the same predicate from the two
 * timestamps it can read. The one thing this copy must never do is answer
 * `false` where the server answers `true`: that combination is an app that
 * offers its screens and is refused on every request, with no route to the
 * fix. So every uncertainty here resolves to `true`.
 *
 * The rule, verbatim from the contract: outstanding when
 * `password_set_by_admin_at` is not null AND (`password_changed_at` is null OR
 * `password_changed_at <= password_set_by_admin_at`).
 *
 * `<=`, not `<`, matching the SQL. A tie — the two instants equal to the
 * microsecond — means still outstanding. The asymmetry is the reason: with
 * `<=` a tie costs one extra screen, with `<` a tie silently clears a reset
 * that never happened.
 *
 * The timestamps are compared as INSTANTS, not as strings. PostgREST renders
 * `timestamptz` with a variable fractional part and a UTC offset
 * (`2026-10-26T12:00:00.123456+00:00`), so lexical order is not time order
 * once two values differ in precision or offset.
 */
export function isPasswordChangeOutstanding(
  passwordSetByAdminAt: string | null,
  passwordChangedAt: string | null,
): boolean {
  if (passwordSetByAdminAt === null) return false;
  if (passwordChangedAt === null) return true;

  const setAt = Date.parse(passwordSetByAdminAt);
  const changedAt = Date.parse(passwordChangedAt);
  // An unparseable instant is not evidence that the change has happened.
  if (Number.isNaN(setAt) || Number.isNaN(changedAt)) return true;

  return changedAt <= setAt;
}

export interface Profile {
  readonly id: string;
  readonly email: string | null;
  readonly fullName: string | null;
  readonly status: UserStatus;
  readonly roles: readonly Role[];
  /**
   * True when no readable profile row exists for this identity. A brand new
   * Google sign-in looks exactly like this, and so does an identity RLS
   * refuses to show — both are handled identically, as `pending`.
   */
  readonly provisional: boolean;
  /** When an administrator last set this account a password. Null means never. */
  readonly passwordSetByAdminAt: string | null;
  /** When the holder last set their own password. Null means never. */
  readonly passwordChangedAt: string | null;
  /**
   * True while the account is still using a password an administrator typed.
   *
   * Derived from the two timestamps above by `isPasswordChangeOutstanding`.
   * It decides where the router sends this person; it does not decide what
   * they may do — `public.require_permission` already withheld every
   * permission before the UI was asked.
   */
  readonly mustChangePassword: boolean;
}

function parseStatus(raw: string | null | undefined): UserStatus {
  const match = USER_STATUSES.find((s) => s === raw);
  // Fail closed. An unrecognised status is never read as `active`: a typo or a
  // future status value must not hand somebody the application (FR-001).
  return match ?? 'pending';
}

function parseRoles(rows: readonly { role: string }[]): Role[] {
  const seen = new Set<Role>();
  for (const row of rows) {
    const match = ROLES.find((r) => r === row.role);
    if (match !== undefined) seen.add(match);
  }
  return [...seen];
}

async function fetchProfile(userId: string, authEmail: string | null): Promise<Profile> {
  const { data, error } = await supabase
    .from(PROFILES_TABLE)
    .select(
      'id, email, display_name, status, password_set_by_admin_at, password_changed_at',
    )
    .eq('id', userId)
    .maybeSingle();

  if (error !== null) {
    throw new Error(`Could not read your access profile: ${error.message}`);
  }

  // `maybeSingle()` returns no row both for "not created yet" and for "RLS
  // will not show it to you". Neither grants access, so neither needs to be
  // distinguished here.
  if (data === null) {
    return {
      id: userId,
      email: authEmail,
      fullName: null,
      status: 'pending',
      roles: [],
      provisional: true,
      // No readable row means no administrator-set password is recorded. The
      // account is `pending` either way, so it is sent to the pending screen
      // and not to the password screen.
      passwordSetByAdminAt: null,
      passwordChangedAt: null,
      mustChangePassword: false,
    };
  }

  const row = profileRowSchema.parse(data);

  const { data: roleData, error: roleError } = await supabase
    .from(USER_ROLES_TABLE)
    .select('role')
    .eq('user_id', userId);

  if (roleError !== null) {
    throw new Error(`Could not read your role assignments: ${roleError.message}`);
  }

  const roles = parseRoles(z.array(roleRowSchema).parse(roleData ?? []));

  const passwordSetByAdminAt = row.password_set_by_admin_at ?? null;
  const passwordChangedAt = row.password_changed_at ?? null;

  return {
    id: row.id,
    email: row.email ?? authEmail,
    fullName: row.display_name ?? null,
    status: parseStatus(row.status),
    roles,
    provisional: false,
    passwordSetByAdminAt,
    passwordChangedAt,
    mustChangePassword: isPasswordChangeOutstanding(passwordSetByAdminAt, passwordChangedAt),
  };
}

export type ProfileState = 'checking' | 'active' | 'not_active' | 'error';

export interface UseProfileResult {
  readonly state: ProfileState;
  readonly profile: Profile | null;
  readonly authority: AuthorityContext | null;
  readonly isActive: boolean;
  readonly error: Error | null;
  /**
   * Re-read the profile. RESOLVES WHEN THE READ HAS LANDED.
   *
   * It returns a promise because at least one caller must not act until the
   * new answer is in: the change-password screen navigates away only once the
   * obligation it was gating on is known to be discharged. Firing and
   * forgetting sent it to `/` while the stale profile still said a change was
   * outstanding, and the router bounced it straight back to the form — a
   * password that had in fact been saved, presented as if it had not.
   */
  readonly refetch: () => Promise<void>;
  /** UI affordance check only. Never a security decision. */
  readonly can: (permission: Permission) => boolean;
}

export function useProfile(
  userId: string | null,
  authEmail: string | null,
): UseProfileResult {
  const query = useQuery({
    queryKey: ['profile', userId],
    queryFn: async () => {
      // Never reachable while `enabled` is false; asserted rather than cast so a
      // future change to the gate fails loudly instead of passing `null` through.
      if (userId === null) throw new Error('No signed-in identity to load a profile for.');
      return fetchProfile(userId, authEmail);
    },
    enabled: userId !== null,
    // Access can be revoked while a tablet sits open on the shop floor; a
    // revoked profile must stop offering actions on the next focus.
    staleTime: 0,
    retry: 1,
  });

  const profile = query.data ?? null;

  /**
   * Recorded delegations are deliberately NOT read here.
   *
   * `can()` accepts them, and a Quality Officer with a recorded disposition
   * delegation does hold that authority — but the delegation table is part of
   * the ledger slice and the server is where the decision is made anyway.
   * Reading it client-side would only widen what the UI offers; omitting it
   * can at worst hide a control from somebody who is entitled to it, which is
   * the safe direction to be wrong in. `RequirePermission` therefore explains
   * a refusal rather than pretending the route does not exist.
   */
  const authority = useMemo<AuthorityContext | null>(
    () =>
      profile === null
        ? null
        : { userId: profile.id, roles: profile.roles, status: profile.status },
    [profile],
  );

  const can = useCallback(
    (permission: Permission) => (authority === null ? false : hasPermission(authority, permission)),
    [authority],
  );

  const queryRefetch = query.refetch;
  const refetch = useCallback(async () => {
    await queryRefetch();
  }, [queryRefetch]);

  const state: ProfileState =
    userId === null
      ? 'checking'
      : query.isError
        ? 'error'
        : profile === null
          ? 'checking'
          : profile.status === 'active'
            ? 'active'
            : 'not_active';

  return {
    state,
    profile,
    authority,
    isActive: state === 'active',
    error: query.error instanceof Error ? query.error : null,
    refetch,
    can,
  };
}
