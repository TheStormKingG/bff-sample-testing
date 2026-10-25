# BFF Sample Testing

Seven quality-control sample-testing logs for the **Bounty Farm Limited Feed Factory,
Guyana**, digitised as a single web application.

- **Supabase Postgres** is the secure transactional ledger and the authoritative
  quality record.
- **One Bounty-Farm-owned native Google Sheet** remains the operational spreadsheet
  record. It is written **only** from the committed ledger, by an Edge Function worker,
  through a transactional outbox. The browser never touches Google.
- The **frontend is a static bundle on GitHub Pages**. It holds no authority; every read
  and write is authorised server-side by Row Level Security and authenticated Edge
  Functions.

The seven logs are the operational tabs of `BFF-FRM-06.18 Sample Test Log`: Raw
materials, Ground (AM/BC), Conditioned, Pellets, Extruded soya, Crumble and Finished
mash.

---

## 0. Source documents

This repository was built from three Bounty Farm documents — the master build prompt,
`BFF-DIG-PRD-001` (the PRD) and `BFF-DIG-CN-001` (the Concept Note) — and from the
workbook `BFF-FRM-06.18 Sample Test Log (DRAFT)`.

**None of them is tracked here.** They are Bounty Farm's own papers and were the input
to this work, not its output, so a public repository should not republish them. Where
the documents below cite them by name, treat it as a citation to the controlled
document, not a path you can open in this checkout. `docs/workbook-verification.md`
records what was verified against the workbook, and
`docs/traceability-matrix.md` maps every requirement to the code and tests that
implement it.

## 1. Honest status

Everything in this section is the output of a command run in this working copy on
**2026-10-24**. Nothing here is a projection.

### IMPLEMENTED and TESTED

| Area | Evidence |
| --- | --- |
| Form schema registry, all 7 tabs, 98 columns | `tests/registry.test.ts` — 77 tests |
| Google Sheets row mapping, formula-injection and zero-vs-blank rules | `tests/sheetMapping.test.ts` — 76 tests |
| Role, status, delegation and segregation-of-duties authority | `tests/authority.test.ts` — 66 tests |
| Specification matching and assessment (incl. Not Assessable) | `tests/assessment.test.ts` — 56 tests |
| Generated per-stage validation schema | `tests/zodSchema.test.ts` — 57 tests |
| Sheets sync: headers, fencing, backoff, dead letter, unknown outcomes | `tests/sheetSync.test.ts` — 46 tests |
| Idempotency registry and canonical payload hashing | `tests/idempotency.test.ts` — 37 tests |
| `America/Guyana` time and local daily ID sequence | `tests/time.test.ts` — 20 tests |
| Sample ID format, parsing and counter key | `tests/sampleId.test.ts` — 26 tests |
| Dashboard/report metric derivation and missing-data honesty | `tests/reportMetrics.test.ts` — 27 tests |
| The generated seven-stage form, rendered | `tests/stageForm.test.tsx` — 14 tests |

### IMPLEMENTED, NOT COVERED BY AN AUTOMATED TEST

The code exists, typechecks and builds. No test asserts its behaviour, so this README
does not call it tested.

- All 14 page components (`src/pages/`), including the Specifications, Reports and Admin
  screens. Only `StageForm` has a rendering test.
- All 8 Edge Function entrypoints as HTTP handlers. Their **pure logic modules**
  (`_shared/projection.ts`, `lease.ts`, `backoff.ts`, `idempotency.ts`, `canonical.ts`,
  `reconcile.ts`, `headerCheck.ts`) are covered through `sheetSync` and `idempotency`;
  the request/response wiring is not.
- Every SQL migration, RLS policy and database trigger. There is no database
  integration test in this repository — `npx vitest run` never opens a connection.
- The seed files. They were verified against a local PostgreSQL 17 instance during
  development, but that verification is not a repeatable check in this repo.

### BLOCKED BY EXTERNAL SETUP

| Blocker | Effect |
| --- | --- |
| No Supabase project | Nothing beyond the sign-in screen can be exercised. `src/lib/env.ts` fails closed with a readable configuration screen. |
| No Google OAuth client / Supabase Google provider | No user can sign in. |
| No `SHEETS_SPREADSHEET_ID`, no service-account key | The sync worker refuses to start, by design. No Sheets behaviour has ever run against a real workbook. |
| **Workbook ownership (B-07)** | The verified workbook is a *draft* owned by a personal Gmail account. It must **never** be the write target. A Bounty-Farm-owned native Sheet has to be created first. |
| **0 of 34 workbook limits are approved** | Every numeric measurement assesses as *Not assessable*. This is correct behaviour (FR-009, R-01), not a defect — but it means no conformity decision can be made in production yet. |
| Docker unavailable here | `supabase start` / `supabase db reset` were never run in this working copy. |

