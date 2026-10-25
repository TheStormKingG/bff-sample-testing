import { Outlet } from 'react-router-dom';
import { env } from '@/lib/env';
import { Header } from '@/components/layout/Header';
import { SecondaryNav } from '@/components/layout/SecondaryNav';

/**
 * The authenticated shell: header, record navigation, page, footer.
 *
 * Only reached once the signed-in profile is known to be `active` — the gate
 * lives in `App.tsx`, before this renders, so no screen inside here has to
 * think about a pending account.
 */
export function AppLayout() {
  return (
    <div className="flex min-h-screen flex-col bg-white">
      <a href="#main-content" className="skip-link no-print">
        Skip to the main content
      </a>

      <div className="no-print">
        <Header />
        <SecondaryNav variant="bar" className="border-b border-slate-200" />
      </div>

      <main id="main-content" tabIndex={-1} className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6">
        <Outlet />
      </main>

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
    </div>
  );
}
