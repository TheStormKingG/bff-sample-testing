/**
 * The bottom bar is the whole of the application's navigation.
 *
 * ===========================================================================
 * WHY THIS FILE REPLACED `secondaryNav.test.tsx`
 * ===========================================================================
 * The old bar sat under the header, listed six record destinations, and was
 * absent from the phone home screen — which deleted the shell to win height.
 * A "More" sheet stood in for it there. Two renderings of one navigation is
 * two things to keep in step, and they did not stay in step: an e2e check
 * that a secondary destination was reachable at all passed on a phone only
 * because an unrelated warning strip happened to link to one.
 *
 * One bar now, on every route and every width. These are the properties that
 * have to hold for that to be true.
 */

import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { PrimaryNav } from '@/components/layout/PrimaryNav';
import { PRIMARY_NAV } from '@/components/layout/navItems';
import { AccessContext, type AccessValue } from '@/components/layout/accessContext';
import type { Permission } from '@/lib/roles';

const ALL: readonly Permission[] = ['sample.view', 'sample.review', 'report.view', 'user.manage'];

function renderNav(granted: readonly Permission[], at = '/samples') {
  const value: AccessValue = {
    profile: {} as AccessValue['profile'],
    can: (permission) => granted.includes(permission),
    reloadProfile: () => {},
  };
  return render(
    <MemoryRouter initialEntries={[at]}>
      <AccessContext.Provider value={value}>
        <PrimaryNav />
      </AccessContext.Provider>
    </MemoryRouter>,
  );
}

const bar = () => screen.getByRole('navigation', { name: 'Main' });
const links = () => within(bar()).getAllByRole('link');

describe('the bottom bar', () => {
  it('offers every destination the role may open, in the fixed order', () => {
    renderNav(ALL);
    expect(links().map((a) => a.getAttribute('href'))).toEqual(PRIMARY_NAV.map((i) => i.to));
  });

  it('is five destinations and no more', () => {
    /*
      Not a style preference. Five is what fits across a phone at a finger's
      width, and the bar is the ONLY navigation — a sixth would either
      shrink the targets below the tap floor or need a "More" affordance,
      which is the arrangement this replaced. Adding a destination is a
      decision about what leaves, so it should fail here first.
    */
    expect(PRIMARY_NAV).toHaveLength(5);
  });

  it('always offers the way home, whatever the role', () => {
    // Home carries no permission on purpose: gating the way out of every
    // screen would strand whoever failed the check on one.
    renderNav([]);
    expect(links().map((a) => a.getAttribute('href'))).toEqual(['/']);
  });

  it('offers nothing a role may not open', () => {
    renderNav(['sample.view']);
    const hrefs = links().map((a) => a.getAttribute('href'));
    expect(hrefs).toContain('/samples');
    expect(hrefs).toContain('/flagged');
    expect(hrefs).not.toContain('/dashboard');
    expect(hrefs).not.toContain('/admin');
  });

  it('marks the current screen in words, not only in colour', () => {
    // PRD §11: colour alone carries no meaning. A screen reader has to be
    // able to hear which tab is current.
    renderNav(ALL, '/flagged');
    const current = links().find((a) => a.getAttribute('href') === '/flagged')!;
    expect(current.textContent).toContain('(current screen)');

    const other = links().find((a) => a.getAttribute('href') === '/samples')!;
    expect(other.textContent).not.toContain('(current screen)');
  });

  it('does not mark Home as current on every screen', () => {
    /*
      The regression this exists for. '/' is a prefix of every route, so a
      NavLink without `end` matches everywhere and the bar shows two current
      tabs — or, worse, Home highlighted while the person is on Admin.
    */
    renderNav(ALL, '/admin');
    const home = links().find((a) => a.getAttribute('href') === '/')!;
    expect(home.textContent).not.toContain('(current screen)');
  });

  it('names no destination after a testing form', () => {
    /*
      Master Prompt §2: the numbered stage cards on Home are the only way
      into a form, and nothing in the navigation may read as an extra one.
    */
    for (const item of PRIMARY_NAV) {
      expect(item.label).not.toMatch(/^\d/);
      expect(item.to).not.toMatch(/^\/stage\//);
    }
  });
});
