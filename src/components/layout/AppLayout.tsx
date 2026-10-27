import { Outlet, useMatch } from 'react-router-dom';
import { env } from '@/lib/env';
import { cn } from '@/lib/cn';
import { Header } from '@/components/layout/Header';
import { SecondaryNav } from '@/components/layout/SecondaryNav';
import { useIsPhone } from '@/components/layout/viewport';

/**
 * The authenticated shell: header, record navigation, page, footer.
 *
 * Only reached once the signed-in profile is known to be `active` — the gate
 * lives in `App.tsx`, before this renders, so no screen inside here has to
 * think about a pending account.
 *
 * ONE EXCEPTION TO THE SHELL, and it is narrow by construction: on the home
 * route, on a phone, the header, the navigation strip and the footer are not
 * rendered. The home screen is eight tiles that must all be reachable without
 * scrolling (see `HomeScreen`), and the shell's chrome measures roughly 380px
 * of a 812px screen — there is no arrangement of eight finger-sized targets
 * that survives that. What the chrome carried is not lost: connectivity and
 * the counting date are in the home screen's own top strip, and identity,
 * role, last-successful-save and Sign out are inside its 'More' sheet.
 *
 * The condition is route AND width, both narrow:
 *   - `useMatch('/')` with `end: true`, so only the index route is affected
 *     and every other screen in the app renders exactly as before;
 *   - `useIsPhone()`, the same breakpoint check the dashboard uses to choose
 *     its layout, so the shell and the page can never disagree about which
 *     one is on screen. (A CSS-only `hidden sm:block` here would be fine on
 *     its own, but the page's choice cannot be made in CSS — see
 *     `useIsPhone` — and two mechanisms reading one breakpoint is how they
 *     end up out of step.)
 * Nothing here changes any other page at any width.
 */
export function AppLayout() {
  // Both hooks run unconditionally; only their COMBINATION is conditional.
  const isPhone = useIsPhone();
  const onHomeRoute = useMatch({ path: '/', end: true }) !== null;
  const onPhoneHome = isPhone && onHomeRoute;
  /**
   * A stage form on a phone gets a compact shell.
   *
   * Measured on 375x812 before this: header 153px, secondary nav 57px, title
   * block 76px and the "Before you start" panel 172px put the FIRST FIELD at
   * 683px, with a 121px action bar under it — 804 of 812 pixels spent before
   * the operator could use anything. The one screen whose entire purpose is
   * typing a value showed no value to type into.
   *
   * So on a phone, while a form is open: the identity block goes (the action
   * bar reports save state when it changes), the secondary nav goes
   * (navigating away mid-form is not what that bar is for), and the page
   * footer goes (a build identifier is not worth a field). None of this
   * applies at `sm` and wider, and none of it applies once the form closes.
   */
  const onStageRoute = useMatch({ path: '/stage/:stage' }) !== null;
  const onPhoneForm = isPhone && onStageRoute;

  return (
    <div
      className={cn(
        'flex min-h-screen flex-col bg-white',
        // `100dvh`, not `100vh`: on mobile Safari `100vh` is the viewport
        // WITHOUT the collapsing toolbar, so a `min-h-screen` page is taller
        // than what is on screen and scrolls by the toolbar's height — which
        // would break the no-scroll promise on the one browser most likely to
        // be holding it.
        onPhoneHome && 'min-h-[100dvh] bg-neu-base',
      )}
    >
      <a href="#main-content" className="skip-link no-print">
        Skip to the main content
      </a>

      {!onPhoneHome && (
        <div className="no-print">
          <Header compact={onPhoneForm} />
          {!onPhoneForm && (
            <SecondaryNav variant="bar" className="border-b border-slate-200" />
          )}
        </div>
      )}

      <main
        id="main-content"
        tabIndex={-1}
        className={cn(
          'mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6',
          onPhoneHome && 'px-0 py-0',
        )}
      >
        <Outlet />
      </main>

      {!onPhoneHome && !onPhoneForm && (
        <footer className="no-print border-t border-slate-200 bg-slate-50">
          <div className="mx-auto flex max-w-6xl flex-col gap-1 px-4 py-4 text-sm text-slate-600 sm:flex-row sm:items-center sm:justify-between sm:px-6">
            <p>Bounty Farm Limited — Feed Factory quality records</p>
            {/* The deployment identifier, so a record on screen can be traced to
              the build that produced it (PRD NFR-005/NFR-006). */}
            <p className="tabular">
              <span className="text-slate-500">Version </span>
              {env.VITE_APP_VERSION}
            </p>
          </div>
        </footer>
      )}
    </div>
  );
}
