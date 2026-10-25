# Administration guide

For the system custodian and for administrators. Read §1 first; it is the thing most
easily misunderstood about this application.

---

## 1. An Administrator has no quality authority

**An Administrator cannot approve a specification limit, cannot clear a quality hold, and
cannot release material.** This is not a UI restriction that a determined administrator
could work around. The role simply does not hold those permissions, the database enforces
the matrix, and every Edge Function re-checks it server-side and **records the attempt**
when it refuses.

The Administrator role holds exactly:

```
sample.view · user.manage · user.approve_access · sync.view · sync.retry
audit.view · report.view
```

It does **not** hold:

```
spec.approve · hold.clear · disposition.accept · disposition.reject
disposition.rework · disposition.override_release
```

The reason is a separation that a feed mill's quality system depends on: the person who
grants system access must not also be the person who decides that out-of-specification
material may be sold. An administrator who needs to make a quality decision needs a
**recorded, time-bounded delegation** from someone who holds the authority, or a second
account with a quality role — and that delegation is itself an auditable event.

The *Admin → Users and access* screen states this on the page, and it builds the
statement by reading `basePermissions('administrator')` **at render time**. If some future
edit ever granted the administrator role a quality permission, the banner reports it as a
fault and names the file to fix rather than quietly showing a longer list.

Two more exclusions work the same way:

- **A Quality Officer can RAISE a hold but cannot CLEAR one**, and cannot approve a
  specification. Raising a hold is the safe direction and needs no second signature;
  clearing one is a release decision.
- **`disposition.override_release` is granted to NO role at all.** It exists only as a
  delegation, and the database additionally refuses to grant it to a role through a CHECK
  against `delegation_only_permissions()`.

---

## 2. The role matrix

| Permission | Operator | Quality Officer | Quality Supervisor | Administrator | Auditor |
| --- | :-: | :-: | :-: | :-: | :-: |
| `sample.view` | ● | ● | ● | ● | ● |
| `sample.draft` | ● | ● | ● | | |
| `sample.register` | ● | ● | ● | | |
| `sample.enter_results` | | ● | ● | | |
| `sample.correct` | | ● | ● | | |
| `sample.void` | | | ● | | |
| `sample.review` | | ● | ● | | |
| `hold.raise` | ● | ● | ● | | |
| `hold.clear` | | | ● | | |
| `disposition.accept` | | | ● | | |
| `disposition.reject` | | | ● | | |
| `disposition.rework` | | | ● | | |
| `disposition.override_release` † | | | | | |
| `spec.propose` | | ● | ● | | |
| `spec.approve` | | | ● | | |
| `user.manage` | | | | ● | |
| `user.approve_access` | | | | ● | |
| `sync.view` | | ● | ● | ● | |
| `sync.retry` | | | | ● | |
| `audit.view` | | | ● | ● | ● |
| `report.view` | | ● | ● | ● | ● |
| `export.run` | | | ● | | |

† Held by **no role at all**. It exists only as a time-bounded delegation, and the
database refuses to grant it to a role through a CHECK against
`delegation_only_permissions()`.

Source: `BASE_PERMISSIONS` in `src/lib/roles.ts`, mirrored by `role_permissions` in
migration `0001_identity.sql`. The two were diffed mechanically during the build — 42 rows
each, identical. `tests/authority.test.ts` (66 tests) asserts the matrix, the
administrator's lack of quality authority, the officer's raise-but-not-clear asymmetry,
the delegation-only override and the segregation-of-duties checks.

**The copy in `src/lib/roles.ts` is not the security boundary.** It drives the UI so that
nobody is shown a button that will be refused. The boundary is RLS plus the Edge
Functions.

### Account statuses

| Status | Can sign in? | Sees data? |
| --- | --- | --- |
| `pending` | yes | **no** — a new Google identity lands here |
| `active` | yes | yes, per role |
| `suspended` | yes | **no** — reversible |
| `disabled` | yes | **no** — terminal |

