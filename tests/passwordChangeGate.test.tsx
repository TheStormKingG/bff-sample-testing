/**
 * The routing gate that forces an administrator-created account to choose its
 * own password, exercised through the real router.
 *
 * ===========================================================================
 * WHY THIS SUITE RENDERS `App` AND NOT A FUNCTION
 * ===========================================================================
 * The claim being defended is not "a predicate returns true" — that is
 * `tests/passwordChangeRule.test.ts`. The claim is that no ROUTE is reachable
 * while a forced change is outstanding, and that is a property of the route
 * table, not of any function. A test of a decision function can pass in full
 * while the router ignores it; a test that renders one page and checks it
 * redirects says nothing about the other nine. So the whole `App` is mounted,
 * with the session and the profile replaced, and the assertions are made on
 * what the browser would actually show for a given address.
 *
 * Deep links are the point. `#/samples`, `#/admin` and a bookmark from last
 * week are the three ways somebody gets past a guard that lives in a
 * navigation component or in a page's own effect, which is why the gate is in
 * `App.tsx`'s branch structure instead. These tests are what stops a later
 * refactor moving it somewhere a deep link can reach.
 *
 * ===========================================================================
 * WHAT IS FAKED, AND WHAT IS DELIBERATELY NOT
 * ===========================================================================
 * Faked: the Vite environment (validated at module load, absent in a test
 * runner), `useSession`, `useProfile`, and the two network-touching exports of
 * `@/lib/supabase`. Everything else is the shipped code — the real
 * `HashRouter`, the real branch structure in `App.tsx`, the real
 * `ChangePasswordPage` and the real `LoginPage`.
 *
 * NOT faked: `fetch` is stubbed to REJECT, and that is an assertion rather
 * than a convenience. While the gate is closed the app must issue no data
 * request at all (Master Prompt §2: "Do not expose data while checking user
 * permission"), and a stub that quietly succeeded would hide a screen that
 * had started loading samples behind the password prompt.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import type { Profile, UseProfileResult } from '@/hooks/useProfile';
import type { SessionStatus } from '@/hooks/useSession';

const FAKE_ENV = {
  VITE_SUPABASE_URL: 'https://example.supabase.co',
  VITE_SUPABASE_ANON_KEY: 'test-anon-key',
  VITE_APP_VERSION: 'test',
  VITE_BASE_PATH: '/',
};

vi.mock('@/lib/env', () => ({
  env: FAKE_ENV,
  basePath: '/',
  readEnv: () => FAKE_ENV,
}));

/**
 * `vi.hoisted` because `vi.mock` factories are hoisted above the imports, so
 * anything they close over has to be hoisted too. This object is the dial each
 * test turns.
 */
const harness = vi.hoisted(() => ({
  sessionStatus: 'signed_in' as 'checking' | 'signed_in' | 'signed_out',
  profileState: 'active' as 'checking' | 'active' | 'not_active' | 'error',
  mustChangePassword: false,
  status: 'active' as 'pending' | 'active' | 'suspended' | 'disabled',
  changeOwnPassword: vi.fn(),
  signOut: vi.fn(),
  refetch: vi.fn(),
  signInWithPassword: vi.fn(),
}));

vi.mock('@/hooks/useSession', () => ({
  useSession: () => ({
    status: harness.sessionStatus as SessionStatus,
    session: null,
    user:
      harness.sessionStatus === 'signed_in'
        ? { id: 'user-1', email: 'operator@example.com' }
        : null,
    authError: null,
    dismissAuthError: vi.fn(),
  }),
}));

vi.mock('@/hooks/useProfile', () => ({
  useProfile: (): UseProfileResult => {
    const profile: Profile = {
      id: 'user-1',
      email: 'operator@example.com',
      fullName: 'Test Operator',
      status: harness.status,
      roles: ['quality_officer'],
      provisional: false,
      passwordSetByAdminAt: harness.mustChangePassword
        ? '2026-10-26T08:00:00.000000+00:00'
        : null,
      passwordChangedAt: null,
      mustChangePassword: harness.mustChangePassword,
    };
    return {
      state: harness.profileState,
      profile: harness.profileState === 'checking' ? null : profile,
      authority: null,
      isActive: harness.profileState === 'active',
      error: null,
      refetch: harness.refetch,
      // Everything is offered, so a redirect that failed would show a usable
      // screen rather than a permission refusal — the gate is what is under
      // test, not the permission table.
      can: () => true,
    };
  },
}));

