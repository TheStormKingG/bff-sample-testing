# User acceptance test plan

All 15 acceptance scenarios from PRD §13, as runnable steps.

**Read this column first.** Every scenario states what it genuinely needs. Most of them
cannot run today, and saying so is the point of the document.

| Need | Meaning |
| --- | --- |
| **Supabase** | A real Supabase project with migrations applied, the `rpc_*` functions deployed and Google sign-in configured. |
| **Google OAuth** | A working Google OAuth client and Supabase Google provider; real staff accounts. |
| **Test Sheet** | The **TEST** spreadsheet, shared with the service account, with `SHEETS_SPREADSHEET_ID` set on the **test** project. |
| **Approved limit** | At least one approved specification rule. None exists in production data — 0 of 34. |
| **Fixture** | `supabase/seed/test_fixtures.sql`, applied by hand to a **test** database. |

> **Never run any of these against the 2026-10-24 draft workbook, and never against a
> production project.** The draft is owned by a personal Gmail account (D-07) and is not a
> test target.

---

## Readiness summary

| Scenario | Needs | Automated coverage today | Can run now? |
| --- | --- | --- | --- |
| UAT-01 Header fidelity | Supabase, Test Sheet | `tests/sheetMapping.test.ts` (76) | No |
| UAT-02 AM vs BC | — | `tests/registry.test.ts`, `tests/zodSchema.test.ts`, `tests/stageForm.test.tsx` | **Partly — unit level passes today** |
| UAT-03 Concurrent registration | Supabase | **none** | No |
| UAT-04 Idempotent retry | Supabase | `tests/idempotency.test.ts` (37) | **Partly — unit level passes today** |
| UAT-05 Missing approved limit | Supabase | `tests/assessment.test.ts` | **Partly — unit level passes today** |
| UAT-06 Boundary tests | Supabase, **Fixture** | `tests/assessment.test.ts` | **Partly — unit level passes today** |
| UAT-07 Unit uncertainty | — | `tests/assessment.test.ts`, `tests/stageForm.test.tsx` | **Partly — unit level passes today** |
| UAT-08 Visual hold | Supabase | `tests/assessment.test.ts`, `tests/registry.test.ts` | **Partly — unit level passes today** |
| UAT-09 Role denial | Supabase, Google OAuth | `tests/authority.test.ts` (66) — **pure functions only** | No, for the server-denial half |
| UAT-10 Full lifecycle | Supabase, Google OAuth | **none** | No |
| UAT-11 Revision conflict | Supabase | partial — `tests/sheetSync.test.ts` revision guard | No |
| UAT-12 Limit versioning | Supabase, Approved limit | partial — rule-id evidence recorded | No |
| UAT-13 Outage | Supabase, Test Sheet | `tests/sheetSync.test.ts` unknown-outcome suite | **Partly — unit level passes today** |
| UAT-14 Injection / invalid input | — | `tests/zodSchema.test.ts`, `tests/sheetMapping.test.ts` | **Partly — unit level passes today** |
| UAT-15 Recovery and reconciliation | Supabase ×2 | **none** | No |

"Partly" means the rule is asserted as a pure function and passes today; the end-to-end
scenario the PRD describes has not been run. Nothing in this table is marked passed.

---

## UAT-01 — Header fidelity

**Needs:** Supabase, Test Sheet · **Covers:** FR-004, NFR-006 · **Automated:**
`tests/sheetMapping.test.ts`

**Preconditions:** test project pointed at the TEST workbook. *Admin → Workbook schema
check* passes for all seven tabs. The sync worker can run.

1. Run *Admin → Workbook schema check*. **All seven tabs must pass before step 2.**
2. For each of the seven forms: register one sample with a distinctive value in **every**
   column, including a deliberate `0` in one numeric field, a blank in another, and a
   decimal with a trailing zero such as `12.50`.
3. Wait for *Confirmed in Google Sheets* on each.
4. Open the workbook and verify, per tab:
   - the row is in the **correct tab** and at **row 5 or below**;
   - every value is in the column `docs/mapping.md` says it should be;
   - no field swap, no truncation, no unit confusion;
   - `0` appears where zero was entered, and the cell is **blank** where nothing was;
   - `12.50` still reads `12.50`;
   - coded values became labels (`corn` → `Corn`, `yes` → `Yes`);
   - **rows 1–4 are untouched** on every tab;
   - **`Read me` and `Limits` are untouched**;
   - no other tab changed.

**Expected:** 98 values land in 98 intended cells across seven tabs, with zero collateral
edits.

---

## UAT-02 — AM versus BC

