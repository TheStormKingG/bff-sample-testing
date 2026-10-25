-- ---------------------------------------------------------------------------
-- 0011_server_authority.sql
--
-- Server-side authority for the RPC layer, the client/database vocabulary
-- translation, and the one enqueue path every mutation uses.
--
-- WHY THE 0001 HELPERS CANNOT BE USED DIRECTLY.
--
-- public.has_permission(), public.is_active_user() and
-- public.authority_basis() all resolve the subject through auth.uid(). An RPC
-- in this contract is invoked by an Edge Function holding the SERVICE ROLE
-- key, on a connection with no end-user JWT, so auth.uid() is NULL inside it
-- and every one of those helpers would answer "no permission" for the most
-- privileged actor in the system. Re-using them unchanged would make every
-- mutation fail closed -- safe, but the application would not work.
--
-- So the authority question is asked about an actor passed as an argument. The
-- three rules that keep that from being "trusting the request":
--
--   1. p_actor is the uid the EDGE VERIFIED. authenticate() in
--      _shared/adapters/authorize.ts calls admin.auth.getUser(token) and
--      passes actor.userId. It is never an email, role or id read from a
--      request body, and the RPCs below never accept a role or permission as
--      an argument -- only the subject, whose authority is then looked up here.
--   2. Only `service_role` may execute these RPCs. A client that could call
--      them directly could name any actor, which is why not one of them is
--      granted to `authenticated` and why 0009 asserts that.
--   3. Defence in depth for the day somebody adds that grant anyway:
--      public.assert_actor_is_caller() refuses whenever auth.uid() is present
--      and differs from p_actor. On the service-role path auth.uid() is NULL
--      and the check passes; on a direct PostgREST call it is the caller's own
--      uid, so naming somebody else is refused.
--
-- Every function here mirrors a rule that already exists in TypeScript, and
-- the comment on each one names the file it mirrors. Where the two could drift,
-- the database is the control and the client is the convenience: hiding a
-- button is not a control.
-- ---------------------------------------------------------------------------


-- ---------------------------------------------------------------------------
-- Actor-keyed authority. Mirrors can() in src/lib/roles.ts, including the rule
-- that a non-active account holds NOTHING -- "a pending/suspended/disabled
-- account can read nothing" -- and that a delegation-only permission can never
-- be reached through a base role.
-- ---------------------------------------------------------------------------

create function public.actor_status(p_actor uuid)
returns public.user_status
language sql
stable
security definer
set search_path = ''
as $$
  select p.status from public.profiles p where p.id = p_actor;
$$;

