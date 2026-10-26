import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, KeyRound, LogOut } from 'lucide-react';

import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ErrorSummary, type FieldError } from '@/components/ui/ErrorSummary';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { InfoNote } from '@/components/records/common';
import {
  changeOwnPassword,
  MAX_PASSWORD_BYTES,
  MIN_PASSWORD_LENGTH,
  passwordByteLength,
  signOut,
} from '@/lib/supabase';

export interface ChangePasswordPageProps {
  /** The account that signed in, so the person can see whose password this is. */
  readonly email: string | null;
  /**
   * Re-read the profile after a successful change.
   *
   * This is the MOUNTED hook's own `refetch`, not a cache key. The page also
   * invalidates `['profile']`, but that prefix is a guess about another
   * module's query key and a rename there would silently stop the
   * invalidation working; calling the hook's refetch directly cannot drift.
   * Both are done — see `handleSubmit`.
   */
  readonly onChanged: () => void | Promise<void>;
  /**
   * True when this account is not yet approved.
   *
   * The default copy on this screen assumes an approved account: "before you
   * start" and, on success, "from here on the records you sign are yours".
   * Neither is true for a `pending` account — it can start nothing, and the
   * router sends it back to `/pending` the moment the change lands. Saying so
   * here is what stops the bounce reading as a failure. `App.tsx` passes this
   * only from the `not_active` branch.
   */
  readonly approvalPending?: boolean;
}

const NEW_PASSWORD_ID = 'new-password';
const CONFIRM_PASSWORD_ID = 'confirm-password';

/**
 * The problems with what has been typed, in the order the fields appear.
 *
 * NOT exported. Two reasons, and the second is the real one: exporting a
 * non-component from a `.tsx` file trips `react-refresh/only-export-components`
 * and would add a warning to a lint gate whose documented baseline is an exact
 * count — and the rules are better tested through the rendered form anyway,
 * because that is where an operator meets them. A test of this function alone
 * can pass while the form never calls it.
 */
function passwordProblems(newPassword: string, confirmation: string): FieldError[] {
  const problems: FieldError[] = [];

  if (newPassword === '') {
    problems.push({
      id: NEW_PASSWORD_ID,
      label: 'New password',
      message: 'Type the password you want to use from now on.',
    });
  } else if (newPassword.length < MIN_PASSWORD_LENGTH) {
    problems.push({
      id: NEW_PASSWORD_ID,
      label: 'New password',
      message: `Use at least ${MIN_PASSWORD_LENGTH} characters. This one has ${newPassword.length}.`,
    });
  } else if (passwordByteLength(newPassword) > MAX_PASSWORD_BYTES) {
    // The upper bound is checked here and not left to the server, because
    // anything past the 72nd byte is DISCARDED when the password is stored —
    // so a longer password would be accepted and then silently shortened, and
    // the administrator's temporary password might still open the account.
    // Said in characters, because bytes are not a thing an operator can count.
    problems.push({
      id: NEW_PASSWORD_ID,
      label: 'New password',
      message:
        'That password is too long to be stored in full, so part of it would be ' +
        'thrown away. Shorten it — around 70 characters is the most that fits.',
    });
  }

  // Only worth saying once there is something to compare against, otherwise a
  // person who has filled in neither box is told about two problems.
  if (confirmation === '') {
    if (newPassword !== '') {
      problems.push({
        id: CONFIRM_PASSWORD_ID,
        label: 'Type the new password again',
        message: 'Type the same password a second time, so a typing slip cannot lock you out.',
      });
    }
  } else if (confirmation !== newPassword) {
    problems.push({
      id: CONFIRM_PASSWORD_ID,
      label: 'Type the new password again',
      message: 'The two passwords are not the same. Check both and retype them.',
    });
  }

  return problems;
}

/**
 * Choose your own password — the one screen an account with an outstanding
 * forced change can reach.
 *
 * ===========================================================================
 * WHY SOMEBODY IS HERE, AND WHY IT IS NOT A TELLING-OFF
 * ===========================================================================
 * This project has no email delivery: there is no custom SMTP and Supabase's
 * shared sender only reaches members of the Supabase organisation. So there is
 * no signup email and no "forgot password" link, and accounts are created by
 * an administrator who types a temporary password and hands it over.
 *
 * That temporary password is known to two people. Until it is replaced,
 * anything recorded under this account names an account rather than a person —
 * and naming a person is the entire purpose of a quality record. So the holder
 * is asked to choose their own before anything else. They have done nothing
 * wrong; the wording on this screen says so, because an operator who thinks
 * they are being accused of something tends to go and find a supervisor
 * instead of finishing the job.
 *
 * ===========================================================================
 * WHAT ACTUALLY STOPS THEM WORKING, AND WHAT THIS SCREEN IS
 * ===========================================================================
 * The enforcement is in the database, and it takes TWO predicates rather than
 * the one this comment used to name. `public.require_permission` (migration
 * 0019) reads `public.must_change_password()` before it reads the permission,
 * which covers the RPC and Edge Function route. The row-level-security
 * policies authorise through `public.is_active_user()` and
 * `public.has_permission()` instead, and those never consulted the credential
 * until migration 0020 put the same call inside them — so before 0020 an
 * account in this state was refused by the Edge Functions and served by
 * PostgREST, while four comments in this codebase said otherwise. With both in
 * place the account holds no permission by any route, so navigating past this
 * screen gains nothing: every request behind it is refused.
 *
 * This screen is the way OUT of that state, not the thing that creates it.
 * The router refuses to mount anything else (see `App.tsx`) so that the only
 * two things reachable are the ones that need no permission: changing the
 * password, and signing out.
 */
