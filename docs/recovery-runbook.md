# Recovery runbook

For the system custodian, under pressure. Each section is "symptom → what it means →
what to do", in that order.

## Four rules that apply to every section

1. **Restore into the TEST project. Never over production.** A restore over production
   destroys the evidence of what went wrong, and you will need that evidence.
2. **Never hand-edit the Google Sheet to fix a sync problem.** It creates a discrepancy
   the reconciler will report as drift, and it destroys the record of what actually
   happened. Use `reconcile-sheets`.
3. **A timeout is an unknown outcome, not a failure. Reconcile before retrying.** The
   write may have landed. A blind retry is how one sample becomes two rows.
4. **Postgres is the authoritative quality record; the Sheet is a projection.** If the two
   disagree, the ledger is right and the Sheet needs repairing — never the reverse.

---

## 1. Backup

### What must be backed up

| Asset | Mechanism | Who owns it |
| --- | --- | --- |
| Postgres — the quality ledger | Supabase PITR + a scheduled logical dump | custodian |
| The operational Google Sheet | Google's own version history + a periodic exported copy | Workbook owner |
| Migrations, functions, frontend | git | repository owner |
| The Google service-account key | **Not backed up.** Revoke and reissue if lost. | custodian |
| Supabase Edge Function secrets | Recorded in the organisation's password manager | custodian |

### Set it up

1. **Point-in-Time Recovery.** *Project Settings → Database → Backups* → enable PITR.
   Agree the retention window with Bounty Farm's record-control owner (D-08, NFR-009).
2. **A logical dump you control.** A managed backup you have never restored yourself is
   not a tested backup:

   ```bash
   pg_dump "$PRODUCTION_DATABASE_URL" \
     --format=custom --no-owner --no-privileges \
     --file="bff-$(date -u +%Y%m%dT%H%M%SZ).dump"
   ```

   Store it where the Supabase project's own failure cannot take it with it.
3. **Workbook copies.** *File → Make a copy* on a schedule, into a Bounty-Farm-owned
   folder. Google's version history is good but is tied to the same account that owns
   the file — and **the file is currently owned by a personal Gmail account** (D-07),
   which is itself a disaster-recovery exposure a database backup does not address.
4. **Secrets.** `supabase secrets list` prints names and digests, never values. Record in
   the password manager: which secrets exist, what each is for, and where the authoritative
   copy lives. Not the values themselves in any document.

### Verify it

A backup is a hypothesis until restored. **Quarterly**, run §2 end to end and write down
the recovery time. FR-016 and UAT-15 require a *documented restore test*.

---

## 2. Restore into a TEST project

```bash
# 1. A test project that is NOT production. Check the ref twice.
supabase link --project-ref <TEST-project-ref>

# 2. Schema first.
supabase db push

# 3. Data.
pg_restore --dbname "$TEST_DATABASE_URL" --no-owner --no-privileges \
  --clean --if-exists bff-20261024T120000Z.dump

# 4. The test project must point at the TEST spreadsheet. Confirm, do not assume.
supabase secrets list            # names and digests only
supabase secrets set SHEETS_SPREADSHEET_ID='<the TEST workbook id>'
```

> **Before anything else, confirm the restored test project cannot reach the production
> workbook.** A restored project carries restored data, not restored secrets — but a test
> project that was previously pointed at production still is. Set
> `SHEETS_SPREADSHEET_ID` to the test workbook **before** any function runs, or the
> restored outbox will start writing production rows into the live spreadsheet. This is
> the single most dangerous step in this document.

### Then verify the restore, rather than assuming it

```sql
-- Does the data look like the right day?
select count(*) as samples, max(created_at) as newest from public.samples;
select count(*) from public.sample_measurements;
select count(*) from public.audit_events;

-- NFR-001: every acknowledged save readable back by UUID.
select count(*) as acknowledged_without_a_sample
  from public.idempotency_requests r
 where r.state = 'succeeded'
   and not exists (select 1 from public.samples s where s.id = r.sample_id);
-- expect 0

-- The one state that must never exist in production data.
select count(*) as approved_rules from public.specification_versions
 where status = 'approved';
-- on restored PRODUCTION data today, expect 0 (0 of 34 workbook limits approved)
```

**A zero here is only meaningful if the query could have returned non-zero.** Before
believing the third query, confirm the instrument discriminates: count the
`reference_only` rows first and expect **34**. A zero after a count that proves the
question reached rows is evidence; a zero on its own is silence. The seed files use the
same ordering for the same reason.

---

## 3. Reconciling the three populations

Three records of the same events, which must agree.

```
  idempotency request registry  ──┐
                                  ├──  must agree  ──  operational Sheet rows
  samples + measurements (ledger) ─┤
                                  │
  sheet_sync_outbox             ──┘
```

### 3.1 Requests against samples

