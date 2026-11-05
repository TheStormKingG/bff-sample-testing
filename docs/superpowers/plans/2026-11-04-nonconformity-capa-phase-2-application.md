# Nonconformity and Corrective Action — Phase 2: the application

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking. Also load **superpowers-plan-extras**.

**Goal:** Make the nonconformity database layer reachable from the application — raise one, work
it, verify it and close it, from a phone in the mill.

**Architecture:** The database layer landed in migrations 0048–0052 with eight RPCs and no caller.
This adds the three layers above it, in the shape this codebase already uses for every other
mutation: an action vocabulary in `_shared/actions.ts`, eight `MutationSpec`s in
`_shared/handlers/nonconformity.ts`, one router function `nonconformity-action`, and on the client
two read hooks, one mutation hook, a second tab on Flagged and a detail page at `/nc/:id`. One
thing has to be fixed before any of it is usable: the edge's Postgres-error mapper knows five
`BFF_` prefixes and none of the twenty the NC RPCs raise, so today every gate refusal would reach
the operator as an HTTP 500 with the word "internal" — and spec §9 makes the refusal's wording the
feature.

**Tech Stack:** React 18.3.1, TypeScript strict, Vite 6, Tailwind 3.4.17, HashRouter on
`/FeedQualityApp/`, @tanstack/react-query, vitest 2.1.8 + jsdom, Playwright, Supabase (PostgreSQL
17 + Deno 2.8.0 Edge Functions).

---

## Scope: why this is one of three plans, not one plan

Spec §10 sets the build order and it is not negotiable here:

> 1. Schema, RPCs and probes. No UI. — **done (phase 1)**
> 2. Read screens.
> 3. Raise, act and close flows, including attachments.
> 4. The hold → nonconformity hook, last.
>
> "Step 4 changes a live safety path. It goes in only once the machinery it depends on is proven,
> not while that machinery is still moving."

**This plan is steps 2 and 3 minus attachments.** Steps 2 and 3 are deliberately fused: a read
screen on its own would show an empty list for ever, because there is no way to create a
nonconformity from the application at all — there is no Edge handler. The first increment worth
shipping is therefore "raise, see, work, close".

**Attachments are a separate plan** because they are a separate subsystem with their own security
surface, and nothing for them exists: no `nc_attachments` table (0048 creates only
`nonconformities`, `nc_actions` and `nc_number_sequence`), and **no Supabase Storage usage anywhere
in this repository** — no bucket, no `storage.objects` policy, no `storage.` reference in any
migration, no upload code, no file input, no `FormData`. That is a from-scratch build, not a
feature of this one.

**The hold hook is a separate plan** because spec §7 requires `rpc_raise_hold` to create the
nonconformity in the same transaction, and `rpc_raise_nonconformity` has **no `p_hold_id`
parameter** and does not list `hold_id` in its INSERT, so no existing write path can set it. It
also edits the mill's most safety-critical function.

---

## What already exists, verified, so no task re-does it

Each of these was read, not recalled. A plan that names a file is making a claim about the code,
and these are the claims this plan rests on.

| Thing | State | Where |
| --- | --- | --- |
| Eight NC RPCs | Deployed and proved | `supabase/migrations/0051_*.sql`, `0052_*.sql` |
| `nc.raise` / `nc.act` / `nc.close` | In the enum, in `role_permissions`, in `src/lib/roles.ts`, agreement gated | `tests/permissionCatalogueContract.test.ts` |
| RPC names + typed argument interfaces | Already in `supabase/functions/_shared/rpc.ts` (lines ~112–115 in the map, interfaces from ~line 800) | gated by `tests/rpcContract.test.ts` |
| Read RLS policies | `nonconformities_select_viewers`, `nc_actions_select_viewers`, both on `sample.view` | `0050_nonconformity_rls.sql:42-45` |
| `SELECT` grant to `authenticated` | Granted | `0052_nonconformity_review_fixes.sql` |
| `RequirePermission` | Exists | `src/components/layout/RequirePermission.tsx` |
| Behavioural verifier | `npm run verify:nc-lifecycle` | `scripts/verify-nc-lifecycle.sql` |

**And what does not exist.** No `supabase/functions/nonconformity-action/`, no
`_shared/handlers/nonconformity.ts`, no `NC_ACTIONS` in `_shared/actions.ts`, no `ncAction` in
`FUNCTIONS`, no NC entry in `TABLES`, no `src/hooks/useNonconformities.ts`, no page, no route, no
nav entry. A case-insensitive grep for "nonconformit" across `src/` returns exactly one hit: a
prose comment at `src/lib/roles.ts:73`.

---

## Three findings that change what the tasks have to be

### 1. Every NC refusal is currently an HTTP 500

`mapPostgresError` (`supabase/functions/_shared/adapters/mutation.ts:226-257`) classifies a thrown
Postgres error by matching one of exactly five prefixes — `BFF_REVISION_CONFLICT`, `BFF_NOT_FOUND`,
`BFF_FORBIDDEN`, `BFF_SEPARATION_OF_DUTIES`, `BFF_TRANSITION_NOT_ALLOWED` — and otherwise returns
`new ApiError('internal', { internalDetail: ... })`.

The NC RPCs raise none of those. They raise `BFF_NC_GATE_UNMET`, `BFF_STALE_REVISION`,
`BFF_NC_NOT_OPEN`, `BFF_NC_FROZEN`, `BFF_NC_TERMINAL`, `BFF_UNKNOWN_NONCONFORMITY`,
`BFF_UNKNOWN_ACTION`, `BFF_UNKNOWN_SAMPLE`, `BFF_UNKNOWN_ASSIGNEE`, `BFF_TITLE_REQUIRED`,
`BFF_DESCRIPTION_REQUIRED`, `BFF_ACTION_DESCRIPTION_REQUIRED`, `BFF_DUE_DATE_REQUIRED`,
`BFF_COMPLETION_NOTE_REQUIRED`, `BFF_VERIFICATION_NOTE_REQUIRED`, `BFF_VOID_REASON_REQUIRED`,
`BFF_REASON_REQUIRED`, `BFF_ACTION_ALREADY_COMPLETE`, `BFF_NC_NOT_AWAITING_VERIFICATION` and
`BFF_NOT_AUTHORISED` (the last from `require_permission`).

`internalDetail` is **not** sent to the client — `toErrorBody`
(`supabase/functions/_shared/errors.ts:153-170`) returns only `code`, `message`, `correlationId`
and `details`. So the operator would see the generic internal-error sentence, and spec §9's
requirement reads:

> Not "validation failed" but *"Cannot send for verification: corrective action has not been
> evaluated, and 2 of 3 actions are incomplete."* A gate that will not say why is a gate people
> route around.

That text is already written, in the migration, in English, deliberately. It has to reach the
screen. **Task 1 exists to make that happen, and it is first because every later task's error path
depends on it.**

### 2. Only ONE of the eight RPCs takes an expected revision

A reconnaissance pass over this claimed that `rpc_update`, `rpc_close` and `rpc_void` all take
`p_expected_revision`. **That is wrong.** Verified by counting the parameter in the migrations:
`rpc_update_nonconformity` takes it; the other seven do not.

This is correct as built and no task should "fix" it. Closing and voiding are state transitions out
of a named state, and the state check is the concurrency control: `rpc_close_nonconformity` refuses
unless `status = 'awaiting_verification'` and `rpc_void_nonconformity` unless the status is `open`
or `awaiting_verification`, both under `for update`. Two supervisors closing at once means the
second finds `closed` and is refused by name. Adding a revision parameter would add a second,
weaker expression of the same guard. **The client therefore sends `expectedRevision` on the update
call only**, and Task 10 says so explicitly so nobody adds it to the others for symmetry.

### 3. Flagged has no tabs, and there is no shared Tabs component

`src/pages/FlaggedPage.tsx:109-146` is a `role="group"` `aria-label="Filter by what is wrong"` row
of `aria-pressed` buttons — a **filter**, not a tablist. `DashboardPage` hand-rolls
`role="tablist"` / `role="tab"` / `aria-selected`; `AdminPage` hand-rolls `nav`/`ul`/`li` with
`aria-current="page"`; the two use different colour tokens and there is no shared component.

Spec §8 wants Flagged to become `Samples | Nonconformities`. The hazard is specific: the band chips
and a tab row built from the same classes become one indistinguishable strip of six buttons.
Task 7 follows the Dashboard tablist pattern and gives the tab row a visually distinct treatment,
with a test asserting the two rows are separately addressable.

Also note: `PRIMARY_NAV` is pinned at exactly five entries by `tests/primaryNav.test.tsx:61`
(`expect(PRIMARY_NAV).toHaveLength(5)`), and `navItems.ts:29-30` says five is "what fits across the
bottom of a phone". The spec's choice of a tab inside Flagged is what keeps that true. **No task
adds a sixth destination.**

---

## File structure

**Edge (Deno).** Every function in this repo is a single `index.ts` with its logic in
`_shared/handlers/`. There is no `deno.json`, no import map and no `[functions.*]` block in
`supabase/config.toml` for any of the fifteen functions — **do not create any.**

| File | Responsibility |
| --- | --- |
| `supabase/functions/_shared/actions.ts` *(modify)* | `NC_ACTIONS`, `NC_ACTION_PERMISSION`, `NC_ACTION_CLAIM_OPERATION` |
| `supabase/functions/_shared/handlers/nonconformity.ts` *(create)* | The eight `MutationSpec`s |
| `supabase/functions/nonconformity-action/index.ts` *(create)* | Router entrypoint, ~70 lines |
| `supabase/functions/_shared/adapters/mutation.ts` *(modify)* | NC error classification |

**Client.**

| File | Responsibility |
| --- | --- |
| `src/hooks/useSamples.ts` *(modify)* | `TABLES.nonconformities`, `TABLES.ncActions`, `FUNCTIONS.ncAction` |
| `src/lib/ncBands.ts` *(create)* | `ncBandOf`, `isActionOverdue` — pure, no React, no Supabase |
| `src/hooks/useNonconformities.ts` *(create)* | List + detail reads, and the one mutation hook |
| `src/components/nc/NonconformityTable.tsx` *(create)* | The list table and its band chips |
| `src/components/nc/RaiseNonconformityDialog.tsx` *(create)* | The raise form |
| `src/components/nc/NcActionList.tsx` *(create)* | Actions with owners, due dates, complete/reassign |
| `src/pages/NonconformityDetailPage.tsx` *(create)* | `/nc/:id` |
| `src/pages/FlaggedPage.tsx` *(modify)* | The second tab |
| `src/pages/SampleDetailPage.tsx` *(modify)* | Its nonconformities and the raise button |
| `src/App.tsx` *(modify)* | The `nc/:id` route |

`src/lib/ncBands.ts` is separate from the hooks file on purpose: derived logic with a control test
must be importable without pulling in react-query or a Supabase mock, which is the same reason
`flagBandOf`'s tests work.

---

## Spec-coverage map

Every clause of the specification, mapped to a task, an explicit deferral with its destination, or
out-of-scope with a reason. **A clause with no entry is a defect in this plan, not a scope
decision.** The final task re-reads the spec and checks this map against it.

| Spec clause | Entry |
| --- | --- |
| §1 raising, investigating, assigning and tracking actions, verifying before closure | The whole of this plan; §1 is the summary the rest of the spec expands |
| §1 "Explicitly not in this spec": email and push notification | **Out of scope, by the spec itself** — "This application cannot send email at all", a standing application-wide constraint. No task may add a notification, and Task 10 must not imply one when an action is assigned |
| §1 "Explicitly not in this spec": trend dashboards | **Out of scope, by the spec itself** — there are zero records to build against. Deferred to the Dashboard's Reports tab |
| §1 D-09: a setting out of range is a PROCESS nonconformity, not a product one | Task 10 — the classification control must offer `process` and must not default to `product` |
| §2 `nonconformities` table | Phase 1 — migration 0048 |
| §2 `nc_actions` table | Phase 1 — migration 0048 |
| §2 `nc_attachments` table | **Deferred → Plan 3 (attachments)** |
| §2 `nc_number_sequence` | Phase 1 — migration 0048 |
| §2 Storage bucket `nc-attachments` | **Deferred → Plan 3** |
| §3 the state machine | Phase 1 — `tg_nonconformities_guard` |
| §3 gate 1's six preconditions | Phase 1 — `nc_gate_one_unmet` |
| §3 gate 2 stamps verifier/self_verified | Phase 1 — `rpc_close_nonconformity` |
| §3 void from open or awaiting | Phase 1 — `rpc_void_nonconformity` |
| §3 closed is terminal and frozen | Phase 1 — guard + `nc_closed_is_verified` |
| §3 "none needed" is first class | Task 10 (the CA evaluation form) |
| §4 three permissions, three roles | Phase 1 — 0049, 0050, `roles.ts` |
| §4 reading reuses `sample.view` | Task 7, Task 8 (route guard) |
| §4 permission gates what is *offered*; RLS what is *reached* | Task 8 (`useAuthority().allows`) |
| §5 Overdue, never stored | Task 6 (`isActionOverdue`) |
| §5 Band on the Nonconformities tab | Task 6 (`ncBandOf`) |
| §5 severity is a column and a filter, not a band | Task 6, Task 7 |
| §5 `self_verified` computed at closure and stamped | Phase 1; **shown** in Task 11 |
| §6 `NC-{year}-{seq}`, plant-local, zero-padded | Phase 1 — `allocate_nc_number` |
| §6 atomic allocation, proved under concurrency | Phase 1 — `verify-nc-numbering.sh` |
| §7 a hold always raises a nonconformity | **Deferred → Plan 4 (hold hook)** |
| §7 classification and severity left unset | Phase 1 — not arguments to the raise RPC |
| §7 raising a hold stays one action | **Deferred → Plan 4** |
| §8 Flagged gains a second tab | Task 7 |
| §8 chips All · Overdue · Open · Awaiting verification, with counts | Task 7 |
| §8 table columns (number, title, classification, severity, sample, next due, status) | Task 7 |
| §8 NC detail at `/nc/:id`, in work order | Task 8 |
| §8 sections above your permission are visible, not editable | Task 8 |
| §8 three ways in: flagged sample, tab button, hold | Tasks 9 and 12; the hold one **→ Plan 4** |
| §8 sample detail lists its nonconformities | Task 12 |
| §9 gate refusals name what is missing | **Task 1**, asserted again in Task 11 |
| §9 concurrent edits refused, not merged | Task 10 (`expectedRevision` on update only) |
| §9 probe: gates refuse and pass | Phase 1 — `verify-nc-lifecycle.sql` |
| §9 probe: concurrent raises get different numbers | Phase 1 — `verify-nc-numbering.sh` |
| §9 probe: hold creates its NC in one transaction | **Deferred → Plan 4** |
| §9 probe: a closed NC cannot be edited | Phase 1 — section H/I of the verifier |
| §9 derived logic each with a control proving the assertion can fail | Task 6 |
| §9 the new RPCs appear in `tests/rpcContract.test.ts` | Phase 1 — done |
| §9 gate refusal messages asserted by text | Task 1 and Task 11 |
| §10 build order | This plan is steps 2 and 3 minus attachments; see Scope |
| §11 D-09 needs policy ratification | **Out of scope** — a decision for the plant, not code |
| §11 watch whether hold counts fall | **Out of scope** — an operational observation after Plan 4 |
| §11 `self_verified` will mostly be true | Task 11 shows it plainly; no code owes anything else |

