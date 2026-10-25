# Requirements traceability matrix

**This document's only value is its accuracy. An optimistic matrix is worse than none.**

> **Revised 2026-10-24, after migrations `0009`–`0015` landed.** Rows that read
> "`rpc_x` does not exist" were written when only `0001`–`0008` were on disk; all 38
> RPCs are now defined and `tests/rpcContract.test.ts` enforces that both sides of
> `_shared/rpc.ts` agree on function names and on parameter **names**.
>
> One caveat applies to every SQL row below and is not repeated in each: **no migration
> has ever been executed.** Docker is unavailable in the build environment, so
> `supabase db reset` has not run. "Implemented" for a database object means the SQL is
> written and statically checked, never that it applied cleanly or behaved as intended.
> Two migration-aborting defects were found by reading and fixed — a foreign key
> inserted before its referent, and a function redefined with a widened return type —
> which is direct evidence that reading catches some of this class and that running it
> would catch more. Treat `supabase db reset` as a precondition for believing any SQL
> row, and the RLS rows especially: a policy is a claim about a denial, and no denial
> here has been observed.

## How to read it, and how it was built

The requirement ids below were **extracted mechanically** from
`BFF_Digital_Sample_Testing_PRD.md`, not typed from memory:

```
FR-001 … FR-021   21 ids   PRD §8
NFR-001 … NFR-009  9 ids   PRD §9
UAT-01 … UAT-15   15 ids   PRD §13
R-01 … R-10       10 ids   PRD §15
                  ──────
                  55 clauses, every one of which has a row below
```

The clause **set** is therefore derived. The clause **coverage** is not: the PRD's
requirements exist only as prose, so the mapping from a clause to the code and tests that
satisfy it is a written judgement and can drift from the code. That is stated here rather
than left implicit, because a written coverage map that calls itself derived is the more
dangerous artefact.

### Status vocabulary — deliberately narrow

| Status | Means |
| --- | --- |
| **Implemented** | The code exists, typechecks and builds. Says nothing about testing. |
| **Partially implemented** | Part of the path exists; a named part does not. |
| **Not implemented** | No code. |
| **Blocked by external setup** | Code exists but cannot run without a cloud resource that does not exist. |

### Tested column — the conservative one

| Value | Means |
| --- | --- |
| **Unit** | An automated test in `tests/` asserts this behaviour and passed on 2026-10-24. |
| **Unit (partial)** | Some of the clause is asserted; a named part is not. |
| **None** | **No automated test asserts this.** The code may still be correct. |
| **e2e NOT RUN** | A Playwright spec exists for it and **has never executed** — the local browser build does not match the pinned Playwright version. |

**If there is no test, this document does not say "Tested".** It never writes "Tested" for
a DB policy, an HTTP handler or a page component, because no test in this repository
opens a database connection, invokes a function over HTTP, or renders any page except
`StageForm`.

Verified command results behind every "Unit" below: `npx vitest run` → **11 files passed,
502 of 502 tests passed, exit 0**. `npx tsc -b --noEmit` → exit 0, validated with a
positive control. `npm run build` → exit 0. `npm run lint` → **exit 1**.
`npm run test:e2e` → **54 collected, 54 failed at browser launch, 0 assertions
evaluated**.

---

## Functional requirements

