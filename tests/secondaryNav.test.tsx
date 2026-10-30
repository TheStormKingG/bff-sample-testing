/**
 * Every record screen has a visible way back to the testing forms.
 *
 * The bar under the header was, until now, the only chrome on a record screen
 * and it listed seven places to go and no way back. The one route home was the
 * wordmark in the header — a real `<Link to="/">`, but one that reads as a
 * logo, so it was not found. On a phone the dashboard hides the header and bar
 * entirely, which makes the bar the whole of the navigation everywhere else.
 */

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { SecondaryNav } from '@/components/layout/SecondaryNav';
import { AccessContext, type AccessValue } from '@/components/layout/accessContext';
import type { Permission } from '@/lib/roles';

function renderNav(
  variant: 'bar' | 'panel',
  granted: readonly Permission[],
  at = '/admin',
): ReturnType<typeof render> {
  const value: AccessValue = {
    profile: {} as AccessValue['profile'],
    can: (permission) => granted.includes(permission),
    reloadProfile: () => {},
  };
  return render(
    <MemoryRouter initialEntries={[at]}>
      <AccessContext.Provider value={value}>
        <SecondaryNav variant={variant} />
      </AccessContext.Provider>
    </MemoryRouter>,
  );
}

const ALL: readonly Permission[] = ['sample.view', 'sample.review', 'report.view', 'user.manage'];

describe('the navigation bar on a record screen', () => {
  it('offers a way home', () => {
    renderNav('bar', ALL);
    const home = screen.getByRole('link', { name: /Home/ });
    expect(home).toHaveAttribute('href', '/');
  });

  it('puts it first, where a way out belongs', () => {
    renderNav('bar', ALL);
    const links = screen.getAllByRole('link');
    expect(links[0]).toHaveTextContent('Home');
  });

  it('offers it even to someone who may see nothing else', () => {
    // THE CASE THIS TEST EXISTS FOR. The component used to return null when no
    // secondary item passed its permission check. A reader holding none of
    // them can still reach a record screen by URL and be met by "You do not
    // have access to this screen" — and that page would then have had no exit
    // but the browser's back button.
    renderNav('bar', []);
    expect(screen.getByRole('link', { name: /Home/ })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Samples' })).toBeNull();
  });

  it('does not mark Home as the current page while elsewhere', () => {
    // Without `end` on the NavLink, every route matches the '/' prefix and
    // Home renders as the current page on every screen in the application.
    renderNav('bar', ALL, '/admin');
    expect(screen.getByRole('link', { name: /Home/ })).not.toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('does mark it current on the dashboard itself', () => {
    renderNav('bar', ALL, '/');
    expect(screen.getByRole('link', { name: /Home/ })).toHaveAttribute('aria-current', 'page');
  });
});

describe('the panel at the bottom of the dashboard', () => {
  it('has no Home entry, because it is already on it', () => {
    renderNav('panel', ALL, '/');
    expect(screen.queryByRole('link', { name: /Home/ })).toBeNull();
  });

  it('POSITIVE CONTROL: it does render the secondary destinations', () => {
    renderNav('panel', ALL, '/');
    // By TEXT, not by accessible name: a panel link's name is its label plus
    // its description, and several descriptions mention samples.
    expect(screen.getByText('Samples')).toBeInTheDocument();
    expect(screen.getByText('Admin')).toBeInTheDocument();
  });

  it('stays absent when there is nothing to list', () => {
    const { container } = renderNav('panel', [], '/');
    expect(container.firstChild).toBeNull();
  });
});
