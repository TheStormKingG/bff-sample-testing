import { createContext, useContext } from 'react';
import type { Permission } from '@/lib/roles';
import type { Profile } from '@/hooks/useProfile';

/**
 * The approved profile of the person using the app, published once by the
 * shell so the header, the navigation and the route guards all answer "who is
 * this and what may they be offered?" from the same value.
 *
 * It is only ever populated for an `active` profile. A pending or suspended
 * account never reaches a provider, which is what keeps the pending gate from
 * being a cosmetic redirect.
 */
export interface AccessValue {
  readonly profile: Profile;
  /** UI affordance check. Not a security decision — see RequirePermission. */
  readonly can: (permission: Permission) => boolean;
  readonly reloadProfile: () => void;
}

export const AccessContext = createContext<AccessValue | null>(null);

export function useAccess(): AccessValue {
  const value = useContext(AccessContext);
  if (value === null) {
    throw new Error(
      'useAccess() was called outside the authenticated shell. A screen that ' +
        'needs the signed-in profile must render inside AppLayout.',
    );
  }
  return value;
}
