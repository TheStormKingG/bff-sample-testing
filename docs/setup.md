# Setup checklist

The eight external-setup checklists required by Master Prompt §9. Each is a sequence of
real screens, fields and values.

**Nothing in this document has been executed.** No cloud resource was created, no Google
Sheet was modified and nothing was pushed to a live repository, because that needs
authorised credentials and explicit permission. Every *local* file is fully implemented;
these are the only blocked steps.

## Two rules that override convenience at every step

> **1. `SHEETS_SPREADSHEET_ID` is a Supabase Edge Function secret with NO DEFAULT.**
> It does not appear in `.env.example`, in `src/`, in a seed, in a test or as a
> fallback. If it is unset the sync worker **refuses to run** and names the missing key
> without printing any value. That is the intended behaviour: a worker that guessed a
> spreadsheet could write quality records into the wrong document.
>
> **2. The workbook verified on 2026-10-24 must NEVER be the write target.**
> `BFF-FRM-06_18_Sample_Test_Log_DRAFT` is a **draft**, owned by a **personal Gmail
> account**. That is cutover blocker **B-07** (`docs/open-decisions.md` D-07). A new
> Bounty-Farm-owned native Google Sheet must be created from the verified structure, and
> a separate throwaway copy used for testing. Point nothing at the draft, not even
> read-only, not even once.

---

## 1. Google Cloud project, Sheets API, service account, sharing the native Sheet

**Screens:** Google Cloud Console → *IAM & Admin* → *Service Accounts*; *APIs & Services*
→ *Library*; Google Drive / Sheets sharing dialog.

1. **Create or choose a project.** Console → project picker → *New Project*.
   - Name: `bff-sample-testing`
   - Organisation: the Bounty Farm Workspace organisation if one exists. If staff are on
     personal Gmail accounts this will be a personal project — record that as a risk, it
     is the same class of problem as D-07.
2. **Enable the Sheets API.** *APIs & Services → Library* → search `Google Sheets API` →
   **Enable**. Do **not** enable the Drive API: the worker addresses one spreadsheet by
   id and needs nothing else.
3. **Create the service account.** *IAM & Admin → Service Accounts → Create service
   account*.
   - Name: `bff-sheets-writer`
   - Description: `Writes committed sample records to the BFF operational workbook. No
     other access.`
   - **Grant it NO project role.** Click *Continue* and then *Done* on the "Grant this
     service account access to project" step. Sheets access comes from sharing one
     document, not from a project role. An `Editor` project role here would be a
     standing grant over every future resource.
   - No user is given access to the service account.
4. **Create a JSON key.** Open the service account → *Keys* → *Add key* → *Create new
   key* → **JSON**. The file downloads once.
   - This file is a credential. It goes **straight into `supabase secrets set`** (step 3
     below) and nowhere else. Not into the repository, not into `.env`, not into a chat
     message, not into a shared drive.
   - Note the `client_email` — that is the address you share the Sheet with.
5. **Create the operational workbook — a NATIVE Google Sheet.**
   - Google Drive → *New* → *Google Sheets*. **Not** an uploaded `.xlsx`: an uploaded
     file has no Sheets API identity of the kind the worker addresses.
   - Owner: a **Bounty Farm Workspace account or shared drive**. Not a personal Gmail
     account.
   - Reproduce the verified structure exactly: 9 tabs with the exact names in
     `docs/mapping.md` §1, rows 1–2 title and instruction, **row 3 as a merged
     section-band row**, row 4 as the verified headers, data from row 5.
   - **Protect rows 1–4 on every operational tab** and protect both reference tabs:
     *Data → Protect sheets and ranges*. Restrict editing to the named humans who
     maintain the template. The service account must be able to write row 5 and below and
     must not be able to change a header.
6. **Create a separate test workbook** the same way, named so nobody can confuse them,
   e.g. `BFF-FRM-06.18 Sample Test Log — TEST`. Destructive tests point here and only
   here.
