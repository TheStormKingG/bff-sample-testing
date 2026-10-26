/**
 * The plaintext temporary password is not in the TanStack mutation cache —
 * measured in the real cache, not inferred from the source.
 *
 * ===========================================================================
 * WHAT THE PREVIOUS GUARD ACTUALLY ASSERTED
 * ===========================================================================
 * The scrub was `action.reset()` in `onSettled`, and the test defending it
 * matched the source text for that call. That pair is a tautology: deleting the
 * call makes a search for the call fail, so it survives a mutation probe with
 * full marks while saying nothing about the credential. The property —
 * "the cache no longer holds the secret" — was never measured, and it was
 * false.
 *
 * `MutationObserver.reset()` in `@tanstack/query-core` does two things:
 *
 *     reset() { this.#currentMutation?.removeObserver(this);
 *               this.#currentMutation = void 0; }
 *
 * It detaches the OBSERVER. It does not touch the MUTATION's state, and the
 * Mutation — with `state.variables.temporaryPassword` still in it — stays in
 * the MutationCache. `removeObserver` calls `scheduleGc()`, so the object is
 * removed by a timer `gcTime` later: five minutes by default, and
 * `src/lib/queryClient.ts` sets `gcTime` for queries only.
 *
 * ===========================================================================
 * WHY THIS SUITE READS THE CACHE AND NOT THE SOURCE
 * ===========================================================================
 * A release API is a claim about a REFERENCE, not about memory, and the only
 * way to tell the two apart is to read the store back. So the fix is not a
 * better scrub: the credential never enters the mutation variables at all, and
 * what is asserted below is the absence of the plaintext from every field of
 * every mutation the real `AdminPage` created, through the real `useAdmin`.
 *
 * Two halves, and the second is what makes the first mean anything:
 *
 *   ABSENCE   the generated password appears nowhere in the mutation cache.
 *   PRESENCE  a non-secret value sent in the SAME request — the operator's
 *             written reason — does appear there. Without this, every
 *             assertion in the file is satisfied by a probe that reads the
 *             wrong object, or an empty cache, and reports a clean result.
 *
 * And a third, because a credential that never reaches the server is not a
 * fix: the password is still on the wire, in the request body, where it is the
 * only place it can be.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.stubEnv('VITE_SUPABASE_URL', 'https://test.supabase.co');
vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'test-anon-key');

let tables: Record<string, readonly unknown[]> = {};
const invoke = vi.fn();

vi.mock('@/lib/supabase', () => {
  function builder(table: string) {
    const settle = () =>
      Promise.resolve({
        data: tables[table] ?? [],
        error: null,
        count: (tables[table] ?? []).length,
      });
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
  return { supabase: { from: (table: string) => builder(table), functions: { invoke } } };
});

vi.mock('@/hooks/useSamples', async (importOriginal) => {
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
const { temporaryPasswordStashSize } = await import('@/hooks/useAdmin');

const REASON = 'Authorised by the plant manager; identity confirmed in person.';

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

/** The client under inspection — kept in scope so its cache can be read. */
let client: QueryClient;

function mount() {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: 0 } },
  });
  return render(
    <QueryClientProvider client={client}>
      <AdminPage />
    </QueryClientProvider>,
  );
}

/**
 * Everything the mutation cache is holding, serialised.
 *
 * `state` is dumped whole rather than `state.variables` alone: `variables` is
 * where the credential was, but `data`, `error` and `context` are the same kind
 * of store and a later edit could route it through any of them. The mutation
 * key and options are included for the same reason.
 */
function mutationCacheDump(): string {
  const all = client.getMutationCache().getAll();
  return JSON.stringify(
    all.map((mutation) => ({
      state: mutation.state,
      mutationKey: mutation.options.mutationKey ?? null,
      meta: mutation.options.meta ?? null,
    })),
  );
}

function mutationCount(): number {
  return client.getMutationCache().getAll().length;
}

