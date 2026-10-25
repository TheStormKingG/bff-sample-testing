# Open decisions

Every decision somebody other than a developer still owes this system. PRD §16's ten
open questions, plus everything the build itself surfaced.

**Each entry states the current safe default**, because the application is already
running on one. A safe default is not a resolution — most of them are the system refusing
to pretend, and a refusal that nobody revisits quietly becomes the permanent behaviour.

| Legend | Meaning |
| --- | --- |
| 🔴 | Blocks go-live |
| 🟠 | Blocks a feature, or blocks acceptance of one |
| 🟡 | Should be decided; the default is defensible indefinitely |

---

## Summary

| ID | Decision | Owner | Blocks | Flag |
| --- | --- | --- | --- | --- |
| D-01 | Which Google accounts will staff use? | Management + IT | consent-screen type, access model | 🔴 |
| D-02 | **0 of 34 limits are approved.** Who approves, and when? | Quality function | every conformity decision | 🔴 |
| D-03 | Who may release material or clear a hold? | Management + Quality | FR-011 acceptance | 🔴 |
| D-04 | Sampling frequencies for Ground, Conditioned, Pellets, Crumble | Feed Factory Process Owner | FR-020, any adherence KPI | 🟠 |
| D-05 | What is the steam-pressure unit? | Process Owner + Polinutri | UAT-07, entry #13 | 🟠 |
| D-06 | Which fields are mandatory at which stage? | Quality function | FR-008 acceptance | 🟡 |
| D-07 | **The workbook is a draft owned by a personal Gmail account (B-07)** | Management + IT | **cutover** | 🔴 |
| D-08 | Retention, disposal, backup objective, ongoing owner | Record-control owner | NFR-009, FR-016 | 🟠 |
| D-09 | **Should equipment SETTINGS be conformity-assessed at all?** | Quality + Process Owner | 9 of 34 limit entries | 🟠 |
| D-10 | `checkDisposition` has no `'undetermined'` branch | Dev + Quality sign-off | a latent authority bypass | 🟠 |
| D-11 | Two one-line defects in frozen or foreign files | Dev | the sync worker and results entry | 🔴 |
| D-12 | Migration `0002` FK ordering breaks `db:reset` | Dev | **every** local and fresh deployment | 🔴 |
| D-13 | **No `rpc_*` function exists**, and five frontend endpoints are missing | Dev + architecture | every write path | 🔴 |
| D-14 | `npm run lint` fails, so CI is red | Dev | **every deployment** | 🔴 |
| D-15 | A bundle-scanner positive control passes spuriously | Dev | trust in the credential scan | 🟠 |
| D-16 | The e2e skip guard is inert in CI | Dev | the meaning of "3 skipped" | 🟡 |
| D-17 | The privilege read-back control does not exist | Dev + security review | NFR-002 evidence | 🟠 |
| D-18 | Nothing schedules the sync worker or the reconciler | Dev + IT | FR-015 in practice | 🔴 |
| D-19 | **Should a Google Sheets confirmation gate material release?** | Quality function | release workflow design | 🟠 |
| D-20 | Multiple simultaneous samples at one stage; official plant/line/run identifiers | Process Owner | FR-012, traceability | 🟡 |
| D-21 | How are 'Other' raw materials and extra mycotoxins assessed? | Quality function | two tab-1 columns | 🟡 |
| D-22 | Is connectivity good enough for online-only, and what is the paper fallback? | Process Owner + IT | pilot design, FR-021 | 🟠 |

---

## From PRD §16

### D-01 🔴 Which Google accounts will staff use?

*PRD §16 Q1.* One Bounty Farm Workspace domain, personal Gmail accounts, or both?

**Who decides:** Management with IT.
**Blocks:** the OAuth consent-screen user type, and therefore the strongest available
access restriction. A Workspace domain allows **Internal**, which admits only
organisation members. Personal Gmail accounts force **External**, where every staff
member must be added individually as a test user while the app stays unpublished.
**Safe default today:** no allowlist by domain. Every new sign-in lands on `pending` and
sees nothing until an administrator approves it by name. This is secure, and it does not
scale past a handful of people.
**Note:** this is the same exposure as D-07. A system whose identity and whose records
both depend on a personal account has a single person as a dependency.

