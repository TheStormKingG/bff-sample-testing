import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Lock } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ROLE_LABELS, type Permission } from '@/lib/roles';
import { useAccess } from '@/components/layout/accessContext';

export interface RequirePermissionProps {
  readonly permission: Permission;
  readonly children: ReactNode;
}

/**
 * Hide a route from somebody who has no business seeing it.
 *
 * ---------------------------------------------------------------------------
 * THIS IS USER EXPERIENCE, NOT A SECURITY CONTROL.
 *
 * Everything in this bundle is public: GitHub Pages serves the same JavaScript
 * to anybody, signed in or not, and anyone can edit the running page or call
 * the API directly. The actual control is Row Level Security on every table
 * plus server-side authorization in the Edge Functions and RPCs, evaluated
 * from `auth.uid()` on each request. Master Prompt section 1: "Security must
 * reside in Supabase, RLS, Edge Functions and locked-down Google Sheet
 * sharing — not in hidden UI buttons."
 *
 * So the purpose of this component is to keep an operator from walking into a
 * screen full of denials, and nothing more. Removing it would be a usability
 * regression, not a breach.
 * ---------------------------------------------------------------------------
 *
 * On refusal it says so plainly rather than redirecting to the dashboard.
 * Recorded delegations are intentionally not read in the browser, so a Quality
 * Officer who has just been delegated authority can land here while genuinely
 * holding the permission server-side; the message below says what to do about
 * that instead of implying the screen does not exist.
 */
export function RequirePermission({ permission, children }: RequirePermissionProps) {
  const { profile, can, reloadProfile } = useAccess();

  if (can(permission)) return <>{children}</>;

  const roleText =
    profile.roles.length === 0
      ? 'no role yet'
      : profile.roles.map((role) => ROLE_LABELS[role]).join(', ');

  return (
    <Card title="You do not have access to this screen" className="mx-auto max-w-2xl">
      <div className="flex items-start gap-3">
        <Lock aria-hidden="true" className="mt-0.5 h-6 w-6 shrink-0 text-slate-500" />
        <div className="space-y-3 text-base text-slate-700">
          <p>
            Your account is signed in as <strong>{profile.email ?? profile.id}</strong> with{' '}
            {roleText}. That does not include this part of the system.
          </p>
          <p>
            If a supervisor has just given you this authority, reload your access and try
            again. If it still does not open, ask your Quality Supervisor — access is
            granted in the system, not on this device.
          </p>
          <div className="flex flex-col gap-2 pt-1 sm:flex-row">
            <Button variant="secondary" onClick={reloadProfile}>
              Reload my access
            </Button>
            {/* A Link, not a Button wrapping a Link: a nested interactive
                element inside a button is invalid markup and screen readers
                announce it inconsistently. */}
            <Link
              to="/"
              className="inline-flex min-h-tap items-center justify-center rounded-lg border border-transparent px-4 py-2.5 font-semibold text-bff-800 hover:bg-slate-100"
            >
              Back to the dashboard
            </Link>
          </div>
        </div>
      </div>
    </Card>
  );
}
