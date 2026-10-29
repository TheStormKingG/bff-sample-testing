/**
 * Shared E2E helpers.
 *
 * Two jobs:
 *
 *  1. Address the app the way GitHub Pages serves it. `vite preview` honours
 *     Vite's `base`, so a build made with VITE_BASE_PATH=/REPO/ is served at
 *     http://localhost:4173/REPO/ and NOTHING is served at `/`. Specs therefore
 *     never navigate to '/' — they navigate to `appUrl(...)`.
 *
 *  2. Stand in for Supabase. No Supabase project and no Google OAuth client
 *     are available in CI, so anything behind the authentication gate is
 *     exercised against network-layer mocks. Every spec that uses
 *     `seedApprovedSession` is MOCKED, not an integration test, and
 *     e2e/README.md says so per spec. A mocked pass is never evidence that the
 *     real backend works.
 *
 * Everything below that mirrors the application was READ from the application,
 * not assumed: the storage key from src/lib/supabase.ts, the table and column
 * names from src/hooks/useProfile.ts, the stage ids and titles from
 * src/forms/registry.ts, the routes from src/App.tsx. If one of those moves,
 * the spec that depends on it fails with a message naming what it looked for.
 */

import type { Page, Request, Route } from '@playwright/test';

// ---------------------------------------------------------------------------
// Addressing the app on its Pages base path
// ---------------------------------------------------------------------------

function normaliseBase(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed === '/') return '/';
  const withLeading = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  return withLeading.endsWith('/') ? withLeading : `${withLeading}/`;
}

/**
 * The base path the build under test was produced with. playwright.config.ts
 * passes the same value to the preview server, so the two always agree.
 */
export const BASE_PATH = normaliseBase(process.env.VITE_BASE_PATH ?? '/');

/**
 * A URL for a hash route, on the base path.
 * `appUrl()` -> '/REPO/'   `appUrl('/samples')` -> '/REPO/#/samples'
 */
export function appUrl(hashRoute = ''): string {
  if (hashRoute === '') return BASE_PATH;
  const route = hashRoute.startsWith('/') ? hashRoute : `/${hashRoute}`;
  return `${BASE_PATH}#${route}`;
}

// ---------------------------------------------------------------------------
// Identity used by the mocks
// ---------------------------------------------------------------------------

/** Mirrors VITE_SUPABASE_URL for the build under test; see the CI workflows. */
export const SUPABASE_URL = (process.env.VITE_SUPABASE_URL ?? 'https://exampleref.supabase.co').replace(
  /\/+$/,
  '',
);

export function supabaseOrigin(): string {
  return new URL(SUPABASE_URL).origin;
}

/**
 * The app sets an EXPLICIT storageKey in src/lib/supabase.ts rather than
 * taking supabase-js's `sb-<project ref>-auth-token` default, because GitHub
 * Pages shares one origin across every repository of an account. Seeding the
 * default key would silently do nothing, and the spec would then fail as
 * "dashboard did not render" with no hint why.
 */
export const AUTH_STORAGE_KEY = 'bff-sample-testing-auth';

function base64url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

/**
 * A structurally valid, cryptographically meaningless JWT, assembled at run
 * time rather than pasted in as a literal. That is deliberate: a literal JWT
 * carrying a `role` claim other than `anon` is exactly what
 * scripts/check-bundle-secrets.mjs treats as a leak, and it is right to.
 */
function fakeJwt(claims: Record<string, unknown>): string {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  return `${header}.${base64url(JSON.stringify(claims))}.E2E_MOCK_SIGNATURE_not_verified_anywhere`;
}

export const MOCK_USER_ID = '00000000-0000-4000-8000-000000000001';
export const MOCK_USER_EMAIL = 'e2e.quality.officer@example.invalid';
export const MOCK_USER_NAME = 'E2E Quality Officer';

/** Values from src/lib/roles.ts — not invented here. */
export type MockRole =
  | 'operator'
  | 'quality_officer'
  | 'quality_supervisor'
  | 'administrator'
  | 'auditor';