7. **Share each workbook with the service account.** Open the Sheet → *Share* → paste the
   service account's `client_email` → **Editor** → **untick "Notify people"** → *Share*.
   - *Editor* is the minimum that can write a row. There is no narrower Sheets role.
   - **General access must stay "Restricted".** Never *Anyone with the link*, never
     *Publish to the web* (R-10).
8. **Record the spreadsheet ids** from each URL —
   `https://docs.google.com/spreadsheets/d/`**`<THIS PART>`**`/edit`. Put them straight
   into the matching Supabase project's secrets. Do not write them into any file in this
   repository.

---

## 2. Google OAuth web client, Supabase Google provider, the Supabase-managed callback

**Screens:** Google Cloud Console → *APIs & Services* → *OAuth consent screen*, then
*Credentials*; Supabase Dashboard → *Authentication* → *Sign In / Providers*.

1. **Get the Supabase callback URI first.** Supabase Dashboard → *Authentication* →
   *Sign In / Providers* → **Google**. The page shows a **Callback URL (for OAuth)**:

   ```
   https://<project-ref>.supabase.co/auth/v1/callback
   ```

   Copy it. **This is the only redirect URI Google needs.** The app does not host its own
   callback — `supabase/config.toml` sets `redirect_uri = ""` precisely so the
   Supabase-managed address is used. A custom callback on GitHub Pages cannot work from a
   subpath.
2. **Configure the OAuth consent screen.** *APIs & Services → OAuth consent screen*.
   - User type: **Internal** if the Bounty Farm Workspace organisation exists — the
     strongest available restriction. **External** otherwise, and then add every staff
     member under *Test users* while the app stays unpublished.
   - App name: `BFF Sample Testing`. Support email: the system custodian.
   - Scopes: the default `openid`, `email`, `profile` only. **Add nothing.** The app never
     reads a user's Drive or Sheets; the service account does the writing.
3. **Create the OAuth client.** *Credentials → Create credentials → OAuth client ID*.
   - Application type: **Web application**
   - Name: `BFF Sample Testing — Supabase auth`
   - **Authorised redirect URIs:** the single Supabase callback from step 1.
   - **Authorised JavaScript origins:** leave **empty**. The browser never calls Google
     directly.
   - Copy the **Client ID** and **Client secret**.
4. **Enter them in Supabase.** *Authentication → Sign In / Providers → Google* →
   **Enable** → paste Client ID and Client secret → *Save*.
   - The client secret lives here and in the local shell only. It is **never** a `VITE_*`
     variable and never reaches `src/`.
5. **For local development**, export both before `supabase start` — `config.toml` reads
   them from the environment and never commits them:

   ```bash
   export SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_ID=...
   export SUPABASE_AUTH_EXTERNAL_GOOGLE_SECRET=...
   ```

---

## 3. Supabase project, migrations, RLS, secrets

**Screens:** Supabase Dashboard → *New project*; *SQL Editor*; *Project Settings* →
*Edge Functions* → *Secrets*. Plus the CLI.

1. **Create two projects**, not one: `bff-sample-testing-prod` and
   `bff-sample-testing-test`. Record the database password in the organisation's password
   manager. Choose the region closest to Guyana.
2. **Link and push the schema.**

   ```bash
   supabase link --project-ref <project-ref>
   supabase db push                 # applies migrations 0001 … 0008 in order
   ```

   Then apply the two production seeds. They are listed in `config.toml` under
   `[db.seed].sql_paths`, so `supabase db reset` runs them locally; against a hosted
   project apply them explicitly:

   ```bash
   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/seed/0001_controlled_vocabulary.sql
   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/seed/0002_specification_reference_import.sql
   ```

   Each file ends with a gate that **reads the catalogue back** rather than trusting that
   its statements had an effect. Expect exactly:

   ```
   Controlled vocabulary seeded: 4 materials, 2 sampling points, 2 mill screen sizes
   Specification reference import complete: 28 parameters, 34 workbook entries,
     ALL reference_only, 0 approved, 9 equipment settings, bounds on 6
   ```

   If the second line does not say **0 approved**, stop. An approved limit in a
   production database is the one state that must not exist (R-01).

   > **`supabase db reset` currently fails before any seed runs.** `0002_samples.sql`
   > inserts `sample_prefixes` rows referencing `sampling_points` codes `'AM'` and `'BC'`,
   > and nothing inserts those rows before the migration phase ends — they live in
   > `seed/0001`, and seeds run after migrations. The fix is one line in
   > `0002_samples.sql`, immediately before the `sample_prefixes` insert. See
   > `docs/open-decisions.md` D-12. Apply it before attempting this step.