| ID | Requirement | Status | Tested | Implementing files | Covering tests |
| --- | --- | --- | --- | --- | --- |
| **FR-001** | Authentication; verify identity on the server | Implemented · **Blocked by external setup** (no project, no OAuth client) | Unit (partial) — the authority rules only; no server round trip is exercised | `src/hooks/useSession.ts`, `useProfile.ts`, `src/components/layout/RequirePermission.tsx`, `src/pages/{LoginPage,PendingAccessPage}.tsx`, `supabase/functions/_shared/adapters/{authorize,mutation}.ts`, `supabase/migrations/0001_identity.sql` | `tests/authority.test.ts` — *"FR-001: account status gates everything"* |
| **FR-002** | Role authorization on **every server operation**, not hidden buttons | Implemented | Unit (partial) — the matrix is asserted as a pure function; **no RLS or Edge Function test exists** | `src/lib/roles.ts`, `_shared/adapters/authorize.ts` (`requirePermission`, audited denial), `0001_identity.sql` `role_permissions` | `tests/authority.test.ts` (66) |
| **FR-003** | Dashboard: exactly seven prominent form buttons + secondary actions | Implemented | Unit (order and count only) · **e2e NOT RUN** | `src/pages/DashboardPage.tsx`, `src/forms/registry.ts` `DASHBOARD_ORDER`, `src/components/layout/{SecondaryNav,navItems}.ts` | `tests/registry.test.ts` — *"registry: dashboard"*; `e2e/dashboard.spec.ts` (never executed) |
| **FR-004** | Exact A-to-last-column mapping for each operational tab | **Implemented** | **Unit** — the strongest coverage in the project | `src/forms/registry.ts` (98 columns), `src/forms/sheetMapping.ts`, `docs/mapping.md` | `tests/registry.test.ts` (77) + `tests/sheetMapping.test.ts` (76) — width, column isolation, no cross-tab bleed, zero ≠ blank, precision, coded→label |
| **FR-005** | Save draft without pretending a sample is registered | Implemented, **with a documented deviation** | Unit | `src/hooks/useSampleDraft.ts`, `src/components/form/StageForm.tsx` | `tests/zodSchema.test.ts` — *"a draft may be incomplete (FR-005)"*; `tests/stageForm.test.tsx` draft case |
| | | | | **Deviation:** drafts live in **per-user browser `localStorage`**, not in sheet metadata. `samples` requires a non-null collection instant, local date and local time, and Ground additionally requires a sampling point — exactly what an operator has not decided yet. A server draft would need fabricated values, which is a false quality record. The honest limit (same device, same browser profile) is surfaced as `DRAFT_SCOPE_NOTE` beside the restored-draft banner. "Not counted as collected" is satisfied more strongly than by a row: **there is no row for any count to find.** | |
| **FR-006** | Unique durable sample ids; persist the first data row; idempotent retry | **Implemented** — `rpc_register_sample` defined in `0013_rpc_mutations.sql`; allocation is an atomic upsert-returning. **Never executed against a database** (no Docker here), and **concurrency is unproven** | Unit (partial) — idempotency fully covered; **concurrency NOT covered** | `supabase/functions/register-sample/index.ts`, `_shared/idempotency.ts`, `canonical.ts`, `hash.ts`, `src/hooks/useRegisterSample.ts`, `src/lib/sampleId.ts`, `0002_samples.sql` | `tests/idempotency.test.ts` (37), `tests/sampleId.test.ts` (26) |
| | | | | **Gap:** no test exercises ≥20 simultaneous registrations (UAT-03). The property rests on the schema's per-(prefix, plant-local-date) sequence and is **unverified**. | |
| **FR-007** | Append tests to an existing sample rather than duplicate it | **Partially implemented** | **None** | `supabase/functions/update-results/index.ts`, `src/hooks/useSampleDetail.ts`, `src/pages/SampleDetailPage.tsx` | — |
| | | | | **Two defects.** (1) `update-results/index.ts:120` calls `asOutboxState(...)` without importing it — a `ReferenceError` on the **success** path, so every accepted results update would 500 **after** committing. (2) `StageFormPage` mounts the generated form at `phase="registration"` only; results entry is on the detail screen. `StageForm` already accepts `phase="testing"`. | |
| **FR-008** | Requiredness by stage, types, units, controlled options, safe strings | **Implemented** | **Unit** | `src/forms/zodSchema.ts` (generated from the registry), `src/forms/registry.ts`, `_shared/validation.ts`, `src/components/form/**` | `tests/zodSchema.test.ts` (57) + `tests/stageForm.test.tsx` (14) |
| **FR-009** | Evaluate **only approved** rules applicable to the context | **Implemented** | **Unit** | `src/lib/assessment.ts`, `0008_assessment_engine.sql` (`evaluate_measurement`, `is_unit_confirmed`), `0003_specifications.sql` | `tests/assessment.test.ts` (56) — incl. *"the seeded production ruleset assesses nothing"* |
| **FR-010** | Adverse findings and out-of-range results create a hold | Implemented | Unit (pure functions) — the **database trigger is untested** | `src/lib/assessment.ts` `holdTriggers`, `src/forms/registry.ts` `adverseValue`, `0004_quality_decisions.sql`, `src/components/records/HoldBanner.tsx` | `tests/assessment.test.ts` — *"UAT-08: adverse observations force a hold regardless of numbers"*; `tests/registry.test.ts` quality-critical flags |
| **FR-011** | Authorised review and disposition; no implicit release | **Implemented** — `rpc_set_disposition` defined in `0013_rpc_mutations.sql`. **Never executed against a database** | Unit (partial) | `src/lib/workflow.ts`, `supabase/functions/{set-disposition,review-sample}/index.ts`, `src/components/records/DispositionDialog.tsx`, `src/pages/ReviewsPage.tsx` | `tests/authority.test.ts` — *"disposition authority (FR-011)"*, *"a quality officer can raise but not clear"*, *"override release is delegation-only"* |
| | | | | **Known gap:** `checkDisposition` has **no branch for `'undetermined'`**. `DISPOSITION_PERMISSION` maps it to `null`, the permission check is skipped, no branch matches, and execution reaches `return { allowed: true }`. A caller passing it would move a held sample out of `on_hold` with no authority and no reason. `src/lib/workflow.ts` is frozen; `set-disposition` refuses the value at the boundary and is currently the only caller. **Any future caller inherits the gap.** D-10. | |
| **FR-012** | Search and filter by id, lot, batch, run, material, stage, time, status | Implemented | **None** | `src/pages/SamplesPage.tsx`, `src/hooks/useSamples.ts`, `src/components/records/{SampleFilters,SampleTable,Pagination,LinkedSamples}.tsx` | — |
| **FR-013** | Reasoned revision with before/after trace; no silent overwrite | **Partially implemented** | **None** | `src/hooks/useSampleDetail.ts` (`expectedRevision`), `src/components/form/ReasonDialog.tsx`, `src/components/records/AuditTimeline.tsx`, `0006_audit_and_idempotency.sql` | — |
| **FR-014** | Only delegated quality approval activates a new spec | Implemented | Unit (partial) — segregation and rule-version evidence; **prospective-effect refusal is untested** | `supabase/functions/approve-specification/index.ts`, `src/lib/roles.ts` `checkSeparationOfDuties`, `src/components/records/SpecApprovalForm.tsx`, `src/pages/SpecificationsPage.tsx`, `0003_specifications.sql` (immutable versions) | `tests/authority.test.ts` segregation of duties; `tests/assessment.test.ts` — *"records the deciding rule id and version as evidence"* |
| **FR-015** | Distinguish editing, saving, saved, failed, retry; success only after a verified write | Implemented | Unit (partial) — the sync side; the **UI banner state machine is untested** | `src/components/form/saveState.ts`, `SaveStateBanner.tsx`, `src/components/ui/SyncStatus.tsx`, `_shared/syncStatus.ts` (`syncStatusFor`) | `tests/sheetSync.test.ts` — *"a timeout is an unknown outcome, not a failure"*, read-back verification suite |
| **FR-016** | Event log, scheduled backups, **documented restore test**, reconciliation | **Partially implemented** | **None** | `0006_audit_and_idempotency.sql`, `_shared/adapters/authorize.ts` `recordAudit`, `supabase/functions/reconcile-sheets/index.ts`, `docs/recovery-runbook.md` | — |
| | | | | The event log is implemented. **Scheduled backups and the restore test are procedure only** — nothing automates them, and no restore has been performed. FR-016 asks for a *documented* restore test; that is UAT-15 and it has not run. | |
| **FR-017** | Reports: stage volumes, awaiting results, holds, outside-limit events, trends | Implemented (MVP widgets) | **Unit** | `src/lib/reportMetrics.ts`, `src/pages/ReportsPage.tsx`, `src/components/records/ReportCard.tsx` | `tests/reportMetrics.test.ts` (27) — zero vs absent, plant-local day boundary, adherence withheld, every metric declares how it is built |
| **FR-018** | Print or copy an immutable sample id for bag labels | Implemented | **None** | `src/components/records/LabelDialog.tsx`, `src/components/form/RegistrationConfirmation.tsx`, `src/styles/index.css` `@media print` | — |
| **FR-019** | Role-permitted filtered CSV/PDF export with watermark and source range | **Partially implemented** — **CSV only; no PDF** | Unit (partial) — the escaping; **not the export flow** | `src/components/records/sampleCsv.ts`, `src/forms/sheetMapping.ts` `escapeForCsvExport`, `src/pages/ReportsPage.tsx` (gated on `export.run`) | `tests/sheetMapping.test.ts` — *"spreadsheet formula injection (PRD §6.1, UAT-14)"* |
| **FR-020** | Due/overdue testing based on frequencies **only after approval** | **Implemented as a refusal** — which is what the requirement asks for | **Unit** | `src/forms/registry.ts` `frequencyApproved`, `src/lib/reportMetrics.ts`, `src/pages/ReportsPage.tsx`, `src/components/form/InstructionStrip.tsx` | `tests/registry.test.ts` — *"sampling frequency honesty (FR-020, R-08)"*; `tests/reportMetrics.test.ts` — *"sampling adherence is withheld where the frequency is unapproved"* |
| | | | | No overdue flag and no adherence percentage is produced for **any** stage. Four stages read *Not reported* (no approved target). The three with a stated frequency read *Insufficient data*, because the denominator — loads received, runs made, production runs started — is recorded nowhere in the ledger. The page states both reasons and the difference between them. | |
| **FR-021** | Offline queue | **Not implemented** | — | — | — |
| | | | | Out of scope for the MVP by the PRD's own wording. No offline-save promise is made anywhere in the UI, which is the requirement. | |

