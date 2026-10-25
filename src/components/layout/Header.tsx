import { useCallback, useSyncExternalStore } from 'react';
import { Link } from 'react-router-dom';
import { CloudOff, LogOut, Wifi, WifiOff } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { StatusChip } from '@/components/ui/StatusChip';
import { ROLE_LABELS } from '@/lib/roles';
import { signOut } from '@/lib/supabase';
import { lastSuccessfulWriteStore } from '@/lib/queryClient';
import { formatPlantDateTimeLabelled } from '@/lib/time';
import { useAccess } from '@/components/layout/accessContext';

/**
 * Browser connectivity, as a subscribable store.
 *
 * `navigator.onLine` is the only signal available to a static frontend and it
 * reports the network interface, not whether Supabase is reachable — so the
 * chip says "Online"/"Offline" and nothing stronger. A failed request reports
 * itself where it happens; this is only the ambient hint.
 */
const connectivityStore = {
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

export function Header() {
  const { profile } = useAccess();
  const online = useSyncExternalStore(
    connectivityStore.subscribe,
    connectivityStore.getSnapshot,
    // Server snapshot: never rendered here, but required by the hook.
    () => true,
  );
  const lastWriteAt = useSyncExternalStore(
    lastSuccessfulWriteStore.subscribe,
    lastSuccessfulWriteStore.getSnapshot,
    () => null,
  );

  const handleSignOut = useCallback(() => {
    void signOut();
  }, []);

  const roleText =
    profile.roles.length === 0
      ? 'Awaiting role assignment'
      : profile.roles.map((role) => ROLE_LABELS[role]).join(', ');

  return (
    <header className="border-b border-slate-200 bg-white">
      <div className="mx-auto flex max-w-6xl flex-col gap-3 px-4 py-3 sm:px-6 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex items-center justify-between gap-3">
          <Link
            to="/"
            className="rounded text-xl font-bold tracking-tight text-bff-800 sm:text-2xl"
          >
            BFF Sample Testing
          </Link>
          <Button
            variant="ghost"
            onClick={handleSignOut}
            leadingIcon={<LogOut aria-hidden="true" className="h-5 w-5" />}
            className="lg:hidden"
          >
            Sign out
          </Button>
        </div>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
          <div className="min-w-0">
            <p className="truncate font-semibold text-slate-900">
              {profile.fullName ?? profile.email ?? 'Signed in'}
            </p>
            <p className="truncate text-slate-600">{roleText}</p>
          </div>

          <StatusChip
            label={online ? 'Online' : 'Offline'}
            tone={online ? 'success' : 'danger'}
            icon={online ? Wifi : WifiOff}
            srPrefix="Connection:"
            size="sm"
          />

          {/*
            The last save this device actually saw succeed. When nothing has
            been saved yet it says so — FR-015 and PRD section 12 both forbid
            standing in a reassuring but invented timestamp.
          */}
          {lastWriteAt === null ? (
            <StatusChip
              label="No save yet in this session"
              tone="neutral"
              icon={CloudOff}
              size="sm"
            />
          ) : (
            <p className="text-slate-600">
              <span className="text-slate-500">Last successful save: </span>
              <span className="font-medium text-slate-800">
                {formatPlantDateTimeLabelled(lastWriteAt)}
              </span>
            </p>
          )}

          <Button
            variant="secondary"
            onClick={handleSignOut}
            leadingIcon={<LogOut aria-hidden="true" className="h-5 w-5" />}
            className="hidden lg:inline-flex"
          >
            Sign out
          </Button>
        </div>
      </div>
    </header>
  );
}