### D-02 🔴 Who approves specification limits, and when?

*PRD §16 Q2, R-01.* **0 of 34 workbook limit entries are approved.** 27 are *To set*, 4
are *Set* (Polinutri **vendor reference values** from 23 October 2026, **not Bounty Farm
approvals**), 2 are *Confirm with Polinutri*, 1 is *To set with Polinutri*.

**Who decides:** the Quality function, with a named approver.
**Blocks:** every conformity decision in the system.
**Safe default today:** every numeric measurement assesses **Not assessable**, and no
automatic accept or release exists. That is FR-009, UAT-05 and R-01 working correctly.
**The cost of leaving it:** the system records faithfully and decides nothing. An
operator who reads *Not assessable* as "the app is broken" will start making the call
themselves, which is worse than the paper form. **Cover this in training before the
pilot.**
**Smallest useful step:** approve **one** rule — conditioned mash temperature is the
obvious candidate — so the whole assessment path is exercised with real authority. A
single approved rule turns an untested code path into a demonstrated one.

### D-03 🔴 Who may release material or clear a hold?

*PRD §16 Q2, FR-011.*

**Who decides:** Management with the Quality function. Needed **in writing**.
**Blocks:** FR-011 acceptance, UAT-09 and UAT-10.
**Safe default today:** `hold.clear` and the three dispositions sit with
`quality_supervisor` only. `disposition.override_release` is held by **no role at all**
and can only exist as a time-bounded delegation. An Administrator has **no** quality
authority. A Quality Officer can **raise** a hold but not clear one.
**The question the default does not answer:** who holds `quality_supervisor`, by name, and
who covers them when they are away? The delegation mechanism exists; nobody has said who
may use it.

### D-04 🟠 Sampling frequencies for Ground, Conditioned, Pellets and Crumble

*PRD §16 Q3, R-08, FR-020.* The workbook says **"To set"** for all four. Only Raw
materials (*every load*), Extruded soya (*every run*) and Mash (*once per production run*)
are stated.

**Who decides:** the Feed Factory Process Owner.
**Blocks:** FR-020, and any sampling-adherence KPI.
**Safe default today:** **no adherence percentage is produced for any stage**, and no
overdue flag exists. Four stages read *Not reported* — no approved target, so more data
would not help. The three with a stated frequency read *Insufficient data* — the
denominator (loads received, runs made, production runs started) is **recorded nowhere in
the ledger**. The Reports page states both reasons and the difference between them.
**Note:** resolving the frequency fixes only half of this. An adherence percentage also
needs a recorded denominator, which means recording how many loads arrived and how many
runs were made — a second decision nobody has been asked for yet.

### D-05 🟠 What is the steam-pressure measurement unit?

*PRD §16 Q5, R-02, UAT-07.* `Limits` entry **#13** has the unit cell containing the
literal string **`"to confirm"`** with a range of 2.2–2.8.

**Who decides:** the Process Owner with Polinutri.
**Blocks:** UAT-07, and any assessment of column G on tab 3.
**Safe default today:** the unit renders **verbatim** — the app does not guess "bar". The
field is marked *unit not confirmed*, it can **never** assess as conforming even if a
2.2–2.8 rule were approved, and `is_unit_confirmed` returns false for `'to confirm'` and
for NULL.
**Why guessing is not an option:** 2.5 bar and 2.5 psi differ by a factor of about 14.5.
A conformity decision on an unknown unit is not a decision.

### D-06 🟡 Which test fields are mandatory at which stage?

*PRD §16 Q4.*

**Who decides:** the Quality function.
**Blocks:** FR-008 acceptance — the requiredness model needs a sign-off, not a change.
**Safe default today:** the registry's four-level model — `registration`, `testing`,
`review`, `optional` — with the per-field assignment in `docs/mapping.md`. Drafts may be
incomplete (FR-005).
**Related and unresolved:** `suppliers` and `feed_types` ship as **empty** controlled
lists. Inventing a supplier name would put a fabricated party on a quality record, and the
registry's feed-type fields are free text because no closed set has ever been published.
Bounty Farm must supply the real lists.

