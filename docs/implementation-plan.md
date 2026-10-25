# Implementation plan

Master Prompt §11 step 1 asks for a plan "mapping every PRD FR/UAT to planned code and
tests, and logging open assumptions".

**This plan is written after the build, not before it**, because the build happened across
several interrupted runs. It therefore reports what was actually done and what remains,
rather than what was intended. Where it says "planned", nothing exists yet.

- The requirement-by-requirement mapping with conservative status:
  **`docs/traceability-matrix.md`** — read that for status, this for sequence and
  reasoning.
- The decisions somebody still owes: **`docs/open-decisions.md`**.
- The verified command results: **`README.md` §1**.

---

## 1. Phase status against PRD §14

| Phase | Scope | Status |
| --- | --- | --- |
| **P0** Preconditions / blocker | approved workbook identity, seven columns signed off, login model proven, interim hold/review policy, test ownership, specification governance | **NOT COMPLETE.** Columns verified (98 headers, zero divergence). Workbook identity **blocked** — D-07. Login model unproven. Hold policy, test ownership and specification governance all open — D-02, D-03. **No go-live before P0 is complete.** |
| **P1** Foundation | auth, roles, seven dashboard buttons, fixed form schemas, schema verifier, draft and register, central ids, Sheets adapter, save-confirmation | **Code complete; cannot run.** The `rpc_*` layer is missing — D-13. |
| **P2** Quality workflow | progressive testing, limit approval and versioning, assessment, holds, dispositions, auditable corrections, search and detail | **Code complete; cannot run.** Same cause, plus two one-line defects — D-11. |
| **P3** Operational readiness | dashboard counts, label print/copy, backup/restore, monitoring, accessibility, UAT, training, SOP, administration manual | **Partly.** Counts, labels, reports, admin screens and this documentation exist. Monitoring, scheduling, UAT execution, training, SOP and the administration manual do not — D-18. |
| **P4** Enhancements | supplier trends, frequency reminders, control charts, device integration, offline capture | **Not started.** Correctly: FR-020 reminders need approved frequencies (D-04) and FR-021 is out of MVP scope. |

---

## 2. What was built, in the order it was built

### Phase A — the shared contract

Built and frozen first, because everything else derives from it. This is the reason the
parallel completion runs could proceed without colliding on meaning.

| Module | Role | Tests |
| --- | --- | --- |
| `src/forms/types.ts` | `Stage`, `FieldDef`, `StageSchema`, `Section`, `Requiredness` | — |
| `src/forms/registry.ts` | **The single source of truth.** 7 stages, 98 columns, tab names, column letters, verified row-4 headers, types, units, requiredness, applicability, parameter keys, adverse values, hard bounds, typo guards, frequencies | `tests/registry.test.ts` — **77** |
| `src/forms/sheetMapping.ts` | `toSheetRow`, `expectedHeaders`, `diffHeaders`, A1 range construction, `looksLikeFormula`, `escapeForCsvExport`, `SHEETS_VALUE_INPUT_OPTION = 'RAW'` | `tests/sheetMapping.test.ts` — **76** |
| `src/lib/time.ts` | `America/Guyana`; plant-local day bounds; the ID date component; display labelling | `tests/time.test.ts` — **20** |
| `src/lib/sampleId.ts` | format, parse, validate, counter key | `tests/sampleId.test.ts` — **26** |
| `src/lib/roles.ts` | roles, statuses, permissions, `can`, `permissionsFor`, `checkSeparationOfDuties`, `DELEGATION_ONLY_PERMISSIONS` | `tests/authority.test.ts` — **66** |
| `src/lib/assessment.ts` | `assess`, `holdTriggers`, `isUnitConfirmed`, `describeBounds` | `tests/assessment.test.ts` — **56** |
| `src/lib/workflow.ts` | capture states, dispositions, `checkTransition`, `evaluateRelease`, `checkDisposition`, `readyForReview` | `tests/authority.test.ts` |

**Why this order.** PRD NFR-006 forbids magic column offsets. Making one registry the
origin of the validation schema, the Sheets row, the form renderer, the server validator
and the specification linkage means a column cannot be right in one place and wrong in
another. The 77 + 76 tests on those two modules are the highest-value tests in the
project, because a defect there is a mis-filed quality record and nothing downstream
notices.

### Phase B — generated derivations