```sql
-- An acknowledged request with no sample: the worst case. We told a user
-- "recorded" and there is no record. NFR-001 forbids this.
select r.idempotency_key, r.created_at, r.operation
  from public.idempotency_requests r
 where r.state = 'succeeded'
   and r.sample_id is not null
   and not exists (select 1 from public.samples s where s.id = r.sample_id);

-- A sample with no request: a write that did not come through the normal path.
-- Not necessarily wrong (a seed, a migration), but it must be explainable.
select s.id, s.sample_id, s.created_at
  from public.samples s
 where not exists (
   select 1 from public.idempotency_requests r where r.sample_id = s.id);

-- Stuck in progress. Usually a function that died mid-flight.
select idempotency_key, created_at, operation
  from public.idempotency_requests
 where state = 'in_progress' and created_at < now() - interval '1 hour';
```

### 3.2 Samples against the outbox

```sql
-- A sample with no outbox event will NEVER reach the spreadsheet,
-- and nothing will ever report it as failed. It is silently invisible.
select s.id, s.sample_id, s.stage, s.created_at
  from public.samples s
 where not exists (
   select 1 from public.sheet_sync_outbox o where o.sample_id = s.id)
 order by s.created_at desc;

-- How far behind is the worker?
select state, count(*), min(created_at) as oldest
  from public.sheet_sync_outbox group by state order by 1;
```

A sample with no outbox event needs a requeue, not a re-registration. Re-registering
creates a second sample with a second id and a second row.

### 3.3 Ledger against the Sheet

Use `reconcile-sheets`, not your eyes. It verifies the row-4 headers first, and **reports
drift without comparing a single cell** when the headers moved — because every column
index would otherwise mean something else.

```bash
curl -sS -X POST \
  "https://<project-ref>.supabase.co/functions/v1/reconcile-sheets" \
  -H "x-sync-scheduler-secret: $SYNC_SCHEDULER_SECRET" \
  -H 'content-type: application/json' \
  -d '{"dryRun": true}'
```

`dryRun: true` takes **no lease and writes nothing at all**. Always run it first.

It pages the ledger and **refuses rather than reporting a partial comparison as
complete** — a `missing_row` finding is only valid against a fully-read ledger, so a
truncated read is reported as a refusal, not as findings.

#### What it repairs, and what it refuses to touch

| Finding | Repaired automatically? | Why |
| --- | --- | --- |
| `requeue_outbox_event` | **Yes** | The ledger row is agreed; the event simply needs re-running. |
| `update_row_mapping` (pure relocation) | **Yes**, by `rowHash` of the agreed ledger row | The sheet was re-sorted. The row is the same row. |
| A direct cell edit by a human | **No** — `needsHuman` | Overwriting it would destroy evidence of what someone did and why. |
| A duplicate sample identifier in the sheet | **No** — `needsHuman` | Which one is real is not mechanically decidable. |
| A blank identifier | **No** — `needsHuman` | Nothing to match it to. |
| An unknown row | **No** — `needsHuman` | It may be legitimate pre-digital history. |

A per-sample repair failure is collected into `repairFailures` rather than discarding
every other sample's findings.

When the dry run looks right, repeat without `dryRun`. A repairing run needs
`sync.retry`.

---

## 4. Dead-letter handling

**A dead letter is a committed quality record the operational spreadsheet does not show.**
Treat it as a records-integrity event, not a technical nuisance.

### What it is not

- **Not data loss.** The sample is in Postgres and is the authoritative record.
- **Not a reason to re-enter the sample.** That creates a second sample and a second id.

### Procedure

1. **Read the last error before doing anything.** *Admin → Google Sheets sync health*
   shows it per job. Do not retry first and read second — the retry may change what the
   error says.
2. **Classify it:**

   | Last error | Cause | Action |
   | --- | --- | --- |
   | `schema_drift` | Row-4 headers changed | §5. **Do not retry** until the headers match. |
   | Protected-region write refused | Rows 1–4 protection, or the service account lost Editor | Re-check the Sheet's share list; the service account must be Editor. |
   | Width mismatch | The tab's column count no longer matches the registry | §5. A structural change, not a transient error. |
   | Duplicate identifier in the sheet | Two rows claim one sample id | Reconcile dry run. **Human decision.** Do not let the worker choose. |
   | Row absent after a confirmed write | Somebody deleted a confirmed row | §6. **Do not re-append blindly.** |
   | Quota / 429 | Sheets API limits | Wait. The worker honours a quota hint and backs off. Check the quota page (R-07). |
   | Auth failure | Service-account key revoked or expired | Reissue the key, `supabase secrets set`, retry. |
   | Unknown outcome at max attempts | A timeout on every attempt | Reconcile **first**. The row may already exist. |
3. **Fix the cause.** Not the symptom.
4. **Reconcile with `dryRun: true`** and confirm the expected state.
5. **Retry** from the sync-health screen, or requeue through
   `reconcile-sheets`' `requeue_outbox_event`.
6. **Write it down.** Date, sample ids, cause, action, outcome. A dead letter touched the
   integrity of a quality record and the record of that belongs with the records.

### If the same job dead-letters twice

Stop retrying. Two dead letters on one job means the cause is structural, and the backoff
and attempt budget have already told you the retry is not the answer.

---

## 5. Schema-drift response

**Symptom:** the worker returns `409 schema_drift`; *Admin → Workbook schema check* shows
a mismatch; jobs stop progressing with nothing visibly broken.