### D-07 🔴 The workbook is a draft owned by a personal Gmail account

*PRD §16 Q10. Cutover blocker **B-07**.* `BFF-FRM-06_18_Sample_Test_Log_DRAFT` is a
**native** Google Sheet — good — but it is a **draft** and it is owned by a **personal
Gmail account**.

**Who decides:** Management with IT.
**Blocks:** **production cutover.** Nothing else in this list blocks it as directly.
**Safe default today:** `SHEETS_SPREADSHEET_ID` has **no default anywhere**. The worker
refuses to run when it is unset and names the missing key. The draft id appears nowhere in
code, seeds, tests, `.env.example` or any fallback. **The draft is not a write target, not
even read-only, not even once.**
**What has to happen:** create a new **native** Google Sheet, **owned by a Bounty Farm
Workspace account or shared drive**, reproducing the verified structure
(`docs/mapping.md` §1). Create a separate TEST copy. Retire the draft. Protect rows 1–4
and both reference tabs on every tab.
**Why it is urgent rather than tidy:** a quality record whose operational copy lives in an
individual's personal Drive can be lost when that person leaves, and cannot be
access-recertified by the organisation (R-10, NFR-002). A database backup does not cover
it.

### D-08 🟠 Retention, disposal, backup objective, and the ongoing owner

*PRD §16 Q8, NFR-009, FR-016, PRD §17.*

**Who decides:** Bounty Farm's record-control owner, with management naming the owner.
**Blocks:** NFR-009, FR-016 and the PRD §17 definition of done, which requires "a named
ongoing owner with a support and change-control plan".
**Safe default today:** data minimisation is implemented — only the Google email and
display name are stored about a person. Audit events and specification versions are
immutable by trigger and cannot be deleted, so **nothing expires**. Backup and restore are
documented procedure in `docs/recovery-runbook.md`; nothing automates them and no restore
has been performed.
**Four answers needed:** how long must quality records be kept; how long must backups be
kept; what is the recovery point and recovery time objective; and who is the named system
owner.

### D-20 🟡 Multiple simultaneous samples at one stage; official identifiers

*PRD §16 Q6.* Can a batch have more than one sample at the same stage, and what are the
official identifiers for plant, line and production run?

**Who decides:** the Process Owner.
**Blocks:** FR-012 search semantics and traceability completeness.
**Safe default today:** multiple samples at one stage on one date are **permitted** — the
id sequence allows `-01`, `-02`, `-03`. Batch, bin, run and lot are free-text fields
carrying whatever the plant writes. Upstream and downstream links must be **declared, never
inferred** (PRD §6.4), so nothing is guessed.
**The cost of leaving it:** free text does not aggregate. Reporting by line or by
production run is not possible until the identifiers are formalised.

### D-21 🟡 'Other' raw materials and additional mycotoxins

*PRD §16 Q7.* Tab 1 columns **L** (*Other mycotoxin tested (name)*) and **M** (*Other
mycotoxin result*).

**Who decides:** the Quality function.
**Blocks:** assessment of those two columns, and of `material = other`.
**Safe default today:** both columns are `optional`, have **no parameter key** — so they
are **recorded only and can never be assessed** — and column M is marked *unit not
confirmed*. `material = other` is an accepted controlled code with no material-specific
rule.
**What a decision would need:** a named test method and unit per mycotoxin, and an
approved limit. Until then, recording the name and the number alongside each other is the
honest treatment.

### D-22 🟠 Is connectivity good enough for online-only, and what is the paper fallback?

*PRD §16 Q9, R-06, FR-021.*

**Who decides:** the Process Owner with IT, from observed plant conditions.
**Blocks:** pilot design, and whether FR-021 ever needs building.
**Safe default today:** online-only, with **no offline-save promise anywhere in the UI** —
which is exactly what FR-021 requires while a durable queue is unimplemented. Failures say
*"Not saved — check connection and retry"*. A retry with the held idempotency key is safe.
**The decision that cannot be deferred:** **what an operator does when the app will not
load.** That is a paper fallback and a transcription procedure, and it is a quality
procedure, not a software feature. The pilot should run paper in parallel regardless.

---

## Surfaced by the build

