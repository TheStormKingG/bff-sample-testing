-- ===========================================================================
-- 0052 — five defects in the nonconformity layer, found by a review pointed
--        at the SPECIFICATION rather than at the plan that produced the code.
--
-- The plan contained the complete code, so "does the implementation match the
-- plan?" was a tautology and the question that mattered — does the plan match
-- the requirement? — was asked by nobody. Four reviewers were given the spec,
-- the live schema and the files, and explicitly told the plan might be wrong.
-- Every defect below came back from that, and none of them is a style note.
--
-- ---------------------------------------------------------------------------
-- 1. THE READ PATH DID NOT EXIST
-- ---------------------------------------------------------------------------
-- 0050 enabled row-level security on `nonconformities` and `nc_actions` and
-- wrote a select policy for each. It never granted SELECT to `authenticated`.
-- An RLS policy narrows a privilege; it does not confer one, so the policies
-- could never be reached and NO account — supervisor, officer, operator or
-- auditor — could read a nonconformity through the client. Confirmed against
-- the live project before this was written: `has_table_privilege` reported
-- false for both tables while reporting true for `samples` and `holds`.
--
-- It was invisible because every probe in 0048-0051 runs as the table owner,
-- which RLS and table privileges do not constrain. The whole proof suite
-- tested the write paths from a position no browser ever occupies.
--
-- ---------------------------------------------------------------------------
-- 2. A TRIGGER FUNCTION LEFT WITH PUBLIC EXECUTE, AND THE GUARD THAT WOULD
--    HAVE SAID SO WAS NOT RUN
-- ---------------------------------------------------------------------------
-- `tg_nonconformities_guard()` was created with no ACL at all, which leaves
-- the IMPLICIT PUBLIC execute grant in place — reaching `anon` and
-- `authenticated`. Every other function-creating migration in this schema
-- ends by calling `public.assert_function_privileges()`, which fails on
-- exactly this condition. 0048, 0049, 0050 and 0051 all skipped it.
--
-- It was already failing. Run against the live project before this migration:
--   ERROR 42501: functions in schema public still grant EXECUTE to PUBLIC:
--   tg_nonconformities_guard().
-- A gate the schema already owned, which nothing invoked for four migrations.
--
-- ---------------------------------------------------------------------------
-- 3. GATE 1 WAS ONE-SHOT
-- ---------------------------------------------------------------------------
-- `rpc_update_nonconformity` refused only `closed` and `voided`, so a record
-- sitting in `awaiting_verification` could still have its gate-1 inputs
-- rewritten, and `rpc_close_nonconformity` re-checked none of them. The
-- sequence, entirely through the RPCs:
--
--   raise -> set ca_required = false with a rationale -> submit (legitimately
--   passes: §3 requires a root cause and actions only when ca_required is
--   true) -> update again with ca_required = true -> close.
--
-- The result is a closed, frozen quality record asserting that corrective
-- action was required, with no root cause recorded and no action ever raised
-- — precisely the combination gate 1 refuses. Spec §3 says "Editable while
-- open", and the RPC was reading that as "editable until closed".
--
-- Both ends are fixed, because they fail independently: the update refuses
-- once the record has left `open`, AND the gate-1 predicate is now ONE
-- function called by both gates, so they cannot drift apart. The probe
-- exercises the second fix through a direct UPDATE as owner — a path the
-- 0048 guard still permits — because a check that cannot be made to fire has
-- not been tested.
--
-- ---------------------------------------------------------------------------
-- 4. A RACE BETWEEN ADDING AN ACTION AND PASSING THE GATE
-- ---------------------------------------------------------------------------
-- `rpc_add_nc_action` read the parent nonconformity WITHOUT `for update`, so
-- its status check could be satisfied by a value a concurrent
-- `rpc_submit_nc_for_verification` was already committing. The action then
-- lands on a record that has passed a gate requiring every action to be
-- complete, and can never be completed afterwards, because completing one
-- requires status = 'open'. An unclearable row in a warning state — the
-- trap 0048's own comment sets out to avoid.
--
-- All three action RPCs now lock the PARENT FIRST and the action second, in
-- that order everywhere, so two of them cannot deadlock against each other.
--
-- ---------------------------------------------------------------------------
-- 5. ONE ASSERTION WAS PROVING SOMETHING ELSE
-- ---------------------------------------------------------------------------
-- 0048's assertion A7, labelled "a nonconformity was closed with no
-- verification", is satisfied by the lifecycle TRIGGER refusing the
-- transition, not by the `nc_closed_is_verified` CHECK constraint it appears
-- to test. The constraint had no test anywhere. It is tested here, through
-- the one transition the trigger permits: `awaiting_verification -> closed`
-- with `verified_by` null.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. The read privilege the policies in 0050 narrow.
--
-- `nc_number_sequence` is deliberately NOT granted: it is written only by
-- `allocate_nc_number` and holds nothing a screen needs.
-- ---------------------------------------------------------------------------
grant select on public.nonconformities to authenticated;
grant select on public.nc_actions      to authenticated;