| Module | Derived from | Tests |
| --- | --- | --- |
| `src/forms/zodSchema.ts` | the registry, per stage **and per phase** | `tests/zodSchema.test.ts` — **57** |
| `src/forms/defaults.ts` | the registry — seeds only collection date and time, **never a result** | — |
| `src/lib/reportMetrics.ts` | stored facts; every metric declares its own construction | `tests/reportMetrics.test.ts` — **27** |

The validation schema is rebuilt per submission from the values being validated, so
conditional applicability resolves against what the operator actually chose rather than
against a snapshot.

### Phase C — the database

`0001` identity · `0002` samples · `0003` specifications · `0004` quality decisions ·
`0005` system config · `0006` audit and idempotency · `0007` sheet sync · `0008`
assessment engine.

RLS on every table. `specification_versions` and `audit_events` immutable by trigger.
`role_permissions` seeded in `0001` and mechanically diffed against `BASE_PERMISSIONS` —
42 rows each, identical. `disposition.override_release` cannot be granted to a role, by a
CHECK against `delegation_only_permissions()`.

**Not done: the `rpc_*` layer.** D-13. This is the gap that makes P1 and P2 unrunnable.

### Phase D — Edge Functions

`register-sample` · `review-sample` · `update-results` · `set-disposition` ·
`approve-specification` · `sheets-sync-worker` · `reconcile-sheets` · `health`

Shared: `authorize` (JWT identity, audited denials) · `mutation` (idempotency, canonical
hashing, the transaction wrapper) · `idempotency` · `canonical` · `hash` · `sha256` ·
`projection` · `outbox` · `lease` · `backoff` · `reconcile` · `headerCheck` · `quota` ·
`syncWorker` · `syncStatus` · `validation` · `errors` · `fakeSheets` ·
`adapters/{googleAuth,googleSheets,store,env,http}`.

Covered by `tests/sheetSync.test.ts` (**46**) and `tests/idempotency.test.ts` (**37**) —
which test the **pure modules**, against an in-memory Sheets fake. The HTTP wiring is
untested, and `eslint.config.js` ignores `supabase/functions/**` while
`tsconfig.app.json` does not include it, so **neither project gate sees this code at
all**.

### Phase E — frontend

`src/components/ui/**` primitives · `layout/**` shell, navigation, `RequirePermission` ·
`form/**` the one registry-driven `StageForm` used by all seven stages · `records/**`
tables, filters, dialogs, timelines, panels · `hooks/**` TanStack Query · `pages/**`
fourteen screens.

`tests/stageForm.test.tsx` (**14**) is the only rendering test. It asserts that every
applicable field of all seven stages renders exactly once, cross-checked against an
independently computed `98 − 7 system − 1 non-applicable = 90`; the AM/BC clearing
behaviour; the accessible error summary holding focus on its own heading; units in labels
with a non-zero checked count so the sweep cannot pass vacuously; and the
unconfirmed-unit warning with its `aria-describedby` resolving to real text.

**Thirteen of the fourteen pages have no test of any kind.**

### Phase F — seeds

`0001_controlled_vocabulary.sql` — materials, sampling points, mill screens, taken
verbatim from the registry's option lists. `suppliers` and `feed_types` ship **empty**, by
decision.

`0002_specification_reference_import.sql` — 28 specification parents carrying 34
versions, **all `reference_only`, all with NULL `proposed_by` and `approved_by`**. 28
rather than 34 because six parameters are stated per material or per sampling point, and
that distinction belongs in the version's applicability filters. Unit strings verbatim,
including the literal `'to confirm'` and NULL where the cell is empty. Bounds recorded on
**only the six entries that carry them** — elsewhere both bounds are NULL, **never 0**.
Nine entries flagged `is_machine_setting` (D-09).

`bootstrap_first_administrator.sql` — hand-applied; refuses without an explicit session
setting, on a malformed address, if an administrator already exists, or if a grant is
already pending.

`test_fixtures.sql` — **test only**; refuses unless `app.allow_test_fixtures = 'yes'`.
Holds the approved 84–86 °C rule UAT-06 needs, with no `workbook_entry_no` so it stays
distinguishable from an import.

**Every seed ends with a gate that reads the catalogue back** rather than trusting that
its statements had an effect — because `on conflict do nothing` succeeds when it inserts
nothing. In `0002` the "34 reference_only" assertion deliberately precedes the "0
approved" assertion: a zero means either the right state or that the question reached no
rows, so counting 34 first proves the instrument discriminates and makes the following
zero evidence rather than silence.

### Phase G — CI, deployment, documentation

