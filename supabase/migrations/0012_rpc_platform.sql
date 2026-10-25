-- ---------------------------------------------------------------------------
-- 0012_rpc_platform.sql
--
-- The RPCs that are not mutations of a sample: authority lookup, the audit
-- writer, the idempotency registry, and the three read paths.
--
--   rpc_authority_context              rpc_read_idempotency_record
--   rpc_record_audit_event             rpc_begin_idempotent_request
--   rpc_read_sample_sync_state         rpc_complete_idempotent_request
--   rpc_read_ledger_for_stage          rpc_health_snapshot
--
-- Argument names are taken from the CALL SITES, not invented: PostgREST sends
-- named arguments, so a renamed parameter is not a type error anywhere -- it is
-- a PGRST202 at runtime, which _shared/adapters/store.ts maps to
-- `rpc_not_deployed`. Each function below names the file and line its argument
-- list came from.
-- ---------------------------------------------------------------------------


-- ---------------------------------------------------------------------------
-- record_audit_event, extended with the deployment version.
--
-- RpcActorArgs declares `p_app_version` as the "deployment version, recorded
-- on the audit event (FR-016)", and the Edge Functions pass the version of the
-- build that is actually running. The 0006 writer could not record it: it read
-- `deployment_version` out of public.system_config, which is a static
-- configuration row ('local-dev' until CI sets it) and therefore says what the
-- database was configured with rather than what served the request. Those are
-- different facts, and attributing a behaviour change needs the second.
--
-- DROPPED and recreated rather than overloaded. Adding a 13th parameter with a
-- default alongside the 12-parameter version would make every existing
-- 12-argument call ambiguous ("function is not unique"), which would break
-- public.apply_measurement at runtime. A plpgsql body resolves its calls when
-- it executes, so the existing 12-argument call sites bind to this function and
-- keep working, now with the configured version as the default.
-- ---------------------------------------------------------------------------

drop function public.record_audit_event(
  text, text, text, uuid, text, jsonb, jsonb, uuid, text, text, text, uuid
);