3. **Verify RLS is on and `anon` holds nothing.** *SQL Editor*:

   ```sql
   select relname, relrowsecurity
     from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
    order by 1;
   -- every row must show relrowsecurity = true

   select table_name, privilege_type
     from information_schema.role_table_grants
    where grantee = 'anon' and table_schema = 'public';
   -- expect ZERO rows
   ```

   Read the privilege catalogue back rather than assuming a `REVOKE` took effect. A
   `REVOKE` can only remove a grant that was actually recorded, so it succeeds and changes
   nothing when the grant was never there — and `ALTER DEFAULT PRIVILEGES … REVOKE` is
   inert for exactly that reason. `0001_identity.sql` discusses this hazard and names a
   `0013_security_posture.sql` as the file that performs the read-back; **that file does
   not exist**, so this check is currently manual. Recorded as D-17.

4. **Set the Edge Function secrets.** *Project Settings → Edge Functions → Secrets*, or:

   ```bash
   supabase secrets set SHEETS_SPREADSHEET_ID='<the id from step 1.8>'
   supabase secrets set GOOGLE_SERVICE_ACCOUNT_JSON="$(cat /path/to/key.json)"
   supabase secrets set SYNC_SCHEDULER_SECRET="$(openssl rand -hex 32)"
   ```

   - `SUPABASE_SERVICE_ROLE_KEY` is injected by the platform. Do not set it, and never
     copy it anywhere.
   - **Shred the downloaded JSON key file afterwards.** It now exists in exactly one
     place.
   - Confirm with `supabase secrets list` — it prints names and digests, never values.
   - **The test project gets the TEST spreadsheet id.** Nothing else.
5. **Deploy the functions.**

   ```bash
   npm run fn:deploy      # or: supabase functions deploy <name>
   ```

   > Two things are missing before this is useful. **(a)** No `rpc_*` function exists in
   > migrations 0001–0008, so every function returns its typed `rpc_not_deployed` error
   > (D-13). **(b)** `supabase/config.toml` has no `[functions.*]` block, so `health` and
   > `sheets-sync-worker` sit behind the gateway's default `verify_jwt` and their own
   > internal authorisation never gets a chance to run. Add, before deploying:
   >
   > ```toml
   > [functions.health]
   > verify_jwt = false
   > [functions.sheets-sync-worker]
   > verify_jwt = false
   > ```
   >
   > Both authorise themselves — `health` serves anonymous liveness only, and the worker
   > requires the scheduler secret or a user holding `sync.retry`.

---

## 4. Auth Site URL and redirect URLs, consistent with HashRouter

**Screen:** Supabase Dashboard → *Authentication* → *URL Configuration*.

| Field | Value |
| --- | --- |
| **Site URL** | `https://<owner>.github.io/<repo>/` — **with the trailing slash** |
| **Redirect URLs** | `https://<owner>.github.io/<repo>/`<br>`http://localhost:5173/`<br>`http://127.0.0.1:5173/` |

Why these exact shapes:

- **The app uses `HashRouter`.** Every in-app route is `#/samples`, `#/stage/pellets` and
  so on. The fragment is **never sent to the server**, so every redirect target is the
  site root and the router resolves the rest in the browser. This is the only routing mode
  that works for an OAuth callback on a GitHub Pages subpath, and it is mandatory
  (Master Prompt §1).
- **The trailing slash matters.** Supabase matches redirect URLs as prefixes. Without it a
  sibling path could match.
- **Do not add a `#/...` suffix to a redirect URL.** It would never match, because the
  fragment does not reach Supabase.
- `localhost` and `127.0.0.1` are different origins to a browser. Add both or local
  sign-in will fail on whichever you did not add.

