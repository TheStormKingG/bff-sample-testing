-- ---------------------------------------------------------------------------
-- 0010_rpc_contract_schema.sql
--
-- The storage the RPC contract in supabase/functions/_shared/rpc.ts needs and
-- 0001-0008 do not provide. Nothing here is a preference: each item below is a
-- field, state or table that a declared RPC argument or return shape requires
-- and that has no column to live in.
--
--   * `sheet_sync_state` is missing 'superseded'. OUTBOX_STATES in
--     _shared/outbox.ts has six members and syncWorker.ts line 227 really does
--     produce the 'superseded' outcome, which nextOutboxState() turns into a
--     terminal transition whose state is passed straight to
--     rpc_record_outbox_outcome as p_state. Without the value that call fails
--     on an invalid enum input, so a stale event could never be retired.
--   * `sheet_sync_outbox` has nowhere to keep three declared OutboxEvent
--     fields: the projected row cells, the reconcile-first flag, and the hash
--     a confirmation was matched on.
--   * `idempotency_requests` cannot represent an in-progress claim, which is
--     the whole point of rpc_begin_idempotent_request.
--   * There is no per-workbook state row for rpc_read_workbook_state to read,
--     and nowhere for a reconciliation report to be written.
--
-- `alter type ... add value` lives in this file and is used nowhere in it: a
-- new enum label cannot be referenced by the transaction that adds it, and the
-- Supabase CLI applies each migration file in one transaction. Everything that
-- reads or writes 'superseded' is in 0011 onwards.
-- ---------------------------------------------------------------------------

alter type public.sheet_sync_state add value if not exists 'superseded';

comment on type public.sheet_sync_state is
  'pending | leased | confirmed | failed | dead_letter | superseded. Mirrors OUTBOX_STATES in supabase/functions/_shared/outbox.ts; the client vocabulary differs and public.outbox_state_to_client() is the only translation.';