### Tasks with no spec clause of their own

Six tasks are not traceable to a clause, and that is correct rather than an omission — the
specification describes a quality process, not this codebase's plumbing. Recorded here so the
enumeration in Task 13 does not read them as unexplained:

| Task | Why it exists |
| --- | --- |
| 1 — the error vocabulary | §9 requires the refusal's wording to reach the operator. Nothing in the spec could know that `mapPostgresError` would discard it. |
| 2 — the action vocabulary | A house requirement of `_shared/actions.ts`: the tables must be total. |
| 3 — the mutation specs | The pipeline every write in this application goes through. |
| 4 — the router endpoint | The same. |
| 5 — tables, function name, read hooks | The client's half of the same pipeline. |
| 9 — the raise dialog | Delivers §8's "Three ways in" and §7's unset-classification rule; cross-referenced above, listed here because the dialog itself is not a clause. |
| 13 — e2e and the spec re-read | §9's verification requirements plus this plan's own coverage check. |

---

## Task 1: make an NC refusal legible to the operator

**Review reference (plan-extras Rule 2):** **spec §9**, first paragraph. Not this plan's code.

**Why first.** Every task after this one has an error path, and until this lands they all end in
the same generic 500. It is also the only task whose absence is invisible in a happy-path demo.

**Files:**
- Modify: `supabase/migrations/` — new file `0053_nc_revision_conflict_message.sql`
- Modify: `supabase/functions/_shared/adapters/mutation.ts:226-257` (`mapPostgresError`)
- Create: `tests/postgresErrorCoverage.test.ts`

### The design decision, stated so the executor does not have to guess

`toErrorBody`'s own comment says "a driver-level string or a Postgres error text can never become
the operator-visible message". Task 1 makes a **narrow, allow-listed exception** to that, and the
reasoning must survive in the code:

- The general rule exists because driver text leaks schema details and reads as gibberish.
- The NC gate messages are not driver text. They are prose written in the migration, addressed to
  the person at the mill, and spec §9 makes the wording the feature.
- So the exception is keyed on an **explicit list of prefixes** whose text is authored for a
  reader. Everything else still collapses to `internal`. A new `BFF_` name added later is
  unmapped — and Task 1's test fails until somebody classifies it.

`BFF_STALE_REVISION` is handled differently: the edge already has a `revision_conflict` code whose
mapper parses `current_revision=(\d+)` out of the message. Rather than add a second revision
concept, migration 0053 adds that token to the RPC's message. The human sentence stays.

- [ ] **Step 1: Write the failing coverage test**

Create `tests/postgresErrorCoverage.test.ts`:

```ts
/**
 * Every BFF_ error a migration raises must be CLASSIFIED by the edge.
 *
 * `mapPostgresError` matches a closed set of prefixes and returns
 * `ApiError('internal')` for anything else. `internalDetail` is not sent to
 * the client, so an unclassified refusal reaches the operator as the generic
 * internal-error sentence — indistinguishable from a crash.
 *
 * That is what the eight nonconformity RPCs did on the day they shipped:
 * twenty distinct, carefully worded refusals, every one of them a 500.
 *
 * This test enumerates both sides. A new BFF_ name is either mapped, or listed
 * in UNMAPPED_BY_DESIGN with a reason — and the list is checked too, so a name
 * cannot be parked there after it stops existing.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const REPO = process.cwd();
const MIGRATIONS_DIR = join(REPO, 'supabase/migrations');
const MAPPER = join(REPO, 'supabase/functions/_shared/adapters/mutation.ts');

/**
 * Raised deliberately and deliberately NOT classified, with the reason.
 *
 * `BFF_NOT_AUTHORISED` comes from `require_permission`, which the RPCs call as
 * a second line of defence. `runMutation` authorises against the same
 * permission BEFORE calling the RPC and returns `forbidden` itself, so this
 * one firing means the two disagree — a bug, not a refusal to explain to a
 * user. It stays `internal` on purpose, and loudly.
 */
const UNMAPPED_BY_DESIGN: Readonly<Record<string, string>> = {
  BFF_NOT_AUTHORISED:
    'the edge authorises before the call, so this firing is an edge/SQL disagreement, not a user-facing refusal',
  BFF_IDEMPOTENCY_CONFLICT:
    'handled by the idempotency registry before mapPostgresError is reached',
};

function migrationSql(): string {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => readFileSync(join(MIGRATIONS_DIR, f), 'utf8'))
    .join('\n');
}

/** Every `BFF_NAME` that appears inside a `raise exception` in the corpus. */
function raisedNames(): Set<string> {
  const sql = migrationSql();
  const names = new Set<string>();
  // `raise exception 'BFF_X: ...'` and `raise exception\n  'BFF_X: ...'`.
  for (const m of sql.matchAll(/raise\s+exception\s*\n?\s*'(BFF_[A-Z0-9_]+)/gi)) {
    names.add(m[1]!.toUpperCase());
  }
  // The format(...) form, used where the message interpolates.
  for (const m of sql.matchAll(/raise\s+exception\s*\n?\s*format\(\s*'(BFF_[A-Z0-9_]+)/gi)) {
    names.add(m[1]!.toUpperCase());
  }
  return names;
}

const RAISED = raisedNames();
const MAPPER_SRC = readFileSync(MAPPER, 'utf8');

describe('the instrument', () => {
  it('found the BFF_ names in the migrations', () => {
    // Without this the whole suite passes against a broken regex.
    expect(RAISED.size).toBeGreaterThan(20);
    expect(RAISED.has('BFF_NC_GATE_UNMET')).toBe(true);
  });

  it('read the mapper', () => {
    expect(MAPPER_SRC).toContain('export function mapPostgresError');
  });
});

describe('every raised BFF_ error is classified', () => {
  it('leaves none of them to collapse to a generic internal error', () => {
    const unclassified = [...RAISED]
      .filter((name) => !MAPPER_SRC.includes(name) && !(name in UNMAPPED_BY_DESIGN))
      .sort();
    expect(
      unclassified,
      `${unclassified.length} refusal(s) reach the operator as "internal", losing their wording:\n  ` +
        unclassified.join('\n  '),
    ).toEqual([]);
  });

  it('parks nothing in UNMAPPED_BY_DESIGN that no migration raises', () => {
    const stale = Object.keys(UNMAPPED_BY_DESIGN).filter((n) => !RAISED.has(n)).sort();
    expect(stale, `listed as deliberately unmapped but never raised: ${stale.join(', ')}`).toEqual(
      [],
    );
  });

  it('gives a reason for each one left unmapped', () => {
    for (const [name, reason] of Object.entries(UNMAPPED_BY_DESIGN)) {
      expect(reason.length, `${name} has no reason`).toBeGreaterThan(30);
    }
  });
});
```

- [ ] **Step 2: Run it and watch it fail, for the right reason**

Run: `npx vitest run tests/postgresErrorCoverage.test.ts`

Expected: the instrument tests PASS, and
`every raised BFF_ error is classified > leaves none of them to collapse to a generic internal error`
FAILS, listing roughly eighteen `BFF_NC_*`, `BFF_UNKNOWN_*` and `BFF_*_REQUIRED` names.

**If the instrument tests fail instead, stop.** The regex did not find the names and the real
assertion is vacuous. Fix the regex before going on — an empty result here is a claim about the
test, not about the mapper.

- [ ] **Step 3: Add the `current_revision` token to the stale-revision message**

Create `supabase/migrations/0053_nc_revision_conflict_message.sql`:

```sql
-- ===========================================================================
-- 0053 — one word, so a stale NC edit is a 409 and not a 500.
--
-- `mapPostgresError` classifies a revision conflict by matching
-- `BFF_REVISION_CONFLICT` and parsing `current_revision=(\d+)` out of the
-- message, which is how the client knows what to reload to. The NC update RPC
-- raised `BFF_STALE_REVISION` with the figures in prose, so it matched
-- nothing and reached the operator as an internal error.
--
-- The name changes to the one the edge already knows and the token is added.
-- The human sentence stays, because it is the half the person reads.
-- ===========================================================================
create or replace function public.rpc_update_nonconformity(
  p_actor uuid,
  p_idempotency_key text,
  p_payload_hash text,
  p_app_version text,
  p_nc_id uuid,
  p_expected_revision integer,
  p_classification text,
  p_severity text,
  p_correction text,
  p_root_cause text,
  p_root_cause_method text,
  p_five_whys text[],
  p_ca_required boolean,
  p_ca_rationale text
)
returns table (nonconformity_id uuid, revision integer, recorded_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_basis text;
  v_nc    public.nonconformities;
  v_now   timestamptz := now();
begin
  v_basis := public.require_permission(p_actor, 'nc.act');
  perform public.claim_mutation(p_idempotency_key, 'update_nonconformity', p_actor, p_payload_hash);

  select * into v_nc from public.nonconformities where id = p_nc_id for update;
  if v_nc.id is null then
    raise exception 'BFF_UNKNOWN_NONCONFORMITY: no nonconformity %', p_nc_id using errcode = '23503';
  end if;
  if v_nc.status <> 'open' then
    raise exception
      'BFF_NC_NOT_OPEN: % is %. A nonconformity is editable while it is open; everything this changes is a precondition of the gate it has already passed.',
      v_nc.nc_number, v_nc.status using errcode = '23514';
  end if;
  if v_nc.revision is distinct from p_expected_revision then
    raise exception
      'BFF_REVISION_CONFLICT: somebody else saved nonconformity % while this was open (current_revision=%, yours=%). Reload and re-apply your changes.',
      v_nc.nc_number, v_nc.revision, p_expected_revision using errcode = '40001';
  end if;

  update public.nonconformities
     set classification    = coalesce(p_classification::public.nc_classification, classification),
         severity          = coalesce(p_severity::public.nc_severity, severity),
         correction        = coalesce(nullif(btrim(p_correction), ''), correction),
         root_cause        = coalesce(nullif(btrim(p_root_cause), ''), root_cause),
         root_cause_method = coalesce(p_root_cause_method::public.nc_rc_method, root_cause_method),
         five_whys         = coalesce(p_five_whys, five_whys),
         ca_required       = coalesce(p_ca_required, ca_required),
         ca_rationale      = coalesce(nullif(btrim(p_ca_rationale), ''), ca_rationale),
         revision          = revision + 1
   where id = p_nc_id;

  perform public.record_audit_event(
    p_action             => 'nonconformity.updated',
    p_entity_type        => 'nonconformity',
    p_entity_id          => p_nc_id::text,
    p_sample_uuid        => v_nc.sample_uuid,
    p_reason             => 'Investigation fields updated',
    p_before             => jsonb_build_object('revision', v_nc.revision),
    p_after              => jsonb_build_object('revision', v_nc.revision + 1),
    p_outcome            => 'succeeded',
    p_authority_basis    => v_basis,
    p_actor_id           => p_actor,
    p_deployment_version => p_app_version
  );
  perform public.mark_mutation_committed(p_idempotency_key, v_nc.sample_uuid);

  return query select n.id, n.revision, v_now from public.nonconformities n where n.id = p_nc_id;
end $$;

revoke all on function public.rpc_update_nonconformity(uuid, text, text, text, uuid, integer, text, text, text, text, text, text[], boolean, text)
  from public, anon, authenticated;

select public.assert_function_privileges();
```

**Note for the executor:** `create or replace` is permitted here only because the `returns` clause
is byte-identical to the one in 0052 — that is the rule `tests/rpcContract.test.ts` enforces
("redefines an rpc_* name only after explicitly dropping it, or in place"). Change a single
character of the `returns table (...)` line and the test fails, correctly.

- [ ] **Step 4: Update the verifier, which asserts the old name**

`scripts/verify-nc-lifecycle.sql` section G asserts `sqlerrm not like '%BFF_STALE_REVISION%'`
twice (the G2 and G4 handlers). Change both to `'%BFF_REVISION_CONFLICT%'`, and add to the G1
handler an assertion that the token is present, because the client parses it:

```sql
      if sqlerrm not like '%current_revision=%' then
        raise exception
          'BFF_NCV_G6: the refusal carries no current_revision= token, so the client cannot say what to reload: %',
          sqlerrm using errcode = '22023';
      end if;
```

- [ ] **Step 5: Apply 0053 and run the verifier**

```bash
scripts/run-sql.py < supabase/migrations/0053_nc_revision_conflict_message.sql
npm run verify:nc-lifecycle
```

Expected: both silent. The verifier is silent on success and raises on failure, so a zero exit IS
the result.

- [ ] **Step 6: Classify the NC errors in the mapper**

In `supabase/functions/_shared/adapters/mutation.ts`, insert this block inside
`mapPostgresError`, **after** the five existing prefix checks and **before** the `PGRST202` check:

```ts
  // -------------------------------------------------------------------------
  // The nonconformity refusals, whose wording IS the feature (spec §9).
  //
  // `toErrorBody` says a Postgres error text must never become the
  // operator-visible message, and it is right about driver text. These are not
  // driver text: they are prose written in migrations 0051-0053, addressed to
  // the person at the mill, and a gate that will not say what is missing is a
  // gate people route around.
  //
  // So the exception is ALLOW-LISTED, never general. A name not on a list
  // below still collapses to `internal`, and
  // `tests/postgresErrorCoverage.test.ts` fails until somebody classifies it.
  // -------------------------------------------------------------------------

  /** Refusals whose own sentence is shown to the operator, prefix stripped. */
  const NC_SPOKEN: readonly string[] = [
    'BFF_NC_GATE_UNMET',
    'BFF_NC_NOT_OPEN',
    'BFF_NC_FROZEN',
    'BFF_NC_TERMINAL',
    'BFF_NC_NOT_AWAITING_VERIFICATION',
    'BFF_ACTION_ALREADY_COMPLETE',
    'BFF_TITLE_REQUIRED',
    'BFF_DESCRIPTION_REQUIRED',
    'BFF_ACTION_DESCRIPTION_REQUIRED',
    'BFF_DUE_DATE_REQUIRED',
    'BFF_COMPLETION_NOTE_REQUIRED',
    'BFF_VERIFICATION_NOTE_REQUIRED',
    'BFF_VOID_REASON_REQUIRED',
    'BFF_REASON_REQUIRED',
  ];

  /** Refusals that mean "the thing you named is not there." */
  const NC_NOT_FOUND: readonly string[] = [
    'BFF_UNKNOWN_NONCONFORMITY',
    'BFF_UNKNOWN_ACTION',
    'BFF_UNKNOWN_SAMPLE',
    'BFF_UNKNOWN_ASSIGNEE',
  ];

  for (const prefix of NC_SPOKEN) {
    if (message.includes(prefix)) {
      // Everything after "PREFIX: ", which is the sentence. The driver wraps
      // the message with its own context lines, so cut at the first newline.
      const spoken = message.slice(message.indexOf(prefix) + prefix.length + 2).split('\n')[0]!;
      return new ApiError('validation_failed', {
        message: spoken.trim(),
        internalDetail: `${name}: ${message}`,
      });
    }
  }
  for (const prefix of NC_NOT_FOUND) {
    if (message.includes(prefix)) {
      return new ApiError('not_found', { internalDetail: `${name}: ${message}` });
    }
  }
```

- [ ] **Step 7: Run the coverage test, the Edge gates and the whole suite**

```bash
npx vitest run tests/postgresErrorCoverage.test.ts
npm run typecheck:functions && npm run lint:functions
npm test
```

Expected: the coverage test passes; both Edge gates pass; the full suite passes.

- [ ] **Step 8: Mutation-test the mapper, and check WHICH assertion catches it**

Remove `'BFF_NC_GATE_UNMET'` from `NC_SPOKEN` and re-run
`npx vitest run tests/postgresErrorCoverage.test.ts`.

Expected: `leaves none of them to collapse to a generic internal error` fails, naming
`BFF_NC_GATE_UNMET`.

**Read which assertion failed.** If an instrument test failed instead, the mutation proved nothing
about the coverage assertion — pick a different mutation. Restore the entry and confirm green.

- [ ] **Step 9: Commit**

```bash
git add supabase/migrations/0053_nc_revision_conflict_message.sql \
        supabase/functions/_shared/adapters/mutation.ts \
        scripts/verify-nc-lifecycle.sql \
        tests/postgresErrorCoverage.test.ts
git commit -m "Let an NC refusal say what is missing instead of 500"
```

---

## Task 2: the action vocabulary

**Review reference:** **spec §4**'s permission table, and
`supabase/functions/_shared/actions.ts`'s own header, which requires the tables be TOTAL with no
default branch.

**Files:**
- Modify: `supabase/functions/_shared/actions.ts` (append a new section, after `sync-action`)

- [ ] **Step 1: Add the vocabulary**

Append to `supabase/functions/_shared/actions.ts`, before the `Parsing` section:

```ts
// ---------------------------------------------------------------------------
// nonconformity-action
// ---------------------------------------------------------------------------

/**
 * `NcActionKind` in `src/hooks/useNonconformities.ts`.
 *
 * Unlike the four vocabularies above, this one is NOT read off an existing
 * caller — there is no caller yet. It is read off the RPCs instead, which is
 * the only other source of truth available: eight write paths in migrations
 * 0051-0053, each with its own permission check. The names are the RPC names
 * minus the `rpc_` prefix, so the two sides are legible side by side.
 *
 * `reassign_action` is spelled differently from its RPC (`rpc_reassign_nc_action`)
 * because the `nc_` infix is redundant inside a vocabulary that is entirely
 * about nonconformities, and `NC_ACTION_CLAIM_OPERATION` below carries the
 * mapping. That map is the contract with the SQL, not a convenience.
 */
export const NC_ACTIONS = [
  'raise',
  'update',
  'add_action',
  'complete_action',
  'reassign_action',
  'submit_for_verification',
  'close',
  'void',
] as const;
export type NcAction = (typeof NC_ACTIONS)[number];

/**
 * Spec §4, exactly.
 *
 * `raise` is `nc.raise`, which an OPERATOR holds — they already hold
 * `hold.raise`, and a hold will create a nonconformity (§7), so they must be
 * able to raise what their own action creates.
 *
 * `submit_for_verification` is `nc.act` and not `nc.close`. Sending work for
 * checking is the last act of doing it, not the first act of verifying it; the
 * officer who investigated says "I am finished", and the supervisor decides
 * whether that is true. Putting it under `nc.close` would mean an officer
 * could never hand work over.
 *
 * `void` is `nc.close`. Voiding is a decision that a quality record should not
 * exist, which is a bigger claim than closing one, not a smaller one.
 *
 * An ADMINISTRATOR is refused all eight: the role holds no `nc.*` permission
 * (`0050_nonconformity_rls.sql` asserts it, and
 * `tests/permissionCatalogueContract.test.ts` re-asserts it against
 * `src/lib/roles.ts`), and there is no branch here that could except it.
 */
export const NC_ACTION_PERMISSION: Readonly<Record<NcAction, Permission>> = {
  raise: 'nc.raise',
  update: 'nc.act',
  add_action: 'nc.act',
  complete_action: 'nc.act',
  reassign_action: 'nc.act',
  submit_for_verification: 'nc.act',
  close: 'nc.close',
  void: 'nc.close',
};

/**
 * The operation each NC action's RPC hands `claim_mutation`.
 *
 * `runMutation` claims the idempotency key before calling the RPC and the RPC
 * claims the same key again from inside Postgres; `claim_mutation` raises
 * `BFF_IDEMPOTENCY_CONFLICT: operation_mismatch` when the two names differ.
 * Every administrator action in 0015 was refused before doing any work for
 * exactly this reason, which is why these are data checked by a test rather
 * than strings typed twice.
 *
 * Checked against the literals in the migrations by
 * `tests/idempotencyOperationContract.test.ts`.
 */
export const NC_ACTION_CLAIM_OPERATION: Readonly<Record<NcAction, string>> = {
  raise: 'raise_nonconformity',
  update: 'update_nonconformity',
  add_action: 'add_nc_action',
  complete_action: 'complete_nc_action',
  reassign_action: 'reassign_nc_action',
  submit_for_verification: 'submit_nc_for_verification',
  close: 'close_nonconformity',
  void: 'void_nonconformity',
};
```

- [ ] **Step 2: Verify the claim-operation map against the SQL**

```bash
grep -o "claim_mutation(p_idempotency_key, '[a-z_]*'" supabase/migrations/0051_nonconformity_rpcs.sql | sort -u
```

Expected, exactly these eight literals:
`add_nc_action`, `close_nonconformity`, `complete_nc_action`, `raise_nonconformity`,
`reassign_nc_action`, `submit_nc_for_verification`, `update_nonconformity`, `void_nonconformity`.

Compare against `NC_ACTION_CLAIM_OPERATION`'s values. They must match as a set.

- [ ] **Step 3: Run the contract tests and the Edge gates**

```bash
npx vitest run tests/idempotencyOperationContract.test.ts
npm run typecheck:functions && npm run lint:functions
```

Expected: pass. `idempotencyOperationContract` discovers specs by scanning, so it will not see
these until Task 3 wires them into a spec — that is expected and is why Task 3 re-runs it.

- [ ] **Step 4: Prove the TOTAL table is really total**

Temporarily add `'escalate'` to `NC_ACTIONS` and run `npm run typecheck:functions`.

Expected: FAIL — `NC_ACTION_PERMISSION` and `NC_ACTION_CLAIM_OPERATION` no longer satisfy
`Record<NcAction, …>`. This is the check that stops an unclassified action reaching a permissive
default. Remove `'escalate'` and confirm it type-checks again.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/actions.ts
git commit -m "The nonconformity action vocabulary, read off the RPCs"
```

---

## Task 3: the eight mutation specs

**Review reference:** `supabase/migrations/0051_nonconformity_rpcs.sql` and `0053` for the
parameter lists; `supabase/functions/_shared/rpc.ts` for the typed argument interfaces (already
written); `supabase/functions/_shared/handlers/hold.ts` for the house idiom.

**Files:**
- Create: `supabase/functions/_shared/handlers/nonconformity.ts`

Pass `args` typed as the `rpc.ts` interface, never as `Record<string, unknown>` — `callTransaction`
takes `args: object` precisely so a misspelt `p_` key is a compile error rather than a PostgREST
404 at the mill.

- [ ] **Step 1: Write the handler module**

Create `supabase/functions/_shared/handlers/nonconformity.ts`:

```ts
/**
 * The eight nonconformity write paths, as the pipeline's own specs.
 *
 * EIGHT SPECS, NOT ONE WITH A FLAG — the same reasoning `hold.ts` records.
 * Raising answers to `nc.raise`, acting to `nc.act` and closing to `nc.close`,
 * and those sit with different roles: an operator can raise a nonconformity
 * and cannot investigate one; an officer can investigate and cannot close.
 * One entry point taking the act as data would make the permission check
 * depend on a body field.
 *
 * WHAT IS NOT HERE. No authority logic: `runMutation` authorises against the
 * permission on the selected spec before any work begins and audits the
 * denial. No validation that the RPC already does: the database refuses a
 * blank title, a blank completion note and a blank void reason by name, with
 * wording written for the person reading it (spec §9), and
 * `mapPostgresError` now carries that wording to the screen. A second copy
 * here would be a second wording to drift.
 *
 * What IS here is the shape of the request: which body fields each act reads,
 * and the typed argument object. A missing required field is caught here, by
 * `readString(..., { required: true })`, because the pipeline's
 * `validation_failed` names the FIELD and a screen can mark it.
 *
 * DENO-ONLY: reached through `adapters/mutation.ts`.
 */

import {
  callTransaction,
  readInteger,
  readString,
  requireExpectedRevision,
  type MutationSpec,
} from '../adapters/mutation.ts';
import { ApiError } from '../errors.ts';
import { recordAudit } from '../adapters/authorize.ts';
import {
  NC_ACTION_CLAIM_OPERATION,
  NC_ACTION_PERMISSION,
  type NcAction,
} from '../actions.ts';
import {
  RPC,
  type AddNcActionArgs,
  type AddNcActionResult,
  type CloseNonconformityArgs,
  type CloseNonconformityResult,
  type CompleteNcActionArgs,
  type CompleteNcActionResult,
  type RaiseNonconformityArgs,
  type RaiseNonconformityResult,
  type ReassignNcActionArgs,
  type ReassignNcActionResult,
  type SubmitNcForVerificationArgs,
  type SubmitNcForVerificationResult,
  type UpdateNonconformityArgs,
  type UpdateNonconformityResult,
  type VoidNonconformityArgs,
  type VoidNonconformityResult,
} from '../rpc.ts';

/** `text[]` or null. A blank line is dropped; the array is not padded. */
function readStringArray(
  body: Record<string, unknown>,
  key: string,
  maxItems: number,
): readonly string[] | null {
  const value = body[key];
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) {
    throw new ApiError('validation_failed', {
      details: { issues: [{ field: key, code: 'not_a_list', message: `${key} must be a list.` }] },
    });
  }
  if (value.length > maxItems) {
    throw new ApiError('validation_failed', {
      details: {
        issues: [{ field: key, code: 'too_many', message: `${key} takes at most ${maxItems}.` }],
      },
    });
  }
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') {
      throw new ApiError('validation_failed', {
        details: {
          issues: [{ field: key, code: 'not_a_string', message: `Every ${key} entry must be text.` }],
        },
      });
    }
    const trimmed = item.trim();
    if (trimmed !== '') out.push(trimmed);
  }
  return out.length === 0 ? null : out;
}

/** One place for the three fields every spec below shares. */
function base(action: NcAction, subjectId: (body: Record<string, unknown>) => string | null) {
  return {
    operation: `nonconformity_action.${action}`,
    claimOperation: NC_ACTION_CLAIM_OPERATION[action],
    permission: NC_ACTION_PERMISSION[action],
    subjectType: 'nonconformity',
    subjectId,
  } as const;
}

const ncId = (body: Record<string, unknown>) =>
  typeof body['ncId'] === 'string' ? body['ncId'] : null;
const actionId = (body: Record<string, unknown>) =>
  typeof body['actionId'] === 'string' ? body['actionId'] : null;

// ---------------------------------------------------------------------------
// raise
// ---------------------------------------------------------------------------

/**
 * `classification` and `severity` are NOT read from the body, because the RPC
 * does not take them. Spec §7: they are required at the first gate, which is
 * the moment somebody is thinking about it, and guessing them at the mill
 * would fill two columns with defaults nobody chose.
 */