After a repository rename, update the Site URL and the redirect list in the same change.
`VITE_BASE_PATH` is derived automatically by the deploy workflow; this list is not.

---

## 5. Staff roles and allowlist, first-admin bootstrap, service-account least privilege

1. **Decide the account model first.** PRD §16 Q1 — one Bounty Farm Workspace domain,
   personal Gmail accounts, or both? This is D-01 and it gates the consent-screen choice
   in step 2.2. A Workspace domain allows *Internal* user type, which is the strongest
   restriction available.
2. **Arm the first administrator.** A profile is keyed to `auth.users`, so **no script can
   create an account** — only a real Google sign-in does. The seed arms a one-shot grant
   that the founder's first sign-in consumes:

   ```bash
   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
     -c "set app.bootstrap_admin_email = 'custodian@bountyfarm.example'" \
     -f supabase/seed/bootstrap_first_administrator.sql
   ```

   The file refuses to run without the setting, refuses a malformed address, refuses if any
   administrator already exists, and refuses if an unconsumed grant is already pending —
   so a second run cannot redirect the founding grant to a different person. **No email
   address is stored in the file**; it is supplied at the command line.
3. **The founder signs in with Google.** The trigger produces: profile `active`,
   `approval_basis = first_administrator_bootstrap`, no approver, the `administrator` role
   with a NULL grantor, the grant consumed with a consumer recorded, and two audit events
   (`identity.provisioned`, `identity.bootstrap_administrator`).
4. **Every subsequent sign-in lands on `pending` and sees no data.** The gate is RLS, not
   a screen. An administrator approves each one from *Admin → Users* and assigns a role.
5. **Assign roles deliberately.** The matrix is in `docs/admin-guide.md` §2. The two
   exclusions that are easiest to get wrong, and are enforced server-side:
   - **An Administrator has NO quality authority** — cannot approve a specification,
     clear a hold or release material.
   - **A Quality Officer can RAISE a hold but not CLEAR one**, and cannot approve a
     specification.
   - **`disposition.override_release` is granted to NO role.** It exists only as a
     time-bounded delegation, and the database additionally enforces that through a CHECK
     against `delegation_only_permissions()`.
6. **Service-account least privilege — verify, do not assume.**
   - No project IAM role (step 1.3).
   - Editor on **one** spreadsheet, by explicit share. Confirm on the Sheet's *Share*
     dialog that the service account appears once and that *General access* is
     *Restricted*.
   - Drive API **not** enabled.
   - One JSON key in existence. *Service account → Keys* should list exactly one.
   - Diarise a quarterly access recertification (NFR-002): re-read the Sheet's share
     list, the project's IAM list and the Supabase user list, and remove anyone who has
     left.

---

## 6. GitHub repository, Actions, the Vite base path, Pages settings

1. **Create the repository** under the Bounty Farm organisation. **Private** unless there
   is a decision to the contrary — the application code is not the secret, but a public
   repository invites forks that deploy with somebody else's configuration.
2. **Settings → Pages → Build and deployment → Source: GitHub Actions.** Not "Deploy from
   a branch".
3. **Settings → Secrets and variables → Actions → Variables** — add:

   | Name | Value | Kind |
   | --- | --- | --- |
   | `VITE_SUPABASE_URL` | `https://<project-ref>.supabase.co` | Variable (public by design) |
   | `VITE_SUPABASE_ANON_KEY` | the publishable / anon key | Variable, or a Secret — the workflow accepts either |

   The build fails with a named error if either is missing, and prints only lengths. **Add
   nothing else.** A service-role key, a Google key, an OAuth secret or the spreadsheet id
   in this screen would be compiled into public JavaScript; `npm run verify:bundle` fails
   the deployment if any of them reach `dist/`.
4. **Do not set `VITE_BASE_PATH` by hand.** `deploy-pages.yml` derives it from
   `actions/configure-pages`, falling back to the repository name, and normalises the
   trailing slash. A hardcoded slug breaks silently on a rename or a fork.
5. **Branch protection on the default branch:** require the `CI` workflow to pass, and
   require a pull request. Deployment runs only from the default branch and only after
   `ci.yml` passes in full.
