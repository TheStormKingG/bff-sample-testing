# End-to-end specs — what they actually prove

This file exists so that nobody reads a green Playwright run as more assurance
than it is. Of the 18 specs in this directory, **10 exercise the real
application unauthenticated, 5 run against a forged session and are not
integration tests at all, and 3 are skipped until credentials for an isolated
test Supabase project are supplied.** A mocked pass is not an integration pass,
and the table below is the mapping.

Read this before quoting an e2e result as UAT evidence.

---

## 1. How the suite is wired

`playwright.config.ts` builds and previews the **real production bundle** and
serves it on the GitHub Pages base path:

```
webServer.command = npm run build && npm run preview -- --port 4173 --strictPort
webServer.env     = { VITE_BASE_PATH: process.env.VITE_BASE_PATH ?? '/' }
use.baseURL       = process.env.E2E_BASE_URL ?? 'http://localhost:4173'
```

So the code under test is the shipped artefact, minified, with Vite's `base`
compiled in — not a dev server. Specs never navigate to `/`; they use
`appUrl()` from `fixtures/app.ts`, which prefixes the base path and puts the
route in the hash.

Three projects, all Chromium device descriptors (CI installs Chromium only):

| project | device |
| --- | --- |
| `desktop-chrome` | Desktop Chrome |
| `plant-tablet` | Galaxy Tab S4 |
| `small-phone` | Galaxy S9+ |

Every spec therefore runs three times: **18 declarations → 54 runs.** Note that
the four viewport specs call `page.setViewportSize()` themselves, which
overrides the project's device viewport — those four assert the same two widths
(375px, 768px) in all three projects rather than three different ones.

### `retries: 0`, and why it stays that way

`playwright.config.ts` sets `retries: 0` deliberately. This app is a quality
record: its acceptance evidence has to mean what it says, and a retry launders
exactly the signal that matters. A spec that fails on attempt 1 and passes on
attempt 2 has told you something true — that the behaviour is not
deterministic — and `retries: 1` would convert that finding into a green tick
with a small "flaky" annotation nobody reads in a release decision.

It matters more here than in a typical suite because much of what is asserted
is *timing-adjacent*: a rendered geometry measurement, a `networkidle` wait, a
mocked response resolving before a React query. Those are the assertions most
likely to pass on a second attempt for no good reason, and they are also the
ones whose failure is most worth investigating. With retries off, a flake is a
ticket; with retries on, a flake is indistinguishable from a pass.

Consequently: **do not "fix" a failing e2e spec by enabling retries.** Either
the application is non-deterministic, or the spec is measuring something it
should not.

---

## 2. The three honesty tiers

### Tier A — real, unauthenticated (10 specs)

These drive the real build with no session. The only thing intercepted is the
**Supabase origin**, and only because that host does not resolve in CI: an
unmocked DNS failure would fail these specs for a reason that has nothing to do
with the behaviour under test. `installSupabaseMocks(page, { authenticated:
false })` answers that origin the way a backend answers an anonymous caller —
`401` on `/auth/v1/user`, `400 invalid_grant` on `/auth/v1/token`, empty
`[]`/`null` on every `/rest/v1/` table.

**What a Tier A pass does prove:** the application's own gate logic is correct
given an anonymous backend. It renders the sign-in page and mounts no
application route; it stores no session token; no sample identifier appears
anywhere in the document; the sign-in control is a ≥44px target; there is no
horizontal scroll at 375px or 768px; no origin outside the app and its Supabase
project is contacted; the app is served from the Pages subpath; a deep link to
a protected route survives a **full reload** instead of 404ing; and built asset
URLs carry the base path.

**What a Tier A pass does not prove:** that Row Level Security actually denies
an anonymous caller. The fixture decides that by fiat — it returns `[]` because
it was written to. The real claim is a database claim and belongs to the
migrations and their SQL tests, not to a browser spec. If RLS were wide open
tomorrow, every spec in this tier would still pass.