export type MockStatus = 'pending' | 'active' | 'suspended' | 'disabled';

export interface MockSessionOptions {
  readonly role?: MockRole;
  readonly status?: MockStatus;
}

export function mockUser() {
  const now = new Date().toISOString();
  return {
    id: MOCK_USER_ID,
    aud: 'authenticated',
    role: 'authenticated',
    email: MOCK_USER_EMAIL,
    email_confirmed_at: now,
    phone: '',
    confirmed_at: now,
    last_sign_in_at: now,
    app_metadata: { provider: 'google', providers: ['google'] },
    user_metadata: { full_name: MOCK_USER_NAME, email: MOCK_USER_EMAIL },
    identities: [],
    created_at: now,
    updated_at: now,
    is_anonymous: false,
  };
}

export function mockSession() {
  // Far-future expiry on purpose: an expired stored session makes gotrue-js
  // attempt a token refresh, which would make every spec depend on refresh
  // mocking as well.
  const issuedAt = Math.floor(Date.now() / 1000);
  const expiresAt = issuedAt + 60 * 60 * 24;
  return {
    access_token: fakeJwt({
      iss: `${SUPABASE_URL}/auth/v1`,
      sub: MOCK_USER_ID,
      aud: 'authenticated',
      role: 'authenticated',
      email: MOCK_USER_EMAIL,
      iat: issuedAt,
      exp: expiresAt,
      app_metadata: { provider: 'google' },
      user_metadata: { full_name: MOCK_USER_NAME },
    }),
    token_type: 'bearer',
    expires_in: 60 * 60 * 24,
    expires_at: expiresAt,
    refresh_token: 'e2e-mock-refresh-token',
    user: mockUser(),
  };
}

// ---------------------------------------------------------------------------
// Network-layer mocks
// ---------------------------------------------------------------------------

/** Table names read from src/hooks/useProfile.ts. */
const PROFILES_TABLE = 'profiles';
const USER_ROLES_TABLE = 'user_roles';

function jsonBody(route: Route, status: number, body: unknown): Promise<void> {
  return route.fulfill({
    status,
    contentType: 'application/json',
    headers: { 'access-control-allow-origin': '*' },
    body: JSON.stringify(body),
  });
}

/** `.single()` / `.maybeSingle()` ask PostgREST for an object, not an array. */
function wantsSingleObject(request: Request): boolean {
  return (request.headers()['accept'] ?? '').includes('vnd.pgrst.object');
}

function tableOf(pathname: string): string {
  return pathname.split('/rest/v1/')[1]?.split('?')[0] ?? '';
}

/** Exactly the four columns useProfile selects from `profiles`. */
function profileRow(options: MockSessionOptions) {
  return {
    id: MOCK_USER_ID,
    email: MOCK_USER_EMAIL,
    full_name: MOCK_USER_NAME,
    status: options.status ?? 'active',
  };
}

export interface MockOptions extends MockSessionOptions {
  /** When false, Supabase answers as it would for an anonymous caller. */
  readonly authenticated?: boolean;
}

/**
 * Intercept every Supabase call, installed BEFORE navigation. In CI the
 * Supabase host does not resolve at all, and an unmocked DNS failure would
 * fail specs for a reason that has nothing to do with the application.
 */