Only `active` grants anything. `can()` returns false for every permission at any other
status, so suspending an account is immediate and complete without touching its roles.

---

## 3. Approving a new user

**Admin → Users and access**

1. A staff member signs in with Google. The account is created as `pending` and they see
   the *Access pending* screen. **They see no sample data at all** — the gate is RLS, so
   a deep link, a reload or a hand-built query all return nothing.
2. The pending account appears in the administrator's list with its Google email and
   sign-in time.
3. Click **Approve**, choose a role, confirm. The approval is recorded as an audit event
   with your identity, the instant and the role granted.
4. To change a role later, use **Assign role** on the active account. To remove access,
   set the status to `suspended` (reversible) or `disabled` (terminal). **Do not delete a
   profile** — quality records reference the person who created them.

**You cannot approve your own account.** `checkSeparationOfDuties` blocks it, the screen
says so in words rather than disabling a button with no explanation, and
`profiles_no_self_approval` enforces it in the database. The only exception is the
founding administrator, created by the one-shot bootstrap grant
(`docs/setup.md` §5).

**Approve deliberately.** Approval is the whole access-control decision. There is no
second gate, no email-domain allowlist and no self-service sign-up — because an
allowlist that silently admits anyone on a domain is weaker than a person reading a name.

---

## 4. Delegated authority

**Admin → Delegated authority**

A delegation grants **one permission** to **one person** for **a bounded period**. It is
how a Quality Officer covers a supervisor's absence without widening the role for
everyone (PRD §2: "segregation of duties is configurable").

1. Choose the person. **Only `active` accounts are offered** — delegating to a pending or
   suspended account would be inert, because `can()` returns false at any other status,
   and the server would refuse it too.
2. Choose the permission. `disposition.override_release` is marked as
   **delegation-only**: no role holds it, and this is the only way it can ever be held.
3. Set **effective from** and **effective to**. An open-ended delegation is possible but
   is almost always the wrong answer — write the date the cover ends.
4. Confirm. The delegation records who granted it; the grantor must themselves hold the
   permission.

Delegations are evaluated against the current instant on every check, so one expires
without anyone revoking it. Review the list monthly and before each access
recertification: an expired delegation is harmless, but a forgotten open-ended one is a
standing grant nobody decided to make.

---

## 5. Controlled lists

**Admin → Controlled lists**

The closed sets a form offers: materials (`corn`, `rice`, `soya`, `other`), sampling
points (`AM`, `BC`), mill screen sizes (`5`, `7`), suppliers and feed types.

Three operations are available, and they are exactly the three the server accepts:

- **Add** a value with a label.
- **Re-label** an existing value. The **code is never changed** — stored records
  reference the code, and renaming a code would silently re-point historical quality
  records. Change the label; leave the code.
- **Stop offering** a value: set it inactive. It disappears from new forms and stays
  resolvable on every record that already used it.

There is no delete and no sort-order editing. `AdminActionInput` exposes
`listKey`/`value`/`label`/`active` and nothing else, so the screen deliberately offers
nothing it cannot actually send.

**`suppliers` and `feed_types` ship empty.** That is a decision, not an omission.
Inventing a supplier name would put a fabricated party on a quality record, and the
registry's feed-type fields are free text with no published option list. Add the real
ones here once Bounty Farm supplies them (D-06).

---

## 6. Google Sheets sync health

**Admin → Google Sheets sync health**

### What the two honest states mean

| Shown on a sample | Means |
| --- | --- |
| *Recorded securely, Google Sheets sync pending* | Committed to the ledger. **The quality record exists and is durable.** Google has not confirmed. |
| *Confirmed in Google Sheets* | The worker wrote the row **and read it back**. |

There is no third state and no code path says "Saved to Google Sheets" for unsynced data.
A pending sync is **not** data loss and **not** a reason to re-enter the sample: entering
it again creates a second sample with a second id.

### The screen