`ci.yml` — lint, typecheck, Playwright-spec typecheck, unit tests, build, scanner
self-test, bundle scan, then Playwright on the derived Pages base path.
`deploy-pages.yml` — gates on `ci.yml` via `workflow_call` rather than a copy of its
steps, deploys only from the default branch, and scans the exact uploaded artefact.
`scripts/check-bundle-secrets.mjs` — with its own self-test, because a checker cannot see
what it gates.

**CI is currently red at its first step** — D-14.

---

## 3. What remains, in dependency order

Nothing below is a guess about effort; each is a named, located piece of work.

| # | Work | Why first | Decision |
| --- | --- | --- | --- |
| 1 | Two lint disables with stated reasons | **CI is red; nothing can deploy.** Two lines. | D-14 |
| 2 | One `insert into sampling_points` in `0002` | **`db:reset` fails; no seed ever runs.** One line. | D-12 |
| 3 | Add `asOutboxState` to the `update-results` import block | A `ReferenceError` on the success path. One line. | D-11 |
| 4 | Reconcile `WORKBOOK_KEY` with the seeded lease row | The worker addresses a non-existent row. One token. | D-11 |
| 5 | **Write the `rpc_*` migration(s)** | **Every write path depends on it.** The largest remaining piece by far. Must satisfy the argument lists `reconcile-sheets` documents, and needs a reconciliation-report table. | D-13 |
| 6 | Decide and fix the five missing frontend endpoints | Review, specification, admin and sync-retry mutations 404. Router functions, or repoint the hook. | D-13 |
| 7 | `[functions.*]` blocks for `health` and `sheets-sync-worker` | Their internal authorisation is unreachable behind default `verify_jwt`. | D-18 |
| 8 | Schedule the worker and the reconciler; wire dead-letter notification | Without it, every sample stays "sync pending" forever. | D-18 |
| 9 | Fix the `checkDisposition` `'undetermined'` fall-through in `workflow.ts` | A latent authority bypass that any new caller inherits. | D-10 |
| 10 | Bind the bundle scanner's URL control to an injected value | A control that can be satisfied by documentation is not a control. | D-15 |
| 11 | Write `0013_security_posture.sql` — the privilege read-back | The control `0001` names as its evidence does not exist. | D-17 |
| 12 | Re-key the e2e guard on `E2E_REAL_BACKEND=1` | A guard satisfied by the placeholder it excludes. | D-16 |
| 13 | **A database integration test suite** | No RLS policy, trigger or RPC is exercised by anything. The biggest coverage gap after UAT-03. | — |
| 14 | **A concurrency test: ≥20 simultaneous registrations** | UAT-03. The largest single untested requirement. | — |
| 15 | Fix the local Playwright browser mismatch and run the suite | 54 runs exist; **no assertion has ever been evaluated.** | — |
| 16 | Create the Bounty-Farm-owned native workbook; retire the draft | **Cutover blocker.** | D-07 |
| 17 | Approve one specification rule — **a product test, not a setting** | Turns the whole assessment path from untested into demonstrated. See D-09 before choosing. | D-02, D-09 |
| 18 | Restore test into the test project, documented | FR-016 asks for a documented restore test. UAT-15. | D-08 |
| 19 | Tests for the fourteen pages | Thirteen have none. | — |
| 20 | Performance measurement against NFR-003 | Nothing measures load or save latency. | — |
| 21 | SOP, administration manual, operator training | PRD §17 definition of done. | — |

---

## 4. Open assumptions

These are assumptions the code **already relies on**. Each is stated so it can be
contradicted cheaply, rather than discovered expensively. None is a decision from
`docs/open-decisions.md`; those are tracked there.

### About the workbook

1. **The 98 row-4 headers verified on 2026-10-24 are the headers the production workbook
   will have.** If the new Bounty-Farm-owned Sheet differs by a single character, every
   write blocks on schema drift. **Verify before cutover** (`docs/setup.md` §8.1), do not
   assume the copy was faithful.
2. **Row 3 stays a merged band row and rows 1–4 stay protected.** The writer addresses
   row 5 and below and verifies row 4. A column inserted by a person changes what every
   subsequent column means.
3. **Tab names stay byte-identical**, including the leading digit and space —
   `'1 Raw materials'`. Tab names are the API addressing key. A rename is a drift event.
4. **The `Limits` tab is never read to decide conformity.** It was imported once as
   `reference_only`. Editing a number there changes nothing in the application, which is
   FR-014's acceptance criterion — and which also means **nobody should expect editing it
   to have an effect**.

