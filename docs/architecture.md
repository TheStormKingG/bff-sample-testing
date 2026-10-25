# Architecture

> Written by reading the code on 2026-10-24. Where a component is specified but not yet
> built, this document says so in the same sentence rather than in a footnote.

---

## 1. The one-paragraph version

A static React bundle, published on a public host, talks to Supabase. **It holds no
authority.** Reads are authorised by Row Level Security evaluated against the signed-in
user's JWT; every write goes through an authenticated Edge Function that re-derives the
caller's identity server-side and calls a transactional database function. A commit to
Postgres also enqueues a row in a **transactional outbox** in the same transaction. A
separate, leased, single-flight worker drains that outbox into the operational Google
Sheet. The Sheet is therefore always a projection of the ledger, never a second source of
truth, and the UI never claims a Sheets confirmation it has not observed.

---

## 2. Layers

```
┌───────────────────────────────────────────────────────────────────────────┐
│  BROWSER — public static bundle (GitHub Pages).  NO AUTHORITY.            │
│                                                                           │
│  src/pages/        14 screens: dashboard, the 7 forms, samples, detail,   │
│                    awaiting, holds, reviews, specifications, reports,     │
│                    admin, login, pending, 404                            │
│  src/components/   ui/ (primitives) · layout/ · form/ · records/          │
│  src/hooks/        TanStack Query: session, profile, samples, detail,     │
│                    specifications, admin, draft, register                │
│  src/forms/        registry.ts  ← SINGLE SOURCE OF TRUTH for all 98       │
│                    columns, 7 tabs, types, units, requiredness,           │
│                    applicability and parameter keys                       │
│                    zodSchema.ts and sheetMapping.ts are GENERATED from it │
│  src/lib/          time (America/Guyana) · sampleId · roles · assessment  │
│                    · workflow · reportMetrics · env (4-var allowlist)     │
└──────────────────────────────┬────────────────────────────────────────────┘
                               │  HTTPS.  anon key + the user's JWT.
                               ▼
┌───────────────────────────────────────────────────────────────────────────┐
│  SUPABASE EDGE FUNCTIONS (Deno) — the write boundary                      │
│                                                                           │
│  register-sample   review-sample   update-results   set-disposition       │
│  approve-specification   sheets-sync-worker   reconcile-sheets   health    │
│                                                                           │
│  _shared/adapters/  authorize · mutation · http · store · env             │
│                     googleAuth · googleSheets                             │
│  _shared/           idempotency · canonical · hash · sha256 · projection  │
│                     outbox · lease · backoff · reconcile · headerCheck    │
│                     quota · syncWorker · syncStatus · validation · rpc    │
│                     errors · fakeSheets · sheets                          │
└──────────────────────────────┬────────────────────────────────────────────┘
                               │  service role, inside the function only
                               ▼
┌───────────────────────────────────────────────────────────────────────────┐
│  POSTGRES — the authoritative quality ledger                              │
│                                                                           │
│  0001 identity, roles, permissions, delegations, bootstrap grant          │
│  0002 samples, stages, prefixes, measurements, links, sampling points     │
│  0003 specifications and immutable specification_versions                 │
│  0004 holds, dispositions, quality decisions                              │
│  0005 system_config                                                       │
│  0006 audit_events, idempotency request registry                           │
│  0007 sheet_sync_outbox, worker lease, schema verifications                │
│  0008 assessment engine (evaluate_measurement, is_unit_confirmed)         │
│                                                                           │
│  RLS on every table.  Specification versions and audit events are         │
│  immutable by trigger.                                                     │
└──────────────────────────────┬────────────────────────────────────────────┘
                               │  outbox, drained by ONE leased worker
                               ▼
┌───────────────────────────────────────────────────────────────────────────┐
│  GOOGLE SHEETS — the operational record, write-only from the ledger       │
│                                                                           │
│  9 tabs.  "Read me" and "Limits" are REFERENCE: never written.            │
│  Rows 1–4 protected (1–2 title/instruction, 3 merged band, 4 headers).    │
│  Data from row 5.  valueInputOption = RAW, always.                        │
└───────────────────────────────────────────────────────────────────────────┘
```

### The registry is load-bearing

PRD NFR-006 forbids "magic column offsets buried throughout UI code". `src/forms/
registry.ts` is the only place a column letter, a tab name, a unit or a requiredness
rule exists. The validation schema, the Sheets row builder, the form renderer, the server
validator and the specification linkage are all derived from it. No stage name and no
field key appears in `StageForm.tsx`; the form for all seven tabs is one component.

Consequence worth stating: adding a column is a registry edit plus a workbook change,
and `verifyWorkbook()` will refuse to write until the live row-4 headers match. A
mismatch fails closed.

---

## 3. Data flow: registration to a confirmed Sheets row

