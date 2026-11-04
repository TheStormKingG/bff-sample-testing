# Nonconformity and corrective action — design

**Date:** 2026-11-04
**Status:** approved for planning
**Decided with:** Bounty Farm (Stefan Gravesande), 2026-11-04

---

## 1. What this is for

ISO 9001 clause 10.2 requires that when a nonconformity occurs the organisation
reacts to it, evaluates whether action is needed to stop it recurring, takes
that action, and reviews whether it worked. Today none of that exists in this
application. A hold stops material and a disposition records a decision about
it, but nothing records **what went wrong, why, what was done, and whether it
worked**.

This spec covers that: raising a nonconformity, investigating it, assigning and
tracking corrective actions with deadlines, and verifying effectiveness before
closure.

### Explicitly not in this spec

Two capabilities were asked for and are deliberately held back, each to its own
spec. Neither is deferred indefinitely; both follow this one.

**Email and push notification.** This application cannot send email at all.
That is a standing constraint, documented in `src/lib/supabase.ts`,
`src/pages/LoginPage.tsx` and `src/pages/ChangePasswordPage.tsx`: there is no
custom SMTP and Supabase's shared sender only reaches members of the Supabase
organisation. An assignment email would go nowhere, silently. Making it work
means choosing a sender, configuring credentials, and deciding what a failed
delivery means in a quality system — an application-wide capability, not a
feature of this subsystem. It is worth doing on its own terms, because the same
work removes the current practice of an administrator typing a temporary
password that two people then know.

**Trend dashboards.** There are zero nonconformity records today, so an
analytics screen over them would be built against imagined data and rebuilt
against real data. Measurement trends (urease, mycotoxin, DGM, moisture over
time) are a different thing again and belong with the Dashboard's Reports tab.

### What this spec resolves

Open decision **D-09** asks whether a machine setting outside its range makes
*material* non-conforming. It does not. Until now there was nowhere to put a
process deviation, so the only available response was a quality hold on feed
that may be perfectly good. The `classification` field below gives it a home:
a mis-set roll gap raises a **process** nonconformity against the equipment and
does not drag a Quality Supervisor into a release decision about an engineering
problem. D-09 still needs formal ratification; the model no longer forces the
wrong answer in the meantime.

---

## 2. Data model

### `nonconformities`

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid pk | |
| `nc_number` | text unique | `NC-2026-001`. Allocated server-side. See §6. |
| `status` | enum `nc_status` | `open` · `awaiting_verification` · `closed` · `voided` |
| `classification` | enum `nc_classification` | `product` · `process` · `system` · `supplier` · `customer_complaint`. Null until the first gate. |
| `severity` | enum `nc_severity` | `major` · `minor`. Null until the first gate. |
| `title` | text not null | |
| `description` | text not null | What happened. |
| `sample_uuid` | uuid null → `samples` | Set when raised from a sample. |
| `hold_id` | uuid null → `holds` | Set when auto-raised by a hold. |
| `recurrence_of` | uuid null → `nonconformities` | Makes "this is the third time" queryable. |
| `detected_by` | uuid not null → `profiles` | |
| `detected_at` | timestamptz not null | Server-set. |
| `correction` | text null | The immediate fix. Required at the first gate. |
| `root_cause` | text null | Required at the first gate **only when `ca_required`**. |
| `root_cause_method` | enum `nc_rc_method` null | `five_whys` · `other` |
| `five_whys` | text[] null | Successive answers. Length is not fixed at five. Must hold at least one entry when `root_cause_method = 'five_whys'`. |
| `ca_required` | boolean null | The ISO 10.2.1(b) evaluation. Null until decided. |
| `ca_rationale` | text null | Required at the first gate **whichever way it was decided**. |
| `verified_by` | uuid null → `profiles` | |
| `verified_at` | timestamptz null | |
| `verification_note` | text null | |
| `self_verified` | boolean null | Computed and stamped at closure. See §5. |
| `void_reason` | text null | Required to void. |
| `revision` | integer not null | Optimistic concurrency, as `samples` uses. |
| `created_at` / `updated_at` | timestamptz | |

**Severity has an objective test**, not a judgement: **major** means
non-conforming feed left the mill, or could affect bird health; **minor** is
everything else. Two values with a decidable rule beats three with a matter of
taste, which is how severity fields become uniformly major.

### `nc_actions`

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid pk | |
| `nc_id` | uuid not null → `nonconformities` | |
| `description` | text not null | |
| `assigned_to` | uuid not null → `profiles` | |
| `due_date` | date not null | Plant-local. |
| `completed_at` | timestamptz null | |
| `completed_by` | uuid null → `profiles` | |
| `completion_note` | text null | Required to complete. |
| `created_by` / `created_at` | | |

