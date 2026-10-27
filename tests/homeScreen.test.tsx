/**
 * The phone home screen: eight tiles, one tap, nothing hidden by accident.
 *
 * ===========================================================================
 * WHAT THIS SUITE CAN AND CANNOT SEE
 * ===========================================================================
 * jsdom has no layout engine: `getBoundingClientRect` is all zeros here, so
 * "all eight tiles fit a 375x812 screen without scrolling" is NOT testable in
 * this file and is deliberately not asserted. That claim is a measurement,
 * and it was measured in a real browser (documentElement.scrollHeight 812 vs
 * clientHeight 812 at 375x812; 844/844 at 390x844), alongside a sensitivity
 * control proving the same instrument reports 1359px of overflow on a page
 * that does scroll. Asserting geometry from jsdom would have produced a green
 * test that certified nothing.
 *
 * What IS testable here, and is: the structure a sampler depends on. That the
 * seven forms are offered in the plant's own order, that the eighth tile
 * holds the rest, that a role which cannot record samples gets a truthful
 * screen instead of seven tiles that refuse, that the known sampling-
 * frequency gap is still stated, and that a count is either a number or an
 * honest dash — never a placeholder zero.
 *
 * Every "X is absent" assertion below is paired with a case where the same
 * query FINDS something. An absence check over a screen that failed to render
 * passes for the wrong reason, and that is the one failure mode this file is
 * most exposed to.
 */

import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

const signOutSpy = vi.hoisted(() => vi.fn());
vi.mock('@/lib/supabase', () => ({
  signOut: signOutSpy,
  supabase: {},
}));

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

const BASE: HomeScreenProps = {
  plantDate: '2026-10-27',
  mayRecord: true,
  todayByStage: undefined,
  awaitingResults: undefined,
  readyForReview: undefined,
  onHold: undefined,
};

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
  return screen
    .getAllByRole('link')
    .filter((el): el is HTMLAnchorElement => (el.getAttribute('href') ?? '').includes('/stage/'));
}