beforeEach(() => {
  tables = { profiles: [profile()], user_roles: [] };
  invoke.mockReset();
  invoke.mockResolvedValue({ data: { ok: true, message: 'Done.' }, error: null });
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Create an account, returning the password the screen generated. */
async function createAccount() {
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
  await user.type(within(await screen.findByRole('dialog')).getByRole('textbox'), REASON);
  await user.click(screen.getByRole('button', { name: /create the account/i }));
  await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
  return { user, generated };
}

/** Reset an existing account's password, returning the password sent. */
async function resetPassword() {
  const user = userEvent.setup();
  mount();
  await screen.findByText('An Operator');
  await user.click(
    screen.getByRole('button', { name: /^Generate a temporary password for An Operator$/i }),
  );
  const field = screen.getByLabelText(
    /^Temporary password for An Operator$/i,
  ) as HTMLInputElement;
  const generated = field.value;
  expect(generated).not.toBe('');

  await user.click(screen.getByRole('button', { name: /^reset password$/i }));
  await user.type(
    within(await screen.findByRole('dialog')).getByRole('textbox'),
    'Forgotten password; identity confirmed by the shift supervisor.',
  );
  await user.click(screen.getByRole('button', { name: /set this temporary password/i }));
  await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
  return { user, generated };
}

describe('the probe itself', () => {
  it('can see a non-secret value the same request carried', async () => {
    // THE POSITIVE CONTROL, and the reason the absences below are evidence.
    // The operator's written reason travels in the same `mutate` call as the
    // credential did, so if the probe were reading the wrong object — or an
    // empty cache — this would fail and the absence assertions would pass for
    // the wrong reason.
    await createAccount();

    expect(mutationCount()).toBeGreaterThan(0);
    expect(mutationCacheDump()).toContain('plant manager');
  });
});

describe('creating an account', () => {
  it('leaves no copy of the password in the mutation cache', async () => {
    const { generated } = await createAccount();

    expect(mutationCacheDump()).not.toContain(generated);
  });

  it('still sends the password to the server, which is the only place it goes', async () => {
    // A credential kept out of the cache by not being sent is not a fix. The
    // request body is the one place the plaintext must appear.
    const { generated } = await createAccount();

    const body = (invoke.mock.calls[0]![1] as { body: Record<string, unknown> }).body;
    expect(body['temporaryPassword']).toBe(generated);
    expect(body['action']).toBe('create_account');
  });

  it('keeps nothing in the hand-off stash once the request has been built', async () => {
    // The stash exists only to carry the credential from the click handler to
    // the request body without passing through the mutation variables. It is
    // read-and-delete, so an entry surviving the request would be a new
    // retention site replacing the one that was closed.
    await createAccount();

    expect(temporaryPasswordStashSize()).toBe(0);
  });

  it('holds no copy after the one-time panel is dismissed', async () => {
    // Over time, not at one instant. The deliberate on-screen copy is cleared
    // by the panel; nothing else may outlive it.
    const { user, generated } = await createAccount();

    const panel = await screen.findByRole('alert', { name: /temporary password, shown once/i });
    expect(within(panel).getByText(generated)).toBeInTheDocument();

    await user.click(within(panel).getByRole('button', { name: /i have given it to them/i }));
    await waitFor(() =>
      expect(
        screen.queryByRole('alert', { name: /temporary password, shown once/i }),
      ).not.toBeInTheDocument(),
    );

    expect(document.body.textContent ?? '').not.toContain(generated);
    expect(mutationCacheDump()).not.toContain(generated);
    expect(temporaryPasswordStashSize()).toBe(0);
  });
});

describe('resetting an existing password', () => {
  it('leaves no copy of the password in the mutation cache', async () => {
    const { generated } = await resetPassword();

    expect(mutationCacheDump()).not.toContain(generated);
  });

  it('still sends it, under set_password for that account', async () => {
    const { generated } = await resetPassword();

    const body = (invoke.mock.calls[0]![1] as { body: Record<string, unknown> }).body;
    expect(body['action']).toBe('set_password');
    expect(body['userId']).toBe('user-1');
    expect(body['temporaryPassword']).toBe(generated);
  });

  it('leaves no copy when the server refuses, either', async () => {
    // The failure path is where a scrub placed in a success callback would
    // have been missed, and it is also the path on which the panel stays on
    // screen — so the cache must be clean while the plaintext is still being
    // displayed on purpose.
    invoke.mockResolvedValue({ data: null, error: new Error('network down') });
    const { generated } = await resetPassword();

    const panel = await screen.findByRole('alert', { name: /temporary password, shown once/i });
    expect(within(panel).getByText(generated)).toBeInTheDocument();
    expect(panel).toHaveTextContent(/did not confirm/i);

    expect(mutationCacheDump()).not.toContain(generated);
    expect(temporaryPasswordStashSize()).toBe(0);
  });
});

describe('a non-credential action is unaffected', () => {
  it('still carries its payload through the mutation variables', async () => {
    // The change must not have turned every administrative action into a
    // stash-fed one: an action with no credential has nothing to hand over,
    // and `useAdminAction` must not refuse it for want of a stash entry.
    const user = userEvent.setup();
    tables = { profiles: [profile({ status: 'pending' })], user_roles: [] };
    mount();
    await screen.findByText('An Operator');

    await user.click(screen.getByRole('button', { name: /approve access/i }));
    await user.type(
      within(await screen.findByRole('dialog')).getByRole('textbox'),
      'Authorised by the plant manager.',
    );
    await user.click(screen.getByRole('button', { name: /approve this account/i }));

    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    const body = (invoke.mock.calls[0]![1] as { body: Record<string, unknown> }).body;
    expect(body['action']).toBe('approve_access');
    expect(body['userId']).toBe('user-1');
    expect('temporaryPassword' in body).toBe(false);
    // And its variables are in the cache, as they always were — the change is
    // about the credential, not about how mutations work.
    expect(mutationCacheDump()).toContain('approve_access');
  });
});