| spec | tests | asserts |
| --- | --- | --- |
| `first-load.spec.ts` | 4 | no uncaught exception and no application `console.error` on first load; no 5xx; no third-party origin; no horizontal scroll at 375px and 768px |
| `login-gate.spec.ts` | 3 | exactly one "Sign in with Google" control, ≥44px; no stage card, secondary-nav item or sample ID reachable pre-sign-in; no auth token in storage without signing in |
| `pages-routing.spec.ts` | 3 | the app is served at the base path and `#root` is non-empty; a deep link keeps its hash and survives a full reload; script/stylesheet URLs stay inside the base path |

`first-load.spec.ts` separates two different claims that both look like
"console errors": messages the application emitted (`appErrors`, asserted on)
and notices the browser wrote because a subresource came back non-2xx
(`resourceNotices`, reported for context but **not** asserted on, because the
network here is partly our own fixture and grading the app on it would grade
the fixture). See `fixtures/console.ts`.

### Tier B — forged session, NOT an integration test (5 specs)

`dashboard.spec.ts` is the whole of this tier. There is no Supabase project and
no Google OAuth client in CI, so a signed-in state is manufactured:

1. `page.addInitScript` writes a structurally valid session into `localStorage`
   under `bff-sample-testing-auth` — the explicit `storageKey` from
   `src/lib/supabase.ts`, not supabase-js's default. The access token is
   assembled at run time and its signature is the literal string
   `E2E_MOCK_SIGNATURE_not_verified_anywhere`. Nothing verifies it, because
   nothing real is on the other end.
2. The authenticated mocks then return a `profiles` row with `status: 'active'`
   and a `user_roles` row carrying the requested role.

**A pass means: the dashboard renders correctly GIVEN an approved session.** It
is not evidence that such a session could only have been obtained legitimately,
and it exercises no real authentication, no real RLS and no real
authorisation — the role it reports on is one the fixture asserted, not one the
database granted.

| spec | tests | asserts |
| --- | --- | --- |
| `dashboard.spec.ts` | 5 | exactly seven links to `#/stage/<id>`, in the order fixed by the build spec, each labelled with its own stage; each card ≥44px; the seven secondary destinations are reachable but none of them is an eighth stage card; no horizontal scroll at 375px and 768px |

The cards are located by the route they link to rather than by markup or copy,
so the locator tracks the routing contract in `src/App.tsx` instead of drifting
with a class name.

### Tier C — real backend, skipped by default (3 specs)

`authenticated-integration.spec.ts` mocks nothing. If it runs, it runs against
a real project, real RLS and real rows — which is why it does not run unless
you say so.

| spec | tests | skip guard |
| --- | --- | --- |
| `authenticated-integration.spec.ts` | 3 | a `describe`-level project guard, plus a per-test token guard on each |

Exactly what each skipped test needs:

| test | required to run |
| --- | --- |
| *an approved user reaches the dashboard, and the data really came from the project* | `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, **`E2E_APPROVED_USER_TOKEN`** — an access token for a test user whose `profiles` row has `status = 'active'` |
| *a pending user is shown the pending screen and reaches no data* | `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, **`E2E_PENDING_USER_TOKEN`** — an access token for a test user whose `profiles` row has `status = 'pending'` |
| *a deep link to a protected route is refused for a pending user, including after reload* | same as above — **`E2E_PENDING_USER_TOKEN`** |

`E2E_REFRESH_TOKEN` is read if present and defaults to `''`; it is not required.

Three further conditions, all easy to get wrong:

- **The build must be made with the same `VITE_SUPABASE_URL` as the tokens
  belong to.** `webServer` builds the app, so the URL has to be in the
  environment *before* Playwright starts, not only in the spec's process.
- Use an **isolated test project** and throwaway accounts. Never a real staff
  session, and never a service-role key — that key must not reach a browser
  under any circumstances.
- The tokens expire. `seedRealSession` throws a clear error rather than failing
  obscurely if you hand it a stale one.

