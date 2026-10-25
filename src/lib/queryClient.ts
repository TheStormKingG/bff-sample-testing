/**
 * Shared TanStack Query client.
 *
 * Caching policy is deliberately conservative. Master Prompt section 9
 * requires "dependable caching/invalidation without showing stale quality
 * decisions as current", and PRD FR-015 requires that success is shown only
 * after a verified persistent write. So: nothing is served as fresh without a
 * refetch, and mutations are never retried automatically.
 */

import { QueryClient } from '@tanstack/react-query';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // A hold, a disposition or an assessment read from cache a minute later
      // may already be wrong. Always revalidate; keep the previous value only
      // to avoid a flash of empty UI while the refetch is in flight.
      staleTime: 0,
      gcTime: 5 * 60_000,
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
      retry: 2,
      retryDelay: (attempt) => Math.min(1_000 * 2 ** attempt, 8_000),
      // Plant connectivity drops. Fail fast and visibly rather than hanging.
      networkMode: 'online',
    },
    mutations: {
      /**
       * Never retry a write automatically. Every mutation in this system
       * carries a client-generated idempotency UUID (PRD section 10.3) and the
       * retry decision belongs to the caller, which must first ask the server
       * for the outcome of the original request. A blind retry here would be
       * indistinguishable from a second registration attempt.
       */
      retry: 0,
      networkMode: 'online',
    },
  },
});

/**
 * Time of the most recent write this browser session has seen succeed.
 *
 * The header shows this as the "last successful save" (PRD section 3.1). It is
 * derived from the mutation cache rather than from a timestamp column, so it
 * reports what this device actually observed and can never claim a save that
 * did not return successfully. It is deliberately session-scoped: `null` means
 * "no save observed yet", which the header renders as such instead of as a
 * reassuring but invented time.
 *
 * This is NOT the Google Sheets confirmation. Sheets sync state is per record
 * and is rendered by the `SyncStatus` component.
 */
let lastWriteAt: Date | null = null;
const listeners = new Set<() => void>();

queryClient.getMutationCache().subscribe((event) => {
  if (event.type !== 'updated') return;
  if (event.mutation.state.status !== 'success') return;
  lastWriteAt = new Date();
  for (const listener of listeners) listener();
});

export const lastSuccessfulWriteStore = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  /** Stable across notifications, so `useSyncExternalStore` will not loop. */
  getSnapshot(): Date | null {
    return lastWriteAt;
  },
};