---

## Nonfunctional requirements

| ID | Requirement | Status | Tested | Implementing files | Covering tests |
| --- | --- | --- | --- | --- | --- |
| **NFR-001** | 100% of acknowledged saves readable back by UUID; retry creates no duplicate; no write on failed validation; write confirmation plus reconciliation | **Partially implemented** | **Unit** for idempotency and sync; **None** for the reconciliation of request records against operational rows | `_shared/idempotency.ts`, `canonical.ts`, `projection.ts`, `outbox.ts`, `reconcile.ts`, `syncWorker.ts`, `supabase/functions/reconcile-sheets/index.ts` | `tests/idempotency.test.ts` (37) + `tests/sheetSync.test.ts` (46) |
| | | | | The mechanisms are built and unit-tested against an in-memory Sheets fake. The **100% claim is unmeasured** — it needs UAT-15, which has not run. | |
| **NFR-002** | HTTPS-only; server-side identity and authorization; secrets outside client code; minimum Drive access; restricted sharing; protected cells; security logging; access recertification | Implemented **in the parts this repository controls** | Unit (partial) | `src/lib/env.ts` (four-variable allowlist, https refinement), `scripts/check-bundle-secrets.mjs`, `_shared/adapters/{authorize,env}.ts`, `0001_identity.sql` grants/revokes, `.github/workflows/*` | `tests/authority.test.ts`; `node scripts/check-bundle-secrets.mjs --self-test` |
| | | | | Three honest caveats. (1) **No RLS test exists** — every policy is unexercised by automation. (2) `verify:bundle` reports 0 credential findings, but its `supabase-url-shape` **positive control passes spuriously** on an example URL inside a validation message in `src/lib/env.ts`; a control that searches for a value's *shape* is satisfied by that shape appearing in the value's documentation (D-15). (3) Sheet sharing, protected cells and recertification are **procedure**, in `docs/setup.md` and `docs/admin-guide.md`. | |
| **NFR-003** | ≥99.5% availability; p95 form load ≤3 s; p95 save confirmation ≤5 s; clear network failures | **Not implemented** for the measurable part | **None** | `src/components/form/SaveStateBanner.tsx`, `src/lib/queryClient.ts` | — |
| | | | | Network failures are surfaced in plain language. **Nothing measures availability or latency.** The PRD itself says these targets "require load/performance validation before contractual adoption". | |
| **NFR-004** | Mobile-first, large tap targets, labels and inline units, contrast, accessible error text, keyboard navigation, no colour-only signals; WCAG 2.2 AA where feasible | **Partially implemented** | Unit (partial) · **e2e NOT RUN** | `src/styles/index.css` (`:focus-visible` applied via `:where(...)` so no component can forget it, `prefers-reduced-motion`, skip link), `src/components/form/**`, `src/components/ui/statusMaps.ts` (icon + text, never colour alone), `src/components/ui/{AssessmentChip,StatusChip}.tsx` | `tests/stageForm.test.tsx` — accessible error summary holding focus on its own heading, units in labels, `aria-describedby` resolving to real text; `e2e/{dashboard,first-load}.spec.ts` 44 px tap targets and no horizontal scroll at 375/768 px — **never executed** |
| | | | | **No screen reader has been used and no operator has been observed.** NFR-004 asks for observation during the pilot; that is a human activity. | |
| **NFR-005** | Event time, actor, original and new value, reason, disposition, ruleset version; no unlogged destructive change | **Partially implemented** | **None** | `0006_audit_and_idempotency.sql` (immutable `audit_events`), `_shared/adapters/authorize.ts` `recordAudit`, `src/components/records/AuditTimeline.tsx`, `src/pages/AdminPage.tsx` audit tab | — |
| | | | | Every field is modelled and immutability is enforced by trigger. **No automated test asserts that any particular action writes its event**, because that needs a database. | |
| **NFR-006** | Centrally versioned form schema; controlled config; documented deployments; automated tests; rollback; **no magic column offsets** | **Implemented** | **Unit** | `src/forms/registry.ts` as the single source of truth; `zodSchema.ts` and `sheetMapping.ts` generated from it; `src/lib/env.ts` allowlist; `.github/workflows/{ci,deploy-pages}.yml`; `README.md` §4 rollback | `tests/registry.test.ts` (77), `tests/sheetMapping.test.ts` (76), `tests/zodSchema.test.ts` — *"the schema is generated, not hand-written per stage"* |
| | | | | **One live defect against this requirement:** `npm run lint` exits 1 on two errors in deliberate code, and CI runs lint first, so the automated gate this NFR requires **is currently red** and no deployment can succeed. D-14. | |
| **NFR-007** | No 300-row assumption; quotas monitored; quota exhaustion signalled explicitly | Implemented | **None** | `_shared/quota.ts`, `_shared/sheets.ts` (locates a row by identifier, never reads the whole spreadsheet), `src/components/records/Pagination.tsx`, `src/hooks/useSamples.ts` | — |
| | | | | No row ceiling exists anywhere in the app. A quota hint is honoured and the worker backs off — `tests/sheetSync.test.ts` includes *"a quota hint is honoured"*, but there is **no load test** and no benchmark against real plant volume (R-07). | |
| **NFR-008** | Authoritative clock and time zone; collection time and server transaction time stored **separately** | **Implemented** | **Unit** | `src/lib/time.ts` (`PLANT_TIME_ZONE`, `plantDayStart/End`, `idDatePart`), `src/lib/sampleId.ts`, `0002_samples.sql` (separate `collection_instant` and server-side `created_at`) | `tests/time.test.ts` (20) + `tests/sampleId.test.ts` (26) — day bounds, the plant-local ID date component, display labelling |
| **NFR-009** | Collect only necessary user data; define retention, access, disposal and backup locations with the record-control owner | **Partially implemented** | **None** | `0001_identity.sql` (profiles hold the Google email and display name only), `docs/recovery-runbook.md` | — |
| | | | | Data minimisation is implemented: nothing beyond the Google email and display name is stored about a person. **Retention, disposal and backup locations are undefined** and need a Bounty Farm decision — D-08. | |