### D-09 🟠 Should equipment SETTINGS be conformity-assessed at all?

**Nine of the 34 `Limits` entries describe machine settings, not sample tests**: #7
(hammer distance), #13 (steam pressure), #14 (water added), #19–23 (extruder settings:
crusher roller gap, steam line %, steam line temperature, extruder temperature, amount),
and #27 (crumbler roll gap). The seed records them with `is_machine_setting = true`.

**Who decides:** the Quality function with the Process Owner.
**Blocks:** what a quality hold means. This is the most conceptually important entry in
this document.

**Why it matters.** A product test answers *is this material acceptable?* A machine setting
answers *was the equipment set as intended?* Those are different questions with different
consequences:

- A setting outside its range **at the moment of sampling** does not by itself make the
  material non-conforming. It is a **process deviation**, and the product may be perfectly
  good.
- Conversely, a setting inside its range does not make the material conforming.
- If settings are assessed as conformity, a mis-set roll gap raises a **quality hold on
  material** that may need no hold, and a Quality Supervisor is asked to make a release
  decision about an engineering problem.
- If settings are **not** assessed, a drifting conditioner may go unnoticed, because
  nothing flags it.

Four of the nine already carry Polinutri reference numbers (#13, #14, #27 and, via
*Confirm with Polinutri*, the urease and protein-solubility rows which are **product**
tests). So the numbers are arriving before the question has been answered.

**Safe default today:** all nine are imported as `reference_only`, so nothing is assessed
and no hold can be raised from a setting. The registry gives seven of them a
`parameterKey`, which means they *could* be assessed the moment somebody approved a rule —
**so the default is safe only while no rule is approved.** Approving a settings rule would
silently start raising material holds from process deviations.

**Three ways the decision could go:**

1. **Settings are not assessed.** Record them, never hold on them. Simplest and closest to
   current behaviour; loses the drift signal.
2. **Settings are assessed, but raise a *process deviation* rather than a material hold.**
   Correct in principle, and it needs a **second disposition track** that does not exist in
   the code or the data model.
3. **Settings are assessed as conformity.** Works today with no code change, and it means
   accepting that a mis-set machine puts material on hold.

**Whoever decides must be told that option 3 is the current code's behaviour the instant a
settings rule is approved.** That is why this entry blocks D-02's "approve one rule to
exercise the path" suggestion if the rule chosen is a setting — choose a product test.

### D-19 🟠 Should a Google Sheets confirmation gate material release?

Today the ledger is authoritative and the Sheet is a projection. A sample can be
**accepted and released while its sync is still pending**, and `set-disposition` reads the
sheet-confirmation state but does not require it.

**Who decides:** the Quality function.
**Blocks:** release workflow design, and the meaning of the two sync labels to a
supervisor.

**The argument for gating.** If the operational spreadsheet is the record the auditor
reads, releasing material whose row is not yet in it means releasing against a record that
does not yet exist where the organisation looks for it.

**The argument against.** Google is a **third party outside Bounty Farm's control**. Making
release depend on it means a Google outage, a quota exhaustion or a schema drift stops the
feed mill from releasing material that is demonstrably fine and whose record is
demonstrably durable in Postgres. It converts an availability problem into a production
stoppage — and the incentive it creates is to bypass the system, which is the worst
possible outcome for a quality record.

**Safe default today:** **not gated.** The disposition requires authority, a reason and a
time; the sync status is displayed truthfully beside it and the supervisor can see it. The
two honest labels are *Recorded securely, Google Sheets sync pending* and *Confirmed in
Google Sheets*.
**A middle option worth considering:** do not gate, but **record the sync state on the
disposition event**, so an audit can distinguish a release made against a confirmed row
from one made against a pending row. That is a small change and it preserves both
properties.

### D-10 🟠 `checkDisposition` has no `'undetermined'` branch

`src/lib/workflow.ts`: `DISPOSITION_PERMISSION` maps `'undetermined'` to `null`
(line 267), so the permission check is skipped; no decision branch matches it; execution
reaches `return { allowed: true, recordsOverride: false }` (line 372). **A caller passing
`'undetermined'` would move a held sample out of `on_hold` with no authority and no
reason.**

