/**
 * The administration screen, rendered, for the three claims only a render can
 * settle.
 *
 * ===========================================================================
 * WHAT THIS SUITE IS FOR
 * ===========================================================================
 * `tests/adminPasswords.test.ts` proves the generator, the forced-change rule
 * and the request body as pure functions. None of that shows:
 *
 *  1. THAT THE TEMPORARY PASSWORD IS SHOWN ONCE AND THEN GONE. "Shown once" is
 *     a statement about the DOM over time, so it is asserted over time: the
 *     password is absent before, present after the server confirms, and absent
 *     again after the panel is dismissed — including from the form field that
 *     produced it, which is the place a careless implementation leaves it.
 *
 *  2. THAT THE REQUEST ACTUALLY CARRIES THE IDEMPOTENCY KEY. The body builder
 *     puts it in the body; only the real hook puts it in the HEADER, and the
 *     header is what `runMutation` reads first and refuses the request for.
 *     Every administrative action on this screen was being refused for want of
 *     it, which no unit test could see.
 *
 *  3. THAT THE FORCED-CHANGE STATE REACHES THE SCREEN FROM THE TWO COLUMNS.
 *     The columns are new, the select string that reads them is a plain string
 *     PostgREST interprets, and the rule that turns them into a label lives in
 *     a different file from the label.
 *
 * `AdminPage` is rendered with only its two outside edges replaced: the
 * Supabase client (a chainable stub over fixed rows, and a spy for
 * `functions.invoke`) and `useAuthority` (a signed-in administrator). The real
 * `useAdmin` runs — it is the thing under test — so the select strings, the
 * mapping and the mutation are all genuine. Nothing here reaches the network;
 * `invoke` is a spy and the stub answers from memory.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';

vi.stubEnv('VITE_SUPABASE_URL', 'https://test.supabase.co');
vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'test-anon-key');

/** Rows the chainable stub answers with, reassigned per test. */
let tables: Record<string, readonly unknown[]> = {};
const invoke = vi.fn();

vi.mock('@/lib/supabase', () => {
  /**
   * The shape `useAdmin` actually uses: `.from(t).select(c)` awaited directly,
   * or followed by `.order(...)` / `.in(...)` and then awaited. The object is
   * thenable so both forms resolve, which is why `select` can be the end of
   * the chain in one call site and the middle of it in another.
   */
  function builder(table: string) {
    const settle = () =>
      Promise.resolve({ data: tables[table] ?? [], error: null, count: (tables[table] ?? []).length });
    const chain = {
      select: () => chain,
      order: () => chain,
      in: () => chain,
      eq: () => chain,
      ilike: () => chain,
      gte: () => chain,
      lt: () => chain,
      limit: () => chain,
      range: () => chain,
      then: (...args: Parameters<Promise<unknown>['then']>) => settle().then(...args),
    };
    return chain;
  }
  return {
    supabase: { from: (table: string) => builder(table), functions: { invoke } },
  };
});

vi.mock('@/hooks/useSamples', async (importOriginal) => {
  // Partial: `useAdmin` imports FUNCTIONS and TABLES from here, and replacing
  // those with invented values would make every assertion about table names
  // and function names vacuous.
  const actual = await importOriginal<typeof import('@/hooks/useSamples')>();
  return {
    ...actual,
    useAuthority: () => ({
      user: {
        id: 'actor-0000-0000-0000-000000000001',
        email: 'admin@example.test',
        fullName: 'An Administrator',
        status: 'active' as const,
        roles: ['administrator' as const],
        delegations: [],
      },
      allows: () => true,
    }),
  };
});

const { default: AdminPage } = await import('@/pages/AdminPage');

const RESET_AT = '2026-10-20T12:00:00.000+00:00';

/** One profile row in the shape `fetchAdminUsers` selects. */
function profile(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 'user-1',
    email: 'operator@example.test',
    display_name: 'An Operator',
    status: 'active',
    created_at: '2026-10-01T12:00:00.000+00:00',
    password_set_by_admin_at: null,
    password_changed_at: null,
    ...over,
  };
}

function mount(element: ReactElement = <AdminPage />) {
  // Retries off: a test that asserts a failure must not wait out two retries,
  // and the app's own mutations never retry either.
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: 0 } },
  });
  return render(<QueryClientProvider client={client}>{element}</QueryClientProvider>);
}