---

## Acceptance scenarios

Statuses here answer one question: *has this scenario been executed?* For eight of the
fifteen, the underlying rule is asserted by a passing unit test, and that is stated — but
**no scenario below has been run as the PRD describes it.** Full steps:
`docs/uat-plan.md`.

| ID | Scenario | Status | Automated coverage | Needs |
| --- | --- | --- | --- | --- |
| **UAT-01** | Header fidelity — one record per form, exact columns, no collateral edits | **Not run** | `tests/sheetMapping.test.ts` (76) asserts the mapping; **no real sheet has ever been written** | Supabase, TEST workbook |
| **UAT-02** | AM vs BC — hide BC moisture at AM, require it at BC, correct prefix | **Not run end to end**; the rule **passes at unit level today** | `tests/registry.test.ts`, `tests/zodSchema.test.ts`, `tests/stageForm.test.tsx` — incl. clearing a typed BC value on switching to AM and excluding the key from the payload | nothing extra for the unit level |
| **UAT-03** | ≥20 concurrent registrations — unique durable ids, no overwrites, all reconcile | **Not run** | **NONE.** The single largest untested requirement. | Supabase |
| **UAT-04** | Idempotent retry after a network timeout | **Not run end to end**; **passes at unit level today** | `tests/idempotency.test.ts` (37) — every stored state swept from `IDEMPOTENCY_STATES`, take-over at exactly the timeout, clock skew, key-format boundaries, hash agreement with known SHA-256 values | Supabase |
| **UAT-05** | Missing approved limit → Not Assessable, no automatic release | **Not run end to end**; **passes at unit level today** | `tests/assessment.test.ts` — *"the seeded production ruleset assesses nothing"*. Also exercised once through the database's own `evaluate_measurement()` on a local PostgreSQL 17 instance: 83.9 / 84 / 86 / 86.1 all `not_assessable / no_approved_rule` | Supabase |
| **UAT-06** | Approved 84–86 °C boundaries: 84 and 86 Within, 83.9 and 86.1 Outside | **Not run end to end**; **passes at unit level today** | `tests/assessment.test.ts` — *"UAT-06: approved inclusive boundaries"*. Verified once through `evaluate_measurement()` with the fixture applied, `candidate_count = 1` on each | Supabase + **`supabase/seed/test_fixtures.sql`**, applied by hand to a **test** database with `app.allow_test_fixtures = 'yes'` |
| **UAT-07** | Pressure with an unconfirmed unit cannot be assessed as compliant | **Not run end to end**; **passes at unit level today** | `tests/assessment.test.ts` — *"UAT-07: unconfirmed units can never pass"*; `tests/stageForm.test.tsx` asserts the warning and its `aria-describedby`, with the registry premise that this is the only such field asserted rather than assumed | nothing extra for the unit level |
| **UAT-08** | `Mould seen? = Yes` forces a hold even when every number is within limits | **Not run end to end**; **passes at unit level today** | `tests/assessment.test.ts` hold suite; `tests/registry.test.ts` quality-critical flags | Supabase |
| **UAT-09** | Operator and administrator denied a release or an approval; the attempt is recorded | **Not run** for the server half | `tests/authority.test.ts` (66) asserts the matrix as **pure functions**. **Nothing reaches a server.** The audited-denial path is untested. | Supabase + Google OAuth |
| **UAT-10** | Full lifecycle across four roles with linked upstream/downstream history | **Not run** | **NONE** | Supabase + Google OAuth + 4 accounts |
| **UAT-11** | Revision conflict — no silent overwrite, explicit refresh | **Not run** | Partial — `tests/sheetSync.test.ts` *"does not roll a confirmed row back to an older revision"*. The **UI conflict flow is untested.** | Supabase |
| **UAT-12** | Limit versioning — future assessments change, history stays reproducible | **Not run** | Partial — `tests/assessment.test.ts` *"records the deciding rule id and version as evidence"*. Prospective-effect refusal and immutability triggers untested. | Supabase + an approved limit |
| **UAT-13** | Outage — never "Saved" without confirmation; retry without duplication | **Not run end to end**; the sync half **passes at unit level today** | `tests/sheetSync.test.ts` unknown-outcome suite, incl. the one-row property with blind-append switched on | Supabase + TEST workbook |
| **UAT-14** | Injection and invalid inputs blocked | **Not run end to end**; **passes at unit level today** | `tests/zodSchema.test.ts` (formula injection split by field kind, hard bounds, zero vs blank, controlled codes) + `tests/sheetMapping.test.ts` (export neutralisation, RAW) | nothing extra for the unit level |
| **UAT-15** | Restore a verified backup into a test environment and reconcile | **Not run** | **NONE** | Two Supabase projects |