-- ---------------------------------------------------------------------------
-- 2. The trigger function's implicit PUBLIC execute grant.
-- ---------------------------------------------------------------------------
revoke all on function public.tg_nonconformities_guard() from public, anon, authenticated;


-- ---------------------------------------------------------------------------
-- 3. The gate-1 predicate, in ONE place.
--
-- Both gates call it. Written as a function rather than copied into the
-- second caller because two copies of a six-clause predicate drift, and the
-- drift is silent: each copy is internally consistent and the disagreement
-- only shows up in a record that passed one and failed the other.
--
-- Returns the unmet items rather than a boolean, so the caller can name all
-- of them at once. A gate that refuses on the first missing field makes
-- somebody submit six times to learn six things.
-- ---------------------------------------------------------------------------
create or replace function public.nc_gate_one_unmet(p_nc_id uuid)
returns text[]
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_nc      public.nonconformities;
  v_unmet   text[] := array[]::text[];
  v_actions integer;
  v_open    integer;
begin
  select * into v_nc from public.nonconformities where id = p_nc_id;
  if v_nc.id is null then
    raise exception 'BFF_UNKNOWN_NONCONFORMITY: no nonconformity %', p_nc_id using errcode = '23503';
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

  return v_unmet;
end $$;

revoke all on function public.nc_gate_one_unmet(uuid) from public, anon, authenticated;

comment on function public.nc_gate_one_unmet(uuid) is
  'The spec §3 open -> awaiting_verification preconditions, as a list of what is unmet. Called by BOTH gates so they cannot drift apart.';


-- ---------------------------------------------------------------------------
-- 4. The update RPC: editable while OPEN, which is what spec §3 says.
--
-- Everything this writes is a gate-1 input. Permitting it in
-- `awaiting_verification` let a record be changed into a state that would not
-- pass the gate it had already passed.
--
-- There is deliberately no path back to `open` in phase 1. The 0048 guard
-- permits that transition, but the spec's state diagram does not draw it and
-- no RPC performs it; a verifier who finds a record incomplete closes it with
-- a note saying so, or voids it. Adding a return path is a spec question, not
-- an implementation one.
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
  if v_nc.status <> 'open' then
    raise exception
      'BFF_NC_NOT_OPEN: % is %. A nonconformity is editable while it is open; everything this changes is a precondition of the gate it has already passed.',
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
-- 5. Adding an action: lock the parent, THEN read its status.
--
-- Without the lock the status check could be satisfied by a value a
-- concurrent submit was already committing, leaving an action on a record
-- that had passed a gate requiring every action to be complete — and which
-- could never be completed, because completing one requires status = 'open'.
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

  -- FOR UPDATE: the status read below must not be able to go stale between
  -- the read and the insert.
  select * into v_nc from public.nonconformities where id = p_nc_id for update;
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
-- 6. Completing an action: parent first, action second.
--
-- The lock ORDER is the point, not just the presence of locks. The previous
-- version locked the action and then read the parent unlocked; a submit locks
-- the parent and then reads the actions. Two of those running at once can
-- hold what the other wants. Parent-then-child, everywhere.
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
  v_nc_id  uuid;
  v_action public.nc_actions;
  v_nc     public.nonconformities;
  v_now    timestamptz := now();
