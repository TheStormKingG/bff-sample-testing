/**
 * REAL-BACKEND specs. SKIPPED unless credentials for an isolated TEST Supabase
 * project are supplied. Nothing in this file is mocked: if it runs, it runs
 * against a real project, real Row Level Security and real rows.
 *
 * Required to run:
 *   E2E_REAL_BACKEND=1       the explicit opt-in. Nothing here runs without it,
 *                            whatever the other variables say.
 *   VITE_SUPABASE_URL        the TEST project's URL (never production)
 *   VITE_SUPABASE_ANON_KEY   that project's publishable / anon key
 *   E2E_APPROVED_USER_TOKEN  an access token for a user whose profile is active
 *   E2E_PENDING_USER_TOKEN   an access token for a user whose profile is pending
 *
 * The build under test must be built with the same VITE_SUPABASE_URL, or the
 * app will talk to a different project than the one the tokens belong to.
 *
 * The tokens are session tokens for throwaway accounts in a throwaway project.
 * Never a real staff session, and never a service-role key: that key must not
 * reach a browser under any circumstances.
 *
 * NOT COVERED HERE, DELIBERATELY: the interactive Google sign-in round trip.
 * It needs a human at a Google consent screen, so it cannot be a Playwright
 * spec that would ever actually run. Writing one would mean shipping a test
 * that is permanently skipped and permanently unverified, which reads as
 * coverage while being none. It is a manual UAT step — see e2e/README.md.
 */

import { expect, test, type Page } from '@playwright/test';
import {
  AUTH_STORAGE_KEY,
  DASHBOARD_STAGES,
  SAMPLE_ID_PATTERN,
  appUrl,
  clickableBoxes,
  stageLinks,
  stageOf,
  supabaseOrigin,
} from './fixtures/app';

const APPROVED_TOKEN = process.env.E2E_APPROVED_USER_TOKEN;
const PENDING_TOKEN = process.env.E2E_PENDING_USER_TOKEN;

/**
 * Running against a real backend is an EXPLICIT OPT-IN. It is never inferred
 * from the shape of a value.
 *
 * The previous guard asked whether VITE_SUPABASE_URL contained '.supabase.'.
 * `.github/workflows/ci.yml` sets the deliberate placeholder
 * `https://exampleref.supabase.co`, which contains it — so in CI the guard
 * concluded "a real project is configured" in precisely the environment it
 * existed to exclude. That was not bad luck: a placeholder has to look like a
 * real value to satisfy the app's own startup validation and the Tier B route
 * mocks, so a predicate asking "does this look real" asks the one question
 * every placeholder is built to answer yes.
 *
 * It left no symptom, which is why it survived. All three specs did skip in
 * CI — on their per-test token guards below, for an unrelated reason — so the
 * skip count was exactly what a working guard would produce, and the only way
 * to see the dead layer was to evaluate its predicate by hand.
 *
 * `E2E_REAL_BACKEND=1` cannot be satisfied by a placeholder, because no
 * placeholder has any reason to set it. The URL and key are still required:
 * opting in without them is a misconfiguration, not a run.
 *
 * Residual risk, stated rather than papered over: opting in while leaving a
 * placeholder URL in place still fails as network errors rather than skipping.
 * Catching that would mean hard-coding ci.yml's placeholder literal here, and
 * a two-file agreement kept only by a comment does not break when one side
 * changes it — it inverts into a confident "this is a real project". The
 * opt-in is a deliberate act naming a real project; that is the guard.
 */
const REAL_BACKEND_OPT_IN = process.env.E2E_REAL_BACKEND === '1';

function isSet(name: string): boolean {
  const value = process.env[name];
  return typeof value === 'string' && value.length > 0;
}

/**
 * What is missing, named individually, so the reported skip reason states
 * which predicate was actually decisive. Where two guards can both produce a
 * skip, the skip itself is evidence about neither — the reason is, and it is
 * what the next person provisions against.
 */
const MISSING_FOR_REAL_BACKEND: readonly string[] = [
  ...(REAL_BACKEND_OPT_IN
    ? []
    : ['E2E_REAL_BACKEND=1 (the explicit opt-in; set it only for an isolated TEST project)']),
  ...(isSet('VITE_SUPABASE_URL')
    ? []
    : ['VITE_SUPABASE_URL (the TEST project URL, needed at build time as well as here)']),
  ...(isSet('VITE_SUPABASE_ANON_KEY') ? [] : ["VITE_SUPABASE_ANON_KEY (that project's publishable key)"]),
];

interface TokenClaims {
  readonly sub: string;
  readonly exp: number;
  readonly email?: string;
}

function claimsOf(accessToken: string): TokenClaims {
  const segment = accessToken.split('.')[1];
  if (segment === undefined) throw new Error('the supplied E2E token is not a JWT: no payload segment');
  const parsed: unknown = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as { sub?: unknown }).sub !== 'string' ||
    typeof (parsed as { exp?: unknown }).exp !== 'number'
  ) {
    throw new Error('the supplied E2E token has no `sub` and `exp` claims');
  }
  const claims = parsed as { sub: string; exp: number; email?: unknown };
  return {
    sub: claims.sub,
    exp: claims.exp,
    ...(typeof claims.email === 'string' ? { email: claims.email } : {}),
  };
}