---

## Risk register

| ID | Risk | Treatment status | Where |
| --- | --- | --- | --- |
| **R-01** | No approved limits → must block auto-release | **Treated, and tested** | Every measurement assesses `not_assessable` on production data; no automatic accept exists. `tests/assessment.test.ts`. The underlying condition is **unresolved** — D-02. |
| **R-02** | Unconfirmed steam-pressure units → exclude from conformity | **Treated, and tested** | `unitConfirmed: false`; `is_unit_confirmed` returns false for `'to confirm'` and NULL. `tests/assessment.test.ts`, `tests/stageForm.test.tsx`. Decision open — D-05. |
| **R-03** | User identity unavailable in the deployment | **Treated by architecture** | Supabase Auth + Google OIDC; identity is read from the JWT server-side, never from a request body. Unproven without a project. |
| **R-04** | Multiple users writing the same sheet | **Treated, and tested** | Fenced single-flight lease, idempotency registry, `expectedRevision`, reconciliation. `tests/sheetSync.test.ts`, `tests/idempotency.test.ts`. |
| **R-05** | A human alters the source sheet | **Treated, and tested** | Row-4 verification in the writing invocation; drift latches and aborts with no API call. `tests/sheetSync.test.ts`. Procedure in `docs/recovery-runbook.md` §5. |
| **R-06** | Connectivity interruptions | **Treated, partly tested** | Explicit unsaved state, caller-held idempotency key, unknown-outcome handling. `tests/sheetSync.test.ts`. The UI half is untested. |
| **R-07** | Batching and quota constraints | **Partially treated** | `_shared/quota.ts` honours a hint and backs off; the worker never reads the whole spreadsheet. **No benchmark under real workload.** |
| **R-08** | Unapproved sampling frequency → no false compliance KPI | **Treated, and tested** | No overdue flag and no adherence percentage for any stage. `tests/registry.test.ts`, `tests/reportMetrics.test.ts`. Decision open — D-04. |
| **R-09** | Incomplete batch/lot data | **Treated** | Per-stage requiredness in the registry; links must be **declared**, never inferred. `tests/zodSchema.test.ts`. |
| **R-10** | Sensitive access via shared links | **Treated by procedure only** | `docs/setup.md` §1.7 — Restricted sharing, never published to the web, quarterly recertification. **Nothing in code can enforce this**; it is a Google Drive setting a human must get right. |