### NOT IMPLEMENTED

- **Nothing has been executed against a real database.** This is now the largest gap,
  and it is an environment limitation rather than missing code: Docker is unavailable
  here, so `supabase db reset` has never been run. Every claim about the SQL in this
  repository — that the migrations apply in order, that the RLS policies behave as
  written, that the RPCs return what their callers expect — is verified by **reading and
  by static contract checks only**. Two migration-aborting defects were found that way
  and fixed (a foreign key inserted before its referent in `0002`, and a function
  redefined with a widened return type in `0015`); a third of the same class would also
  only be found by reading. Running `supabase db reset` is the first thing to do in an
  environment that has Docker, and it is a precondition for trusting any of the above.
- **No end-to-end run has happened.** No sample has been registered, no row has reached
  a Google Sheet, and no RLS policy has denied a real request. The e2e suite covers the
  unauthenticated gate and the Pages routing path; everything past sign-in needs a live
  project (see `e2e/README.md`, which states exactly which specs are real, mocked and
  skipped).
- Results entry is reached from the sample detail screen; `StageFormPage` mounts the
  generated form at `phase="registration"` only.

### RESOLVED since this section was first written

These were listed as NOT IMPLEMENTED and have since landed. Recorded rather than
deleted, because the matrix and this list are read by people deciding what to trust.

- **The `rpc_*` database contract.** All **38** functions the Edge Functions call are
  now defined across migrations `0012`–`0015`, with per-signature
  `revoke ... from public` and a pinned `search_path` on every `SECURITY DEFINER`
  function. Enforced from now on by `tests/rpcContract.test.ts`, which compares both
  sides of `_shared/rpc.ts` as text and fails on a missing function, a disagreeing
  parameter **name** (PostgREST passes named arguments, so a rename is an identical
  symptom to the function being absent), a redefinition without a preceding `drop`, or
  an orphan function nothing calls.
- **A reconciliation-report table.** `public.sheet_reconciliation_reports` added in
  `0010`, alongside `public.sheet_workbook_state`.
- **Five frontend endpoints that did not exist.** All five now exist as function
  directories: `sample-action`, `specification-action`, `admin-action`, `sync-action`
  and `schema-verify`.
- **The CI blind spot.** `supabase/functions/**` was read by no gate at all, which is
  how a `ReferenceError` on a committed success path passed lint, typecheck, the unit
  suite, the build and the bundle scan. `ci.yml` now runs `deno check` and `deno lint`
  over every module (currently 46, enumerated by `find` rather than hardcoded, and
  failing closed if that set is ever empty), and `deploy-pages.yml` gates on it.
- **Audit-write failures were unobservable.** A failed audit write is still caught, so
  a denial cannot become a 500, but it now writes the whole original event to
  `public.audit_event_dead_letters`, is counted by `rpc_health_snapshot`, is replayable
  through `rpc_retry_audit_dead_letters`, and is surfaced to a human by the
  audit-trail-gap banner on the Administration → sync screen.
- Results entry is reached from the sample detail screen; `StageFormPage` mounts the
  generated form at `phase="registration"` only.
- No `[functions.*]` block in `supabase/config.toml`, so `health` and
  `sheets-sync-worker` sit behind the gateway's default `verify_jwt`.
- No cron schedule for the sync worker or the reconciler.
- FR-021 offline queue — explicitly out of scope for the MVP.

### The exact command results

```
$ npx vitest run
Test Files  11 passed (11)
     Tests  502 passed (502)
exit 0

$ npx tsc -b --noEmit
(no output)
exit 0
```

`tsc` reporting zero is the one result that needs its instrument checked, so it was
validated both ways: planting `export const __control: number = 'must fail';` in `src/`
produced `error TS2322` and exit 2; removing it returned the tree to exit 0 and no
output. The clean result is genuine.

```
$ npm run build
✓ 1797 modules transformed
dist/index.html                  1.01 kB │ gzip:   0.58 kB
dist/assets/index-*.css         31.50 kB │ gzip:   6.14 kB
dist/assets/browser-*.js         0.62 kB │ gzip:   0.42 kB
dist/assets/env-*.js            61.11 kB │ gzip:  14.88 kB
dist/assets/index-*.js         146.54 kB │ gzip:  47.54 kB
dist/assets/App-*.js           486.96 kB │ gzip: 135.14 kB
exit 0
```