begin
  v_basis := public.require_permission(p_actor, 'nc.act');
  perform public.claim_mutation(p_idempotency_key, 'complete_nc_action', p_actor, p_payload_hash);

  -- Unlocked, only to find which parent to lock. nc_id is immutable.
  select nc_id into v_nc_id from public.nc_actions where id = p_action_id;
  if v_nc_id is null then
    raise exception 'BFF_UNKNOWN_ACTION: no action %', p_action_id using errcode = '23503';
  end if;

  select * into v_nc from public.nonconformities where id = v_nc_id for update;
  if v_nc.status <> 'open' then
    raise exception 'BFF_NC_NOT_OPEN: % is %; its actions can no longer be completed.',
      v_nc.nc_number, v_nc.status using errcode = '23514';
  end if;

  select * into v_action from public.nc_actions where id = p_action_id for update;
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
-- 7. Reassigning an action: same lock order.
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
  v_nc_id  uuid;
  v_action public.nc_actions;
  v_nc     public.nonconformities;
  v_now    timestamptz := now();
begin
  v_basis := public.require_permission(p_actor, 'nc.act');
  perform public.claim_mutation(p_idempotency_key, 'reassign_nc_action', p_actor, p_payload_hash);

  select nc_id into v_nc_id from public.nc_actions where id = p_action_id;
  if v_nc_id is null then
    raise exception 'BFF_UNKNOWN_ACTION: no action %', p_action_id using errcode = '23503';
  end if;

  select * into v_nc from public.nonconformities where id = v_nc_id for update;
  if v_nc.status <> 'open' then
    raise exception 'BFF_NC_NOT_OPEN: % is %; its actions can no longer be reassigned.',
      v_nc.nc_number, v_nc.status using errcode = '23514';
  end if;

  select * into v_action from public.nc_actions where id = p_action_id for update;
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
-- 8. Both gates, now sharing one predicate.
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
  v_basis text;
  v_nc    public.nonconformities;
  v_unmet text[];
  v_now   timestamptz := now();
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

  v_unmet := public.nc_gate_one_unmet(p_nc_id);
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
-- 9. Gate 2, which now re-checks gate 1.
--
-- WHY RE-CHECK SOMETHING THAT CANNOT CHANGE
--
-- With the update RPC refusing anything but `open`, no path THROUGH THE RPCs
-- can make this fire. It is here because the 0048 guard still permits a
-- direct UPDATE in `awaiting_verification`, so a future RPC, a migration or a
-- hand-edit can reach the state; a closed nonconformity is frozen and
-- permanent, and this is the last place anything looks.
--
-- A check nothing can make fail is not a check, so the verifier drives this
-- one through exactly that direct UPDATE and asserts the refusal. The same
-- reasoning that makes the check worth having makes testing it mandatory.
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
  v_unmet text[];
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

  v_unmet := public.nc_gate_one_unmet(p_nc_id);
  if array_length(v_unmet, 1) > 0 then
    raise exception
      'BFF_NC_GATE_UNMET: % no longer satisfies the conditions it passed to reach verification, so it cannot be closed — %. Void it, or put it back in order first.',
      v_nc.nc_number, array_to_string(v_unmet, '; ') using errcode = '23514';
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
-- 10. The revokes, one signature at a time. See 0051 for why not a loop.
-- ---------------------------------------------------------------------------
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


-- ---------------------------------------------------------------------------
-- 11. Prove it, in the same transaction that did it.
--
-- The privileges and the ACL are asserted here. The BEHAVIOURAL fixes — the
-- post-gate update refusal, gate 2's re-check driven through a direct UPDATE,
-- and the nc_closed_is_verified constraint — are asserted in
-- `scripts/verify-nc-lifecycle.sql`, which can resolve real accounts and
-- roll its writes back; a migration cannot invent a profile row.
-- ---------------------------------------------------------------------------
do $$
declare
  v_fail text := '';
  v_acl  aclitem[];
