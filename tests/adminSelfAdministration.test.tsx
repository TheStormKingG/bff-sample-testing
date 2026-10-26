/**
 * No control on the administration screen offers an act the server refuses
 * unconditionally — and the row that offers nothing says why.
 *
 * ===========================================================================
 * THE RULE BEING DEFENDED
 * ===========================================================================
 * `public.assert_administers_other(p_actor, p_target_user)` raises
 * `BFF_SELF_ADMINISTRATION` whenever the actor IS the target. It is not
 * conditional, there is no override, and five RPCs perform it before doing
 * anything else:
 *
 *     rpc_approve_account            0015_rpc_domain_and_admin.sql
 *     rpc_set_user_status            0015_rpc_domain_and_admin.sql
 *     rpc_set_user_roles             0015_rpc_domain_and_admin.sql
 *     rpc_grant_delegation           0015_rpc_domain_and_admin.sql
 *     rpc_record_admin_password_set  0019 / 0020
 *
 * `rpc_revoke_delegation` deliberately does NOT, so withdrawing your own
 * delegation is permitted and is not covered here.
 *
 * A control whose only reachable outcome is a refusal is not a strict UI, it is
 * a broken one — and for the password reset it is worse than broken. The Edge
 * handler arms the forced change through the RPC FIRST and calls
 * `auth.admin.updateUserById` only afterwards, so a self-targeted reset raises
 * inside the RPC and the password is never set on any account — AFTER the
 * screen has already shown the administrator a generated password and told
 * them to give it to somebody.
 *
 * ===========================================================================
 * WHY FOUR CONTROLS AND NOT ONE
 * ===========================================================================
 * The audit named the password reset. The password reset is one of four
 * controls on this screen that target an account, and the three others —
 * roles, status, and the delegation picker — are refused by the same
 * unconditional assertion in the same way. A fix that closed only the named
 * instance would have inherited the audit's sample as if it were the defect's
 * extent. Approve/Deny was already guarded, by `checkSeparationOfDuties`,
 * which is where the pattern was copied from.
 *
 * Every absence below is paired with the same assertion on ANOTHER account's
 * row, because an assertion that a control is gone passes equally well when
 * the whole screen failed to render.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.stubEnv('VITE_SUPABASE_URL', 'https://test.supabase.co');
vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'test-anon-key');

const ACTOR_ID = 'actor-0000-0000-0000-000000000001';

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
        id: ACTOR_ID,
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

/** The actor's own row, as `fetchAdminUsers` returns it — it selects no filter. */
function ownProfile(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return profile({
    id: ACTOR_ID,
    email: 'admin@example.test',
    display_name: 'An Administrator',
    ...over,
  });
}

function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: 0 } },
  });
  return render(
    <QueryClientProvider client={client}>
      <AdminPage />
    </QueryClientProvider>,
  );
}

/** The `<li>` one account's controls live in, found by the name it renders. */
async function row(name: string): Promise<HTMLElement> {
  const heading = await screen.findByText(name);
  const li = heading.closest('li');
  if (li === null) throw new Error(`No row element found for ${name}`);
  return li as HTMLElement;
}

beforeEach(() => {
  tables = { profiles: [ownProfile(), profile()], user_roles: [] };
  invoke.mockReset();
  invoke.mockResolvedValue({ data: { ok: true, message: 'Done.' }, error: null });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the password reset — the instance the audit named', () => {
  it('is absent from the signed-in administrator’s own row', async () => {
    mount();
    const own = await row('An Administrator');

    expect(
      within(own).queryByRole('button', { name: /^reset password$/i }),
    ).not.toBeInTheDocument();
    expect(
      within(own).queryByLabelText(/^Temporary password for An Administrator$/i),
    ).not.toBeInTheDocument();
    expect(
      within(own).queryByRole('button', {
        name: /^Generate a temporary password for An Administrator$/i,
      }),
    ).not.toBeInTheDocument();
  });

  it('is present on another account’s row — the control that proves the absence', async () => {
    // Without this the test above passes on an empty screen, on a crashed
    // render, and on a build that deleted the feature.
    mount();
    const other = await row('An Operator');

    expect(within(other).getByRole('button', { name: /^reset password$/i })).toBeInTheDocument();
    expect(
      within(other).getByLabelText(/^Temporary password for An Operator$/i),
    ).toBeInTheDocument();
  });

  it('says on that row why the control is absent, naming what is needed instead', async () => {
    // An administrator who cannot find the button assumes the feature is
    // broken and goes looking for it somewhere else. The row has to answer the
    // question it raises.
    mount();
    const own = await row('An Administrator');

    expect(own).toHaveTextContent(/your own account/i);
    expect(own).toHaveTextContent(/another administrator/i);
  });
});