export const RAISE_SPEC: MutationSpec<Record<string, unknown>> = {
  // The subject does not exist yet, so the audit event's subject is the sample
  // when there is one. `subjectId` is read before authorisation, so it must
  // not assume a nonconformity id.
  ...base('raise', (body) =>
    typeof body['sampleUuid'] === 'string' ? body['sampleUuid'] : null,
  ),
  subjectType: 'nonconformity',
  run: async ({ actor, admin, body, idempotencyKey, payloadHash, appVersion, markCommitted }) => {
    const title = readString(body, 'title', { required: true, maxLength: 200 })!;
    const description = readString(body, 'description', { required: true, maxLength: 5000 })!;
    const sampleUuid = readString(body, 'sampleUuid');
    const recurrenceOf = readString(body, 'recurrenceOf');

    const args: RaiseNonconformityArgs = {
      p_actor: actor.userId,
      p_idempotency_key: idempotencyKey,
      p_payload_hash: payloadHash,
      p_app_version: appVersion,
      p_title: title,
      p_description: description,
      p_sample_uuid: sampleUuid,
      p_recurrence_of: recurrenceOf,
    };

    const result = await callTransaction<RaiseNonconformityResult>(
      admin,
      RPC.raiseNonconformity,
      args,
    );

    /** COMMIT POINT. A throw past here is a reply that could not be built. */
    markCommitted({
      ok: true,
      action: 'raise',
      nonconformityId: result.nonconformity_id,
      ncNumber: result.nc_number,
      status: result.status,
      recordedAt: result.recorded_at,
    });

    await recordAudit({
      actorId: actor.userId,
      action: 'nonconformity_action.raise',
      subjectType: 'nonconformity',
      subjectId: result.nonconformity_id,
      outcome: 'allowed',
      reason: description,
      after: { nc_number: result.nc_number, sample_uuid: sampleUuid },
      appVersion,
    });

    return {
      ok: true,
      action: 'raise',
      nonconformityId: result.nonconformity_id,
      ncNumber: result.nc_number,
      status: result.status,
      recordedAt: result.recorded_at,
      message: `${result.nc_number} has been raised.`,
    };
  },
};
```

**The remaining seven specs follow the same five parts** — read the body, build the typed args,
`callTransaction`, `markCommitted`, `recordAudit`, return. Write them out in full in the same file.
Their body fields and argument objects, exactly:

| Action | Body fields read | Args interface | RPC |
| --- | --- | --- | --- |
| `update` | `ncId`*, `expectedRevision`* (via `requireExpectedRevision`), `classification`, `severity`, `correction`, `rootCause`, `rootCauseMethod`, `fiveWhys` (list, max 10), `caRequired` (boolean or null), `caRationale` | `UpdateNonconformityArgs` | `RPC.updateNonconformity` |
| `add_action` | `ncId`*, `description`*, `assignedTo`*, `dueDate`* | `AddNcActionArgs` | `RPC.addNcAction` |
| `complete_action` | `actionId`*, `completionNote`* | `CompleteNcActionArgs` | `RPC.completeNcAction` |
| `reassign_action` | `actionId`*, `assignedTo`*, `reason`* | `ReassignNcActionArgs` | `RPC.reassignNcAction` |
| `submit_for_verification` | `ncId`* | `SubmitNcForVerificationArgs` | `RPC.submitNcForVerification` |
| `close` | `ncId`*, `verificationNote`* | `CloseNonconformityArgs` | `RPC.closeNonconformity` |
| `void` | `ncId`*, `voidReason`* | `VoidNonconformityArgs` | `RPC.voidNonconformity` |

(* = `{ required: true }`.)

**`expectedRevision` is read on `update` and on NOTHING else.** The other seven RPCs do not take
it; see "Three findings" above. `caRequired` must be read as a tri-state — `true`, `false` or
absent — because null means "not yet evaluated" and `false` means "evaluated, none needed", and
spec §3 treats them as different facts. Read it as:

```ts
    const caRequiredRaw = body['caRequired'];
    const caRequired =
      caRequiredRaw === undefined || caRequiredRaw === null
        ? null
        : typeof caRequiredRaw === 'boolean'
          ? caRequiredRaw
          : (() => {
              throw new ApiError('validation_failed', {
                details: {
                  issues: [
                    {
                      field: 'caRequired',
                      code: 'not_a_boolean',
                      message:
                        'Whether corrective action is needed must be yes or no. Leaving it unanswered is a third, different answer and is sent as absent.',
                    },
                  ],
                },
              });
            })();
```

- [ ] **Step 2: Type-check and lint under Deno**

```bash
npm run typecheck:functions && npm run lint:functions
```

Expected: `All 54 Edge Function modules type-check.` becomes 55, and lint passes. Every relative
import must carry its `.ts` extension — `node scripts/check-shared-module-imports.mjs` enforces it.

- [ ] **Step 3: Prove a misspelt argument is a compile error**

Change `p_verification_note` to `p_verification_notes` in the close spec and run
`npm run typecheck:functions`.

Expected: FAIL, naming the property. This is why `args` is typed rather than
`Record<string, unknown>`; without it the mistake is a PostgREST 404 discovered by an operator.
Restore it.

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/_shared/handlers/nonconformity.ts
git commit -m "Eight nonconformity mutation specs, validating shape and nothing more"
```

---

## Task 4: the router endpoint

**Review reference:** `supabase/functions/sample-action/index.ts`, which is the shape to copy.

**Files:**
- Create: `supabase/functions/nonconformity-action/index.ts`

Do **not** create a `deno.json`, an import map, or a `[functions.nonconformity-action]` block in
`supabase/config.toml`. None of the fifteen existing functions has any of those, and this one needs
JWT verification, which is the default.

- [ ] **Step 1: Write the entrypoint**

Create `supabase/functions/nonconformity-action/index.ts`:

```ts
/**
 * POST /nonconformity-action — the eight nonconformity decisions.
 *
 * A route table and nothing else. Each action maps to a spec in
 * `_shared/handlers/nonconformity.ts`; no authority logic is restated here, so
 * there is no second copy of a permission rule to drift from the first.
 *
 * AUTHORITY IS NOT DECIDED HERE. `runMutation` authorises before the work
 * begins, using the permission on the selected spec, and audits the denial
 * (FR-002). An ADMINISTRATOR is refused all eight: the role holds no `nc.*`
 * permission and there is no branch here that could make an exception.
 *
 * Unlike `sample-action`, this endpoint is NOT replacing a broken call — no
 * client has ever called it. It is a router rather than eight endpoints
 * because the detail screen performs several of these acts and one function
 * name means one deployment, one CORS surface and one idempotency registry
 * entry shape to reason about.
 */

import { ApiError } from '../_shared/errors.ts';
import { serveFunction, type RequestContext } from '../_shared/adapters/http.ts';
import { runMutation, type MutationSpec } from '../_shared/adapters/mutation.ts';
import { parseAction, NC_ACTIONS, type NcAction } from '../_shared/actions.ts';
import {
  ADD_ACTION_SPEC,
  CLOSE_SPEC,
  COMPLETE_ACTION_SPEC,
  RAISE_SPEC,
  REASSIGN_ACTION_SPEC,
  SUBMIT_FOR_VERIFICATION_SPEC,
  UPDATE_SPEC,
  VOID_SPEC,
} from '../_shared/handlers/nonconformity.ts';

/**
 * Action -> spec. Total over `NcAction`, with no default branch, so a new
 * action cannot compile until it is given a spec.
 */
function specFor(action: NcAction): MutationSpec<Record<string, unknown>> {
  switch (action) {
    case 'raise':
      return RAISE_SPEC;
    case 'update':
      return UPDATE_SPEC;
    case 'add_action':
      return ADD_ACTION_SPEC;
    case 'complete_action':
      return COMPLETE_ACTION_SPEC;
    case 'reassign_action':
      return REASSIGN_ACTION_SPEC;
    case 'submit_for_verification':
      return SUBMIT_FOR_VERIFICATION_SPEC;
    case 'close':
      return CLOSE_SPEC;
    case 'void':
      return VOID_SPEC;
  }
}

async function handler(ctx: RequestContext): Promise<Response> {
  return await runMutation(ctx, (body) => {
    const action = parseAction(body['action'], NC_ACTIONS);
    if (action === null) {
      // Thrown before the idempotency key is claimed, so a malformed request
      // does not consume one.
      throw new ApiError('bad_request', {
        message: 'An unknown nonconformity action was requested.',
        details: { field: 'action', allowed: NC_ACTIONS },
      });
    }
    return specFor(action);
  });
}

serveFunction({ name: 'nonconformity-action', methods: ['POST'] }, handler);
```

- [ ] **Step 2: Run every Edge and contract gate**

```bash
npm run verify:functions
npx vitest run tests/idempotencyOperationContract.test.ts tests/rpcContract.test.ts tests/payloadSecrets.test.ts
npm test
```

Expected: all pass. `rpcContract`'s "does not define an rpc_* function nothing calls" is now
satisfied by real callers rather than by the map entries alone.

- [ ] **Step 3: Deploy the function and call it once, expecting a NAMED refusal**

```bash
npx supabase functions deploy nonconformity-action --project-ref ydvgxsbymnnidenkrvin
```

Then, signed in as a quality officer in the browser console (an officer holds `nc.act` and NOT
`nc.close`, which is the control):

```js
const { data: { session } } = await window.__supabase.auth.getSession();
const r = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/nonconformity-action`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    authorization: `Bearer ${session.access_token}`,
    'idempotency-key': crypto.randomUUID(),
  },
  body: JSON.stringify({ action: 'close', ncId: '00000000-0000-0000-0000-000000000000', verificationNote: 'x' }),
});
console.log(r.status, await r.json());
```

Expected: **403** with `code: 'forbidden'` — refused by the edge on the permission, before the RPC
is reached. Not 500, and not 404.

Then repeat as a supervisor with the same all-zero id. Expected: **404** with `code: 'not_found'` —
`BFF_UNKNOWN_NONCONFORMITY`, now classified by Task 1. Seeing a 500 here means Task 1's mapper
block is not deployed.

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/nonconformity-action/index.ts
git commit -m "One endpoint for the eight nonconformity decisions"
```

---

## Task 5: the client's table names, function name and read hooks

**Review reference:** `scripts/check-frontend-schema.py` for the five constraints it imposes, and
`src/hooks/useSamples.ts` for `TABLES`, `FUNCTIONS` and the column-constant idiom.

**Files:**
- Modify: `src/hooks/useSamples.ts` (`TABLES`, `FUNCTIONS`)
- Create: `src/hooks/useNonconformities.ts`

`TABLES` and `FUNCTIONS` both live in `src/hooks/useSamples.ts` — a 1318-line module about
samples. That is the convention; this plan follows it rather than starting a second registry,
because `scripts/check-frontend-schema.py`'s `TABLE_ALIAS` regex is anchored on that file.

**The five things the schema gate requires** (it reads source text, so a form it cannot see is a
form it cannot check):
1. a `TABLES` entry is `alias: 'table_name',` **with the trailing comma**, inside the first `}`
   after `TABLES = {`;
2. a `.select()` argument is a single-quoted string literal, or a SCREAMING_SNAKE identifier
   declared as `const NAME = '...'`;
3. a template literal or a double-quoted string is **invisible** to the gate;
4. the constant must be one line;
5. the columns must exist in the migration corpus.

- [ ] **Step 1: Add the table aliases and the function name**

In `src/hooks/useSamples.ts`, inside `TABLES`, after `auditDeadLetters`:

```ts
  nonconformities: 'nonconformities',
  ncActions: 'nc_actions',
```

In `FUNCTIONS`, after `schemaVerify`:

```ts
  /**
   * `raise`, `update`, `add_action`, `complete_action`, `reassign_action`,
   * `submit_for_verification`, `close`, `void`. Authority is the spec's, and
   * an administrator is refused all eight.
   */
  ncAction: 'nonconformity-action',
```

- [ ] **Step 2: Write the failing read-hook test**

Create `tests/nonconformityColumns.test.ts`:

```ts
/**
 * The columns the nonconformity hooks select must exist.
 *
 * The dashboard asked for `collected_at` for months. The column has never
 * existed — it is `collection_instant` — so every figure on that screen was a
 * dash and the error said "counts could not be loaded". Nothing caught it,
 * because a wrong column name is a runtime PostgREST error on one screen.
 *
 * `scripts/check-frontend-schema.py` catches this class now, but it needs a
 * built database, and open decision D-12 means the local check database cannot
 * be rebuilt. This test reads the migrations as text instead, so it runs in CI
 * on every push with no database at all — the same approach
 * `tests/dashboardColumns.test.ts` takes for the same reason.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { NONCONFORMITY_COLUMNS, NC_ACTION_COLUMNS } from '@/hooks/useNonconformities';

const MIGRATIONS = join(process.cwd(), 'supabase/migrations');

function corpus(): string {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => readFileSync(join(MIGRATIONS, f), 'utf8'))
    .join('\n');
}

/** Column names in `create table public.<name> ( ... )`, as declared. */
function columnsOf(table: string, sql: string): Set<string> {
  const m = new RegExp(`create table public\\.${table}\\s*\\(([\\s\\S]*?)\\n\\);`, 'i').exec(sql);
  if (m === null) throw new Error(`no create table for ${table}`);
  const cols = new Set<string>();
  for (const line of m[1]!.split('\n')) {
    const c = /^\s{2}([a-z_][a-z0-9_]*)\s+[a-z]/.exec(line);
    if (c !== null) cols.add(c[1]!);
  }
  // Columns added by a later `alter table ... add column`.
  for (const a of sql.matchAll(
    new RegExp(`alter table (?:only )?public\\.${table}\\s+add column (?:if not exists )?([a-z_]+)`, 'gi'),
  )) {
    cols.add(a[1]!);
  }
  return cols;
}

const SQL = corpus();
const NC = columnsOf('nonconformities', SQL);
const ACTIONS = columnsOf('nc_actions', SQL);

/** The hook's select string -> the bare column names it asks for. */
function asked(select: string): string[] {
  return select
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')
    .map((s) => s.replace(/:.*$/, '').replace(/\(.*$/, '').trim());
}

describe('the instrument', () => {
  it('parsed both tables', () => {
    expect(NC.size).toBeGreaterThan(20);
    expect(ACTIONS.size).toBeGreaterThan(8);
    expect(NC.has('nc_number')).toBe(true);
    expect(ACTIONS.has('due_date')).toBe(true);
  });

  it('would notice a column that does not exist', () => {
    expect(NC.has('collected_at')).toBe(false);
  });
});

describe('every selected column exists', () => {
  it('on nonconformities', () => {
    const missing = asked(NONCONFORMITY_COLUMNS).filter((c) => !NC.has(c));
    expect(missing, `selected but absent from nonconformities: ${missing.join(', ')}`).toEqual([]);
  });

  it('on nc_actions', () => {
    const missing = asked(NC_ACTION_COLUMNS).filter((c) => !ACTIONS.has(c));
    expect(missing, `selected but absent from nc_actions: ${missing.join(', ')}`).toEqual([]);
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `npx vitest run tests/nonconformityColumns.test.ts`

Expected: FAIL at the import — `Failed to resolve import "@/hooks/useNonconformities"`.

- [ ] **Step 4: Write the read hooks**

Create `src/hooks/useNonconformities.ts`. The column constants must be **one line each**, single
quotes, SCREAMING_SNAKE, so `scripts/check-frontend-schema.py` can see them:

```ts
/**
 * Reading nonconformities, and the one hook that writes them.
 *
 * READING IS GATED BY `sample.view`, NOT BY AN NC PERMISSION. There is no
 * `nc.view` — spec §4: "anyone who may read a sample may read a
 * nonconformity, auditors included." The RLS policies
 * `nonconformities_select_viewers` and `nc_actions_select_viewers`
 * (migration 0050) are the enforcement; the route guard is the affordance.
 *
 * WRITING GOES THROUGH THE EDGE. Nothing here calls `rpc(...)` from the
 * browser: the eight RPCs have `EXECUTE` revoked from `authenticated`, and the
 * tables have no write policies at all. A write is a POST to
 * `FUNCTIONS.ncAction` carrying an idempotency key.
 */