-- ---------------------------------------------------------------------------
-- sheet_sync_outbox: the three missing OutboxEvent fields.
--
-- `projected_row` is the row as `toSheetRow` serialised it, which is what
-- OutboxEvent.row is declared to be ("The row cells, serialised by toSheetRow
-- at enqueue time") and what syncWorker.ts writes to the sheet. It is NOT a
-- second copy of the column mapping: the mapping stays in
-- src/forms/sheetMapping.ts and this column stores its OUTPUT, frozen at
-- enqueue time so the worker writes what was committed. `payload` keeps the
-- field-keyed snapshot from public.sample_snapshot() as the evidence of what
-- the record held, which is a different question from what the cell should
-- show and is why both are kept.
-- ---------------------------------------------------------------------------

alter table public.sheet_sync_outbox
  add column projected_row text[] not null,
  -- Set when the previous attempt ended in an UNKNOWN outcome. The worker must
  -- reconcile against the sheet before deciding what to write, so this cannot
  -- be inferred from the state: 'failed' after a classified error and 'failed'
  -- after a timeout need different handling and would otherwise look alike.
  add column reconcile_first boolean not null default false,
  -- The hash the confirmation was matched on. Deliberately WITHOUT the
  -- `^[0-9a-f]{64}$` shape that payload_hash carries: this value arrives from
  -- the Edge Function, whose rowHash() prefixes the algorithm ('sha256:...',
  -- HASH_PREFIX in _shared/hash.ts), so the hex-only pattern would reject
  -- every real confirmation.
  add column confirmed_payload_hash text,
  -- The projection decision the worker acted on, as evidence. p_decision is a
  -- declared argument of rpc_record_outbox_outcome (a ProjectionDecision:
  -- append / update / noop / blocked, with its reason and the cell differences
  -- it found), and it is the only record of WHY a row was appended rather than
  -- updated. Accepting the argument and discarding it would be a silently
  -- swallowed input, so it is stored.
  add column last_decision jsonb;

alter table public.sheet_sync_outbox
  add constraint sheet_sync_outbox_projected_row_present
  check (cardinality(projected_row) > 0);

-- A confirmed event names the hash it was matched on; an unconfirmed one
-- cannot claim a confirmation hash.
alter table public.sheet_sync_outbox
  add constraint sheet_sync_outbox_confirmed_hash_shape
  check ((state = 'confirmed') = (confirmed_payload_hash is not null));

comment on column public.sheet_sync_outbox.projected_row is
  'The cells toSheetRow() produced at enqueue time, column A first. The OUTPUT of the mapping in src/forms/sheetMapping.ts, never a second copy of it.';
alter table public.sheet_sync_outbox
  add constraint sheet_sync_outbox_decision_is_object
  check (last_decision is null or jsonb_typeof(last_decision) = 'object');

comment on column public.sheet_sync_outbox.reconcile_first is
  'True after an UNKNOWN outcome. The next attempt must read the sheet before writing, which is what makes a Google timeout that actually succeeded resolve to a no-op instead of a second operational row.';


-- ---------------------------------------------------------------------------
-- idempotency_requests: make the registry able to hold a CLAIM.
--
-- As built in 0006 the table can only record a finished request, so the
-- read-then-write race that rpc_begin_idempotent_request exists to remove
-- could not be removed. Four mismatches against the contract, all structural:
--
--   1. The key is `request_id uuid`, but an idempotency key is
--      `^[A-Za-z0-9_.:-]{16,128}$` (KEY_PATTERN in _shared/idempotency.ts) and
--      is explicitly not required to be a UUID: "accepting any sufficiently
--      long opaque token keeps a non-UUID client honest". A uuid column cannot
--      store one.
--   2. `outcome` allows only succeeded | denied | failed, so there is no
--      in_progress. IDEMPOTENCY_STATES is in_progress | succeeded | failed, and
--      asIdempotencyState() in adapters/store.ts maps anything that is not
--      succeeded or failed to in_progress -- which would silently re-read a
--      'denied' row as a live claim. 'denied' is therefore removed rather than
--      kept: a request that was refused did not commit, and the registry's own
--      doc comment says a failed attempt may be retried under the same key.
--   3. `payload_hash` is constrained to bare hex, but payloadHash() in
--      _shared/hash.ts returns 'sha256:' + 64 hex so that a future algorithm
--      change is a visible, migratable value. Every real write would violate
--      the old pattern.
--   4. `response_payload` is NOT NULL, but a claim has no response yet, and
--      `updated_at` -- which drives the stale-claim takeover -- does not exist.
--
-- The table is empty at this point in the migration chain, so the column can be
-- added NOT NULL without a backfill.
-- ---------------------------------------------------------------------------

alter table public.idempotency_requests
  add column idempotency_key text not null,
  add column updated_at timestamptz not null default now(),
  -- When the WORK committed, as distinct from when the RESPONSE was stored.
  --
  -- Without this column the registry cannot tell a live claim from a finished
  -- one. The Edge Function claims the key, calls the mutation RPC, and stores
  -- the response in a THIRD call; between the second and the third the row says
  -- `in_progress` while a sample already exists. A retry that read only the
  -- state would run the mutation again -- and in a direct test it did, creating
  -- a second sample under one key.
  --
  -- Deliberately NOT solved by flipping `outcome` to 'succeeded' early: that
  -- state means "the stored response may be replayed verbatim", and the
  -- mutation RPC does not have the HTTP body to store. Marking the commit
  -- separately keeps the replay contract honest -- a retry after a lost
  -- response gets the in-progress answer and then a refusal, never a fabricated
  -- body and never a second record.
  add column committed_at timestamptz,
  alter column request_id set default gen_random_uuid(),
  alter column response_payload drop not null;

alter table public.idempotency_requests
  drop constraint idempotency_requests_hash_shape,
  drop constraint idempotency_requests_outcome_valid;

alter table public.idempotency_requests
  add constraint idempotency_requests_key_shape
    check (idempotency_key ~ '^[A-Za-z0-9_.:-]{16,128}$'),
  add constraint idempotency_requests_hash_shape
    check (payload_hash ~ '^sha256:[0-9a-f]{64}$'),
  add constraint idempotency_requests_outcome_valid
    check (outcome in ('in_progress', 'succeeded', 'failed')),
  -- A finished request carries its finish time and its body; a live claim
  -- carries neither.
  add constraint idempotency_requests_completion_shape
    check (
      (outcome = 'in_progress' and completed_at is null)
      or (outcome <> 'in_progress' and completed_at is not null)
    ),
  add constraint idempotency_requests_succeeded_has_response
    check (outcome <> 'succeeded' or response_payload is not null);

-- UNIQUE ON THE KEY ALONE, not on (key, operation).
--
-- decideIdempotency() returns an `operation_mismatch` conflict when a stored
-- record's operation differs from the incoming one, and that branch is only
-- reachable if a lookup by key can RETURN a row belonging to another
-- operation. Keying the index on the pair would make the same key under a
-- second endpoint a brand-new row, the mismatch would never be detected, and
-- the registry's stated rule -- "the operation name, so one key cannot be
-- reused across endpoints" -- would be false. So the lookup is by key, the
-- operation travels with the row, and the pure function does the comparing.
create unique index idempotency_requests_key_key
  on public.idempotency_requests (idempotency_key);

comment on index public.idempotency_requests_key_key is
  'Unique on the KEY ALONE. A lookup by key must be able to return a row stored under a different operation, or decideIdempotency() could never raise operation_mismatch and one key could be replayed across endpoints.';
comment on column public.idempotency_requests.outcome is
  'in_progress | succeeded | failed, matching IDEMPOTENCY_STATES in supabase/functions/_shared/idempotency.ts. Exposed to the Edge Functions as `state`.';


-- ---------------------------------------------------------------------------
-- sheet_workbook_state: what rpc_read_workbook_state returns.
--
-- WorkbookStateRow declares last_verified_at, verified_stages, schema_drifted,
-- schema_problems and last_reconciled_at for one workbook key. 0007 has an
-- append-only verification LOG (sheet_schema_verifications) and a lease row,
-- but no current-state row, so the worker had nothing to read its own gate
-- from. Separate from the lease on purpose: the lease answers "who may write
-- right now", this answers "has the header check passed recently", and
-- conflating them would make releasing a lease look like discarding a
-- verification.
-- ---------------------------------------------------------------------------

create table public.sheet_workbook_state (
  workbook_key       text primary key,
  last_verified_at   timestamptz,
  -- The stages whose row-4 headers matched at that verification. An empty
  -- array is not "all": the worker may only write a tab that is named here.
  verified_stages    public.sample_stage[] not null default '{}'::public.sample_stage[],
  schema_drifted     boolean not null default false,
  schema_problems    jsonb not null default '[]'::jsonb,
  last_reconciled_at timestamptz,
  updated_at         timestamptz not null default now(),

  constraint sheet_workbook_state_problems_is_array
    check (jsonb_typeof(schema_problems) = 'array'),
  -- Drift is a recorded finding, never a bare flag: something has to say WHAT
  -- diverged, or an administrator cannot act on it.
  constraint sheet_workbook_state_drift_has_problems
    check (not schema_drifted or jsonb_array_length(schema_problems) > 0),
  -- A stage can only be listed as verified if a verification actually ran.
  -- NOT an equivalence: a run that checked the workbook and passed NOTHING is a
  -- real and important outcome -- it is the state a drifted workbook is in --
  -- and the worker must be able to record it. Requiring a non-empty list
  -- alongside a timestamp would make the honest "verified, nothing passed"
  -- unstorable and push the caller towards recording no verification at all.
  constraint sheet_workbook_state_verified_pair
    check (last_verified_at is not null or cardinality(verified_stages) = 0)
);

create trigger sheet_workbook_state_set_updated_at
  before update on public.sheet_workbook_state
  for each row execute function public.tg_set_updated_at();

-- One row, for the one workbook, under the key the Edge Functions send. Same
-- literal as the lease row in 0007 and as WORKBOOK_KEY in
-- supabase/functions/_shared/adapters/store.ts.
insert into public.sheet_workbook_state (workbook_key) values ('operational-workbook');

alter table public.sheet_workbook_state
  add constraint sheet_workbook_state_key_matches_client
  check (workbook_key = 'operational-workbook');

comment on table public.sheet_workbook_state is
  'Current header-verification and reconciliation state for the one operational workbook. The append-only evidence is public.sheet_schema_verifications; this is the gate the worker reads.';


-- ---------------------------------------------------------------------------
-- sheet_reconciliation_reports: where rpc_write_reconciliation_report puts it.
--
-- reconcile-sheets/index.ts builds a report and calls the RPC with
-- p_workbook_key, p_started_at, p_finished_at, p_total_findings, p_clean and
-- p_report. Append-only, because a reconciliation run is an event: editing a
-- past report would be editing the record of what the sheet looked like.
-- ---------------------------------------------------------------------------

create table public.sheet_reconciliation_reports (
  id             uuid primary key default gen_random_uuid(),
  workbook_key   text not null,
  started_at     timestamptz not null,
  finished_at    timestamptz not null,
  total_findings integer not null,
  clean          boolean not null,
  report         jsonb not null,
  recorded_at    timestamptz not null default now(),

  constraint sheet_reconciliation_reports_window check (finished_at >= started_at),
  constraint sheet_reconciliation_reports_findings_nonneg check (total_findings >= 0),
  constraint sheet_reconciliation_reports_report_is_object
    check (jsonb_typeof(report) = 'object'),
  -- A clean run found nothing. The flag cannot contradict the count.
  constraint sheet_reconciliation_reports_clean_is_empty
    check (clean = (total_findings = 0))
);

create index sheet_reconciliation_reports_recent_idx
  on public.sheet_reconciliation_reports (workbook_key, finished_at desc);

create trigger sheet_reconciliation_reports_append_only
  before update or delete on public.sheet_reconciliation_reports
  for each row execute function public.tg_append_only();

comment on constraint sheet_reconciliation_reports_clean_is_empty
  on public.sheet_reconciliation_reports is
  'A run cannot be recorded as clean while it carries findings. The flag and the count are the same fact.';


-- ---------------------------------------------------------------------------
-- Privileges for the two new tables.
--
-- Supabase's default privileges grant ALL on a new table in `public` to `anon`
-- and `authenticated`; 0009 removed that default for the role that runs these
-- migrations, but the per-table revoke below is the control and the default
-- change is only defence in depth. See the header of 0009.
--
-- `sync.view` already gates the administrator sync-health screen through the
-- policies 0007 established, so SELECT is granted to `authenticated` and the
-- policy decides. There is no INSERT, UPDATE or DELETE privilege for any
-- client role on either table: both are written only by service-role RPCs.
-- ---------------------------------------------------------------------------

alter table public.sheet_workbook_state          enable row level security;
alter table public.sheet_reconciliation_reports  enable row level security;

create policy sheet_workbook_state_select_sync_viewers on public.sheet_workbook_state
  for select to authenticated
  using (public.is_active_user() and public.has_permission('sync.view'));

create policy sheet_reconciliation_reports_select_sync_viewers
  on public.sheet_reconciliation_reports
  for select to authenticated
  using (public.is_active_user() and public.has_permission('sync.view'));

revoke all on public.sheet_workbook_state         from anon, authenticated;
revoke all on public.sheet_reconciliation_reports from anon, authenticated;

grant select on public.sheet_workbook_state         to authenticated;
grant select on public.sheet_reconciliation_reports to authenticated;

select public.assert_function_privileges();