```
 OPERATOR                 EDGE FUNCTION                POSTGRES                 WORKER / GOOGLE
    │
    │ fills the form
    │ (registry-driven; zero ≠ blank;
    │  no result pre-filled)
    │
    │ "Save draft"
    ├──────────────────────────────────────────────────────────────────┐
    │   localStorage, per user, per device.  NO sample row, NO id.     │
    │   FR-005: not counted as collected — there is no row to count.   │
    └──────────────────────────────────────────────────────────────────┘
    │
    │ "Register sample"  + Idempotency-Key (held per payload
    │                      fingerprint, REUSED on retry)
    ▼
         ┌──────────────────────────────────────────┐
         │ 1. identity from the JWT — never from    │
         │    the request body                      │
         │ 2. canonical payload hash (SHA-256)      │
         │ 3. request registry lookup:              │
         │      same key + same payload  → REPLAY   │
         │      same key + diff. payload → 409      │
         │      in progress              → 409      │
         │ 4. permission check; a denial is AUDITED │
         │ 5. registry validation, server-side      │
         └────────────────┬─────────────────────────┘
                          ▼
              ┌──────────────────────────────────────────────────┐
              │  ONE TRANSACTION                                 │
              │   • allocate the sample id from the plant-LOCAL   │
              │     collection date sequence  (AP-2026-10-24-01)  │
              │   • insert the sample + its measurements          │
              │   • assess each measurement against APPROVED      │
              │     rules only → within / outside / not_assessable│
              │   • raise a hold if any adverse observation or    │
              │     out-of-limit result                           │
              │   • write audit events                            │
              │   • ENQUEUE sheet_sync_outbox  ← same transaction  │
              │   • store the response in the request registry    │
              └────────────────┬─────────────────────────────────┘
                               │  commit
                               ▼
    ◄──── 200 { sampleId, recordedAt, captureState, syncStatus: 'pending' }
    │
    │  UI shows:  "Recorded securely, Google Sheets sync pending"
    │             — never "Saved to Google Sheets"
    │
    │            ·  ·  ·  later, independently  ·  ·  ·
    │                                                        ┌──────────────┐
    │                                                        │ sheets-sync- │
    │                                                        │ worker       │
    │                                                        └──────┬───────┘
    │                              refuses to start unless SHEETS_SPREADSHEET_ID
    │                              and GOOGLE_SERVICE_ACCOUNT_JSON are both set
    │                                                               │
    │                              1. ACQUIRE THE LEASE, take a fence token
    │                              2. validate the returned row — never assume
    │                                 the acquisition won
    │                              3. VERIFY ROW-4 HEADERS for every stage in
    │                                 the batch, in THIS invocation, before the
    │                                 first write.  Drift → 409, no API call.
    │                              4. claim outbox events under the fence
    │                              5. per event:
    │                                   LOCATE the row by sample id
    │                                   append (once) or update in place
    │                                   READ BACK and verify
    │                                   relocate if the sheet was re-sorted
    │                                   RAW, always
    │                              6. mark confirmed / retry with jittered
    │                                 backoff / dead-letter at max attempts
    │                              7. release the lease under the fence
    │                                                               ▼
    │  UI now shows:  "Confirmed in Google Sheets"      row 5+ of the right tab
```

### What the seven state words actually mean

The UI has exactly two honest sync labels, both produced by `syncStatusFor()`:

| Label | Meaning |
| --- | --- |
| *Recorded securely, Google Sheets sync pending* | Committed to the ledger. The quality record **exists and is durable**. Google has not confirmed. |
| *Confirmed in Google Sheets* | The worker wrote the row **and read it back**. |

There is no third label, and no code path produces "Saved to Google Sheets" for unsynced
data.

---

## 4. The trust boundary

```
            PUBLIC  ·  anyone can read this, signed in or not
   ┌──────────────────────────────────────────────────────────┐
   │  dist/  on GitHub Pages                                   │
   │    the whole application's JavaScript and CSS             │
   │    VITE_SUPABASE_URL          public by design            │
   │    VITE_SUPABASE_ANON_KEY     public by design            │
   │    VITE_APP_VERSION, VITE_BASE_PATH                       │
   └──────────────────────────────────────────────────────────┘
   ════════════════════  TRUST BOUNDARY  ═══════════════════════
   ┌──────────────────────────────────────────────────────────┐
   │  Row Level Security                                       │
   │    every table; a `pending` account matches no row        │
   │  Edge Functions                                           │
   │    identity from the JWT; permission checked server-side;  │
   │    a denial is audited, not merely refused                │
   │  Database functions and triggers                          │
   │    re-evaluate authority under their own lock; immutable   │
   │    specification versions and audit events                 │
   │  Google Sheet sharing                                     │
   │    one least-privilege service account as Editor;          │
   │    rows 1–4 and both reference tabs protected;             │
   │    never published to the web, never link-shared           │
   │  Edge Function secrets                                    │
   │    SHEETS_SPREADSHEET_ID (no default) ·                    │
   │    GOOGLE_SERVICE_ACCOUNT_JSON · SYNC_SCHEDULER_SECRET ·   │
   │    service-role key                                        │
   └──────────────────────────────────────────────────────────┘
```