import { useCallback, useRef } from 'react';
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';

import { supabase, edgeErrorMessage } from '@/lib/supabase';
import { env } from '@/lib/env';
import { FUNCTIONS, TABLES } from '@/hooks/useSamples';
import { newIdempotencyKey } from '@/hooks/useRegisterSample';

/**
 * The eight acts this hook can post, declared HERE and mirrored by
 * `NC_ACTIONS` in `supabase/functions/_shared/actions.ts`.
 *
 * This direction is the codebase's own: `actions.ts`'s header records that its
 * four other vocabularies "had to be READ OFF THE CALLERS rather than
 * invented", because a router that accepted a tidier set of names would have
 * replaced one broken call with a different broken call. The client is the
 * caller, so the client names the acts. (Task 2 of this plan had to read them
 * off the RPCs instead, because this file did not exist yet — the two must now
 * agree, and `tests/idempotencyOperationContract.test.ts` plus the router's
 * `parseAction` are what make a disagreement loud.)
 *
 * A src file does NOT import from `supabase/functions/**`: the dependency runs
 * the other way (`actions.ts` imports `src/lib/roles.ts`), and
 * `scripts/check-shared-module-imports.mjs` polices the specifiers that cross
 * the boundary.
 */
export type NcActionKind =
  | 'raise'
  | 'update'
  | 'add_action'
  | 'complete_action'
  | 'reassign_action'
  | 'submit_for_verification'
  | 'close'
  | 'void';

/** One line, single quotes, SCREAMING_SNAKE: `check-frontend-schema.py` reads it as text. */
export const NONCONFORMITY_COLUMNS = 'id,nc_number,status,classification,severity,title,description,sample_uuid,hold_id,recurrence_of,detected_by,detected_at,correction,root_cause,root_cause_method,five_whys,ca_required,ca_rationale,verified_by,verified_at,verification_note,self_verified,void_reason,revision,created_at,updated_at' as const;

export const NC_ACTION_COLUMNS = 'id,nc_id,description,assigned_to,due_date,completed_at,completed_by,completion_note,created_by,created_at' as const;
```

Then, in the same file: `useNonconformityList()` selecting `NONCONFORMITY_COLUMNS` from
`TABLES.nonconformities` with its actions, `useNonconformity(id)` for one record plus its
`nc_actions`, and `useNonconformityAction()`.

**The query keys, enumerated** — nothing invalidates automatically:

| Key | Set by | Invalidated by |
| --- | --- | --- |
| `['nonconformities','list']` | `useNonconformityList` | every NC write |
| `['nonconformity', id]` | `useNonconformity` | every NC write naming that id |
| `['sample', sampleUuid]` | existing, `useSampleDetail` | a raise or close carrying a `sampleUuid` |
| `['samples']` | existing | a raise carrying a `sampleUuid` |

The last two matter: a nonconformity raised against a sample changes what the sample screen should
show, and nothing links the two caches.

**The idempotency key must live outside the mutation.** `newIdempotencyKey()` mints a fresh UUID
per call, so a "try again" button that re-enters the mutation creates a SECOND nonconformity —
there is nothing idempotent about raising one. Hold the key in a ref keyed by a fingerprint of the
payload, which is the pattern `StageFormPage` already uses:

```ts
/**
 * One key per distinct act, held across retries.
 *
 * `newIdempotencyKey()` is a fresh UUID per call, so a retry through a new key
 * is a new act: press "try again" after a raise that actually succeeded and
 * the mill has two nonconformities for one problem. The key is therefore
 * derived from WHAT is being done, not from WHEN, and survives for as long as
 * the payload is unchanged.
 *
 * It also throws in an insecure context (`crypto.randomUUID` is unavailable
 * off HTTPS/localhost), which is a deployment fault and not something to
 * paper over with a weaker key.
 */
function useStableIdempotencyKey() {
  const keys = useRef(new Map<string, string>());
  return useCallback((fingerprint: string): string => {
    const held = keys.current.get(fingerprint);
    if (held !== undefined) return held;
    const minted = newIdempotencyKey();
    keys.current.set(fingerprint, minted);
    return minted;
  }, []);
}
```

The fingerprint is `JSON.stringify([action, ncId ?? null, actionId ?? null, payloadFieldsThatMatter])`.
Note that the idempotency key itself is excluded from the Edge's payload hash
(`NON_PAYLOAD_KEYS` in `_shared/hash.ts:124-127`), so sending it in both the header and the body —
as every other hook does — cannot manufacture a conflict; but any **other** field differing between
two sends of the same key raises `idempotency_conflict` (409), which is the behaviour we want.

- [ ] **Step 5: Run the column test, then the gates**

```bash
npx vitest run tests/nonconformityColumns.test.ts
npm run typecheck && npm run lint
```

Expected: pass.

- [ ] **Step 6: Mutation-test the column guard**

Change `nc_number` to `nc_numbers` in `NONCONFORMITY_COLUMNS` and re-run the test.

Expected: `every selected column exists > on nonconformities` fails, naming `nc_numbers`. Confirm
the failure is that assertion and not an instrument one, then restore.

- [ ] **Step 7: Commit**

```bash
git add src/hooks/useSamples.ts src/hooks/useNonconformities.ts tests/nonconformityColumns.test.ts
git commit -m "Read nonconformities, and one guarded way to write them"
```

---

## Task 6: the derived values, with controls

**Review reference:** **spec §5**. Note what it says and what it does not: Overdue and Band are
derived; **severity is a stored column and a filter, not a band.**

**Files:**
- Create: `src/lib/ncBands.ts`
- Create: `tests/ncBands.test.ts`

A reconnaissance pass over this suggested reusing `flagBandOf`. Do not. `flagBandOf` bands a
sample by `hold_flag`/`outside_limit_flag`; a nonconformity has neither, and its `severity` is a
stored enum — the opposite of the derived-severity principle `FlaggedPage`'s header states. The two
vocabularies are different and conflating them would put "Critical" next to "major" meaning
something else.

- [ ] **Step 1: Write the failing test**

Create `tests/ncBands.test.ts`:

```ts
/**
 * Overdue and the Nonconformities band, with a control on each.
 *
 * Spec §5: nothing here is stored, so nothing can be edited to look better
 * than it is. "Overdue" in particular is `completed_at is null AND due_date <
 * plant-local today` — a column would need a job to keep it current and would
 * be a field somebody could edit to look less late.
 *
 * Every assertion is paired with a case where the same input lands elsewhere.
 * A band function that returned one constant would satisfy half of these.
 */
import { describe, it, expect } from 'vitest';

import { isActionOverdue, ncBandOf, NC_BANDS, type NcRecordForBand } from '@/lib/ncBands';

/** 2026-11-04 in Guyana. The clock is an argument, never read from the host. */
const TODAY = '2026-11-04';

function rec(over: Partial<NcRecordForBand> = {}): NcRecordForBand {
  return { status: 'open', actions: [], ...over };
}

describe('isActionOverdue', () => {
  it('is overdue when it is unfinished and its day has passed', () => {
    expect(isActionOverdue({ dueDate: '2026-11-03', completedAt: null }, TODAY)).toBe(true);
  });

  it('is NOT overdue on its due date', () => {
    // The control that matters: an off-by-one here makes every action due
    // today look late, and a screen that cries wolf stops being read.
    expect(isActionOverdue({ dueDate: TODAY, completedAt: null }, TODAY)).toBe(false);
  });

  it('is NOT overdue once completed, however late', () => {
    expect(
      isActionOverdue({ dueDate: '2020-01-01', completedAt: '2026-11-04T10:00:00Z' }, TODAY),
    ).toBe(false);
  });

  it('reads the day from the argument, not from the host clock', () => {
    const action = { dueDate: '2026-11-03', completedAt: null };
    expect(isActionOverdue(action, '2026-11-02')).toBe(false);
    expect(isActionOverdue(action, '2026-11-04')).toBe(true);
  });
});

