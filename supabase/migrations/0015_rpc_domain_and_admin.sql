-- ---------------------------------------------------------------------------
-- 0015_rpc_domain_and_admin.sql
--
-- The twelve RPCs that supabase/functions/_shared/rpc.ts gained after 0009-0014
-- were written, plus the three whose declared signatures changed:
--
--   rpc_raise_hold            rpc_clear_hold
--   rpc_propose_specification rpc_submit_specification_for_review
--   rpc_approve_account       rpc_set_user_status   rpc_set_user_roles
--   rpc_upsert_controlled_value
--   rpc_grant_delegation      rpc_revoke_delegation
--   rpc_record_audit_failure  rpc_retry_audit_dead_letters
--
--   rpc_retry_dead_lettered      -- declared signature replaces an inferred one
--   rpc_requeue_outbox_event     -- gains a second, declared signature
--   rpc_health_snapshot          -- gains the audit dead-letter counts
--
-- Every argument list is taken from a real call site, named in the comment on
-- each function. None is guessed.
--
-- ONE RULE RUNS THROUGH ALL THE ADMINISTRATION RPCS. rpc.ts states it: "
-- `p_target_user` is the account being administered and is ALWAYS distinct from
-- `p_actor` ... No administration RPC may read the acting identity from its own
-- arguments." So each of them refuses a self-targeted call outright. That is
-- not defensiveness about an unlikely input: `user.manage` and
-- `user.approve_access` belong to the administrator, and a self-targeted call
-- is precisely how an administrator would approve their own access, restore
-- their own suspended account or grant themselves a quality role.
-- ---------------------------------------------------------------------------


-- ---------------------------------------------------------------------------
-- The audit dead letter.
--
-- "NOT a variant of rpc_record_audit_event: it is called precisely when that
-- one has already failed, so it must reach a different table by a different
-- statement, or it fails for the same reason and records nothing."
--
-- Hence a separate table with NO foreign key to public.profiles on the actor,
-- and no reference to public.samples. audit_events.actor_id references
-- profiles ON DELETE RESTRICT and sample_uuid references samples: a violation
-- of either is one of the plausible reasons the original write failed, and
-- repeating the constraint here would reproduce the failure. The actor is
-- stored as a bare uuid, which is what a dead letter is for -- holding what was
-- said, exactly as it was said, until somebody can look at it.
-- ---------------------------------------------------------------------------

create table public.audit_event_dead_letters (
  id              uuid primary key default gen_random_uuid(),
  received_at     timestamptz not null default now(),

  -- The WHOLE original event, by value. "Carries the WHOLE original event, not
  -- a counter, so the trail can be replayed once the cause is fixed. A count
  -- alone would tell an administrator that N events were lost and nothing
  -- about what they said."
  actor_id        uuid,
  action          text not null,
  subject_type    text not null,
  subject_id      text,
  outcome         text not null,
  reason          text,
  before_payload  jsonb,
  after_payload   jsonb,
  app_version     text,

  -- Why the audit write failed. 'rpc_error' means the database answered and
  -- refused; 'threw' means it was never reached. Different faults, different
  -- investigations, so they are not collapsed into one flag.
  failure_detail  text not null,
  failure_stage   text not null,

  state           text not null default 'held',
  attempts        integer not null default 0,
  last_attempt_at timestamptz,
  last_error      text,
  replayed_at     timestamptz,
  replayed_event  uuid,

  constraint audit_event_dead_letters_action_present check (length(btrim(action)) > 0),
  constraint audit_event_dead_letters_outcome_valid
    check (outcome in ('allowed', 'denied', 'error')),
  constraint audit_event_dead_letters_stage_valid
    check (failure_stage in ('rpc_error', 'threw')),
  constraint audit_event_dead_letters_detail_present
    check (length(btrim(failure_detail)) > 0),
  constraint audit_event_dead_letters_state_valid
    check (state in ('held', 'replayed')),
  constraint audit_event_dead_letters_attempts_nonneg check (attempts >= 0),
  -- A replayed letter names the event it became. Without that the trail would
  -- say an event was recovered and give no way to find it.
  constraint audit_event_dead_letters_replay_shape check (
    (state = 'replayed' and replayed_at is not null and replayed_event is not null)
    or (state = 'held' and replayed_at is null and replayed_event is null)
  )
);

create index audit_event_dead_letters_held_idx
  on public.audit_event_dead_letters (received_at)
  where state = 'held';

-- A dead letter is NEVER updated except by the replay path and never deleted:
-- the whole point is that it survives the thing that lost the original.
create trigger audit_event_dead_letters_no_delete
  before delete on public.audit_event_dead_letters
  for each row execute function public.tg_append_only();

comment on table public.audit_event_dead_letters is
  'Audit events whose write to public.audit_events failed, held verbatim for replay. Deliberately free of the foreign keys on audit_events, because a violation of one of those is a likely cause of the original failure.';

alter table public.audit_event_dead_letters enable row level security;

create policy audit_event_dead_letters_select_auditors
  on public.audit_event_dead_letters
  for select to authenticated
  using (public.is_active_user() and public.has_permission('audit.view'));

revoke all on public.audit_event_dead_letters from anon, authenticated;
grant select on public.audit_event_dead_letters to authenticated;


-- ---------------------------------------------------------------------------
-- rpc_record_audit_failure(...)
--
-- Call site: _shared/adapters/authorize.ts:195, eleven named arguments.
--
-- Takes NO idempotency key and performs NO authority check, both deliberately.
-- It is reached only from the failure path of recordAudit(), on the
-- service-role connection, after an audit write has already failed; adding a
-- precondition here adds a way for the dead letter itself to fail, and then the
-- event is simply gone. Writing one plain INSERT is the whole job.
-- ---------------------------------------------------------------------------

create function public.rpc_record_audit_failure(
  p_actor          uuid,
  p_action         text,
  p_subject_type   text,
  p_subject_id     text,
  p_outcome        text,
  p_reason         text,
  p_before         jsonb,
  p_after          jsonb,
  p_app_version    text,
  p_failure_detail text,
  p_failure_stage  text
)
returns uuid
language sql
security definer
set search_path = ''
as $$
  insert into public.audit_event_dead_letters (
    actor_id, action, subject_type, subject_id, outcome, reason,
    before_payload, after_payload, app_version, failure_detail, failure_stage
  )
  values (
    p_actor, p_action, p_subject_type, p_subject_id, p_outcome, p_reason,
    p_before, p_after, p_app_version,
    p_failure_detail, p_failure_stage
  )
  returning id;
$$;


-- ---------------------------------------------------------------------------
-- rpc_retry_audit_dead_letters(p_limit)
--
-- Declared by RetryAuditDeadLettersArgs / RetryAuditDeadLettersResult.
-- "Replays held audit events."
--
-- NO LONGER IN THE `RPC` CONSTANT. It was there when this migration was
-- written and has since been removed from supabase/functions/_shared/rpc.ts, so
-- nothing calls it today. It is kept, and kept complete, for one reason: the
-- dead-letter table has no other way back into public.audit_events, and
-- rpc_health_snapshot reports how many letters are held and how old the oldest
-- is. A backlog an operator can see and cannot clear is worse than no dead
-- letter at all. Deleting it would also mean deleting the only replay path for
-- audit events the system has already admitted to losing.
--
-- NO actor, so no permission check is possible and none is pretended: this is a
-- recovery job run by the scheduler on the service-role key, and the privilege
-- boundary is that `authenticated` cannot call it. Each letter is replayed in
-- its own exception block, so ONE letter that still cannot be written does not
-- abort the pass and strand the rest -- which was the original failure mode,
-- repeated.
-- ---------------------------------------------------------------------------