```
$ npm run lint
✖ 6 problems (2 errors, 4 warnings)
exit 1          ← FAILS. CI runs this FIRST, so CI is currently red.
```

Both errors are in deliberate, correct code and neither is a defect:

| Location | Rule | What the code is doing |
| --- | --- | --- |
| `src/components/records/sampleCsv.ts:211` | `no-irregular-whitespace` | Emits a UTF-8 byte-order mark so `µm` and `°C` survive being opened in Excel. |
| `src/forms/sheetMapping.ts:116` | `no-control-regex` | `[\s\u0000-\u001f]` strips control characters before the spreadsheet-formula check. |

Each needs a narrow `eslint-disable-next-line` with a reason, or a rule configuration.
`src/forms/sheetMapping.ts` and `eslint.config.js` are both in the frozen shared
contract, so this fix needs a deliberate decision. Until it is made, **no deployment can
succeed**, because `deploy-pages.yml` gates on `ci.yml`. See `docs/open-decisions.md`
D-14.

```
$ npm run verify:bundle
Credential findings: 0
  PASS  javascript-present
  PASS  supabase-url-shape
  FAIL  anon-key-shape
exit 1
```

Two separate things are true here:

1. The `anon-key-shape` failure is **environmental and correct**. This working copy has
   no `.env`, so `VITE_SUPABASE_ANON_KEY` was unset at build time and the scanner
   rightly refuses to call a zero-finding scan a pass. CI supplies a placeholder.
2. `supabase-url-shape` **passed spuriously**. No project URL is baked into this build.
   What the control matched is the example URL inside a validation message in
   `src/lib/env.ts` (`'… for example https://abc.supabase.co'`). A control that searches
   for a value's *shape* is satisfied by that shape appearing in the value's own
   documentation. Recorded as D-15.

```
$ npm run test:e2e
Running 54 tests using 4 workers
54 failed   —  every one at browserType.launch, before any assertion ran
exit 1
```

**No Playwright assertion has ever been evaluated in this working copy.** The cause is a
local toolchain mismatch, not the application: `@playwright/test` is pinned at `1.49.1`,
which wants `chromium_headless_shell-1148`, and the installed browser build is `-1248`.
Fix with `npx playwright install chromium` (this downloads a browser; it was deliberately
not done here). What the run *does* establish is the suite's real shape: **18 test
declarations × 3 Chromium projects = 54 runs**, matching `e2e/README.md`.

It also confirms a defect that `e2e/README.md` documents: the three
`authenticated-integration.spec.ts` tests were **collected, not skipped at the describe
level**, even with a placeholder project URL. `HAS_PROJECT` tests
`VITE_SUPABASE_URL.includes('.supabase.')`, and `https://exampleref.supabase.co` contains
`.supabase.` — verified directly, not inferred. A guard keyed on an explicit
`E2E_REAL_BACKEND=1` opt-in would not have this hole. See D-16.

---

## 2. Commands

Node 22 is what CI uses. Dependencies are installed with `npm ci`.

