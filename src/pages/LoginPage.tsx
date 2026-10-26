import { useState, type FormEvent } from 'react';
import { AlertCircle, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { env } from '@/lib/env';
import { signInWithGoogle, signInWithPassword } from '@/lib/supabase';

export interface LoginPageProps {
  /** A problem reported by the previous sign-in attempt, if any. */
  readonly authError: string | null;
  readonly onDismissAuthError: () => void;
}

const EMAIL_ID = 'sign-in-email';
const PASSWORD_ID = 'sign-in-password';

/**
 * The sign-in screen.
 *
 * Nothing is fetched here and nothing is shown here. Master Prompt section 2:
 * "Do not expose data while checking user permission." This component holds no
 * query, so there is no cache to leak a previous user's samples to the next
 * person who picks the tablet up.
 *
 * ===========================================================================
 * TWO WAYS IN, AND NO THIRD
 * ===========================================================================
 * Google sign-in is unchanged. Email and password sits beside it because not
 * every plant-floor operator has a Google account, and a quality record signed
 * by an account nobody can use is no record at all.
 *
 * THERE IS DELIBERATELY NO "CREATE AN ACCOUNT" AND NO "FORGOT PASSWORD" LINK.
 * Both would be buttons that cannot work: this project has no custom SMTP, and
 * Supabase's shared sender only delivers to members of the Supabase
 * organisation, so no confirmation email and no reset link would ever arrive.
 * A dead link is worse than none — it is an operator standing at a tablet
 * waiting for an email while a batch goes out. In its place the screen says,
 * in plain words, who to ask: an administrator creates the account and sets a
 * new password by hand, and hands it over in person.
 */
export function LoginPage({ authError, onDismissAuthError }: LoginPageProps) {
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [signingIn, setSigningIn] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);

  async function handleGoogleSignIn() {
    setStarting(true);
    setStartError(null);
    setPasswordError(null);
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

  async function handlePasswordSignIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (signingIn) return;

    setStartError(null);
    setPasswordError(null);
    onDismissAuthError();

    if (email.trim() === '' || password === '') {
      /**
       * A FALLBACK, NOT THE LIVE PATH — keep it, and do not write a test that
       * claims it fires.
       *
       * Both controls are `required` and the address is `type="email"`, so a
       * browser refuses the submit and focuses the offending box before this
       * handler runs; measured in jsdom for an empty value and for spaces
       * alike. What this guards is a later edit adding `noValidate` to get
       * custom messages, after which it becomes the only thing stopping an
       * empty pair being sent. Said as one sentence about the pair rather than
       * two about the boxes: the remedy is the same either way, and one
       * message is one announcement.
       */
      setPasswordError('Type your email address and your password, then press Sign in.');
      return;
    }

    setSigningIn(true);
    const { error } = await signInWithPassword(email, password);
    if (error !== null) {
      setPasswordError(error.message);
      setSigningIn(false);
      return;
    }

    // Success. `useSession` notices the new session and the app re-routes, so
    // this component is about to unmount — the password is dropped from state
    // first rather than left sitting there until React gets round to it.
    setPassword('');
    setSigningIn(false);
  }

  /**
   * The Google and redirect problems share one banner; a rejected
   * email-and-password pair has its own, under the form it belongs to, because
   * an error 300 pixels above the box that caused it is an error nobody reads.
   */
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
              onClick={() => void handleGoogleSignIn()}
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

            {/*
              A separator with a word in it, not a bare rule. The two halves are
              alternatives, and a hairline alone does not say so.
            */}
            <div className="my-6 flex items-center gap-3" aria-hidden="true">
              <span className="h-px flex-1 bg-slate-200" />
              <span className="text-xs font-semibold uppercase tracking-widest text-slate-500">
                or
              </span>
              <span className="h-px flex-1 bg-slate-200" />
            </div>

            <form className="space-y-4" onSubmit={(event) => void handlePasswordSignIn(event)}>
              <h2 className="text-base font-semibold text-slate-900">
                Sign in with an email address
              </h2>

              {passwordError !== null && (
                <div
                  role="alert"
                  className="flex items-start gap-2 rounded-xl border-2 border-red-600 bg-red-50 p-3"
                >
                  <AlertCircle
                    aria-hidden="true"
                    className="mt-0.5 h-5 w-5 shrink-0 text-red-700"
                  />
                  <p className="text-sm font-medium text-red-900">{passwordError}</p>
                </div>
              )}

              <Field id={EMAIL_ID} label="Email address" required>
                <Input
                  type="email"
                  autoComplete="username"
                  inputMode="email"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                />
              </Field>

              <Field id={PASSWORD_ID} label="Password" required>
                <Input
                  type="password"
                  autoComplete="current-password"
                  autoCapitalize="none"
                  spellCheck={false}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </Field>

              <Button
                type="submit"
                variant="secondary"
                size="lg"
                fullWidth
                loading={signingIn}
                loadingLabel="Signing in…"
              >
                Sign in
              </Button>
            </form>

            <p className="mt-4 text-sm text-slate-600">
              No account, or forgotten the password? Ask your Quality Supervisor or an
              administrator. They create the account and set a new password by hand and give
              it to you directly — nothing is sent by email. You will be asked to choose your
              own password the first time you sign in.
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