**An action must be reassignable.** `assigned_to` can be changed while the
action is incomplete, with the change audited. Without this, an action owned
by somebody who has left the company can never be completed and never
cleared, and the nonconformity holding it can never reach its first gate —
a row stuck in a warning state that no action anybody takes will clear. The
same trap was found in the specification lifecycle, where `reference_only`
had no outgoing transition at all; a list with permanently unclearable items
stops being read, which costs more than the stuck row.

### `nc_attachments`

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid pk | |
| `nc_id` | uuid not null → `nonconformities` | |
| `storage_path` | text not null | `{nc_id}/{uuid}.{ext}` in a private bucket. |
| `filename` | text not null | As uploaded, for the reader. |
| `content_type` | text not null | Images and PDF only. |
| `size_bytes` | integer not null | Capped at 10 MB. |
| `caption` | text null | |
| `uploaded_by` / `uploaded_at` | | |

### `nc_number_sequence`

`year` (int, pk) and `last_number` (int). One row per plant-local year, written
only by the allocation statement in §6.

### Storage

A private Supabase Storage bucket `nc-attachments`, readable by anyone holding
`sample.view` and writable by `nc.raise` / `nc.act`. Attachments may be removed at
any point before closure, audited like any other change; once closed they are
frozen with the rest of the record.

---

## 3. States and gates

```
open ──────────────► awaiting_verification ──────────────► closed
  │                            │                             ▲
  └────────► voided ◄──────────┘                          (terminal)
```

**Open → Awaiting verification** requires all of:

- `classification` set
- `severity` set
- `correction` non-empty
- `ca_required` decided (true or false)
- `ca_rationale` non-empty — **whichever way it was decided**
- if `ca_required`: `root_cause` non-empty, at least one action exists, and
  every action is complete

Actions may be added whichever way `ca_required` was decided — recording a
follow-up on a nonconformity that needed no systemic action is legitimate. The
gate only *requires* them when `ca_required` is true. Any action that exists
must be complete before the gate passes, regardless.

**Awaiting verification → Closed** requires `verification_note` non-empty, and
stamps `verified_by`, `verified_at` and `self_verified`.

**Void** requires `void_reason` and is available from `open` **or**
`awaiting_verification`. A nonconformity raised on a mis-read can be
discovered at verification, and closing it as though it were legitimate would
put a fiction in the record.

**Closed is terminal and frozen.** Editable while open, immutable once closed —
the rule `specification_versions` already follows. A recurrence is a *new*
nonconformity carrying `recurrence_of`, not a reopening.

### Why "none needed" is a first-class outcome

ISO 10.2.1(b) requires evaluating the *need* for action, not taking one every
time. A system that cannot record "evaluated, not required, because…" produces
invented corrective actions written to satisfy a mandatory field — dozens of
"operator retrained" entries that nobody believes and nobody verifies. Hence
`ca_required` as a boolean with a mandatory rationale either way.

---

## 4. Authority

Three new permissions in `src/lib/roles.ts`:

| Permission | Roles | Covers |
| --- | --- | --- |
| `nc.raise` | operator, quality_officer, quality_supervisor | Open a nonconformity. |
| `nc.act` | quality_officer, quality_supervisor | Correction, root cause, CA evaluation, add and complete actions, attachments. |
| `nc.close` | quality_supervisor | Verify, close, void. |

Operators hold `nc.raise` because they already hold `hold.raise`, and a hold
creates a nonconformity (§7) — they must be able to raise what their own action
creates.

Reading reuses `sample.view` rather than adding a fourth permission: anyone who
may read a sample may read a nonconformity, auditors included.

Every mutation goes through a `SECURITY DEFINER` RPC that checks the permission,
records the authority basis and writes an audit event, as every other write in
this application does. The permission list gates what is *offered*;
`RequirePermission` and RLS gate what is *reached*.

---

## 5. Derived values

Nothing in this section is stored except where stated, so nothing can be edited
to look better than it is. This follows the rule set for the Flagged sample
bands on 2026-11-03.

**Overdue** — an action with `completed_at is null AND due_date <` plant-local
today. Never stored.

**Band**, on the Nonconformities tab — `Overdue` · `Open` ·
`Awaiting verification`, derived from status and the actions. Severity is a
column and a filter, *not* a band, so both Flagged tabs follow the same rule.

**`self_verified`** — true when `verified_by` is also `detected_by`, or is the
`completed_by` of any of the nonconformity's actions. Computed at closure and
**stamped**, because the record must still say so years later even if the
surrounding data moves. When true, the record says on its face that it was
verified by the person who did the work.

This is deliberate. Requiring a different verifier would deadlock a two-person
quality team the first time one person both investigates and fixes something,
and the workaround would be signing as each other — which is worse than a
visible label. It is the same approach already taken where both specification
approvers are the same person.