begin
  -- B1. The read privilege exists, on both tables, for `authenticated` and
  --     not for `anon`. The policies in 0050 narrow a privilege; they do not
  --     confer one, which is the whole defect.
  if not has_table_privilege('authenticated', 'public.nonconformities', 'SELECT') then
    v_fail := v_fail || 'authenticated still cannot select nonconformities; ';
  end if;
  if not has_table_privilege('authenticated', 'public.nc_actions', 'SELECT') then
    v_fail := v_fail || 'authenticated still cannot select nc_actions; ';
  end if;
  if has_table_privilege('anon', 'public.nonconformities', 'SELECT') then
    v_fail := v_fail || 'anon can select nonconformities; ';
  end if;

  -- B2. A negative control on the instrument itself. `has_table_privilege`
  --     answering true for everything would satisfy B1, and a quality record
  --     is exactly the thing not to be wrong about here.
  if has_table_privilege('authenticated', 'public.nc_number_sequence', 'SELECT') then
    v_fail := v_fail || 'authenticated can select nc_number_sequence, which is internal; ';
  end if;

  -- B3. No INSERT, UPDATE or DELETE. 0050 wrote no write policies, but a
  --     policy-less privilege plus a future permissive policy is how a write
  --     path appears by accident.
  if has_table_privilege('authenticated', 'public.nonconformities', 'INSERT')
     or has_table_privilege('authenticated', 'public.nonconformities', 'UPDATE')
     or has_table_privilege('authenticated', 'public.nonconformities', 'DELETE') then
    v_fail := v_fail || 'authenticated holds a write privilege on nonconformities; ';
  end if;

  -- B4. The trigger function no longer carries the implicit PUBLIC grant.
  select p.proacl into v_acl
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'tg_nonconformities_guard';
  if v_acl is null then
    v_fail := v_fail || 'tg_nonconformities_guard still has a null ACL (implicit PUBLIC execute); ';
  elsif array_to_string(v_acl, ' ') like '%=X/%' and array_to_string(v_acl, ' ') ~ '(^| )=X/' then
    v_fail := v_fail || 'tg_nonconformities_guard still grants EXECUTE to PUBLIC; ';
  end if;

  -- B5. The shared predicate exists and both gates call it. Checked by
  --     reading the function bodies, because two copies of the predicate is
  --     the defect this replaced and it would re-appear silently.
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'public' and p.proname = 'nc_gate_one_unmet') then
    v_fail := v_fail || 'nc_gate_one_unmet does not exist; ';
  else
    if (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public'
           and p.proname in ('rpc_submit_nc_for_verification','rpc_close_nonconformity')
           and pg_get_functiondef(p.oid) like '%nc_gate_one_unmet%') <> 2 then
      v_fail := v_fail
        || 'both gates must call nc_gate_one_unmet; at least one still carries its own copy; ';
    end if;
    -- And neither of them re-implements it: a bare `classification is null`
    -- in a gate means the predicate was copied back in beside the call.
    if (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public'
           and p.proname in ('rpc_submit_nc_for_verification','rpc_close_nonconformity')
           and pg_get_functiondef(p.oid) like '%a classification has not been chosen%') <> 0 then
      v_fail := v_fail || 'a gate still contains an inline copy of the gate-1 predicate; ';
    end if;
  end if;

  if v_fail <> '' then
    raise exception 'BFF_0052: %', v_fail using errcode = '22023';
  end if;
end $$;


-- ---------------------------------------------------------------------------
-- 12. The gate 0048 through 0051 did not run.
--
-- Every other function-creating migration in this schema ends here. Four in
-- a row did not, and the condition it checks was already true and already
-- failing. Last, so that it sees this migration's own functions too.
-- ---------------------------------------------------------------------------
select public.assert_function_privileges();
