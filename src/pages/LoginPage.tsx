import { useState } from 'react';
import { AlertCircle, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { env } from '@/lib/env';
import { signInWithGoogle } from '@/lib/supabase';

export interface LoginPageProps {
  /** A problem reported by the previous sign-in attempt, if any. */
  readonly authError: string | null;
  readonly onDismissAuthError: () => void;
}

/**
 * The sign-in screen.
 *
 * Nothing is fetched here and nothing is shown here. Master Prompt section 2:
 * "Do not expose data while checking user permission." This component holds no
 * query, so there is no cache to leak a previous user's samples to the next
 * person who picks the tablet up.
 */
export function LoginPage({ authError, onDismissAuthError }: LoginPageProps) {
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  async function handleSignIn() {
    setStarting(true);
    setStartError(null);
    onDismissAuthError();
    const { error } = await signInWithGoogle();
    if (error !== null) {
      // Reaching here means the redirect never happened, so the button must
      // become usable again. On success the browser leaves this page.
      setStartError(
        `Sign-in could not be started: ${error.message}. Check the connection and try again.`,
      );
      setStarting(false);
    }
  }

  const problem = startError ?? authError;

  return (
    <div className="flex min-h-screen flex-col bg-white">
      <main className="flex flex-1 items-center justify-center px-4 py-10">
        <div className="w-full max-w-md">
          <div className="text-center">
            <p className="text-sm font-semibold uppercase tracking-widest text-bff-700">
              Bounty Farm Limited
            </p>
            <h1 className="mt-2 text-3xl font-bold tracking-tight text-slate-900 sm:text-4xl">
              BFF Sample Testing
            </h1>
            <p className="mt-2 text-base text-slate-600">
              Feed Factory quality records — sample registration, testing and review.
            </p>
          </div>

          <div className="mt-8 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
            {problem !== null && (
              <div
                role="alert"
                className="mb-5 flex items-start gap-2 rounded-xl border-2 border-red-600 bg-red-50 p-3"
              >
                <AlertCircle aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0 text-red-700" />
                <p className="text-sm font-medium text-red-900">{problem}</p>
              </div>
            )}

            <Button
              variant="primary"
              size="lg"
              fullWidth
              onClick={() => void handleSignIn()}
              loading={starting}
              loadingLabel="Opening Google sign-in…"
            >
              Sign in with Google
            </Button>

            <p className="mt-4 flex items-start gap-2 text-sm text-slate-600">
              <ShieldCheck aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-slate-500" />
              <span>
                Signing in with Google confirms who you are. It does not give you access on
                its own — a supervisor approves each account before any record can be seen.
              </span>
            </p>
          </div>

          <p className="mt-6 text-center text-sm text-slate-500">
            <span className="tabular">Version {env.VITE_APP_VERSION}</span>
          </p>
        </div>
      </main>
    </div>
  );
}

export default LoginPage;
