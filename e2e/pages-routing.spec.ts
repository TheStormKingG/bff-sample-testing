/**
 * The GitHub Pages routing regression.
 *
 * This is the failure that is invisible on a developer machine and total in
 * production: GitHub Pages serves a project site from a SUBPATH and cannot
 * serve a deep link or an OAuth callback from one. A build that quietly uses
 * BrowserRouter, or whose `base` is wrong, works at `localhost:5173/` and gives
 * a 404 or a white screen at `owner.github.io/repo/samples`.
 *
 * Runs for real, against the production build that `playwright.config.ts`
 * previews, on whatever VITE_BASE_PATH that build was made with. In CI that is
 * the repository's own Pages path, so this spec exercises the shipped shape.
 */

import { expect, test } from '@playwright/test';
import { BASE_PATH, appUrl, installSupabaseMocks } from './fixtures/app';

test.beforeEach(async ({ page }) => {
  await installSupabaseMocks(page, { authenticated: false });
});

test('the app is served from the Pages base path', async ({ page }) => {
  const response = await page.goto(appUrl());
  expect(response, 'no response for the base path').not.toBeNull();
  expect(
    response!.status(),
    `the app is not served at ${BASE_PATH}; Vite's base and VITE_BASE_PATH disagree`,
  ).toBe(200);

  await expect(page.locator('#root')).toHaveCount(1);

  // Wait for the mount instead of sampling it.
  //
  // `#root` is in the static index.html, so it exists before any JavaScript
  // runs; reading childElementCount immediately after goto() therefore races
  // React's first render and reports 0 on a perfectly healthy app. This test
  // failed in CI for exactly that reason while the two tests below passed,
  // because they navigate again first and so happen to allow time to mount.
  // waitForFunction keeps the original diagnostic — a bundle that genuinely
  // fails to load or throws while mounting never satisfies it and the message
  // still says so — without asserting on a half-finished frame.
  await page
    .waitForFunction(() => (document.querySelector('#root')?.childElementCount ?? 0) > 0, null, {
      timeout: 10_000,
    })
    .catch(() => {
      throw new Error(
        'the root element stayed empty: the bundle did not load or threw while mounting',
      );
    });
});

test('a deep link to a protected route survives a full reload instead of 404ing', async ({ page }) => {
  const deepLink = appUrl('/samples');

  const first = await page.goto(deepLink);
  expect(first, 'no response for the deep link').not.toBeNull();
  expect(
    first!.status(),
    `${deepLink} did not return 200. On GitHub Pages only index.html exists at the base path, ` +
      'so a protected route must be addressed through the hash, not through a server path.',
  ).toBe(200);

  const signIn = page
    .getByRole('button', { name: /sign in with google/i })
    .or(page.getByRole('link', { name: /sign in with google/i }));

  // Unauthenticated deep link must land on the gate, not on the route and not
  // on a blank page.
  await expect(signIn, 'a deep link to a protected route did not land on the sign-in gate').toBeVisible();

  const afterRedirect = page.url();
  expect(
    afterRedirect,
    'the URL lost its hash. A path-based route cannot be refreshed on GitHub Pages, ' +
      'which is exactly why HashRouter is mandated — this looks like a switch to BrowserRouter.',
  ).toContain('#');

  // The requirement is specifically about a FULL reload, which re-runs the
  // whole bootstrap from the server rather than re-rendering in place.
  const reloaded = await page.reload();
  expect(reloaded, 'no response after reload').not.toBeNull();
  expect(reloaded!.status(), 'reloading the deep link 404ed').toBe(200);
  await expect(signIn, 'the sign-in gate did not survive a full reload of the deep link').toBeVisible();

  const mounted = await page.evaluate(() => document.querySelector('#root')?.childElementCount ?? 0);
  expect(mounted, 'white screen after reloading a deep link').toBeGreaterThan(0);
});

test('built asset URLs carry the base path, so they resolve from a subpath', async ({ page }) => {
  const assetRequests: string[] = [];
  page.on('request', (request) => {
    if (['script', 'stylesheet'].includes(request.resourceType())) assetRequests.push(request.url());
  });

  await page.goto(appUrl());
  await expect(page.locator('#root')).toHaveCount(1);

  expect(assetRequests.length, 'the page requested no script or stylesheet at all').toBeGreaterThan(0);

  if (BASE_PATH !== '/') {
    const offPath = assetRequests.filter((url) => !new URL(url).pathname.startsWith(BASE_PATH));
    expect(
      offPath,
      `these assets were requested outside ${BASE_PATH} and would 404 on GitHub Pages: ${offPath.join(', ')}`,
    ).toHaveLength(0);
  }
});