Three consequences the team should hold on to:

1. **The anon key being public is the design, not an oversight.** It names the project
   and nothing else. Authority arrives with the user's JWT.
2. **Hiding a UI control is not a control.** `RequirePermission` exists so an operator
   is not shown a button that will be refused. The refusal itself lives on the server,
   and `tests/authority.test.ts` asserts the matrix the server enforces — notably that an
   administrator holds no `spec.approve`, no `hold.clear` and no disposition permission.
3. **A `pending` account sees nothing.** The gate is RLS, not the `PendingAccessPage`
   screen. A deep link, a reload or a hand-built query all land on the same empty result.

---

## 5. Concurrency, leasing and idempotency

Four separate mechanisms, each answering a different question.

### 5.1 Unique ids under concurrent registration — FR-006, UAT-03

The id is allocated **inside the registration transaction**, from a per-(prefix, plant-local
date) sequence, so two simultaneous registrations serialise on the counter row and cannot
produce the same id. The sequence key is the plant-**local** collection date, so a sample
collected at 21:00 Guyana time on the 24th belongs to the 24th even though UTC has
already rolled over.

> No automated test exercises 20 simultaneous registrations. `tests/sampleId.test.ts`
> covers the format, parsing and counter key; the concurrency property itself is
> asserted only by the schema. UAT-03 remains a manual scenario.

### 5.2 Retry safety — FR-006, UAT-04

The caller supplies an **idempotency key and holds it across retries**. `useRegisterSample`
takes the key as a required input and exports `newIdempotencyKey()` rather than minting one
per call — a fresh key on every retry is exactly how a save that timed out after the server
committed becomes a second sample with a second id and a second spreadsheet row.

The request registry decides on three axes, all before any work:

| Same key, and… | Outcome |
| --- | --- |
| identical canonical payload | the stored response is replayed **verbatim**, however often asked, even after the actor lost the permission |
| different payload | `409 payload_mismatch` |
| different actor | `409` — the identity mismatch is reported *before* the payload mismatch |
| different operation | `409` |
| still in progress | `409 in_progress`, with take-over after `IN_PROGRESS_TIMEOUT_MS` |

"The same payload" is a canonical SHA-256 hash that ignores object key order but **not**
array order, and separates `0` from `""` from absent, and `84` from `'84'` from `'84.0'`.

### 5.3 One writer at a time — R-04

The Sheets worker holds a **lease with a fence token**. Every write and every bookkeeping
call carries the fence; a stale fence is rejected at the worker's own pre-write check
*and independently* at the store, so a stalled fence-7 worker cannot write while fence-8
is live. The lease is released in a `finally` under the fence, and a failed release is
logged and swallowed so it cannot overwrite a successful pass's outcome. A second
overlapping caller gets `409 lease_conflict`.

The worker also **re-verifies the row-4 headers in the invocation that is about to
write**, for every stage in the claimed batch. A latched drift aborts with no Google API
call at all; a freshly-discovered mismatch latches drift and returns `409 schema_drift`
naming the offending columns.

### 5.4 Optimistic revision — UAT-11, FR-013

Mutations against an existing sample carry `expectedRevision`. A stale value returns
`409` with the current revision, so a second editor is told to refresh rather than
silently overwriting. Registration sends none: a brand-new sample has no prior revision,
and passing one would be a guess.

### 5.5 What a timeout means

A Google write that times out is an **unknown outcome**, never a failure. The write may
have landed. The worker therefore reconciles — locates the row by sample id — *before*
retrying, and `allowAppendWithoutLocate` is explicitly `false`. `tests/sheetSync.test.ts`
asserts that a write which landed and then timed out produces one row, not two, including
with the blind-append optimisation switched on.

---

## 6. Capture state, assessment and disposition are three different things

Conflating these is the most expensive mistake available in this domain, so the code
keeps them in three separate modules with three separate vocabularies.

```
   CAPTURE STATE            ASSESSMENT                  DISPOSITION
   where the RECORD is      what the NUMBERS say        what a PERSON decided
   src/lib/workflow.ts      src/lib/assessment.ts       src/lib/workflow.ts
   per sample               per measurement             per sample
   moved by the system      computed, never decided     requires authority,
   as work proceeds         by a person                 a reason and a time

   draft                    within_limit                undetermined
   registered               outside_limit               on_hold
   awaiting_results         not_assessable              accepted
   ready_for_review                                     rejected
   reviewed                                             rework_required
   voided                                               released_by_
                                                          authorized_override
```

