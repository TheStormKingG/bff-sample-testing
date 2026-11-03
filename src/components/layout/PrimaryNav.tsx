import { NavLink } from 'react-router-dom';

import { PRIMARY_NAV } from '@/components/layout/navItems';
import { useAccess } from '@/components/layout/accessContext';
import { cn } from '@/lib/cn';

/**
 * The bottom tab bar: the app's navigation, on every screen and every width.
 *
 * ===========================================================================
 * WHY THE BOTTOM, AND WHY THE SAME BAR EVERYWHERE
 * ===========================================================================
 * This is a phone held in one hand on a mill floor, often in a glove. The
 * bottom of the screen is the part of it a thumb reaches without regripping,
 * and it is the one piece of chrome that does not compete with the content
 * for the top of the viewport — which mattered enough that the home screen
 * used to delete the entire shell to win its height back.
 *
 * It renders identically at every width rather than becoming a top strip on
 * a desktop. Two layouts of the same navigation is two things to keep in
 * step, and the previous arrangement — a bar at the top on a tablet, a
 * "More" sheet on a phone — is exactly how a destination ends up reachable
 * on one and not the other. It was, for a while: an e2e check that secondary
 * navigation was reachable at all passed on a phone only because an
 * unrelated warning strip happened to link to one of the screens.
 *
 * ===========================================================================
 * WHAT IS OFFERED IS NOT WHAT IS ALLOWED
 * ===========================================================================
 * Items whose permission the signed-in person lacks are not rendered, so
 * nobody is invited to a screen that will refuse them. That is courtesy, not
 * security: `RequirePermission` is what actually guards the route, and the
 * server guards the data behind it. Home carries no permission at all —
 * gating the way out of every screen would strand somebody on one.
 */
export function PrimaryNav({ className }: { readonly className?: string }) {
  const { can } = useAccess();
  const items = PRIMARY_NAV.filter((item) => item.permission === null || can(item.permission));

  return (
    <nav
      aria-label="Main"
      className={cn(
        'no-print sticky bottom-0 z-30 border-t border-slate-200 bg-neu-base',
        // The home indicator on a modern iPhone sits over the bottom of the
        // viewport. Without this the last row of tap targets is under it.
        'pb-[env(safe-area-inset-bottom)]',
        className,
      )}
    >
      <ul className="mx-auto flex max-w-6xl items-stretch justify-around">
        {items.map((item) => (
          <li key={item.to} className="flex-1">
            <NavLink
              to={item.to}
              // `end` only on Home: every other route is a prefix of nothing,
              // but '/' is a prefix of all of them and would otherwise show
              // as the active tab on every screen in the app.
              end={item.to === '/'}
              className={({ isActive }) =>
                cn(
                  'flex min-h-tap flex-col items-center justify-center gap-0.5 px-1 py-2',
                  'text-xs font-semibold',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-700',
                  isActive ? 'text-blue-800' : 'text-slate-600',
                )
              }
            >
              {({ isActive }) => (
                <>
                  <item.icon
                    aria-hidden="true"
                    className={cn('h-6 w-6 shrink-0', isActive && 'text-blue-800')}
                  />
                  <span>{item.label}</span>
                  {/*
                    The active tab is named to a screen reader as well as
                    coloured. Colour alone is not a state anyone can hear,
                    and PRD section 11 forbids carrying meaning in it.
                  */}
                  {isActive ? <span className="sr-only">(current screen)</span> : null}
                </>
              )}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}