beforeEach(() => {
  tables = { profiles: [profile()], user_roles: [] };
  invoke.mockReset();
  invoke.mockResolvedValue({ data: { ok: true, message: 'Done.' }, error: null });
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Fill the create-account form and press through the reason dialog. */
async function createAccount(options: { readonly reason?: string } = {}) {
  const user = userEvent.setup();
  mount();
  await user.type(await screen.findByLabelText(/email address/i), 'newhire@example.test');
  await user.type(screen.getByLabelText(/full name/i), 'A New Hire');
  await user.click(
    screen.getByRole('button', { name: /^Generate a temporary password for the new account$/i }),
  );

  const field = screen.getByLabelText(
    /^Temporary password for the new account$/i,
  ) as HTMLInputElement;
  const generated = field.value;
  expect(generated).not.toBe('');

  await user.click(screen.getByRole('button', { name: /continue and state the reason/i }));
  await user.type(
    within(await screen.findByRole('dialog')).getByRole('textbox'),
    options.reason ?? 'Authorised by the plant manager; identity confirmed in person.',
  );
  await user.click(screen.getByRole('button', { name: /create the account/i }));
  return { user, generated };
}

describe('creating an account', () => {
  it('sends the contract payload, with the idempotency key in the header', async () => {
    const { generated } = await createAccount();

    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    const call = invoke.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(call[0]).toBe('admin-action');

    const body = call[1]['body'] as Record<string, unknown>;
    const headers = call[1]['headers'] as Record<string, string>;

    expect(body['action']).toBe('create_account');
    expect(body['email']).toBe('newhire@example.test');
    expect(body['displayName']).toBe('A New Hire');
    expect(body['temporaryPassword']).toBe(generated);
    expect(body['reason']).toMatch(/plant manager/);

    // THE HEADER. `runMutation` reads this before anything else and refuses
    // the request without it, and the same key is in the body as the
    // documented fallback for a proxy that strips custom headers.
    expect(headers['Idempotency-Key']).toMatch(/^[A-Za-z0-9_.:-]{16,128}$/);
    expect(body['idempotencyKey']).toBe(headers['Idempotency-Key']);
  });

  it('shows the password once, then makes that true', async () => {
    const { user, generated } = await createAccount();

    const panel = await screen.findByRole('alert', { name: /temporary password, shown once/i });
    expect(within(panel).getByText(generated)).toBeInTheDocument();
    expect(panel).toHaveTextContent(/only time this password is shown/i);
    // The readout, which is the whole reason the alphabet is what it is.
    expect(panel).toHaveTextContent(/to read out:/i);

    await user.click(
      within(panel).getByRole('button', { name: /i have given it to them/i }),
    );

    // Gone from the panel...
    await waitFor(() =>
      expect(
        screen.queryByRole('alert', { name: /temporary password, shown once/i }),
      ).not.toBeInTheDocument(),
    );
    // ...and gone from the form that made it, which is the half a careless
    // implementation leaves behind. Nothing on the screen holds it now.
    expect(
      (screen.getByLabelText(/^Temporary password for the new account$/i) as HTMLInputElement)
        .value,
    ).toBe('');
    expect(document.body.textContent ?? '').not.toContain(generated);
  });

  it('says plainly that the act was not confirmed when the server refuses', async () => {
    invoke.mockResolvedValue({ data: null, error: new Error('network down') });

    const { generated } = await createAccount();

    const panel = await screen.findByRole('alert', { name: /temporary password, shown once/i });
    // Still shown — it was sent, so the administrator has to know what was
    // sent — but not claimed to work.
    expect(within(panel).getByText(generated)).toBeInTheDocument();
    expect(panel).toHaveTextContent(/did not confirm/i);

    // And the page-level message must not say "Nothing was changed", because
    // for this action that is a claim nobody can make.
    const failure = await screen.findByText(/was not confirmed/i, { selector: 'p' });
    expect(failure).toHaveTextContent(/may or may not have taken effect/i);
    expect(failure.textContent ?? '').not.toMatch(/nothing was changed/i);
  });

  it('discards the password when the reason dialog is cancelled', async () => {
    // THE PATH THE REMOUNT DOES NOT COVER, and the reason the explicit clear
    // is not redundant with it. Pressing Go back means the action never
    // settles, so `formGeneration` never changes and the form is never
    // remounted; only the clear on submit empties the field. Without this
    // scenario, removing that clear breaks a real path and every other test
    // here still passes — the two mechanisms hide each other's loss.
    const user = userEvent.setup();
    mount();
    await user.type(await screen.findByLabelText(/email address/i), 'newhire@example.test');
    await user.type(screen.getByLabelText(/full name/i), 'A New Hire');
    await user.click(
      screen.getByRole('button', { name: /^Generate a temporary password for the new account$/i }),
    );
    const field = screen.getByLabelText(
      /^Temporary password for the new account$/i,
    ) as HTMLInputElement;
    const generated = field.value;
    expect(generated).not.toBe('');

    await user.click(screen.getByRole('button', { name: /continue and state the reason/i }));
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: /go back/i }),
    );

    expect(invoke).not.toHaveBeenCalled();
    // No panel, because nothing was sent — and nothing left in the box
    // either, so a password composed for a hand-over that did not happen is
    // not sitting on an unattended plant tablet.
    expect(
      screen.queryByRole('alert', { name: /temporary password, shown once/i }),
    ).not.toBeInTheDocument();
    expect(
      (screen.getByLabelText(/^Temporary password for the new account$/i) as HTMLInputElement)
        .value,
    ).toBe('');
    expect(document.body.textContent ?? '').not.toContain(generated);
    // The address and the name survive, so cancelling to re-read a note does
    // not mean typing the person's details again.
    expect((screen.getByLabelText(/email address/i) as HTMLInputElement).value).toBe(
      'newhire@example.test',
    );
  });

  it('refuses a malformed address without sending anything', async () => {
    const user = userEvent.setup();
    mount();
    await user.type(await screen.findByLabelText(/email address/i), 'not-an-address');
    await user.type(screen.getByLabelText(/full name/i), 'A New Hire');
    await user.click(
      screen.getByRole('button', { name: /^Generate a temporary password for the new account$/i }),
    );
    await user.click(screen.getByRole('button', { name: /continue and state the reason/i }));

    expect(await screen.findByText(/type the email address/i)).toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('refuses a password shorter than a generated one, without sending anything', async () => {
    const user = userEvent.setup();
    mount();
    await user.type(await screen.findByLabelText(/email address/i), 'newhire@example.test');
    await user.type(screen.getByLabelText(/full name/i), 'A New Hire');
    await user.type(
      screen.getByLabelText(/^Temporary password for the new account$/i),
      'short',
    );
    await user.click(screen.getByRole('button', { name: /continue and state the reason/i }));

    expect(await screen.findByText(/at least \d+ characters/i)).toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe('resetting a password on an existing account', () => {
  it('sends set_password for that account and nothing about its roles', async () => {
    const user = userEvent.setup();
    mount();
    await screen.findByText('An Operator');

    // Named after the account, so the row's Generate button is not the create
    // form's — which is exactly why it is named after the account.
    await user.click(
      screen.getByRole('button', { name: /^Generate a temporary password for An Operator$/i }),
    );
    const rowField = screen.getByLabelText(
      /^Temporary password for An Operator$/i,
    ) as HTMLInputElement;
    expect(rowField.value).not.toBe('');
    // Filling the row's field must not have filled the create form's: they
    // are two independent drafts, and a shared one would send the wrong
    // password to the wrong account.
    expect(
      (screen.getByLabelText(/^Temporary password for the new account$/i) as HTMLInputElement)
        .value,
    ).toBe('');
    // Captured BEFORE the submit, because the field is cleared the moment the
    // password is handed over — which is the behaviour that makes the panel's
    // "shown once" claim true, and is asserted as such below.
    const sent = rowField.value;

    await user.click(screen.getByRole('button', { name: /^reset password$/i }));
    await user.type(
      within(await screen.findByRole('dialog')).getByRole('textbox'),
      'Forgotten password; identity confirmed by the shift supervisor.',
    );
    await user.click(screen.getByRole('button', { name: /set this temporary password/i }));

    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    const call = invoke.mock.calls[0] as unknown as [string, Record<string, unknown>];
    const body = call[1]['body'] as Record<string, unknown>;
    expect(body['action']).toBe('set_password');
    expect(body['userId']).toBe('user-1');
    expect(body['temporaryPassword']).toBe(sent);
    // The field it came from is empty now.
    expect(rowField.value).toBe('');
    // A password reset must not carry anything that would let the function
    // change the account's identity or authority as a side effect.
    expect('roles' in body).toBe(false);
    expect('email' in body).toBe(false);
    expect('displayName' in body).toBe(false);
    expect('status' in body).toBe(false);
  });

  it('states what will happen to the holder, before it happens', async () => {
    mount();
    await screen.findByText('An Operator');
    // The brief's requirement, asserted where the administrator reads it
    // rather than left to the confirmation dialog.
    expect(
      screen.getByText(/required to choose a new one the next time they sign in/i),
    ).toBeInTheDocument();
  });
});

describe('the forced-change state, read from the two new columns', () => {
  it('says nothing when no administrator has set a password', async () => {
    mount();
    await screen.findByText('An Operator');
    expect(
      screen.queryByText(/password an administrator knows/i),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(/only ever signed in with Google/i),
    ).toBeInTheDocument();
  });

  it('labels an account whose holder has never chosen their own password', async () => {
    tables = {
      profiles: [profile({ password_set_by_admin_at: RESET_AT })],
      user_roles: [],
    };
    mount();

    // The chip, which is the at-a-glance answer...
    const chips = await screen.findAllByText(/password an administrator knows/i);
    expect(chips.length).toBeGreaterThan(0);
    // ...and the summary, which is the auditor's count, naming the person.
    expect(
      screen.getByText(/1 account is still using a password an administrator knows/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/they have never chosen one/i)).toBeInTheDocument();
  });

  it('clears the label once the holder has chosen one after the reset', async () => {
    tables = {
      profiles: [
        profile({
          password_set_by_admin_at: RESET_AT,
          password_changed_at: '2026-10-21T12:00:00.000+00:00',
        }),
      ],
      user_roles: [],
    };
    mount();

    await screen.findByText(/No administrator knows it/i);
    expect(screen.queryByText(/password an administrator knows/i)).not.toBeInTheDocument();
  });

  it('keeps the label on an exact tie, as the contract rule requires', async () => {
    tables = {
      profiles: [
        profile({ password_set_by_admin_at: RESET_AT, password_changed_at: RESET_AT }),
      ],
      user_roles: [],
    };
    mount();

    expect(
      (await screen.findAllByText(/password an administrator knows/i)).length,
    ).toBeGreaterThan(0);
  });

  it('counts every such account, suspended ones included', async () => {
    tables = {
      profiles: [
        profile({ id: 'user-1', display_name: 'An Operator', password_set_by_admin_at: RESET_AT }),
        profile({
          id: 'user-2',
          email: 'second@example.test',
          display_name: 'A Second Operator',
          status: 'suspended',
          password_set_by_admin_at: RESET_AT,
        }),
        profile({ id: 'user-3', email: 'third@example.test', display_name: 'A Third Operator' }),
      ],
      user_roles: [],
    };
    mount();

    // The count is inside a <strong>; the names follow it as a sibling text
    // node, so the assertion has to be made on the whole note rather than on
    // the element the text query happens to return.
    const counted = await screen.findByText(
      /2 accounts are still using a password an administrator knows/i,
    );
    const summary = counted.closest('p');
    expect(summary).not.toBeNull();
    expect(summary).toHaveTextContent(/An Operator/);
    expect(summary).toHaveTextContent(/A Second Operator/);
    expect(summary?.textContent ?? '').not.toContain('A Third Operator');
  });

  it('tells the truth about how a pending account got there', async () => {
    tables = {
      profiles: [
        profile({
          id: 'user-1',
          display_name: 'A New Hire',
          status: 'pending',
          password_set_by_admin_at: RESET_AT,
        }),
      ],
      user_roles: [],
    };
    mount();

    // The old wording said every pending account "has signed in with Google",
    // which an administrator-created account has not — it is pending before
    // anybody has signed in to it at all.
    expect(
      await screen.findByText(/created here with a temporary password/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/has signed in with Google but can see no data/i)).toBeNull();
  });
});
