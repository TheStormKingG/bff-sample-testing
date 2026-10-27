/**
 * Which dashboard renders, and why exactly one of them does.
 *
 * ===========================================================================
 * WHAT IS BEING DEFENDED
 * ===========================================================================
 * The phone home screen and the wide dashboard both contain a link to
 * `#/stage/raw_materials`. The acceptance specs address the dashboard by that
 * routing contract on purpose — an href cannot drift with a class name — so
 * if BOTH layouts are in the document at once, every such locator matches two
 * elements and the suite fails. The first version of this screen rendered
 * both and hid one with `sm:hidden`, and that is exactly what happened.
 *
 * So the rule this file enforces is not cosmetic: EXACTLY ONE layout is in
 * the document at any width. A test that only checked "the tile grid appears
 * on a phone" would pass just as happily with both trees present, which is
 * why each case asserts the absence of the other layout as well as the
 * presence of its own.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { can as canFor } from '@/lib/roles';
import type { Profile } from '@/hooks/useProfile';
import { AccessContext } from '@/components/layout/accessContext';
import DashboardPage from '@/pages/DashboardPage';

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
 * A chainable stand-in for the Supabase query builder that resolves to an
 * empty, error-free result. The counts are not what this file is about; a
 * builder that threw would make a layout question look like a data failure.
 */
vi.mock('@/lib/supabase', () => {
  const result = { data: [], error: null, count: 0 };
  const builder: Record<string, unknown> = {};
  for (const method of ['select', 'gte', 'lt', 'in', 'eq']) {
    builder[method] = () => builder;
  }
  builder.then = (resolve: (value: typeof result) => unknown) =>
    Promise.resolve(result).then(resolve);
  return { supabase: { from: () => builder }, signOut: vi.fn() };
});

const profile: Profile = {
  id: 'u1',
  email: 'sampler@example.test',
  fullName: 'A Sampler',
  status: 'active',
  roles: ['quality_officer'],
  provisional: false,
  passwordSetByAdminAt: null,
  passwordChangedAt: '2026-01-01T00:00:00.000Z',
  mustChangePassword: false,
} as Profile;

/**
 * Stub `matchMedia` so the breakpoint is a dial this test turns.
 *
 * `useIsPhone` asks for `(min-width: 640px)` — the exact complement of
 * Tailwind's `sm:` — so `matches: false` means "phone".
 */
function stubViewport(wide: boolean): void {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: query.includes('min-width: 640px') ? wide : false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

function renderDashboard() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const value = {
    profile,
    can: (permission: Parameters<typeof canFor>[1]) =>
      canFor({ userId: profile.id, status: profile.status, roles: profile.roles }, permission),
    reloadProfile: vi.fn(),
  };
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <AccessContext.Provider value={value}>
          <DashboardPage />
        </AccessContext.Provider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function stageLinkCount(stage: string): number {
  return screen
    .getAllByRole('link')
    .filter((el) => (el.getAttribute('href') ?? '').endsWith(`/stage/${stage}`)).length;
}

afterEach(() => {
  // Leave the global as the other suites expect to find it.
  Reflect.deleteProperty(window, 'matchMedia');
});

describe('exactly one dashboard layout is in the document', () => {
  it('below sm: the eight-tile home screen, and NOT the wide dashboard', () => {
    stubViewport(false);
    renderDashboard();

    expect(screen.getByRole('heading', { level: 1, name: /Sample testing/i }).id).toBe(
      'home-heading',
    );
    expect(document.querySelector('#forms-heading')).toBeNull();
    expect(document.querySelector('#queues-heading')).toBeNull();
    expect(document.querySelector('#records-nav-heading')).toBeNull();

    // The assertion that actually protects the acceptance specs.
    expect(stageLinkCount('raw_materials')).toBe(1);
    expect(screen.getByRole('button', { name: /More/ })).toBeInTheDocument();
  });

  it('at sm and above: the wide dashboard, and NOT the tile grid', () => {
    stubViewport(true);
    renderDashboard();

    expect(screen.getByRole('heading', { level: 1, name: /Sample testing/i }).id).toBe(
      'forms-heading',
    );
    expect(document.querySelector('#home-heading')).toBeNull();
    // The richer screen's own sections are still there — this is the
    // "desktop must not regress" half of the pair.
    expect(document.querySelector('#records-nav-heading')).not.toBeNull();

    expect(stageLinkCount('raw_materials')).toBe(1);
    // No 'More' tile at this width: the records panel is already on screen.
    expect(screen.queryByRole('button', { name: /^More$/ })).toBeNull();
  });

  it('falls back to the wide dashboard when matchMedia is unavailable', () => {
    // Some embedded browsers and runners have no `matchMedia`. The wide
    // dashboard works at every size; the phone screen assumes it owns the
    // viewport, so "unknown" must not resolve to "phone".
    //
    // Note it has to be SHADOWED, not deleted: jsdom defines `matchMedia` on
    // `Window.prototype`, so deleting the own property reveals jsdom's own
    // implementation (which answers `matches: false` to everything) and tests
    // the phone branch instead of the absent-API branch. Deleting it was the
    // first attempt here and it failed for exactly that reason.
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      configurable: true,
      value: undefined,
    });
    renderDashboard();
    expect(document.querySelector('#forms-heading')).not.toBeNull();
    expect(document.querySelector('#home-heading')).toBeNull();
  });
});
