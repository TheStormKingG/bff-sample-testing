# Nonconformity & corrective action — Phase 1 (database) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and prove the complete database layer for nonconformity and
corrective action — schema, numbering, RLS, and every mutation RPC with its
gates — so that the screens in Phase 2 have a correct, tested surface to call.

**Architecture:** Two tables (`nonconformities`, `nc_actions`) plus a
`nc_number_sequence` allocator, following this project's established shape:
constraints in the schema, `SECURITY DEFINER` RPCs as the only write path,
`record_audit_event` on every mutation, and a rolled-back probe inside the
migration that proves behaviour against the real database before anything
ships.

**Tech Stack:** PostgreSQL 17 (Supabase), plpgsql, TypeScript (Deno Edge
Functions), Vitest.

---

## Scope of THIS plan

This plan is **Phase 1 of the spec's four-phase build order (spec §10)**: the
database layer only. No UI.

Phases 2–4 (read screens, write flows, attachments, the hold hook) get their
own plan, written once this lands. That is not padding the schedule — it is
Rule 5 of `superpowers-plan-extras`: *"A plan written before the
implementation is, by construction, oldest exactly where it is most
specific."* UI task code authored now would reference generated types, hook
signatures and column names that do not exist yet, and every literal in it
would need re-deriving before use. The database layer has no such dependency,
which is why it can be specified exactly and why it goes first.

**Phase 1 produces working, testable software**: a complete nonconformity
backend, exercisable through its RPCs and proven by its own probes.

---

## What has already been executed