---

## Discrepancies between the completion agents' reports and the code

Every claim below was checked by reading the file. Where a report was right, that is said
too — a verification that only records disagreements cannot be distinguished from one that
only looked for them.

### Confirmed, exactly as reported

| Claim | Verified how |
| --- | --- |
| `0002_samples.sql` `sample_prefixes` insert violates its FK to `sampling_points`, which nothing seeds beforehand | `sampling_points` is created at `0002:140`; the FK is at `0002:176`; the insert of `'AM'`/`'BC'` prefixes is at `0002:186`; **no `insert into public.sampling_points` exists in any migration.** |
| `WORKBOOK_KEY` mismatch | `_shared/adapters/store.ts:116` → `'operational-workbook'`; `0007_sheet_sync.sql:185` → `'operational_workbook'`. |
| `asOutboxState` used but not imported | `update-results/index.ts:120` uses it; the import block at lines 25–37 does not include it. |
| Five frontend endpoint names match no function directory | `useSamples.ts:74–85` maps to `sample-action`, `specification-action`, `admin-action`, `sync-action`, `schema-verify`; the deployed set is the eight real directories. |
| `checkDisposition` falls through for `'undetermined'` | `workflow.ts:267` maps it to `null`; no branch matches it; `workflow.ts:372` returns `{ allowed: true }`. |
| `system_config.schema_version` is `'0005'` with eight migrations present | `0005_system_config.sql:36`. |
| `docs/workbook-verification.md:237` says "Four of the 34" and enumerates nine | `(#7, #13, #14, #19–23, #27)` = 9. The enumeration agrees with the seed; only the count word is wrong. Not corrected here — that file is an evidence record and is not mine to edit. |
| No `[functions.*]` block in `supabase/config.toml` | `grep -c '^\[functions' → 0`. |
| The e2e `HAS_PROJECT` guard is inert in CI | `authenticated-integration.spec.ts:42` tests `.includes('.supabase.')`; `ci.yml` sets `https://exampleref.supabase.co`. Evaluated directly: `true`. **Also confirmed empirically** — with that placeholder, Playwright **collected** the three tests rather than skipping the describe. |
| `tsc -b --noEmit` is clean across the whole tree | Exit 0, with a planted-error positive control. |
| `npm run build` succeeds, 1797 modules | Exit 0. |
| `npx vitest run` → 502 of 502 | Exit 0, 11 files. |