create function public.actor_is_active(p_actor uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_actor is not null and coalesce(public.actor_status(p_actor) = 'active', false);
$$;

create function public.actor_has_permission(
  p_actor      uuid,
  p_permission public.app_permission
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    public.actor_is_active(p_actor)
    and (
      -- A recorded, unrevoked, in-window delegation grants it outright, and is
      -- the ONLY route to a delegation-only permission such as
      -- disposition.override_release.
      exists (
        select 1
        from public.user_delegations d
        where d.user_id = p_actor
          and d.permission = p_permission
          and d.revoked_at is null
          and d.effective_from <= now()
          and (d.effective_to is null or d.effective_to > now())
      )
      or (
        not (p_permission = any (public.delegation_only_permissions()))
        and exists (
          select 1
          from public.user_roles ur
          join public.role_permissions rp on rp.role = ur.role
          where ur.user_id = p_actor
            and rp.permission = p_permission
        )
      )
    );
$$;

create function public.actor_authority_basis(
  p_actor      uuid,
  p_permission public.app_permission
)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_delegation uuid;
  v_role       public.app_role;
begin
  if not public.actor_is_active(p_actor) then
    return null;
  end if;

  select d.id into v_delegation
  from public.user_delegations d
  where d.user_id = p_actor
    and d.permission = p_permission
    and d.revoked_at is null
    and d.effective_from <= now()
    and (d.effective_to is null or d.effective_to > now())
  order by d.granted_at desc
  limit 1;

  if v_delegation is not null then
    return 'delegation:' || v_delegation::text;
  end if;

  if p_permission = any (public.delegation_only_permissions()) then
    return null;
  end if;

  select ur.role into v_role
  from public.user_roles ur
  join public.role_permissions rp on rp.role = ur.role
  where ur.user_id = p_actor
    and rp.permission = p_permission
  order by ur.role
  limit 1;

  if v_role is null then
    return null;
  end if;

  return 'base_role:' || v_role::text;
end;
$$;

comment on function public.actor_has_permission(uuid, public.app_permission) is
  'can() from src/lib/roles.ts, asked about an actor rather than auth.uid(), because the RPCs run on a service-role connection where auth.uid() is NULL. A non-active account holds nothing.';


-- ---------------------------------------------------------------------------
-- The two guards every authority-bearing RPC runs FIRST.
--
-- assert_actor_is_caller() closes the impersonation hole that would open if
-- one of these RPCs were ever granted to `authenticated`: see rule 3 in the
-- file header. It is cheap and it is unconditional, so it cannot be forgotten
-- selectively.
--
-- require_permission() raises. That is deliberate and it is NOT in tension
-- with the audit rule in 0006 ("authority checks RETURN a denial rather than
-- raising -- raising would roll back the very row that records the attempt"):
-- a denied ATTEMPT is audited by the Edge Function through recordAudit(), on a
-- separate connection and a separate transaction, before the HTTP error is
-- returned. The denial record therefore survives this rollback, and rolling
-- back is what guarantees a refused mutation leaves nothing behind.
-- ---------------------------------------------------------------------------

create function public.assert_actor_is_caller(p_actor uuid)
returns void
language plpgsql
stable
set search_path = ''
as $$
begin
  if p_actor is null then
    raise exception 'BFF_ACTOR_REQUIRED: an actor is required'
      using errcode = '28000';
  end if;

  -- NULL on the service-role connection the Edge Functions use. Non-null only
  -- when an end-user JWT is present, in which case the actor must be that user.
  if auth.uid() is not null and auth.uid() <> p_actor then
    raise exception
      'BFF_ACTOR_MISMATCH: the caller % may not act as %', auth.uid(), p_actor
      using errcode = '42501';
  end if;
end;
$$;

create function public.require_permission(
  p_actor      uuid,
  p_permission public.app_permission
)
returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  v_basis text;
begin
  perform public.assert_actor_is_caller(p_actor);

  -- Status before permission, so a suspended account with a role still gets
  -- the account answer and not the authority answer.
  if not public.actor_is_active(p_actor) then
    raise exception
      'BFF_ACCOUNT_NOT_ACTIVE: account % is %', p_actor,
      coalesce(public.actor_status(p_actor)::text, 'not provisioned')
      using errcode = '42501';
  end if;

  if not public.actor_has_permission(p_actor, p_permission) then
    raise exception
      'BFF_NOT_AUTHORISED: % is not authorised to %', p_actor, p_permission
      using errcode = '42501';
  end if;

  v_basis := public.actor_authority_basis(p_actor, p_permission);
  if v_basis is null then
    -- actor_has_permission() said yes and actor_authority_basis() cannot name
    -- how. The two read the same tables, so this is unreachable unless they
    -- drift. Refuse: a decision that cannot be explained must not be recorded,
    -- because holds and dispositions store the basis as evidence.
    raise exception
      'BFF_AUTHORITY_UNEXPLAINED: % holds % but no basis could be recorded',
      p_actor, p_permission
      using errcode = '42501';
  end if;

  return v_basis;
end;
$$;

comment on function public.require_permission(uuid, public.app_permission) is
  'The first statement of every authority-bearing RPC. Raises on a non-active account or a missing permission, and returns the authority basis to be recorded as evidence.';


-- ---------------------------------------------------------------------------
-- Client/database vocabulary.
--
-- OUTBOX_STATES and OUTBOX_EVENT_KINDS in supabase/functions/_shared/outbox.ts
-- are not the same strings as public.sheet_sync_state and
-- public.sheet_sync_event_kind. The RPC boundary is the only place the two
-- vocabularies meet, so the translation lives here, in exactly one pair of
-- functions each, and it FAILS CLOSED.
--
-- Failing closed matters in one direction in particular. asOutboxState() in
-- outbox.ts maps an unrecognised string to null, which renders as "pending",
-- "so an unknown value must never fall through to confirmed". A default branch
-- returning 'confirmed' here would be the false green that rule 6 forbids, so
-- there is no default branch at all: an unmapped value raises.
-- ---------------------------------------------------------------------------

create function public.outbox_state_to_client(p_state public.sheet_sync_state)
returns text
language plpgsql
immutable
set search_path = ''
as $$
begin
  case p_state
    when 'pending'     then return 'pending';
    when 'leased'      then return 'in_flight';
    when 'confirmed'   then return 'confirmed';
    when 'failed'      then return 'retry_scheduled';
    when 'dead_letter' then return 'needs_attention';
    when 'superseded'  then return 'superseded';
    else
      raise exception 'BFF_UNMAPPED_OUTBOX_STATE: % has no client state', p_state
        using errcode = '22023';
  end case;
end;
$$;

create function public.outbox_state_from_client(p_state text)
returns public.sheet_sync_state
language plpgsql
immutable
set search_path = ''
as $$
begin
  case p_state
    when 'pending'         then return 'pending';
    when 'in_flight'       then return 'leased';
    when 'confirmed'       then return 'confirmed';
    when 'retry_scheduled' then return 'failed';
    when 'needs_attention' then return 'dead_letter';
    when 'superseded'      then return 'superseded';
    else
      raise exception 'BFF_UNMAPPED_OUTBOX_STATE: % is not an outbox state', p_state
        using errcode = '22023';
  end case;
end;
$$;

create function public.outbox_kind_to_client(p_kind public.sheet_sync_event_kind)
returns text
language plpgsql
immutable
set search_path = ''
as $$
begin
  case p_kind
    when 'register'    then return 'sample_registered';
    when 'results'     then return 'results_recorded';
    when 'correction'  then return 'correction_applied';
    when 'disposition' then return 'review_recorded';
    else
      raise exception 'BFF_UNMAPPED_OUTBOX_KIND: % has no client kind', p_kind
        using errcode = '22023';
  end case;
end;
$$;

create function public.outbox_kind_from_client(p_kind text)
returns public.sheet_sync_event_kind
language plpgsql
immutable
set search_path = ''
as $$
begin
  case p_kind
    when 'sample_registered'   then return 'register';
    when 'results_recorded'    then return 'results';
    when 'correction_applied'  then return 'correction';
    when 'review_recorded'     then return 'disposition';
    else
      raise exception 'BFF_UNMAPPED_OUTBOX_KIND: % is not an outbox kind', p_kind
        using errcode = '22023';
  end case;
end;
$$;

comment on function public.outbox_state_to_client(public.sheet_sync_state) is
  'The ONLY translation between public.sheet_sync_state and OUTBOX_STATES in supabase/functions/_shared/outbox.ts. No default branch: an unmapped value raises rather than resolving to confirmed, which would be a false "Confirmed in Google Sheets".';


-- ---------------------------------------------------------------------------
-- The sample sync rollup, corrected for 'superseded'.
--
-- The version in 0007 ends with `when count(*) > 0 then 'confirmed'`. With
-- 'superseded' now reachable, a sample whose only outbox events were all
-- superseded would roll up to CONFIRMED -- a row reported as present in the
-- spreadsheet when nothing was ever written. That is precisely the false green
-- the original comment set out to prevent, so the rollup is rewritten rather
-- than extended: superseded events are excluded from the decision, and a
-- sample with nothing but superseded events reads as pending.
-- ---------------------------------------------------------------------------

create or replace function public.tg_refresh_sample_sync_state()
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
      -- Only CONFIRMED events remain. A superseded event is excluded above and
      -- cannot reach this branch on its own, so "nothing left to do" really
      -- does mean every live event was written and read back.
      when count(*) filter (where o.state = 'confirmed')   > 0 then 'confirmed'
      else 'pending'
    end,
    max(o.external_row_number) filter (where o.state = 'confirmed'),
    max(o.confirmed_at)
  into v_state, v_row, v_at
  from public.sheet_sync_outbox o
  where o.sample_uuid = v_sample
    -- A superseded event is a retired intention, not an outstanding one, and
    -- not evidence of a write. It must not move the rollup in either
    -- direction.
    and o.state <> 'superseded';

  update public.samples s
     set sheet_sync_state   = v_state,
         sheet_row_hint     = coalesce(v_row, s.sheet_row_hint),
         -- samples_sheet_confirmation_pair requires these two to agree.
         sheet_confirmed_at = case when v_state = 'confirmed' then v_at else null end
   where s.id = v_sample;

  return null;
end;
$$;


-- ---------------------------------------------------------------------------
-- The single enqueue path.
--
-- 0008 defined enqueue_sheet_sync_event(uuid, kind), which stores the
-- field-keyed snapshot and has nowhere to put the projected row. OutboxEvent
-- declares `row` as "the row cells, serialised by toSheetRow at enqueue time"
-- and syncWorker.ts writes event.row to the sheet, so an event without it is
-- an event the worker cannot act on.
--
-- The 2-argument version is DROPPED rather than left beside this one. Two
-- enqueue paths, one of which produces unusable events, is exactly the drift
-- the single-source-of-truth rule exists to prevent; and the old signature had
-- no callers, because the RPCs that were meant to call it were never written.
-- ---------------------------------------------------------------------------

drop function public.enqueue_sheet_sync_event(uuid, public.sheet_sync_event_kind);

create function public.enqueue_sheet_sync_event(
  p_sample_uuid uuid,
  p_event_kind  public.sheet_sync_event_kind,
  -- Column A first, left blank by the caller: the identifier is allocated
  -- server-side and is written in by this function, so a client-supplied
  -- sample id in column A is discarded rather than trusted.
  p_row         text[]
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sample   public.samples;
  v_tab      text;
  v_width    integer;
  v_row      text[];
  v_payload  jsonb;
  v_event_id uuid;
begin
  select * into v_sample from public.samples where id = p_sample_uuid;
  if v_sample.id is null then
    raise exception 'Unknown sample %', p_sample_uuid using errcode = '23503';
  end if;

  -- A draft has no operational row. Nothing is enqueued for one, which is why
  -- a draft never shows a sync status at all.
  if v_sample.capture_state = 'draft' or v_sample.sample_id is null then
    return null;
  end if;

  select d.sheet_tab, d.column_count into v_tab, v_width
  from public.stage_definitions d
  where d.stage = v_sample.stage;

  if p_row is null or cardinality(p_row) = 0 then
    raise exception
      'BFF_ROW_REQUIRED: an outbox event for % needs the projected row', v_sample.sample_id
      using errcode = '22023';
  end if;

  -- Normalise to the stage's column count, exactly as normaliseRow() does in
  -- _shared/hash.ts: the Sheets API truncates TRAILING empty cells on read, so
  -- a row of 19 ending in three blanks comes back as 16 and a raw comparison
  -- would report a difference that does not exist. Only trailing absence is
  -- filled; an interior blank is real data meaning "not measured" and is
  -- preserved, because a blank is not a zero.
  if cardinality(p_row) > v_width then
    raise exception
      'BFF_ROW_TOO_WIDE: % has % columns but % cells were supplied',
      v_tab, v_width, cardinality(p_row)
      using errcode = '22023';
  end if;

  v_row := array(
    select coalesce(p_row[i], '')
    from generate_series(1, v_width) as g(i)
  );

  -- Column A is the identifier, assigned here.
  v_row[1] := v_sample.sample_id;

  v_payload := public.sample_snapshot(p_sample_uuid);

  insert into public.sheet_sync_outbox (
    sample_uuid, target_tab, event_kind,
    payload_revision, payload_hash, payload, projected_row,
    external_record_key
  )
  values (
    p_sample_uuid, v_tab, p_event_kind,
    v_sample.revision,
    -- Hash of the ROW this event intends to write, which is what
    -- OutboxEvent.payloadHash is declared to be. Bare hex, satisfying
    -- sheet_sync_outbox_hash_shape; the Edge Function's own rowHash() carries a
    -- 'sha256:' prefix and is stored separately in confirmed_payload_hash.
    public.payload_hash(to_jsonb(v_row)),
    v_payload, v_row,
    v_sample.sample_id
  )
  -- ON CONFLICT against the one-per-revision unique constraint, so a replayed
  -- RPC enqueues nothing new rather than producing a second spreadsheet row.
  on conflict (sample_uuid, event_kind, payload_revision) do nothing
  returning event_id into v_event_id;

  return v_event_id;
end;
$$;

comment on function public.enqueue_sheet_sync_event(uuid, public.sheet_sync_event_kind, text[]) is
  'The only enqueue path. Runs inside the calling mutation transaction, so the event and the data it describes commit together. ON CONFLICT DO NOTHING on (sample, kind, revision) is what makes EXACTLY ONE event per revision structural rather than conventional.';


-- ---------------------------------------------------------------------------
-- Privileges. Per signature, from anon and authenticated as well as PUBLIC --
-- a revoke only deletes a grant that was RECORDED, and Supabase's default
-- privileges record EXECUTE for anon and authenticated on every new function
-- in `public`, which `revoke ... from public` does not touch. See 0009.
--
-- `authenticated` gets NONE of these. The actor-keyed authority helpers are
-- the dangerous ones: a client able to call actor_has_permission() or
-- require_permission() for an arbitrary uid could enumerate the authority of
-- every person in the plant.
-- ---------------------------------------------------------------------------

revoke all on function public.actor_status(uuid) from public, anon, authenticated;
grant execute on function public.actor_status(uuid) to service_role;

revoke all on function public.actor_is_active(uuid) from public, anon, authenticated;
grant execute on function public.actor_is_active(uuid) to service_role;

revoke all on function public.actor_has_permission(uuid, public.app_permission)
  from public, anon, authenticated;
grant execute on function public.actor_has_permission(uuid, public.app_permission)
  to service_role;

revoke all on function public.actor_authority_basis(uuid, public.app_permission)
  from public, anon, authenticated;
grant execute on function public.actor_authority_basis(uuid, public.app_permission)
  to service_role;

revoke all on function public.assert_actor_is_caller(uuid) from public, anon, authenticated;
grant execute on function public.assert_actor_is_caller(uuid) to service_role;

revoke all on function public.require_permission(uuid, public.app_permission)
  from public, anon, authenticated;
grant execute on function public.require_permission(uuid, public.app_permission)
  to service_role;

revoke all on function public.outbox_state_to_client(public.sheet_sync_state)
  from public, anon, authenticated;
grant execute on function public.outbox_state_to_client(public.sheet_sync_state) to service_role;

revoke all on function public.outbox_state_from_client(text) from public, anon, authenticated;
grant execute on function public.outbox_state_from_client(text) to service_role;

revoke all on function public.outbox_kind_to_client(public.sheet_sync_event_kind)
  from public, anon, authenticated;
grant execute on function public.outbox_kind_to_client(public.sheet_sync_event_kind)
  to service_role;

revoke all on function public.outbox_kind_from_client(text) from public, anon, authenticated;
grant execute on function public.outbox_kind_from_client(text) to service_role;

revoke all on function public.tg_refresh_sample_sync_state() from public, anon, authenticated;

revoke all on function public.enqueue_sheet_sync_event(
  uuid, public.sheet_sync_event_kind, text[]
) from public, anon, authenticated;

select public.assert_function_privileges();