**Who decides:** a developer, with a Quality sign-off on the intended semantics.
**Blocks:** a latent authority bypass.
**Safe default today:** `src/lib/workflow.ts` is in the frozen shared contract, so
`set-disposition` refuses the value at the HTTP boundary and is currently the **only**
caller. **Any future caller inherits the gap**, and nothing warns them.
**The real fix** is in `workflow.ts`: either refuse `'undetermined'` explicitly, or type
the function's parameter as `Exclude<Disposition, 'undetermined'>` so the compiler refuses
it at every call site. The second is better — a permission table keyed by a complete enum
maps the non-decision member to "no permission required", and the permissive branch is
then reached by the one value nobody classified.

### D-11 🔴 Two one-line defects in files nobody owned

1. **`WORKBOOK_KEY` mismatch.** `_shared/adapters/store.ts:116` exports
   `'operational-workbook'` (hyphen); `0007_sheet_sync.sql:185` seeds the only lease row as
   `'operational_workbook'` (underscore). **Every** lease acquire, read, renew and release
   and **every** outbox claim would address a row that does not exist. One side must
   change; either fixes both, since the functions import the constant rather than restating
   it.
2. **`update-results/index.ts:120`** calls `asOutboxState(result.sheet_sync_state)` and
   never imports it. A `ReferenceError` on the **success** path, so every accepted results
   update would **500 after committing** — the worst shape of failure available, because
   the write succeeded and the caller is told it failed.

**Who decides:** a developer. Neither needs a product decision.
**Blocks:** the sync worker entirely (1), and results entry entirely (2).
**Safe default today:** none. Both are live defects. Neither sat in any completion agent's
ownership list, which is why both survived five agents all reporting their own files clean.

### D-12 🔴 Migration `0002` FK ordering breaks `db:reset`

`0002_samples.sql` inserts `sample_prefixes` rows whose `sampling_point` values `'AM'` and
`'BC'` carry a foreign key (line 176) to `public.sampling_points` (created line 140) —
and **no migration ever inserts into `sampling_points`.** The rows live in
`seed/0001_controlled_vocabulary.sql`, and **seeds run after migrations**, so a seed can
never satisfy a constraint checked during a migration. The FK is not deferrable.

Proven empirically against an empty PostgreSQL 17 database:

```
ERROR: insert or update on table "sample_prefixes" violates foreign key constraint
       "sample_prefixes_sampling_point_fkey"
DETAIL: Key (sampling_point)=(AM) is not present in table "sampling_points"
```

**Who decides:** a developer.
**Blocks:** `supabase db reset`, every fresh local setup and every new deployment. **No
seed file ever runs**, including the reference import.
**Safe default today:** none. Nothing can be stood up from scratch.
**The fix,** immediately before the `sample_prefixes` insert:

```sql
insert into public.sampling_points (code, label, sort_order)
values ('AM','AM after mill',10),('BC','BC before conditioning',20);
```

With that line added to a scratch copy, all eight migrations apply cleanly and both
production seeds pass their own gates. `seed/0001` keeps its `sampling_points` insert with
`on conflict do update`, so it becomes a harmless no-op afterwards.

### D-13 🔴 No `rpc_*` function exists, and five frontend endpoints are missing

Two halves of one gap: **the write path has no middle.**

**(a) The database side.** Migrations `0001`–`0008` define tables, RLS, triggers and the
assessment engine, but **no `rpc_*` function**. Every Edge Function calls `RPC.*` and
returns its typed `rpc_not_deployed` error. Needed at minimum:
`rpc_register_sample`, `rpc_update_results`, `rpc_review_sample`, `rpc_set_disposition`,
`rpc_approve_specification`, the lease and outbox RPCs, `rpc_read_sample_sync_state`,
`rpc_read_ledger_for_stage`, `rpc_requeue_outbox_event`,
`rpc_write_reconciliation_report` and `rpc_health_snapshot`.

Two of those are **declared in `_shared/rpc.ts` with no argument interface** while every
other member is fully typed, so each caller invents the argument names and a mismatch is
invisible to a type checker. `reconcile-sheets` documents the lists it sends in its own
header; the migration must match them. `rpc_read_ledger_for_stage` is specified in a prose
comment only, as `(p_stage, p_limit, p_offset)`.