create function public.record_audit_event(
  p_action             text,
  p_entity_type        text,
  p_entity_id          text default null,
  p_sample_uuid        uuid default null,
  p_reason             text default null,
  p_before             jsonb default null,
  p_after              jsonb default null,
  p_request_id         uuid default null,
  p_outcome            text default 'succeeded',
  p_denial_code        text default null,
  p_authority_basis    text default null,
  p_actor_id           uuid default null,
  p_deployment_version text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor   uuid := coalesce(p_actor_id, auth.uid());
  v_email   text;
  v_roles   text[];
  v_version text := p_deployment_version;
  v_uuid    uuid;
begin
  select p.email into v_email from public.profiles p where p.id = v_actor;

  select array_agg(ur.role::text order by ur.role) into v_roles
  from public.user_roles ur
  where ur.user_id = v_actor;

  -- The caller's build identity wins; the configured value is the fallback for
  -- the in-database call sites (apply_measurement, the draft-abandonment
  -- trigger) that have no request behind them.
  if v_version is null then
    select c.value into v_version
    from public.system_config c
    where c.key = 'deployment_version';
  end if;

  insert into public.audit_events (
    actor_id, actor_email, actor_roles, authority_basis,
    action, entity_type, entity_id, sample_uuid, reason,
    before_payload, after_payload, request_id,
    outcome, denial_code, deployment_version
  )
  values (
    v_actor, v_email, v_roles, p_authority_basis,
    p_action, p_entity_type, p_entity_id, p_sample_uuid, p_reason,
    p_before, p_after, p_request_id,
    p_outcome, p_denial_code, v_version
  )
  returning event_uuid into v_uuid;

  return v_uuid;
end;
$$;

comment on function public.record_audit_event is
  'The single writer of public.audit_events. Resolves the actor email and role list so a call site cannot omit them, and records the build that served the request in preference to the configured deployment_version.';

revoke all on function public.record_audit_event(
  text, text, text, uuid, text, jsonb, jsonb, uuid, text, text, text, uuid, text
) from public, anon, authenticated;
grant execute on function public.record_audit_event(
  text, text, text, uuid, text, jsonb, jsonb, uuid, text, text, text, uuid, text
) to service_role;


-- ---------------------------------------------------------------------------
-- rpc_authority_context(p_user_id)
--
-- Call site: supabase/functions/_shared/adapters/authorize.ts:105, one named
-- argument `p_user_id`. Return shape: AuthorityRow in _shared/rpc.ts.
--
-- NO permission check, deliberately. This is the function authenticate() calls
-- to FIND OUT whether the account is active, so requiring an active account
-- would make the pending-access screen unreachable: a pending user would get a
-- refusal instead of their status and the Edge Function could not tell
-- "unknown sign-in" from "approved but suspended".
--
-- That does not weaken rule 4. What it returns is the caller's OWN identity and
-- authority and nothing else -- no sample, no measurement, no limit -- which is
-- exactly what the pending screen displays. Reading somebody else's row is
-- prevented by the privilege boundary (service_role only, and the Edge Function
-- passes the uid it verified through admin.auth.getUser) and, if that grant is
-- ever widened, by assert_actor_is_caller below.
-- ---------------------------------------------------------------------------

create function public.rpc_authority_context(p_user_id uuid)
returns table (
  user_id     uuid,
  email       text,
  full_name   text,
  status      text,
  roles       text[],
  delegations jsonb
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.assert_actor_is_caller(p_user_id);

  return query
  select
    p.id,
    p.email,
    p.display_name,
    p.status::text,
    coalesce(
      (select array_agg(ur.role::text order by ur.role)
         from public.user_roles ur where ur.user_id = p.id),
      '{}'::text[]
    ),
    coalesce(
      (select jsonb_agg(jsonb_build_object(
                'permission',     d.permission,
                'granted_by',     d.granted_by,
                'effective_from', d.effective_from,
                'effective_to',   d.effective_to
              ) order by d.granted_at desc)
         from public.user_delegations d
        where d.user_id = p.id
          -- A revoked delegation is not authority. It stays in the table as
          -- evidence and must never be returned as if it were live; the
          -- effective window is re-checked client-side by delegationActive(),
          -- but a revoked row has no window to check.
          and d.revoked_at is null),
      '[]'::jsonb
    )
  from public.profiles p
  where p.id = p_user_id;
end;
$$;


-- ---------------------------------------------------------------------------
-- rpc_record_audit_event(...)
--
-- Call site: supabase/functions/_shared/adapters/authorize.ts:174, nine named
-- arguments. Note the vocabulary difference the boundary has to absorb:
-- AuditEventArgs.p_outcome is 'allowed' | 'denied' | 'error', and
-- audit_events.outcome is constrained to 'succeeded' | 'denied' | 'failed'.
-- Translated here, failing closed on anything else -- an unmapped outcome
-- must not be recorded as a success.
--
-- p_actor is nullable by design: the sync worker and the scheduler act with no
-- person behind them, and audit_events.actor_id is nullable "for a system
-- action such as the sync worker".
-- ---------------------------------------------------------------------------

create function public.rpc_record_audit_event(
  p_actor        uuid,
  p_action       text,
  p_subject_type text,
  p_subject_id   text,
  p_outcome      text,
  p_app_version  text,
  p_reason       text default null,
  p_before       jsonb default null,
  p_after        jsonb default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_outcome text;
  v_sample  uuid;
begin
  if p_actor is not null then
    perform public.assert_actor_is_caller(p_actor);
  end if;

  case p_outcome
    when 'allowed' then v_outcome := 'succeeded';
    when 'denied'  then v_outcome := 'denied';
    when 'error'   then v_outcome := 'failed';
    else
      raise exception
        'BFF_UNMAPPED_AUDIT_OUTCOME: % is not an audit outcome', p_outcome
        using errcode = '22023';
  end case;

  -- Populate sample_uuid when the subject IS a sample, so the per-sample audit
  -- index can serve the sample history screen. A subject id that is not a uuid
  -- is a legitimate case (the workbook key, an email), so it is not an error.
  if p_subject_type = 'sample' and p_subject_id is not null then
    begin
      v_sample := p_subject_id::uuid;
    exception when invalid_text_representation then
      v_sample := null;
    end;
    -- Only if it really is a sample we hold: the column is a foreign key.
    if v_sample is not null
       and not exists (select 1 from public.samples s where s.id = v_sample) then
      v_sample := null;
    end if;
  end if;

  return public.record_audit_event(
    p_action             => p_action,
    p_entity_type        => p_subject_type,
    p_entity_id          => p_subject_id,
    p_sample_uuid        => v_sample,
    p_reason             => p_reason,
    p_before             => p_before,
    p_after              => p_after,
    p_request_id         => null,
    p_outcome            => v_outcome,
    -- audit_events_denied_has_code requires a denial code on every denial. The
    -- reason the Edge Function sent IS the code it chose ('not_authorised',
    -- 'disposition_refused', ...); the fallback keeps a denial recordable
    -- rather than letting the constraint turn a refusal into a 500.
    p_denial_code        => case when v_outcome = 'denied'
                                 then coalesce(nullif(btrim(p_reason), ''), 'denied')
                                 else null end,
    p_authority_basis    => null,
    p_actor_id           => p_actor,
    p_deployment_version => p_app_version
  );
end;
$$;


-- ---------------------------------------------------------------------------
-- The idempotency registry.
--
-- Call sites: supabase/functions/_shared/adapters/store.ts -- read() at :287
-- (p_key, p_operation), begin() at :316 (p_key, p_operation, p_actor,
-- p_payload_hash, p_stale_after_ms), complete() at :356 (p_key, p_operation,
-- p_actor, p_state, p_response).
--
-- All three look the record up BY KEY ALONE and carry the operation in the row.
-- See the comment on idempotency_requests_key_key in 0010: filtering by
-- (key, operation) would make decideIdempotency()'s `operation_mismatch` branch
-- unreachable and let one key be replayed across endpoints.
-- ---------------------------------------------------------------------------

create function public.rpc_read_idempotency_record(
  p_key       text,
  p_operation text
)
returns table (
  key          text,
  operation    text,
  actor_id     uuid,
  payload_hash text,
  state        text,
  response     jsonb,
  created_at   timestamptz,
  updated_at   timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  -- p_operation is accepted because the declared contract passes it and
  -- because a future scoping change would start here, but it deliberately does
  -- NOT filter: a row stored under a different operation must be RETURNED so
  -- decideIdempotency() can refuse it.
  select r.idempotency_key, r.operation, r.actor_id, r.payload_hash,
         r.outcome, r.response_payload, r.created_at, r.updated_at
  from public.idempotency_requests r
  where r.idempotency_key = p_key;
$$;

create function public.rpc_begin_idempotent_request(
  p_key            text,
  p_operation      text,
  p_actor          uuid,
  p_payload_hash   text,
  p_stale_after_ms integer
)
returns table (
  claimed      boolean,
  key          text,
  operation    text,
  actor_id     uuid,
  payload_hash text,
  state        text,
  response     jsonb,
  created_at   timestamptz,
  updated_at   timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_stale interval := make_interval(secs => greatest(coalesce(p_stale_after_ms, 0), 0) / 1000.0);
  v_row   public.idempotency_requests;
begin
  perform public.assert_actor_is_caller(p_actor);

  if not public.actor_is_active(p_actor) then
    raise exception 'BFF_ACCOUNT_NOT_ACTIVE: account % is %', p_actor,
      coalesce(public.actor_status(p_actor)::text, 'not provisioned')
      using errcode = '42501';
  end if;

  -- ONE statement. The insert takes the key, or the conflicting row is taken
  -- over -- but only when it is the SAME request that died. A read followed by
  -- a write could not do this: two concurrent requests would both read "no
  -- record" and both run the operation.
  insert into public.idempotency_requests as r (
    idempotency_key, operation, actor_id, payload_hash, outcome, response_payload
  )
  values (p_key, p_operation, p_actor, p_payload_hash, 'in_progress', null)
  on conflict (idempotency_key) do update
     set outcome          = 'in_progress',
         response_payload = null,
         completed_at     = null,
         updated_at       = now(),
         replay_count     = r.replay_count + 1
   where
     -- Identity first. A key presented by a different person, or for a
     -- different endpoint, is not a retry and must keep the stored row intact
     -- so the pure decision function can refuse it.
     r.actor_id = p_actor
     and r.operation = p_operation
     and r.payload_hash = p_payload_hash
     -- Whose WORK has not already committed. A claim whose mutation committed
     -- but whose response was never stored must never be handed out again: the
     -- record exists, and re-running the operation would duplicate it.
     and r.committed_at is null
     and (
       -- A failed attempt committed nothing, so the same payload may re-run.
       r.outcome = 'failed'
       -- An in-progress record older than the lock timeout: the original
       -- attempt died before recording an outcome, and leaving the key wedged
       -- forever would strand an operator whose client has already persisted
       -- it locally.
       or (r.outcome = 'in_progress' and r.updated_at < now() - v_stale)
     )
  returning r.* into v_row;

  if v_row.request_id is not null then
    return query select true, v_row.idempotency_key, v_row.operation, v_row.actor_id,
                        v_row.payload_hash, v_row.outcome, v_row.response_payload,
                        v_row.created_at, v_row.updated_at;
    return;
  end if;

  -- The upsert matched a row it was not allowed to take over. Return the
  -- authoritative stored row with claimed = false; the Edge Function re-runs
  -- decideIdempotency() against it, so the replay/conflict/in-progress policy
  -- stays in one tested place and this function supplies only the atomicity.
  select * into v_row from public.idempotency_requests where idempotency_key = p_key;

  if v_row.request_id is null then
    -- Neither inserted nor found. Unreachable: the conflict proves a row
    -- exists and nothing deletes from this table. Refuse rather than return a
    -- fabricated "claimed" answer, which would run the operation twice.
    raise exception
      'BFF_IDEMPOTENCY_LOST: key % conflicted but no record could be read', p_key
      using errcode = 'XX000';
  end if;

  return query select false, v_row.idempotency_key, v_row.operation, v_row.actor_id,
                      v_row.payload_hash, v_row.outcome, v_row.response_payload,
                      v_row.created_at, v_row.updated_at;
end;
$$;

create function public.rpc_complete_idempotent_request(
  p_key       text,
  p_operation text,
  p_actor     uuid,
  p_state     text,
  p_response  jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_updated integer;
begin
  perform public.assert_actor_is_caller(p_actor);

  if p_state not in ('succeeded', 'failed') then
    raise exception
      'BFF_BAD_IDEMPOTENCY_STATE: a request completes as succeeded or failed, not %', p_state
      using errcode = '22023';
  end if;

  -- A success with no body cannot be replayed, and replaying the stored
  -- response verbatim is the entire contract. Refusing here surfaces the
  -- programming error; storing NULL would turn the next retry into a silent
  -- empty 200.
  if p_state = 'succeeded' and p_response is null then
    raise exception
      'BFF_RESPONSE_REQUIRED: a succeeded request must store the response it will replay'
      using errcode = '22023';
  end if;

  update public.idempotency_requests r
     set outcome          = p_state,
         response_payload = p_response,
         completed_at     = now(),
         updated_at       = now()
   where r.idempotency_key = p_key
     and r.operation = p_operation
     and r.actor_id = p_actor;

  get diagnostics v_updated = row_count;

  if v_updated = 0 then
    -- Completing a key that was never claimed, or that belongs to somebody
    -- else, is a bug in the caller. Swallowing it would leave the real claim
    -- in_progress until it went stale, blocking the operator meanwhile.
    raise exception
      'BFF_IDEMPOTENCY_NOT_CLAIMED: no % request for key % belongs to %',
      p_operation, p_key, p_actor
      using errcode = '42501';
  end if;
end;
$$;


-- ---------------------------------------------------------------------------
-- rpc_read_sample_sync_state(p_sample_uuid)
--
-- Call sites: _shared/adapters/store.ts:222 and set-disposition/index.ts:243,
-- one named argument. Return shape: SampleSyncStateRow.
--
-- "Highest revision whose row was written AND read back", so the aggregate is
-- over CONFIRMED events only. Any other state is an intention, and reporting
-- an intention as a confirmed revision is the false green rule 6 forbids.
-- Returns no row for a sample with no confirmed event, which is what
-- `confirmedRowNumber === null` means to decideProjection().
-- ---------------------------------------------------------------------------

create function public.rpc_read_sample_sync_state(p_sample_uuid uuid)
returns table (
  sample_uuid            uuid,
  stage                  public.sample_stage,
  confirmed_revision     integer,
  confirmed_row_number   integer,
  confirmed_at           timestamptz,
  confirmed_payload_hash text
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    s.id,
    s.stage,
    latest.payload_revision,
    latest.external_row_number,
    latest.confirmed_at,
    latest.confirmed_payload_hash
  from public.samples s
  join lateral (
    select o.payload_revision, o.external_row_number, o.confirmed_at,
           o.confirmed_payload_hash
    from public.sheet_sync_outbox o
    where o.sample_uuid = s.id
      and o.state = 'confirmed'
    order by o.payload_revision desc, o.confirmed_at desc
    limit 1
  ) as latest on true
  where s.id = p_sample_uuid;
$$;


-- ---------------------------------------------------------------------------
-- rpc_read_ledger_for_stage(p_stage, p_limit, p_offset)
--
-- Specified only in a prose comment in _shared/rpc.ts ("`rpc_read_ledger_for_stage(p_stage,
-- p_limit, p_offset)`"), and confirmed against the call site at
-- reconcile-sheets/index.ts:159, which passes exactly those three names with
-- p_offset = page * LEDGER_PAGE. Return shape: LedgerRow.
--
-- A DRAFT is not in the ledger. It has no identifier and no operational row, so
-- including one would make reconciliation report a `missing_row` finding for a
-- record that was never meant to be in the sheet.
--
-- The ORDER BY is total and stable (sample_id is unique), because the caller
-- pages with LIMIT/OFFSET and compares the result against the whole sheet: an
-- unstable order would drop or duplicate rows across pages and the comparison
-- would invent findings.
-- ---------------------------------------------------------------------------

create function public.rpc_read_ledger_for_stage(
  p_stage  public.sample_stage,
  p_limit  integer,
  p_offset integer
)
returns table (
  sample_uuid          uuid,
  sample_id            text,
  stage                public.sample_stage,
  revision             integer,
  "row"                text[],
  confirmed_row_number integer,
  sync_pending         boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    s.id,
    s.sample_id,
    s.stage,
    s.revision,
    -- The row the ledger believes the sheet should hold: the projection of the
    -- most recent revision enqueued for this sample. Not recomputed here --
    -- the column mapping lives in src/forms/sheetMapping.ts and this is its
    -- stored output.
    coalesce(newest.projected_row, '{}'::text[]),
    confirmed.external_row_number,
    s.sheet_sync_state <> 'confirmed'
  from public.samples s
  left join lateral (
    select o.projected_row
    from public.sheet_sync_outbox o
    where o.sample_uuid = s.id
      and o.state <> 'superseded'
    order by o.payload_revision desc, o.created_at desc
    limit 1
  ) as newest on true
  left join lateral (
    select o.external_row_number
    from public.sheet_sync_outbox o
    where o.sample_uuid = s.id
      and o.state = 'confirmed'
    order by o.payload_revision desc
    limit 1
  ) as confirmed on true
  where s.stage = p_stage
    and s.capture_state <> 'draft'
    and s.sample_id is not null
  order by s.sample_id
  limit greatest(coalesce(p_limit, 0), 0)
  offset greatest(coalesce(p_offset, 0), 0);
$$;


-- ---------------------------------------------------------------------------
-- rpc_health_snapshot()
--
-- Call site: health/index.ts:84, `admin.rpc(RPC.healthSnapshot, {})` -- NO
-- arguments. Return shape: HealthSnapshotRow.
--
-- The outbox counters are reported in the CLIENT vocabulary the interface
-- names: `outbox_retrying` is the database's 'failed' and
-- `outbox_needs_attention` is 'dead_letter'. A superseded event is in neither
-- count: it is not waiting and it is not a problem.
--
-- Its purpose is partly to be ABSENT. health/index.ts treats PGRST202 on this
-- function as "the migrations have not been applied", which is the exact
-- condition finding 1 describes, so this name existing is itself the signal
-- that the contract is deployed.
-- ---------------------------------------------------------------------------

create function public.rpc_health_snapshot()
returns table (
  outbox_pending          bigint,
  outbox_retrying         bigint,
  outbox_needs_attention  bigint,
  outbox_confirmed_24h    bigint,
  oldest_pending_at       timestamptz,
  last_confirmed_at       timestamptz,
  last_reconciled_at      timestamptz,
  schema_drifted          boolean,
  lease_owner             text,
  lease_expires_at        timestamptz,
  lease_fence             bigint
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    count(*) filter (where o.state in ('pending', 'leased')),
    count(*) filter (where o.state = 'failed'),
    count(*) filter (where o.state = 'dead_letter'),
    count(*) filter (where o.state = 'confirmed' and o.confirmed_at > now() - interval '24 hours'),
    min(o.created_at) filter (where o.state in ('pending', 'leased', 'failed')),
    max(o.confirmed_at) filter (where o.state = 'confirmed'),
    (select w.last_reconciled_at from public.sheet_workbook_state w
      where w.workbook_key = 'operational-workbook'),
    coalesce((select w.schema_drifted from public.sheet_workbook_state w
      where w.workbook_key = 'operational-workbook'), false),
    (select l.lease_holder from public.sheet_sync_worker_lease l
      where l.workbook_key = 'operational-workbook'),
    (select l.leased_until from public.sheet_sync_worker_lease l
      where l.workbook_key = 'operational-workbook'),
    (select l.fence_token from public.sheet_sync_worker_lease l
      where l.workbook_key = 'operational-workbook')
  from public.sheet_sync_outbox o;
$$;


-- ---------------------------------------------------------------------------
-- Privileges.
--
-- Every signature revoked from anon and authenticated as well as PUBLIC: a
-- revoke only deletes a grant that was RECORDED, and Supabase's default
-- privileges record EXECUTE for anon and authenticated on every new function
-- in `public`, which `revoke ... from public` does not remove. Never collapse
-- these to the `from public` form -- that is the inert revoke 0009 exists to
-- correct.
--
-- NOT ONE of these is granted to `authenticated`. Every one takes the actor as
-- an argument, so a client able to call them directly could name somebody else;
-- the boundary is that only the Edge Functions, holding the service-role key
-- and a JWT they verified themselves, can reach them at all.
-- ---------------------------------------------------------------------------

revoke all on function public.rpc_authority_context(uuid) from public, anon, authenticated;
grant execute on function public.rpc_authority_context(uuid) to service_role;

revoke all on function public.rpc_record_audit_event(uuid, text, text, text, text, text, text, jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function public.rpc_record_audit_event(uuid, text, text, text, text, text, text, jsonb, jsonb)
  to service_role;

revoke all on function public.rpc_read_idempotency_record(text, text)
  from public, anon, authenticated;
grant execute on function public.rpc_read_idempotency_record(text, text) to service_role;

revoke all on function public.rpc_begin_idempotent_request(text, text, uuid, text, integer)
  from public, anon, authenticated;
grant execute on function public.rpc_begin_idempotent_request(text, text, uuid, text, integer)
  to service_role;

revoke all on function public.rpc_complete_idempotent_request(text, text, uuid, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.rpc_complete_idempotent_request(text, text, uuid, text, jsonb)
  to service_role;

revoke all on function public.rpc_read_sample_sync_state(uuid) from public, anon, authenticated;
grant execute on function public.rpc_read_sample_sync_state(uuid) to service_role;

revoke all on function public.rpc_read_ledger_for_stage(public.sample_stage, integer, integer)
  from public, anon, authenticated;
grant execute on function public.rpc_read_ledger_for_stage(public.sample_stage, integer, integer)
  to service_role;

revoke all on function public.rpc_health_snapshot() from public, anon, authenticated;
grant execute on function public.rpc_health_snapshot() to service_role;

select public.assert_function_privileges();