- **Capture state** answers *has the work been done?* It is a state machine
  (`checkTransition`, `allowedTransitionsFrom`); no transition is implicit.
- **Assessment** answers *does this number conform?* It is a pure function of the value,
  the measurement context and the **approved** rules. `not_assessable` is returned
  whenever there is no approved applicable rule, when the rules are ambiguous, or when
  the unit is unconfirmed. Today, with 0 of 34 workbook limits approved, **every numeric
  measurement in production assesses as `not_assessable`** — which is FR-009 and R-01
  working, not a bug.
- **Disposition** answers *what did an authorised person decide, and why?* It always
  requires a permission, a reason and a recorded instant. Accepting over an outstanding
  finding needs the delegation-only `disposition.override_release` and is recorded as an
  override, never as a clean pass, so the audit trail cannot be misread.

A hold is raised automatically — by an adverse visual observation such as
`Mould seen? = Yes`, or by an out-of-approved-limit result — and **cannot be cleared by
the automatic path that raised it**. A Quality Officer may *raise* a hold; clearing needs
`hold.clear`, which the officer does not hold by default.

### Known gap in this separation

`checkDisposition` has **no branch for the `undetermined` member of `DISPOSITIONS`**.
`DISPOSITION_PERMISSION` maps it to `null`, so the permission check is skipped, no
decision branch matches, and execution reaches the final
`return { allowed: true, recordsOverride: false }`. A caller passing `'undetermined'`
would move a held sample out of `on_hold` with no authority and no reason.

`src/lib/workflow.ts` is in the frozen shared contract, so the fix was not applied there.
`set-disposition` refuses `'undetermined'` at the boundary instead, and that is currently
the only caller. **Any future caller of `checkDisposition` inherits the gap.** Recorded as
D-10.

---

## 7. Reads, caching and staleness

Reads go through TanStack Query (`src/lib/queryClient.ts`). The rule that matters for a
quality record: **a stale quality decision must never be shown as current.** Mutations
invalidate the sample, the worklists and the dashboard counts, and holds, dispositions
and assessments are refetched rather than optimistically patched. A disposition the
server has not acknowledged is never rendered as recorded.

Reports are **views over stored records**, not shadow tables (PRD §12). Every metric in
`src/lib/reportMetrics.ts` declares its numerator, denominator, timestamp convention and
missing-data handling, and distinguishes three things a naive dashboard would collapse:

| Shown | Means |
| --- | --- |
| `0` | a real, measured zero |
| *Insufficient data* | the denominator is not recorded anywhere in the ledger |
| *Not reported* | there is no approved target, so more data would not help |

Sampling adherence is therefore reported for **no** stage: four stages have
`frequencyApproved = false` (*Not reported*), and the three with a stated frequency have
no recorded denominator — loads received, runs made, production runs started (*Insufficient
data*). Inventing a denominator would produce a compliance percentage that looks
authoritative and is not (R-08, FR-020).

---

## 8. Where the architecture is not finished

Stated here so the diagrams above are not read as a description of a running system.

1. **No `rpc_*` function exists in migrations 0001–0008.** Every Edge Function calls
   `RPC.*` and returns the typed `rpc_not_deployed` error. The write path in §3 is
   implemented end to end *except* for the transaction at its centre.
2. **`rpc_requeue_outbox_event` and `rpc_write_reconciliation_report` are declared in
   `_shared/rpc.ts` with no argument interface**, while every other member is fully
   typed. Each caller therefore invents the argument names and a mismatch is invisible to
   a type checker. `reconcile-sheets` documents the lists it sends in its own header.
3. **No table backs a reconciliation report**, though `last_reconciled_at` is read in two
   places.
4. **`WORKBOOK_KEY` disagrees with the seeded lease row**:
   `_shared/adapters/store.ts` exports `'operational-workbook'` (hyphen);
   `0007_sheet_sync.sql` seeds `'operational_workbook'` (underscore). Every lease
   acquire, read, renew and release, and every outbox claim, would address a row that does
   not exist. One side must change. D-11.
5. **`update-results/index.ts:120` calls `asOutboxState(...)` without importing it.** A
   `ReferenceError` on the **success** path, so every accepted results update would 500
   *after* committing. One-line fix. D-11.
6. **`supabase/config.toml` has no `[functions.*]` block**, so `health` and
   `sheets-sync-worker` sit behind the gateway's default `verify_jwt` and their own
   internal authorisation (anonymous liveness; scheduler secret or `sync.retry`) is
   unreachable.
7. **Nothing schedules the worker or the reconciler.** Both accept a scheduler
   invocation; no cron entry exists.
8. **`system_config.schema_version` is `'0005'`** while eight migrations exist, and the
   row's own description says it is "updated by the last migration in a release".
