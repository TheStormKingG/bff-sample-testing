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
import ChangePasswordPage from '@/pages/ChangePasswordPage';
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

function AuthenticatedRoutes({
  email,
  onProfileChanged,
}: {
  readonly email: string | null;
  readonly onProfileChanged: () => void;
}) {
  return (
    <Routes>
      {/* Already signed in and approved: these two have nothing left to say. */}
      <Route path="/login" element={<Navigate to="/" replace />} />
      <Route path="/pending" element={<Navigate to="/" replace />} />

      {/*
        Reachable voluntarily, by somebody who owes no forced change and simply
        wants a different password. Mounted OUTSIDE `AppLayout`, like the two
        redirects above, because the screen is full-page and holds no query.

        Not mounting it here would be the worse option rather than the stricter
        one: the route exists in the app, so an active user who followed a
        bookmark to it would fall through to `NotFoundPage` and be told a real
        address does not exist. Nothing is relaxed by mounting it — the page's
        only action changes the caller's own password.
      */}
      <Route
        path="/change-password"
        element={<ChangePasswordPage email={email} onChanged={onProfileChanged} />}
      />

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
              /*
                WHY THIS BRANCH WINS OVER THE PASSWORD BRANCH BELOW, AND WHY
                THAT MADE THIS SCREEN THE PLACE THE REMEDY HAS TO LIVE.

                Both facts are true of a pending-and-armed account, and the
                order decides which one is the headline. The test is which fact
                is STILL true once the holder has done everything in their
                power: replacing the password does not approve the account,
                whereas being approved does not discharge the password. Only
                the approval survives the holder's own best effort, so the
                approval is the honest headline — and it is also the ordering
                `public.require_permission` uses (status before credential), so
                the screen agrees with the reason the server would give.

                That ordering was right and, on its own, produced a dead end:
                this screen said nothing about passwords, so the one action the
                holder could take was reachable only by typing
                `#/change-password` by hand. Hence the two props below. The
                branch order is the decision; the remedy block is what makes
                the decision defensible rather than a trap.

                It matters more since migration 0020 gated `is_active_user()`:
                an armed account now fails 36 of 37 row-level-security
                policies, so any screen carrying a query renders empty for it.
                `PendingAccessPage` holds no query at all, which makes it the
                one screen that provably renders correctly here.
              */
              mustChangePassword={profile.profile.mustChangePassword}
              createdByAdministrator={profile.profile.passwordSetByAdminAt !== null}
            />
          }
        />
        {/*
          Also reachable while not yet approved, and that is deliberate.
          Migration 0019 states it in `rpc_record_password_changed`: "a
          'pending' administrator-created account must be able to clear its
          temporary credential before it is approved", which is why that RPC
          has no status check. The server permits it, so the UI must offer a
          way to do it — and since the pending screen now LINKS here, this
          route is no longer only reachable by a hand-typed address.

          `approvalPending` is what stops the two screens contradicting each
          other. The default copy says "before you start" and, on success,
          "from here on the records you sign are yours" — neither is true for
          an account that will be sent straight back to `/pending`.
        */}
        <Route
          path="/change-password"
          element={
            <ChangePasswordPage
              email={profile.profile.email}
              onChanged={profile.refetch}
              approvalPending
            />
          }
        />
        {/* A not-yet-approved account has exactly one destination. No app
            route is mounted at all, so there is nothing for it to request. */}
        <Route path="*" element={<Navigate to="/pending" replace />} />
      </Routes>
    );
  }

  /**
   * THE FORCED PASSWORD CHANGE.
   *
   * ==========================================================================
   * WHY IT IS HERE AND NOT IN A COMPONENT
   * ==========================================================================
   * This sits in the same place as the pending and suspended gates above, and
   * for the same reason: it is the only place a deep link cannot get round.
   * The branch does not hide a navigation item or disable a button — it
   * declines to MOUNT any other route, so `#/samples`, `#/admin` and a
   * bookmark from last week all resolve to the one screen that can clear the
   * state. A guard placed inside `AppLayout` or inside each page would be a
   * redirect somebody can race, and a guard placed in a navigation component
   * would not be a guard at all.
   *
   * ORDER MATTERS, AND IT MIRRORS THE SERVER. `public.require_permission`
   * (migration 0011, extended by 0019) checks the account's STATUS before it
   * checks the credential, so a suspended account gets the account answer and
   * not the password answer. The branches here are in that same order, so the
   * screen a person is shown agrees with the reason the server would give.
   *
   * ==========================================================================
   * THIS IS NOT THE ENFORCEMENT
   * ==========================================================================
   * The enforcement is `public.must_change_password()`, and it reaches every
   * route through TWO INDEPENDENT CHAINS — which is worth stating precisely,
   * because this comment used to name only the first and that is exactly what
   * made the hole invisible:
   *
   *   RAISING (0011, extended by 0019) `require_permission` consults
   *     `must_change_password` before the permission itself. This governs the
   *     RPC and Edge Function chain, and NOTHING ELSE. Row-level-security
   *     policies do not call it.
   *   BOOLEAN (0001, gated by 0020) the RLS policies authorise through
   *     `is_active_user()` and `has_permission()`, non-raising helpers that
   *     never consulted the credential. Until 0020 an armed account was
   *     blocked from the Edge Functions and FREE through PostgREST — an
   *     auditor reproduced a DELETE of its own draft. 0020 put the gate in
   *     `is_active_user()` (the chokepoint, reached by 36 of 37 policies) and
   *     restated it in `has_permission()`, and added
   *     `public.assert_password_gate_on_every_policy()` so a future policy
   *     authorising through an ungated predicate fails the build.
   *
   * So the claim "no permission by any route" is true, and it is true because
   * of 0020 rather than because of this branch. Deleting this branch would not
   * grant anybody anything; it would produce an app whose every screen is
   * refused with no route to the remedy. The flag is read from the two
   * timestamps on the profile row, which `profiles_select_self` lets the
   * holder read even while the gate is closed — that policy is 0020's one
   * declared exemption, and it exists so the remedy stays discoverable.
   *
   * Signing out stays possible, and the change-password screen itself works,
   * because neither needs a permission.
   */
  if (profile.profile.mustChangePassword) {
    return (
      <Routes>
        <Route
          path="/change-password"
          element={
            <ChangePasswordPage email={profile.profile.email} onChanged={profile.refetch} />
          }
        />
        <Route path="*" element={<Navigate to="/change-password" replace />} />
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
      <AuthenticatedRoutes
        email={profile.profile.email}
        onProfileChanged={profile.refetch}
      />
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
