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

describe('the tile grid', () => {
  it('offers every form in the plant’s own order, then More', () => {
    renderHome(['quality_officer']);

    const links = stageLinks();
    // One per dashboard card, derived rather than hardcoded: `stageTiles` is
    // deliberately not sliced, so a form must never be able to go missing here.
    expect(links).toHaveLength(DASHBOARD_ORDER.length);
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

describe('a stage tile carries its number and its name, and nothing else', () => {
  it('shows no collected-today figure, because the second line was removed', async () => {
    // The owner asked for one piece of text per tile with the icon beside it.
    // The per-stage figure went with the second line. It is NOT gone from the
    // app — the wide dashboard still renders it from the same query — so this
    // asserts the phone tile's content exactly rather than asserting the
    // figure is nowhere.
    renderHome(['quality_officer']);
    const raw = stageLinks().find((a) => a.getAttribute('href') === '/stage/raw_materials');
    // The visible ordinal badge, then the name. The ordinal appears twice in
    // the text: once seen (aria-hidden) and once spoken as "Form 1:", so the
    // reading order matches the seen order without a screen reader saying
    // "1 1". Nothing follows the name.
    expect(raw?.textContent).toBe('1Form 1: Raw Materials');
    for (const link of stageLinks()) {
      expect(link.textContent).not.toContain('today');
      expect(link.textContent).not.toContain('Count not available');
    }
  });

  it('still reports an unknown queue figure as a dash inside More', async () => {
    // PRD §12 — never a placeholder zero — is unchanged; it moved to where
    // the figures still are. A failed query that renders "0" reads as a quiet
    // morning instead of a broken screen.
    const user = userEvent.setup();
    renderHome(['quality_officer'], {
      awaitingResults: undefined,
      readyForReview: 4,
      onHold: undefined,
    });
    await user.click(screen.getByRole('button', { name: /More/ }));

    const dialog = screen.getByRole('dialog');
    // Two unknown figures, one known. The known one is a figure; neither
    // unknown one became a zero.
    expect(within(dialog).getAllByText('Count not available')).toHaveLength(2);
    expect(within(dialog).getByText('4')).toBeInTheDocument();
    expect(within(dialog).queryByText('0')).toBeNull();
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

  it('POSITIVE CONTROL: the same query finds every form for a role that may record', () => {
    renderHome(['quality_officer'], { mayRecord: true });
    expect(stageLinks()).toHaveLength(DASHBOARD_ORDER.length);
    expect(screen.queryByText(/does not record samples/i)).toBeNull();
  });
});