**Needs:** nothing extra for the unit level · **Covers:** FR-004, FR-008 ·
**Automated:** `tests/registry.test.ts`, `tests/zodSchema.test.ts`,
`tests/stageForm.test.tsx`

1. Open **Ground**. Choose sampling point **AM**.
2. Confirm *Moisture (%) at BC* (column L) is **not shown**.
3. Fill the rest and register. Confirm the sample ID starts **`AM-`**.
4. Open Ground again. Choose **BC**.
5. Confirm *Moisture (%) at BC* **is** shown, and is required at the testing stage.
6. Register. Confirm the ID starts **`BC-`**.
7. **The regression that matters:** on a BC form, type `13.25` into the BC moisture field,
   then switch the point to **AM**. The field disappears, the value is **cleared**, the key
   is **absent from the submitted payload**, and switching back to BC shows an **empty**
   box — not `13.25`.

**Expected:** the prefix comes from the structured sampling-point **code**, never from
substring-matching display text. A stale BC value can never reach the sheet from an AM
sample.

**Already green:** `npx vitest run tests/stageForm.test.tsx tests/zodSchema.test.ts
tests/registry.test.ts` asserts all of steps 2–7 at the unit level today.

---

## UAT-03 — Concurrent registration

**Needs:** Supabase · **Covers:** FR-006, NFR-001, R-04 · **Automated: NONE**

> This is the largest untested requirement in the system. The property is enforced by the
> schema — the id is allocated inside the registration transaction from a per-(prefix,
> plant-local-date) sequence, so simultaneous callers serialise on the counter row — but
> **no test exercises it**.

**Preconditions:** test project, `rpc_*` deployed, one `active` account with
`sample.register`.

1. Script **at least 20 simultaneous** `register-sample` calls for the **same stage and
   the same plant-local date**, each with a **distinct** idempotency key and a distinct
   payload.
2. Collect all 20 responses.

**Expected:**
- 20 **distinct** sample ids, with sequence numbers `01`–`20` and no gap and no repeat;
- 20 rows in `samples`;
- 20 outbox events;
- after the worker drains: **20 rows** in the workbook, not 19 and not 21;
- every acknowledgement reconciles to a row.

**Then repeat across the plant-local midnight boundary** — 23:59:30 and 00:00:30 Guyana
time — and confirm the sequence resets to `01` on the new local date while the earlier
sample keeps the previous date. That is the part a UTC-keyed implementation gets wrong.

---

## UAT-04 — Idempotent retry

**Needs:** Supabase · **Covers:** FR-006, FR-015, NFR-001 · **Automated:**
`tests/idempotency.test.ts` (37)

1. Register a sample and capture its idempotency key and response.
2. **Re-send the identical request with the identical key.** Expect the **same** sample
   id and the **byte-identical** stored response, not a new sample.
3. Re-send a third and fourth time. Same answer every time.
4. Re-send with the **same key and a changed payload**. Expect `409 payload_mismatch`.
5. Re-send with the **same key as a different user**. Expect `409`, and the identity
   mismatch reported **before** the payload mismatch.
6. Simulate a timeout **after** the Google write landed: confirm the retry produces **one
   row, not two**.
7. Confirm one sample, one outbox event and one spreadsheet row throughout.

**Expected:** no duplicate samples, no duplicate rows, and a replay even after the
original actor has lost the permission — because the stored response is replayed, not
recomputed.

**Already green at the unit level today.** `tests/idempotency.test.ts` sweeps every stored
state from the exported `IDEMPOTENCY_STATES` list, covers take-over at exactly
`IN_PROGRESS_TIMEOUT_MS`, clock skew, an unreadable timestamp, key-format boundaries at 16
and 128 characters, and asserts the canonical hash against the independently-known SHA-256
of `''` and `'abc'`.

---

## UAT-05 — Missing approved limit

**Needs:** Supabase · **Covers:** FR-009, R-01 · **Automated:**
`tests/assessment.test.ts`

1. On **production seed data** (0 of 34 approved), register a Conditioned sample with
   mash temperature `85.0`.
2. Enter it as a test result.

**Expected:**
- the measurement reads **Not assessable**, with a plain-language reason — *no approved
  rule*;
- **no automatic accept and no automatic release**;
- the sample cannot be accepted without an authorised disposition carrying a reason.

Repeat for a value far outside any plausible range, e.g. `250`. **Still Not assessable** —
there is no approved rule to be outside of. That is the correct answer and the one
operators find most surprising, so cover it in training.