describe('the eight tiles', () => {
  it('offers the seven forms in the plant’s own order, then More', () => {
    renderHome(['quality_officer']);

    const links = stageLinks();
    expect(links).toHaveLength(7);
    expect(links.map((a) => a.getAttribute('href'))).toEqual(
      DASHBOARD_ORDER.map((schema) => `/stage/${schema.stage}`),
    );

    // The eighth tile is a BUTTON, not a link to a stage route. That is what
    // keeps "exactly seven ways into a testing form" true (Master Prompt §2);
    // an eighth stage-shaped link would be a records screen dressed as a form.
    const more = screen.getByRole('button', { name: /More/ });
    expect(more).toBeInTheDocument();
    expect(more.getAttribute('href')).toBeNull();
  });

  it('shows each form’s number and name, and speaks the number in order', () => {
    renderHome(['quality_officer']);

    for (const schema of DASHBOARD_ORDER) {
      const tile = stageLinks().find(
        (a) => a.getAttribute('href') === `/stage/${schema.stage}`,
      );
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

describe('the sampling-frequency gap is stated, not dropped', () => {
  it('marks every stage without an approved frequency, and no others', () => {
    renderHome(['quality_officer']);

    const without = DASHBOARD_ORDER.filter((s) => !s.frequencyApproved);
    const withApproved = DASHBOARD_ORDER.filter((s) => s.frequencyApproved);

    // Both sets must be non-empty, or one half of this test is vacuous.
    expect(without.length).toBeGreaterThan(0);
    expect(withApproved.length).toBeGreaterThan(0);

    for (const schema of without) {
      const tile = stageLinks().find((a) => a.getAttribute('href') === `/stage/${schema.stage}`);
      expect(tile?.textContent, `${schema.stage} should carry the warning`).toContain(
        'Sampling frequency not yet set',
      );
    }
    // The negative control. Without it, a change that marked ALL seven tiles
    // would pass the loop above.
    for (const schema of withApproved) {
      const tile = stageLinks().find((a) => a.getAttribute('href') === `/stage/${schema.stage}`);
      expect(tile?.textContent, `${schema.stage} should NOT carry the warning`).not.toContain(
        'Sampling frequency not yet set',
      );
    }
  });

  it('summarises the gap in a strip, with the figure read from the registry', () => {
    renderHome(['quality_officer']);
    const expected = DASHBOARD_ORDER.filter((s) => !s.frequencyApproved).length;
    expect(
      screen.getByText(
        `${expected} of ${DASHBOARD_ORDER.length} stages have no approved sampling frequency`,
      ),
    ).toBeInTheDocument();
  });

  it('makes the strip a link to Approved limits only for someone who may open it', () => {
    // A quality officer holds `report.view`.
    renderHome(['quality_officer']);
    expect(
      screen.getAllByRole('link').some((a) => a.getAttribute('href') === '/specifications'),
    ).toBe(true);
  });

  it('states the same gap as plain text when the role may not open Approved limits', () => {
    renderHome(['operator']);
    // An operator holds no `report.view`, so the figure is still on screen...
    const expected = DASHBOARD_ORDER.filter((s) => !s.frequencyApproved).length;
    expect(
      screen.getByText(
        `${expected} of ${DASHBOARD_ORDER.length} stages have no approved sampling frequency`,
      ),
    ).toBeInTheDocument();
    // ...but it is not offered as a destination they would be refused at.
    expect(
      screen.getAllByRole('link').some((a) => a.getAttribute('href') === '/specifications'),
    ).toBe(false);
  });
});

describe('counts are a number or an honest dash, never a placeholder zero', () => {
  it('shows the figure when it is known, including a real zero', () => {
    renderHome(['quality_officer'], {
      todayByStage: { raw_materials: 3, ground: 0 },
    });

    const raw = stageLinks().find((a) => a.getAttribute('href') === '/stage/raw_materials');
    expect(raw?.textContent).toContain('3');
    expect(raw?.textContent).toContain('collected today');

    // A genuine zero is a figure, and must read as one — not as "unknown".
    const ground = stageLinks().find((a) => a.getAttribute('href') === '/stage/ground');
    expect(ground?.textContent).toContain('0');
    expect(ground?.textContent).not.toContain('Count not available');
  });

  it('says the count is not available rather than showing zero', () => {
    renderHome(['quality_officer'], { todayByStage: undefined });
    const raw = stageLinks().find((a) => a.getAttribute('href') === '/stage/raw_materials');
    expect(raw?.textContent).toContain('Count not available');
    // The dash, not a zero. A failed query that renders "0 today" reads as a
    // quiet morning instead of a broken screen (PRD §12).
    expect(raw?.textContent).toContain('—');
  });
});

describe('the More tile', () => {
  it('opens a sheet holding the records destinations and Sign out', async () => {
    const user = userEvent.setup();
    renderHome(['quality_officer']);

    await user.click(screen.getByRole('button', { name: /More/ }));

    const dialog = screen.getByRole('dialog');
    // The destinations the wide layout offers, offered here too.
    for (const route of ['/samples', '/awaiting', '/holds', '/reviews', '/specifications']) {
      expect(
        within(dialog)
          .getAllByRole('link')
          .some((a) => a.getAttribute('href') === route),
        `${route} should be reachable from More`,
      ).toBe(true);
    }
    // Admin is NOT a quality officer's to open — the sheet uses the same
    // permission check as everything else, so it cannot over-offer.
    expect(
      within(dialog)
        .getAllByRole('link')
        .some((a) => a.getAttribute('href') === '/admin'),
    ).toBe(false);

    // Hiding the app header on this screen would otherwise take sign-out with
    // it, which is why it lives here.
    expect(within(dialog).getByRole('button', { name: /Sign out/i })).toBeInTheDocument();
  });

  it('keeps the three queue figures separate instead of summing them', async () => {
    const user = userEvent.setup();
    renderHome(['quality_officer'], { awaitingResults: 4, readyForReview: 2, onHold: 1 });

    // The tile says there is work, in words, and does NOT carry the sum.
    const more = screen.getByRole('button', { name: /More/ });
    expect(more.textContent).toContain('Needs attention');
    expect(more.textContent).not.toContain('7');

    await user.click(more);
    const dialog = screen.getByRole('dialog');
    const rowFor = (route: string) =>
      within(dialog)
        .getAllByRole('link')
        .find((a) => a.getAttribute('href') === route);
    expect(rowFor('/awaiting')?.textContent).toContain('4');
    expect(rowFor('/reviews')?.textContent).toContain('2');
    expect(rowFor('/holds')?.textContent).toContain('1');
  });

  it('says nothing needs attention when nothing does', () => {
    renderHome(['quality_officer'], { awaitingResults: 0, readyForReview: 0, onHold: 0 });
    expect(screen.getByRole('button', { name: /More/ }).textContent).not.toContain(
      'Needs attention',
    );
  });
});

describe('a role that does not record samples gets a truthful screen', () => {
  it('offers the records it can open, not seven forms that would refuse', () => {
    renderHome(['auditor'], { mayRecord: false });

    // No form is offered at all...
    expect(stageLinks()).toHaveLength(0);
    // ...and the screen says why, rather than leaving an unexplained grid.
    expect(screen.getByText(/does not record samples/i)).toBeInTheDocument();
    // ...and the tiles that ARE there lead somewhere this role may go.
    const links = screen.getAllByRole('link').map((a) => a.getAttribute('href'));
    expect(links).toContain('/samples');
    expect(links).not.toContain('/admin');
    // Sign out is still reachable.
    expect(screen.getByRole('button', { name: /More/ })).toBeInTheDocument();
  });

  it('POSITIVE CONTROL: the same query finds seven forms for a role that may record', () => {
    renderHome(['quality_officer'], { mayRecord: true });
    expect(stageLinks()).toHaveLength(7);
    expect(screen.queryByText(/does not record samples/i)).toBeNull();
  });
});