**No table backs `rpc_write_reconciliation_report`**, though `last_reconciled_at` is read
in two places.

**(b) The frontend side.** `src/hooks/useSamples.ts:74–85` maps to five endpoint names
that match no function directory: `sample-action`, `specification-action`, `admin-action`,
`sync-action`, `schema-verify`. The deployed set is the eight real directories. **Every
mutation from the review, specification, admin and sync-retry screens will 404.** This
predates the completion run — it already failed for the three original entrypoints.

**Who decides:** a developer, plus an architectural choice on (b): add thin action-router
functions, or repoint the hook constants at the real endpoints. `set-disposition` and
`approve-specification` already return the `{ ok, … }` shapes those hooks expect, so
repointing is viable for at least those two.
**Blocks:** every write path in the application.
**Safe default today:** none. Reads work; nothing can be written.

### D-14 🔴 `npm run lint` fails, so CI is red and nothing can deploy

`npm run lint` exits 1:

```
src/components/records/sampleCsv.ts:211  error  Irregular whitespace not allowed      no-irregular-whitespace
src/forms/sheetMapping.ts:116            error  Unexpected control character(s) …     no-control-regex
✖ 6 problems (2 errors, 4 warnings)
```

**Neither is a defect.** The first is a deliberate UTF-8 byte-order mark so `µm` and `°C`
survive being opened in Excel. The second is a deliberate `[\s\u0000-\u001f]` class
stripping control characters before the spreadsheet-formula check — because a tab before
`=` still parses as a formula downstream.

`ci.yml` runs `npm run lint` as its **first** step, and `deploy-pages.yml` gates on
`ci.yml` through `workflow_call`. **A deployment attempted today fails before anything is
built.**

**Who decides:** a developer, and whoever owns the frozen contract — `src/forms/
sheetMapping.ts` and `eslint.config.js` are both in it.
**Blocks:** every deployment, and NFR-006's "automated tests" gate.
**Safe default today:** none.
**Two options:** a narrow `eslint-disable-next-line` with a stated reason at each site (two
lines, and the reason is the valuable part), or a rule configuration in
`eslint.config.js`. The disable comments are preferable — they document *why* at the place
a future reader will ask.
**Worth recording about how this survived:** four completion agents ran
`eslint <their own files>` and each was genuinely clean. `eslint .` is a different command
with a different verdict, and neither offending file sat in any agent's ownership list.
Per-slice verification attributes diagnostics correctly and leaves the aggregate gate owned
by nobody.

### D-15 🟠 A bundle-scanner positive control passes spuriously

`npm run verify:bundle` reports `Credential findings: 0` and
`PASS supabase-url-shape — project URL shape found in assets/env-*.js`. **No project URL
is baked into that build** — this working copy has no `.env`. What the control matched is
the example URL inside a validation message in `src/lib/env.ts`:

```ts
.url('VITE_SUPABASE_URL must be a full URL, for example https://abc.supabase.co')
```

The sibling `anon-key-shape` control correctly **failed** on the same build, and that
disagreement is the only reason this was visible. Had the example been a *key* rather than
a *URL*, both controls would have passed and the scanner would have certified a bundle it
had never truly examined.

**Who decides:** a developer.
**Blocks:** trust in the credential scan, which is the control protecting a public static
host from a leaked secret.
**Safe default today:** the scan still exits 1 because the other control fails, so the gate
holds — **by luck, not by design.** Supply a real `.env` and it exits 0 with one of its two
controls meaningless.
**The fix:** bind the control to a value the **pipeline injected for this build** — a
nonce, the build id, or the literal `VITE_SUPABASE_URL` value — and assert that exact
string rather than its pattern. A control that cannot distinguish the artefact from a
*description* of the artefact is not a control. Related: validate a control by withholding
the real value from the **real** artefact, not by handing it a fixture built to contain
nothing — the existing self-test does the latter and therefore could not find this.

### D-16 🟡 The e2e skip guard is inert in CI