- Pending, confirmed, failed and dead-lettered job counts.
- Per-job detail: sample id, stage, attempt count, last error, next attempt time.
- **Manual retry** for a failed or dead-lettered job. Needs `sync.retry`, which only the
  Administrator role holds.

### Reading it

| Symptom | What it means | What to do |
| --- | --- | --- |
| A few pending rows, counts falling | Normal. The worker is draining. | Nothing. |
| Pending rows not falling | The worker is not running, or cannot start. | Check the scheduler. Check `health`'s detail tier: it reports secret presence **by name only, as booleans** — a missing `SHEETS_SPREADSHEET_ID` or `GOOGLE_SERVICE_ACCOUNT_JSON` makes the worker refuse to run, by design. |
| A job with a rising attempt count | Transient Google errors. The backoff is working. | Watch. Do not retry manually; you will reset nothing useful. |
| **A dead letter** | A committed sample the spreadsheet does not show. **A quality-record integrity event.** | Investigate before retrying. `docs/recovery-runbook.md` §5. |
| `409 schema_drift` | Live row-4 headers no longer match the registry. **The writer has stopped on purpose.** | §7 below. Do not retry until the headers match. |
| `409 lease_conflict` | Two invocations overlapped; the second exited. | Nothing. This is the lease working. |

**Never hand-edit the spreadsheet to "fix" a sync problem.** It creates a discrepancy the
reconciler will report as drift, and it destroys the evidence of what actually happened.

---

## 7. Workbook schema verification

**Admin → Workbook schema check**

Compares the **live row-4 headers** of each operational tab against `expectedHeaders`
derived from `src/forms/registry.ts`, and reports per-column differences.

This screen costs Sheets API calls, so it only runs when you open it.

- **The writer verifies headers itself, in the invocation that is about to write**, for
  every stage in its batch, before the first write. You do not need to run this screen
  for the writer to be safe.
- Run it **after any change to the workbook**, and **before a cutover** (R-05).
- A mismatch **latches**: the worker aborts subsequent passes with no API call at all,
  until the drift is resolved. That is deliberate — a changed header means a column may
  now mean something else, and writing into it would corrupt records silently.

**When drift is reported:**

1. Read which columns differ. The report names them.
2. Decide which side is right. Usually the workbook was edited by a person and should be
   put back. If the *registry* needs to change, that is a code change with a migration and
   a test, not a spreadsheet edit.
3. Fix the headers, re-run this screen until all seven tabs pass.
4. Retry the blocked jobs from the sync-health screen.

---

## 8. Specification approval

**Specifications** (not under Admin — it needs `spec.propose` or `spec.approve`, and the
Administrator role holds neither)

### The state of the limits today

**0 of 34 workbook limit entries are approved.** The screen says so on the page, with the
consequence written out: *every numeric measurement therefore assesses as Not
assessable*. That is FR-009 and R-01 working correctly, not a defect.

The 34 imported entries are grouped by their four live workbook statuses, and every one
carries a **"Reference only — not an approved limit"** chip:

| Status | Count | Meaning |
| --- | --- | --- |
| *To set* | 27 | No numbers at all. |
| *Set* | 4 | **Polinutri vendor reference values** from a visit on 23 October 2026. **Not Bounty Farm approvals.** |
| *Confirm with Polinutri* | 2 | Numbers present, not agreed. |
| *To set with Polinutri* | 1 | Entry #8, ground particle size. Carries a note but **no bounds**. |

The three statuses that carry numbers are framed heavily on the screen, because a number
on a screen is the single easiest thing in this system to mistake for an approved limit.

### Writing a rule

1. Open an entry and choose **"Write a new rule starting from this entry"**.
2. **No field is pre-filled.** There is deliberately no one-click promotion of a workbook
   number into an approved limit. The form opens with the entry number recorded as
   provenance and a `referenceNote` quoting what the workbook says, and you type the
   values you are approving.
