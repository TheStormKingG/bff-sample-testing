/**
 * Routing and the authentication gate.
 *
 * ===========================================================================
 * WHY HashRouter, AND WHY THAT DECIDES THE OAUTH FLOW
 * ===========================================================================
 *
 * This app is served by GitHub Pages from a repository subpath, e.g.
 * `https://OWNER.github.io/REPO/`. Pages is a plain static file server: it has
 * no rewrite rule, so a request for `/REPO/samples/abc` looks for a FILE at
 * that path, finds none and returns its 404 page. With BrowserRouter every
 * refresh of a deep link and every bookmark would break. HashRouter keeps the
 * whole route in the fragment — `/REPO/#/samples/abc` — and the server only
 * ever sees `/REPO/`, which always exists. Master Prompt section 1 requires a
 * "GitHub Pages-safe routing strategy" for exactly this reason.
 *
 * The consequence is that THE FRAGMENT IS NOW THE PAGE ADDRESS, and that rules
 * out the OAuth implicit flow. Implicit returns the session in the fragment
 * (`#access_token=...`), which is the same slot the router owns: the router
 * reads it as the route `/access_token=...`, and whichever of the two rewrites
 * the fragment first destroys the other's data. So `src/lib/supabase.ts` sets
 * `flowType: 'pkce'`, which returns `?code=...` in the query string instead —
 * a part of the URL the router never touches. supabase-js exchanges the code
 * during client construction (synchronously reading `window.location.href`,
 * before any React effect can interfere) and then deletes only the `code`
 * parameter, leaving the fragment intact.
 *
 * Two things therefore have to stay true:
 *   1. The Supabase redirect URL is the app ROOT with no `#/...` route, and
 *      both `http://localhost:5173/` and `https://OWNER.github.io/REPO/` are
 *      on the Supabase Auth redirect allowlist.
 *   2. Nothing in the app may link using a bare `#id` fragment anchor, because
 *      that is a route change. `ErrorSummary` moves focus with `focus()` for
 *      this reason.
 *
 * `useSession` additionally detects a fragment that arrives carrying
 * `access_token` and reports it, so if the project is ever switched back to
 * implicit the failure is a message rather than a button that does nothing.
 * ===========================================================================
 */

import { QueryClientProvider } from '@tanstack/react-query';
import { HashRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AlertTriangle } from 'lucide-react';

import { queryClient } from '@/lib/queryClient';
import { useSession } from '@/hooks/useSession';
import { useProfile } from '@/hooks/useProfile';
import { Button } from '@/components/ui/Button';
import { Spinner } from '@/components/ui/Spinner';
import { AppLayout } from '@/components/layout/AppLayout';
import { RequirePermission } from '@/components/layout/RequirePermission';
import { AccessContext, type AccessValue } from '@/components/layout/accessContext';
import { signOut } from '@/lib/supabase';

import LoginPage from '@/pages/LoginPage';
import PendingAccessPage from '@/pages/PendingAccessPage';
import DashboardPage from '@/pages/DashboardPage';
import NotFoundPage from '@/pages/NotFoundPage';

// Owned by other slices. Imported by path so that a missing one fails the
// build loudly instead of being papered over with a placeholder screen.
import StageFormPage from '@/pages/StageFormPage';
import SamplesPage from '@/pages/SamplesPage';
import SampleDetailPage from '@/pages/SampleDetailPage';
import AwaitingResultsPage from '@/pages/AwaitingResultsPage';
import HoldsPage from '@/pages/HoldsPage';
import ReviewsPage from '@/pages/ReviewsPage';
import SpecificationsPage from '@/pages/SpecificationsPage';
import ReportsPage from '@/pages/ReportsPage';
import AdminPage from '@/pages/AdminPage';

/**
 * The neutral "we are still finding out" screen.
 *
 * Shown while the session or the profile is unresolved. It is deliberately not
 * the dashboard and not the pending screen: until the profile has been read we
 * do not know which is true, and guessing either way would mean briefly
 * showing a person something that is not theirs (Master Prompt section 2).
 */
function CheckingAccess({ message }: { readonly message: string }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-white px-4">
      <div className="text-center">
        <Spinner size="lg" label={message} />
        <p className="mt-4 text-base text-slate-700">{message}</p>
      </div>
    </div>
  );
}

/**
 * The profile could not be read at all — a network failure, or a database the
 * app cannot reach. This is distinct from "not approved", and saying so is the
 * difference between an operator retrying and an operator giving up because
 * they think they have been locked out.
 */