describe('ncBandOf', () => {
  it('bands an open record with a late action as overdue', () => {
    expect(
      ncBandOf(rec({ status: 'open', actions: [{ dueDate: '2026-11-01', completedAt: null }] }), TODAY),
    ).toBe('overdue');
  });

  it('bands an open record with no late action as open', () => {
    expect(
      ncBandOf(rec({ status: 'open', actions: [{ dueDate: '2026-12-01', completedAt: null }] }), TODAY),
    ).toBe('open');
  });

  it('bands a record awaiting verification as awaiting, not open', () => {
    expect(ncBandOf(rec({ status: 'awaiting_verification' }), TODAY)).toBe('awaiting_verification');
  });

  it('puts a late action on an awaiting record in overdue, because it is still work', () => {
    // Overdue wins. A record cannot reach gate 1 with an incomplete action, so
    // this state means an action was added after the gate — which 0052 forbids
    // through the RPCs and the guard still permits directly. If it ever
    // appears, it is late work and must show as late, not as "being checked".
    expect(
      ncBandOf(
        rec({ status: 'awaiting_verification', actions: [{ dueDate: '2026-11-01', completedAt: null }] }),
        TODAY,
      ),
    ).toBe('overdue');
  });

  it('gives a closed record no band at all', () => {
    expect(ncBandOf(rec({ status: 'closed' }), TODAY)).toBeNull();
    expect(ncBandOf(rec({ status: 'voided' }), TODAY)).toBeNull();
  });

  it('puts every record in at most one band', () => {
    const cases: NcRecordForBand[] = [
      rec({ status: 'open' }),
      rec({ status: 'open', actions: [{ dueDate: '2026-11-01', completedAt: null }] }),
      rec({ status: 'awaiting_verification' }),
      rec({ status: 'closed' }),
      rec({ status: 'voided' }),
    ];
    for (const c of cases) {
      const band = ncBandOf(c, TODAY);
      const hits = NC_BANDS.filter((b) => b === band);
      expect(hits.length, `${c.status} landed in ${hits.length} bands`).toBeLessThanOrEqual(1);
    }
  });

  it('does not band by severity', () => {
    // Spec §5: severity is a column and a FILTER, not a band — the same rule
    // the Flagged sample bands follow. Two records differing only in severity
    // band identically.
    const major = ncBandOf(rec({ status: 'open', severity: 'major' }), TODAY);
    const minor = ncBandOf(rec({ status: 'open', severity: 'minor' }), TODAY);
    expect(major).toBe(minor);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/ncBands.test.ts`
Expected: FAIL — `Failed to resolve import "@/lib/ncBands"`.

- [ ] **Step 3: Write the module**

Create `src/lib/ncBands.ts` with `NC_BANDS = ['overdue','open','awaiting_verification'] as const`,
the `NcBand` type, `NcActionForBand` (`dueDate`, `completedAt`), `NcRecordForBand` (`status`,
`actions`, optional `severity`), `isActionOverdue(action, plantToday)` and
`ncBandOf(record, plantToday)`. Both take the plant-local day as a **string argument** — never read
a clock inside, which is what makes the test above able to fail.

Plant-local today is `plantLocalDate(new Date())` from `src/lib/time.ts` (line 83), which returns
`YYYY-MM-DD` in `America/Guyana`. The CALLER evaluates it and passes the string in; neither
function in `ncBands.ts` may call it, because a module that reads a clock cannot be tested against
a fixed day.

- [ ] **Step 4: Run the test**

Run: `npx vitest run tests/ncBands.test.ts`
Expected: PASS, all eleven.

- [ ] **Step 5: Mutation-test both functions**

Two mutations, each answered by the assertion written for it:

1. Change `isActionOverdue`'s comparison from `<` to `<=`. Expected: `is NOT overdue on its due
   date` fails.
2. Make `ncBandOf` ignore the actions and band purely on status. Expected: `bands an open record
   with a late action as overdue` fails.

Restore after each and confirm green. **Read which assertion failed each time** — if a different
one catches it, the control written for that behaviour is still unproven.

- [ ] **Step 6: Commit**

```bash
git add src/lib/ncBands.ts tests/ncBands.test.ts
git commit -m "Overdue and the nonconformity bands, derived and never stored"
```

---

## Task 7: the Nonconformities tab on Flagged

**Review reference:** **spec §8**, first three paragraphs. Also `src/pages/DashboardPage.tsx` for
the tablist pattern and `tests/neumorphism.test.ts` for what the classes may be.

**Files:**
- Modify: `src/pages/FlaggedPage.tsx`
- Create: `src/components/nc/NonconformityTable.tsx`
- Create: `tests/flaggedTabs.test.tsx`

**The hazard, stated so it is designed for rather than discovered.** `FlaggedPage` already has a
chip row at lines 109–146: `role="group"`, `aria-label="Filter by what is wrong"`, buttons with
`aria-pressed`. The new tab row sits **above** it. Built from the same classes, the two become one
indistinguishable strip of six buttons and the screen gets worse, not better. So:

- the tab row is a `role="tablist"` with `role="tab"` and `aria-selected`, following
  `DashboardPage`, **not** `aria-pressed`;
- it is visually distinct: full-width segmented, `rounded-2xl`, heavier weight on the selected tab;
- the band chip row stays **inside** the Samples panel, so switching tabs replaces the chips rather
  than stacking two filter rows.

**Neumorphism gate constraints** (`tests/neumorphism.test.ts`), all of which apply here:
- `bg-white` only within 400 characters of `shadow-neu-inset` — so **do not** reach for `bg-white`
  on a tab or a chip; use `bg-neu-base` with `shadow-neu-sm`;
- no `text-slate-500` anywhere;
- `text-slate-400` only as `placeholder:` / `disabled:`, or within 200 characters of
  `aria-hidden="true"`;
- never pair `rounded-sm` or `rounded-md` with `shadow-neu` — hence `rounded-2xl`.

- [ ] **Step 1: Write the failing test**

Create `tests/flaggedTabs.test.tsx`:

```tsx
/**
 * Flagged is two screens now, and they must not read as one.
 *
 * The risk this file exists for is cosmetic and real: the band chips
 * (All/Critical/High/Other) and a tab row (Samples/Nonconformities) built from
 * the same classes become one strip of six buttons, and the screen that was
 * meant to answer "what needs me?" stops answering it.
 *
 * So the two rows are asserted to be SEPARATELY ADDRESSABLE — a tablist and a
 * group, with different roles and different selected-state attributes — and
 * each "is absent" check is paired with a case where the same query finds
 * something, because an absence over a screen that failed to render passes
 * for the wrong reason.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { can as canFor, type Role } from '@/lib/roles';
import type { Profile } from '@/hooks/useProfile';
import { AccessContext } from '@/components/layout/accessContext';
import FlaggedPage from '@/pages/FlaggedPage';

const FAKE_ENV = {
  VITE_SUPABASE_URL: 'https://example.supabase.co',
  VITE_SUPABASE_ANON_KEY: 'test-anon-key',
  VITE_APP_VERSION: 'test',
  VITE_BASE_PATH: '/',
};
vi.mock('@/lib/env', () => ({ env: FAKE_ENV, basePath: '/', readEnv: () => FAKE_ENV }));
vi.mock('@/lib/supabase', () => ({ signOut: vi.fn(), supabase: {} }));

// The hooks, not the transport. This file is about the screen's structure; the
// column names are `tests/nonconformityColumns.test.ts`'s job and the bands
// are `tests/ncBands.test.ts`'s.
vi.mock('@/hooks/useSamples', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/useSamples')>()),
  // The real names: `useFlagged(band, page)` and `useFlaggedCounts()`.
  useFlagged: () => ({ data: { rows: [], total: 0 }, isPending: false, isError: false }),
  useFlaggedCounts: () => ({ data: { all: 0, critical: 0, high: 0, other: 0 }, isError: false }),
}));
vi.mock('@/hooks/useNonconformities', () => ({
  useNonconformityList: () => ({
    data: [
      {
        id: 'nc1',
        nc_number: 'NC-2026-001',
        status: 'open',
        classification: 'process',
        severity: 'minor',
        title: 'Fines in the cooler',
        sample_uuid: null,
        actions: [{ dueDate: '2026-11-01', completedAt: null }],
      },
    ],
    isPending: false,
    isError: false,
  }),
  NONCONFORMITY_COLUMNS: '',
  NC_ACTION_COLUMNS: '',
}));

function profileWith(roles: readonly Role[]): Profile {
  return {
    id: 'u1',
    email: 'officer@example.test',
    fullName: 'An Officer',
    status: 'active',
    roles,
    provisional: false,
    passwordSetByAdminAt: null,
    passwordChangedAt: '2026-01-01T00:00:00.000Z',
    mustChangePassword: false,
  } as Profile;
}

function renderFlagged(roles: readonly Role[] = ['quality_officer']) {
  const profile = profileWith(roles);
  const value = {
    profile,
    // The REAL matrix. A screen gated on a stub `can` proves nothing about
    // what this role is actually offered.
    can: (permission: Parameters<typeof canFor>[1]) =>
      canFor({ userId: profile.id, status: profile.status, roles: profile.roles }, permission),
    reloadProfile: vi.fn(),
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <AccessContext.Provider value={value}>
          <FlaggedPage />
        </AccessContext.Provider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('the two rows are not one row', () => {
  it('offers exactly two tabs, as tabs', () => {
    renderFlagged();
    const tablist = screen.getByRole('tablist', { name: /what needs attention/i });
    const tabs = within(tablist).getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['Samples', 'Nonconformities']);
  });

  it('keeps the band chips out of the tablist', () => {
    renderFlagged();
    const tablist = screen.getByRole('tablist', { name: /what needs attention/i });
    // The paired positive: the chips exist on the page...
    expect(screen.getByRole('group', { name: /filter by what is wrong/i })).toBeInTheDocument();
    // ...and are not inside the tab row.
    expect(within(tablist).queryByText(/critical/i)).toBeNull();
  });

  it('marks the selected tab with aria-selected and the chips with aria-pressed', () => {
    renderFlagged();
    const tabs = within(screen.getByRole('tablist', { name: /what needs attention/i })).getAllByRole('tab');
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
    expect(tabs[0]).not.toHaveAttribute('aria-pressed');
    const chips = within(screen.getByRole('group', { name: /filter by what is wrong/i })).getAllByRole('button');
    expect(chips[0]).toHaveAttribute('aria-pressed');
  });
});

describe('the nonconformities tab', () => {
  it('replaces the sample bands rather than stacking a second filter row', async () => {
    renderFlagged();
    await userEvent.click(screen.getByRole('tab', { name: 'Nonconformities' }));
    expect(screen.queryByRole('group', { name: /filter by what is wrong/i })).toBeNull();
    expect(screen.getByRole('group', { name: /filter nonconformities/i })).toBeInTheDocument();
  });

  it('shows the number, the title and the derived band', async () => {
    renderFlagged();
    await userEvent.click(screen.getByRole('tab', { name: 'Nonconformities' }));
    expect(screen.getByText('NC-2026-001')).toBeInTheDocument();
    expect(screen.getByText(/fines in the cooler/i)).toBeInTheDocument();
    // The fixture's action was due 2026-11-01 and is incomplete, so the record
    // is overdue — derived, not a column.
    expect(screen.getByText(/overdue/i)).toBeInTheDocument();
  });

  it('offers "Raise a nonconformity" to a role that may, and not to one that may not', async () => {
    renderFlagged(['quality_officer']);
    await userEvent.click(screen.getByRole('tab', { name: 'Nonconformities' }));
    expect(screen.getByRole('button', { name: /raise a nonconformity/i })).toBeInTheDocument();
  });

  it('does not offer it to an auditor', async () => {
    renderFlagged(['auditor']);
    await userEvent.click(screen.getByRole('tab', { name: 'Nonconformities' }));
    // The paired positive: the auditor still SEES the tab and the record, so
    // this absence is about the button and not about a blank screen.
    expect(screen.getByText('NC-2026-001')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /raise a nonconformity/i })).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/flaggedTabs.test.tsx`
Expected: FAIL — no `tablist` with that name. Confirm the failure names the missing tablist and is
not a render crash: a crash would fail every assertion for one unrelated reason.

- [ ] **Step 3: Build the table component, then the tab row**

`src/components/nc/NonconformityTable.tsx` renders the chips
`All · Overdue · Open · Awaiting verification` with counts inside
`role="group" aria-label="Filter nonconformities"`, over a table with the seven columns spec §8
names: NC number, title, classification, severity, linked sample, next due date, status. Reuse
`Card`, `EmptyState`, `LoadingBlock`, `ErrorNotice` and `Pagination` from
`@/components/records/common` — and **do not pass `className` to that `Card`**; only
`src/components/ui/Card.tsx` accepts one.

Then in `FlaggedPage.tsx`, between the `PageHeader` (line 107) and the band chip row (line 109),
add the tablist and make lines 109–202 the body of the Samples panel.

- [ ] **Step 4: Run the test, the style gate and the suite**

```bash
npx vitest run tests/flaggedTabs.test.tsx tests/neumorphism.test.ts
npm run typecheck && npm run lint && npm test
```

Expected: all pass. If `neumorphism` fails on `bg-white`, the tab or a chip reached for white —
use `bg-neu-base` with `shadow-neu-sm`.

- [ ] **Step 5: Verify it in a real browser, at phone width**

jsdom has no layout engine: `getBoundingClientRect` is all zeros, so nothing above proves the two
rows look different or that six buttons fit a 375px phone. That is e2e's job and the browser's.

```bash
npm run dev
```

Then with the preview tools: open the Flagged screen at 375×812, screenshot both tabs, and confirm
(a) the tab row and the chip row are visibly different controls, (b) there is no horizontal scroll.

- [ ] **Step 6: Commit**

```bash
git add src/pages/FlaggedPage.tsx src/components/nc/NonconformityTable.tsx tests/flaggedTabs.test.tsx
git commit -m "Flagged answers two questions now, in two tabs that do not look alike"
```

---

## Task 8: `/nc/:id`, read-only first

**Review reference:** **spec §8**, the "NC detail" paragraph — in particular "Sections above the
reader's permission are **visible but not editable**, so everyone can see what the next person has
to do." Also `src/pages/SampleDetailPage.tsx` for the page shape.

**Files:**
- Create: `src/pages/NonconformityDetailPage.tsx`
- Modify: `src/App.tsx`
- Create: `tests/ncDetailPage.test.tsx`

**Two things about permissions on this page, both verified and both easy to get wrong.**

1. "May I?" has **two** answers in this browser. Route and nav gating use `useAccess().can`, which
   reads roles only. In-page action gating on a record screen uses `useAuthority().allows`, which
   reads roles **plus recorded delegations**. `SampleDetailPage` uses the second. **This page must
   use `useAuthority().allows`** — using `useAccess().can` would silently ignore a delegation,
   which is the mechanism by which a supervisor hands authority to somebody for a shift.
2. The route guard is `sample.view`, not an `nc.*` permission. There is no `nc.view`; spec §4 says
   reading reuses `sample.view`.

**The page shape, which is not negotiable because the codebase has one.** `useParams<{ id: string }>()`,
one query with `enabled` on the param, two early returns — `isPending` → `LoadingBlock`, `isError`
→ `ErrorNotice` plus a `Link` back — and the **not-found case thrown as a human sentence by the
fetcher**, not a third branch. `SampleDetailPage` has no `isNotFound` branch and this page must not
invent one.

- [ ] **Step 1: Write the failing test**

Create `tests/ncDetailPage.test.tsx`, following `tests/flaggedTabs.test.tsx`'s provider setup
(same `FAKE_ENV` mock, same `AccessContext` with the real matrix, plus a `MemoryRouter` with
`initialEntries={['/nc/nc1']}` and a `Routes`/`Route path="/nc/:id"` wrapper). Assert:

```tsx
describe('what every reader sees', () => {
  it('lays the record out in the order the work happens', () => {
    // Spec §8: the problem and where it was detected, the correction, root
    // cause, the CA evaluation, the actions, attachments, then verification.
    // Asserted as DOM ORDER, because "in the order the work happens" is the
    // requirement and a set of headings in any order satisfies a weaker one.
    renderDetail(['auditor']);
    const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(headings).toEqual([
      'The problem',
      'Immediate correction',
      'Root cause',
      'Corrective action',
      'Actions',
      'Verification',
    ]);
  });

  it('shows an auditor every section, and no control in any of them', () => {
    renderDetail(['auditor']);
    expect(screen.getByRole('heading', { name: 'Verification' })).toBeInTheDocument();
    // The paired positive: the record rendered, so this absence is about
    // permission and not about a blank page.
    expect(screen.getByText('NC-2026-001')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /save|complete|close|void|add/i })).toBeNull();
  });

  it('says on the record s face when it was verified by the person who did the work', () => {
    // Spec §5 and §11: self_verified will be true on most records initially,
    // because there are two quality people. That is the honest state of the
    // control and is why it is recorded rather than hidden.
    renderDetail(['auditor'], { self_verified: true, status: 'closed' });
    expect(screen.getByText(/verified by the person who did the work/i)).toBeInTheDocument();
  });
});

describe('what each permission is offered', () => {
  it('offers an officer the act controls and not the closing ones', () => {
    renderDetail(['quality_officer']);
    expect(screen.getByRole('button', { name: /add an action/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /send for verification/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^close/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /void/i })).toBeNull();
  });

  it('offers a supervisor the closing controls', () => {
    renderDetail(['quality_supervisor'], { status: 'awaiting_verification' });
    expect(screen.getByRole('button', { name: /^close/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /void/i })).toBeInTheDocument();
  });

  it('offers nobody a control on a closed record', () => {
    renderDetail(['quality_supervisor'], { status: 'closed', self_verified: false });
    expect(screen.getByText(/NC-2026-001/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /save|complete|close|void|add/i })).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/ncDetailPage.test.tsx`
Expected: FAIL — `Failed to resolve import "@/pages/NonconformityDetailPage"`.

- [ ] **Step 3: Write the page, read-only**

Create `src/pages/NonconformityDetailPage.tsx` with the six `h2` sections in that order, using
`PageHeader`, `Card`, `DetailRow`, `LoadingBlock`, `ErrorNotice`, `InfoNote` and `NotPermitted`
from `@/components/records/common`. Every section renders for every reader; controls are
conditional on `allows(...)` **and** on the record's status. The write controls are stubs in this
task — Tasks 9–11 fill them in — but the **buttons and their gating are built here**, because that
is what the test above asserts and what spec §8 requires.

- [ ] **Step 4: Add the route**

In `src/App.tsx`, add one default import and one child route inside
`<Route path="/" element={<AppLayout />}>`, **above** the `path="*"` catch-all at line 237:

```tsx
        <Route
          path="nc/:id"
          element={
            <RequirePermission permission="sample.view">
              <NonconformityDetailPage />
            </RequirePermission>
          }
        />
```

No leading slash on a child path, and no lazy loading — every page in this app is a static default
import.

- [ ] **Step 5: Run the test and the gates**

```bash
npx vitest run tests/ncDetailPage.test.tsx
npm run typecheck && npm run lint && npm test
```

Expected: pass.

- [ ] **Step 6: Mutation-test the permission gating**

Change the officer's close-button condition from `allows('nc.close')` to `allows('nc.act')` and
re-run. Expected: `offers an officer the act controls and not the closing ones` fails. Then swap
`useAuthority().allows` for `useAccess().can` and confirm the suite still passes — **it will**,
which is exactly why this is written down rather than left to a reviewer: no unit test can tell
them apart, because a delegation only exists at runtime. Restore `useAuthority()`.

- [ ] **Step 7: Commit**

```bash
git add src/pages/NonconformityDetailPage.tsx src/App.tsx tests/ncDetailPage.test.tsx
git commit -m "The nonconformity record, laid out in the order the work happens"
```

---

## Task 9: raising one

**Review reference:** **spec §8** "Three ways in", and **spec §7**'s rule that classification and
severity are left unset.

**Files:**
- Create: `src/components/nc/RaiseNonconformityDialog.tsx`
- Modify: `src/components/nc/NonconformityTable.tsx` (wire the button)
- Create: `tests/raiseNonconformity.test.tsx`

The form has exactly four fields: **title**, **description**, and optionally **the sample** (
pre-filled and read-only when raised from a sample) and **recurrence of** (a picker over open and
recently closed records). It has **no classification and no severity field** — not disabled ones,
not optional ones, absent ones — because the RPC does not take them and spec §7 says why. A field
that silently does nothing is worse than no field.

- [ ] **Step 1: Write the failing test**

Create `tests/raiseNonconformity.test.tsx`. Assert:

```tsx
  it('asks for a title and a description and nothing else', () => {
    renderDialog();
    expect(screen.getByLabelText(/title/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/what happened/i)).toBeInTheDocument();
    // Spec §7: these are required at the first gate, not at the mill.
    expect(screen.queryByLabelText(/classification/i)).toBeNull();
    expect(screen.queryByLabelText(/severity/i)).toBeNull();
  });

  it('refuses to submit with a blank title, before any request is made', async () => {
    const post = vi.fn();
    renderDialog({ post });
    await userEvent.type(screen.getByLabelText(/what happened/i), 'Fines everywhere.');
    await userEvent.click(screen.getByRole('button', { name: /raise/i }));
    expect(post).not.toHaveBeenCalled();
    expect(screen.getByText(/give it a short title/i)).toBeInTheDocument();
  });

  it('sends the same idempotency key when the same raise is retried', async () => {
    // The one that matters. `newIdempotencyKey()` is a fresh UUID per call, so
    // a retry through a new key is a NEW act: press "try again" after a raise
    // that actually succeeded and the mill has two nonconformities for one
    // problem, with two numbers, and nothing to tell them apart.
    const post = vi.fn().mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce({ ok: true });
    renderDialog({ post });
    await userEvent.type(screen.getByLabelText(/title/i), 'Fines in the cooler');
    await userEvent.type(screen.getByLabelText(/what happened/i), 'Observed on discharge.');
    await userEvent.click(screen.getByRole('button', { name: /raise/i }));
    await userEvent.click(await screen.findByRole('button', { name: /try again/i }));
    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[0][0].idempotencyKey).toBe(post.mock.calls[1][0].idempotencyKey);
  });

  it('mints a DIFFERENT key once the payload changes', async () => {
    // The control. A key held for ever would make a second, genuinely
    // different nonconformity collide with the first as an idempotency
    // conflict — the opposite failure, equally bad.
    const post = vi.fn().mockResolvedValue({ ok: true });
    renderDialog({ post });
    await userEvent.type(screen.getByLabelText(/title/i), 'First');
    await userEvent.type(screen.getByLabelText(/what happened/i), 'One.');
    await userEvent.click(screen.getByRole('button', { name: /raise/i }));
    await userEvent.clear(screen.getByLabelText(/title/i));
    await userEvent.type(screen.getByLabelText(/title/i), 'Second');
    await userEvent.click(screen.getByRole('button', { name: /raise/i }));
    expect(post.mock.calls[0][0].idempotencyKey).not.toBe(post.mock.calls[1][0].idempotencyKey);
  });

  it('shows the number it was given, because that is what the operator writes down', async () => {
    const post = vi.fn().mockResolvedValue({ ok: true, ncNumber: 'NC-2026-007' });
    renderDialog({ post });
    await userEvent.type(screen.getByLabelText(/title/i), 'Fines');
    await userEvent.type(screen.getByLabelText(/what happened/i), 'Seen.');
    await userEvent.click(screen.getByRole('button', { name: /raise/i }));
    expect(await screen.findByText(/NC-2026-007/)).toBeInTheDocument();
  });
```

- [ ] **Step 2: Run it and watch it fail; then build the dialog; then run it again**

```bash
npx vitest run tests/raiseNonconformity.test.tsx   # FAIL: no such module
# ...build src/components/nc/RaiseNonconformityDialog.tsx...
npx vitest run tests/raiseNonconformity.test.tsx   # PASS
```

The dialog takes `sampleUuid?: string | null` and renders the sample as read-only text when given
one. On success it invalidates `['nonconformities','list']`, and `['sample', sampleUuid]` plus
`['samples']` when a sample was linked.

- [ ] **Step 3: Verify a real raise, end to end, against the live project**

With the dev server running, signed in as an operator (who holds `nc.raise` and not `nc.act`):
raise one from the Nonconformities tab. Then confirm in the database that the record is real and
its number was allocated:

```bash
echo "select nc_number, status, classification, severity, title, detected_by from public.nonconformities order by created_at desc limit 1;" | scripts/run-sql.py
```

Expected: one row, `status = 'open'`, **`classification` and `severity` both null** — spec §7 — and
`detected_by` the operator's id.

- [ ] **Step 4: Commit**

```bash
git add src/components/nc/ tests/raiseNonconformity.test.tsx
git commit -m "Raise a nonconformity: a title, what happened, and a number to write down"
```

---

## Task 10: working it — the investigation and its actions

**Review reference:** **spec §3**'s precondition list and its "Why 'none needed' is a first-class
outcome" section; **spec §9** on concurrent edits.

**Files:**
- Modify: `src/pages/NonconformityDetailPage.tsx`
- Create: `src/components/nc/NcActionList.tsx`
- Create: `tests/ncInvestigation.test.tsx`

**The CA evaluation is a tri-state and the form must show three states.** `ca_required` is
`null` (not yet evaluated), `true`, or `false`, and spec §3 requires `ca_rationale` **whichever way
it was decided**. ISO 10.2.1(b) requires evaluating the *need* for action, not taking one every
time; a system that cannot record "evaluated, not required, because…" produces invented corrective
actions nobody believes. So:

- a radio pair, **neither preselected** — a default would record a decision nobody made;
- the rationale textarea is required as soon as either is chosen, with a label that changes
  (*"Why is corrective action needed?"* / *"Why is none needed?"*);
- the root-cause and actions sections become required-looking only when `true` is chosen.

**`expectedRevision` goes on this call and on no other.** `rpc_update_nonconformity` is the only
one of the eight that takes it. Pass `expectedRevision: nc.revision` from the loaded record; on a
`revision_conflict` (409) show the refusal's own sentence and a Reload button, never a merge.

- [ ] **Step 1: Write the failing test**

Create `tests/ncInvestigation.test.tsx`. Assert:

```tsx
  it('preselects neither answer on the corrective-action question', () => {
    // A default here would record an evaluation nobody made, and `null` is a
    // different fact from `false` — gate 1 tells them apart by name.
    renderInvestigation();
    expect(screen.getByRole('radio', { name: /yes/i })).not.toBeChecked();
    expect(screen.getByRole('radio', { name: /no/i })).not.toBeChecked();
  });

  it('asks why even when the answer is no', async () => {
    renderInvestigation();
    await userEvent.click(screen.getByRole('radio', { name: /no/i }));
    expect(screen.getByLabelText(/why is none needed/i)).toBeInTheDocument();
  });

  it('asks why when the answer is yes, with the other wording', async () => {
    renderInvestigation();
    await userEvent.click(screen.getByRole('radio', { name: /yes/i }));
    expect(screen.getByLabelText(/why is corrective action needed/i)).toBeInTheDocument();
  });

  it('sends the revision it loaded, so a stale save is refused rather than merged', async () => {
    const post = vi.fn().mockResolvedValue({ ok: true });
    renderInvestigation({ post, nc: { revision: 4 } });
    await userEvent.type(screen.getByLabelText(/immediate correction/i), 'Cooler reset.');
    await userEvent.click(screen.getByRole('button', { name: /save/i }));
    expect(post.mock.calls[0][0].expectedRevision).toBe(4);
  });

  it('shows the database s own words when the save is refused as stale', async () => {
    // Spec §9: refused, not merged — and the refusal says what to do. The
    // message is the one migration 0053 raises, carried by mapPostgresError.
    const post = vi.fn().mockRejectedValue(
      Object.assign(new Error('x'), {
        code: 'revision_conflict',
        message:
          'somebody else saved nonconformity NC-2026-001 while this was open (current_revision=5, yours=4). Reload and re-apply your changes.',
      }),
    );
    renderInvestigation({ post, nc: { revision: 4 } });
    await userEvent.type(screen.getByLabelText(/immediate correction/i), 'Cooler reset.');
    await userEvent.click(screen.getByRole('button', { name: /save/i }));
    expect(await screen.findByText(/reload and re-apply your changes/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /reload/i })).toBeInTheDocument();
  });

  it('does not send expectedRevision on an action call', async () => {
    // Only rpc_update_nonconformity takes it. Sending it elsewhere is a
    // PostgREST 404 — a named argument no function has.
    const post = vi.fn().mockResolvedValue({ ok: true });
    renderActions({ post });
    await userEvent.click(screen.getByRole('button', { name: /add an action/i }));
    await userEvent.type(screen.getByLabelText(/what is to be done/i), 'Shorten the interval.');
    await userEvent.click(screen.getByRole('button', { name: /^add$/i }));
    expect(post.mock.calls[0][0]).not.toHaveProperty('expectedRevision');
  });

  it('marks an unfinished action past its day as overdue, and one due today as not', () => {
    renderActions({
      today: '2026-11-04',
      actions: [
        { id: 'a1', description: 'Late one', dueDate: '2026-11-01', completedAt: null },
        { id: 'a2', description: 'Due today', dueDate: '2026-11-04', completedAt: null },
      ],
    });
    const late = screen.getByRole('row', { name: /late one/i });
    const today = screen.getByRole('row', { name: /due today/i });
    expect(within(late).getByText(/overdue/i)).toBeInTheDocument();
    expect(within(today).queryByText(/overdue/i)).toBeNull();
  });

  it('requires a note before an action can be completed', async () => {
    const post = vi.fn();
    renderActions({ post });
    await userEvent.click(screen.getByRole('button', { name: /mark complete/i }));
    await userEvent.click(screen.getByRole('button', { name: /^complete$/i }));
    expect(post).not.toHaveBeenCalled();
    expect(screen.getByText(/say what was done/i)).toBeInTheDocument();
  });
```

- [ ] **Step 2: Run it, build the sections, run it again**

```bash
npx vitest run tests/ncInvestigation.test.tsx   # FAIL
# ...build the investigation form and src/components/nc/NcActionList.tsx...
npx vitest run tests/ncInvestigation.test.tsx   # PASS
```

`NcActionList` renders each action as a `role="row"` with its description, owner, due date, the
derived `Overdue` chip from `isActionOverdue`, and — when `allows('nc.act')` and the record is
`open` — **Mark complete** and **Reassign**. Reassign requires a reason; spec amendment of
2026-11-04 exists so an action owned by somebody who has left can still be cleared.

- [ ] **Step 3: Work a real record end to end against the live project**

Signed in as a quality officer: open the record raised in Task 9, fill the correction, answer the
CA question **no** with a rationale, save. Then confirm:

```bash
echo "select nc_number, correction, ca_required, ca_rationale, revision from public.nonconformities order by created_at desc limit 1;" | scripts/run-sql.py
```

Expected: the correction and rationale stored, `ca_required = false`, `revision = 2`.

- [ ] **Step 4: Commit**

```bash
git add src/pages/NonconformityDetailPage.tsx src/components/nc/NcActionList.tsx tests/ncInvestigation.test.tsx
git commit -m "Work a nonconformity, and record that no action was needed as an answer"
```

---

## Task 11: the two gates, and the refusal that says why

**Review reference:** **spec §9**'s first paragraph, quoted again because it is the acceptance
criterion: *"Not 'validation failed' but 'Cannot send for verification: corrective action has not
been evaluated, and 2 of 3 actions are incomplete.' A gate that will not say why is a gate people
route around."*

**Files:**
- Modify: `src/pages/NonconformityDetailPage.tsx`
- Create: `tests/ncGateRefusal.test.tsx`

This task is where Task 1 pays off. The gate's sentence is written in
`nc_gate_one_unmet` (migration 0052) and arrives as `ApiError.message` under
`code: 'validation_failed'`. **Render it verbatim.** Do not map it to a friendlier string, do not
truncate it at the first semicolon, and do not replace it with a field-by-field form annotation —
the message lists *every* unmet precondition precisely so the person sees the whole list at once
instead of submitting six times to learn six things.

- [ ] **Step 1: Write the failing test**

Create `tests/ncGateRefusal.test.tsx`:

```tsx
  it('shows every unmet precondition, in the database s own words', async () => {
    const post = vi.fn().mockRejectedValue(
      Object.assign(new Error('x'), {
        code: 'validation_failed',
        message:
          'NC-2026-001 cannot be submitted for verification yet — a severity has not been chosen; the need for corrective action has not been evaluated; 2 action(s) are still outstanding.',
      }),
    );
    renderDetail(['quality_officer'], { post });
    await userEvent.click(screen.getByRole('button', { name: /send for verification/i }));
    const notice = await screen.findByRole('alert');
    // All three, not the first one. The list IS the feature.
    expect(notice).toHaveTextContent(/a severity has not been chosen/i);
    expect(notice).toHaveTextContent(/has not been evaluated/i);
    expect(notice).toHaveTextContent(/2 action\(s\) are still outstanding/i);
  });

  it('does not replace it with a generic sentence', async () => {
    const post = vi.fn().mockRejectedValue(
      Object.assign(new Error('x'), {
        code: 'validation_failed',
        message: 'NC-2026-001 cannot be submitted for verification yet — a severity has not been chosen.',
      }),
    );
    renderDetail(['quality_officer'], { post });
    await userEvent.click(screen.getByRole('button', { name: /send for verification/i }));
    const notice = await screen.findByRole('alert');
    expect(notice).not.toHaveTextContent(/validation failed/i);
    expect(notice).not.toHaveTextContent(/something went wrong/i);
    expect(notice).not.toHaveTextContent(/please try again/i);
  });

  it('requires a verification note before closing, and says why one is wanted', async () => {
    const post = vi.fn();
    renderDetail(['quality_supervisor'], { post, nc: { status: 'awaiting_verification' } });
    await userEvent.click(screen.getByRole('button', { name: /^close/i }));
    await userEvent.click(screen.getByRole('button', { name: /^close the nonconformity$/i }));
    expect(post).not.toHaveBeenCalled();
    expect(screen.getByText(/say what was checked/i)).toBeInTheDocument();
  });

  it('tells the verifier, before they close it, that this will be a self-verification', async () => {
    // Spec §5: self_verified is recorded rather than refused, because
    // requiring a different verifier would deadlock a two-person quality team.
    // The honest version of that is to say so at the moment of signing.
    renderDetail(['quality_supervisor'], {
      nc: { status: 'awaiting_verification', detected_by: 'u1' },
      profileId: 'u1',
    });
    await userEvent.click(screen.getByRole('button', { name: /^close/i }));
    expect(screen.getByText(/you raised this one/i)).toBeInTheDocument();
  });

  it('does not say that when somebody else raised it', async () => {
    renderDetail(['quality_supervisor'], {
      nc: { status: 'awaiting_verification', detected_by: 'someone-else' },
      profileId: 'u1',
    });
    await userEvent.click(screen.getByRole('button', { name: /^close/i }));
    expect(screen.queryByText(/you raised this one/i)).toBeNull();
  });

  it('requires a reason to void, and offers voiding from both live states', async () => {
    for (const status of ['open', 'awaiting_verification'] as const) {
      const post = vi.fn();
      const { unmount } = renderDetail(['quality_supervisor'], { post, nc: { status } });
      await userEvent.click(screen.getByRole('button', { name: /void/i }));
      await userEvent.click(screen.getByRole('button', { name: /^void the nonconformity$/i }));
      expect(post, `void was accepted with no reason from ${status}`).not.toHaveBeenCalled();
      unmount();
    }
  });
```

- [ ] **Step 2: Run it, build the gate controls, run it again**

```bash
npx vitest run tests/ncGateRefusal.test.tsx   # FAIL
# ...build the submit / close / void controls and the refusal notice...
npx vitest run tests/ncGateRefusal.test.tsx   # PASS
```

The refusal notice is `role="alert"` and renders `error.message` as text. For
`code: 'validation_failed'` and `revision_conflict` the message is the database's; for any other
code fall back to `edgeErrorMessage`, which is what the rest of the app does.

- [ ] **Step 3: Drive a REAL gate refusal through the browser, and read it**

This is the acceptance criterion and it cannot be met by a mock: the wording has to survive the
RPC, `mapPostgresError`, the HTTP body and the component.

As a quality officer, on a record with nothing filled in, press **Send for verification**.

Expected on screen: the whole list — *"… cannot be submitted for verification yet — a
classification has not been chosen; a severity has not been chosen; the immediate correction has
not been recorded; the need for corrective action has not been evaluated; the reason for that
evaluation has not been recorded (required whichever way it was decided)."*

**Seeing "Something went wrong" or an internal-error sentence means Task 1's mapper is not
deployed** — redeploy `nonconformity-action` and check the `NC_SPOKEN` list.

- [ ] **Step 4: Close one, and confirm `self_verified` was stamped**

Fill the record in properly, send it for verification as the officer, then close it as the
supervisor. Then:

```bash
echo "select nc_number, status, self_verified, verified_by, verification_note from public.nonconformities order by created_at desc limit 1;" | scripts/run-sql.py
```

Expected: `status = 'closed'`, `verified_by` the supervisor, the note stored, and `self_verified`
**false** if the officer raised it — which is the case worth checking, because a hardcoded `true`
passes the other one.

- [ ] **Step 5: Commit**

```bash
git add src/pages/NonconformityDetailPage.tsx tests/ncGateRefusal.test.tsx
git commit -m "A gate that says what is missing, in the words the migration wrote"
```

---

## Task 12: the sample's own nonconformities, and the third way in

**Review reference:** **spec §8**, last paragraph: "a button on a flagged sample, which pre-fills
the link and carries its results … Sample detail gains a list of its nonconformities."

**Files:**
- Modify: `src/pages/SampleDetailPage.tsx`
- Create: `tests/sampleNonconformities.test.tsx`

**Mind the existing tests on this page.** `SampleDetailPage` is an established screen with its own
suite. Adding a section to it mutates a shared fixture, so before inserting anything: find every
assertion in the existing sample-detail tests that counts headings, counts buttons, or asserts an
absence over the whole page, and confirm each can still fail afterwards. A new section with a new
button is exactly the change that makes `queryByRole('button', { name: /…/ })` ambiguous and turns a
real assertion into a passing one.

```bash
grep -rn "getAllByRole\|queryAllByRole\|toHaveLength\|queryByRole('button'" tests/ | grep -i sample
```

List what that returns in the commit message, with what happened to each.

- [ ] **Step 1: Write the failing test**

Create `tests/sampleNonconformities.test.tsx`:

```tsx
  it('lists the sample s nonconformities with their numbers and status', () => {
    renderSample(['quality_officer'], {
      nonconformities: [
        { id: 'nc1', nc_number: 'NC-2026-001', title: 'Fines', status: 'open' },
        { id: 'nc2', nc_number: 'NC-2026-002', title: 'Moisture', status: 'closed' },
      ],
    });
    expect(screen.getByRole('link', { name: /NC-2026-001/ })).toHaveAttribute('href', '/nc/nc1');
    expect(screen.getByRole('link', { name: /NC-2026-002/ })).toBeInTheDocument();
  });

  it('says plainly when a sample has none, rather than showing an empty table', () => {
    renderSample(['quality_officer'], { nonconformities: [] });
    expect(screen.getByText(/no nonconformity has been raised against this sample/i)).toBeInTheDocument();
  });

  it('pre-fills the sample when raising from here, and does not let it be changed', async () => {
    renderSample(['quality_officer'], { sampleId: 'GRD-2026-11-04-01', sampleUuid: 's1' });
    await userEvent.click(screen.getByRole('button', { name: /raise a nonconformity/i }));
    const dialog = screen.getByRole('dialog', { name: /raise a nonconformity/i });
    expect(within(dialog).getByText('GRD-2026-11-04-01')).toBeInTheDocument();
    // Read-only text, not a field: the link is the reason this entry point
    // exists, and a changeable sample picker here is a different feature.
    expect(within(dialog).queryByLabelText(/sample/i)).toBeNull();
  });

  it('offers the button to a role that may raise, and not to an auditor', () => {
    renderSample(['auditor'], { nonconformities: [{ id: 'nc1', nc_number: 'NC-2026-001', title: 'Fines', status: 'open' }] });
    // Paired positive: the auditor sees the list, so the absence below is
    // about permission and not about a section that failed to render.
    expect(screen.getByRole('link', { name: /NC-2026-001/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /raise a nonconformity/i })).toBeNull();
  });
```

- [ ] **Step 2: Run it, add the section, run it again**

```bash
npx vitest run tests/sampleNonconformities.test.tsx   # FAIL
# ...add the section to SampleDetailPage, gated on allows('nc.raise') for the button...
npx vitest run tests/sampleNonconformities.test.tsx   # PASS
npm test                                              # the WHOLE suite, for the shared-fixture reason above
```

- [ ] **Step 3: Confirm the existing sample-detail assertions can still fail**

For each assertion the grep in the preamble found, make the thing it asserts false and confirm it
goes red. An assertion that counts buttons on this page now counts one more; an assertion that
cannot fail after this change must be repaired in this task, not left.

- [ ] **Step 4: Commit**

```bash
git add src/pages/SampleDetailPage.tsx tests/sampleNonconformities.test.tsx
git commit -m "A sample shows what was raised against it, and raising one from there"
```

---

## Task 13: end to end, and the spec read again

**Review reference:** the **specification itself**, start to finish. Not this plan.

**Files:**
- Create: `e2e/nonconformity.spec.ts`
- Modify: `docs/superpowers/plans/2026-11-04-nonconformity-capa-phase-2-application.md` (the
  coverage map's outcome)

The e2e layer is where a layout engine exists. `playwright.config.ts` has three projects —
`desktop-chrome`, `plant-tablet`, `small-phone` — and specs live in `e2e/` using free-function
helpers from `e2e/fixtures/app.ts` and `e2e/fixtures/console.ts`. There is no page-object class and
no `test.extend` fixture; do not introduce one.

- [ ] **Step 1: Write the spec**

Create `e2e/nonconformity.spec.ts` covering, on **all three projects**:

1. Flagged shows two tabs and no horizontal scroll at 375px — the thing jsdom cannot see.
2. The tab row and the band chip row are visually distinguishable: assert they differ in computed
   `border-radius` or `font-weight`, not merely that both exist.
3. A raise from the Nonconformities tab reaches a detail page whose heading is the allocated
   number.
4. Pressing **Send for verification** on an empty record shows a message containing at least two
   semicolon-separated clauses — the whole list, which is §9's requirement, measured rather than
   asserted by eye.
5. No console error on any of those steps (`e2e/fixtures/console.ts` is how the existing specs do
   this).

- [ ] **Step 2: Run every gate in the repository**

```bash
npm run typecheck && npm run lint
npm test
npm run typecheck:functions && npm run lint:functions
npm run verify:imports
npm run build && npm run verify:bundle
npm run verify:nc-numbering
npm run verify:nc-lifecycle
npm run test:e2e
```

Expected: all pass.

**`npm run verify:schema` will fail** on `samples.grind_purpose` and `samples.outside_limit_flag`,
and may now also fail on the new NC columns. That is the stale local check database — it predates
migration 0043 and rebuilding it is blocked by **open decision D-12**
(`scripts/verify-migrations.sh` fails at 0039 because the 0039 probe asserts on rows the seed
inserts afterwards). Confirm it is that and not something new:

```bash
psql -t -A -d bff_migration_check -c "select count(*) from information_schema.columns where table_name='samples' and column_name='grind_purpose';"
```

Expected: `0`. A non-zero answer means the database was rebuilt and the failure is real.

- [ ] **Step 3: Re-read the specification and check the coverage map against it**

Open the spec. Enumerate every numbered clause, bullet and stated rule, §1 to §11. For each, find
its row in this plan's coverage map and confirm the named task **actually delivers it**.

Checking the plan against its own map answers a different question and always answers yes. The map
is the artefact; this enumeration is what makes it a check.

Write the outcome into the plan as an amendment: every clause either delivered, deferred to the
named plan, or out of scope. **A clause with no row is a defect in this plan** — add the task.

- [ ] **Step 4: Dispatch an independent review pointed at the spec**

The same mechanism that found twelve real defects in phase 1 after every gate was green. The
reviewers get the **specification**, the live schema and the files, and are told the plan may be
wrong and shares an author with the review. Lenses worth running here:

- **spec coverage** — every clause, especially the ones stated in prose rather than in a list;
- **permission reachability** — a control offered that the RPC refuses, or refused that it allows,
  and whether `useAuthority` vs `useAccess` was used in the right place;
- **the refusal path** — can every one of the twenty `BFF_` names reach a screen with its own
  words, and what does an unmapped one look like;
- **can the proofs fail** — the usual list: a negative assertion whose precondition vanished, a
  loop that could iterate zero times, a mock asserting on a value it also supplied.

Each finding gets an adversarial verification pass before it is believed, and the refuted list is
**re-screened after the confirmed fixes land** — in phase 1 a refutation rested on a property that
one of the confirmed fixes removed, and the finding turned out to be real.

- [ ] **Step 5: Finish the branch**

Announce: "I'm using the finishing-a-development-branch skill to complete this work."
**REQUIRED SUB-SKILL:** `superpowers:finishing-a-development-branch`.

Note for the executor: migrations applied to the hosted project exist in the database before they
exist on `main`. Say so when presenting the options — the repository is behind the database until
this merges, and that mismatch is worth stating out loud rather than leaving for somebody to find.

---

## Self-review of this plan

Run before execution begins, per `writing-plans`.

**1. Spec coverage.** Every clause of §1–§11 has a row in the coverage map above: a task, a
deferral naming Plan 3 or Plan 4, or out-of-scope with a reason. The three deferrals are
`nc_attachments` + Storage (Plan 3) and the hold hook + its same-transaction probe (Plan 4). Two
clauses are out of scope and say why: D-09's policy ratification and watching whether hold counts
fall are both decisions for the plant, not code.

**2. Placeholder scan.** No "TBD", no "add appropriate error handling", no "similar to Task N". Two
tasks describe code by table rather than quoting it in full — Task 3's seven remaining specs and
Task 6's module body — and both give the exact body fields, argument interfaces, RPC constants and
function signatures, with one spec written out in full as the pattern. That is a deliberate trade
against repeating 400 lines of near-identical code; if the executor finds it insufficient, that is
a defect in this plan and not in their reading of it.

**3. Type consistency.** Three similar names, deliberately distinct, and the review caught the
plan importing one of them from the wrong module:

| Name | What it is | Where it lives |
| --- | --- | --- |
| `NcAction` | the Edge-side act vocabulary | `supabase/functions/_shared/actions.ts` |
| `NcActionKind` | the same eight names, client side | `src/hooks/useNonconformities.ts` |
| `NcActionForBand` | an assigned action, for the band calculation | `src/lib/ncBands.ts` |

`NC_ACTIONS` is the Edge vocabulary; `NC_BANDS` is the band list; `NC_ACTION_COLUMNS` is the select
string for the `nc_actions` table. The plan originally imported `NcAction` into the client hook
from `@/lib/ncBands`, which defines no such type — a wrong import that would have failed to
resolve. The client declares its own union, which is the direction `actions.ts` says its other four
vocabularies came from.

**4. Two claims this plan made and got wrong, corrected before it shipped.** The self-review was
run as a grep over every name the plan asserts, not as a read-through, and it found two: the plan
imported `edgeErrorMessage` from `@/hooks/useSamples` (it is declared in and exported from `@/lib/supabase`
only — `useSamples.ts:18` merely imports it and does not re-export it, so the import as written
would not resolve), and it mocked a hook called
`useFlaggedSamples`, which does not exist — the real one is `useFlagged(band, page)` and it returns
`{ rows, total }`, not an array. Both would have been pasted into the repository by whoever
executed the plan. Verifying a name costs one grep; a wrong one costs an executor a debugging
session on code they did not write.

**5. What this plan does not prove.** It adds no probe for the hold → nonconformity transaction
(§9 item 3) because the hook is Plan 4. It adds no test that reading is refused to a signed-out
browser, because `RequirePermission` and RLS are established mechanisms with their own coverage.
And no unit test can distinguish `useAuthority().allows` from `useAccess().can`, which is why Task
8 Step 6 says so in writing instead of relying on a reviewer to notice.
