import { useSyncExternalStore } from 'react';
import { NavLink } from 'react-router-dom';
import { ChevronRight, LogOut } from 'lucide-react';
import { Dialog } from '@/components/ui/Dialog';
import { Button } from '@/components/ui/Button';
import { SECONDARY_NAV } from '@/components/layout/navItems';
import { useAccess } from '@/components/layout/accessContext';
import { ROLE_LABELS } from '@/lib/roles';
import { signOut } from '@/lib/supabase';
import { lastSuccessfulWriteStore } from '@/lib/queryClient';
import { formatPlantDateTimeLabelled } from '@/lib/time';

/** A count to show beside the queue it belongs to, or an honest dash. */
export interface QueueCount {
  readonly route: string;
  readonly value: number | undefined;
}

export interface MoreSheetProps {
  readonly open: boolean;
  readonly onClose: () => void;
  /**
   * Per-queue figures, keyed by route. These are the numbers the wide
   * dashboard shows under "Needs attention"; on a phone they live here
   * because the home screen's one job is "which test am I doing".
   *
   * They are deliberately NOT summed into a single badge: awaiting-results,
   * ready-for-review and on-hold are three different kinds of work, and one
   * number over all three would be an aggregate across segments that are not
   * comparable.
   */
  readonly queueCounts: readonly QueueCount[];
}

/**
 * Everything that is not one of the seven forms.
 *
 * Reuses the app's `Dialog`, which already renders as a bottom sheet on a
 * phone and gets the parts that are easy to get wrong right: focus moves in,
 * Tab is trapped, Escape closes, focus returns to the 'More' tile, and the
 * grid behind cannot be scrolled away under a thumb.
 *
 * The rows are the same `SECONDARY_NAV` table the wide layout uses, filtered
 * by the same permission check, so nothing can be offered here that is hidden
 * there. The identity and session controls follow, because hiding the header
 * on the phone home screen would otherwise take sign-out with it.
 */
export function MoreSheet({ open, onClose, queueCounts }: MoreSheetProps) {
  const { profile, can } = useAccess();
  const items = SECONDARY_NAV.filter((item) => can(item.permission));

  const lastWriteAt = useSyncExternalStore(
    lastSuccessfulWriteStore.subscribe,
    lastSuccessfulWriteStore.getSnapshot,
    () => null,
  );

  const roleText =
    profile.roles.length === 0
      ? 'Awaiting role assignment'
      : profile.roles.map((role) => ROLE_LABELS[role]).join(', ');

  const countFor = (route: string): QueueCount | undefined =>
    queueCounts.find((count) => count.route === route);

  return (
    <Dialog open={open} onClose={onClose} title="Records and administration">
      <p className="-mt-1 text-sm text-slate-600">
        These are places to look records up. They are not testing forms.
      </p>

      {items.length === 0 ? (
        <p className="mt-4 text-base text-slate-700">
          Your role does not currently open any of these. An administrator can change that.
        </p>
      ) : (
        <ul className="mt-4 space-y-2">
          {items.map((item) => {
            const count = countFor(item.to);
            return (
              <li key={item.to}>
                <NavLink
                  to={item.to}
                  onClick={onClose}
                  className="flex min-h-tap items-center gap-3 rounded-xl border border-slate-200 bg-white px-3 py-3 hover:border-bff-300 hover:bg-bff-50"
                >
                  <item.icon aria-hidden="true" className="h-5 w-5 shrink-0 text-slate-600" />
                  <span className="min-w-0 flex-1">
                    <span className="block font-semibold text-slate-900">{item.label}</span>
                    <span className="block text-sm text-slate-600">{item.description}</span>
                  </span>
                  {count !== undefined &&
                    (count.value === undefined ? (
                      <span className="shrink-0 text-lg font-bold text-slate-900">
                        <span aria-hidden="true">—</span>
                        <span className="sr-only">Count not available</span>
                      </span>
                    ) : (
                      <span className="shrink-0 text-lg font-bold tabular text-slate-900">
                        {count.value}
                        <span className="sr-only"> samples</span>
                      </span>
                    ))}
                  <ChevronRight aria-hidden="true" className="h-5 w-5 shrink-0 text-slate-600" />
                </NavLink>
              </li>
            );
          })}
        </ul>
      )}

      <div className="mt-5 border-t border-slate-200 pt-4">
        <p className="font-semibold text-slate-900">
          {profile.fullName ?? profile.email ?? 'Signed in'}
        </p>
        <p className="text-sm text-slate-600">{roleText}</p>
        {/* FR-015: never stand in a reassuring but invented timestamp. */}
        <p className="mt-2 text-sm text-slate-600">
          {lastWriteAt === null ? (
            'No save yet in this session'
          ) : (
            <>
              <span>Last successful save: </span>
              <span className="font-medium text-slate-800">
                {formatPlantDateTimeLabelled(lastWriteAt)}
              </span>
            </>
          )}
        </p>

        <Button
          variant="secondary"
          onClick={() => void signOut()}
          leadingIcon={<LogOut aria-hidden="true" className="h-5 w-5" />}
          className="mt-4 w-full justify-center"
        >
          Sign out
        </Button>
      </div>
    </Dialog>
  );
}