| Purpose | Command |
| --- | --- |
| Install | `npm ci` |
| Dev server | `npm run dev` (http://localhost:5173) |
| Lint | `npm run lint` |
| Typecheck | `npm run typecheck` |
| Unit / contract / authority tests | `npm test` |
| Tests, watching | `npm run test:watch` |
| Coverage | `npm run test:coverage` |
| End-to-end | `npm run test:e2e` |
| Production build | `npm run build` |
| Preview the production build | `npm run preview` |
| Scan the built bundle for credentials | `npm run verify:bundle` |
| Validate that scanner | `node scripts/check-bundle-secrets.mjs --self-test` |

Database and functions (Supabase CLI, Docker required):

| Purpose | Command |
| --- | --- |
| Start the local stack | `npm run db:start` |
| Apply migrations + seed, from scratch | `npm run db:reset` |
| Diff local schema against migrations | `npm run db:diff` |
| Regenerate typed schema | `npm run db:types` |
| Serve functions locally | `npm run fn:serve` |
| Deploy all functions | `npm run fn:deploy` |
| Deploy one function | `supabase functions deploy <name>` |
| Push migrations to a linked project | `supabase db push` |
| Set an Edge Function secret | `supabase secrets set KEY=value` |

Run the gate the pipeline runs, in the pipeline's order, before claiming anything is
ready:

```bash
npm run lint && npm run typecheck && npm test && npm run build \
  && node scripts/check-bundle-secrets.mjs --self-test && npm run verify:bundle
```

Per-file invocations of the same tools are **not** this gate. `eslint <my files>` and
`eslint .` are different commands with different verdicts.

### Migrations

`supabase/migrations/0001_identity.sql` … `0008_assessment_engine.sql` run in filename
order. `supabase/config.toml` then applies two seeds:

```
seed/0001_controlled_vocabulary.sql           materials, sampling points, mill screens
seed/0002_specification_reference_import.sql  34 workbook limit entries, ALL reference_only
```

Two further files are applied **by hand** and are deliberately not in `sql_paths`:

```
seed/bootstrap_first_administrator.sql   arms the first-admin grant; refuses without
                                         -v / SET app.bootstrap_admin_email
seed/test_fixtures.sql                   TEST ONLY. Refuses unless
                                         app.allow_test_fixtures = 'yes'. Creates the
                                         approved 84–86 °C rule UAT-06 needs.
```

> **`npm run db:reset` currently fails.** `0002_samples.sql` inserts
> `sample_prefixes` rows whose `sampling_point` values `'AM'` and `'BC'` carry a foreign
> key to `public.sampling_points`, and nothing inserts into `sampling_points` before
> that point — the rows live in `seed/0001`, and seeds run *after* migrations. Proven by
> applying the set to an empty PostgreSQL 17 database:
> `ERROR: insert or update on table "sample_prefixes" violates foreign key constraint
> "sample_prefixes_sampling_point_fkey"`. One-line fix in `0002_samples.sql`, immediately
> before the `sample_prefixes` insert:
> `insert into public.sampling_points (code, label, sort_order) values ('AM','AM after mill',10),('BC','BC before conditioning',20);`
> See `docs/open-decisions.md` D-12.

---

## 3. Environment variables

**Exactly four** variables reach the browser, and all four are public by design.
`src/lib/env.ts` enforces that as an allowlist, so adding a fifth is a visible change.

| Variable | Public? | Purpose |
| --- | --- | --- |
| `VITE_SUPABASE_URL` | **Public by design** | The project endpoint. |
| `VITE_SUPABASE_ANON_KEY` | **Public by design** | The publishable key. It carries **no authority of its own**; all authority comes from RLS evaluated against the signed-in user's JWT. |
| `VITE_APP_VERSION` | Public | Shown in the footer and recorded on audit events, so a quality record traces to the deployment that produced it. |
| `VITE_BASE_PATH` | Public | Diagnostics only. Routing uses Vite's compiled `import.meta.env.BASE_URL`, so the two cannot disagree at runtime. |

GitHub Pages is a public static host. **Every `VITE_*` value is inlined into JavaScript
that anyone can read, signed in or not.** The login screen does not change that.

### Server secrets — never `VITE_*`, never in `src/`

Set with `supabase secrets set`:

| Secret | Notes |
| --- | --- |
| `SHEETS_SPREADSHEET_ID` | **No default, anywhere.** If unset the worker refuses to run and names the missing key. The verified 2026-10-24 *draft* workbook id must never be written into code, seeds, tests, `.env.example` or a fallback. |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Least-privilege service account. |
| `SYNC_SCHEDULER_SECRET` | Compared in constant time; unavailable when unset. |
| `SUPABASE_SERVICE_ROLE_KEY` | Injected into the function runtime by Supabase. Never in a browser bundle. |

`npm run verify:bundle` fails the build if any of these reach `dist/`.

### Running against a local Supabase

```bash
npm run db:start                                  # needs Docker
supabase status                                   # copy the API URL and anon key
cp .env.example .env                              # then paste both in
psql "$(supabase status -o env | grep DB_URL | cut -d= -f2-)" \
  -v ON_ERROR_STOP=1 \
  -c "set app.bootstrap_admin_email = 'you@example.com'" \
  -f supabase/seed/bootstrap_first_administrator.sql
npm run fn:serve                                  # functions, JWT verification off
npm run dev
```

Add `http://localhost:5173/` to the Supabase Auth redirect allowlist, or Google sign-in
will bounce. Full walkthrough: `docs/setup.md`.

---

## 4. Deploying to GitHub Pages

`.github/workflows/deploy-pages.yml` runs on a push to `main` (and on manual dispatch),
and gates on `ci.yml` through `workflow_call` rather than a copy of its steps.

1. **Settings → Pages → Source: GitHub Actions.**
2. **Settings → Secrets and variables → Actions → Variables**, add:
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY` (a repository *variable* is correct — it is publishable; a
     secret also works)
   The build fails with a named error if either is missing, and prints only lengths,
   never values.
3. **Supabase → Authentication → URL Configuration**: add
   `https://<owner>.github.io/<repo>/` as the Site URL and to the redirect allowlist,
   with the trailing slash. Add `http://localhost:5173/` too.
4. Push to `main`.

The workflow derives Vite's `base` from `actions/configure-pages` and falls back to the
repository name, so renaming or forking the repository does not silently break asset
paths. The app uses **HashRouter** because Pages cannot serve an OAuth callback from a
subpath any other way — all in-app routes are `#/...`.

The artifact is scanned for credentials **twice**: once in CI's placeholder build and
again against the exact directory that is uploaded, because what a site ships is a
property of the artifact that shipped.

### Rollback

| Situation | Action |
| --- | --- |
| Bad frontend deploy | **Settings → Pages → deployment history → re-deploy** a known-good deployment. Or `git revert` the commit and push: the workflow redeploys from `main`. A revert is preferable — it leaves the audit trail intact. |
| Bad Edge Function | `supabase functions deploy <name>` from the previous commit. Functions have no version history of their own, so the git commit *is* the version. |
| Bad migration | Forward-only. Write a new numbered migration that reverses the change. **Never edit an applied migration**; quality records depend on the schema history being replayable. Specification versions and audit events are immutable by trigger and cannot be deleted. |
| Sheets written wrongly | Do **not** hand-edit the Sheet. Run `reconcile-sheets` with `dryRun: true`, read the findings, then repair through the worker. See `docs/recovery-runbook.md`. |
| Data loss | `docs/recovery-runbook.md` — restore into a **test** project first, never over production. |

Because deployment gates on `ci.yml` and `npm run lint` currently exits 1, **a
deployment attempted today would fail at the first step.** Fix the two lint errors first.

---

## 5. Ten rules this codebase will not break

1. The spreadsheet id is an Edge Function secret with **no default**.
2. No service-role key, PEM, service-account JSON, OAuth client secret or refresh token
   anywhere the browser can reach.
3. Authorization is server-side. Hiding a UI control is not a control.
4. A new Google sign-in is `pending` and sees **no data** until approved.
5. An Administrator has **no quality authority**. A Quality Officer can *raise* a hold
   but not *clear* one. `disposition.override_release` is granted to no role — delegation
   only.
6. Only two honest sync states: *"Recorded securely, Google Sheets sync pending"* and
   *"Confirmed in Google Sheets"*. Never "Saved to Google Sheets" for unsynced data.
7. No invented numeric acceptance limit in code, seed, UI or test, outside the
   clearly-marked test-only fixture.
8. Zero is a measured value; blank means not measured. An empty numeric input is
   `undefined`, never `0`.
9. UTC instants stored; plant-local display via `America/Guyana`. The sample-ID sequence
   key is the plant-**local** collection date.
10. No TODOs, no placeholder components, no fake handlers, no silently-swallowed errors.

---

## 6. Documentation

| File | Contents |
| --- | --- |
| `docs/architecture.md` | Layers, the registration → outbox → confirmed-row data flow, the trust boundary, leasing and idempotency, and capture state vs assessment vs disposition. |
| `docs/setup.md` | The eight numbered external-setup checklists, with exact screens and values. |
| `docs/mapping.md` | The full A-to-last-column table for all seven tabs, generated from `src/forms/registry.ts`. |
| `docs/admin-guide.md` | User approval, roles, delegations, sync health, schema verification, specification approval, audit query. |
| `docs/uat-plan.md` | All 15 PRD UAT scenarios as runnable steps, with what each one really needs. |
| `docs/recovery-runbook.md` | Backup, restore into a test project, reconciliation, dead letters, schema drift, and what a Google write timeout means. |
| `docs/implementation-plan.md` | Every FR / NFR / UAT mapped to code and tests, plus open assumptions. |
| `docs/traceability-matrix.md` | FR-001–021, NFR-001–009, UAT-01–15 against conservative status. **Read this before believing any status claim.** |
| `docs/open-decisions.md` | Every decision a process owner still owes, with what it blocks and the current safe default. |
| `docs/workbook-verification.md` | The evidence record from reading the live workbook on 2026-10-24. Do not edit. |
| `e2e/README.md` | What the Playwright suite proves, and the three honesty tiers it does not. |