### Where a report did not match the whole picture

| Reported | What is actually the case |
| --- | --- |
| Four agents reported **"eslint clean"** on their own files | True per file, and **misleading as a project statement**. `npm run lint` — the command CI runs **first** — exits 1 with 2 errors: `src/components/records/sampleCsv.ts:211` (`no-irregular-whitespace`, a deliberate UTF-8 BOM so `µm` and `°C` survive Excel) and `src/forms/sheetMapping.ts:116` (`no-control-regex`, a deliberate control-character class). Neither is a defect, and **neither sits in any agent's ownership list** — `sheetMapping.ts` and `eslint.config.js` are both in the frozen contract. The aggregate gate was therefore owned by nobody while every per-slice report was accurate. **CI is red and no deployment can succeed.** D-14. |
| One report described `verify:bundle` as failing only because `VITE_SUPABASE_ANON_KEY` was unset | Accurate as far as it goes, and it **misses a worse finding in the same output**. The `supabase-url-shape` positive control **passed on a build with no project URL at all**, matching the example URL in a validation message in `src/lib/env.ts`. A control that licenses trust in a zero, and that can be satisfied by the documentation of the thing it certifies, is not a control. D-15. |
| One report stated "no missing-module errors remain in `App.tsx`, so every page it imports now exists" | Correct, and it is a statement about **module resolution**, not about the pages working. Thirteen of the fourteen pages have **no test of any kind**. Both statements are true; only the first was reported. |
| The e2e suite's shape (18 declarations, 54 runs) was reported as verified by grep | Confirmed — and now confirmed more strongly: Playwright itself **collected 54 tests**. It then failed all 54 at `browserType.launch` (`@playwright/test` 1.49.1 wants `chromium_headless_shell-1148`; the machine has `-1248`), so **no assertion in the suite has ever been evaluated in this working copy**. No report claimed otherwise, but no report said this either. |
| One report said the seed gates were "validated both ways" against PostgreSQL 17 | Plausible and internally consistent, and **not reproducible from this repository** — there is no script, no fixture and no test that re-runs it. Recorded here as a one-off manual verification, not as coverage. The same applies to the `evaluate_measurement()` boundary run behind UAT-05 and UAT-06. |

### Claims this document could not check

Stated rather than silently accepted:

- Every assertion about a **local PostgreSQL 17 run** — the seed gates, the bootstrap's
  six paths, the `evaluate_measurement()` boundary values, the `role_permissions` diff
  against `BASE_PERMISSIONS`. Each is internally consistent and specific, and none leaves
  a repeatable artefact in the repository. Treated as credible manual verification, never
  as test coverage.
- Every assertion about **Deno type checking** of the Edge Functions. `eslint.config.js`
  ignores `supabase/functions/**` and `tsconfig.app.json` does not include it, so neither
  project gate sees that code at all.
- The claim that `googleAuth.ts:141` may be a **toolchain artefact** of a newer local Deno
  than the Supabase Edge Runtime ships. Reasonable; unverifiable without the deploy
  toolchain.
