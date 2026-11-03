/**
 * Home: the seven testing forms, and nothing that reads as an eighth.
 *
 * ===========================================================================
 * WHAT THIS SUITE USED TO COVER, AND WHY IT COVERS LESS NOW
 * ===========================================================================
 * This screen was once the whole application on a phone — the shell was
 * deleted on this route to buy height, so the screen grew its own brand
 * block, connection chip, plant date and a "More" sheet holding the record
 * destinations, three queue figures, the signed-in identity and the only
 * Sign out button in the app. Most of this file tested that sheet.
 *
 * The navigation moved to a bottom bar costing about 58px, which made the
 * trade unnecessary. The shell is back on every route, so identity, sign out
 * and connectivity are the header's again (and the header's tests'), the
 * destinations are `PrimaryNav`'s, and the queue figures have a screen of
 * their own in `FlaggedPage`. What is left here is the one job this screen
 * has: offer the forms, truthfully.
 *
 * ===========================================================================
 * WHAT THIS SUITE CANNOT SEE
 * ===========================================================================
 * jsdom has no layout engine: `getBoundingClientRect` is all zeros, so
 * anything about fit, height or scrolling is NOT testable here and is not
 * asserted. The old screen promised all tiles fit a 375x812 phone without
 * scrolling and that was measured in a real browser; this one makes no such
 * promise, because the chrome came back and seven tiles in two columns may
 * run past the fold. HORIZONTAL scroll is still forbidden and is still
 * checked, in e2e, where there is a layout engine.
 *
 * Every "X is absent" assertion below is paired with a case where the same
 * query FINDS something. An absence check over a screen that failed to
 * render passes for the wrong reason.
 */

import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { can as canFor, type Role } from '@/lib/roles';
import type { Profile } from '@/hooks/useProfile';
import { AccessContext } from '@/components/layout/accessContext';
import { HomeScreen, type HomeScreenProps } from '@/components/home/HomeScreen';
import { DASHBOARD_ORDER } from '@/forms/registry';

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

vi.mock('@/lib/supabase', () => ({ signOut: vi.fn(), supabase: {} }));

function profileWith(roles: readonly Role[]): Profile {
  return {
    id: 'u1',
    email: 'sampler@example.test',
    fullName: 'A Sampler',
    status: 'active',
    roles,
    provisional: false,
    passwordSetByAdminAt: null,
    passwordChangedAt: '2026-01-01T00:00:00.000Z',
    mustChangePassword: false,
  } as Profile;
}

const BASE: HomeScreenProps = { mayRecord: true };

function renderHome(roles: readonly Role[], props: Partial<HomeScreenProps> = {}) {
  const profile = profileWith(roles);
  // The REAL permission matrix, not a stub: a screen that gates on a fake
  // `can` proves nothing about what this role is actually offered.
  const value = {
    profile,
    can: (permission: Parameters<typeof canFor>[1]) =>
      canFor({ userId: profile.id, status: profile.status, roles: profile.roles }, permission),
    reloadProfile: vi.fn(),
  };
  return render(
    <MemoryRouter>
      <AccessContext.Provider value={value}>
        <HomeScreen {...BASE} {...props} />
      </AccessContext.Provider>
    </MemoryRouter>,
  );
}

/** Links that lead to a testing form, in the order the DOM presents them. */
function stageLinks(): HTMLAnchorElement[] {
  // `queryAllByRole`, not `getAllByRole`: a role that records nothing gets a
  // screen with no links at all, and `getAllByRole` throws on an empty match
  // rather than returning one — which would fail the "offers none" test for
  // the wrong reason.
  return screen
    .queryAllByRole('link')
    .filter((el): el is HTMLAnchorElement => (el.getAttribute('href') ?? '').includes('/stage/'));
}

describe('the tile grid', () => {
  it('offers every form in the plant’s own order', () => {
    renderHome(['quality_officer']);

    const links = stageLinks();
    // Derived rather than hardcoded, so a form can never go missing here.
    expect(links).toHaveLength(DASHBOARD_ORDER.length);
    expect(links).toHaveLength(7);
    expect(links.map((a) => a.getAttribute('href'))).toEqual(
      DASHBOARD_ORDER.map((schema) => `/stage/${schema.stage}`),
    );
  });

  it('offers no link that is not a testing form', () => {
    /*
      Master Prompt §2: the numbered cards are the only way into a form and
      nothing on this screen may read as an extra one. The old grid had an
      eighth tile — "More" — which was a button rather than a link, exactly
      so this stayed true. The bottom bar carries that job now, so this
      screen should contain stage links and nothing else at all.
    */
    renderHome(['quality_officer']);
    expect(screen.getAllByRole('link')).toHaveLength(DASHBOARD_ORDER.length);
  });

  it('shows each form’s number and name, and speaks the number in order', () => {
    renderHome(['quality_officer']);

    for (const schema of DASHBOARD_ORDER) {
      const tile = stageLinks().find((a) => a.getAttribute('href') === `/stage/${schema.stage}`);
      expect(tile, `no tile for ${schema.stage}`).toBeDefined();
      // The ordinal is visible...
      expect(tile?.textContent).toContain(String(schema.ordinal));
      // ...and spoken before the title, so the heard order matches the seen
      // order rather than reading the digit twice.
      expect(tile?.textContent).toContain(`Form ${schema.ordinal}: `);
      expect(tile?.textContent).toContain(schema.title);
    }
  });
});

describe('a role that does not record samples gets a truthful screen', () => {
  it('offers no form tiles rather than seven that would refuse', () => {
    renderHome(['auditor'], { mayRecord: false });
    expect(stageLinks()).toHaveLength(0);
    expect(screen.getByText(/does not record samples/i)).toBeInTheDocument();
  });

  it('CONTROL: the same query finds seven for a role that does record', () => {
    // Without this, the assertion above would pass on a screen that failed
    // to render at all.
    renderHome(['quality_officer'], { mayRecord: true });
    expect(stageLinks()).toHaveLength(7);
  });
});

describe('the removed sampling-frequency warning stays removed', () => {
  /*
    This block used to assert the opposite: that every stage without an
    approved frequency carried a "Sampling frequency not yet set" marker, and
    that a strip under the grid summarised the count. Bounty Farm removed
    sampling frequency from the system on 2026-11-03.

    Kept as an inverted guard rather than deleted, because the wording is the
    kind that gets pasted back from an old branch, and nothing else on this
    screen would notice.
  */
  it('shows no sampling-frequency wording anywhere on the home screen', () => {
    renderHome(['quality_officer']);
    expect(document.body.textContent ?? '').not.toMatch(/sampling frequency/i);
  });

  it('still renders a tile per stage, so the check above is not vacuous', () => {
    renderHome(['quality_officer']);
    for (const schema of DASHBOARD_ORDER) {
      expect(
        stageLinks().some((a) => a.getAttribute('href') === `/stage/${schema.stage}`),
        schema.stage,
      ).toBe(true);
    }
  });
});