export async function installSupabaseMocks(page: Page, options: MockOptions = {}): Promise<void> {
  const authenticated = options.authenticated ?? false;

  await page.route(`${supabaseOrigin()}/**`, async (route, request) => {
    const { pathname } = new URL(request.url());

    if (request.method() === 'OPTIONS') {
      await route.fulfill({
        status: 204,
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-headers': '*',
          'access-control-allow-methods': '*',
        },
      });
      return;
    }

    if (pathname.startsWith('/auth/v1/user')) {
      if (!authenticated) {
        await jsonBody(route, 401, { message: 'Invalid or expired token' });
        return;
      }
      await jsonBody(route, 200, mockUser());
      return;
    }

    if (pathname.startsWith('/auth/v1/token')) {
      if (!authenticated) {
        await jsonBody(route, 400, { error: 'invalid_grant', error_description: 'no mock session' });
        return;
      }
      await jsonBody(route, 200, mockSession());
      return;
    }

    if (pathname.startsWith('/auth/v1/logout')) {
      await route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*' } });
      return;
    }

    if (pathname.startsWith('/auth/v1/')) {
      await jsonBody(route, 200, {});
      return;
    }

    if (pathname.startsWith('/rest/v1/')) {
      const table = tableOf(pathname);

      if (!authenticated) {
        // What RLS does to an anonymous caller: the row is simply not there.
        await jsonBody(route, 200, wantsSingleObject(request) ? null : []);
        return;
      }

      if (table === PROFILES_TABLE) {
        const row = profileRow(options);
        await jsonBody(route, 200, wantsSingleObject(request) ? row : [row]);
        return;
      }

      if (table === USER_ROLES_TABLE) {
        // Always an array: useProfile reads many rows and maps them to roles.
        await jsonBody(route, 200, [{ role: options.role ?? 'quality_officer' }]);
        return;
      }

      // Every other table answers empty, so dashboard counts read as zero or
      // "not available" and never as an invented number (Master Prompt §2:
      // live counts only if grounded in stored data).
      await jsonBody(route, 200, wantsSingleObject(request) ? null : []);
      return;
    }

    if (pathname.startsWith('/functions/v1/')) {
      await jsonBody(route, 200, { ok: true, mocked: true });
      return;
    }

    await jsonBody(route, 404, { message: `unmocked Supabase path ${pathname}` });
  });
}

/**
 * Put a session into localStorage before any app code runs, then install the
 * authenticated mocks. supabase-js reads its stored session while the client
 * is being constructed, so this is equivalent to a user who already completed
 * Google sign-in.
 */
export async function seedApprovedSession(page: Page, options: MockSessionOptions = {}): Promise<void> {
  await page.addInitScript(
    ({ storageKey, value }: { storageKey: string; value: string }) => {
      try {
        window.localStorage.setItem(storageKey, value);
      } catch {
        // Storage disabled: the spec's own assertions then fail, which is the
        // correct signal — not something to paper over here.
      }
    },
    { storageKey: AUTH_STORAGE_KEY, value: JSON.stringify(mockSession()) },
  );
  await installSupabaseMocks(page, { ...options, authenticated: true });
}

// ---------------------------------------------------------------------------
// Expectations drawn from the written contract and the shared registry
// ---------------------------------------------------------------------------

/**
 * Master Prompt §2 fixes the first seven primary cards, in exactly this order;
 * DGM is eighth, added 2026-10-29. `stage` is the route segment (src/App.tsx
 * mounts `stage/:stage`); `title` is the schema title from
 * src/forms/registry.ts.
 *
 * This is a hand-maintained duplicate of `DASHBOARD_ORDER` — Playwright does
 * not import application source — so nothing makes it follow the registry.
 * `dashboard.spec.ts` compares the rendered cards against it, which catches a
 * drift in either direction but only when the e2e suite runs.
 */
export const DASHBOARD_STAGES = [
  { stage: 'raw_materials', title: 'Raw Materials' },
  { stage: 'ground', title: 'Ground' },
  { stage: 'conditioned', title: 'Conditioned' },
  { stage: 'pellets', title: 'Pellets' },
  { stage: 'extruded_soya', title: 'Extruded Soya' },
  { stage: 'crumble', title: 'Crumble' },
  { stage: 'mash', title: 'Mash' },
  { stage: 'dgm', title: 'DGM' },
] as const;

export const DASHBOARD_CARDS = DASHBOARD_STAGES.map((entry) => entry.title);

/**
 * The secondary, record-oriented destinations — Master Prompt §2 is explicit
 * that these "are not additional testing-form buttons". Routes from
 * src/App.tsx, labels from src/components/layout/navItems.ts.
 */
