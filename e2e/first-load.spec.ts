/**
 * First load: what the browser does before anybody signs in.
 *
 * Runs for real against the production build. The Supabase origin is mocked so
 * that an unresolvable host in CI cannot be mistaken for an application fault;
 * every other origin is deliberately left un-mocked, because the point of the
 * origin assertion is to catch a request to a host nobody authorised.
 *
 * PRD NFR-002 (nothing leaves the plant that does not need to) and NFR-004
 * (usable on a small phone and a plant tablet).
 */

import { expect, test } from '@playwright/test';
import { appUrl, hasHorizontalScroll, installSupabaseMocks, thirdPartyOrigins } from './fixtures/app';
import { observePage } from './fixtures/console';

test('first load raises no uncaught error and no application console error', async ({ page }) => {
  // Listeners first: attached after navigation, they would miss the bootstrap
  // and the spec would claim to observe a window it never saw.
  const observed = observePage(page);
  await installSupabaseMocks(page, { authenticated: false });

  await page.goto(appUrl(), { waitUntil: 'load' });
  await expect(page.locator('#root')).toHaveCount(1);
  await page.waitForLoadState('networkidle');

  expect(observed.pageErrors, 'uncaught exception(s) during first load').toEqual([]);
  expect(
    observed.appErrors,
    'the application logged error(s) on a plain first load' +
      (observed.resourceNotices.length > 0
        ? `. For context, the browser also reported these subresource failures, which are NOT asserted on here because the Supabase origin is deliberately mocked: ${observed.resourceNotices.join(' / ')}`
        : ''),
  ).toEqual([]);
  expect(observed.serverErrors(), 'a request returned 5xx on first load').toEqual([]);
});

test('first load contacts no origin outside the allowlist', async ({ page, baseURL }) => {
  const observed = observePage(page);
  await installSupabaseMocks(page, { authenticated: false });

  await page.goto(appUrl(), { waitUntil: 'load' });
  await expect(page.locator('#root')).toHaveCount(1);
  await page.waitForLoadState('networkidle');

  expect(observed.requests.length, 'no requests were recorded, so this check observed nothing')
    .toBeGreaterThan(0);

  const strangers = thirdPartyOrigins(observed.requests, baseURL!);
  expect(
    strangers,
    'first load contacted origin(s) outside the allowlist (the app itself and the Supabase project). ' +
      'A font host, CDN or analytics endpoint here both leaks plant activity and breaks on a plant ' +
      'connection with restricted egress.',
  ).toEqual([]);
});

const VIEWPORTS = [
  { label: 'small phone', width: 375, height: 812 },
  { label: 'plant tablet', width: 768, height: 1024 },
] as const;

for (const viewport of VIEWPORTS) {
  test(`the sign-in page has no horizontal scroll at ${viewport.width}px (${viewport.label})`, async ({
    page,
  }) => {
    await installSupabaseMocks(page, { authenticated: false });
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto(appUrl());

    // Positive control: something must have rendered, or "no overflow" is just
    // a measurement of an empty document.
    await expect(
      page.getByRole('button', { name: /sign in with google/i }).or(
        page.getByRole('link', { name: /sign in with google/i }),
      ),
    ).toBeVisible();

    const { scrollWidth, clientWidth } = await hasHorizontalScroll(page);
    // 1px of tolerance for sub-pixel layout rounding; anything more is a real
    // element wider than the screen.
    expect(
      scrollWidth,
      `the page scrolls sideways at ${viewport.width}px (content ${scrollWidth}px wide in a ${clientWidth}px viewport)`,
    ).toBeLessThanOrEqual(clientWidth + 1);
  });
}