describe('the three controls the audit did not name, refused by the same assertion', () => {
  it('offers no role change on the own row, and does on another row', async () => {
    mount();
    const own = await row('An Administrator');
    const other = await row('An Operator');

    expect(
      within(own).queryByRole('button', { name: /role changes to save|save role changes/i }),
    ).not.toBeInTheDocument();
    expect(
      within(other).getByRole('button', { name: /role changes to save|save role changes/i }),
    ).toBeInTheDocument();
  });

  it('offers no status change on the own row, and does on another row', async () => {
    mount();
    const own = await row('An Administrator');
    const other = await row('An Operator');

    expect(within(own).queryByLabelText(/^account status$/i)).not.toBeInTheDocument();
    expect(within(other).getByLabelText(/^account status$/i)).toBeInTheDocument();
  });

  it('still shows the own row’s roles and status as facts, just not as controls', async () => {
    // Removing the controls must not remove the information. An administrator
    // has to be able to read their own roles and status off this screen — it
    // is the only place they are shown — and a row that goes blank would read
    // as a failed query.
    mount();
    const own = await row('An Administrator');

    expect(own).toHaveTextContent(/administrator/i);
    expect(own).toHaveTextContent(/active/i);
  });

  it('keeps the actor out of the delegation picker, but not everybody else', async () => {
    // `rpc_grant_delegation` performs the same assertion, so a delegation
    // aimed at yourself is refused — and this dropdown listed every active
    // account including the actor.
    const user = (await import('@testing-library/user-event')).default;
    mount();
    await user.click(await screen.findByRole('button', { name: /delegated authority/i }));

    const picker = await screen.findByLabelText(/^delegate to$/i);
    const options = within(picker as HTMLElement)
      .getAllByRole('option')
      .map((option) => (option as HTMLOptionElement).value);

    expect(options).not.toContain(ACTOR_ID);
    // The control: somebody else IS offered, so an empty list is not read as a
    // pass.
    expect(options).toContain('user-1');
  });
});

describe('the consequence an administrator needs to know before it matters', () => {
  it('states it on the access screen, where it is read before the password is forgotten', async () => {
    // Surfaced ahead of the moment it matters, and NOT only on the actor's own
    // row: the row answers the question the missing controls raise, which is a
    // question nobody asks until they are already looking for the button. The
    // remedy — a second administrator account that exists, whose holder is
    // reachable — has to be arranged while everything still works.
    mount();
    await screen.findByText('An Operator');

    expect(
      await screen.findByText(/you cannot reset your own password here/i),
    ).toBeInTheDocument();
    expect(document.body.textContent ?? '').toMatch(/no mail at all/i);
  });

  it('states it again on the own row, and the two are different elements', async () => {
    // Deliberately two places with two jobs, so neither is evidence for the
    // other. If a later edit removes one, this fails rather than silently
    // passing on the survivor.
    mount();
    const own = await row('An Administrator');

    expect(own).toHaveTextContent(/another administrator/i);
    // The standing notice is OUTSIDE the row, so the row's copy is its own.
    const standing = screen.getByText(/you cannot reset your own password here/i);
    expect(own.contains(standing)).toBe(false);
  });
});

describe('nothing is sent for a self-targeted act', () => {
  it('issues no request at all while the own row is on screen', async () => {
    // The screen reads accounts and sends nothing until a control is used. If
    // a self-targeted request were being fired on render, every assertion
    // above would still pass.
    mount();
    await row('An Administrator');

    expect(invoke).not.toHaveBeenCalled();
  });
});