export const SECONDARY_NAV_ROUTES = [
  '/samples',
  '/awaiting',
  '/holds',
  '/reviews',
  '/specifications',
  '/reports',
  '/admin',
] as const;

export const SECONDARY_NAV_LABELS = [
  'Samples',
  'Awaiting Results',
  'Holds',
  'Reviews',
  'Approved limits',
  'Reports',
  'Admin',
] as const;

/** PRD NFR-004: `minHeight.tap` is 44px in tailwind.config.js. */
export const MIN_TAP_TARGET_PX = 44;

/** Sample identifiers from src/lib/sampleId.ts (`PREFIX-YYMMDD-NN`). */
export const SAMPLE_ID_PATTERN = /\b(?:RM|AM|BC|AC|AP|ES|CR|MS)-\d{6}-\d{2,}\b/;

// ---------------------------------------------------------------------------
// Origins
// ---------------------------------------------------------------------------

export function allowedOrigins(baseURL: string): readonly string[] {
  return [new URL(baseURL).origin, supabaseOrigin()];
}

/**
 * Origins contacted that are neither the app itself nor its Supabase project.
 * Any of them is a finding: a CDN, font host or analytics endpoint both leaks
 * plant activity and breaks on a plant connection with restricted egress.
 * `data:`, `blob:` and `about:` are not origins and are excluded.
 */
export function thirdPartyOrigins(requests: readonly Request[], baseURL: string): string[] {
  const allowed = new Set(allowedOrigins(baseURL));
  const seen = new Set<string>();
  for (const request of requests) {
    const url = request.url();
    if (!/^https?:/i.test(url)) continue;
    const { origin } = new URL(url);
    if (!allowed.has(origin)) seen.add(origin);
  }
  return [...seen].sort();
}

// ---------------------------------------------------------------------------
// Rendered geometry
// ---------------------------------------------------------------------------

export interface NamedBox {
  readonly name: string;
  readonly href: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Every visible clickable control with its accessible-ish name, its link
 * target and its RENDERED box. Ordered visually (top to bottom, then left to
 * right), not by DOM order, because "the cards are in this order" is a claim
 * about what the operator sees.
 */
export async function clickableBoxes(page: Page): Promise<NamedBox[]> {
  const boxes = await page.evaluate(() => {
    const out: { name: string; href: string; x: number; y: number; width: number; height: number }[] = [];
    for (const element of Array.from(document.querySelectorAll('a, button, [role="button"], [role="link"]'))) {
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      const label =
        element.getAttribute('aria-label') ??
        (element as HTMLElement).innerText ??
        element.textContent ??
        '';
      out.push({
        name: label.replace(/\s+/g, ' ').trim(),
        href: element.getAttribute('href') ?? '',
        x: rect.x + window.scrollX,
        y: rect.y + window.scrollY,
        width: rect.width,
        height: rect.height,
      });
    }
    return out;
  });

  const heights = boxes.map((box) => box.height).filter((height) => height > 0);
  const tolerance = Math.max(8, Math.min(heights.length > 0 ? Math.min(...heights) : 64, 64) / 2);
  return [...boxes].sort((a, b) => (Math.abs(a.y - b.y) <= tolerance ? a.x - b.x : a.y - b.y));
}

/** The stage-form cards, identified by the route they link to. */
export function stageLinks(boxes: readonly NamedBox[]): NamedBox[] {
  return boxes.filter((box) => /#\/stage\/[a-z_]+$/.test(box.href));
}

export function stageOf(box: NamedBox): string {
  return box.href.replace(/^.*#\/stage\//, '');
}

/** Match a label as a whole phrase, case-insensitively. */
export function matchesLabel(name: string, label: string): boolean {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^A-Za-z])${escaped}(?:[^A-Za-z]|$)`, 'i').test(name);
}

export async function hasHorizontalScroll(
  page: Page,
): Promise<{ scrollWidth: number; clientWidth: number }> {
  return page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
}
