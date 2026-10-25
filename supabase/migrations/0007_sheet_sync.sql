-- ===========================================================================
-- 0007_sheet_sync.sql
--
-- The transactional outbox for the Google Sheet, the single-writer lease that
-- serialises it, and the record of each schema verification.
--
-- The contract (Master Prompt section 7): when a registration, a results
-- update or a correction COMMITS in Postgres, exactly one versioned outbox
-- event is created IN THE SAME TRANSACTION. A privileged Edge Function then
-- projects it onto the spreadsheet. Nothing about the spreadsheet is on the
-- user's critical path, and no browser tab has to stay open for a sync to
-- finish.
--
-- Two states are shown to a human, and only two (rule 6):
--   "Recorded securely, Google Sheets sync pending"  -> anything but confirmed
--   "Confirmed in Google Sheets" (with timestamp)    -> state = 'confirmed'
--                                                       AND confirmed_at set
-- `failed` and `dead_letter` are a third FACT but not a third reassurance:
-- they are the pending message plus a visible needs-attention flag.
-- ===========================================================================


create type public.sheet_sync_event_kind as enum (
  'register',
  'results',
  'correction',
  'disposition'
);

create type public.sheet_reconciliation_status as enum (
  'not_checked',
  'matches',
  'row_relocated',
  'payload_drift',
  'row_missing',
  'duplicate_rows'
);


-- ---------------------------------------------------------------------------
-- sheet_sync_outbox.
--
-- EXACTLY ONE event per (sample, kind, payload revision) is a UNIQUE
-- constraint, not a convention. A retried RPC, a duplicated Edge Function
-- invocation or a second enqueue inside the same transaction all collide on
-- the index instead of appending a second spreadsheet row.
-- ---------------------------------------------------------------------------

create table public.sheet_sync_outbox (
  event_id              uuid primary key default gen_random_uuid(),
  sample_uuid           uuid not null references public.samples (id) on delete restrict,
  -- The exact tab name, e.g. '1 Raw materials'. Resolved from the registry at
  -- enqueue time so the worker never has to map a stage to a tab itself.
  target_tab            text not null,
  event_kind            public.sheet_sync_event_kind not null,

  -- The sample revision this payload represents. A worker holding an older
  -- revision must not apply it over a newer one (Master Prompt section 7:
  -- "guard against ... stale jobs applying after newer revisions").
  payload_revision      integer not null,
  payload_hash          text not null,
  -- The projected row: the 98-column mapping for that tab, as
  -- {column_letter: value}. Typed per-column results live in
  -- sample_measurements; this is the RENDERING of them, and it is frozen at
  -- enqueue time so what the worker writes is what was committed.
  payload               jsonb not null,

  state                 public.sheet_sync_state not null default 'pending',
  attempt_count         integer not null default 0,
  next_retry_at         timestamptz not null default now(),
  last_error            text,
  last_attempt_at       timestamptz,

  -- Lease fields. A leased event is being worked on by exactly one worker.
  lease_holder          text,
  leased_until          timestamptz,
  fence_token           bigint,

  confirmed_at          timestamptz,
  -- The IMMUTABLE sample identifier as located in column A of the target tab.
  -- The row number is a hint, never the identity: the sheet may be re-sorted
  -- by a human at any time.
  external_record_key   text,
  external_row_number   integer,
  reconciliation_status public.sheet_reconciliation_status not null default 'not_checked',
  reconciled_at         timestamptz,

  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  -- EXACTLY ONE event per sample, kind and revision.
  constraint sheet_sync_outbox_one_per_revision
    unique (sample_uuid, event_kind, payload_revision),

  constraint sheet_sync_outbox_tab_present check (length(btrim(target_tab)) > 0),
  constraint sheet_sync_outbox_hash_shape check (payload_hash ~ '^[0-9a-f]{64}$'),
  constraint sheet_sync_outbox_payload_is_object check (jsonb_typeof(payload) = 'object'),
  constraint sheet_sync_outbox_revision_positive check (payload_revision >= 1),
  constraint sheet_sync_outbox_attempts_nonneg check (attempt_count >= 0),
  -- A confirmed event has a confirmation time and the key it was matched on,
  -- and nothing else may claim either. This is the database half of rule 6.
  constraint sheet_sync_outbox_confirmation_shape check (
    (state = 'confirmed'
      and confirmed_at is not null
      and external_record_key is not null)
    or
    (state <> 'confirmed'
      and confirmed_at is null)
  ),
  -- A leased event names its holder, its expiry and its fence token.
  constraint sheet_sync_outbox_lease_shape check (
    (state = 'leased'
      and lease_holder is not null
      and leased_until is not null
      and fence_token is not null)
    or
    (state <> 'leased' and lease_holder is null and leased_until is null)
  ),
  constraint sheet_sync_outbox_error_on_failure check (
    state not in ('failed', 'dead_letter') or last_error is not null
  ),
  constraint sheet_sync_outbox_row_number_positive check (
    -- Rows 1-4 are the protected header region of every operational tab
    -- (rows 1-2 title and instruction, ROW 3 the merged section band, row 4
    -- the headers). Data starts at row 5, so a write target below that is a
    -- bug, not a value.
    external_row_number is null or external_row_number >= 5
  )
);