Per Rule 1 (dry-run an irreversible change before applying it) and Rule 5
(execute the plan's code/test pair before the plan ships), the schema in
Task 1 and the allocator in Task 2 were **run against the live database inside
a rolled-back transaction** before this plan was written. Seven assertions
passed, including three refusal assertions each written with both halves — the
attempt *and* a post-condition query proving the state did not change.

The instrument was then validated at **both ends**, because an assertion
script short-circuits and the later assertions are the ones that go
unchecked:

| Control | Mutation | Result |
| --- | --- | --- |
| First assertion | expected number changed to `NC-2026-999` | fired `A1 first number was …` |
| Last assertion | `nc_closed_is_verified` weakened to `check (true or …)` | fired `A7 closed without verification was accepted` |

Residue check after rollback: `select count(*) from pg_type where typname like 'nc_%'` → **0**.

The code blocks in Tasks 1 and 2 are that executed text. They are not a
proposal.

---

## Spec-coverage map

Every clause of
`docs/superpowers/specs/2026-11-04-nonconformity-corrective-action-design.md`,
decomposed. A clause with no entry is a plan defect, not a scope decision.

| Spec clause | Entry |
| --- | --- |
| §1 purpose — react, evaluate, act, review | Tasks 3–8 collectively |
| §1 out of scope — email/push | **Out of scope, reason:** no SMTP exists; own spec |
| §1 out of scope — trend dashboards | **Out of scope, reason:** zero records; own spec |
| §1 D-09 resolution via `classification` | Task 1 (enum), Task 3 (set at gate) |
| §2 `nonconformities` columns | Task 1 |
| §2 `nc_number` format + uniqueness | Task 1 (constraint), Task 2 (allocator) |
| §2 severity objective test (major/minor) | Task 1 (enum); wording is UI → **deferred: plan 2** |
| §2 `nc_actions` columns | Task 1 |
| §2 **action reassignable** | Task 6 (`rpc_reassign_nc_action`) |
| §2 `nc_number_sequence` | Task 1 (table), Task 2 (allocator) |
| §2 `nc_attachments` + storage bucket | **Deferred: plan 2, Phase 3** |
| §3 gate 1 — all six preconditions | Task 7 |
| §3 gate 2 — verification note, stamps | Task 8 |
| §3 void from `open` **or** `awaiting_verification` | Task 8 |
| §3 closed is terminal and frozen | Task 1 (trigger guard) |
| §3 recurrence via `recurrence_of`, not reopening | Task 1 (column); UI → **deferred: plan 2** |
| §3 actions permitted when `ca_required` false; any that exist must complete | Task 7 |
| §4 three permissions | Task 9 |
| §4 reading reuses `sample.view` | Task 4 (RLS) |
| §4 every mutation through a SECURITY DEFINER RPC with audit | Tasks 5–8 |
| §5 overdue derived, never stored | Task 1 (no column); query → **deferred: plan 2** |
| §5 bands derived | **Deferred: plan 2** |
| §5 `self_verified` computed **and stamped** at closure | Task 8 |
| §6 numbering: atomic upsert, `max+1` forbidden | Task 2 |
| §6 plant-local year | Task 2 |
| §6 **concurrency proven with real sessions** | Task 3 |
| §7 hold raises NC in the same transaction | **Deferred: plan 2, Phase 4** |
| §8 screens | **Deferred: plan 2** |
| §9 gate refusals name what is missing | Tasks 7, 8 (message text asserted) |
| §9 concurrent edits refused via `revision` | Task 5 |
| §9 migration probe — 4 required proofs | Tasks 1 (3, 4), 3 (2), 7 (1) |
| §9 new RPCs in `rpcContract.test.ts` | Task 9 |
| §10 build order | This plan's task order |
| §11 D-09 needs policy ratification | **Out of scope, reason:** a decision, not code |
| §11 hold counts falling is a signal | **Out of scope, reason:** operational, not code |
| §11 `self_verified` true initially | Task 8 (no mitigation; it is the honest state) |

**Cardinality clauses, both directions** (coverage-map.md §3):

| Clause | Positive test | Negative test |
| --- | --- | --- |
| `nc_number` is **unique** | Task 2 A1–A3 allocate distinct | Task 1 A4 refuses malformed; unique constraint |
| a sample sits in **exactly one** band | — | **Deferred: plan 2** |
| gate 1 requires **every** action complete | Task 7 passes with all complete | Task 7 refuses with one incomplete |
| void available from **two** states only | Task 8 allows both | Task 8 refuses from `closed` |

**Call-path sweep** (coverage-map.md §4) — every symbol this plan introduces
and the task that consumes it:

| Symbol | Defined | Consumed by |
| --- | --- | --- |
| `allocate_nc_number` | Task 2 | Task 5 (`rpc_raise_nonconformity`) |
| `tg_nonconformities_guard` | Task 1 | trigger on the table (entry point) |
| `rpc_raise_nonconformity` | Task 5 | Edge handler, plan 2 — **entry point for now** |
| `rpc_update_nonconformity` | Task 5 | Edge handler, plan 2 |
| `rpc_add_nc_action` / `_complete_` / `_reassign_` | Task 6 | Edge handler, plan 2 |
| `rpc_submit_nc_for_verification` | Task 7 | Edge handler, plan 2 |
| `rpc_close_nonconformity` / `rpc_void_nonconformity` | Task 8 | Edge handler, plan 2 |

Every RPC's consumer is in plan 2. That is stated rather than left implicit,
because a symbol nothing calls passes all its own tests — the specific trap
Rule 3 names.

---

## File structure

| File | Responsibility |
| --- | --- |
| `supabase/migrations/0048_nonconformity_schema.sql` | Enums, tables, constraints, the freeze guard, the allocator, and the rolled-back probe |
| `supabase/migrations/0049_nonconformity_rls.sql` | RLS policies and grants |
| `supabase/migrations/0050_nonconformity_rpcs.sql` | All eight RPCs and their probes |
| `src/lib/roles.ts` | Three new permissions and their role mapping |
| `tests/ncNumbering.test.ts` | Numbering format and the concurrency proof |
| `tests/rpcContract.test.ts` | Existing — gains the eight new RPCs |

Three migrations rather than one, split by what each can prove on its own:
schema shape, access, behaviour. A single migration would make the probe at
the end the only evidence for all three.

---

## Task 1: Schema, constraints and the freeze guard

**Files:**
- Create: `supabase/migrations/0048_nonconformity_schema.sql`

**Review reference (Rule 2):** check this task against **spec §2 and §3**, and
against the live schema (`information_schema.columns` for `samples`, `holds`,
`profiles`) — *not* against the code block below. The plan may be wrong and
shares an author with its review.

- [ ] **Step 1: Write the enums and tables**

The text below is the executed dry-run DDL with the `pg_temp` probe line
removed. Do not retype it from memory; copy it.

```sql
create type public.nc_status         as enum ('open','awaiting_verification','closed','voided');
create type public.nc_classification as enum ('product','process','system','supplier','customer_complaint');
create type public.nc_severity       as enum ('major','minor');
create type public.nc_rc_method      as enum ('five_whys','other');

create table public.nc_number_sequence (
  year        integer primary key,
  last_number integer not null
);

create table public.nonconformities (
  id                uuid primary key default gen_random_uuid(),
  nc_number         text not null unique,
  status            public.nc_status not null default 'open',
  classification    public.nc_classification,
  severity          public.nc_severity,
  title             text not null,
  description       text not null,
  sample_uuid       uuid references public.samples(id),
  hold_id           uuid references public.holds(id),
  recurrence_of     uuid references public.nonconformities(id),
  detected_by       uuid not null references public.profiles(id),
  detected_at       timestamptz not null default now(),
  correction        text,
  root_cause        text,
  root_cause_method public.nc_rc_method,
  five_whys         text[],
  ca_required       boolean,
  ca_rationale      text,
  verified_by       uuid references public.profiles(id),
  verified_at       timestamptz,
  verification_note text,
  self_verified     boolean,
  void_reason       text,
  revision          integer not null default 1,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint nc_number_shape check (nc_number ~ '^NC-[0-9]{4}-[0-9]{3,}$'),
  constraint nc_verification_pair check ((verified_by is null) = (verified_at is null)),
  constraint nc_closed_is_verified check (
    status <> 'closed' or (verified_by is not null
                           and length(btrim(coalesce(verification_note,''))) > 0
                           and self_verified is not null)),
  constraint nc_voided_has_reason check (
    status <> 'voided' or length(btrim(coalesce(void_reason,''))) > 0),
  constraint nc_five_whys_present check (
    root_cause_method is distinct from 'five_whys'
    or (five_whys is not null and array_length(five_whys,1) >= 1))
);

create table public.nc_actions (
  id              uuid primary key default gen_random_uuid(),
  nc_id           uuid not null references public.nonconformities(id) on delete restrict,
  description     text not null,
  assigned_to     uuid not null references public.profiles(id),
  due_date        date not null,
  completed_at    timestamptz,
  completed_by    uuid references public.profiles(id),
  completion_note text,
  created_by      uuid not null references public.profiles(id),
  created_at      timestamptz not null default now(),
  constraint nc_action_completion_pair check (
    (completed_at is null) = (completed_by is null)),
  constraint nc_action_complete_has_note check (
    completed_at is null or length(btrim(coalesce(completion_note,''))) > 0)
);

create index nc_status_idx        on public.nonconformities (status);
create index nc_sample_idx        on public.nonconformities (sample_uuid) where sample_uuid is not null;
create index nc_actions_due_idx   on public.nc_actions (due_date) where completed_at is null;
```

- [ ] **Step 2: Write the freeze guard (spec §3, "closed is terminal and frozen")**

```sql
create function public.tg_nonconformities_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'A nonconformity is a quality record and cannot be deleted. Void it instead.'
      using errcode = '23514';
  end if;

  -- Frozen once closed or voided. Editable while open or awaiting verification,
  -- because it is a working document until somebody decides it is finished.
  if old.status in ('closed','voided') then
    raise exception 'Nonconformity % is % and cannot be changed. A recurrence is a new record.',
      old.nc_number, old.status using errcode = '23514';
  end if;

  -- The identity of the record never moves, whatever its state.
  if new.id is distinct from old.id
     or new.nc_number is distinct from old.nc_number
     or new.detected_by is distinct from old.detected_by
     or new.detected_at is distinct from old.detected_at
     or new.created_at is distinct from old.created_at then
    raise exception 'The identity of nonconformity % is immutable', old.nc_number
      using errcode = '23514';
  end if;

  -- Only these lifecycle moves exist.
  if new.status is distinct from old.status then
    if not (
         (old.status = 'open' and new.status in ('awaiting_verification','voided'))
      or (old.status = 'awaiting_verification' and new.status in ('closed','voided','open'))
    ) then
      raise exception 'A nonconformity cannot move from % to %', old.status, new.status
        using errcode = '23514';
    end if;
  end if;

  new.updated_at := now();
  return new;
end $$;

create trigger nonconformities_guard
  before update or delete on public.nonconformities
  for each row execute function public.tg_nonconformities_guard();
```

Note `awaiting_verification → open` is permitted: a verifier who finds the
work incomplete must be able to send it back, and without that move the
record is stuck in a state no action can clear — the trap observation 0805
records from the specification lifecycle.

- [ ] **Step 3: Append the probe (the executed assertions)**

Copy assertions A1–A7 from the executed dry run, verbatim, into a trailing
`do $$ … raise exception 'BFF_0048_ROLLBACK' … $$;` block, preceded by the
allocator from Task 2. Each refusal assertion keeps **both halves** — the
attempt wrapped in a handler, and a post-condition query proving the state did
not change. A bare attempt is not an assertion; it terminates the block on the
success of the thing being tested.

- [ ] **Step 4: Apply and verify**

```bash
python3 -I scripts/apply-remote-migrations.py ydvgxsbymnnidenkrvin --from=0048
```

Expected: `ok 0048_nonconformity_schema.sql`.

- [ ] **Step 5: Confirm the probe left nothing**

```bash
echo "select count(*) as rows from public.nonconformities;" | python3 -I <scratch>/q.py
```

Expected: `[{"rows":0}]`.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/0048_nonconformity_schema.sql
git commit -m "Nonconformity schema, with the lifecycle a stuck record can leave"
```

---

## Task 2: The number allocator

**Files:**
- Modify: `supabase/migrations/0048_nonconformity_schema.sql`

**Review reference (Rule 2):** **spec §6**, which forbids `max+1` by name.

- [ ] **Step 1: Write the allocator**

```sql
create function public.allocate_nc_number(p_year integer)
returns text language plpgsql set search_path = '' as $$
declare v_next integer;
begin
  insert into public.nc_number_sequence (year, last_number)
  values (p_year, 1)
  on conflict (year) do update
    set last_number = public.nc_number_sequence.last_number + 1
  returning last_number into v_next;
  return 'NC-' || p_year::text || '-' || lpad(v_next::text, 3, '0');
end $$;

revoke all on function public.allocate_nc_number(integer) from public, anon, authenticated;
```

One statement. `max(nc_number)+1` reads a value another session is about to
write and is the specific failure spec §6 rules out.

- [ ] **Step 2: Verify the three allocation assertions pass**

A1 (`NC-2026-001`), A2 (`NC-2026-002`), A3 (`NC-2027-001`) are already in the
probe from Task 1 Step 3. Apply and confirm `ok`.

- [ ] **Step 3: Commit** — amend into Task 1's commit; the allocator is part of the same migration.

---

## Task 3: Prove the numbering under real concurrency

**Files:**
- Create: `tests/ncNumbering.test.ts`

**Review reference (Rule 2):** **spec §6** and `plan-extras` Rule 1 — *a
probe's transaction boundary decides which case it tested.*

This is its own task because **it cannot be done inside the migration.** Two
inserts in one transaction do not test concurrent allocation; they test
sequential allocation in a way that looks identical in the output. Observation
0572 records exactly this.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';

/**
 * Two genuinely concurrent sessions must receive different numbers.
 *
 * Fired through two separate HTTP requests issued without awaiting each
 * other, because the transaction boundary — not the author's intent —
 * decides which case a probe exercises. The same two calls awaited in
 * sequence would pass on an implementation that allocates with max+1.
 */
it('allocates a distinct number to two concurrent sessions', async () => {
  const call = () => runSql(`select public.allocate_nc_number(2099) as n;`);
  const [a, b] = await Promise.all([call(), call()]);
  expect(a).not.toEqual(b);
});
```

- [ ] **Step 2: Run it against a `max+1` implementation to see it fail**

Temporarily replace the allocator body with
`select 'NC-' || p_year || '-' || lpad((coalesce(max(...),0)+1)::text,3,'0') from public.nonconformities`
and run. Expected: **FAIL**, both sessions returning the same number.

A test that has only ever been observed passing has not been tested.

- [ ] **Step 3: Restore the upsert allocator, run again**

Expected: PASS, two distinct numbers.

- [ ] **Step 4: Clean up year 2099 from `nc_number_sequence` and commit**

---

## Task 4: Row-level security

**Files:**
- Create: `supabase/migrations/0049_nonconformity_rls.sql`

**Review reference (Rule 2):** the **live** `samples` policies
(`pg_policy` where `relname='samples'`), which this must mirror — not the
block below.

- [ ] **Step 1: Enable RLS and write the read policy**

```sql
alter table public.nonconformities enable row level security;
alter table public.nc_actions      enable row level security;
alter table public.nc_number_sequence enable row level security;

-- Read: anyone who may read a sample may read a nonconformity (spec §4).
create policy nonconformities_select_viewers on public.nonconformities
  for select using (public.actor_has_permission(auth.uid(), 'sample.view'));
create policy nc_actions_select_viewers on public.nc_actions
  for select using (public.actor_has_permission(auth.uid(), 'sample.view'));

-- No INSERT, UPDATE or DELETE policy on any of the three. Every write goes
-- through a SECURITY DEFINER RPC holding the service role, exactly as
-- samples do. An absent policy denies by default, which is the intent.
```

- [ ] **Step 2: Prove the absence of a write path, both halves**

```sql
-- Attempt, then post-condition. A bare attempt aborts the block on the
-- success of the thing being tested and reads as a pass.
do $$
declare v_raised text; v_n integer;
begin
  set local role authenticated;
  begin
    insert into public.nonconformities (nc_number, title, description, detected_by)
    values ('NC-2026-999','x','x',(select id from public.profiles limit 1));
  exception when others then v_raised := sqlerrm;
  end;
  reset role;
  if v_raised is null then
    raise exception 'BFF_0049_WRITE: authenticated inserted a nonconformity directly'
      using errcode='22023';
  end if;
  select count(*) into v_n from public.nonconformities where nc_number='NC-2026-999';
  if v_n <> 0 then
    raise exception 'BFF_0049_WRITE_POST: the row exists anyway' using errcode='22023';
  end if;
end $$;
```

- [ ] **Step 3: Apply, confirm `ok`, commit**

---

## Task 5: Raise and update

**Files:**
- Create: `supabase/migrations/0050_nonconformity_rpcs.sql`

**Review reference (Rule 2):** **spec §4 and §9**, and the live
`rpc_propose_specification` definition, whose argument order, idempotency
handling and audit call this must follow.

- [ ] **Step 1: `rpc_raise_nonconformity`**

Signature follows the house pattern exactly — `p_actor`, `p_idempotency_key`,
`p_payload_hash`, `p_app_version`, then the domain arguments. It must:
`require_permission(p_actor,'nc.raise')`; `claim_mutation`; refuse an empty
title or description with `BFF_REASON_REQUIRED`-style named errors; allocate
the number with `allocate_nc_number(extract(year from (now() at time zone 'America/Guyana'))::int)`;
insert with `status='open'`; `record_audit_event`; `mark_mutation_committed`.

- [ ] **Step 2: `rpc_update_nonconformity`, with the revision check**

Takes `p_expected_revision`. Refuses with a named error when it does not match
the stored value, and increments on success. Spec §9: the second save is
refused, never merged.

- [ ] **Step 3: Probe both, rolled back**

Assertions, each with a post-condition where it is a refusal: a raise produces
a number matching `^NC-\d{4}-\d{3,}$`; a stale `p_expected_revision` is
refused and the row is unchanged; a correct one succeeds and bumps `revision`.

- [ ] **Step 4: Apply, confirm, commit**

---

## Task 6: Actions — add, complete, reassign

**Files:**
- Modify: `supabase/migrations/0050_nonconformity_rpcs.sql`

**Review reference (Rule 2):** **spec §2 (`nc_actions`, including the
reassignment paragraph)**.

- [ ] **Step 1:** `rpc_add_nc_action` — `nc.act`; refuses when the NC is not `open`.
- [ ] **Step 2:** `rpc_complete_nc_action` — `nc.act`; requires a completion note; refuses an already-complete action.
- [ ] **Step 3:** `rpc_reassign_nc_action` — `nc.act`; refuses on a **complete** action; audits the change of owner.

Spec §2: without reassignment an action owned by someone who has left can
never be completed and never cleared, and the nonconformity holding it can
never reach its first gate.

- [ ] **Step 4: Probe, including the reassignment-after-completion refusal with its post-condition**
- [ ] **Step 5: Apply, confirm, commit**

---

## Task 7: Gate 1 — submit for verification

**Files:**
- Modify: `supabase/migrations/0050_nonconformity_rpcs.sql`

**Review reference (Rule 2):** **spec §3**, which lists the six preconditions.
Check the count against the spec, not against the code.

- [ ] **Step 1: Write `rpc_submit_nc_for_verification`**

It collects **every** unmet precondition and names them all in one message
(spec §9), rather than failing on the first:

> `Cannot send for verification: corrective action has not been evaluated, and 2 of 3 actions are incomplete.`

Preconditions: `classification` set; `severity` set; `correction` non-empty;
`ca_required` not null; `ca_rationale` non-empty; and when `ca_required` is
true, `root_cause` non-empty and at least one action exists. **Any action that
exists must be complete regardless of `ca_required`** — spec §3.

- [ ] **Step 2: Probe each precondition separately**

**One negative control per precondition, not one per run.** The message builder
short-circuits nothing, but the *assertions* do: a single probe missing all
six fields proves only that the first was detected. Seven probes: six each
missing exactly one field, plus one complete record that passes.

- [ ] **Step 3: Assert the message text, not just the refusal**

The wording is the feature (spec §9). Assert that the message names the
missing field and, where actions are incomplete, carries the count.

- [ ] **Step 4: Apply, confirm, commit**

---

## Task 8: Gate 2 — close, and void

**Files:**
- Modify: `supabase/migrations/0050_nonconformity_rpcs.sql`

**Review reference (Rule 2):** **spec §3 and §5** (the `self_verified`
definition).

- [ ] **Step 1: `rpc_close_nonconformity`**

Requires `nc.close` and a non-empty note. Stamps `verified_by`, `verified_at`,
and computes:

```sql
v_self := (p_actor = v_nc.detected_by)
       or exists (select 1 from public.nc_actions a
                   where a.nc_id = v_nc.id and a.completed_by = p_actor);
```

Stored, not derived at read time — spec §5: the record must still say so years
later.

- [ ] **Step 2: `rpc_void_nonconformity`** — `nc.close`, requires a reason, allowed from `open` **or** `awaiting_verification`, refused from `closed`.

- [ ] **Step 3: Probe, four assertions each with its own control**

`self_verified` true when the closer completed an action; **false when a
different person closes** (the control — without it, a function hardcoded to
`true` passes); void succeeds from both permitted states; void refused from
`closed` with a post-condition.

- [ ] **Step 4: Apply, confirm, commit**

---

## Task 9: Permissions and contract

**Files:**
- Modify: `src/lib/roles.ts`
- Modify: `tests/rpcContract.test.ts`

**Review reference (Rule 2):** **spec §4**, and the live `pg_proc` catalogue.

- [ ] **Step 1: Add the three permissions**

```ts
'nc.raise',
'nc.act',
'nc.close',
```

Mapped: `operator` gains `nc.raise`; `quality_officer` gains `nc.raise` and
`nc.act`; `quality_supervisor` gains all three.

- [ ] **Step 2: Write the failing role test**

```ts
it('lets an operator raise a nonconformity but not close one', () => {
  const actor = { userId: 'u1', status: 'active' as const, roles: ['operator' as const] };
  expect(can(actor, 'nc.raise')).toBe(true);
  expect(can(actor, 'nc.close')).toBe(false);
});
```

The negative half matters: a role map that granted everything would pass the
positive assertion alone.

- [ ] **Step 3: Run — expect FAIL** (`'nc.raise'` is not assignable).
- [ ] **Step 4: Add the permissions; run — expect PASS.**
- [ ] **Step 5: Run `npx vitest run tests/rpcContract.test.ts`**

Expected: FAIL, naming the eight RPCs with no contract entry. Add them.

- [ ] **Step 6: Full gates and commit**

```bash
npm run typecheck && npx vitest run && npm run lint && npm run build && ./scripts/check-edge-functions.sh
```

---

## Pre-flight (the enforcement step)

1. **Irreversible change?** Yes — three migrations. The dry run is recorded
   above: executed against the live database, rolled back, seven assertions,
   two negative controls, zero residue. It asserts; it does not print. No step
   destroys the pre-state its own verification needs: every probe creates its
   own fixture inside the transaction it rolls back.
2. **Review references.** Named per task, all external — the spec, the live
   schema, the live policies, the live `pg_proc`. None is the plan's own code.
3. **Spec-coverage map.** Present above, every clause enumerated, conjunctions
   split, cardinality clauses mapped in both directions, call-path sweep
   naming the consumer of all eight RPCs. Clauses with no implementing task
   are marked deferred-with-destination (plan 2) or out-of-scope-with-reason.
4. **Shared fixtures.** No new test mutates an existing fixture: Task 3 uses
   year 2099 and cleans up; every SQL probe rolls back. Each new test has a
   stated red step — Task 3 against a `max+1` allocator, Task 9 against the
   absent permission.
5. **Code/test pairs executed?** Tasks 1 and 2 — yes, verbatim, with controls.
   Tasks 3–9 ship signatures and assertions rather than complete bodies, and
   are marked as such; their bodies are written and run during execution,
   which is where their literals can be derived from the source that exists by
   then.
6. **Reference files.** `coverage-map.md` loaded before the map was built.
   `test-failability.md` and `plan-snippets.md` **not yet loaded** — they fire
   for Tasks 3 and 9 and must be loaded at the start of those tasks, not now.
   Recorded here so their absence is visible rather than assumed.
7. **Instruments.** The dry run is validated at both ends (first and last
   assertion), which addresses the short-circuit failure mode. Task 7 requires
   one control per precondition — six, not one. Task 8 requires the
   `self_verified` **false** control, without which a hardcoded `true` passes.
8. **Absolute invariants across the sequence.** The one invariant this plan
   can break is "every record can reach a terminal state". Task 1 introduces
   the lifecycle and `awaiting_verification → open` in the same step, so no
   task in this plan leaves a record stuck. No removal is separated from its
   restoration.
9. **Agents / extracts.** None dispatched by this plan.
10. **A rejected class becoming intended?** No.
11. **Generated values between steps?** Task 3's numbers are compared to each
    other inside one test, never retyped across steps.