create function public.rpc_retry_audit_dead_letters(p_limit integer)
returns table (
  attempted  integer,
  written    integer,
  still_held integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_letter    record;
  v_attempted integer := 0;
  v_written   integer := 0;
  v_held      integer;
  v_event     uuid;
  v_outcome   text;
begin
  for v_letter in
    select *
    from public.audit_event_dead_letters
    where state = 'held'
    order by received_at
    limit greatest(coalesce(p_limit, 0), 0)
    for update skip locked
  loop
    v_attempted := v_attempted + 1;

    begin
      case v_letter.outcome
        when 'allowed' then v_outcome := 'succeeded';
        when 'denied'  then v_outcome := 'denied';
        when 'error'   then v_outcome := 'failed';
        else v_outcome := 'failed';
      end case;

      v_event := public.record_audit_event(
        p_action             => v_letter.action,
        p_entity_type        => v_letter.subject_type,
        p_entity_id          => v_letter.subject_id,
        p_sample_uuid        => null,
        p_reason             => v_letter.reason,
        p_before             => v_letter.before_payload,
        p_after              => v_letter.after_payload,
        p_request_id         => null,
        p_outcome            => v_outcome,
        p_denial_code        => case when v_outcome = 'denied'
                                     then coalesce(nullif(btrim(v_letter.reason), ''), 'denied')
                                     else null end,
        p_authority_basis    => null,
        p_actor_id           => v_letter.actor_id,
        p_deployment_version => v_letter.app_version
      );

      update public.audit_event_dead_letters
         set state           = 'replayed',
             replayed_at     = now(),
             replayed_event  = v_event,
             attempts        = attempts + 1,
             last_attempt_at = now(),
             last_error      = null
       where id = v_letter.id;

      v_written := v_written + 1;

    exception when others then
      -- Still unwritable. Record WHY and leave it held; the next pass tries
      -- again. The exception block confines the rollback to this one letter.
      update public.audit_event_dead_letters
         set attempts        = attempts + 1,
             last_attempt_at = now(),
             last_error      = sqlerrm
       where id = v_letter.id;
    end;
  end loop;

  -- Everything still held, not merely what this batch left behind: the caller
  -- is deciding whether the backlog is clearing, and a per-batch figure cannot
  -- answer that.
  select count(*) into v_held
  from public.audit_event_dead_letters
  where state = 'held';

  return query select v_attempted, v_written, v_held::integer;
end;
$$;


-- ---------------------------------------------------------------------------
-- rpc_health_snapshot(), with the audit dead-letter counts.
--
-- HealthSnapshotRow gained `audit_dead_letters` and
-- `audit_dead_letter_oldest_at`. Dropped and recreated because the return type
-- changes; `create or replace` cannot alter an OUT column list.
--
-- The field is optional on the TypeScript side so that "a deployment whose
-- rpc_health_snapshot predates this field must be reported as 'the count is not
-- available', never as zero". This definition always supplies it, so the
-- not-available case is now only a version-skew condition, which is exactly
-- what the optionality is for.
-- ---------------------------------------------------------------------------

drop function public.rpc_health_snapshot();

create function public.rpc_health_snapshot()
returns table (
  outbox_pending              bigint,
  outbox_retrying             bigint,
  outbox_needs_attention      bigint,
  outbox_confirmed_24h        bigint,
  oldest_pending_at           timestamptz,
  last_confirmed_at           timestamptz,
  last_reconciled_at          timestamptz,
  schema_drifted              boolean,
  lease_owner                 text,
  lease_expires_at            timestamptz,
  lease_fence                 bigint,
  audit_dead_letters          bigint,
  audit_dead_letter_oldest_at timestamptz
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
      where w.workbook_key = public.operational_workbook_key()),
    coalesce((select w.schema_drifted from public.sheet_workbook_state w
      where w.workbook_key = public.operational_workbook_key()), false),
    (select l.lease_holder from public.sheet_sync_worker_lease l),
    (select l.leased_until from public.sheet_sync_worker_lease l),
    (select l.fence_token from public.sheet_sync_worker_lease l),
    (select count(*) from public.audit_event_dead_letters d where d.state = 'held'),
    (select min(d.received_at) from public.audit_event_dead_letters d where d.state = 'held')
  from public.sheet_sync_outbox o;
$$;


-- ---------------------------------------------------------------------------
-- rpc_raise_hold / rpc_clear_hold
--
-- Call site: _shared/handlers/hold.ts:88, eight named arguments, one RPC per
-- direction. "Hold raising and hold clearing are two RPCs, not one with a flag,
-- because they answer to two different permissions (`hold.raise` and
-- `hold.clear`) and a single entry point invites a caller to pass the state as
-- data."
--
-- The asymmetry is the whole control. `hold.raise` is held by every role that
-- touches a sample, because stopping material is the safe direction.
-- `hold.clear` is held by the quality SUPERVISOR alone -- not the quality
-- officer, and NOT the administrator -- because letting material go is the
-- unsafe direction. Each is checked against the matrix separately, so clearing
-- can never be reached through the raise path.
-- ---------------------------------------------------------------------------

create function public.rpc_raise_hold(
  p_actor             uuid,
  p_idempotency_key   text,
  p_payload_hash      text,
  p_app_version       text,
  p_sample_uuid       uuid,
  p_expected_revision integer,
  p_reason            text,
  p_field_key         text default null
)
returns table (
  sample_uuid   uuid,
  sample_id     text,
  revision      integer,
  capture_state text,
  disposition   text,
  hold_active   boolean,
  recorded_at   timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_basis  text;
  v_sample public.samples;
begin
  v_basis := public.require_permission(p_actor, 'hold.raise');
  perform public.claim_mutation(p_idempotency_key, 'raise_hold', p_actor, p_payload_hash);

  -- PRD section 6.2: every quality decision carries a reason.
  if coalesce(btrim(p_reason), '') = '' then
    raise exception
      'BFF_REASON_REQUIRED: say why this sample is being held. The reason is recorded in the sample history.'
      using errcode = '22023';
  end if;

  select * into v_sample from public.samples where id = p_sample_uuid for update;
  if v_sample.id is null then
    raise exception 'BFF_UNKNOWN_SAMPLE: no sample %', p_sample_uuid using errcode = '23503';
  end if;

  if v_sample.revision <> p_expected_revision then
    raise exception
      'BFF_REVISION_CONFLICT: % has moved on to revision % since you loaded it (you sent %)',
      coalesce(v_sample.sample_id, v_sample.id::text), v_sample.revision, p_expected_revision;
  end if;

  if v_sample.capture_state = 'voided' then
    raise exception 'BFF_TERMINAL_STATE: a voided sample cannot be held.'
      using errcode = '23514';
  end if;

  -- holds_field_pair requires stage and field_key to be present or absent
  -- together, so a named field carries the sample's stage with it. The field
  -- must exist on THAT stage's form: a hold about a column the form does not
  -- have could never be shown next to anything.
  if p_field_key is not null and not exists (
    select 1 from public.stage_fields f
    where f.stage = v_sample.stage and f.field_key = p_field_key
  ) then
    raise exception
      'BFF_UNKNOWN_FIELD: column % does not exist on the % form', p_field_key, v_sample.stage
      using errcode = '23503';
  end if;

  insert into public.holds (
    sample_uuid, trigger_kind, stage, field_key, detail,
    raised_by, raised_authority, raise_reason
  )
  values (
    p_sample_uuid, 'manual',
    case when p_field_key is null then null else v_sample.stage end,
    p_field_key,
    btrim(p_reason), p_actor, v_basis, btrim(p_reason)
  );

  update public.samples set revision = v_sample.revision + 1 where id = p_sample_uuid;

  perform public.record_audit_event(
    p_action             => 'sample.hold_raised',
    p_entity_type        => 'sample',
    p_entity_id          => p_sample_uuid::text,
    p_sample_uuid        => p_sample_uuid,
    p_reason             => btrim(p_reason),
    p_before             => jsonb_build_object('hold_flag', v_sample.hold_flag,
                                               'disposition', v_sample.disposition),
    p_after              => jsonb_build_object('hold_flag', true, 'field_key', p_field_key),
    p_outcome            => 'succeeded',
    p_authority_basis    => v_basis,
    p_actor_id           => p_actor,
    p_deployment_version => p_app_version
  );

  perform public.mark_mutation_committed(p_idempotency_key, p_sample_uuid);

  return query
  select s.id, s.sample_id, s.revision, s.capture_state::text, s.disposition::text,
         s.hold_flag, s.updated_at
  from public.samples s where s.id = p_sample_uuid;
end;
$$;

create function public.rpc_clear_hold(
  p_actor             uuid,
  p_idempotency_key   text,
  p_payload_hash      text,
  p_app_version       text,
  p_sample_uuid       uuid,
  p_expected_revision integer,
  p_reason            text,
  p_field_key         text default null
)
returns table (
  sample_uuid   uuid,
  sample_id     text,
  revision      integer,
  capture_state text,
  disposition   text,
  hold_active   boolean,
  recorded_at   timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_basis   text;
  v_sample  public.samples;
  v_cleared integer;
begin
  -- NOT 'hold.raise'. The quality officer and the administrator both hold the
  -- raise permission and neither holds this one.
  v_basis := public.require_permission(p_actor, 'hold.clear');
  perform public.claim_mutation(p_idempotency_key, 'clear_hold', p_actor, p_payload_hash);

  -- holds_clearance_justified: clearing a hold always requires a written reason
  -- and a recorded authority. Letting material go is never a silent act.
  if coalesce(btrim(p_reason), '') = '' then
    raise exception
      'BFF_REASON_REQUIRED: say why this hold is being cleared. Letting material go is never a silent act.'
      using errcode = '22023';
  end if;

  select * into v_sample from public.samples where id = p_sample_uuid for update;
  if v_sample.id is null then
    raise exception 'BFF_UNKNOWN_SAMPLE: no sample %', p_sample_uuid using errcode = '23503';
  end if;

  if v_sample.revision <> p_expected_revision then
    raise exception
      'BFF_REVISION_CONFLICT: % has moved on to revision % since you loaded it (you sent %)',
      coalesce(v_sample.sample_id, v_sample.id::text), v_sample.revision, p_expected_revision;
  end if;

  update public.holds h
     set cleared_by        = p_actor,
         cleared_at        = now(),
         cleared_authority = v_basis,
         clear_reason      = btrim(p_reason)
   where h.sample_uuid = p_sample_uuid
     and h.cleared_at is null
     -- p_field_key narrows the clearance to one finding. Absent, every
     -- uncleared hold on the sample is cleared, which is what the endpoint
     -- offers: HoldArgs carries no hold id, so there is no way to name one.
     and (p_field_key is null or h.field_key = p_field_key);

  get diagnostics v_cleared = row_count;

  if v_cleared = 0 then
    -- Nothing was holding this sample. Reporting success would tell an operator
    -- that a hold they can see has been cleared when it has not -- most likely
    -- because somebody else cleared it first and the screen is stale.
    raise exception
      'BFF_NO_ACTIVE_HOLD: % has no uncleared hold%',
      coalesce(v_sample.sample_id, v_sample.id::text),
      case when p_field_key is null then '' else ' for ' || p_field_key end
      using errcode = '23514';
  end if;

  update public.samples set revision = v_sample.revision + 1 where id = p_sample_uuid;

  perform public.record_audit_event(
    p_action             => 'sample.hold_cleared',
    p_entity_type        => 'sample',
    p_entity_id          => p_sample_uuid::text,
    p_sample_uuid        => p_sample_uuid,
    p_reason             => btrim(p_reason),
    p_before             => jsonb_build_object('hold_flag', true,
                                               'disposition', v_sample.disposition),
    p_after              => jsonb_build_object('holds_cleared', v_cleared,
                                               'field_key', p_field_key),
    p_outcome            => 'succeeded',
    p_authority_basis    => v_basis,
    p_actor_id           => p_actor,
    p_deployment_version => p_app_version
  );

  -- Clearing a hold does NOT grant an acceptance: the trigger returns the
  -- decision to `undetermined`, so an authorised person still has to decide.
  perform public.mark_mutation_committed(p_idempotency_key, p_sample_uuid);

  return query
  select s.id, s.sample_id, s.revision, s.capture_state::text, s.disposition::text,
         s.hold_flag, s.updated_at
  from public.samples s where s.id = p_sample_uuid;
end;
$$;


-- ---------------------------------------------------------------------------
-- rpc_propose_specification
--
-- Call site: _shared/handlers/specification.ts:497, under `spec.propose`.
-- "Creates a DRAFT version; never approves it."
--
-- TWO THINGS THIS DOES NOT DO, both on purpose.
--
-- It does not set an acceptance limit from anything but its arguments. Rule 5
-- of the build rules: never invent a numeric acceptance limit. Both bounds may
-- be null, which is a rule that can never assess -- evaluate_measurement
-- reports `rule_has_no_bounds` -- and that is a legitimate proposal, not an
-- error to paper over with a default.
--
-- It does not create an `approved` or a `reference_only` row. reference_only
-- additionally CANNOT carry a proposer (specification_versions_reference_only_unapproved),
-- so a human proposal is structurally incapable of being one, whatever the
-- bounds are.
--
-- `effective_from` is NOT in the declared arguments and the column is NOT NULL
-- and frozen by the guard trigger, so it is set here to the proposal instant.
-- That has a consequence the caller needs to know about and it is stated in the
-- comment below rather than hidden.
-- ---------------------------------------------------------------------------

create function public.rpc_propose_specification(
  p_actor           uuid,
  p_idempotency_key text,
  p_payload_hash    text,
  p_app_version     text,
  p_parameter_key   text,
  p_stage           public.sample_stage,
  p_material        text,
  p_feed_type       text,
  p_sampling_point  text,
  p_test_method     text,
  p_unit            text,
  p_lower_bound     numeric,
  p_upper_bound     numeric,
  p_reason          text
)
returns table (
  specification_version_id uuid,
  parameter_key            text,
  stage                    public.sample_stage,
  version                  integer,
  status                   text,
  proposed_by              uuid,
  recorded_at              timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_basis   text;
  v_spec    uuid;
  v_version integer;
  v_id      uuid;
  v_now     timestamptz := now();
begin
  v_basis := public.require_permission(p_actor, 'spec.propose');
  perform public.claim_mutation(
    p_idempotency_key, 'propose_specification', p_actor, p_payload_hash
  );

  -- source_evidence is NOT NULL: "a limit with no stated source cannot be
  -- defended in an audit". p_reason is that statement, and it is the only
  -- argument that can be.
  if coalesce(btrim(p_reason), '') = '' then
    raise exception
      'BFF_REASON_REQUIRED: say what this limit is based on. A limit with no stated source cannot be defended in an audit.'
      using errcode = '22023';
  end if;

  -- The applicability filters are foreign keys. Checked by name here so the
  -- operator is told which list the value is missing from, rather than reading
  -- a raw constraint name.
  if p_material is not null and not exists (
    select 1 from public.materials m where m.code = p_material
  ) then
    raise exception 'BFF_UNKNOWN_MATERIAL: "%" is not a recorded material', p_material
      using errcode = '23503';
  end if;
  if p_feed_type is not null and not exists (
    select 1 from public.feed_types f where f.code = p_feed_type
  ) then
    raise exception 'BFF_UNKNOWN_FEED_TYPE: "%" is not a recorded feed type', p_feed_type
      using errcode = '23503';
  end if;
  if p_sampling_point is not null and not exists (
    select 1 from public.sampling_points s where s.code = p_sampling_point
  ) then
    raise exception 'BFF_UNKNOWN_SAMPLING_POINT: "%" is not a recorded sampling point',
      p_sampling_point using errcode = '23503';
  end if;

  if p_lower_bound is not null and p_upper_bound is not null
     and p_upper_bound < p_lower_bound then
    raise exception 'BFF_RANGE_INVERTED: the minimum cannot be greater than the maximum'
      using errcode = '22023';
  end if;

  -- The parameter must already be a known quality parameter. specifications is
  -- seeded from the registry's parameter keys, and minting a new one here would
  -- let a proposal invent a parameter that no column maps to -- a limit that
  -- could never apply to anything.
  select s.id into v_spec
  from public.specifications s
  where s.parameter_key = p_parameter_key;

  if v_spec is null then
    raise exception
      'BFF_UNKNOWN_PARAMETER: "%" is not a recorded quality parameter. A limit can only be proposed for a parameter a form column maps to.',
      p_parameter_key
      using errcode = '23503';
  end if;

  select coalesce(max(sv.version), 0) + 1 into v_version
  from public.specification_versions sv
  where sv.specification_id = v_spec;

  insert into public.specification_versions (
    specification_id, version, parameter_key, stage,
    material_code, feed_type_code, sampling_point, test_method,
    unit, lower_bound, upper_bound,
    status, effective_from,
    proposed_by, proposed_at,
    source_evidence
  )
  values (
    v_spec, v_version, p_parameter_key, p_stage,
    p_material, p_feed_type, p_sampling_point, p_test_method,
    p_unit, p_lower_bound, p_upper_bound,
    'draft',
    -- The proposal instant. effective_from is immutable once written, and
    -- approve-specification refuses a version whose plant-local effective date
    -- has already passed, so a draft is approvable on the plant-local DAY IT
    -- WAS PROPOSED and must be re-proposed after that. Choosing a future date
    -- here instead would make it unapprovable today, which is worse; choosing
    -- one at approval time is impossible, because the column is frozen.
    v_now,
    p_actor, v_now,
    btrim(p_reason)
  )
  returning id into v_id;

  perform public.record_audit_event(
    p_action             => 'specification.proposed',
    p_entity_type        => 'specification_version',
    p_entity_id          => v_id::text,
    p_reason             => btrim(p_reason),
    p_after              => jsonb_build_object(
                              'parameter_key', p_parameter_key,
                              'stage', p_stage,
                              'version', v_version,
                              'status', 'draft',
                              'lower_bound', p_lower_bound,
                              'upper_bound', p_upper_bound,
                              'unit', p_unit
                            ),
    p_outcome            => 'succeeded',
    p_authority_basis    => v_basis,
    p_actor_id           => p_actor,
    p_deployment_version => p_app_version
  );

  perform public.mark_mutation_committed(p_idempotency_key, null);

  return query
  select sv.id, sv.parameter_key, sv.stage, sv.version, sv.status::text,
         sv.proposed_by, v_now
  from public.specification_versions sv where sv.id = v_id;
end;
$$;


-- ---------------------------------------------------------------------------
-- rpc_submit_specification_for_review
--
-- Call site: _shared/handlers/specification.ts:594, six named arguments, under
-- `spec.propose`. Moves draft -> proposed, which is the only lifecycle move the
-- guard trigger allows from a draft besides rejection.
--
-- Submitting is NOT approving and carries no part of the two-person rule: the
-- proposer submits their own draft, and a DIFFERENT person approves it. That
-- separation lives in rpc_approve_specification.
-- ---------------------------------------------------------------------------

create function public.rpc_submit_specification_for_review(
  p_actor                    uuid,
  p_idempotency_key          text,
  p_payload_hash             text,
  p_app_version              text,
  p_specification_version_id uuid,
  p_reason                   text
)
returns table (
  specification_version_id uuid,
  parameter_key            text,
  stage                    public.sample_stage,
  version                  integer,
  status                   text,
  proposed_by              uuid,
  recorded_at              timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_basis   text;
  v_version public.specification_versions;
  v_now     timestamptz := now();
begin
  v_basis := public.require_permission(p_actor, 'spec.propose');
  perform public.claim_mutation(
    p_idempotency_key, 'submit_specification_for_review', p_actor, p_payload_hash
  );

  if coalesce(btrim(p_reason), '') = '' then
    raise exception
      'BFF_REASON_REQUIRED: say what this limit is based on before sending it for approval.'
      using errcode = '22023';
  end if;

  select * into v_version
  from public.specification_versions
  where id = p_specification_version_id
  for update;

  if v_version.id is null then
    raise exception 'BFF_UNKNOWN_SPECIFICATION: no specification version %',
      p_specification_version_id using errcode = '23503';
  end if;

  if v_version.status = 'reference_only' then
    raise exception
      'BFF_REFERENCE_ONLY: this row was imported from the workbook Limits tab for reference and cannot enter the approval flow. Propose a rule of your own instead.'
      using errcode = '23514';
  end if;

  if v_version.status <> 'draft' then
    raise exception
      'BFF_NOT_DRAFT: specification %.% is %; only a draft can be sent for review',
      v_version.parameter_key, v_version.version, v_version.status
      using errcode = '23514';
  end if;

  update public.specification_versions
     set status = 'proposed',
         -- proposal_pair keeps these two together. A draft created through
         -- rpc_propose_specification already carries them; a draft written by
         -- any other route may not, and the submitter is the proposer of record.
         proposed_by = coalesce(v_version.proposed_by, p_actor),
         proposed_at = coalesce(v_version.proposed_at, v_now)
   where id = p_specification_version_id;

  perform public.record_audit_event(
    p_action             => 'specification.submitted_for_review',
    p_entity_type        => 'specification_version',
    p_entity_id          => p_specification_version_id::text,
    p_reason             => btrim(p_reason),
    p_before             => jsonb_build_object('status', v_version.status),
    p_after              => jsonb_build_object('status', 'proposed'),
    p_outcome            => 'succeeded',
    p_authority_basis    => v_basis,
    p_actor_id           => p_actor,
    p_deployment_version => p_app_version
  );

  perform public.mark_mutation_committed(p_idempotency_key, null);

  return query
  select sv.id, sv.parameter_key, sv.stage, sv.version, sv.status::text,
         sv.proposed_by, v_now
  from public.specification_versions sv where sv.id = p_specification_version_id;
end;
$$;


-- ---------------------------------------------------------------------------
-- The administration guard.
--
-- Shared by every admin RPC below. The self-target refusal is here rather than
-- repeated five times, so it cannot be present in four of them.
-- ---------------------------------------------------------------------------

create function public.assert_administers_other(
  p_actor       uuid,
  p_target_user uuid
)
returns void
language plpgsql
stable
set search_path = ''
as $$
begin
  if p_target_user is null then
    raise exception 'BFF_TARGET_REQUIRED: the account being administered must be named'
      using errcode = '22023';
  end if;

  if p_actor = p_target_user then
    -- This is the self-approval, the self-reinstatement and the
    -- self-elevation, all at once. `user.manage` and `user.approve_access`
    -- belong to the administrator, who holds no quality authority; a
    -- self-targeted call is how that would be turned into some.
    raise exception
      'BFF_SELF_ADMINISTRATION: an account cannot be administered by its own holder. Another administrator must do it.'
      using errcode = '42501';
  end if;

  if not exists (select 1 from public.profiles p where p.id = p_target_user) then
    raise exception 'BFF_UNKNOWN_USER: no account %', p_target_user using errcode = '23503';
  end if;
end;
$$;


-- ---------------------------------------------------------------------------
-- rpc_approve_account
--
-- Call site: _shared/handlers/admin.ts:422, under `user.approve_access`.
-- "Roles granted at approval. May be empty: approval is not a role grant."
--
-- profiles_active_requires_approval demands that an active account carry
-- evidence of HOW it was let in, and profiles_no_self_approval that the
-- approver is not the account itself. Both are satisfied by recording the
-- approver and the basis, which is also what makes the pending gate auditable
-- rather than cosmetic.
-- ---------------------------------------------------------------------------

create function public.rpc_approve_account(
  p_actor           uuid,
  p_idempotency_key text,
  p_payload_hash    text,
  p_app_version     text,
  p_target_user     uuid,
  p_reason          text,
  p_roles           text[] default '{}'::text[]
)
returns table (
  target_user uuid,
  status      text,
  roles       text[],
  recorded_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_basis   text;
  v_before  public.user_status;
  v_failure text;
  v_role    text;
  v_now     timestamptz := now();
begin
  v_basis := public.require_permission(p_actor, 'user.approve_access');
  perform public.claim_mutation(p_idempotency_key, 'approve_account', p_actor, p_payload_hash);
  perform public.assert_administers_other(p_actor, p_target_user);

  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'BFF_REASON_REQUIRED: record why this account is being approved'
      using errcode = '22023';
  end if;

  -- The same predicate the client uses, asked server side, so the refusal is
  -- explicable and not a bare constraint violation.
  v_failure := public.separation_of_duties_failure(
    'approve_access', p_actor, p_target_user, null
  );
  if v_failure is not null then
    raise exception 'BFF_SEPARATION_OF_DUTIES: %', v_failure using errcode = '42501';
  end if;

  select p.status into v_before from public.profiles p where p.id = p_target_user;

  update public.profiles p
     set status         = 'active',
         approval_basis = 'approved_by_administrator',
         approved_by    = p_actor,
         approved_at    = v_now
   where p.id = p_target_user;

  -- Roles are REPLACED by the list, including the empty list: "approval is not
  -- a role grant", so approving with no roles leaves an active account that can
  -- do nothing but view, which is a real and intended outcome.
  delete from public.user_roles ur
  where ur.user_id = p_target_user
    and not (ur.role::text = any (coalesce(p_roles, '{}'::text[])));

  foreach v_role in array coalesce(p_roles, '{}'::text[])
  loop
    if not exists (
      select 1 from unnest(enum_range(null::public.app_role)) as e(v)
      where e.v::text = v_role
    ) then
      raise exception 'BFF_UNKNOWN_ROLE: "%" is not a role', v_role using errcode = '22023';
    end if;

    insert into public.user_roles (user_id, role, granted_by, reason)
    values (p_target_user, v_role::public.app_role, p_actor, btrim(p_reason))
    on conflict (user_id, role) do nothing;
  end loop;

  perform public.record_audit_event(
    p_action             => 'account.approved',
    p_entity_type        => 'profile',
    p_entity_id          => p_target_user::text,
    p_reason             => btrim(p_reason),
    p_before             => jsonb_build_object('status', v_before),
    p_after              => jsonb_build_object('status', 'active', 'roles', p_roles),
    p_outcome            => 'succeeded',
    p_authority_basis    => v_basis,
    p_actor_id           => p_actor,
    p_deployment_version => p_app_version
  );

  perform public.mark_mutation_committed(p_idempotency_key, null);

  return query
  select p.id, p.status::text,
         coalesce((select array_agg(ur.role::text order by ur.role)
                     from public.user_roles ur where ur.user_id = p.id), '{}'::text[]),
         v_now
  from public.profiles p where p.id = p_target_user;
end;
$$;


-- ---------------------------------------------------------------------------
-- rpc_set_user_status
--
-- Call site: _shared/handlers/admin.ts:436 and :459, under `user.manage`.
--
-- Moving an account TO active through this path is refused. An active account
-- must carry approval evidence (profiles_active_requires_approval), and
-- `user.manage` is not `user.approve_access`: letting a status change grant
-- access would make the approval permission optional. Reinstatement goes
-- through rpc_approve_account, which records who approved it.
-- ---------------------------------------------------------------------------

create function public.rpc_set_user_status(
  p_actor           uuid,
  p_idempotency_key text,
  p_payload_hash    text,
  p_app_version     text,
  p_target_user     uuid,
  p_status          text,
  p_reason          text
)
returns table (
  target_user uuid,
  status      text,
  roles       text[],
  recorded_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_basis  text;
  v_before public.user_status;
  v_now    timestamptz := now();
begin
  v_basis := public.require_permission(p_actor, 'user.manage');
  perform public.claim_mutation(p_idempotency_key, 'set_user_status', p_actor, p_payload_hash);
  perform public.assert_administers_other(p_actor, p_target_user);

  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'BFF_REASON_REQUIRED: record why this account is changing status'
      using errcode = '22023';
  end if;

  if not exists (
    select 1 from unnest(enum_range(null::public.user_status)) as e(v)
    where e.v::text = p_status
  ) then
    raise exception 'BFF_UNKNOWN_STATUS: "%" is not an account status', p_status
      using errcode = '22023';
  end if;

  if p_status = 'active' then
    raise exception
      'BFF_USE_APPROVAL: an account is made active by approving it, which records who approved it and on what basis. Use the approve-access action.'
      using errcode = '42501';
  end if;

  select p.status into v_before from public.profiles p where p.id = p_target_user;

  -- The approval evidence is NOT cleared. It is the record of how the account
  -- was let in and stays true after it is suspended; a later approval
  -- overwrites it with its own.
  update public.profiles p
     set status = p_status::public.user_status
   where p.id = p_target_user;

  perform public.record_audit_event(
    p_action             => 'account.status_changed',
    p_entity_type        => 'profile',
    p_entity_id          => p_target_user::text,
    p_reason             => btrim(p_reason),
    p_before             => jsonb_build_object('status', v_before),
    p_after              => jsonb_build_object('status', p_status),
    p_outcome            => 'succeeded',
    p_authority_basis    => v_basis,
    p_actor_id           => p_actor,
    p_deployment_version => p_app_version
  );

  perform public.mark_mutation_committed(p_idempotency_key, null);

  return query
  select p.id, p.status::text,
         coalesce((select array_agg(ur.role::text order by ur.role)
                     from public.user_roles ur where ur.user_id = p.id), '{}'::text[]),
         v_now
  from public.profiles p where p.id = p_target_user;
end;
$$;


-- ---------------------------------------------------------------------------
-- rpc_set_user_roles
--
-- Call site: _shared/handlers/admin.ts:472, under `user.manage`.
--
-- DECLARATIVE: "the account's roles become EXACTLY this list ... an EMPTY list
-- is a valid instruction meaning 'hold no roles'". Replacing rather than
-- adding is what makes two concurrent administrators converge on a state
-- instead of on whichever order they happened to arrive in.
-- ---------------------------------------------------------------------------

create function public.rpc_set_user_roles(
  p_actor           uuid,
  p_idempotency_key text,
  p_payload_hash    text,
  p_app_version     text,
  p_target_user     uuid,
  p_roles           text[],
  p_reason          text
)
returns table (
  target_user uuid,
  status      text,
  roles       text[],
  recorded_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_basis  text;
  v_before text[];
  v_role   text;
  v_now    timestamptz := now();
begin
  v_basis := public.require_permission(p_actor, 'user.manage');
  perform public.claim_mutation(p_idempotency_key, 'set_user_roles', p_actor, p_payload_hash);
  perform public.assert_administers_other(p_actor, p_target_user);

  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'BFF_REASON_REQUIRED: record why these roles are changing'
      using errcode = '22023';
  end if;

  foreach v_role in array coalesce(p_roles, '{}'::text[])
  loop
    if not exists (
      select 1 from unnest(enum_range(null::public.app_role)) as e(v)
      where e.v::text = v_role
    ) then
      raise exception 'BFF_UNKNOWN_ROLE: "%" is not a role', v_role using errcode = '22023';
    end if;
  end loop;

  select coalesce(array_agg(ur.role::text order by ur.role), '{}'::text[]) into v_before
  from public.user_roles ur where ur.user_id = p_target_user;

  delete from public.user_roles ur
  where ur.user_id = p_target_user
    and not (ur.role::text = any (coalesce(p_roles, '{}'::text[])));

  foreach v_role in array coalesce(p_roles, '{}'::text[])
  loop
    insert into public.user_roles (user_id, role, granted_by, reason)
    values (p_target_user, v_role::public.app_role, p_actor, btrim(p_reason))
    on conflict (user_id, role) do nothing;
  end loop;

  perform public.record_audit_event(
    p_action             => 'account.roles_set',
    p_entity_type        => 'profile',
    p_entity_id          => p_target_user::text,
    p_reason             => btrim(p_reason),
    p_before             => jsonb_build_object('roles', v_before),
    p_after              => jsonb_build_object('roles', coalesce(p_roles, '{}'::text[])),
    p_outcome            => 'succeeded',
    p_authority_basis    => v_basis,
    p_actor_id           => p_actor,
    p_deployment_version => p_app_version
  );

  perform public.mark_mutation_committed(p_idempotency_key, null);

  return query
  select p.id, p.status::text,
         coalesce((select array_agg(ur.role::text order by ur.role)
                     from public.user_roles ur where ur.user_id = p.id), '{}'::text[]),
         v_now
  from public.profiles p where p.id = p_target_user;
end;
$$;


-- ---------------------------------------------------------------------------
-- rpc_upsert_controlled_value
--
-- Call site: _shared/handlers/admin.ts:207, under `user.manage`.
--
-- "An entry is RETIRED rather than deleted: records already referencing it must
-- keep resolving, so deactivation only removes it from future selection." There
-- is therefore no delete path at all, and `p_active = null` means leave it as it
-- is, so a call that only changes a label cannot silently reactivate a retired
-- entry.
--
-- materials, feed_types and suppliers carry a `code = lower(btrim(code))`
-- constraint; sampling_points and mill_screen_sizes do not, because their codes
-- are 'AM'/'BC' and '5'/'7'. The value is normalised for the first three and
-- the RESULT reports what was actually stored, so a caller that sent 'Corn'
-- learns the entry is 'corn' rather than being silently disagreed with.
-- ---------------------------------------------------------------------------


create function public.rpc_upsert_controlled_value(
  p_actor           uuid,
  p_idempotency_key text,
  p_payload_hash    text,
  p_app_version     text,
  p_list_key        text,
  p_value           text,
  p_label           text,
  p_active          boolean,
  p_reason          text
)
returns table (
  list_key    text,
  value       text,
  label       text,
  active      boolean,
  recorded_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_basis  text;
  v_code   text;
  v_label  text;
  v_active boolean;
  v_now    timestamptz := now();
begin
  v_basis := public.require_permission(p_actor, 'user.manage');
  perform public.claim_mutation(
    p_idempotency_key, 'upsert_controlled_value', p_actor, p_payload_hash
  );

  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'BFF_REASON_REQUIRED: record why this list entry is changing'
      using errcode = '22023';
  end if;

  if coalesce(btrim(p_value), '') = '' then
    raise exception 'BFF_VALUE_REQUIRED: a list entry needs a value' using errcode = '22023';
  end if;

  -- Five static branches rather than one dynamic statement. This function is
  -- SECURITY DEFINER, so a table name assembled from an argument and run
  -- through EXECUTE would be privileged dynamic SQL built from caller input --
  -- avoidable here, and so avoided. An unrecognised list is refused, which also
  -- makes p_list_key a controlled vocabulary in its own right.
  --
  -- The label defaults to the value for a NEW entry: every one of these tables
  -- has `label not null` with a non-empty check, and inventing a prettier label
  -- would be inventing data. Leaving p_label null on an EXISTING entry keeps the
  -- label it has.
  if p_list_key = 'materials' then
    v_code := lower(btrim(p_value));
    insert into public.materials (code, label, active)
    values (v_code, coalesce(nullif(btrim(coalesce(p_label, '')), ''), v_code),
            coalesce(p_active, true))
    on conflict (code) do update
      set label  = coalesce(nullif(btrim(coalesce(p_label, '')), ''), public.materials.label),
          active = coalesce(p_active, public.materials.active)
    returning public.materials.code, public.materials.label, public.materials.active
      into v_code, v_label, v_active;

  elsif p_list_key = 'feed_types' then
    v_code := lower(btrim(p_value));
    insert into public.feed_types (code, label, active)
    values (v_code, coalesce(nullif(btrim(coalesce(p_label, '')), ''), v_code),
            coalesce(p_active, true))
    on conflict (code) do update
      set label  = coalesce(nullif(btrim(coalesce(p_label, '')), ''), public.feed_types.label),
          active = coalesce(p_active, public.feed_types.active)
    returning public.feed_types.code, public.feed_types.label, public.feed_types.active
      into v_code, v_label, v_active;

  elsif p_list_key = 'suppliers' then
    v_code := lower(btrim(p_value));
    insert into public.suppliers (code, label, active)
    values (v_code, coalesce(nullif(btrim(coalesce(p_label, '')), ''), btrim(p_value)),
            coalesce(p_active, true))
    on conflict (code) do update
      set label  = coalesce(nullif(btrim(coalesce(p_label, '')), ''), public.suppliers.label),
          active = coalesce(p_active, public.suppliers.active)
    returning public.suppliers.code, public.suppliers.label, public.suppliers.active
      into v_code, v_label, v_active;

  elsif p_list_key = 'sampling_points' then
    -- NOT lower-cased: the codes are 'AM' and 'BC', they drive the sample-ID
    -- prefix, and this table deliberately carries no lower-case constraint.
    v_code := btrim(p_value);
    insert into public.sampling_points (code, label, active)
    values (v_code, coalesce(nullif(btrim(coalesce(p_label, '')), ''), v_code),
            coalesce(p_active, true))
    on conflict (code) do update
      set label  = coalesce(nullif(btrim(coalesce(p_label, '')), ''), public.sampling_points.label),
          active = coalesce(p_active, public.sampling_points.active)
    returning public.sampling_points.code, public.sampling_points.label,
              public.sampling_points.active
      into v_code, v_label, v_active;

  elsif p_list_key = 'mill_screen_sizes' then
    v_code := btrim(p_value);
    insert into public.mill_screen_sizes (code, label, active)
    values (v_code, coalesce(nullif(btrim(coalesce(p_label, '')), ''), v_code),
            coalesce(p_active, true))
    on conflict (code) do update
      set label  = coalesce(nullif(btrim(coalesce(p_label, '')), ''),
                            public.mill_screen_sizes.label),
          active = coalesce(p_active, public.mill_screen_sizes.active)
    returning public.mill_screen_sizes.code, public.mill_screen_sizes.label,
              public.mill_screen_sizes.active
      into v_code, v_label, v_active;

  else
    raise exception
      'BFF_UNKNOWN_LIST: "%" is not a controlled vocabulary. The lists are materials, feed_types, suppliers, sampling_points and mill_screen_sizes.',
      p_list_key
      using errcode = '22023';
  end if;

  perform public.record_audit_event(
    p_action             => 'controlled_value.upserted',
    p_entity_type        => 'controlled_value',
    p_entity_id          => p_list_key || ':' || v_code,
    p_reason             => btrim(p_reason),
    p_after              => jsonb_build_object(
                              'list_key', p_list_key,
                              'value', v_code,
                              'label', v_label,
                              'active', v_active,
                              -- Recorded when the stored code differs from what
                              -- was sent, so the normalisation is visible in the
                              -- trail and not only in the reply.
                              'submitted_value', p_value
                            ),
    p_outcome            => 'succeeded',
    p_authority_basis    => v_basis,
    p_actor_id           => p_actor,
    p_deployment_version => p_app_version
  );

  perform public.mark_mutation_committed(p_idempotency_key, null);

  return query select p_list_key, v_code, v_label, v_active, v_now;
end;
$$;


-- ---------------------------------------------------------------------------
-- rpc_grant_delegation
--
-- Call site: _shared/handlers/admin.ts:348, under `user.manage`.
--
-- "`p_granted_by` is deliberately absent: the grantor is `p_actor`, from the
-- verified token, so a body cannot nominate somebody else as the authority
-- behind a delegation."
--
-- The three refusals mirror delegationGrantRefusal() in
-- supabase/functions/_shared/actions.ts exactly, and the FIRST one is the
-- important one:
--
--   * `disposition.override_release` CANNOT be delegated through this API at
--     all. It is held by no role as a base grant, so whoever may create that
--     delegation is not stated anywhere in the permission matrix -- and "the
--     honest answer to an unspecified authority question is to refuse". Letting
--     `user.manage` do it would mean an administrator, who holds no quality
--     authority whatsoever, could mint release authority and hand it to
--     somebody: the "an Administrator is not automatically a quality-release
--     approver" rule read backwards. The first such delegation is recorded by
--     the database custodian, directly, where it is visible.
--   * No self-delegation. user_delegations_no_self_grant also refuses it, but a
--     named error says why.
--   * The grantor must already HOLD what they are handing over, so
--     `user.manage` alone never widens the quality surface.
-- ---------------------------------------------------------------------------

create function public.rpc_grant_delegation(
  p_actor           uuid,
  p_idempotency_key text,
  p_payload_hash    text,
  p_app_version     text,
  p_target_user     uuid,
  p_permission      text,
  p_effective_from  timestamptz,
  p_effective_to    timestamptz,
  p_reason          text
)
returns table (
  delegation_id  uuid,
  target_user    uuid,
  permission     text,
  effective_from timestamptz,
  effective_to   timestamptz,
  recorded_at    timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_basis      text;
  v_permission public.app_permission;
  v_id         uuid;
  v_now        timestamptz := now();
begin
  v_basis := public.require_permission(p_actor, 'user.manage');
  perform public.claim_mutation(p_idempotency_key, 'grant_delegation', p_actor, p_payload_hash);
  perform public.assert_administers_other(p_actor, p_target_user);

  if coalesce(btrim(p_reason), '') = '' then
    raise exception
      'BFF_REASON_REQUIRED: record why this authority is being delegated. A delegation with no stated ground cannot be defended in an audit.'
      using errcode = '22023';
  end if;

  if not exists (
    select 1 from unnest(enum_range(null::public.app_permission)) as e(v)
    where e.v::text = p_permission
  ) then
    raise exception 'BFF_UNKNOWN_PERMISSION: "%" is not a permission', p_permission
      using errcode = '22023';
  end if;

  v_permission := p_permission::public.app_permission;

  if v_permission = any (public.delegation_only_permissions()) then
    raise exception
      'BFF_NOT_DELEGATABLE: permission_not_delegatable_through_api -- % is held by no role as a base grant, so who may delegate it is not stated in the permission matrix. An administrator holds no quality authority and must not be able to mint release authority. The first such delegation is recorded directly by the database custodian.',
      p_permission
      using errcode = '42501';
  end if;

  -- An actor cannot delegate authority they do not have.
  if not public.actor_has_permission(p_actor, v_permission) then
    raise exception
      'BFF_GRANTOR_LACKS_PERMISSION: grantor_does_not_hold_permission -- you cannot delegate % because you do not hold it.',
      p_permission
      using errcode = '42501';
  end if;

  if p_effective_to is not null and p_effective_to <= coalesce(p_effective_from, v_now) then
    raise exception 'BFF_WINDOW_INVERTED: the end of the delegation must be after its start'
      using errcode = '22023';
  end if;

  insert into public.user_delegations (
    user_id, permission, granted_by, effective_from, effective_to, reason, authority_basis
  )
  values (
    p_target_user, v_permission, p_actor,
    coalesce(p_effective_from, v_now), p_effective_to,
    btrim(p_reason), v_basis
  )
  returning id into v_id;

  perform public.record_audit_event(
    p_action             => 'delegation.granted',
    p_entity_type        => 'delegation',
    p_entity_id          => v_id::text,
    p_reason             => btrim(p_reason),
    p_after              => jsonb_build_object(
                              'delegation_id', v_id,
                              'target_user', p_target_user,
                              'permission', p_permission,
                              'effective_from', coalesce(p_effective_from, v_now),
                              'effective_to', p_effective_to
                            ),
    p_outcome            => 'succeeded',
    p_authority_basis    => v_basis,
    p_actor_id           => p_actor,
    p_deployment_version => p_app_version
  );

  perform public.mark_mutation_committed(p_idempotency_key, null);

  return query
  select d.id, d.user_id, d.permission::text, d.effective_from, d.effective_to, v_now
  from public.user_delegations d where d.id = v_id;
end;
$$;


-- ---------------------------------------------------------------------------
-- rpc_revoke_delegation
--
-- Call site: _shared/handlers/admin.ts:251, under `user.manage`.
--
-- A delegation is REVOKED, never deleted: user_delegations_revocation_complete
-- and user_delegations_revoke_reason keep the row and its reason, so a decision
-- taken while the delegation was live stays explicable afterwards. Revoking an
-- already-revoked delegation is refused rather than reported as done, because
-- the operator's screen is then stale and they need to know.
-- ---------------------------------------------------------------------------

create function public.rpc_revoke_delegation(
  p_actor           uuid,
  p_idempotency_key text,
  p_payload_hash    text,
  p_app_version     text,
  p_delegation_id   uuid,
  p_reason          text
)
returns table (
  delegation_id  uuid,
  target_user    uuid,
  permission     text,
  effective_from timestamptz,
  effective_to   timestamptz,
  recorded_at    timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_basis      text;
  v_delegation public.user_delegations;
  v_now        timestamptz := now();
begin
  v_basis := public.require_permission(p_actor, 'user.manage');
  perform public.claim_mutation(p_idempotency_key, 'revoke_delegation', p_actor, p_payload_hash);

  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'BFF_REASON_REQUIRED: record why this delegation is being revoked'
      using errcode = '22023';
  end if;

  select * into v_delegation
  from public.user_delegations
  where id = p_delegation_id
  for update;

  if v_delegation.id is null then
    raise exception 'BFF_UNKNOWN_DELEGATION: no delegation %', p_delegation_id
      using errcode = '23503';
  end if;

  if v_delegation.revoked_at is not null then
    raise exception
      'BFF_ALREADY_REVOKED: that delegation was revoked at %', v_delegation.revoked_at
      using errcode = '23514';
  end if;

  -- Revoking your OWN delegation is allowed, and is the one administration
  -- action that may be self-targeted: giving up authority is the safe
  -- direction, and refusing it would leave somebody unable to hand back a
  -- permission they no longer want.
  update public.user_delegations
     set revoked_by    = p_actor,
         revoked_at    = v_now,
         revoke_reason = btrim(p_reason)
   where id = p_delegation_id;

  perform public.record_audit_event(
    p_action             => 'delegation.revoked',
    p_entity_type        => 'delegation',
    p_entity_id          => p_delegation_id::text,
    p_reason             => btrim(p_reason),
    p_before             => jsonb_build_object(
                              'target_user', v_delegation.user_id,
                              'permission', v_delegation.permission,
                              'effective_to', v_delegation.effective_to
                            ),
    p_after              => jsonb_build_object('revoked_at', v_now),
    p_outcome            => 'succeeded',
    p_authority_basis    => v_basis,
    p_actor_id           => p_actor,
    p_deployment_version => p_app_version
  );

  perform public.mark_mutation_committed(p_idempotency_key, null);

  return query
  select d.id, d.user_id, d.permission::text, d.effective_from, d.effective_to, v_now
  from public.user_delegations d where d.id = p_delegation_id;
end;
$$;


-- ---------------------------------------------------------------------------
-- rpc_retry_dead_lettered -- DELIBERATELY NOT REDEFINED HERE.
--
-- An earlier draft of this migration replaced the 0014 definition with
-- (p_actor, p_reason, p_limit) returning (requeued, remaining), because an
-- intermediate version of supabase/functions/_shared/rpc.ts declared
-- RetryDeadLetteredArgs that way while nothing called it. The contract has
-- since settled on the signature 0014 derived -- `rpc_retry_dead_lettered(p_actor,
-- p_app_version, p_sample_uuid default null)` returning a bare integer -- and
-- sync-action/index.ts now calls it with exactly those names and reads the
-- count with `callTransaction<number>`.
--
-- So 0014 stands and this file changes nothing about it. The replacement was
-- removed rather than kept as a second overload: two signatures for one name,
-- one of which nothing calls, is how a caller ends up bound to the dead one.
-- The same reasoning applies to rpc_requeue_outbox_event, whose declared
-- RequeueOutboxArgs is (p_sample_uuid, p_owner, p_fence, p_reason) -- the
-- fenced, worker-facing form 0014 defines, and the only form with a caller.
-- ---------------------------------------------------------------------------


-- ---------------------------------------------------------------------------
-- Privileges. Per signature, from anon and authenticated as well as PUBLIC: a
-- revoke only deletes a grant that was RECORDED, and Supabase's default
-- privileges record EXECUTE for anon and authenticated on every new function in
-- `public`, which `revoke ... from public` does not remove. Never collapse
-- these to the `from public` form -- that is the inert revoke 0009 corrects.
--
-- `authenticated` gets none of them. These are the administration and quality
-- RPCs: a client able to call rpc_set_user_roles or rpc_grant_delegation
-- directly would be able to grant itself any role in the system.
-- ---------------------------------------------------------------------------

revoke all on function public.rpc_record_audit_failure(
  uuid, text, text, text, text, text, jsonb, jsonb, text, text, text
) from public, anon, authenticated;
grant execute on function public.rpc_record_audit_failure(
  uuid, text, text, text, text, text, jsonb, jsonb, text, text, text
) to service_role;

revoke all on function public.rpc_retry_audit_dead_letters(integer)
  from public, anon, authenticated;
grant execute on function public.rpc_retry_audit_dead_letters(integer) to service_role;

revoke all on function public.rpc_health_snapshot() from public, anon, authenticated;
grant execute on function public.rpc_health_snapshot() to service_role;

revoke all on function public.rpc_raise_hold(uuid, text, text, text, uuid, integer, text, text)
  from public, anon, authenticated;
grant execute on function public.rpc_raise_hold(uuid, text, text, text, uuid, integer, text, text)
  to service_role;

revoke all on function public.rpc_clear_hold(uuid, text, text, text, uuid, integer, text, text)
  from public, anon, authenticated;
grant execute on function public.rpc_clear_hold(uuid, text, text, text, uuid, integer, text, text)
  to service_role;

revoke all on function public.rpc_propose_specification(
  uuid, text, text, text, text, public.sample_stage, text, text, text, text, text,
  numeric, numeric, text
) from public, anon, authenticated;
grant execute on function public.rpc_propose_specification(
  uuid, text, text, text, text, public.sample_stage, text, text, text, text, text,
  numeric, numeric, text
) to service_role;

revoke all on function public.rpc_submit_specification_for_review(
  uuid, text, text, text, uuid, text
) from public, anon, authenticated;
grant execute on function public.rpc_submit_specification_for_review(
  uuid, text, text, text, uuid, text
) to service_role;

revoke all on function public.assert_administers_other(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.assert_administers_other(uuid, uuid) to service_role;

revoke all on function public.rpc_approve_account(uuid, text, text, text, uuid, text, text[])
  from public, anon, authenticated;
grant execute on function public.rpc_approve_account(uuid, text, text, text, uuid, text, text[])
  to service_role;

revoke all on function public.rpc_set_user_status(uuid, text, text, text, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.rpc_set_user_status(uuid, text, text, text, uuid, text, text)
  to service_role;

revoke all on function public.rpc_set_user_roles(uuid, text, text, text, uuid, text[], text)
  from public, anon, authenticated;
grant execute on function public.rpc_set_user_roles(uuid, text, text, text, uuid, text[], text)
  to service_role;

revoke all on function public.rpc_upsert_controlled_value(
  uuid, text, text, text, text, text, text, boolean, text
) from public, anon, authenticated;
grant execute on function public.rpc_upsert_controlled_value(
  uuid, text, text, text, text, text, text, boolean, text
) to service_role;

revoke all on function public.rpc_grant_delegation(
  uuid, text, text, text, uuid, text, timestamptz, timestamptz, text
) from public, anon, authenticated;
grant execute on function public.rpc_grant_delegation(
  uuid, text, text, text, uuid, text, timestamptz, timestamptz, text
) to service_role;

revoke all on function public.rpc_revoke_delegation(uuid, text, text, text, uuid, text)
  from public, anon, authenticated;
grant execute on function public.rpc_revoke_delegation(uuid, text, text, text, uuid, text)
  to service_role;

select public.assert_function_privileges();
