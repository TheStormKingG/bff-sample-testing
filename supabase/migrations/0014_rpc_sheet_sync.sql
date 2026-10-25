-- ---------------------------------------------------------------------------
-- 0014_rpc_sheet_sync.sql
--
-- The durable-sync RPCs: the single-writer lease, the outbox claim and
-- outcome, row confirmation, schema drift, workbook state, and the two repairs
-- reconciliation performs.
--
--   rpc_acquire_sheet_lease   rpc_renew_sheet_lease    rpc_release_sheet_lease
--   rpc_read_sheet_lease      rpc_claim_outbox_batch   rpc_record_outbox_outcome
--   rpc_confirm_sheet_row     rpc_mark_schema_drifted  rpc_read_workbook_state
--   rpc_write_workbook_verification                    rpc_requeue_outbox_event
--   rpc_retry_dead_lettered   rpc_write_reconciliation_report
--
-- THE FENCE IS CHECKED HERE, NOT IN THE WORKER. _shared/adapters/store.ts says
-- so explicitly: "a check in this file would be advisory, because the process
-- doing the checking is the same process whose staleness is in question. Only
-- the database knows the current fence." So every function below that acts
-- under a lease re-reads the lease row and refuses on a stale fence, and none
-- of them trusts the owner string alone.
--
-- A refusal RAISES rather than returning zero rows wherever "nothing happened"
-- and "you have lost the lease" would otherwise look identical to the caller.
-- A worker that reads an empty batch concludes there is no work and goes back
-- to sleep; a worker that has lost its lease must stop, and the two must not
-- be the same answer.
-- ---------------------------------------------------------------------------


-- ---------------------------------------------------------------------------
-- The fence check, in one place.
-- ---------------------------------------------------------------------------

-- The lease is keyed on the WORKBOOK, not on a tab. Three of the functions
-- below are reached with a sample or an event rather than a workbook key -- the
-- outcome, the row confirmation and the re-queue -- and the thing they hold is
-- a sheet TAB name such as '1 Raw materials'. Passing that to the lease check
-- would look right and match nothing, because the lease row's key is
-- 'operational-workbook'.
--
-- Resolved from the single lease row rather than from a literal, so there is
-- one place the key is written (the seeded row in 0007) and no copy of it here
-- to drift. 0007 guarantees exactly one such row with a unique index on a
-- constant expression, which is what makes "the" lease row a well-defined
-- thing to read.
create function public.operational_workbook_key()
returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  v_key   text;
  v_count integer;
begin
  select count(*) into v_count from public.sheet_sync_worker_lease;

  if v_count <> 1 then
    raise exception
      'BFF_LEASE_ROW_COUNT: expected exactly one sync lease row, found %. The single-writer lease is not mutually exclusive with more than one.',
      v_count
      using errcode = '42704';
  end if;

  select l.workbook_key into v_key from public.sheet_sync_worker_lease l;
  return v_key;
end;
$$;


create function public.assert_sheet_lease(
  p_workbook_key text,
  p_owner        text,
  p_fence        bigint
)
returns void
language plpgsql
stable
set search_path = ''
as $$
declare
  v_lease public.sheet_sync_worker_lease;
begin
  select * into v_lease
  from public.sheet_sync_worker_lease
  where workbook_key = p_workbook_key;

  if v_lease.workbook_key is null then
    raise exception
      'BFF_NO_LEASE_ROW: no sync lease exists for workbook "%". The lease row is seeded by the migrations and its key must match WORKBOOK_KEY in supabase/functions/_shared/adapters/store.ts.',
      p_workbook_key
      using errcode = '42704';
  end if;

  if v_lease.lease_holder is distinct from p_owner then
    raise exception
      'BFF_LEASE_LOST: the sync lease for "%" is held by % , not %',
      p_workbook_key, coalesce(v_lease.lease_holder, '(nobody)'), p_owner
      using errcode = '55P03';
  end if;

  if v_lease.fence_token <> p_fence then
    raise exception
      'BFF_FENCE_STALE: fence % is stale; the current fence for "%" is %',
      p_fence, p_workbook_key, v_lease.fence_token
      using errcode = '55P03';
  end if;

  if v_lease.leased_until is null or v_lease.leased_until <= now() then
    raise exception
      'BFF_LEASE_EXPIRED: the sync lease for "%" expired at %',
      p_workbook_key, v_lease.leased_until
      using errcode = '55P03';
  end if;
end;
$$;


-- ---------------------------------------------------------------------------
-- rpc_acquire_sheet_lease(p_workbook_key, p_owner, p_ttl_ms)
--
-- Call site: _shared/adapters/store.ts:122. Return shape: LeaseRow, or NO ROW
-- when the lease is held by somebody else -- toLease(firstRow(...)) turns that
-- into null and the worker reports lease_conflict, which is the correct and
-- quiet outcome for a second worker arriving on schedule.
--
-- ONE statement with the condition in its WHERE clause, so two workers racing
-- cannot both acquire: the second one's UPDATE matches no row once the first
-- has committed. A read followed by a conditional write would let both pass the
-- read.
--
-- The fence is granted on acquisition and only ever increases, which is what
-- makes a resumed-from-the-dead worker's writes refusable: it still carries the
-- old number. Re-acquiring as the SAME holder extends the lease WITHOUT
-- bumping the fence -- bumping it would invalidate the in-flight events the
-- holder has already claimed under the old one.
-- ---------------------------------------------------------------------------