function AccessCheckFailed({
  message,
  onRetry,
}: {
  readonly message: string;
  readonly onRetry: () => void;
}) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-white px-4">
      <div className="max-w-md text-center">
        <AlertTriangle aria-hidden="true" className="mx-auto h-10 w-10 text-amber-600" />
        <h1 className="mt-4 text-xl font-bold text-slate-900">
          Your access could not be checked
        </h1>
        <p className="mt-2 text-base text-slate-700">{message}</p>
        <p className="mt-2 text-sm text-slate-600">
          This is not a refusal — the system could not be reached. Check the connection and
          try again.
        </p>
        <div className="mt-6 flex flex-col gap-2 sm:flex-row sm:justify-center">
          <Button variant="primary" onClick={onRetry}>
            Try again
          </Button>
          <Button variant="secondary" onClick={() => void signOut()}>
            Sign out
          </Button>
        </div>
      </div>
    </div>
  );
}

function AuthenticatedRoutes() {
  return (
    <Routes>
      {/* Already signed in and approved: these two have nothing left to say. */}
      <Route path="/login" element={<Navigate to="/" replace />} />
      <Route path="/pending" element={<Navigate to="/" replace />} />

      <Route path="/" element={<AppLayout />}>
        <Route index element={<DashboardPage />} />

        {/*
          Every gate below is UX only. The permission that actually decides the
          outcome is evaluated server-side by RLS and the Edge Functions on
          each request — see the header comment in RequirePermission.
        */}
        <Route
          path="stage/:stage"
          element={
            <RequirePermission permission="sample.draft">
              <StageFormPage />
            </RequirePermission>
          }
        />
        <Route
          path="samples"
          element={
            <RequirePermission permission="sample.view">
              <SamplesPage />
            </RequirePermission>
          }
        />
        <Route
          path="samples/:id"
          element={
            <RequirePermission permission="sample.view">
              <SampleDetailPage />
            </RequirePermission>
          }
        />
        <Route
          path="awaiting"
          element={
            <RequirePermission permission="sample.view">
              <AwaitingResultsPage />
            </RequirePermission>
          }
        />
        <Route
          path="holds"
          element={
            <RequirePermission permission="sample.view">
              <HoldsPage />
            </RequirePermission>
          }
        />
        <Route
          path="reviews"
          element={
            <RequirePermission permission="sample.review">
              <ReviewsPage />
            </RequirePermission>
          }
        />
        <Route
          path="specifications"
          element={
            <RequirePermission permission="report.view">
              <SpecificationsPage />
            </RequirePermission>
          }
        />
        <Route
          path="reports"
          element={
            <RequirePermission permission="report.view">
              <ReportsPage />
            </RequirePermission>
          }
        />
        <Route
          path="admin"
          element={
            <RequirePermission permission="user.manage">
              <AdminPage />
            </RequirePermission>
          }
        />

        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}

function AppRoutes() {
  const { status, user, authError, dismissAuthError } = useSession();
  const profile = useProfile(user?.id ?? null, user?.email ?? null);

  if (status === 'checking') {
    return <CheckingAccess message="Checking your sign-in" />;
  }

  if (status === 'signed_out') {
    return (
      <Routes>
        <Route
          path="/login"
          element={<LoginPage authError={authError} onDismissAuthError={dismissAuthError} />}
        />
        {/* Nothing else exists for a signed-out visitor; a deep link is
            remembered only as far as sending them to sign in. */}
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  if (profile.state === 'error') {
    return (
      <AccessCheckFailed
        message={profile.error?.message ?? 'The access check did not complete.'}
        onRetry={profile.refetch}
      />
    );
  }

  if (profile.state === 'checking' || profile.profile === null) {
    return <CheckingAccess message="Checking your access" />;
  }

  if (profile.state === 'not_active') {
    return (
      <Routes>
        <Route
          path="/pending"
          element={
            <PendingAccessPage
              email={profile.profile.email}
              status={profile.profile.status}
              onRecheck={profile.refetch}
            />
          }
        />
        {/* A not-yet-approved account has exactly one destination. No app
            route is mounted at all, so there is nothing for it to request. */}
        <Route path="*" element={<Navigate to="/pending" replace />} />
      </Routes>
    );
  }

  const access: AccessValue = {
    profile: profile.profile,
    can: profile.can,
    reloadProfile: profile.refetch,
  };

  return (
    <AccessContext.Provider value={access}>
      <AuthenticatedRoutes />
    </AccessContext.Provider>
  );
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <HashRouter>
        <AppRoutes />
      </HashRouter>
    </QueryClientProvider>
  );
}

export default App;
