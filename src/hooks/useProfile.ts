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

const profileRowSchema = z.object({
  id: z.string(),
  email: z.string().nullish(),
  display_name: z.string().nullish(),
  status: z.string().nullish(),
});

const roleRowSchema = z.object({ role: z.string() });

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
    .select('id, email, display_name, status')
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

  return {
    id: row.id,
    email: row.email ?? authEmail,
    fullName: row.display_name ?? null,
    status: parseStatus(row.status),
    roles,
    provisional: false,
  };
}

export type ProfileState = 'checking' | 'active' | 'not_active' | 'error';

export interface UseProfileResult {
  readonly state: ProfileState;
  readonly profile: Profile | null;
  readonly authority: AuthorityContext | null;
  readonly isActive: boolean;
  readonly error: Error | null;
  readonly refetch: () => void;
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
  const refetch = useCallback(() => {
    void queryRefetch();
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