**Already green:** `tests/assessment.test.ts` has a *"the seeded production ruleset
assesses nothing"* suite. During the build, the same four boundary values were put through
the database's own `public.evaluate_measurement()` on a real PostgreSQL 17 instance with
only the production seeds applied: `83.9`, `84`, `86`, `86.1` all returned
`not_assessable / no_approved_rule`.

---

## UAT-06 — Boundary tests

**Needs:** Supabase, **Fixture** · **Covers:** FR-009 · **Automated:**
`tests/assessment.test.ts`

> **This scenario needs `supabase/seed/test_fixtures.sql`.** It is the only place an
> approved 84–86 °C conditioned-temperature rule exists. The PRD says plainly: *"Do not
> run this test against live data until that rule is formally approved for testing."*

**Preconditions:** a **test** database. Apply the fixture explicitly — it refuses to run
otherwise:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -c "set app.allow_test_fixtures = 'yes'" \
  -f supabase/seed/test_fixtures.sql
```

The fixture creates three accounts on the reserved `.test` TLD and one approved rule,
proposed by a `quality_officer` and approved by a **different** `quality_supervisor`,
because the two-person CHECK makes that structural. The approved version deliberately
carries **no `workbook_entry_no`**, so it is distinguishable from an imported row and the
production import's own "0 of 34 approved" gate stays green even on a database where the
fixture has been applied.

1. Register four Conditioned samples with mash temperature **83.9, 84, 86, 86.1**.

**Expected:**

| Value | Assessment |
| --- | --- |
| 83.9 | **Outside Limit** |
| 84 | **Within Limit** (bounds are inclusive) |
| 86 | **Within Limit** (bounds are inclusive) |
| 86.1 | **Outside Limit** |

Each with `candidate_count = 1`, so no ambiguity.

2. **Then confirm the fixture did not leak.** Query the production import's gate: still
   34 `reference_only`, still **0 approved**.

**Already verified once:** these exact four values were run through
`public.evaluate_measurement()` on a real PostgreSQL 17 instance with the fixture applied
and returned exactly the table above. The inclusivity follows from
`src/lib/assessment.ts` comparing `value < lowerBound` / `value > upperBound`.

---

## UAT-07 — Unit uncertainty

**Needs:** nothing extra for the unit level · **Covers:** FR-009, R-02 · **Automated:**
`tests/assessment.test.ts`, `tests/stageForm.test.tsx`

1. Open **Conditioned**. Find *Steam pressure reading* (column G).
2. Confirm the field shows **"unit not confirmed"** and that its `aria-describedby`
   resolves to text saying the value **cannot be checked against a limit**.
3. Enter `2.5` — inside the Polinutri reference range of 2.2–2.8 — and register.

**Expected:** **Not assessable**, with *unit not confirmed* as the reason. **Never Within
Limit.** Even if someone later approved a 2.2–2.8 rule, the unconfirmed unit alone makes
the measurement unassessable, because 2.5 of an unknown unit is not a measurement that can
be compared with anything.

The workbook's `Limits` Unit cell for entry #13 contains the literal string
`"to confirm"`. The registry renders it verbatim rather than guessing, the database's
`public.is_unit_confirmed` returns false for `'to confirm'` and for NULL and true for
`'°C'`, and `docs/open-decisions.md` D-05 tracks the decision.

**Already green:** `tests/assessment.test.ts` has a *"UAT-07: unconfirmed units can never
pass"* suite, and `tests/stageForm.test.tsx` asserts the warning text and that this is the
registry's only such field.

---

## UAT-08 — Visual hold

**Needs:** Supabase · **Covers:** FR-010 · **Automated:** `tests/assessment.test.ts`,
`tests/registry.test.ts`

1. Register a **Raw materials** sample with **`Mould seen? = Yes`** and every numeric
   result left blank or comfortably ordinary.
2. Observe the sample.

**Expected:**
- a **hold is raised automatically**, and the sample shows the hold banner;
- the hold exists **even though no numeric result is out of limit** — and even though, on
  production data, every numeric result is *Not assessable*;
- the sample **cannot be automatically accepted**;
- clearing the hold needs `hold.clear`, which an Operator, a Quality Officer and an
  Administrator all lack;
- an audit event records the hold, its trigger and its instant.

Repeat for `Insects seen?`, `Foreign matter seen?` and `Bad smell?` — all four columns on
tab 1 carry an adverse answer that forces a hold.

---

## UAT-09 — Role denial

**Needs:** Supabase, Google OAuth · **Covers:** FR-002, NFR-002 · **Automated:**
`tests/authority.test.ts` (66) — **pure functions only; nothing reaches a server**

1. Sign in as an **Operator**.
2. Confirm the Specifications approval control and the hold-clear control are **not
   shown**.
3. **Then bypass the UI.** Call the Edge Functions directly with the operator's own JWT:
   - `approve-specification` on a proposed version;
   - `set-disposition` with `accepted` on a held sample;
   - `set-disposition` with a hold-clearing decision.
4. Repeat all three as an **Administrator**.
5. Repeat with **no JWT at all**.
6. Attempt a **role escalation**: call `admin`-type actions as a non-administrator.
7. Attempt **impersonation**: put another user's id in the request body.
8. Query `audit_events`.

**Expected:** every attempt in steps 3–7 is **refused by the server** and **recorded** as
an audit event naming the actor, the attempted operation and the instant. Hiding the
button in step 2 is a courtesy, not the control. Step 7 must fail because identity comes
from the JWT and the request body is never consulted for it.

9. Confirm no service-role key, PEM, service-account JSON, OAuth client secret, refresh
   token or spreadsheet id appears in the published bundle:
   `npm run build && npm run verify:bundle` — and check its **positive controls** passed,
   because a zero-finding scan proves nothing on its own. See `README.md` §1 for a control
   that currently passes spuriously.

---

## UAT-10 — Full lifecycle

**Needs:** Supabase, Google OAuth, four accounts · **Covers:** FR-007, FR-011, FR-012,
PRD §6.4 · **Automated: NONE**

1. **Operator** registers a **Raw materials** sample for a soya delivery. Note the id.
2. **Operator** registers a **Ground** sample (BC) and **declares the upstream link** to
   the raw-materials sample. The link must be **declared, never inferred** (PRD §6.4).
3. **Operator** registers **Extruded soya**, linked to the same raw soya lot.
4. **Quality Officer** finds the raw-materials sample by id, adds moisture and aflatoxin
   results. Confirm this **updates the existing row** rather than creating a second
   sample (FR-007).
5. **Quality Officer** submits it for review.
6. **Quality Supervisor** reviews, records a disposition with a reason, and confirms it.
7. Open each of the three samples and confirm the **linked upstream and downstream
   samples are listed and navigable**.
8. Open the audit timeline on the raw-materials sample.

**Expected:** one sample identity throughout, carrying draft → registered → awaiting
results → ready for review → reviewed. One spreadsheet row per sample, updated in place.
Linked history available from every member. A complete audit timeline naming each actor
and instant.

---

## UAT-11 — Revision conflict

**Needs:** Supabase · **Covers:** FR-013, R-04 · **Automated:** partial

1. Open the **same** sample in two browsers, as two different Quality Officers.
2. Editor A changes a result and saves. Succeeds.
3. Editor B — still holding the stale revision — changes a **different** field and saves.

**Expected:**
- B's save is **refused** with `409` and the **current revision**;
- **no silent overwrite**; A's value is intact;
- B is offered an explicit **refresh**, sees A's change, and can then re-apply their own;
- the conflict is visible, not resolved behind B's back.

4. Then test the correction path: change an already-recorded value **with a reason**, and
   confirm the **before and after** are both in the audit timeline. A correction never
   erases the original evidence (FR-013, NFR-005).

---

## UAT-12 — Limit versioning

**Needs:** Supabase, Approved limit · **Covers:** FR-014 · **Automated:** partial

1. With an approved rule in force, record a measurement and note its assessment **and the
   rule id and version recorded as evidence**.
2. Propose a **new version** of the same rule with different bounds, effective from
   **tomorrow**. Have a second person approve it.
3. Re-open the sample from step 1.

**Expected:**
- the historical assessment is **unchanged** and still reproducible, because it names the
  version that decided it;
- the new version applies to **future** measurements only;
- approval with an `effective_from` **before today** is **refused**, naming the earliest
  allowed date;
- a formal retrospective reassessment, if performed, generates **its own audit event** and
  does not overwrite the original.

4. Confirm `specification_versions` rows are immutable: attempt an update and a delete
   directly and confirm the trigger refuses both.
5. Confirm that editing a working number on the workbook's `Limits` tab **changes nothing**
   in live evaluation (FR-014's acceptance criterion). The import is `reference_only`; the
   app never reads `Limits` to decide conformity.

---

## UAT-13 — Outage

**Needs:** Supabase, Test Sheet · **Covers:** FR-015, R-06 · **Automated:**
`tests/sheetSync.test.ts`

1. Start a registration, then **disconnect the network before the response arrives.**
2. Observe the UI.

**Expected:** a clear failure — *"Not saved — check connection and retry"* — and
**never "Saved"**. No success state appears before a server-issued sample id arrives.

3. Reconnect. **Retry with the same idempotency key.**

**Expected:** if the server committed, the original registration is returned — same id,
same row, **no duplicate**. If it did not, the registration proceeds normally.

4. Now the Google half. Make the Sheets API time out **after** the write landed.

**Expected:** the worker treats this as an **unknown outcome**, not a failure. It
**reconciles first** — locates the row by sample id — before retrying, and produces **one
row, not two**. `allowAppendWithoutLocate` is explicitly `false`.

5. Throughout, the sample shows *Recorded securely, Google Sheets sync pending*, and the
   user can check the request state from the sync status on the sample.

**Already green at the unit level:** `tests/sheetSync.test.ts` has a *"a timeout is an
unknown outcome, not a failure"* suite and asserts the one-row property with the
blind-append optimisation switched on as well as off.

---

## UAT-14 — Injection and invalid inputs

**Needs:** nothing extra for the unit level · **Covers:** FR-008 · **Automated:**
`tests/zodSchema.test.ts`, `tests/sheetMapping.test.ts`

Enter each of the following and confirm the stated outcome:

| Input | Field | Expected |
| --- | --- | --- |
| `=SUM(A1:A9)` | Supplier (identity field) | **Refused** |
| `+1234`, `-1+1`, `@import` | any identity field | **Refused** |
| `\t=HYPERLINK(...)` | any identity field | **Refused** — leading whitespace and control characters are stripped before the check |
| `=1+1` | Comments (narrative field) | **Allowed** as text, and **neutralised on CSV export** |
| `-5` | Quantity received (tonnes) | **Refused** — negative mass is impossible |
| `150` | Moisture (%) | **Refused** — above 100 |
| `0` | Moisture (%) | **Accepted** — zero is a measured value |
| (blank) | Moisture (%) | **Accepted as not measured**, stored as `undefined`, written as a blank cell — never as `0` |
| `abc` | any numeric | **Refused** with *numbers only* |
| `zzz` | Material (controlled list) | **Refused** — not a valid code |
| `12.50` | any decimal | **Accepted, precision preserved** |
| `1200` | Quantity received (tonnes) | **Accepted after confirmation** — a typo guard, not a limit, and it never affects an assessment |

Also confirm: every write uses `valueInputOption: 'RAW'`, so nothing the operator types is
ever evaluated by Google as a formula, coerced to a date, or stripped of a leading zero.

**Already green:** `tests/zodSchema.test.ts` has suites for zero-vs-blank, hard bounds,
the soft guard never failing validation, controlled codes, and formula injection split by
field kind. `tests/sheetMapping.test.ts` covers the export-side neutralisation.

---

## UAT-15 — Recovery and reconciliation

**Needs:** Supabase ×2 (production and test) · **Covers:** FR-016, NFR-001 ·
**Automated: NONE**

Full procedure: `docs/recovery-runbook.md`.

1. Take a verified backup of the production project.
2. **Restore it into the TEST project.** Never over production.
3. Reconcile three populations against each other:
   - the idempotency **request registry** against the **samples** it claims to have
     created;
   - the **outbox** against the samples it should carry;
   - the **operational rows** in the workbook against the ledger.
4. Run `reconcile-sheets` with `dryRun: true` and read every finding.
5. **Document the actual recovery time** and **every discrepancy found**, including
   discrepancies of zero.

**Expected:** the restore completes; every acknowledged save is readable back by sample
UUID (NFR-001 asks for 100%); any discrepancy is explained rather than merely counted;
the recovery time is written down.

> FR-016 requires a **documented restore test**, not a backup setting. A backup nobody has
> restored is a hypothesis.

---

## What no scenario above covers

Stated so the plan is not read as exhaustive:

- **Performance.** NFR-003 targets a 95th-percentile form load ≤3 s and save confirmation
  ≤5 s. Nothing measures either. The PRD itself says these "require load/performance
  validation before contractual adoption".
- **Accessibility beyond the mechanical.** `tests/stageForm.test.tsx` asserts an
  accessible error summary and that `aria-describedby` resolves; two Playwright specs
  assert 44 px tap targets and no horizontal scroll at 375 px and 768 px. **No screen
  reader has been used, and no operator has been observed.** NFR-004 asks for observation
  during the pilot; that is a human activity and cannot be automated away.
- **The database's RLS policies.** There is no database integration test in this
  repository. Every policy is unexercised by automation.
- **Any real Google Sheets write.** Every Sheets behaviour is covered against an in-memory
  fake (`_shared/fakeSheets.ts`). No byte has ever reached a real spreadsheet from this
  code.
- **Retention and disposal.** NFR-009 needs a decision from Bounty Farm's record-control
  owner before there is anything to test (D-08).
