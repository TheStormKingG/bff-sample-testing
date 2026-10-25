import { useState } from 'react';
import { Clock, LogOut, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { signOut } from '@/lib/supabase';
import type { UserStatus } from '@/lib/roles';

export interface PendingAccessPageProps {
  /** The Google account that signed in. */
  readonly email: string | null;
  readonly status: UserStatus;
  /** Re-read the profile, for when a supervisor has just approved it. */
  readonly onRecheck: () => void;
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
export function PendingAccessPage({ email, status, onRecheck }: PendingAccessPageProps) {
  const [checking, setChecking] = useState(false);
  const message = MESSAGES[status];

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
          <p className="mt-3 text-base text-slate-700">{message.body}</p>

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
