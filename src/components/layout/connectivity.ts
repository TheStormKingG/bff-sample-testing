import { useSyncExternalStore } from 'react';

/**
 * Browser connectivity, as a subscribable store.
 *
 * `navigator.onLine` is the only signal available to a static frontend and it
 * reports the network interface, not whether Supabase is reachable — so a
 * consumer may say "Online"/"Offline" and nothing stronger. A failed request
 * reports itself where it happens; this is only the ambient hint.
 *
 * Extracted from `Header` because the phone home screen hides the header and
 * still has to tell a sampler whether the plant's connection is up before
 * they walk out to the silo. One store, so the two cannot disagree.
 */
export const connectivityStore = {
  subscribe(listener: () => void): () => void {
    window.addEventListener('online', listener);
    window.addEventListener('offline', listener);
    return () => {
      window.removeEventListener('online', listener);
      window.removeEventListener('offline', listener);
    };
  },
  getSnapshot(): boolean {
    return navigator.onLine;
  },
};

export function useOnline(): boolean {
  return useSyncExternalStore(
    connectivityStore.subscribe,
    connectivityStore.getSnapshot,
    // Server snapshot: never rendered in this SPA, but required by the hook.
    () => true,
  );
}