/**
 * Seed a REAL session. The stored object carries a `user` built from the
 * token's own claims, because supabase-js hands the stored session straight to
 * the app and `useSession` reads `user.id` from it.
 */
async function seedRealSession(page: Page, accessToken: string): Promise<void> {
  const claims = claimsOf(accessToken);
  if (claims.exp * 1000 < Date.now()) {
    throw new Error('the supplied E2E access token has already expired; mint a fresh one');
  }
  const now = new Date().toISOString();
  const session = {
    access_token: accessToken,
    token_type: 'bearer',
    expires_at: claims.exp,
    expires_in: claims.exp - Math.floor(Date.now() / 1000),
    refresh_token: process.env.E2E_REFRESH_TOKEN ?? '',
    user: {
      id: claims.sub,
      aud: 'authenticated',
      role: 'authenticated',
      email: claims.email ?? '',
      app_metadata: { provider: 'google', providers: ['google'] },
      user_metadata: {},
      identities: [],
      created_at: now,
      updated_at: now,
      is_anonymous: false,
    },
  };
  await page.addInitScript(
    ({ storageKey, value }: { storageKey: string; value: string }) => {
      window.localStorage.setItem(storageKey, value);
    },
    { storageKey: AUTH_STORAGE_KEY, value: JSON.stringify(session) },
  );
}

test.describe('real Supabase project', () => {
  test.skip(
    MISSING_FOR_REAL_BACKEND.length > 0,
    `skipped: no real backend opted in. Missing: ${MISSING_FOR_REAL_BACKEND.join('; ')}. ` +
      'Without a backend there is nothing to integrate with, and a mocked pass is not an integration pass.',
  );

  test('an approved user reaches the dashboard, and the data really came from the project', async ({ page }) => {
    test.skip(
      APPROVED_TOKEN === undefined,
      'skipped: needs E2E_APPROVED_USER_TOKEN — an access token for a test user whose profiles row has status active.',
    );

    const liveResponses: string[] = [];
    page.on('response', (response) => {
      if (response.url().startsWith(supabaseOrigin()) && response.status() < 400) {
        liveResponses.push(`${response.status()} ${new URL(response.url()).pathname}`);
      }
    });

    await seedRealSession(page, APPROVED_TOKEN!);
    await page.goto(appUrl());
    await expect(page.locator('a[href$="#/stage/raw_materials"]')).toBeVisible();

    const boxes = await clickableBoxes(page);
    const cards = stageLinks(boxes);
    expect(
      cards.map(stageOf),
      `an approved user did not get the seven stage cards. Controls on screen: ${boxes
        .map((box) => box.name)
        .join(' | ')}`,
    ).toEqual(DASHBOARD_STAGES.map((entry) => entry.stage));

    // The assertion that makes this an INTEGRATION test rather than a dressed
    // up render test: a successful round trip to the real project must have
    // happened. Without it, a misconfigured run could pass while talking to
    // nothing at all.
    expect(
      liveResponses,
      'no successful request reached the Supabase project, so nothing here integrated with anything',
    ).not.toEqual([]);
  });

  test('a pending user is shown the pending screen and reaches no data', async ({ page }) => {
    test.skip(
      PENDING_TOKEN === undefined,
      'skipped: needs E2E_PENDING_USER_TOKEN — an access token for a test user whose profiles row has status ' +
        'pending. This is the UAT-09 negative case: Google login proves identity and grants no app permission.',
    );

    await seedRealSession(page, PENDING_TOKEN!);
    await page.goto(appUrl());

    // Positive control first: something rendered, so the absence checks below
    // are about the gate and not about a blank page.
    await expect(page.getByText(/pending|awaiting|approval|not yet approved/i).first()).toBeVisible();

    const boxes = await clickableBoxes(page);
    expect(
      stageLinks(boxes),
      `a PENDING user was offered stage forms: ${stageLinks(boxes).map(stageOf).join(', ')}`,
    ).toHaveLength(0);

    const bodyText = await page.evaluate(() => document.body.innerText);
    expect(bodyText, 'a pending user can see sample identifiers').not.toMatch(SAMPLE_ID_PATTERN);
  });

  test('a deep link to a protected route is refused for a pending user, including after reload', async ({
    page,
  }) => {
    test.skip(PENDING_TOKEN === undefined, 'skipped: needs E2E_PENDING_USER_TOKEN.');

    await seedRealSession(page, PENDING_TOKEN!);
    const response = await page.goto(appUrl('/samples'));
    expect(response!.status()).toBe(200);
    await page.reload();

    await expect(page.getByText(/pending|awaiting|approval|not yet approved/i).first()).toBeVisible();
    const boxes = await clickableBoxes(page);
    expect(stageLinks(boxes)).toHaveLength(0);
    const bodyText = await page.evaluate(() => document.body.innerText);
    expect(bodyText).not.toMatch(SAMPLE_ID_PATTERN);
  });
});