-- The worker's claim query: the oldest due, unleased event.
create index sheet_sync_outbox_due_idx
  on public.sheet_sync_outbox (next_retry_at, created_at)
  where state in ('pending', 'failed');

create index sheet_sync_outbox_sample_idx on public.sheet_sync_outbox (sample_uuid, created_at desc);
create index sheet_sync_outbox_attention_idx on public.sheet_sync_outbox (created_at desc)
  where state = 'dead_letter';
create index sheet_sync_outbox_leased_idx on public.sheet_sync_outbox (leased_until)
  where state = 'leased';

create trigger sheet_sync_outbox_set_updated_at
  before update on public.sheet_sync_outbox
  for each row execute function public.tg_set_updated_at();

comment on constraint sheet_sync_outbox_one_per_revision on public.sheet_sync_outbox is
  'Exactly one outbox event per sample, kind and revision. A duplicate enqueue collides here instead of producing a second spreadsheet row.';
comment on column public.sheet_sync_outbox.external_row_number is
  'A HINT for locating the row quickly. Identity is the sample ID in column A; the sheet may be re-sorted by a human at any time.';


-- ---------------------------------------------------------------------------
-- sheet_sync_worker_lease  one row, one writer.
--
-- Google Sheets has no transactions. Two workers appending concurrently
-- produce duplicate operational rows that no later reconciliation can tell
-- apart from legitimate repeat sampling. So writes are serialised by a lease
-- on the workbook, with a MONOTONIC FENCE TOKEN: a worker whose lease expired
-- while it was stalled comes back holding an older token, and every write path
-- checks the token before applying anything.
--
-- The lease covers the whole workbook, not a tab, because a cross-tab
-- operation is not atomic in the Sheets API.
-- ---------------------------------------------------------------------------

create table public.sheet_sync_worker_lease (
  workbook_key  text primary key,
  lease_holder  text,
  leased_at     timestamptz,
  leased_until  timestamptz,
  -- Only ever increases. Granted on acquisition.
  fence_token   bigint not null default 0,
  last_heartbeat_at timestamptz,
  updated_at    timestamptz not null default now(),

  constraint sheet_sync_worker_lease_shape
    check ((lease_holder is null) = (leased_until is null)),
  constraint sheet_sync_worker_lease_fence_nonneg check (fence_token >= 0)
);

-- A single logical workbook. The KEY is a label, never the spreadsheet ID:
-- the identifier is an Edge Function secret and must not be recoverable from
-- the database.
--
-- The literal MUST equal WORKBOOK_KEY in
-- supabase/functions/_shared/adapters/store.ts, which is 'operational-workbook'
-- with a HYPHEN. That constant is imported by all five sync entrypoints and is
-- passed as p_workbook_key on every lease call, so a divergence here is a
-- divergence everywhere: rpc_acquire_sheet_lease would match no row and the
-- worker would report lease_conflict forever while the outbox grew without
-- bound. Changing the SQL fixes all five call sites at once; changing the
-- TypeScript would have to be done in one place and verified in five.
insert into public.sheet_sync_worker_lease (workbook_key, fence_token)
values ('operational-workbook', 0);

