import { Outlet, useMatch } from 'react-router-dom';
import { env } from '@/lib/env';
import { cn } from '@/lib/cn';
import { Header } from '@/components/layout/Header';
import { PrimaryNav } from '@/components/layout/PrimaryNav';
import { useIsPhone } from '@/components/layout/viewport';

/**
 * The authenticated shell: header, page, bottom navigation, footer.
 *
 * Only reached once the signed-in profile is known to be `active` — the gate
 * lives in `App.tsx`, before this renders, so no screen inside here has to
 * think about a pending account.
 *
 * ===========================================================================
 * THE SHELL IS THE SAME ON EVERY ROUTE NOW, WITH ONE EXCEPTION
 * ===========================================================================
 * It used to have two. The home route on a phone deleted the header, the
 * navigation and the footer outright, because the old chrome cost roughly
 * 380px of an 812px screen and eight finger-sized tiles could not survive
 * that. The navigation has since moved to a bottom bar about 58px tall, so
 * the arithmetic that forced the exception is gone and the home screen keeps
 * its chrome like everything else. One shell, one set of rules.
 *
 * The exception that remains is a stage form on a phone, and it is the same
 * one as before. Measured on 375x812: header 153px, nav 57px, title block
 * 76px and the "Before you start" panel 172px put the FIRST FIELD at 683px,
 * with a 121px action bar under it — 804 of 812 pixels spent before the
 * operator could use anything. The one screen whose entire purpose is typing
 * a value showed no value to type into. So while a form is open on a phone
 * the identity block goes compact and the footer goes.
 *
 * THE BOTTOM BAR STAYS EVEN THERE. Removing it was the obvious saving and it
 * is the wrong one: an operator part-way through a form who wants out should
 * not have to find a back gesture, and a form that traps you is worse than a
 * form that starts 58px lower. The draft is kept on navigation anyway.
 */
export function AppLayout() {
  const isPhone = useIsPhone();
  const onStageRoute = useMatch({ path: '/stage/:stage' }) !== null;
  const onPhoneForm = isPhone && onStageRoute;

  return (
    <div
      className={cn(
        /*
          THE TINTED BASE IS WHAT MAKES NEUMORPHISM POSSIBLE AT ALL. On pure
          #FFFFFF the light-side shadow has nothing to sit against and every
          raised surface collapses into a flat card with a grey drop shadow.

          `neu-base` is #F1F4F8: measured light enough to read as white on a
          phone in daylight, tinted just enough for the effect to exist.

          `app-shell` exists for one reason: the print stylesheet has to be
          able to take the tint back off.
        */
        'app-shell flex min-h-screen flex-col bg-neu-base',
        // `100dvh`, not `100vh`: on mobile Safari `100vh` is the viewport
        // WITHOUT the collapsing toolbar, so the page is taller than what is
        // on screen and scrolls by the toolbar's height.
        'min-h-[100dvh]',
      )}
    >
      <a href="#main-content" className="skip-link no-print">
        Skip to the main content
      </a>

      <div className="no-print">
        <Header compact={onPhoneForm || isPhone} />
      </div>

      <main
        id="main-content"
        tabIndex={-1}
        className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6"
      >
        <Outlet />
      </main>

      {!onPhoneForm && (
        <footer className="no-print border-t border-slate-200 bg-slate-50">
          <div className="mx-auto flex max-w-6xl flex-col gap-1 px-4 py-3 text-xs text-slate-600 sm:flex-row sm:items-center sm:justify-between sm:px-6 sm:text-sm">
            <p>Bounty Farm Limited — Feed Factory quality records</p>
            {/*
              The deployment identifier, so a record on screen can be traced
              to the build that produced it (PRD NFR-005/NFR-006). It is the
              reason this footer survives on a phone at all: the only other
              place it appears is the sign-in screen, which a signed-in
              person cannot get back to, and the Admin page, which an
              operator may not open.
            */}
            <p className="tabular">
              <span className="text-slate-600">Version </span>
              {env.VITE_APP_VERSION}
            </p>
          </div>
        </footer>
      )}

      <PrimaryNav />
    </div>
  );
}