6. **First deployment:** push to `main`, watch *Actions*, then open
   `https://<owner>.github.io/<repo>/`. If you get a blank page, check the browser console
   — a misconfigured build renders `main.tsx`'s readable configuration-error screen rather
   than nothing, so a truly blank page points at the base path instead.

   > **A deployment attempted today will fail at the first CI step.** `npm run lint`
   > exits 1 on two errors in deliberate code (see `README.md` §1 and D-14). Fix those
   > first.

---

## 7. Sync worker scheduling and error notification

> **A registration now nudges the worker by itself.** `register-sample` fires a
> best-effort POST to `sheets-sync-worker` after the row is queued, so in the
> ordinary case a sample reaches the workbook in seconds instead of waiting for
> whatever runs next. It needs `SYNC_SCHEDULER_SECRET` to be set on the
> project; without it the nudge is refused in the function and logged as
> `sync_kick_not_configured`, naming the missing keys. Check the admin health
> screen to see whether it is set.
>
> **THE NUDGE IS NOT A SCHEDULER, AND STEP 1 IS STILL REQUIRED.** It fires when
> a registration happens. The outbox's own retry policy schedules work for
> instants in the FUTURE — a transient failure becomes `retry_scheduled` with a
> `next_retry_at` that the claim query will not return until that moment — and
> nothing edge-triggered fires then. So the last sample of a shift, if its
> first attempt fails transiently, waits for the next registration, which may
> be the next morning. A `dead_letter` event is never retried automatically at
> all. The periodic runner below remains the mechanism of record.

1. **Schedule the worker.** Still required (D-18); the nudge above shortens the
   common case but does not drain future-dated retries. Two options:
   - **`pg_cron` + `pg_net` inside Supabase** — one moving part, and the schedule lives
     in a migration so it is reviewable:

     ```sql
     select cron.schedule('bff-sheets-sync', '* * * * *', $$
       select net.http_post(
         url     := 'https://<project-ref>.supabase.co/functions/v1/sheets-sync-worker',
         headers := jsonb_build_object('x-sync-scheduler-secret',
                      current_setting('app.sync_scheduler_secret', true))
       );
     $$);
     ```

     Store the secret with `alter database … set app.sync_scheduler_secret = …`, never as
     a literal in the migration.
   - **An external scheduler** (GitHub Actions `schedule`, or any cron host) posting the
     same header. Simpler to reason about, but it puts the scheduler secret in a second
     place.
2. **Every minute is enough.** The lease makes an overlapping invocation harmless: a
   second caller gets `409 lease_conflict` and exits. Do not "fix" that by removing the
   lease.
3. **Schedule the reconciler** separately and far less often — daily, outside production
   hours. Run it with `dryRun: true` first; a repairing run needs `sync.retry`.
4. **Error notification.** The worker dead-letters a job after its configured maximum
   attempts. A dead letter is a **quality-record integrity event**: a committed sample
   that the operational spreadsheet does not show. Someone must be told.
   - Minimum: a daily check of *Admin → Sync health*, which lists failed and
     dead-lettered jobs and offers a manual retry.
   - Better: a scheduled query that emails the custodian when the dead-letter count is
     non-zero, when the oldest pending outbox row is older than an agreed threshold, or
     when `health`'s detail tier reports latched schema drift.
   - **Never alert on a single failed attempt.** Transient Google errors are expected;
     the backoff exists for them. Alert on a dead letter, on drift, and on sustained
     pendency.
5. **Quota.** `_shared/quota.ts` honours a quota hint and the worker backs off rather than
   hammering. Watch the Sheets API quota page during the pilot (R-07, NFR-007). The worker
   never reads the whole spreadsheet to find a row.

---

## 8. Test-workbook verification, supervised pilot, rollback, backup/restore, cutover

### 8.1 Verify against the test workbook — never the draft

1. Point the **test** Supabase project at the **test** spreadsheet id.
2. Run *Admin → Schema verification* for all seven tabs. It compares the live row-4
   headers against `expectedHeaders` from the registry and reports per-column
   differences. **All seven must pass before a single write.**
