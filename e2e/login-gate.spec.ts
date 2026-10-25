/**
 * The authentication gate, exercised WITHOUT credentials.
 *
 * Runs for real: a real production build served by `vite preview` on the Pages
 * base path. The only thing mocked is the Supabase origin, and only so that a
 * host which does not resolve in CI cannot fail these specs for a reason that
 * has nothing to do with the gate.
 *
 * Covers PRD UAT-09 (pending/unauthorised accounts see nothing) in its
 * unauthenticated half, and Master Prompt §2 ("Do not expose data while
 * checking user permission").
 */

import { expect, test } from '@playwright/test';
import {
  DASHBOARD_CARDS,
  SAMPLE_ID_PATTERN,
  SECONDARY_NAV_LABELS,
  appUrl,
  clickableBoxes,
  installSupabaseMocks,
  matchesLabel,
} from './fixtures/app';

const SIGN_IN = /sign in with google/i;

test.beforeEach(async ({ page }) => {
  await installSupabaseMocks(page, { authenticated: false });
});

test('the login page renders and offers exactly one Sign in with Google control', async ({ page }) => {
  await page.goto(appUrl());

  const control = page
    .getByRole('button', { name: SIGN_IN })
    .or(page.getByRole('link', { name: SIGN_IN }));

  // This is also the positive control for the two specs below: every
  // "X is absent" assertion in this file is satisfied by a blank page, so each
  // one is only meaningful once something is proven to have rendered.
  await expect(control).toHaveCount(1);
  await expect(control).toBeVisible();

  const boxes = await clickableBoxes(page);
  const signInBox = boxes.find((box) => SIGN_IN.test(box.name));
  expect(signInBox, `no clickable control matched ${SIGN_IN}; found: ${boxes.map((b) => b.name).join(' | ')}`)
    .toBeDefined();
  // NFR-004: operators use gloves on a plant tablet.
  expect(signInBox!.height).toBeGreaterThanOrEqual(44);
});

test('no stage form, secondary navigation or sample data is reachable before sign-in', async ({ page }) => {
  await page.goto(appUrl());

  const control = page
    .getByRole('button', { name: SIGN_IN })
    .or(page.getByRole('link', { name: SIGN_IN }));
  await expect(control).toBeVisible(); // positive control: the app did render

  const boxes = await clickableBoxes(page);
  const names = boxes.map((box) => box.name);

  for (const card of DASHBOARD_CARDS) {
    expect(
      names.filter((name) => matchesLabel(name, card)),
      `the stage form "${card}" is offered before authentication; controls on screen: ${names.join(' | ')}`,
    ).toHaveLength(0);
  }

  for (const item of SECONDARY_NAV_LABELS) {
    expect(
      names.filter((name) => matchesLabel(name, item)),
      `the secondary navigation item "${item}" is offered before authentication`,
    ).toHaveLength(0);
  }

  const bodyText = await page.evaluate(() => document.body.innerText);
  expect(bodyText.length, 'the page rendered no text at all, so these absence checks prove nothing')
    .toBeGreaterThan(0);
  expect(
    bodyText,
    'a sample identifier is visible before authentication, so record data is leaking to anonymous visitors',
  ).not.toMatch(SAMPLE_ID_PATTERN);
});

test('the sign-in control does not navigate anywhere on load, and no session is assumed', async ({ page }) => {
  await page.goto(appUrl());
  await expect(
    page.getByRole('button', { name: SIGN_IN }).or(page.getByRole('link', { name: SIGN_IN })),
  ).toBeVisible();

  // Google login proves identity, it does not grant app permission: nothing may
  // be treated as signed in until a session exists.
  const storedSessionKeys = await page.evaluate(() =>
    Object.keys(window.localStorage).filter((key) => /auth-token$/.test(key)),
  );
  expect(storedSessionKeys, 'a session token exists in storage without anyone signing in').toHaveLength(0);
});