`e2e/authenticated-integration.spec.ts:42` computes
`HAS_PROJECT = VITE_SUPABASE_URL.includes('.supabase.')`. `ci.yml` sets the placeholder
`https://exampleref.supabase.co`, **which contains `.supabase.`**, so `HAS_PROJECT` is
`true` in CI and the describe-level guard never fires. Verified by direct evaluation, and
confirmed empirically: with that placeholder, Playwright **collected** the three tests
rather than skipping the describe.

**Who decides:** a developer.
**Blocks:** nothing today — the CI outcome is still correct, which is exactly why this has
no symptom.
**Two live consequences:** (a) "3 skipped" in CI means *no tokens supplied*, **not** *no
test project configured*; (b) if someone supplies the tokens but leaves the placeholder URL
— the natural next step, since the skip message names the tokens — the guard will not stop
the run, and the specs will execute against a host that does not resolve and fail as
confusing network errors instead of skipping.
**The fix:** key the guard on an explicit opt-in, `E2E_REAL_BACKEND=1`, rather than on the
shape of a hostname. A guard whose predicate is satisfied by the very placeholder it exists
to exclude is not a guard.
**Documented in** `e2e/README.md` under *"A skip guard that does not fire where you would
expect"*.

### D-17 🟠 The privilege read-back control does not exist

`0001_identity.sql` discusses, correctly and at length, the hazard that a `REVOKE` can only
remove a grant that was actually **recorded** — so it succeeds and changes nothing when the
grant was never there, and `ALTER DEFAULT PRIVILEGES … REVOKE` is inert for exactly that
reason. It names **`0013_security_posture.sql`** as the file that reads the privilege
catalogue back to prove the revokes took effect.

**Superseded 2026-10-24:** migrations `0009`–`0015` are now on disk, and `0009_privilege_hardening.sql` carries the read-back control. Originally recorded when only `0001`–`0008` existed, at which point the control the migration
itself presents as the evidence **is not performed anywhere**, by any automated means.

`0001` also names **`0014_bootstrap_first_admin.sql`** as the home of the bootstrap path,
which is instead implemented as a hand-applied seed. If someone later adds that migration,
the project will have **two** bootstrap paths and they must not both arm a grant.

**Who decides:** a developer, with a security review.
**Blocks:** NFR-002 evidence. The posture may well be correct; nothing demonstrates it.
**Safe default today:** the manual SQL checks in `docs/setup.md` §3.3 — read
`pg_class.relrowsecurity` and `information_schema.role_table_grants` back, and expect zero
rows for `anon`. **A manual check nobody has diarised is not a control.**
**Also outstanding:** a comment in `0001` says `audit_events` is "created in 0005"; it is
created in `0006_audit_and_idempotency.sql`. Harmless to execution, wrong for a reader.

### D-18 🔴 Nothing schedules the sync worker or the reconciler

Both accept a scheduler invocation via `x-sync-scheduler-secret`. **Nothing invokes either
periodically.** No `pg_cron` entry, no external scheduler.

Related: `supabase/config.toml` has **no `[functions.*]` block**, so `health` and
`sheets-sync-worker` sit behind the gateway's default `verify_jwt` and their own internal
authorisation — anonymous liveness for `health`, scheduler secret or `sync.retry` for the
worker — never gets a chance to run.

**Who decides:** a developer with IT, on where the schedule lives.
**Blocks:** FR-015 in practice. Without a scheduler **every sample stays "sync pending"
forever** and the outbox grows without bound. The records are safe; the operational
spreadsheet is never written.
**Safe default today:** manual retry from *Admin → Sync health* (needs `sync.retry`).
Workable for a day of piloting, not for operation.
**Also missing: error notification.** A dead letter is a committed quality record the
spreadsheet does not show — somebody must be told. Alert on a **dead letter**, on latched
**schema drift**, and on **sustained pendency**; never on a single failed attempt, since
transient Google errors are what the backoff exists for. Options and exact SQL:
`docs/setup.md` §7.

---

## One thing that is not a decision

**The 300-row template limit.** The workbook's data validation and conditional formatting
stop at row 304. That is a workbook-formatting fact, not an application constraint:
nothing in this application assumes a row ceiling, as NFR-007 requires. Extending the
formatting down the sheet is housekeeping for whoever maintains the template, not a
decision anyone owes.