3. Register one sample per form. Confirm in the spreadsheet: the right tab, the right
   columns, data at row 5 or below, rows 1–4 untouched, both reference tabs untouched,
   `0` present where zero was entered and blank where nothing was entered, `12.50` still
   reading `12.50`. That is UAT-01.
4. Deliberately rename a header in the test workbook and confirm the writer **blocks** and
   the administrator is notified (R-05). Then put it back.

### 8.2 Supervised pilot

- One stage first — Raw materials. Not all seven.
- Run paper and app **in parallel** for the pilot period. The paper record is the
  fallback and the cross-check (PRD §16 Q9).
- Watch real operators on their own phones, in the plant, with wet hands and gloves
  (NFR-004). Observe; do not coach.
- Expect every numeric result to read **Not assessable**, and make sure operators and
  supervisors understand *why* before the pilot begins. With 0 of 34 limits approved,
  that is the system telling the truth (FR-009, R-01). An operator who reads it as "the
  app is broken" will start guessing.
- Daily: sync health, dead letters, and a reconciliation dry run.

### 8.3 Rollback

Covered in `README.md` §4 and `docs/recovery-runbook.md`. The three rules:

1. **Migrations are forward-only.** Write a new numbered migration that reverses the
   change; never edit an applied one. Specification versions and audit events are
   immutable by trigger.
2. **Never hand-edit the Google Sheet to fix a sync problem.** Use `reconcile-sheets`.
   A hand edit creates a discrepancy the reconciler will then report as drift, and it
   destroys the evidence of what actually happened.
3. **Prefer a revert to a rewrite.** A reverted commit leaves the history intact; a force
   push does not, and this is a quality-records system.

### 8.4 Backup and restore

Full procedure in `docs/recovery-runbook.md`. The part that belongs in a setup checklist:

- Turn on **Point-in-Time Recovery** for the production project (*Project Settings →
  Database → Backups*) and agree the retention window with Bounty Farm's record-control
  owner (PRD §16 Q8, NFR-009).
- Take a logical dump on a schedule you control as well; a managed backup you cannot
  restore yourself is not a tested backup.
- **Restore into the TEST project and reconcile there.** Never restore over production.
  Record the actual recovery time and any discrepancies — FR-016 and UAT-15 require a
  *documented restore test*, not a backup setting.
- Store the Google service-account key's existence (not its value) and the Sheet
  ownership in the same disaster-recovery note, because losing the Workspace account that
  owns the Sheet is a scenario a database backup does not cover.

### 8.5 Production cutover — the gates

Do not cut over until every line is true:

| Gate | Status today |
| --- | --- |
| A Bounty-Farm-owned **native** Google Sheet exists and the draft is retired | **BLOCKED** — D-07 |
| The seven row-4 header sets verify against that workbook | not run |
| `rpc_*` functions deployed; a registration completes end to end | **NOT IMPLEMENTED** — D-13 |
| `npm run lint && npm run typecheck && npm test && npm run build` exits 0 | **FAILS at lint** — D-14 |
| Playwright suite green on the Pages base path | not run — local browser mismatch, see `README.md` §1 |
| At least one specification limit formally approved, or a written decision to operate with none | **0 of 34 approved** — D-02 |
| Hold-release authority named in writing | **OPEN** — D-03 |
| Steam-pressure unit confirmed, or the field formally excluded from assessment | **OPEN** — D-05 |
| Sampling frequencies approved for Ground, Conditioned, Pellets, Crumble, or a written decision to report no adherence | **OPEN** — D-04 |
| Restore tested into the test project and documented | not run — UAT-15 |
| ≥20 concurrent registrations tested | not run — UAT-03 |
| Role-denial negative tests run against the real database | not run — UAT-09 beyond unit level |
| Sync worker scheduled; dead-letter notification live | **NOT IMPLEMENTED** — D-18 |
| Operators trained; SOP and administration manual issued | not started |
| A named ongoing owner with a support and change-control plan | **OPEN** — D-08 |

PRD §14 P0 is explicit: **no go-live before P0 is complete.**