### About the plant

5. **Plant-local time is `America/Guyana` with no daylight saving.** Guyana does not
   observe DST. If that changed, the ID sequence key and every dashboard day boundary would
   shift.
6. **A sample is collected at a single instant** recorded as a plant-local date and time,
   and the server transaction time is stored **separately** (NFR-008). A sample collected
   late and entered the next morning keeps its collection date.
7. **An operator has a working network connection at the moment of registration.** There
   is no offline queue (FR-021) and no promise of one. D-22.
8. **One person is responsible for one sample's registration.** `sampled_by` is free
   text, not an account reference, because the person who sampled is not necessarily the
   person signed in — a distinction worth preserving rather than resolving.

### About authority

9. **The `role_permissions` table and `src/lib/roles.ts` stay in agreement.** They were
   diffed mechanically — 42 rows each, identical — but **nothing enforces it
   continuously.** A drift means the UI offers what the server refuses, or hides what it
   would allow. A test comparing the two against a live database would close this.
10. **Google is the sole identity provider.** Email sign-up is disabled. If a staff member
    has no Google account, they cannot use the system at all. D-01.
11. **An approval decision is a person's decision.** Nothing auto-approves an account, a
    specification or a release, anywhere, under any configuration.

### About Google Sheets

12. **One service account, Editor on one spreadsheet, is enough and is the minimum.**
    Sheets has no narrower write role.
13. **The Sheets API's own ordering is not relied upon.** The worker locates a row by
    sample id and relocates after a re-sort, so a human sorting the sheet is survivable.
14. **Trailing blanks dropped by the API are agreement, not drift.** The API omits trailing
    empty cells; a row of 11 values reported as 9 is the same row. `tests/sheetSync.test.ts`
    asserts this explicitly, because the opposite reading would produce endless false drift.
15. **A timeout is an unknown outcome.** The whole reconcile-before-retry design rests on
    this. If a future change ever treats a timeout as a failure, duplicate rows follow
    immediately.

### About the environment

16. **Everything `VITE_*` is public.** The four-variable allowlist in `src/lib/env.ts`
    exists so that adding a fifth is a visible, reviewable change rather than a quiet one.
17. **GitHub Pages cannot serve an OAuth callback from a subpath**, so `HashRouter` is
    mandatory and every redirect target is the site root.
18. **`SHEETS_SPREADSHEET_ID` being unset is a safe state**, not an error to work around.
    The worker refuses to run. Any future "convenience default" here would be a
    quality-records hazard, not a convenience.

### About the records themselves

19. **Postgres is the authoritative quality record; the Sheet is a projection.** If the
    two disagree, the ledger is right and the Sheet is repaired. Reversing this would make
    a third party's availability a quality-records dependency. D-19.
20. **An audit event is never edited or deleted, by anyone, including an administrator.**
    Enforced by trigger. A correction is a new event carrying before and after.
21. **A specification version is immutable.** A changed limit is a new version, so the
    rule that decided a past assessment remains readable forever (UAT-12).
22. **`not_assessable` is a real, correct, reportable answer** — not a missing value and
    not an error. Today it is the answer for **every** numeric measurement in production
    data. Any future change that treats it as a gap to be filled would reintroduce exactly
    the risk R-01 exists to prevent.

---

## 5. How this plan should be used

1. Work items **1–4** are four lines of code across four files and they unblock
   everything: CI, local setup, the sync worker and results entry. Do them first.
2. Item **5** — the `rpc_*` layer — is the real remaining engineering. Nothing in P1 or
   P2 can be demonstrated until it exists, however complete the surrounding code looks.
3. Items **13–15** are the honest answer to "is it tested?". The 502 passing tests are
   genuinely good coverage **of the pure domain logic**, and they say nothing about the
   database, the HTTP layer or the browser.
4. Items **16–18** need somebody who is not a developer. Start the conversations now;
   they have longer lead times than the code.
5. Before anyone writes "done" against a requirement, read
   `docs/traceability-matrix.md` and check whether a test actually asserts it. Nine of the
   thirty functional and nonfunctional requirements have **no automated test at all**
   (FR-007, FR-012, FR-013, FR-016, FR-018, NFR-003, NFR-005, NFR-007, NFR-009), and three
   acceptance scenarios have none either (UAT-03, UAT-10, UAT-15). Those counts were read
   out of the matrix, not asserted about it.
