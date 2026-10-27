import { useCallback, useSyncExternalStore } from 'react';
import { Link } from 'react-router-dom';
import { CloudOff, LogOut, Wifi, WifiOff } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { StatusChip } from '@/components/ui/StatusChip';
import { ROLE_LABELS } from '@/lib/roles';
import { signOut } from '@/lib/supabase';
import { lastSuccessfulWriteStore } from '@/lib/queryClient';
import { cn } from '@/lib/cn';
import { formatPlantDateTimeLabelled } from '@/lib/time';
import { useAccess } from '@/components/layout/accessContext';
import { useOnline } from '@/components/layout/connectivity';

export interface HeaderProps {
  /**
   * Drop the identity block — name, role, connection and save state.
   *
   * Used on a phone while a form is open. Measured on a 375x812 phone: the
   * full header is 153px, the secondary nav another 57px, and with the title
   * block and the "Before you start" panel the FIRST FIELD began at 683px of
   * an 812px screen — with a 121px action bar below it. The operator could
   * not see a single field without scrolling, on the one screen whose whole
   * job is entering a field.
   *
   * Nothing is lost that the person needs mid-form: they know who they are,
   * and the save state is reported by the action bar at the moment it
   * changes. The full header returns the moment the form is closed, and at
   * `sm` and wider it never changes at all.
   */
  readonly compact?: boolean;
}

export function Header({ compact = false }: HeaderProps = {}) {
  const { profile } = useAccess();
  const online = useOnline();
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
            /*
              `truncate` rather than wrap. At 320px — the narrowest phone this
              app is likely to meet — the brand broke onto two lines and took
              the header with it. The brand may be clipped because the page's
              own title sits directly below it and says where you are; a
              CONTROL's label may not be clipped, which is why Sign out beside
              it keeps its full width and this gives way first.
            */
            className="min-w-0 truncate rounded text-lg font-bold tracking-tight text-bff-800 sm:text-2xl"
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

        <div
          className={cn(
            'flex flex-wrap items-center gap-x-4 gap-y-2 text-sm',
            compact && 'hidden sm:flex',
          )}
        >
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
