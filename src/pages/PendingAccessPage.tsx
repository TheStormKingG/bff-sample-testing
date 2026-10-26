import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Clock, KeyRound, LogOut, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { signOut } from '@/lib/supabase';
import type { UserStatus } from '@/lib/roles';

export interface PendingAccessPageProps {
  /** The account that signed in. */
  readonly email: string | null;
  readonly status: UserStatus;
  /** Re-read the profile, for when a supervisor has just approved it. */
  readonly onRecheck: () => void;
  /**
   * True while the account is still using a password an administrator typed.
   *
   * THIS SCREEN IS WHERE SUCH AN ACCOUNT LANDS, and before this prop existed it
   * said nothing about passwords at all — so the one action the holder could
   * take was reachable only by typing `#/change-password` by hand. `App.tsx`
   * evaluates the status branch before the credential branch, deliberately
   * (see the comment there), which makes this the landing screen and therefore
   * the only place the route out can live.
   */
  readonly mustChangePassword: boolean;
  /**
   * True when an administrator created this account with a temporary password.
   *
   * TWO WAYS TO ARRIVE AT A PENDING ACCOUNT, and the copy used to assume one.
   * "Your Google account has been recognised" is false for an account an
   * administrator created: nobody has signed in to it with Google at all, and
   * telling its holder otherwise sends them looking for a Google problem.
   * `UserRow` on the administration screen branches on the same column for the
   * same reason; this is the holder's side of that correction.
   */
  readonly createdByAdministrator: boolean;
}

const MESSAGES: Record<UserStatus, { heading: string; body: string }> = {
  pending: {
    heading: 'Your access is waiting for approval',
    body:
      'Your Google account has been recognised, but a Quality Supervisor or Administrator ' +
      'must approve it before you can see or record any samples. Ask them to approve your ' +
      'account, then check again.',
  },
  // `active` cannot reach this screen; the entry keeps the table exhaustive so
  // a new status value cannot be added without deciding what it says here.
  active: {
    heading: 'Your access is being checked',
    body: 'One moment while your access is confirmed.',
  },
  suspended: {
    heading: 'Your access is suspended',
    body:
      'Your account has been suspended, so no records can be opened. Speak to your Quality ' +
      'Supervisor or Administrator about having it restored.',
  },
  disabled: {
    heading: 'Your access has been removed',
    body:
      'This account is no longer able to use BFF Sample Testing. If you believe this is a ' +
      'mistake, speak to your Quality Supervisor or Administrator.',
  },
};

/**
 * The pending / not-approved gate.
 *
 * Master Prompt section 1 and FR-001: a new Google sign-in is `pending` and
 * sees no data. This screen holds no query of its own, so there is nothing for
 * it to leak — it shows only the identity the person just signed in with, and
 * a way back out.
 */
/**
 * The pending body, for an account nobody has signed in to with Google.
 *
 * Kept beside `MESSAGES` rather than inside it, because it varies on a
 * different axis: `MESSAGES` is keyed by status, and this replaces only the
 * `pending` entry's body, only when the account was administrator-created.
 */
const PENDING_BODY_ADMIN_CREATED =
  'This account was created for you by an administrator, so there is nothing wrong with ' +
  'your sign-in. A Quality Supervisor or Administrator must still approve it before you ' +
  'can see or record any samples. Ask them to approve it, then check again.';

export function PendingAccessPage({
  email,
  status,
  onRecheck,
  mustChangePassword,
  createdByAdministrator,
}: PendingAccessPageProps) {
  const [checking, setChecking] = useState(false);
  const message = MESSAGES[status];
  const body =
    status === 'pending' && createdByAdministrator
      ? PENDING_BODY_ADMIN_CREATED
      : message.body;

  function handleRecheck() {
    setChecking(true);
    onRecheck();
    // The profile query resolves on its own; this only stops the button from
    // looking stuck, and it is never claimed as a result.
    window.setTimeout(() => setChecking(false), 1_200);
  }

  return (
    <div className="flex min-h-screen flex-col bg-white">
      <main className="flex flex-1 items-center justify-center px-4 py-10">
        <div className="w-full max-w-md text-center">
          <span className="inline-flex h-14 w-14 items-center justify-center rounded-full bg-amber-100">
            <Clock aria-hidden="true" className="h-7 w-7 text-amber-800" />
          </span>

          <h1 className="mt-4 text-2xl font-bold tracking-tight text-slate-900">
            {message.heading}
          </h1>
          <p className="mt-3 text-base text-slate-700">{body}</p>

          {/*
            THE ONE THING THE HOLDER CAN ACTUALLY DO, on the screen they land
            on. Offered for every not-active status and not just `pending`:
            neither `change-own-password` nor `rpc_record_password_changed` has
            a status check — both say so in their own comments, deliberately —
            so the server permits this whatever the status, and a status-keyed
            exemption here would be a loophole rather than a rule. What carries
            the honesty is the wording, which never implies that doing it grants
            access.

            A router `Link`, not an `<a href="#...">`: under HashRouter a bare
            fragment anchor IS a route change, and `App.tsx`'s header comment
            forbids one for that reason. `Link` renders `href="#/change-password"`
            and is handled by the router.
          */}
          {mustChangePassword ? (
            <div className="mt-6 rounded-xl border-2 border-bff-700 bg-bff-50 p-4 text-left">
              <p className="flex items-center gap-2 text-base font-bold text-slate-900">
                <KeyRound aria-hidden="true" className="h-5 w-5" />
                You can do this part now
              </p>
              <p className="mt-2 text-base text-slate-800">
                The password you were given was typed for you, so the administrator who set
                up your account knows it too. Replace it with one <strong>only you</strong>{' '}
                know, and from then on anything recorded under this account is yours and
                nobody else&rsquo;s. It takes a moment and you do not have to wait for
                anyone.
              </p>
              <p className="mt-2 text-sm text-slate-700">
                This <strong>does not approve your account</strong> — that is still somebody
                else&rsquo;s decision, and you will come back to this screen afterwards.
              </p>
              <Link
                to="/change-password"
                className="mt-3 inline-flex min-h-tap items-center gap-2 rounded-lg border border-bff-800 bg-bff-700 px-4 py-2.5 text-base font-medium text-white hover:bg-bff-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-bff-600 focus-visible:ring-offset-2"
              >
                <KeyRound aria-hidden="true" className="h-5 w-5" />
                Choose your own password
              </Link>
            </div>
          ) : null}

          <dl className="mt-6 rounded-xl border border-slate-200 bg-slate-50 p-4 text-left text-sm">
            <dt className="font-medium text-slate-600">Signed in as</dt>
            <dd className="mt-0.5 break-all font-semibold text-slate-900">
              {email ?? 'this Google account'}
            </dd>
          </dl>

          <div className="mt-6 flex flex-col gap-2 sm:flex-row sm:justify-center">
            <Button
              variant="primary"
              onClick={handleRecheck}
              loading={checking}
              loadingLabel="Checking…"
              leadingIcon={<RefreshCw aria-hidden="true" className="h-5 w-5" />}
            >
              Check again
            </Button>
            <Button
              variant="secondary"
              onClick={() => void signOut()}
              leadingIcon={<LogOut aria-hidden="true" className="h-5 w-5" />}
            >
              Sign out
            </Button>
          </div>
        </div>
      </main>
    </div>
  );
}

export default PendingAccessPage;