**What it means:** the live row-4 headers no longer match `expectedHeaders` derived from
`src/forms/registry.ts`. **The writer has stopped on purpose.** A changed header means a
column may now mean something else, and writing into it would corrupt quality records
silently — which is worse than not writing at all.

The drift **latches**: subsequent passes abort with no Google API call, until it is
resolved. That is intended.

### Procedure

1. **Do not retry. Do not disable the check.** The check is the control.
2. *Admin → Workbook schema check*. Read **which columns differ**, per tab.
3. **Establish what happened.** Google's *File → Version history* names who changed what
   and when. Usually a person inserted, renamed, reordered or deleted a column.
4. **Decide which side is correct:**
   - **The workbook was edited by mistake** — the common case. Put the headers back
     exactly, character for character, from `docs/mapping.md`. Then re-protect rows 1–4.
   - **The workbook change is intended** — then it is a **code change**: a registry edit,
     a migration if a stored field changes, updated tests, and a review. Not a
     configuration toggle. The registry is the single source of truth and is deliberately
     not editable from a screen.
5. Re-run the schema check until **all seven tabs pass**.
6. Retry the blocked jobs.
7. **Then prevent the recurrence**, or it will recur: re-check that rows 1–4 are protected
   on all seven tabs, that both reference tabs are protected, and that the Sheet's editor
   list is as short as it can be (R-05). Drift almost always means somebody had edit
   access who did not need it.

---

## 6. A Google write times out

**This is the subtle one, and it is why §3 exists.**

A timeout is an **unknown outcome**. The write may have succeeded, the response may have
been lost, or it may never have arrived. All three look identical from here.

```
   worker writes a row  ──────────▶  Google
                                       │  row written  ✓
        ◀────── response lost ─────────┘
   worker sees: timeout
   worker knows: NOTHING about whether the row exists
```

### What the system does automatically

1. Classifies it as **unknown**, never as a failure.
2. **Reconciles before retrying** — locates the row by sample id. `allowAppendWithoutLocate`
   is explicitly `false`.
3. If the row exists, marks the event confirmed instead of writing again.
4. If it does not, writes once and reads back.
5. Carries `reconcile-first` into a dead letter if it exhausts its attempts, so the next
   human knows a blind retry is unsafe.

`tests/sheetSync.test.ts` asserts the one-row property both with and without the
blind-append optimisation enabled.

### What a human must do

| Situation | Action |
| --- | --- |
| A pending job with a timeout in its error, attempts still rising | **Nothing.** The worker handles it. |
| A dead letter with an unknown outcome | **Reconcile with `dryRun: true` FIRST.** Decide from the findings. Never retry an unknown-outcome job without locating the row. |
| You are about to retry anything by hand | Locate the row by sample id first. Always. |

### The rule, in one line

> **Never retry a write whose outcome you do not know. Find out first.**

That is the whole difference between a quality record with one row and a quality record
with two rows and no way to tell which is real.

---

## 7. Losing the whole Supabase project

1. Create a new project. Record the ref.
2. `supabase link` → `supabase db push` → apply the two production seeds.
3. `pg_restore` the most recent dump.
4. **Re-set every Edge Function secret.** A restored database does not carry them.
   `SHEETS_SPREADSHEET_ID` has **no default**, so until it is set the worker refuses to
   run — which is the correct failure direction.
5. `npm run fn:deploy`.
6. Update **Authentication → URL Configuration** with the Site URL and redirect list.
7. Update `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` in the repository's Actions
   variables and redeploy the frontend.
8. Re-run **Admin → Workbook schema check** before letting the worker touch the Sheet.
9. Run §3 in full. The outbox you restored may be stale with respect to the Sheet.
10. Write down the recovery time.

## 8. Losing the Google Sheet

The quality record is **not lost** — Postgres holds it. Only the operational projection is.

1. Recreate a native Google Sheet with the verified structure
   (`docs/setup.md` §1.5, `docs/mapping.md` §1). **Owned by Bounty Farm this time**
   (D-07).
2. Share it with the service account as Editor. Protect rows 1–4 and both reference tabs.
3. `supabase secrets set SHEETS_SPREADSHEET_ID='<the new id>'`.
4. Run **Admin → Workbook schema check**. All seven tabs.
5. Requeue every sample's outbox event so the ledger re-projects into the new sheet. Do
   this through `reconcile-sheets`, in a dry run first, so the row count is predicted
   before it is produced.
6. Confirm the row counts per tab match the ledger's sample counts per stage.

## 9. Escalation

| Condition | Who |
| --- | --- |
| Quality records may be wrong, missing or duplicated | **Quality Supervisor immediately.** This is a records-integrity event, not an IT ticket. |
| Schema drift on a production workbook | System custodian + the workbook owner |
| Suspected unauthorised access | System custodian + management representative. Preserve the audit events; do not "clean up". |
| A dead letter older than one shift | System custodian |
| Restore needed | System custodian, with the Quality Supervisor informed before any restore |

**Nothing in this runbook requires editing a quality record to fix a technical problem.**
If a procedure seems to need that, stop and escalate — the correct repair is a new, audited
event, never an overwrite.