---

## 6. Numbering

`NC-{year}-{sequence}`, where `year` is the **plant-local** year of detection
(America/Guyana), consistent with every other date in this application, and
`sequence` is zero-padded to three digits and restarts each year.

Allocation uses a dedicated table and a single atomic statement:

```sql
insert into public.nc_number_sequence (year, last_number)
values (p_year, 1)
on conflict (year) do update
  set last_number = public.nc_number_sequence.last_number + 1
returning last_number;
```

`max(nc_number) + 1` is **not** acceptable. Two concurrent raises read the same
maximum and issue the same number, and it will never reproduce in single-user
testing. §9 requires a test that proves the allocation under concurrency.

---

## 7. A hold always raises a nonconformity

Policy decision, 2026-11-04: held material means product did not conform, so a
record is mandatory. `rpc_raise_hold` creates the nonconformity **in the same
transaction** — neither can exist without the other.

The created record has `title` and `description` pre-filled from the hold's
reason, `detected_by` set to whoever raised the hold, `sample_uuid` and
`hold_id` linked, and status `open`.

**`classification` and `severity` are left unset, not guessed.** They are
required at the first gate, which is the moment somebody is actually thinking
about it. Guessing them at the mill would fill the field with defaults nobody
chose.

**Raising a hold must remain one action.** The known failure mode of mandatory
paperwork is that people stop raising holds, or clear them quickly to close the
record — both worse than no hold at all. If raising a hold ever costs more than
it does today, this policy has backfired and should be revisited.

---

## 8. Screens

**Flagged gains a second tab.** The screen becomes `Samples | Nonconformities`,
each with its own bands. This keeps the bottom bar at five destinations — the
limit set on 2026-11-03 because that is what fits a phone at a finger's width —
and keeps one screen answering "what needs me?", which was the point of merging
three lists into Flagged in the first place.

The Nonconformities tab: chips `All · Overdue · Open · Awaiting verification`
with counts, over a table of NC number, title, classification, severity, linked
sample, next due date and status.

**NC detail** at `/nc/:id`, laid out in the order the work happens: the problem
and where it was detected, the correction, root cause, the corrective-action
evaluation, the actions with owners and due dates, attachments, then
verification. Sections above the reader's permission are **visible but not
editable**, so everyone can see what the next person has to do.

**Three ways in:** a button on a flagged sample, which pre-fills the link and
carries its results; "Raise a nonconformity" on the tab, for standalone ones;
and automatically from a hold. Sample detail gains a list of its
nonconformities.

---

## 9. Failure handling and verification

**Gate refusals name what is missing.** Not "validation failed" but
*"Cannot send for verification: corrective action has not been evaluated, and
2 of 3 actions are incomplete."* A gate that will not say why is a gate people
route around.

**Concurrent edits** are refused, not merged. A nonconformity is a working
document two people may have open; `revision` and the optimistic-concurrency
check `samples` already uses mean the second save is refused rather than
silently overwriting the first.

### What the migration must prove

A rolled-back probe against the real database, the pattern established by
migrations 0040, 0045 and 0047, proving four things that cannot be proved any
other way:

1. each gate **refuses** when a required field is missing, and passes when it
   is present
2. **two simultaneous raises receive different numbers.** The probe must use
   two genuinely concurrent sessions. Two inserts inside one transaction test
   nothing about concurrency — the transaction boundary, not the author's
   intent, decides which case a probe actually exercised.
3. raising a hold creates its nonconformity **in the same transaction**, so
   neither can exist without the other
4. a **closed nonconformity cannot be edited**

### Unit and contract tests

Derived logic — overdue, `self_verified`, band assignment — each with a control
proving the assertion can fail. The new RPCs must appear in
`tests/rpcContract.test.ts`. Gate refusal messages are asserted by text, because
their wording is the feature.

---

## 10. Build order

1. **Schema, RPCs and probes.** No UI. The migration proves itself.
2. **Read screens.** The Nonconformities tab and the detail page.
3. **Raise, act and close flows**, including attachments.
4. **The hold → nonconformity hook, last.**

Step 4 changes a live safety path. It goes in only once the machinery it
depends on is proven, not while that machinery is still moving.

---

## 11. Consequences to watch

- **D-09 is resolved in model but not in policy.** Somebody still has to ratify
  that a setting out of range is a process nonconformity and not a product one.
- **Mandatory nonconformities on holds change behaviour at the mill.** If hold
  counts fall after this ships, that is a signal to investigate, not a success.
- **`self_verified` will be true on most records initially**, because there are
  two quality people. That is the honest state of the control and is why it is
  recorded rather than hidden.
