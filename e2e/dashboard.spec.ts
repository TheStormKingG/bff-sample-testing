/**
 * The home dashboard — MOCKED SESSION, NOT AN INTEGRATION TEST.
 *
 * No Supabase project and no Google OAuth client exist in CI, so the signed-in
 * state is produced by (a) writing a structurally valid session into
 * localStorage under the key src/lib/supabase.ts actually uses, and
 * (b) answering every Supabase request at the network layer. Nothing here
 * exercises real authentication, real Row Level Security or real
 * authorisation. A pass means the dashboard renders correctly GIVEN an
 * approved session; it is NOT evidence that such a session could only have
 * been obtained legitimately. See e2e/README.md.
 *
 * Covers Master Prompt §2: exactly seven primary cards, in a fixed order,
 * large enough to hit, with secondary navigation kept out of that set.
 *
 * The cards are located by the route they link to (`#/stage/<id>`) rather than
 * by markup or by text. That is the routing contract in src/App.tsx, so the
 * locator cannot drift with a class name or a copy change, and it is also what
 * makes "is this a stage form?" answerable rather than guessed.
 */

import { expect, test, type Page } from '@playwright/test';
import {
  DASHBOARD_STAGES,
  MIN_TAP_TARGET_PX,
  SECONDARY_NAV_LABELS,
  SECONDARY_NAV_ROUTES,
  appUrl,
  clickableBoxes,
  hasHorizontalScroll,
  matchesLabel,
  seedApprovedSession,
  stageLinks,
  stageOf,
  type NamedBox,
} from './fixtures/app';

/**
 * The seven cards, or a failure naming every control that WAS on screen.
 * Also the positive control for this file: each spec below asserts something
 * about the cards, and an empty page would satisfy several of those assertions
 * vacuously.
 */
async function dashboardCards(page: Page): Promise<{ cards: NamedBox[]; boxes: NamedBox[]; inventory: string }> {
  const boxes = await clickableBoxes(page);
  const inventory = boxes.map((box) => `${box.name || '(unnamed)'}${box.href ? ` -> ${box.href}` : ''}`).join(' | ');
  const cards = stageLinks(boxes);
  expect(
    cards.length,
    `expected seven links to #/stage/<id>. Controls on screen: ${inventory}`,
  ).toBe(7);
  return { cards, boxes, inventory };
}

test.beforeEach(async ({ page }) => {
  await seedApprovedSession(page, { role: 'quality_officer', status: 'active' });
});

test('the seven stage cards render in the order fixed by the build spec', async ({ page }) => {
  await page.goto(appUrl());
  // Wait for the first card rather than for a timer: the gate renders a
  // "Checking your access" screen until the profile query resolves.
  await expect(page.locator('a[href$="#/stage/raw_materials"]')).toBeVisible();

  const { cards, inventory } = await dashboardCards(page);

  // `cards` is in visual order, so this is the order an operator reads.
  expect(
    cards.map(stageOf),
    `the cards are not laid out in the required order. Controls on screen: ${inventory}`,
  ).toEqual(DASHBOARD_STAGES.map((entry) => entry.stage));

  // And each one is labelled with its own stage, not merely positioned there.
  for (const [index, card] of cards.entries()) {
    const expected = DASHBOARD_STAGES[index]!;
    expect(
      matchesLabel(card.name, expected.title),
      `the card at position ${index + 1} links to ${stageOf(card)} but is labelled "${card.name}"`,
    ).toBe(true);
  }
});

test('each stage card is at least a 44px tap target', async ({ page }) => {
  await page.goto(appUrl());
  await expect(page.locator('a[href$="#/stage/raw_materials"]')).toBeVisible();
  const { cards } = await dashboardCards(page);

  for (const card of cards) {
    expect(
      Math.min(card.width, card.height),
      `the "${stageOf(card)}" card renders ${Math.round(card.width)}x${Math.round(card.height)}px, below the ` +
        `${MIN_TAP_TARGET_PX}px minimum for a gloved hand on a plant tablet (PRD NFR-004)`,
    ).toBeGreaterThanOrEqual(MIN_TAP_TARGET_PX);
  }
});

test('secondary navigation is present but is not an eighth stage card', async ({ page }) => {
  await page.goto(appUrl());
  await expect(page.locator('a[href$="#/stage/raw_materials"]')).toBeVisible();
  const { cards, boxes, inventory } = await dashboardCards(page);

  // No stage card may lead to a records screen, and no records screen may be
  // reached through a stage route. The two sets are disjoint by construction
  // if the hrefs are right, so this is the assertion that proves it.
  const cardTargets = new Set(cards.map((card) => card.href.replace(/^.*#/, '')));
  for (const route of SECONDARY_NAV_ROUTES) {
    expect(
      cardTargets.has(route),
      `"${route}" is reachable from one of the seven primary cards, so the dashboard offers a records ` +
        `screen as if it were a testing form. Controls on screen: ${inventory}`,
    ).toBe(false);
  }

  // The secondary destinations must still be reachable — asserting only their
  // absence from the card set would also pass if they vanished entirely.
  const secondaryPresent = SECONDARY_NAV_ROUTES.filter((route) =>
    boxes.some((box) => box.href.endsWith(`#${route}`)),
  );
  expect(
    secondaryPresent.length,
    `no secondary navigation destination is reachable at all. Controls on screen: ${inventory}`,
  ).toBeGreaterThan(0);

  // No stage card may be TITLED like a records screen.
  //
  // This deliberately matches the card's HEADING, not its flattened
  // accessible name. The name includes the card's own count sentence —
  // "...0 samples collected today for Raw Materials" — so a whole-word scan
  // for the secondary label "Samples" matched all seven cards and failed a
  // correct dashboard. The mislabelling this is meant to catch is a stage
  // card whose heading reads "Samples" or "Holds", and a heading comparison
  // catches that without the incidental text.
  for (const label of SECONDARY_NAV_LABELS) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const misTitled = page
      .locator('a[href*="#/stage/"]')
      .filter({ has: page.getByRole('heading', { name: new RegExp(`^\\s*${escaped}\\s*$`, 'i') }) });
    await expect(
      misTitled,
      `a stage card is titled "${label}", so a records screen is presented as a testing form`,
    ).toHaveCount(0);
  }
});

const VIEWPORTS = [
  { label: 'small phone', width: 375, height: 812 },
  { label: 'plant tablet', width: 768, height: 1024 },
] as const;

for (const viewport of VIEWPORTS) {
  test(`the dashboard has no horizontal scroll at ${viewport.width}px (${viewport.label})`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto(appUrl());
    await expect(page.locator('a[href$="#/stage/raw_materials"]')).toBeVisible();
    await dashboardCards(page); // positive control: the seven cards really rendered

    const { scrollWidth, clientWidth } = await hasHorizontalScroll(page);
    // 1px for sub-pixel layout rounding; more than that is a real element
    // wider than the screen.
    expect(
      scrollWidth,
      `the dashboard scrolls sideways at ${viewport.width}px (content ${scrollWidth}px in a ${clientWidth}px viewport)`,
    ).toBeLessThanOrEqual(clientWidth + 1);
  });
}
