-- ===========================================================================
-- 0051 — the eight write paths for a nonconformity.
--
-- Every one follows the shape every other mutation in this schema follows:
-- require the permission, claim the idempotency key, validate with a NAMED
-- error, do the work, record an audit event, mark the mutation committed.
-- None of them is callable by `authenticated`; the Edge Functions hold the
-- service role and are the only caller.
--
-- Returns are deliberately narrow — the id, the number and the status —
-- because a caller that needs the record reads it back under RLS.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Raise.
--
-- `classification` and `severity` are NOT arguments. They are required at the
-- first gate, not at creation, so that a nonconformity raised automatically
-- by a hold (phase 4) costs the person at the mill nothing beyond raising the
-- hold. Guessing them there would fill the columns with defaults nobody chose.
-- ---------------------------------------------------------------------------
create or replace function public.rpc_raise_nonconformity(
  p_actor uuid,
  p_idempotency_key text,
  p_payload_hash text,
  p_app_version text,
  p_title text,
  p_description text,
  p_sample_uuid uuid,
  p_recurrence_of uuid
)
returns table (
  nonconformity_id uuid,
  nc_number text,
  status text,
  recorded_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_basis text;
  v_num   text;
  v_id    uuid;
  v_year  integer;
  v_now   timestamptz := now();
begin
  v_basis := public.require_permission(p_actor, 'nc.raise');
  perform public.claim_mutation(p_idempotency_key, 'raise_nonconformity', p_actor, p_payload_hash);

  if coalesce(btrim(p_title), '') = '' then
    raise exception 'BFF_TITLE_REQUIRED: a nonconformity needs a short title somebody can recognise it by.'
      using errcode = '22023';
  end if;
  if coalesce(btrim(p_description), '') = '' then
    raise exception 'BFF_DESCRIPTION_REQUIRED: say what happened. A nonconformity with no description cannot be investigated later.'
      using errcode = '22023';
  end if;
  if p_sample_uuid is not null
     and not exists (select 1 from public.samples s where s.id = p_sample_uuid) then
    raise exception 'BFF_UNKNOWN_SAMPLE: no sample %', p_sample_uuid using errcode = '23503';
  end if;
  if p_recurrence_of is not null
     and not exists (select 1 from public.nonconformities n where n.id = p_recurrence_of) then
    raise exception 'BFF_UNKNOWN_NONCONFORMITY: no earlier nonconformity %', p_recurrence_of
      using errcode = '23503';
  end if;

  -- The PLANT-LOCAL year, as every other date in this system is.
  v_year := extract(year from (v_now at time zone 'America/Guyana'))::integer;
  v_num  := public.allocate_nc_number(v_year);

  insert into public.nonconformities (
    nc_number, title, description, sample_uuid, recurrence_of, detected_by, detected_at
  ) values (
    v_num, btrim(p_title), btrim(p_description), p_sample_uuid, p_recurrence_of, p_actor, v_now
  ) returning id into v_id;

  perform public.record_audit_event(
    p_action             => 'nonconformity.raised',
    p_entity_type        => 'nonconformity',
    p_entity_id          => v_id::text,
    p_sample_uuid        => p_sample_uuid,
    p_reason             => btrim(p_description),
    p_after              => jsonb_build_object('nc_number', v_num, 'status', 'open'),
    p_outcome            => 'succeeded',
    p_authority_basis    => v_basis,
    p_actor_id           => p_actor,
    p_deployment_version => p_app_version
  );

  perform public.mark_mutation_committed(p_idempotency_key, p_sample_uuid);

  return query
  select n.id, n.nc_number, n.status::text, v_now
    from public.nonconformities n where n.id = v_id;
end $$;


-- ---------------------------------------------------------------------------
-- 2. Update the investigation fields.
--
-- `p_expected_revision` is the optimistic-concurrency token. A nonconformity
-- is a working document two people may have open; the second save is refused
-- rather than silently overwriting the first.
-- ---------------------------------------------------------------------------
create or replace function public.rpc_update_nonconformity(
  p_actor uuid,
  p_idempotency_key text,
  p_payload_hash text,
  p_app_version text,
  p_nc_id uuid,
  p_expected_revision integer,
  p_classification text,
  p_severity text,
  p_correction text,
  p_root_cause text,
  p_root_cause_method text,
  p_five_whys text[],
  p_ca_required boolean,
  p_ca_rationale text
)
returns table (nonconformity_id uuid, revision integer, recorded_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_basis text;
  v_nc    public.nonconformities;
  v_now   timestamptz := now();
begin
  v_basis := public.require_permission(p_actor, 'nc.act');
  perform public.claim_mutation(p_idempotency_key, 'update_nonconformity', p_actor, p_payload_hash);

  select * into v_nc from public.nonconformities where id = p_nc_id for update;
  if v_nc.id is null then
    raise exception 'BFF_UNKNOWN_NONCONFORMITY: no nonconformity %', p_nc_id using errcode = '23503';
  end if;
  if v_nc.status in ('closed','voided') then
    raise exception 'BFF_NC_FROZEN: nonconformity % is % and can no longer be changed.',
      v_nc.nc_number, v_nc.status using errcode = '23514';
  end if;
  if v_nc.revision is distinct from p_expected_revision then
    raise exception
      'BFF_STALE_REVISION: somebody else saved nonconformity % while this was open (theirs is revision %, yours is %). Reload and re-apply your changes.',
      v_nc.nc_number, v_nc.revision, p_expected_revision using errcode = '40001';
  end if;

  update public.nonconformities
     set classification    = coalesce(p_classification::public.nc_classification, classification),
         severity          = coalesce(p_severity::public.nc_severity, severity),
         correction        = coalesce(nullif(btrim(p_correction), ''), correction),
         root_cause        = coalesce(nullif(btrim(p_root_cause), ''), root_cause),
         root_cause_method = coalesce(p_root_cause_method::public.nc_rc_method, root_cause_method),
         five_whys         = coalesce(p_five_whys, five_whys),
         ca_required       = coalesce(p_ca_required, ca_required),
         ca_rationale      = coalesce(nullif(btrim(p_ca_rationale), ''), ca_rationale),
         revision          = revision + 1
   where id = p_nc_id;

  perform public.record_audit_event(
    p_action             => 'nonconformity.updated',
    p_entity_type        => 'nonconformity',
    p_entity_id          => p_nc_id::text,
    p_sample_uuid        => v_nc.sample_uuid,
    p_reason             => 'Investigation fields updated',
    p_before             => jsonb_build_object('revision', v_nc.revision),
    p_after              => jsonb_build_object('revision', v_nc.revision + 1),
    p_outcome            => 'succeeded',
    p_authority_basis    => v_basis,
    p_actor_id           => p_actor,
    p_deployment_version => p_app_version
  );
  perform public.mark_mutation_committed(p_idempotency_key, v_nc.sample_uuid);

  return query select n.id, n.revision, v_now from public.nonconformities n where n.id = p_nc_id;
end $$;


-- ---------------------------------------------------------------------------
-- 3. Add an action.
-- ---------------------------------------------------------------------------
create or replace function public.rpc_add_nc_action(
  p_actor uuid,
  p_idempotency_key text,
  p_payload_hash text,
  p_app_version text,
  p_nc_id uuid,
  p_description text,
  p_assigned_to uuid,
  p_due_date date
)
returns table (action_id uuid, recorded_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_basis text;
  v_nc    public.nonconformities;
  v_id    uuid;
  v_now   timestamptz := now();
begin
  v_basis := public.require_permission(p_actor, 'nc.act');
  perform public.claim_mutation(p_idempotency_key, 'add_nc_action', p_actor, p_payload_hash);

  select * into v_nc from public.nonconformities where id = p_nc_id;
  if v_nc.id is null then
    raise exception 'BFF_UNKNOWN_NONCONFORMITY: no nonconformity %', p_nc_id using errcode = '23503';
  end if;
  if v_nc.status <> 'open' then
    raise exception
      'BFF_NC_NOT_OPEN: actions can only be added while a nonconformity is open; % is %.',
      v_nc.nc_number, v_nc.status using errcode = '23514';
  end if;
  if coalesce(btrim(p_description), '') = '' then
    raise exception 'BFF_ACTION_DESCRIPTION_REQUIRED: say what is to be done.' using errcode = '22023';
  end if;
  if not exists (select 1 from public.profiles pr where pr.id = p_assigned_to) then
    raise exception 'BFF_UNKNOWN_ASSIGNEE: no account %', p_assigned_to using errcode = '23503';
  end if;
  if p_due_date is null then
    raise exception 'BFF_DUE_DATE_REQUIRED: an action with no due date is never late and never done.'
      using errcode = '22023';
  end if;

  insert into public.nc_actions (nc_id, description, assigned_to, due_date, created_by)
  values (p_nc_id, btrim(p_description), p_assigned_to, p_due_date, p_actor)
  returning id into v_id;

  perform public.record_audit_event(
    p_action             => 'nc_action.added',
    p_entity_type        => 'nc_action',
    p_entity_id          => v_id::text,
    p_sample_uuid        => v_nc.sample_uuid,
    p_reason             => btrim(p_description),
    p_after              => jsonb_build_object('nc_number', v_nc.nc_number,
                                               'assigned_to', p_assigned_to,
                                               'due_date', p_due_date),
    p_outcome            => 'succeeded',
    p_authority_basis    => v_basis,
    p_actor_id           => p_actor,
    p_deployment_version => p_app_version
  );
  perform public.mark_mutation_committed(p_idempotency_key, v_nc.sample_uuid);

  return query select v_id, v_now;
end $$;


-- ---------------------------------------------------------------------------
-- 4. Complete an action.
--
-- The note is mandatory. "Done" with nothing beside it is the single most
-- common way a corrective-action register becomes unverifiable later.
-- ---------------------------------------------------------------------------
create or replace function public.rpc_complete_nc_action(
  p_actor uuid,
  p_idempotency_key text,
  p_payload_hash text,
  p_app_version text,
  p_action_id uuid,
  p_completion_note text
)
returns table (action_id uuid, completed_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_basis  text;
  v_action public.nc_actions;
  v_nc     public.nonconformities;
  v_now    timestamptz := now();
begin
  v_basis := public.require_permission(p_actor, 'nc.act');
  perform public.claim_mutation(p_idempotency_key, 'complete_nc_action', p_actor, p_payload_hash);

  select * into v_action from public.nc_actions where id = p_action_id for update;
  if v_action.id is null then
    raise exception 'BFF_UNKNOWN_ACTION: no action %', p_action_id using errcode = '23503';
  end if;
  if v_action.completed_at is not null then
    raise exception 'BFF_ACTION_ALREADY_COMPLETE: that action was completed on %.',
      to_char(v_action.completed_at at time zone 'America/Guyana', 'DD Mon YYYY')
      using errcode = '23514';
  end if;
  if coalesce(btrim(p_completion_note), '') = '' then
    raise exception
      'BFF_COMPLETION_NOTE_REQUIRED: say what was done. An action marked done with no note cannot be verified later.'
      using errcode = '22023';
  end if;

  select * into v_nc from public.nonconformities where id = v_action.nc_id;
  if v_nc.status <> 'open' then
    raise exception 'BFF_NC_NOT_OPEN: % is %; its actions can no longer be completed.',
      v_nc.nc_number, v_nc.status using errcode = '23514';
  end if;

  update public.nc_actions
     set completed_at = v_now, completed_by = p_actor, completion_note = btrim(p_completion_note)
   where id = p_action_id;

  perform public.record_audit_event(
    p_action             => 'nc_action.completed',
    p_entity_type        => 'nc_action',
    p_entity_id          => p_action_id::text,
    p_sample_uuid        => v_nc.sample_uuid,
    p_reason             => btrim(p_completion_note),
    p_after              => jsonb_build_object('nc_number', v_nc.nc_number, 'completed_by', p_actor),
    p_outcome            => 'succeeded',
    p_authority_basis    => v_basis,
    p_actor_id           => p_actor,
    p_deployment_version => p_app_version
  );
  perform public.mark_mutation_committed(p_idempotency_key, v_nc.sample_uuid);

  return query select p_action_id, v_now;
end $$;


-- ---------------------------------------------------------------------------
-- 5. Reassign an action.
--
-- Spec amendment of 2026-11-04: an action owned by somebody who has left the
-- company could otherwise never be completed, and the nonconformity holding
-- it could never reach its first gate.
-- ---------------------------------------------------------------------------
create or replace function public.rpc_reassign_nc_action(
  p_actor uuid,
  p_idempotency_key text,
  p_payload_hash text,
  p_app_version text,
  p_action_id uuid,
  p_assigned_to uuid,
  p_reason text
)
returns table (action_id uuid, assigned_to uuid, recorded_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_basis  text;
  v_action public.nc_actions;
  v_nc     public.nonconformities;
  v_now    timestamptz := now();
begin
  v_basis := public.require_permission(p_actor, 'nc.act');
  perform public.claim_mutation(p_idempotency_key, 'reassign_nc_action', p_actor, p_payload_hash);

  select * into v_action from public.nc_actions where id = p_action_id for update;
  if v_action.id is null then
    raise exception 'BFF_UNKNOWN_ACTION: no action %', p_action_id using errcode = '23503';
  end if;
  if v_action.completed_at is not null then
    raise exception 'BFF_ACTION_ALREADY_COMPLETE: a completed action is not reassigned.'
      using errcode = '23514';
  end if;
  if not exists (select 1 from public.profiles pr where pr.id = p_assigned_to) then
    raise exception 'BFF_UNKNOWN_ASSIGNEE: no account %', p_assigned_to using errcode = '23503';
  end if;
  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'BFF_REASON_REQUIRED: say why the action is moving.' using errcode = '22023';
  end if;

  select * into v_nc from public.nonconformities where id = v_action.nc_id;
  if v_nc.status <> 'open' then
    raise exception 'BFF_NC_NOT_OPEN: % is %; its actions can no longer be reassigned.',
      v_nc.nc_number, v_nc.status using errcode = '23514';
  end if;

  update public.nc_actions set assigned_to = p_assigned_to where id = p_action_id;

  perform public.record_audit_event(
    p_action             => 'nc_action.reassigned',
    p_entity_type        => 'nc_action',
    p_entity_id          => p_action_id::text,
    p_sample_uuid        => v_nc.sample_uuid,
    p_reason             => btrim(p_reason),
    p_before             => jsonb_build_object('assigned_to', v_action.assigned_to),
    p_after              => jsonb_build_object('assigned_to', p_assigned_to),
    p_outcome            => 'succeeded',
    p_authority_basis    => v_basis,
    p_actor_id           => p_actor,
    p_deployment_version => p_app_version
  );
  perform public.mark_mutation_committed(p_idempotency_key, v_nc.sample_uuid);

  return query select p_action_id, p_assigned_to, v_now;
end $$;


-- ---------------------------------------------------------------------------
-- 6. Gate 1 — open -> awaiting_verification.
--
-- WHY THIS COLLECTS EVERY UNMET PRECONDITION INSTEAD OF REFUSING ON THE FIRST
--
-- A gate that refuses on the first missing field makes the person submit six
-- times to learn six things. The six checks of spec §3 are evaluated in full
-- and reported in one message, so the screen can show the whole list at once.
-- ---------------------------------------------------------------------------
create or replace function public.rpc_submit_nc_for_verification(
  p_actor uuid,
  p_idempotency_key text,
  p_payload_hash text,
  p_app_version text,
  p_nc_id uuid
)
returns table (nonconformity_id uuid, status text, recorded_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_basis   text;
  v_nc      public.nonconformities;
  v_unmet   text[] := array[]::text[];
  v_actions integer;
  v_open    integer;
  v_now     timestamptz := now();
begin
  v_basis := public.require_permission(p_actor, 'nc.act');
  perform public.claim_mutation(p_idempotency_key, 'submit_nc_for_verification', p_actor, p_payload_hash);

  select * into v_nc from public.nonconformities where id = p_nc_id for update;
  if v_nc.id is null then
    raise exception 'BFF_UNKNOWN_NONCONFORMITY: no nonconformity %', p_nc_id using errcode = '23503';
  end if;
  if v_nc.status <> 'open' then
    raise exception 'BFF_NC_NOT_OPEN: % is already %.', v_nc.nc_number, v_nc.status
      using errcode = '23514';
  end if;

  select count(*), count(*) filter (where completed_at is null)
    into v_actions, v_open
    from public.nc_actions where nc_id = p_nc_id;

  -- The six preconditions of spec §3, each contributing its own line.
  if v_nc.classification is null then
    v_unmet := v_unmet || ARRAY['a classification has not been chosen'];
  end if;
  if v_nc.severity is null then
    v_unmet := v_unmet || ARRAY['a severity has not been chosen'];
  end if;
  if coalesce(btrim(v_nc.correction), '') = '' then
    v_unmet := v_unmet || ARRAY['the immediate correction has not been recorded'];
  end if;
  if v_nc.ca_required is null then
    v_unmet := v_unmet || ARRAY['the need for corrective action has not been evaluated'];
  end if;
  if coalesce(btrim(v_nc.ca_rationale), '') = '' then
    v_unmet := v_unmet || ARRAY[
      'the reason for that evaluation has not been recorded (required whichever way it was decided)'];
  end if;
  if v_nc.ca_required is true then
    if coalesce(btrim(v_nc.root_cause), '') = '' then
      v_unmet := v_unmet || ARRAY['corrective action is required, so a root cause must be recorded'];
    end if;
    if v_actions = 0 then
      v_unmet := v_unmet || ARRAY['corrective action is required, so at least one action must exist'];
    end if;
  end if;
  -- Independent of how ca_required was decided: an action that exists and is
  -- not done is open work, and a nonconformity with open work is not finished.
  if v_open > 0 then
    v_unmet := v_unmet || ARRAY[format('%s action(s) are still outstanding', v_open)];
  end if;

  if array_length(v_unmet, 1) > 0 then
    raise exception 'BFF_NC_GATE_UNMET: % cannot be submitted for verification yet — %.',
      v_nc.nc_number, array_to_string(v_unmet, '; ') using errcode = '23514';
  end if;

  update public.nonconformities
     set status = 'awaiting_verification', revision = revision + 1
   where id = p_nc_id;

  perform public.record_audit_event(
    p_action             => 'nonconformity.submitted_for_verification',
    p_entity_type        => 'nonconformity',
    p_entity_id          => p_nc_id::text,
    p_sample_uuid        => v_nc.sample_uuid,
    p_reason             => 'All gate-1 preconditions met',
    p_before             => jsonb_build_object('status', 'open'),
    p_after              => jsonb_build_object('status', 'awaiting_verification'),
    p_outcome            => 'succeeded',
    p_authority_basis    => v_basis,
    p_actor_id           => p_actor,
    p_deployment_version => p_app_version
  );
  perform public.mark_mutation_committed(p_idempotency_key, v_nc.sample_uuid);

  return query select p_nc_id, 'awaiting_verification'::text, v_now;
end $$;


-- ---------------------------------------------------------------------------
-- 7. Gate 2 — awaiting_verification -> closed.
--
-- `self_verified` is COMPUTED HERE AND STORED. True when the verifier also
-- detected the nonconformity or completed one of its actions. The record must
-- still say so in five years, whatever happens to the rows around it, and a
-- read-time derivation would quietly change its answer if an action were ever
-- reassigned or a profile merged.
--
-- Self-verification is NOT refused. At a mill with three quality staff it is
-- sometimes the only person who can do it, and a system that forbids it gets
-- worked around by signing in as somebody else — which destroys the record
-- instead of qualifying it. It is recorded, visibly, and an auditor can ask.
-- ---------------------------------------------------------------------------
create or replace function public.rpc_close_nonconformity(
  p_actor uuid,
  p_idempotency_key text,
  p_payload_hash text,
  p_app_version text,
  p_nc_id uuid,
  p_verification_note text
)
returns table (nonconformity_id uuid, status text, self_verified boolean, recorded_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_basis text;
  v_nc    public.nonconformities;
  v_self  boolean;
  v_now   timestamptz := now();
begin
  v_basis := public.require_permission(p_actor, 'nc.close');
  perform public.claim_mutation(p_idempotency_key, 'close_nonconformity', p_actor, p_payload_hash);

  select * into v_nc from public.nonconformities where id = p_nc_id for update;
  if v_nc.id is null then
    raise exception 'BFF_UNKNOWN_NONCONFORMITY: no nonconformity %', p_nc_id using errcode = '23503';
  end if;
  if v_nc.status <> 'awaiting_verification' then
    raise exception
      'BFF_NC_NOT_AWAITING_VERIFICATION: % is %; only a nonconformity awaiting verification can be closed.',
      v_nc.nc_number, v_nc.status using errcode = '23514';
  end if;
  if coalesce(btrim(p_verification_note), '') = '' then
    raise exception
      'BFF_VERIFICATION_NOTE_REQUIRED: say what was checked. A closure with no note records that somebody pressed a button, not that the action worked.'
      using errcode = '22023';
  end if;

  v_self := (v_nc.detected_by = p_actor)
            or exists (select 1 from public.nc_actions a
                        where a.nc_id = p_nc_id and a.completed_by = p_actor);

  update public.nonconformities
     set status            = 'closed',
         verified_by       = p_actor,
         verified_at       = v_now,
         verification_note = btrim(p_verification_note),
         self_verified     = v_self,
         revision          = revision + 1
   where id = p_nc_id;

  perform public.record_audit_event(
    p_action             => 'nonconformity.closed',
    p_entity_type        => 'nonconformity',
    p_entity_id          => p_nc_id::text,
    p_sample_uuid        => v_nc.sample_uuid,
    p_reason             => btrim(p_verification_note),
    p_before             => jsonb_build_object('status', 'awaiting_verification'),
    p_after              => jsonb_build_object('status', 'closed', 'self_verified', v_self),
    p_outcome            => 'succeeded',
    p_authority_basis    => v_basis,
    p_actor_id           => p_actor,
    p_deployment_version => p_app_version
  );
  perform public.mark_mutation_committed(p_idempotency_key, v_nc.sample_uuid);

  return query select p_nc_id, 'closed'::text, v_self, v_now;
end $$;


-- ---------------------------------------------------------------------------
-- 8. Void.
--
-- Available from `open` AND `awaiting_verification`: a nonconformity raised on
-- a mis-read can be discovered at verification, and closing it as though it
-- were legitimate would put a fiction in the record.
-- ---------------------------------------------------------------------------
create or replace function public.rpc_void_nonconformity(
  p_actor uuid,
  p_idempotency_key text,
  p_payload_hash text,
  p_app_version text,
  p_nc_id uuid,
  p_void_reason text
)
returns table (nonconformity_id uuid, status text, recorded_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_basis text;
  v_nc    public.nonconformities;
  v_now   timestamptz := now();
begin
  v_basis := public.require_permission(p_actor, 'nc.close');
  perform public.claim_mutation(p_idempotency_key, 'void_nonconformity', p_actor, p_payload_hash);

  select * into v_nc from public.nonconformities where id = p_nc_id for update;
  if v_nc.id is null then
    raise exception 'BFF_UNKNOWN_NONCONFORMITY: no nonconformity %', p_nc_id using errcode = '23503';
  end if;
  if v_nc.status not in ('open','awaiting_verification') then
    raise exception 'BFF_NC_TERMINAL: % is already %.', v_nc.nc_number, v_nc.status
      using errcode = '23514';
  end if;
  if coalesce(btrim(p_void_reason), '') = '' then
    raise exception
      'BFF_VOID_REASON_REQUIRED: say why this is being voided. A record that disappears without a reason is the thing an audit asks about.'
      using errcode = '22023';
  end if;

  update public.nonconformities
     set status = 'voided', void_reason = btrim(p_void_reason), revision = revision + 1
   where id = p_nc_id;

  perform public.record_audit_event(
    p_action             => 'nonconformity.voided',
    p_entity_type        => 'nonconformity',
    p_entity_id          => p_nc_id::text,
    p_sample_uuid        => v_nc.sample_uuid,
    p_reason             => btrim(p_void_reason),
    p_before             => jsonb_build_object('status', v_nc.status),
    p_after              => jsonb_build_object('status', 'voided'),
    p_outcome            => 'succeeded',
    p_authority_basis    => v_basis,
    p_actor_id           => p_actor,
    p_deployment_version => p_app_version
  );
  perform public.mark_mutation_committed(p_idempotency_key, v_nc.sample_uuid);

  return query select p_nc_id, 'voided'::text, v_now;
end $$;


-- ---------------------------------------------------------------------------
-- 9. Nothing here is callable by a signed-in browser.
--
-- Every one of these runs as the table owner. The Edge Functions hold the
-- service role and are the only legitimate caller; `authenticated` reads under
-- RLS and writes through them.
--
-- Written out one signature at a time, not generated in a loop. The PUBLIC
-- execute grant on a new function is implicit rather than a recorded default,
-- so `alter default privileges ... revoke` is inert and the revoke has to name
-- the function. `tests/rpcContract.test.ts` greps for exactly this shape, and
-- a loop that does the same work is invisible to it — which is the point: a
-- reader cannot see a dynamic revoke either.
-- ---------------------------------------------------------------------------
revoke all on function public.rpc_raise_nonconformity(uuid, text, text, text, text, text, uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.rpc_update_nonconformity(uuid, text, text, text, uuid, integer, text, text, text, text, text, text[], boolean, text)
  from public, anon, authenticated;
revoke all on function public.rpc_add_nc_action(uuid, text, text, text, uuid, text, uuid, date)
  from public, anon, authenticated;
revoke all on function public.rpc_complete_nc_action(uuid, text, text, text, uuid, text)
  from public, anon, authenticated;
revoke all on function public.rpc_reassign_nc_action(uuid, text, text, text, uuid, uuid, text)
  from public, anon, authenticated;
revoke all on function public.rpc_submit_nc_for_verification(uuid, text, text, text, uuid)
  from public, anon, authenticated;
revoke all on function public.rpc_close_nonconformity(uuid, text, text, text, uuid, text)
  from public, anon, authenticated;
revoke all on function public.rpc_void_nonconformity(uuid, text, text, text, uuid, text)
  from public, anon, authenticated;