3. Set the parameter, the applicability (stage, material, sampling point), the unit, the
   bounds and the **effective-from date**.
4. Submit as **proposed**.

### Approving a rule

1. A **different person** with `spec.approve` reviews and approves it. The two-person rule
   is structural: `checkSeparationOfDuties` refuses it in the UI with the message *"You
   proposed this rule, so you cannot approve it"* rather than a disabled button; the Edge
   Function audits the attempt before refusing; and the database enforces
   `approved_by <> proposed_by`.
2. `approve-specification` does **not** accept an `overrideApprovedBy` from the request
   body and always sends `null` — accepting one would let the actor assert that somebody
   else approved.
3. **Approval is prospective only.** It is refused if the frozen `effective_from` falls on
   a plant-local date before today, and the refusal names the earliest allowed date.
   **Decisions already recorded are unchanged** (FR-014, UAT-12). A retrospective
   reassessment is a separate, explicitly audited act.
4. `specification_versions` rows are **immutable**: a trigger refuses any update or
   delete. A changed limit is a new version, so the rule that decided a past assessment is
   always still readable.

### Why the 34 imported entries can never be approved on this screen

They have **no proposer** — they were imported as `reference_only` with
`proposed_by` NULL — so the two-person rule is unsatisfiable by construction. That keeps
"promote a workbook number" off the approval path entirely. A real rule is always typed
by a person who then cannot approve it.

---

## 9. Audit query

**Admin → Audit query**

Every consequential action writes an event: sign-in provisioning, access approval, role
grant, delegation, registration, results entry, correction, review, hold raise and clear,
disposition, specification proposal and approval, sync outcomes, and **refused attempts**.

NFR-005 requires event time, actor, original value, new value, reason, disposition and
ruleset version, with **no unlogged destructive change**. Backups do not substitute for
this.

- Filter by plant-local date range, actor, event type and sample. The two free-text
  fields commit on submit; the date fields commit immediately, matching the sample-filter
  convention.
- Results are paginated.
- Timestamps display plant-local (`America/Guyana`) and are stored as UTC instants.
- **A refused attempt is recorded, not just refused.** An operator who tries to approve a
  limit or clear a hold produces an audit event (FR-002, UAT-09). Review these: a pattern
  of refusals usually means someone needs a delegation, or a role is wrong.

Audit events are immutable. Nobody — including an administrator — can edit or delete one.

---

## 10. Routine administration

| When | Task |
| --- | --- |
| Daily | Sync health: pending falling, no dead letters. |
| Daily, during the pilot | A reconciliation dry run; compare to the paper record. |
| Weekly | Pending access requests. Refused-attempt audit events. |
| Monthly | Delegation list — expired ones are harmless, open-ended ones are not. |
| Quarterly | **Access recertification** (NFR-002): the Supabase user list, the Google Sheet's share list, the Cloud project's IAM list, and the service account's key list (exactly one key). Remove anyone who has left. |
| Quarterly | Restore test into the **test** project, with the recovery time written down (FR-016, UAT-15). |
| After any workbook change | Schema verification, all seven tabs. |
| Before any cutover | The gate table in `docs/setup.md` §8.5. |

---

## 11. What an administrator cannot fix from a screen

Honest limits, so nobody searches for a control that does not exist:

- **No approved limits exist.** Only a Quality Supervisor can approve one, and only
  prospectively.
- **Sampling frequency is "To set" for four stages**, so no overdue flag and no adherence
  KPI can be produced for them. There is no screen to set it, because the frequency is a
  process-owner decision, not a configuration value (D-04, R-08).
- **The spreadsheet id cannot be changed from the UI.** It is an Edge Function secret with
  no default, set with `supabase secrets set`.
- **Controlled-list sort order cannot be edited** — the server accepts no such field.
- **A profile cannot be deleted.** Suspend or disable instead.
- **A specification version cannot be edited.** Approve a new version.
- **An audit event cannot be edited or deleted.** By trigger.