create function public.rpc_acquire_sheet_lease(
  p_workbook_key text,
  p_owner        text,
  p_ttl_ms       integer
)
returns table (
  workbook_key text,
  owner        text,
  fence        bigint,
  acquired_at  timestamptz,
  expires_at   timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ttl interval := make_interval(secs => greatest(coalesce(p_ttl_ms, 0), 1000) / 1000.0);
begin
  if coalesce(btrim(p_owner), '') = '' then
    raise exception 'BFF_OWNER_REQUIRED: a lease names its holder' using errcode = '22023';
  end if;

  return query
  update public.sheet_sync_worker_lease l
     set lease_holder      = p_owner,
         leased_at         = case
                               -- Same holder extending: keep the original
                               -- acquisition instant, so the lease's age stays
                               -- readable on the sync-health screen.
                               when l.lease_holder = p_owner then coalesce(l.leased_at, now())
                               else now()
                             end,
         leased_until      = now() + v_ttl,
         last_heartbeat_at = now(),
         fence_token       = case
                               when l.lease_holder = p_owner then l.fence_token
                               else l.fence_token + 1
                             end
   where l.workbook_key = p_workbook_key
     and (
       -- Free, expired, or already ours.
       l.lease_holder is null
       or l.leased_until is null
       or l.leased_until <= now()
       or l.lease_holder = p_owner
     )
  returning l.workbook_key, l.lease_holder, l.fence_token, l.leased_at, l.leased_until;
end;
$$;


-- ---------------------------------------------------------------------------
-- rpc_renew_sheet_lease(p_workbook_key, p_owner, p_fence, p_ttl_ms)
--
-- Call site: _shared/adapters/store.ts:137. Returns NO ROW when the lease is no
-- longer ours, which the worker reads as a lost lease and stops on. The fence
-- is NOT bumped: a renewal is the same lease continuing, and bumping would
-- invalidate the holder's own claimed events.
-- ---------------------------------------------------------------------------

create function public.rpc_renew_sheet_lease(
  p_workbook_key text,
  p_owner        text,
  p_fence        bigint,
  p_ttl_ms       integer
)
returns table (
  workbook_key text,
  owner        text,
  fence        bigint,
  acquired_at  timestamptz,
  expires_at   timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ttl interval := make_interval(secs => greatest(coalesce(p_ttl_ms, 0), 1000) / 1000.0);
begin
  return query
  update public.sheet_sync_worker_lease l
     set leased_until      = now() + v_ttl,
         last_heartbeat_at = now()
   where l.workbook_key = p_workbook_key
     and l.lease_holder = p_owner
     and l.fence_token = p_fence
     -- An EXPIRED lease is not renewable. Another worker may already have
     -- taken it with a higher fence, and extending ours would hand two
     -- processes a live lease over the same workbook.
     and l.leased_until > now()
  returning l.workbook_key, l.lease_holder, l.fence_token, l.leased_at, l.leased_until;
end;
$$;


-- ---------------------------------------------------------------------------
-- rpc_release_sheet_lease(p_workbook_key, p_owner, p_fence)
--
-- Call site: _shared/adapters/store.ts:148, returns void. Releasing a lease we
-- no longer hold is silently nothing, deliberately: a worker shutting down
-- after its lease lapsed should not fail, and the row already says somebody
-- else holds it. sheet_sync_worker_lease_shape requires holder and expiry to be
-- null together.
--
-- Events still LEASED to this owner are returned to the queue in the same
-- statement. Leaving them leased to a departed worker would strand them until
-- their lease expired, and the outbox is the thing that must not stall.
-- ---------------------------------------------------------------------------

create function public.rpc_release_sheet_lease(
  p_workbook_key text,
  p_owner        text,
  p_fence        bigint
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_released integer;
begin
  update public.sheet_sync_worker_lease l
     set lease_holder = null,
         leased_at    = null,
         leased_until = null
   where l.workbook_key = p_workbook_key
     and l.lease_holder = p_owner
     and l.fence_token = p_fence;

  get diagnostics v_released = row_count;

  if v_released = 0 then
    return;
  end if;

  update public.sheet_sync_outbox o
     set state        = 'pending',
         lease_holder = null,
         leased_until = null
   where o.state = 'leased'
     and o.lease_holder = p_owner
     and o.fence_token = p_fence;
end;
$$;


-- ---------------------------------------------------------------------------
-- rpc_read_sheet_lease(p_workbook_key)
--
-- Call site: _shared/adapters/store.ts:130. No row when the lease is unheld:
-- LeaseRow declares `owner: string`, so returning a row with a null owner would
-- hand the worker a lease object describing nobody.
-- ---------------------------------------------------------------------------

create function public.rpc_read_sheet_lease(p_workbook_key text)
returns table (
  workbook_key text,
  owner        text,
  fence        bigint,
  acquired_at  timestamptz,
  expires_at   timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select l.workbook_key, l.lease_holder, l.fence_token, l.leased_at, l.leased_until
  from public.sheet_sync_worker_lease l
  where l.workbook_key = p_workbook_key
    and l.lease_holder is not null;
$$;


-- ---------------------------------------------------------------------------
-- rpc_claim_outbox_batch(p_workbook_key, p_owner, p_fence, p_limit)
--
-- Call site: _shared/adapters/store.ts:158. Return shape: OutboxRow[].
--
-- FOR UPDATE SKIP LOCKED, so a concurrent claim never blocks and never hands
-- the same event to two workers. The lease already makes a second writer
-- illegitimate; this makes the claim safe even while one is being refused.
--
-- `attempt_count` is deliberately NOT incremented here. OutboxEvent.attempts
-- "counts attempts BEFORE this one" and nextOutboxState() computes
-- `args.event.attempts + 1` itself, so incrementing on claim would double-count
-- and the backoff would reach the dead-letter ceiling in half the attempts.
--
-- An event whose own lease has EXPIRED is reclaimable: its worker died
-- mid-flight, and leaving it leased forever is the stall this whole mechanism
-- exists to avoid. It comes back with reconcile_first untouched, so an unknown
-- outcome still forces a read before the next write.
-- ---------------------------------------------------------------------------

create function public.rpc_claim_outbox_batch(
  p_workbook_key text,
  p_owner        text,
  p_fence        bigint,
  p_limit        integer
)
returns table (
  id                   uuid,
  sample_uuid          uuid,
  sample_id            text,
  stage                public.sample_stage,
  kind                 text,
  revision             integer,
  payload_hash         text,
  "row"                text[],
  state                text,
  attempts             integer,
  next_attempt_at      timestamptz,
  reconcile_first      boolean,
  last_error           text,
  confirmed_row_number integer,
  confirmed_at         timestamptz,
  created_at           timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_until timestamptz;
begin
  perform public.assert_sheet_lease(p_workbook_key, p_owner, p_fence);

  select l.leased_until into v_until
  from public.sheet_sync_worker_lease l
  where l.workbook_key = p_workbook_key;

  return query
  with due as (
    select o.event_id
    from public.sheet_sync_outbox o
    where (
            (o.state in ('pending', 'failed') and o.next_retry_at <= now())
            -- Reclaim after a dead worker: leased, but the lease has lapsed.
            or (o.state = 'leased' and o.leased_until is not null and o.leased_until <= now())
          )
    order by o.next_retry_at, o.created_at
    limit greatest(coalesce(p_limit, 0), 0)
    for update skip locked
  ),
  claimed as (
    update public.sheet_sync_outbox o
       set state           = 'leased',
           lease_holder    = p_owner,
           leased_until    = v_until,
           fence_token     = p_fence,
           last_attempt_at = now()
     where o.event_id in (select event_id from due)
    returning o.*
  )
  select c.event_id, c.sample_uuid, s.sample_id, s.stage,
         public.outbox_kind_to_client(c.event_kind),
         c.payload_revision, c.payload_hash, c.projected_row,
         public.outbox_state_to_client(c.state),
         c.attempt_count, c.next_retry_at, c.reconcile_first, c.last_error,
         c.external_row_number, c.confirmed_at, c.created_at
  from claimed c
  join public.samples s on s.id = c.sample_uuid
  order by c.next_retry_at, c.created_at;
end;
$$;


-- ---------------------------------------------------------------------------
-- rpc_record_outbox_outcome(...)
--
-- Call site: _shared/adapters/store.ts:253, twelve named arguments. Writes the
-- transition nextOutboxState() computed; the policy stays in that tested pure
-- function and this records its result.
--
-- The three constraints this has to satisfy together, which is why the
-- confirmation fields are derived from the NEW STATE rather than copied
-- through: sheet_sync_outbox_confirmation_shape (only a confirmed event has a
-- confirmed_at), sheet_sync_outbox_confirmed_hash_shape (only a confirmed
-- event has a matched hash) and sheet_sync_outbox_lease_shape (only a leased
-- event names a holder). terminal() in outbox.ts passes the event's EXISTING
-- confirmedAt through on a non-confirming transition, so copying it verbatim
-- would violate the first of those.
-- ---------------------------------------------------------------------------

create function public.rpc_record_outbox_outcome(
  p_event_id             uuid,
  p_owner                text,
  p_fence                bigint,
  p_state                text,
  p_attempts             integer,
  p_next_attempt_at      timestamptz,
  p_reconcile_first      boolean,
  p_last_error           text,
  p_confirmed_row_number integer,
  p_confirmed_at         timestamptz,
  p_dead_lettered        boolean,
  p_decision             jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_state   public.sheet_sync_state := public.outbox_state_from_client(p_state);
  v_event   public.sheet_sync_outbox;
  v_sample  text;
begin
  select * into v_event
  from public.sheet_sync_outbox
  where event_id = p_event_id
  for update;

  if v_event.event_id is null then
    raise exception 'BFF_UNKNOWN_OUTBOX_EVENT: no outbox event %', p_event_id
      using errcode = '23503';
  end if;

  -- The WORKBOOK key, not v_event.target_tab: the tab is '1 Raw materials',
  -- the lease is keyed 'operational-workbook'.
  perform public.assert_sheet_lease(public.operational_workbook_key(), p_owner, p_fence);

  -- The event's OWN fence, not just the workbook lease. An event claimed under
  -- fence 4 must not be written by a process now holding fence 5: the newer
  -- holder may already have re-claimed and re-processed it.
  if v_event.fence_token is distinct from p_fence then
    raise exception
      'BFF_FENCE_STALE: event % was claimed under fence %, not %',
      p_event_id, v_event.fence_token, p_fence
      using errcode = '55P03';
  end if;

  update public.sheet_sync_outbox o
     set state         = v_state,
         attempt_count = greatest(coalesce(p_attempts, o.attempt_count), 0),
         -- A terminal state has no next attempt. next_retry_at is NOT NULL, so
         -- "never again" is recorded as now() and the state is what stops it
         -- being picked up, which is the only representation the column allows.
         next_retry_at = coalesce(p_next_attempt_at, now()),
         reconcile_first = coalesce(p_reconcile_first, false),
         last_error    = p_last_error,
         last_decision = p_decision,
         lease_holder  = case when v_state = 'leased' then o.lease_holder else null end,
         leased_until  = case when v_state = 'leased' then o.leased_until else null end,
         external_row_number = case
                                 when v_state = 'confirmed'
                                 then coalesce(p_confirmed_row_number, o.external_row_number)
                                 else o.external_row_number
                               end,
         confirmed_at  = case
                           when v_state = 'confirmed'
                           then coalesce(p_confirmed_at, o.confirmed_at, now())
                           else null
                         end,
         confirmed_payload_hash = case
                                    when v_state = 'confirmed'
                                    -- rpc_confirm_sheet_row runs first on both
                                    -- confirming paths and sets this. The
                                    -- payload hash is the fallback so the
                                    -- constraint is satisfiable if the order
                                    -- ever changes.
                                    then coalesce(o.confirmed_payload_hash, o.payload_hash)
                                    else null
                                  end
   where o.event_id = p_event_id;

  if coalesce(p_dead_lettered, false) then
    select s.sample_id into v_sample from public.samples s where s.id = v_event.sample_uuid;

    -- A dead letter is the alert. Recorded as an audit event with outcome
    -- 'failed' so it is visible to audit.view and not only on a sync screen
    -- somebody has to remember to open.
    perform public.record_audit_event(
      p_action      => 'sheet_sync.dead_lettered',
      p_entity_type => 'sheet_sync',
      p_entity_id   => p_event_id::text,
      p_sample_uuid => v_event.sample_uuid,
      p_reason      => p_last_error,
      p_before      => jsonb_build_object('state', v_event.state, 'attempts', v_event.attempt_count),
      p_after       => jsonb_build_object(
                         'state', v_state,
                         'attempts', p_attempts,
                         'sample_id', v_sample,
                         'target_tab', v_event.target_tab,
                         'decision', p_decision
                       ),
      p_outcome     => 'failed',
      -- No person acted. audit_events.actor_id is nullable for exactly this.
      p_actor_id    => null
    );
  end if;
end;
$$;


-- ---------------------------------------------------------------------------
-- rpc_confirm_sheet_row(...)
--
-- Call site: _shared/adapters/store.ts:329, eight named arguments. Called on
-- both confirming paths -- after a verified write and after a no-op where the
-- sheet already held exactly this row -- and by reconcile-sheets when it
-- relocates a row a human moved.
--
-- Identity is the SAMPLE and the REVISION, never the row number: "the row
-- number is a hint, never the identity: the sheet may be re-sorted by a human
-- at any time". So the event is located by (sample, revision) and the row
-- number is written onto it.
--
-- p_payload_hash is stored in confirmed_payload_hash and NOT in payload_hash:
-- the Edge Function's rowHash() prefixes the algorithm ('sha256:...'), which
-- the hex-only sheet_sync_outbox_hash_shape would reject, and overwriting the
-- enqueue-time hash would destroy the record of what the event meant to write.
-- ---------------------------------------------------------------------------

create function public.rpc_confirm_sheet_row(
  p_sample_uuid  uuid,
  p_owner        text,
  p_fence        bigint,
  p_stage        public.sample_stage,
  p_row_number   integer,
  p_revision     integer,
  p_payload_hash text,
  p_confirmed_at timestamptz
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tab     text;
  v_updated integer;
begin
  select d.sheet_tab into v_tab
  from public.stage_definitions d
  where d.stage = p_stage;

  if v_tab is null then
    raise exception 'BFF_UNKNOWN_STAGE: % has no operational tab', p_stage
      using errcode = '23503';
  end if;

  -- The WORKBOOK key, not the tab name v_tab resolved above: v_tab is used for
  -- the protected-row message below, and the lease is keyed per workbook.
  perform public.assert_sheet_lease(public.operational_workbook_key(), p_owner, p_fence);

  -- Rows 1-4 are the protected header region of every operational tab (rows
  -- 1-2 title, ROW 3 the merged section band, ROW 4 the headers). Data starts
  -- at row 5, so a confirmation below that is a bug being recorded as a fact.
  -- sheet_sync_outbox_row_number_positive would also refuse it, but a named
  -- error says why.
  if p_row_number is null or p_row_number < 5 then
    raise exception
      'BFF_PROTECTED_ROW: row % is inside the protected header region of "%"; operational data starts at row 5',
      p_row_number, v_tab
      using errcode = '23514';
  end if;

  update public.sheet_sync_outbox o
     set state                  = 'confirmed',
         external_row_number    = p_row_number,
         confirmed_at           = coalesce(p_confirmed_at, now()),
         confirmed_payload_hash = p_payload_hash,
         reconciliation_status  = 'matches',
         reconciled_at          = now(),
         lease_holder           = null,
         leased_until           = null,
         last_error             = null
   where o.sample_uuid = p_sample_uuid
     and o.payload_revision = p_revision
     and o.state <> 'superseded';

  get diagnostics v_updated = row_count;

  if v_updated = 0 then
    -- Confirming a row for an event that does not exist would make the
    -- confirmation unrecorded while the worker believed it had succeeded, and
    -- the next pass would write the row a second time.
    raise exception
      'BFF_NO_EVENT_TO_CONFIRM: no live outbox event for sample % at revision %',
      p_sample_uuid, p_revision
      using errcode = '23503';
  end if;

  -- Every OLDER revision of this sample is now overtaken: the sheet holds a
  -- newer row and writing an older one would roll the operational record
  -- backwards. This is the 'superseded' state that OUTBOX_STATES carries and
  -- that nothing could reach before it existed.
  update public.sheet_sync_outbox o
     set state        = 'superseded',
         lease_holder = null,
         leased_until = null,
         last_error   = format('Superseded by revision %s, confirmed in the sheet.', p_revision)
   where o.sample_uuid = p_sample_uuid
     and o.payload_revision < p_revision
     and o.state in ('pending', 'failed', 'leased');
end;
$$;


-- ---------------------------------------------------------------------------
-- rpc_mark_schema_drifted(p_workbook_key, p_owner, p_fence, p_problems)
--
-- Call site: _shared/adapters/store.ts:201. Master Prompt section 3: "when
-- names diverge from this prompt, stop deployment until reconciled." Drift is
-- recorded WITH the divergences, never as a bare flag -- the
-- sheet_workbook_state_drift_has_problems constraint refuses a flag with
-- nothing behind it, because an administrator cannot act on "something is
-- wrong".
--
-- Marking drift also CLEARS the verified-stage list. A drifted workbook has no
-- verified tab, and leaving the old list in place would let the worker keep
-- writing to tabs it last checked before the headers moved.
-- ---------------------------------------------------------------------------

create function public.rpc_mark_schema_drifted(
  p_workbook_key text,
  p_owner        text,
  p_fence        bigint,
  p_problems     jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_problems jsonb := coalesce(p_problems, '[]'::jsonb);
begin
  perform public.assert_sheet_lease(p_workbook_key, p_owner, p_fence);

  if jsonb_typeof(v_problems) <> 'array' then
    raise exception 'BFF_PROBLEMS_SHAPE: the schema problems must be a list'
      using errcode = '22023';
  end if;

  if jsonb_array_length(v_problems) = 0 then
    -- "The headers drifted, and here is nothing" is not a finding. Refusing it
    -- keeps the flag and its evidence from ever disagreeing.
    raise exception
      'BFF_PROBLEMS_REQUIRED: schema drift is recorded with the divergences that were found, never as a bare flag'
      using errcode = '22023';
  end if;

  update public.sheet_workbook_state w
     set schema_drifted  = true,
         schema_problems = v_problems,
         verified_stages = '{}'::public.sample_stage[],
         last_verified_at = null
   where w.workbook_key = p_workbook_key;

  if not found then
    raise exception 'BFF_UNKNOWN_WORKBOOK: no state row for workbook "%"', p_workbook_key
      using errcode = '23503';
  end if;

  perform public.record_audit_event(
    p_action      => 'sheet_sync.schema_drifted',
    p_entity_type => 'sheet_sync',
    p_entity_id   => p_workbook_key,
    p_reason      => 'The workbook headers diverge from the registry; writes are stopped until reconciled.',
    p_after       => jsonb_build_object('problems', v_problems, 'detected_by', p_owner),
    p_outcome     => 'failed',
    p_actor_id    => null
  );
end;
$$;


-- ---------------------------------------------------------------------------
-- rpc_read_workbook_state(p_workbook_key)
--
-- Call site: _shared/adapters/store.ts:171. Return shape: WorkbookStateRow.
-- readVerificationState() treats no row as "nothing verified, not drifted", so
-- an absent row is a legitimate answer and not an error.
-- ---------------------------------------------------------------------------

create function public.rpc_read_workbook_state(p_workbook_key text)
returns table (
  workbook_key       text,
  last_verified_at   timestamptz,
  verified_stages    text[],
  schema_drifted     boolean,
  schema_problems    jsonb,
  last_reconciled_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select w.workbook_key, w.last_verified_at,
         -- As text[], because VerificationState.verifiedStages is a string
         -- array that the adapter filters against STAGES itself.
         (select coalesce(array_agg(s::text order by s), '{}'::text[])
            from unnest(w.verified_stages) as s),
         w.schema_drifted, w.schema_problems, w.last_reconciled_at
  from public.sheet_workbook_state w
  where w.workbook_key = p_workbook_key;
$$;


-- ---------------------------------------------------------------------------
-- rpc_write_workbook_verification(p_workbook_key, p_last_verified_at,
--                                 p_verified_stages, p_schema_drifted)
--
-- Call site: _shared/adapters/store.ts:187, four named arguments.
--
-- p_verified_stages arrives as text[] and each entry is checked against
-- public.sample_stage rather than cast blindly: an unrecognised stage name
-- would otherwise raise a bare invalid-enum error, and worse, a TYPO would be
-- indistinguishable from a tab that genuinely failed its check -- the worker
-- would then refuse to write a tab that had actually passed.
--
-- It writes the STATE row only. public.sheet_schema_verifications, the
-- append-only evidence log from 0007, requires the comparison counts
-- (tabs_expected, tabs_found, headers_expected, headers_matched) and NO RPC in
-- supabase/functions/_shared/rpc.ts carries them. Filling those columns with
-- zeros or guesses would put fabricated evidence in an audit table, so the log
-- is left for the writer that has the real counts. See the return value of this
-- change for that gap stated plainly.
-- ---------------------------------------------------------------------------

create function public.rpc_write_workbook_verification(
  p_workbook_key     text,
  p_last_verified_at timestamptz,
  p_verified_stages  text[],
  p_schema_drifted   boolean
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_stages public.sample_stage[] := '{}'::public.sample_stage[];
  v_name   text;
begin
  foreach v_name in array coalesce(p_verified_stages, '{}'::text[])
  loop
    if not exists (
      select 1 from unnest(enum_range(null::public.sample_stage)) as e(v)
      where e.v::text = v_name
    ) then
      raise exception
        'BFF_UNKNOWN_STAGE: "%" is not one of the seven operational stages', v_name
        using errcode = '22023';
    end if;
    v_stages := v_stages || v_name::public.sample_stage;
  end loop;

  -- Drift and a verified tab list cannot both stand: see
  -- sheet_workbook_state_drift_has_problems. A verification that reports drift
  -- names no verified stage.
  if coalesce(p_schema_drifted, false) and cardinality(v_stages) > 0 then
    raise exception
      'BFF_DRIFT_WITH_VERIFIED_STAGES: a verification cannot report drift and list verified tabs at the same time'
      using errcode = '22023';
  end if;

  update public.sheet_workbook_state w
     set last_verified_at = p_last_verified_at,
         verified_stages  = v_stages,
         schema_drifted   = coalesce(p_schema_drifted, false),
         -- Clearing drift clears its evidence; recording drift through THIS
         -- path carries none, so rpc_mark_schema_drifted is the only way to
         -- record a drift with its divergences and the constraint keeps the two
         -- consistent.
         schema_problems  = case when coalesce(p_schema_drifted, false)
                                 then w.schema_problems
                                 else '[]'::jsonb end
   where w.workbook_key = p_workbook_key;

  if not found then
    raise exception 'BFF_UNKNOWN_WORKBOOK: no state row for workbook "%"', p_workbook_key
      using errcode = '23503';
  end if;
end;
$$;


-- ---------------------------------------------------------------------------
-- rpc_requeue_outbox_event(p_sample_uuid, p_owner, p_fence, p_reason)
--
-- SIGNATURE INFERRED. _shared/rpc.ts declares the NAME but no argument
-- interface for it; these four names are taken verbatim from the only call
-- site, reconcile-sheets/index.ts:282, which passes p_sample_uuid, p_owner,
-- p_fence and a p_reason reading
-- 'Reconciliation found no row for <id> in "<tab>".'
--
-- Keyed on the SAMPLE, not the event, because that is what the call site has:
-- reconciliation compares the ledger against the sheet and finds a sample whose
-- row is absent. The newest live projection for that sample is the thing to
-- write again.
--
-- reconcile_first is set. The sheet has already disagreed with the ledger once,
-- so the next attempt must read before it writes rather than appending a row
-- that may be present after all under a different row number.
-- ---------------------------------------------------------------------------

create function public.rpc_requeue_outbox_event(
  p_sample_uuid uuid,
  p_owner       text,
  p_fence       bigint,
  p_reason      text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event uuid;
  v_tab   text;
begin
  select o.event_id, o.target_tab into v_event, v_tab
  from public.sheet_sync_outbox o
  where o.sample_uuid = p_sample_uuid
    and o.state <> 'superseded'
  order by o.payload_revision desc, o.created_at desc
  limit 1;

  if v_event is null then
    raise exception
      'BFF_NOTHING_TO_REQUEUE: sample % has no live outbox event to re-queue', p_sample_uuid
      using errcode = '23503';
  end if;

  -- The WORKBOOK key, not the tab name v_tab, which is only recorded in the
  -- audit event below.
  perform public.assert_sheet_lease(public.operational_workbook_key(), p_owner, p_fence);

  update public.sheet_sync_outbox o
     set state                  = 'pending',
         next_retry_at          = now(),
         reconcile_first        = true,
         last_error             = p_reason,
         lease_holder           = null,
         leased_until           = null,
         -- The sheet does NOT hold this row: that is the finding that brought
         -- us here. Keeping the confirmation would leave the sample reading as
         -- "Confirmed in Google Sheets" while the row is missing, which is the
         -- false green rule 6 forbids.
         confirmed_at           = null,
         confirmed_payload_hash = null,
         external_row_number    = null,
         reconciliation_status  = 'row_missing',
         reconciled_at          = now()
   where o.event_id = v_event;

  perform public.record_audit_event(
    p_action      => 'sheet_sync.requeued',
    p_entity_type => 'sheet_sync',
    p_entity_id   => v_event::text,
    p_sample_uuid => p_sample_uuid,
    p_reason      => p_reason,
    p_after       => jsonb_build_object('requeued_by', p_owner, 'target_tab', v_tab),
    p_outcome     => 'succeeded',
    p_actor_id    => null
  );
end;
$$;


-- ---------------------------------------------------------------------------
-- rpc_retry_dead_lettered(p_actor, p_app_version, p_sample_uuid)
--
-- SIGNATURE INFERRED, AND THIS ONE HAS NO CALL SITE AT ALL. The name is in the
-- RPC constant in _shared/rpc.ts (`retryDeadLettered`), but nothing in src/,
-- supabase/functions/ or e2e/ calls it and no argument interface is declared
-- for it, so there is no evidence to derive the exact names from -- unlike
-- rpc_requeue_outbox_event and rpc_write_reconciliation_report, whose call
-- sites fix theirs. The signature here follows the only two things the codebase
-- does say about it:
--
--   * `sync.retry` is a real permission in src/lib/roles.ts and is held by
--     `administrator` ALONE, which makes this an administrator action taken by a
--     person -- hence p_actor and p_app_version, exactly as the mutating RPCs
--     take them.
--   * a dead letter is "visible to an administrator and retryable by hand"
--     (OUTBOX_STATES), so the unit of work is one sample or the whole backlog;
--     p_sample_uuid is therefore optional and null means all of it.
--
-- If the administrator screen is written with different argument names, this
-- function must be renamed to match it rather than the call adapted, because
-- PostgREST resolves named arguments and a mismatch is a silent 404.
-- ---------------------------------------------------------------------------

create function public.rpc_retry_dead_lettered(
  p_actor       uuid,
  p_app_version text,
  p_sample_uuid uuid default null
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_basis   text;
  v_retried integer;
begin
  v_basis := public.require_permission(p_actor, 'sync.retry');

  update public.sheet_sync_outbox o
     set state         = 'pending',
         next_retry_at = now(),
         -- A dead letter is being retried by hand after an unknown number of
         -- real-world changes, so the next attempt reads the sheet before it
         -- writes. The 'unknown' outcome already carries reconcileFirst into a
         -- dead letter for this reason; a manual retry gets the same treatment.
         reconcile_first = true,
         attempt_count   = 0,
         lease_holder     = null,
         leased_until     = null
   where o.state = 'dead_letter'
     and (p_sample_uuid is null or o.sample_uuid = p_sample_uuid);

  get diagnostics v_retried = row_count;

  perform public.record_audit_event(
    p_action             => 'sheet_sync.dead_letters_retried',
    p_entity_type        => 'sheet_sync',
    p_entity_id          => coalesce(p_sample_uuid::text, 'operational-workbook'),
    p_sample_uuid        => p_sample_uuid,
    p_reason             => null,
    p_after              => jsonb_build_object('events_retried', v_retried),
    p_outcome            => 'succeeded',
    p_authority_basis    => v_basis,
    p_actor_id           => p_actor,
    p_deployment_version => p_app_version
  );

  return v_retried;
end;
$$;


-- ---------------------------------------------------------------------------
-- rpc_write_reconciliation_report(...)
--
-- SIGNATURE INFERRED. _shared/rpc.ts declares the name with no argument
-- interface; these six names are taken verbatim from the only call site,
-- reconcile-sheets/index.ts:332, which passes p_workbook_key, p_started_at,
-- p_finished_at, p_total_findings, p_clean and p_report (the whole report
-- object).
--
-- Append-only: a reconciliation run is an event, and editing a past report
-- would be editing the record of what the sheet looked like at that moment.
-- ---------------------------------------------------------------------------

create function public.rpc_write_reconciliation_report(
  p_workbook_key   text,
  p_started_at     timestamptz,
  p_finished_at    timestamptz,
  p_total_findings integer,
  p_clean          boolean,
  p_report         jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_report_id uuid;
begin
  if not exists (
    select 1 from public.sheet_workbook_state w where w.workbook_key = p_workbook_key
  ) then
    raise exception 'BFF_UNKNOWN_WORKBOOK: no state row for workbook "%"', p_workbook_key
      using errcode = '23503';
  end if;

  insert into public.sheet_reconciliation_reports (
    workbook_key, started_at, finished_at, total_findings, clean, report
  )
  values (
    p_workbook_key, p_started_at, p_finished_at,
    greatest(coalesce(p_total_findings, 0), 0),
    coalesce(p_clean, false),
    coalesce(p_report, '{}'::jsonb)
  )
  returning id into v_report_id;

  update public.sheet_workbook_state w
     set last_reconciled_at = p_finished_at
   where w.workbook_key = p_workbook_key;

  return v_report_id;
end;
$$;


-- ---------------------------------------------------------------------------
-- Privileges. Per signature, from anon and authenticated as well as PUBLIC: a
-- revoke only deletes a grant that was RECORDED, and Supabase's default
-- privileges record EXECUTE for anon and authenticated on every new function in
-- `public`, which `revoke ... from public` does not remove. Never collapse
-- these to the `from public` form -- that is the inert revoke 0009 corrects.
--
-- `authenticated` gets none of them. A client holding the lease functions could
-- take the single-writer lease away from the worker and stop the spreadsheet
-- being written at all.
-- ---------------------------------------------------------------------------

revoke all on function public.operational_workbook_key() from public, anon, authenticated;
grant execute on function public.operational_workbook_key() to service_role;

revoke all on function public.assert_sheet_lease(text, text, bigint)
  from public, anon, authenticated;
grant execute on function public.assert_sheet_lease(text, text, bigint) to service_role;

revoke all on function public.rpc_acquire_sheet_lease(text, text, integer)
  from public, anon, authenticated;
grant execute on function public.rpc_acquire_sheet_lease(text, text, integer) to service_role;

revoke all on function public.rpc_renew_sheet_lease(text, text, bigint, integer)
  from public, anon, authenticated;
grant execute on function public.rpc_renew_sheet_lease(text, text, bigint, integer) to service_role;

revoke all on function public.rpc_release_sheet_lease(text, text, bigint)
  from public, anon, authenticated;
grant execute on function public.rpc_release_sheet_lease(text, text, bigint) to service_role;

revoke all on function public.rpc_read_sheet_lease(text) from public, anon, authenticated;
grant execute on function public.rpc_read_sheet_lease(text) to service_role;

revoke all on function public.rpc_claim_outbox_batch(text, text, bigint, integer)
  from public, anon, authenticated;
grant execute on function public.rpc_claim_outbox_batch(text, text, bigint, integer)
  to service_role;

revoke all on function public.rpc_record_outbox_outcome(
  uuid, text, bigint, text, integer, timestamptz, boolean, text, integer, timestamptz, boolean, jsonb
) from public, anon, authenticated;
grant execute on function public.rpc_record_outbox_outcome(
  uuid, text, bigint, text, integer, timestamptz, boolean, text, integer, timestamptz, boolean, jsonb
) to service_role;

revoke all on function public.rpc_confirm_sheet_row(
  uuid, text, bigint, public.sample_stage, integer, integer, text, timestamptz
) from public, anon, authenticated;
grant execute on function public.rpc_confirm_sheet_row(
  uuid, text, bigint, public.sample_stage, integer, integer, text, timestamptz
) to service_role;

revoke all on function public.rpc_mark_schema_drifted(text, text, bigint, jsonb)
  from public, anon, authenticated;
grant execute on function public.rpc_mark_schema_drifted(text, text, bigint, jsonb)
  to service_role;

revoke all on function public.rpc_read_workbook_state(text) from public, anon, authenticated;
grant execute on function public.rpc_read_workbook_state(text) to service_role;

revoke all on function public.rpc_write_workbook_verification(text, timestamptz, text[], boolean)
  from public, anon, authenticated;
grant execute on function public.rpc_write_workbook_verification(text, timestamptz, text[], boolean)
  to service_role;

revoke all on function public.rpc_requeue_outbox_event(uuid, text, bigint, text)
  from public, anon, authenticated;
grant execute on function public.rpc_requeue_outbox_event(uuid, text, bigint, text)
  to service_role;

revoke all on function public.rpc_retry_dead_lettered(uuid, text, uuid)
  from public, anon, authenticated;
grant execute on function public.rpc_retry_dead_lettered(uuid, text, uuid) to service_role;

revoke all on function public.rpc_write_reconciliation_report(
  text, timestamptz, timestamptz, integer, boolean, jsonb
) from public, anon, authenticated;
grant execute on function public.rpc_write_reconciliation_report(
  text, timestamptz, timestamptz, integer, boolean, jsonb
) to service_role;

select public.assert_function_privileges();