The first of those three tests carries the assertion that makes it an
integration test rather than a dressed-up render test: at least one successful
response must have come back from the Supabase origin. Without it, a
misconfigured run could pass while talking to nothing.

#### A skip guard that does not fire where you would expect

`HAS_PROJECT` is computed as "`VITE_SUPABASE_URL` contains `.supabase.` and
`VITE_SUPABASE_ANON_KEY` is non-empty". `.github/workflows/ci.yml` sets a
workflow-level placeholder `VITE_SUPABASE_URL: https://exampleref.supabase.co`
and a placeholder anon key, and that string **does** contain `.supabase.`. So
in CI the `describe`-level guard evaluates to "a project is configured" and
does not fire. All three tests still skip — on their per-test token guards,
since neither token is set — so the CI outcome is correct, but the reported
reason is the token one, and the project guard is doing nothing there.

Two practical consequences:

- Do not read "3 skipped" in CI as "no test project configured". Read it as
  "no test tokens supplied".
- If you supply tokens but leave the placeholder URL in place, the project
  guard will **not** stop the run. The specs will execute against a host that
  does not resolve and fail as network errors rather than skipping. Set the
  real test-project URL in the same environment as the tokens.

This is a note about `authenticated-integration.spec.ts`, not a change to it.

---

## 3. What no spec in this directory covers

Everything below is outside the suite today. None of it is asserted anywhere in
`e2e/`, and a full green run says nothing about any of it:

- stage form rendering, field applicability, validation and submission
- sample registration, the sample-ID sequence, and the registration receipt
- results entry, assessment against limits, and the hold triggers
- review and approval, separation of duties, disposition and release
- specification approval
- reports and the dashboard's live counts beyond "they are not invented"
- administrator user approval
- the Google Sheets projection, the outbox and the sync worker
- the interactive Google sign-in round trip

The last one is **deliberately** absent rather than merely missing. It needs a
human at a Google consent screen, so a Playwright spec for it could never
actually run; writing one would ship a permanently skipped, permanently
unverified test that reads as coverage while being none. It is a manual UAT
step. Covering the rest means either widening Tier C (real project, real rows)
or adding server-side tests — not adding more Tier B mocks, which would grow
the green count without growing the assurance.

---

## 4. Running them

```bash
# Tier A + Tier B. Tier C skips.
npm run test:e2e

# On the Pages subpath, as CI does.
VITE_BASE_PATH=/your-repo/ npm run test:e2e

# One spec, one project.
npx playwright test e2e/login-gate.spec.ts --project=desktop-chrome
```

Two things that bite on a first local run:

1. **The frontend env must be set, or every spec fails identically.**
   `src/lib/env.ts` validates `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`
   while its module body runs, and `src/main.tsx` turns that throw into a
   configuration-error screen. With no `.env` present the built app shows that
   screen, the sign-in button never appears, and all 54 runs fail on a locator
   timeout that looks like an application bug. Copy `.env.example` to `.env`
   first. For a mocked run the values only have to be well-formed — an `https`
   URL and any non-empty key; the placeholders in `.github/workflows/ci.yml`
   are what CI uses, and `fixtures/app.ts` falls back to the same
   `exampleref.supabase.co` origin for its route pattern. Keep the two in
   agreement, or the mocks will be installed on an origin the app does not
   call.
2. **`webServer.command` runs `npm run build`, which is `tsc -b && vite
   build`.** The whole project has to typecheck before a single spec starts, so
   a type error anywhere — including in a file unrelated to the spec you are
   running — stops the suite before Playwright opens a browser.

CI (`.github/workflows/ci.yml`, job `e2e`) derives `VITE_BASE_PATH` from the
repository name, installs Chromium only, runs with `workers: 1`, and uploads
`playwright-report/` and `test-results/` on failure. It also re-scans the
base-path bundle for leaked credentials, because that build is a different
artefact from the one the `verify` job scanned.