export function ChangePasswordPage({
  email,
  onChanged,
  approvalPending = false,
}: ChangePasswordPageProps) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const [newPassword, setNewPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [problems, setProblems] = useState<readonly FieldError[]>([]);
  const [serverProblem, setServerProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [changed, setChanged] = useState(false);

  /** Which field errors to show under the controls — only after a submit. */
  const problemFor = (id: string): string | null =>
    problems.find((problem) => problem.id === id)?.message ?? null;

  /**
   * Re-read the profile so the app learns the obligation is discharged.
   *
   * MUST NOT BE CALLED FROM THE SUBMIT HANDLER. Doing so was a defect that
   * reached production and made a successful change look like a failed one.
   *
   * The mechanism, because it is not obvious and the next person will be
   * tempted to put it back: `App` renders this page from TWO different route
   * trees. While `mustChangePassword` is true it returns a small gated
   * `<Routes>` of its own; once that flips false it falls through to the
   * authenticated router, which ALSO mounts `/change-password` — a different
   * element in a different tree. So refetching here flipped the flag, React
   * unmounted this component and mounted a fresh one, and `changed` went back
   * to false. The person saw the empty form again, one instant after their
   * password had in fact been saved.
   *
   * Observed consequence, not a theory: the owner changed their password twice
   * because the first attempt gave no acknowledgement. The audit trail shows
   * both `identity.password_changed` events.
   *
   * So the refetch now happens when the person presses Continue, by which time
   * they have seen the confirmation and a remount costs nothing.
   */
  async function reload(): Promise<void> {
    // Two deliberate calls. `invalidateQueries` reaches any other consumer of
    // the profile; `onChanged` is the mounted hook's own refetch and does not
    // depend on this file guessing that hook's query key correctly.
    //
    // AWAITED, because the caller navigates afterwards. Firing and forgetting
    // left `/` to be decided by the stale profile, which still said a change
    // was outstanding, so the router bounced straight back to this form.
    void queryClient.invalidateQueries({ queryKey: ['profile'] });
    await onChanged();
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;

    setServerProblem(null);
    const found = passwordProblems(newPassword, confirmation);
    setProblems(found);
    if (found.length > 0) return;

    setSaving(true);
    const { error } = await changeOwnPassword(newPassword);
    setSaving(false);

    if (error !== null) {
      setServerProblem(error.message);
      return;
    }

    // Do not keep what was typed in component state a moment longer than the
    // request needed it.
    setNewPassword('');
    setConfirmation('');
    setChanged(true);
    // NO reload() here. See the note on `reload` — refetching at this moment
    // unmounts this component and discards the confirmation the person needs
    // to see. Continue does it instead.
  }

  if (changed) {
    return (
      <div className="flex min-h-screen flex-col bg-white">
        <main className="flex flex-1 items-center justify-center px-4 py-10">
          <div className="w-full max-w-md text-center">
            <span className="inline-flex h-14 w-14 items-center justify-center rounded-full bg-green-100">
              <CheckCircle2 aria-hidden="true" className="h-7 w-7 text-green-800" />
            </span>
            <h1 className="mt-4 text-2xl font-bold tracking-tight text-slate-900">
              Your password is set
            </h1>
            {/*
              `role="status"` rather than `role="alert"`: this is the outcome of
              something the person just did, so it is announced politely
              instead of interrupting them.
            */}
            <p role="status" className="mt-3 text-base text-slate-700">
              This password is now yours alone. Nobody else knows it, so from here on the
              records you sign are yours.
            </p>
            {/*
              THE SECOND HALF OF THE ANSWER, for an account that is not
              approved yet. Pressing Continue sends it back to `/pending`, and
              without this sentence that bounce reads as the change having
              failed — the one outcome this screen must never imply, because
              the change did land and the holder has nothing left to do.
            */}
            {approvalPending ? (
              <p className="mt-3 text-base font-medium text-amber-900">
                Your account is <strong>still waiting for approval</strong>, so you will not
                see any samples yet — that is the next step and it is somebody
                else&rsquo;s. Nothing has gone wrong and there is nothing more for you to do
                here.
              </p>
            ) : null}
            {/*
              Says what is true now. The earlier wording — "your access is
              being re-checked" — described a refetch that fired on submit,
              which is exactly the call that destroyed this panel before
              anybody could read it. Nothing is in flight here; the next step
              is the person's.
            */}
            <p className="mt-3 text-sm text-slate-600">
              Your new password is saved. Press Continue to go on.
            </p>
            <div className="mt-6 flex flex-col gap-2 sm:flex-row sm:justify-center">
              {/*
                Goes to the start of the app, which is the right destination in
                both cases and needs no knowledge of which one applies. If the
                forced change really has cleared, the dashboard opens. If the
                profile has not caught up yet, the router sends them straight
                back here — no screen lies about the state, and nobody is
                stranded on a success message with nowhere to go.
              */}
              <Button
                variant="primary"
                size="lg"
                onClick={() => {
                  void (async () => {
                    await reload();
                    navigate('/', { replace: true });
                  })();
                }}
              >
                Continue
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

  return (
    <div className="flex min-h-screen flex-col bg-white">
      <main className="flex flex-1 items-start justify-center px-4 py-10">
        <div className="w-full max-w-md">
          <div className="text-center">
            <span className="inline-flex h-14 w-14 items-center justify-center rounded-full bg-bff-100">
              <KeyRound aria-hidden="true" className="h-7 w-7 text-bff-800" />
            </span>
            <h1 className="mt-4 text-2xl font-bold tracking-tight text-slate-900">
              Choose your own password
            </h1>
            {/*
              Two intros, because "before you start" is false for an account
              that cannot start anything. The pending screen links here, so a
              person who arrives that way must not be told their work is
              waiting on this.
            */}
            <p className="mt-3 text-base text-slate-700">
              {approvalPending
                ? 'You are signed in, and your account is still waiting for approval. This is the one part you can settle now: replace the password you were given with one only you know.'
                : 'You are signed in. Before you start, please replace the password you were given with one only you know.'}
            </p>
          </div>

          <Card className="mt-6">
            <InfoNote>
              The password you were given was typed by the person who set up your account,
              so they know it too. Every sample, result and review you record names you —
              that only holds once the password is yours alone. Nothing is wrong with your
              account.
            </InfoNote>

            {problems.length > 0 && (
              <ErrorSummary
                className="mt-4"
                errors={problems}
                title={
                  problems.length === 1
                    ? 'There is 1 problem to fix'
                    : `There are ${problems.length} problems to fix`
                }
                autoFocus
              />
            )}

            {serverProblem !== null && (
              <div
                role="alert"
                className="mt-4 rounded-xl border-2 border-red-600 bg-red-50 p-3 text-sm font-medium text-red-900"
              >
                {serverProblem}
              </div>
            )}

            <form className="mt-4 space-y-5" onSubmit={(event) => void handleSubmit(event)}>
              <dl className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm">
                <dt className="font-medium text-slate-600">Signed in as</dt>
                <dd className="mt-0.5 break-all font-semibold text-slate-900">
                  {email ?? 'this account'}
                </dd>
              </dl>

              <Field
                id={NEW_PASSWORD_ID}
                label="New password"
                required
                /*
                  The rule is stated here, before anything is typed. Finding out
                  the minimum length only by being rejected is how somebody ends
                  up typing four passwords on a tablet with one hand.
                */
                hint={`At least ${MIN_PASSWORD_LENGTH} characters and no more than about 70. Make it different from the one you were given, and do not use one you have told anybody.`}
                error={problemFor(NEW_PASSWORD_ID)}
              >
                <Input
                  type="password"
                  autoComplete="new-password"
                  autoCapitalize="none"
                  spellCheck={false}
                  value={newPassword}
                  onChange={(event) => setNewPassword(event.target.value)}
                />
              </Field>

              <Field
                id={CONFIRM_PASSWORD_ID}
                label="Type the new password again"
                required
                hint="Typed twice, because a slip here would lock you out and there is no reset email."
                error={problemFor(CONFIRM_PASSWORD_ID)}
              >
                <Input
                  type="password"
                  autoComplete="new-password"
                  autoCapitalize="none"
                  spellCheck={false}
                  value={confirmation}
                  onChange={(event) => setConfirmation(event.target.value)}
                />
              </Field>

              <Button
                type="submit"
                variant="primary"
                size="lg"
                fullWidth
                loading={saving}
                loadingLabel="Saving your password…"
              >
                Save my password
              </Button>
            </form>
          </Card>

          <div className="mt-6 text-center">
            <Button
              variant="ghost"
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

export default ChangePasswordPage;