-- The divergence above was silent because nothing asserted the row's key. Two
-- structural guards so it cannot recur:
--
--  1. Exactly ONE lease row may ever exist. The lease is the single-writer
--     control for the whole workbook; a second row is not a second workbook,
--     it is the mutual exclusion silently ceasing to hold. A unique index on a
--     constant expression permits exactly one row, for every writer including
--     the table owner and a SECURITY DEFINER function.
--  2. That row's key is the one the application actually sends. A CHECK is
--     evaluated per row on write, so a future edit to the literal fails here
--     instead of at runtime in the worker.
create unique index sheet_sync_worker_lease_singleton
  on public.sheet_sync_worker_lease ((true));

alter table public.sheet_sync_worker_lease
  add constraint sheet_sync_worker_lease_key_matches_client
  check (workbook_key = 'operational-workbook');

comment on constraint sheet_sync_worker_lease_key_matches_client
  on public.sheet_sync_worker_lease is
  'The key WORKBOOK_KEY in supabase/functions/_shared/adapters/store.ts sends. A hyphen/underscore divergence here made the only lease row unmatchable and the sync worker reported lease_conflict forever.';
comment on index public.sheet_sync_worker_lease_singleton is
  'Exactly one lease row. A unique index on a constant expression; a second row would end the mutual exclusion the single-writer design depends on.';

create function public.tg_guard_fence_token()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.fence_token < old.fence_token then
    raise exception
      'A sync lease fence token is monotonic: cannot move from % to %',
      old.fence_token, new.fence_token
      using errcode = '23514';
  end if;
  new.updated_at := now();
  return new;
end;
$$;

create trigger sheet_sync_worker_lease_guard
  before update on public.sheet_sync_worker_lease
  for each row execute function public.tg_guard_fence_token();


-- ---------------------------------------------------------------------------
-- sheet_schema_verifications  the header-fidelity gate, recorded.
--
-- Master Prompt section 3: "Validate original row-4 header names from the
-- actual workbook before selecting production Sheet; when names diverge from
-- this prompt, stop deployment until reconciled."
--
-- A verification is an EVENT with an outcome, not a boolean flag somebody
-- sets. Appending a row is how the worker earns the right to write, and the
-- row says exactly what was compared.
-- ---------------------------------------------------------------------------

create table public.sheet_schema_verifications (
  id                uuid primary key default gen_random_uuid(),
  verified_at       timestamptz not null default now(),
  -- 'passed' | 'failed'. A failure must stop writes, which is why the worker
  -- requires a PASSED verification inside its freshness window rather than
  -- merely the absence of a failure.
  outcome           text not null,
  tabs_expected     integer not null,
  tabs_found        integer not null,
  headers_expected  integer not null,
  headers_matched   integer not null,
  divergences       jsonb not null default '[]'::jsonb,
  -- True when a legacy sample-ID formula was still present in A5 of any
  -- operational tab. The server assigns identifiers, so a surviving formula
  -- would fight the registration (workbook verification Finding 7, cutover
  -- step C-04).
  formula_in_a5     boolean,
  protected_rows_ok boolean,
  notes             text,
  recorded_by       uuid references public.profiles (id),

  constraint sheet_schema_verifications_outcome_valid
    check (outcome in ('passed', 'failed')),
  constraint sheet_schema_verifications_counts_nonneg
    check (tabs_expected >= 0 and tabs_found >= 0
           and headers_expected >= 0 and headers_matched >= 0),
  constraint sheet_schema_verifications_divergences_is_array
    check (jsonb_typeof(divergences) = 'array'),
  -- A pass means every tab and every header matched and no divergence was
  -- recorded. The three cannot disagree.
  constraint sheet_schema_verifications_pass_is_complete check (
    outcome <> 'passed'
    or (tabs_found = tabs_expected
        and headers_matched = headers_expected
        and jsonb_array_length(divergences) = 0
        and coalesce(formula_in_a5, true) = false
        and coalesce(protected_rows_ok, false) = true)
  )
);