vi.mock('@/lib/supabase', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/supabase')>();
  return {
    ...actual,
    changeOwnPassword: harness.changeOwnPassword,
    signOut: harness.signOut,
    signInWithGoogle: vi.fn(async () => ({ error: null })),
    signInWithPassword: harness.signInWithPassword,
  };
});

const { App } = await import('@/App');
const { MAX_PASSWORD_BYTES, MIN_PASSWORD_LENGTH } = await import('@/lib/supabase');

const fetchSpy = vi.fn(async () => {
  throw new Error('No network request may be made in this suite.');
});

function goTo(route: string) {
  window.location.hash = route;
}

function currentRoute(): string {
  return window.location.hash;
}

beforeEach(() => {
  harness.sessionStatus = 'signed_in';
  harness.profileState = 'active';
  harness.status = 'active';
  harness.mustChangePassword = false;
  harness.changeOwnPassword.mockReset();
  harness.changeOwnPassword.mockResolvedValue({ error: null });
  harness.signOut.mockReset();
  harness.signOut.mockResolvedValue({ error: null });
  harness.refetch.mockReset();
  harness.signInWithPassword.mockReset();
  harness.signInWithPassword.mockResolvedValue({ error: null });
  fetchSpy.mockClear();
  vi.stubGlobal('fetch', fetchSpy);
  goTo('#/');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const CHANGE_PASSWORD_HEADING = /choose your own password/i;

describe('a profile with an outstanding forced change is sent to /change-password', () => {
  // Every address a person could arrive at, including the three that a guard
  // living anywhere other than the route table would let through.
  for (const route of ['#/', '#/samples', '#/admin', '#/reports', '#/stage/raw_material']) {
    it(`redirects ${route}`, async () => {
      harness.mustChangePassword = true;
      goTo(route);

      render(<App />);

      expect(
        await screen.findByRole('heading', { name: CHANGE_PASSWORD_HEADING, level: 1 }),
      ).toBeInTheDocument();
      await waitFor(() => expect(currentRoute()).toBe('#/change-password'));
    });
  }

  it('mounts no other route, so nothing behind the gate can load data', async () => {
    harness.mustChangePassword = true;
    goTo('#/samples');

    render(<App />);
    await screen.findByRole('heading', { name: CHANGE_PASSWORD_HEADING, level: 1 });

    // The app shell is absent too — not merely hidden. If `AppLayout` had
    // mounted, its navigation would be here.
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('still lets the person sign out', async () => {
    harness.mustChangePassword = true;
    render(<App />);
    await screen.findByRole('heading', { name: CHANGE_PASSWORD_HEADING, level: 1 });

    await userEvent.click(screen.getByRole('button', { name: /sign out/i }));
    expect(harness.signOut).toHaveBeenCalledTimes(1);
  });

  it('states the length rule before anything is typed', async () => {
    harness.mustChangePassword = true;
    render(<App />);
    await screen.findByRole('heading', { name: CHANGE_PASSWORD_HEADING, level: 1 });

    // Derived from the constant, not written out: a hard-coded "10" would keep
    // passing after the rule changed, while the screen told people the wrong
    // number.
    expect(
      screen.getByText(new RegExp(`at least ${MIN_PASSWORD_LENGTH} characters`, 'i')),
    ).toBeInTheDocument();

    const newPassword = screen.getByLabelText(/^new password/i);
    expect(newPassword).toHaveAttribute('type', 'password');
    expect(newPassword).toHaveAttribute('autocomplete', 'new-password');
  });
});

describe('a profile with no outstanding change is left alone', () => {
  it('does not redirect a deep link', async () => {
    harness.mustChangePassword = false;
    goTo('#/samples');

    render(<App />);

    // The address is untouched and the password screen is nowhere.
    await waitFor(() => expect(currentRoute()).toBe('#/samples'));
    expect(
      screen.queryByRole('heading', { name: CHANGE_PASSWORD_HEADING, level: 1 }),
    ).not.toBeInTheDocument();
  });

  it('can still reach /change-password on purpose', async () => {
    // The route exists for somebody who simply wants a different password.
    // Without this, a bookmark to a real address would render "not found".
    harness.mustChangePassword = false;
    goTo('#/change-password');

    render(<App />);

    expect(
      await screen.findByRole('heading', { name: CHANGE_PASSWORD_HEADING, level: 1 }),
    ).toBeInTheDocument();
    expect(currentRoute()).toBe('#/change-password');
  });
});

describe('the other two gates still answer first', () => {
  it('sends a signed-out visitor to /login, whatever they asked for', async () => {
    harness.sessionStatus = 'signed_out';
    goTo('#/samples');

    render(<App />);

    expect(
      await screen.findByRole('heading', { name: /bff sample testing/i, level: 1 }),
    ).toBeInTheDocument();
    await waitFor(() => expect(currentRoute()).toBe('#/login'));
    expect(
      screen.queryByRole('heading', { name: CHANGE_PASSWORD_HEADING, level: 1 }),
    ).not.toBeInTheDocument();
  });

  it('shows a pending account the account answer, not the password answer', async () => {
    // ORDER, ASSERTED, AND IT IS A DECISION RATHER THAN AN ACCIDENT.
    //
    // Both branches describe something true of a pending-and-armed account,
    // and only one of them is STILL true after the holder has done everything
    // in their power: changing the password does not approve the account,
    // whereas being approved does not discharge the password. So the honest
    // headline is the approval, and the password change is offered as the
    // action — see the block below, which is the other half of this decision
    // and without which this assertion would be defending a dead end.
    //
    // It also mirrors `public.require_permission`, which checks status BEFORE
    // the credential, so the screen agrees with the reason the server would
    // give; and it keeps the change-password screen's own success message
    // ("from here on the records you sign are yours") out of a flow where it
    // would be the whole answer to an account that still cannot see anything.
    harness.profileState = 'not_active';
    harness.status = 'pending';
    harness.mustChangePassword = true;
    goTo('#/samples');

    render(<App />);

    expect(
      await screen.findByRole('heading', { name: /waiting for approval/i, level: 1 }),
    ).toBeInTheDocument();
    await waitFor(() => expect(currentRoute()).toBe('#/pending'));
  });

  it('lets a pending account clear its temporary password if it asks', async () => {
    // Migration 0019 gives `rpc_record_password_changed` no status check for
    // exactly this: "a 'pending' administrator-created account must be able to
    // clear its temporary credential before it is approved". The server
    // permits it, so the UI offers it.
    harness.profileState = 'not_active';
    harness.status = 'pending';
    harness.mustChangePassword = true;
    goTo('#/change-password');

    render(<App />);

    expect(
      await screen.findByRole('heading', { name: CHANGE_PASSWORD_HEADING, level: 1 }),
    ).toBeInTheDocument();
  });
});

describe('the change-password form', () => {
  beforeEach(() => {
    harness.mustChangePassword = true;
  });

  async function openForm() {
    render(<App />);
    await screen.findByRole('heading', { name: CHANGE_PASSWORD_HEADING, level: 1 });
    return {
      newPassword: screen.getByLabelText(/^new password/i),
      confirmation: screen.getByLabelText(/^type the new password again/i),
      submit: screen.getByRole('button', { name: /save my password/i }),
    };
  }

  it('refuses a password shorter than the rule, and says the real length', async () => {
    const form = await openForm();
    const short = 'a'.repeat(MIN_PASSWORD_LENGTH - 1);

    await userEvent.type(form.newPassword, short);
    await userEvent.type(form.confirmation, short);
    await userEvent.click(form.submit);

    const summary = await screen.findByRole('alert');
    expect(summary).toHaveTextContent(new RegExp(`at least ${MIN_PASSWORD_LENGTH}`, 'i'));
    expect(summary).toHaveTextContent(new RegExp(`has ${short.length}`));
    expect(harness.changeOwnPassword).not.toHaveBeenCalled();
  });

  it('refuses a password too long to be stored in full, and sends nothing', async () => {
    // bcrypt discards everything past the 72nd byte, so a longer password
    // would be accepted, truncated, and the temporary one the administrator
    // typed could still open the account. Caught here rather than on submit,
    // because the whole point of the hint is that the rule is known in
    // advance.
    const form = await openForm();
    const tooLong = 'x'.repeat(MAX_PASSWORD_BYTES + 1);

    await userEvent.type(form.newPassword, tooLong);
    await userEvent.type(form.confirmation, tooLong);
    await userEvent.click(form.submit);

    expect(await screen.findByRole('alert')).toHaveTextContent(/too long to be stored/i);
    expect(harness.changeOwnPassword).not.toHaveBeenCalled();
  });

  it('refuses two entries that do not match, and sends nothing', async () => {
    const form = await openForm();

    await userEvent.type(form.newPassword, 'correct-horse-battery');
    await userEvent.type(form.confirmation, 'correct-horse-batterz');
    await userEvent.click(form.submit);

    expect(await screen.findByRole('alert')).toHaveTextContent(/not the same/i);
    expect(harness.changeOwnPassword).not.toHaveBeenCalled();
  });

  it('sends the new password once and then re-reads the profile', async () => {
    const form = await openForm();
    const chosen = 'correct-horse-battery';

    await userEvent.type(form.newPassword, chosen);
    await userEvent.type(form.confirmation, chosen);
    await userEvent.click(form.submit);

    await waitFor(() => expect(harness.changeOwnPassword).toHaveBeenCalledWith(chosen));
    expect(harness.changeOwnPassword).toHaveBeenCalledTimes(1);
    // The whole point of invalidating: the app must re-read the now-unblocked
    // state rather than keep the one that put this screen on the tablet.
    await waitFor(() => expect(harness.refetch).toHaveBeenCalled());
  });

  it('reports a refusal from the server without claiming the password changed', async () => {
    harness.changeOwnPassword.mockResolvedValue({
      error: new Error('The server refused: that password has been used before.'),
    });
    const form = await openForm();
    const chosen = 'correct-horse-battery';

    await userEvent.type(form.newPassword, chosen);
    await userEvent.type(form.confirmation, chosen);
    await userEvent.click(form.submit);

    expect(await screen.findByRole('alert')).toHaveTextContent(/used before/i);
    // Still on the form, and no success claimed.
    expect(screen.getByRole('button', { name: /save my password/i })).toBeInTheDocument();
    expect(screen.queryByText(/your password is set/i)).not.toBeInTheDocument();
  });

  it('disables the submit button while the change is in flight', async () => {
    let release: (value: { error: Error | null }) => void = () => {};
    harness.changeOwnPassword.mockImplementation(
      () =>
        new Promise<{ error: Error | null }>((resolve) => {
          release = resolve;
        }),
    );

    const form = await openForm();
    const chosen = 'correct-horse-battery';
    await userEvent.type(form.newPassword, chosen);
    await userEvent.type(form.confirmation, chosen);
    await userEvent.click(form.submit);

    await waitFor(() => expect(harness.changeOwnPassword).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('button', { name: /saving your password/i })).toBeDisabled();

    release({ error: null });
    await waitFor(() => expect(harness.refetch).toHaveBeenCalled());
  });
});

describe('the sign-in screen offers both routes and no dead ends', () => {
  beforeEach(() => {
    harness.sessionStatus = 'signed_out';
    goTo('#/login');
  });

  it('offers Google and email side by side', async () => {
    render(<App />);
    expect(
      await screen.findByRole('button', { name: /sign in with google/i }),
    ).toBeInTheDocument();

    const email = screen.getByLabelText(/email address/i);
    expect(email).toHaveAttribute('type', 'email');
    expect(email).toHaveAttribute('autocomplete', 'username');

    const password = screen.getByLabelText(/^password/i);
    expect(password).toHaveAttribute('type', 'password');
    expect(password).toHaveAttribute('autocomplete', 'current-password');

    expect(screen.getByRole('button', { name: /^sign in$/i })).toHaveAttribute(
      'type',
      'submit',
    );
  });

  it('offers no sign-up and no reset link, because neither could work', async () => {
    render(<App />);
    await screen.findByRole('button', { name: /sign in with google/i });

    // There is no SMTP on this project, so a reset link would send nothing and
    // a signup link would wait for a confirmation email that never arrives.
    // Asserted as the absence of a CONTROL, not of the words: the screen does
    // say what to do when a password has been forgotten.
    for (const control of [...screen.queryAllByRole('link'), ...screen.queryAllByRole('button')]) {
      expect(control.textContent ?? '').not.toMatch(
        /forgot .*\?|reset (my )?password|create an account|sign up|register/i,
      );
    }
    expect(screen.getByText(/ask your quality supervisor or an administrator/i)).toBeInTheDocument();
  });
});

describe('the email and password sign-in form', () => {
  beforeEach(() => {
    harness.sessionStatus = 'signed_out';
    goTo('#/login');
  });

  async function openLogin() {
    render(<App />);
    await screen.findByRole('button', { name: /sign in with google/i });
    return {
      email: screen.getByLabelText(/email address/i),
      password: screen.getByLabelText(/^password/i),
      submit: screen.getByRole('button', { name: /^sign in$/i }),
    };
  }

  it('submits the pair as typed, trimming nothing from the password', async () => {
    const form = await openLogin();
    await userEvent.type(form.email, 'operator@example.com');
    await userEvent.type(form.password, 'temp-pass-123');
    await userEvent.click(form.submit);

    await waitFor(() =>
      expect(harness.signInWithPassword).toHaveBeenCalledWith(
        'operator@example.com',
        'temp-pass-123',
      ),
    );
  });

  it('disables the submit button while the attempt is in flight', async () => {
    let release: (value: { error: Error | null }) => void = () => {};
    harness.signInWithPassword.mockImplementation(
      () =>
        new Promise<{ error: Error | null }>((resolve) => {
          release = resolve;
        }),
    );

    const form = await openLogin();
    await userEvent.type(form.email, 'operator@example.com');
    await userEvent.type(form.password, 'temp-pass-123');
    await userEvent.click(form.submit);

    await waitFor(() => expect(harness.signInWithPassword).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('button', { name: /signing in/i })).toBeDisabled();

    release({ error: null });
    // A second click must not produce a second attempt.
    await waitFor(() => expect(harness.signInWithPassword).toHaveBeenCalledTimes(1));
  });

  it('announces a refusal to a screen reader without naming which half was wrong', async () => {
    harness.signInWithPassword.mockResolvedValue({
      error: new Error('That email address and password were not accepted.'),
    });

    const form = await openLogin();
    await userEvent.type(form.email, 'operator@example.com');
    await userEvent.type(form.password, 'wrong');
    await userEvent.click(form.submit);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/were not accepted/i);
    // The non-enumerating claim, asserted as an absence. Telling somebody the
    // email is unknown would let anybody test whether an address has an
    // account here, and the server does not distinguish the two cases anyway.
    expect(alert.textContent ?? '').not.toMatch(
      /no such (email|account|user)|unknown email|email not found|incorrect password|wrong password/i,
    );
  });

  it('leaves a genuinely empty box to the browser, which blocks the submit', async () => {
    // Both controls are `required`, so the browser refuses the submit and puts
    // the cursor in the empty box before any handler runs. Asserted because
    // the app's own empty-box message would otherwise look like dead code:
    // the reachable case for it is the one below, not this one.
    const form = await openLogin();
    expect(form.email).toBeRequired();
    expect(form.password).toBeRequired();

    await userEvent.type(form.email, 'operator@example.com');
    await userEvent.click(form.submit);

    expect(harness.signInWithPassword).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('blocks a space-only address too, on the input type rather than on a handler', async () => {
    // MEASURED, NOT ASSUMED, and it changed what the page ships. The first
    // version of this suite asserted that the app's own "type your email
    // address and your password" message appears for an empty or
    // whitespace-only box. It never appears: `required` plus `type="email"`
    // means the browser refuses the submit and focuses the offending box
    // before React's handler runs, for an empty value AND for spaces. The
    // app's check is therefore a fallback against a future `noValidate`, not
    // the live path — so what is asserted is the behaviour that actually
    // reaches the operator.
    const form = await openLogin();
    expect(form.email).toHaveAttribute('type', 'email');

    await userEvent.type(form.email, '   ');
    await userEvent.type(form.password, 'temp-pass-123');
    await userEvent.click(form.submit);

    expect(harness.signInWithPassword).not.toHaveBeenCalled();
  });
});

describe('the landing screen a pending AND armed account reaches offers the remedy', () => {
  // THE DEFECT THIS CLOSES. The branch order above is right, and on its own it
  // produced a dead end: `PendingAccessPage` said nothing about passwords, so
  // the one action the holder could actually take was reachable only by typing
  // `#/change-password` by hand. Not a brick — worse than a brick, because
  // nothing on screen suggested there was anything to do.
  //
  // It matters more since migration 0020 gated `is_active_user()`: an armed
  // account now fails 36 of the 37 row-level-security policies, so every screen
  // it could land on renders with no data at all. `PendingAccessPage` holds no
  // query of its own, which makes it the one screen that provably renders
  // correctly for such an account — and therefore the right place to put the
  // route out.

  beforeEach(() => {
    harness.profileState = 'not_active';
    harness.status = 'pending';
    harness.mustChangePassword = true;
    goTo('#/pending');
  });

  it('names the password as something to do now, and links to the screen that does it', async () => {
    render(<App />);
    await screen.findByRole('heading', { name: /waiting for approval/i, level: 1 });

    const link = screen.getByRole('link', { name: /choose your own password/i });
    expect(link).toHaveAttribute('href', '#/change-password');
  });

  it('says why it is worth doing before approval, in terms of what it achieves', async () => {
    // Not "you must", which invites the reasonable question "or what?" — the
    // account is already refused everything. The reason is attribution: until
    // the password is replaced, two people can sign in as this account.
    render(<App />);
    await screen.findByRole('heading', { name: /waiting for approval/i, level: 1 });

    const main = screen.getByRole('main');
    expect(main).toHaveTextContent(/administrator who set up your account knows it/i);
    expect(main).toHaveTextContent(/only you/i);
  });

  it('does not claim the password change will grant access', async () => {
    // The failure mode of putting the remedy here: a person does it, nothing
    // changes, and they conclude the system is broken.
    render(<App />);
    await screen.findByRole('heading', { name: /waiting for approval/i, level: 1 });

    expect(screen.getByRole('main')).toHaveTextContent(
      /does not approve your account|still need|will not give you access/i,
    );
  });

  it('offers nothing about passwords when none is outstanding', async () => {
    // THE CONTROL. Without it, every assertion above is satisfied by a block
    // rendered unconditionally — which would tell every new Google sign-in to
    // go and change a password nobody set for them.
    harness.mustChangePassword = false;
    render(<App />);
    await screen.findByRole('heading', { name: /waiting for approval/i, level: 1 });

    expect(
      screen.queryByRole('link', { name: /choose your own password/i }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('main').textContent ?? '').not.toMatch(/password/i);
  });

  it('keeps Check again and Sign out, which are what the screen was for', async () => {
    // A regression guard rather than a new claim: the remedy block is an
    // addition, and the two things this screen already did must survive it.
    render(<App />);
    await screen.findByRole('heading', { name: /waiting for approval/i, level: 1 });

    expect(screen.getByRole('button', { name: /check again/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /sign out/i })).toBeInTheDocument();
  });

  it('describes an administrator-created account as such, not as a Google sign-in', async () => {
    // The copy said "Your Google account has been recognised", which is false
    // for an account an administrator created with a temporary password:
    // nobody has signed in to it with Google at all. `UserRow` on the admin
    // screen already branches on `password_set_by_admin_at` for exactly this
    // reason; this is the same correction on the holder's side.
    render(<App />);
    await screen.findByRole('heading', { name: /waiting for approval/i, level: 1 });

    const main = screen.getByRole('main');
    expect(main.textContent ?? '').not.toMatch(/google account has been recognised/i);
    expect(main).toHaveTextContent(/created for you by an administrator/i);
  });

  it('still says Google for an account that did sign in with Google', async () => {
    // The control for the branch above: one wording for each way of arriving,
    // not one wording replacing the other.
    harness.mustChangePassword = false;
    render(<App />);
    await screen.findByRole('heading', { name: /waiting for approval/i, level: 1 });

    expect(screen.getByRole('main')).toHaveTextContent(/google account has been recognised/i);
  });
});

describe('following the remedy link from the pending screen', () => {
  it('reaches the change-password screen and keeps the approval fact in view', async () => {
    // The two screens have to agree. Arriving here from `#/pending`, the
    // person must not be told "before you start" — they cannot start — and
    // must not be left believing the change was pointless either.
    harness.profileState = 'not_active';
    harness.status = 'pending';
    harness.mustChangePassword = true;
    goTo('#/pending');

    render(<App />);
    await screen.findByRole('heading', { name: /waiting for approval/i, level: 1 });

    await userEvent.click(screen.getByRole('link', { name: /choose your own password/i }));

    expect(
      await screen.findByRole('heading', { name: CHANGE_PASSWORD_HEADING, level: 1 }),
    ).toBeInTheDocument();
    expect(screen.getByRole('main')).toHaveTextContent(/still waiting for approval/i);
    expect(screen.getByRole('main').textContent ?? '').not.toMatch(/before you start/i);
  });

  it('says plainly, after the change, that approval is still outstanding', async () => {
    // The success screen's own words are "from here on the records you sign
    // are yours" and a Continue button to the dashboard. For an unapproved
    // account the router sends them back to `#/pending`, so the success screen
    // must have said why rather than letting the bounce say it.
    harness.profileState = 'not_active';
    harness.status = 'pending';
    harness.mustChangePassword = true;
    goTo('#/change-password');

    render(<App />);
    await screen.findByRole('heading', { name: CHANGE_PASSWORD_HEADING, level: 1 });

    const chosen = 'correct-horse-battery';
    await userEvent.type(screen.getByLabelText(/^new password/i), chosen);
    await userEvent.type(screen.getByLabelText(/^type the new password again/i), chosen);
    await userEvent.click(screen.getByRole('button', { name: /save my password/i }));

    expect(await screen.findByRole('heading', { name: /your password is set/i })).toBeInTheDocument();
    expect(screen.getByRole('main')).toHaveTextContent(/still waiting for approval/i);
  });

  it('says nothing about approval for an active account — the control', async () => {
    // The approval wording is conditional. An ordinary forced change must not
    // acquire a sentence about an approval that already happened.
    harness.profileState = 'active';
    harness.status = 'active';
    harness.mustChangePassword = true;
    goTo('#/change-password');

    render(<App />);
    await screen.findByRole('heading', { name: CHANGE_PASSWORD_HEADING, level: 1 });

    expect(screen.getByRole('main').textContent ?? '').not.toMatch(/waiting for approval/i);
    expect(screen.getByRole('main')).toHaveTextContent(/before you start/i);
  });
});

describe('a suspended account that also owes a password change', () => {
  it('is told about the suspension, and is still offered the remedy', async () => {
    // ONE RULE, NO STATUS EXEMPTION. Neither `change-own-password` nor
    // `rpc_record_password_changed` has a status check — both say so in their
    // own comments, deliberately — so the server permits this for every
    // status. A status-keyed exemption here would be a loophole rather than a
    // rule, and the copy is what carries the honesty: it never implies access.
    harness.profileState = 'not_active';
    harness.status = 'suspended';
    harness.mustChangePassword = true;
    goTo('#/samples');

    render(<App />);

    expect(
      await screen.findByRole('heading', { name: /access is suspended/i, level: 1 }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /choose your own password/i }),
    ).toHaveAttribute('href', '#/change-password');
  });

  it('is told about the suspension and nothing else when no change is owed', async () => {
    harness.profileState = 'not_active';
    harness.status = 'suspended';
    harness.mustChangePassword = false;
    goTo('#/samples');

    render(<App />);

    await screen.findByRole('heading', { name: /access is suspended/i, level: 1 });
    expect(
      screen.queryByRole('link', { name: /choose your own password/i }),
    ).not.toBeInTheDocument();
  });
});