create index sheet_schema_verifications_recent_idx
  on public.sheet_schema_verifications (verified_at desc);

create trigger sheet_schema_verifications_append_only
  before update or delete on public.sheet_schema_verifications
  for each row execute function public.tg_append_only();

comment on constraint sheet_schema_verifications_pass_is_complete on public.sheet_schema_verifications is
  'A pass cannot be recorded while a tab is missing, a header diverges, a legacy A5 formula survives or the protected header rows are unverified. The outcome cannot contradict its own evidence.';


-- ---------------------------------------------------------------------------
-- samples.sheet_sync_state, maintained from the outbox.
-- ---------------------------------------------------------------------------

create function public.tg_refresh_sample_sync_state()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sample uuid := coalesce(new.sample_uuid, old.sample_uuid);
  v_state  public.sheet_sync_state;
  v_row    integer;
  v_at     timestamptz;
begin
  -- The worst outstanding state wins, so a confirmed registration followed by
  -- a pending results update reads as pending. Showing "Confirmed" while any
  -- part of the record is unwritten would be the false green that rule 6
  -- forbids.
  select
    case
      when count(*) filter (where o.state = 'dead_letter') > 0 then 'dead_letter'
      when count(*) filter (where o.state = 'failed')      > 0 then 'failed'
      when count(*) filter (where o.state = 'leased')      > 0 then 'leased'
      when count(*) filter (where o.state = 'pending')     > 0 then 'pending'
      when count(*) > 0                                        then 'confirmed'
      else 'pending'
    end,
    max(o.external_row_number),
    max(o.confirmed_at)
  into v_state, v_row, v_at
  from public.sheet_sync_outbox o
  where o.sample_uuid = v_sample;

  update public.samples s
     set sheet_sync_state   = v_state,
         sheet_row_hint     = coalesce(v_row, s.sheet_row_hint),
         -- samples_sheet_confirmation_pair requires these two to agree.
         sheet_confirmed_at = case when v_state = 'confirmed' then v_at else null end
   where s.id = v_sample;

  return null;
end;
$$;

create trigger sheet_sync_outbox_refresh_sample
  after insert or update or delete on public.sheet_sync_outbox
  for each row execute function public.tg_refresh_sample_sync_state();


-- ---------------------------------------------------------------------------
-- Row level security.
-- ---------------------------------------------------------------------------

alter table public.sheet_sync_outbox            enable row level security;
alter table public.sheet_sync_worker_lease      enable row level security;
alter table public.sheet_schema_verifications   enable row level security;

-- Sync health is visible to anyone with sync.view, which includes the
-- Administrator, the Quality Officer and the Quality Supervisor. A failed sync
-- MUST be visible and escalatable, so this is a read grant and not a secret.
create policy sheet_sync_outbox_select_sync_viewers on public.sheet_sync_outbox
  for select to authenticated
  using (public.has_permission('sync.view'));

create policy sheet_schema_verifications_select_sync_viewers
  on public.sheet_schema_verifications
  for select to authenticated
  using (public.has_permission('sync.view'));

-- No policy on the lease table. It is worker machinery, and its contents say
-- nothing a user needs.

-- No write policy anywhere in this migration. The outbox is written by
-- public.enqueue_sheet_sync_event() during a committed mutation, and advanced
-- by the worker functions in 0012, which are granted to service_role only. An
-- authenticated client cannot mark a row confirmed, which is what stops a
-- browser from asserting that the spreadsheet holds something it does not.


-- ---------------------------------------------------------------------------
-- Privileges.
-- ---------------------------------------------------------------------------

revoke all on public.sheet_sync_outbox          from anon, authenticated;
revoke all on public.sheet_sync_worker_lease    from anon, authenticated;
revoke all on public.sheet_schema_verifications from anon, authenticated;

grant select on public.sheet_sync_outbox          to authenticated;
grant select on public.sheet_schema_verifications to authenticated;

revoke all on function public.tg_guard_fence_token() from public;
revoke all on function public.tg_refresh_sample_sync_state() from public;
