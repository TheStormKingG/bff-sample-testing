-- ===========================================================================
-- 0045 — a scoped limit can be proposed, and two differently-scoped limits
--        can both be approved.
--
-- ---------------------------------------------------------------------------
-- WHAT 0044 LEFT HALF-DONE
-- ---------------------------------------------------------------------------
-- 0044 gave the engine a fifth applicability dimension, `grind_purpose`, so
-- that "corn for pelletized feed" and "rice for mashed feed" could carry
-- different grind targets. The engine matches on it, the browser scores it,
-- and a rolled-back probe proved a corn sample picks the corn rule.
--
-- None of which could ever be used, because of two things nobody looked at:
--
--  1. `rpc_propose_specification` has no `p_grind_purpose` argument. It is the
--     ONLY write path to a proposal — the column is immutable once written,
--     so a rule that is not scoped at the moment it is created can never be
--     scoped afterwards. The dimension was reachable by the reader and
--     unreachable by the writer.
--
--  2. `rpc_approve_specification` supersedes EVERY other approved version of
--     the same specification, and refuses the approval outright if another
--     approved version takes effect at or after this one. Both are scoped to
--     `specification_id` alone. So approving the corn rule and then the rice
--     rule does not produce two scoped rules: it produces one rice rule and a
--     superseded corn rule. Four purpose-scoped grind targets were not merely
--     unproposable, they were unapprovable in principle.
--
-- (1) is an omission. (2) is a genuine design error, and the comment above it
-- explains why it was made: two approved versions covering one instant make
-- `evaluate_measurement` see ambiguous rules, which it reports as
-- `ambiguous_rules` and cannot assess. That reasoning is right, and the check
-- built on it is too coarse. Two rules that differ in their applicability are
-- NOT ambiguous — distinguishing them by specificity is the engine's entire
-- purpose. The check should fire on two rules with the SAME scope, which is
-- the case it was defending against, and stay quiet on two with different
-- scopes, which is the case the engine was built to handle.
--
-- ---------------------------------------------------------------------------
-- WHAT "THE SAME SCOPE" MEANS HERE
-- ---------------------------------------------------------------------------
-- All five dimensions, compared with `is not distinct from` so that two
-- unscoped rules (every dimension null) still collide with each other — that
-- is the common case and it must keep working exactly as it did.
--
-- This narrows a refusal and narrows an UPDATE. Narrowing a refusal admits
-- things that were refused before, so the probe below proves the refusal
-- still fires on same-scope overlap; narrowing an UPDATE leaves rows behind
-- that were previously superseded, so the probe also proves a same-scope
-- approval still supersedes its predecessor. Both controls, not just the new
-- behaviour: the failure mode of this change is that it supersedes nothing
-- and every parameter ends up ambiguous.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. A proposal can carry a grind purpose.
--
-- `p_grind_purpose` is APPENDED, matching how 0044 appended it to
-- `evaluate_measurement`, so the four existing applicability arguments keep
-- their positions and no caller's other arguments shift.
--
-- The 14-argument function is dropped rather than left beside the new one. An
-- overload that still accepts a proposal but silently cannot scope it is a
-- live write path with a hole in it, and `tests/rpcContract.test.ts` fails on
-- an RPC the contract does not account for.
-- ---------------------------------------------------------------------------
drop function if exists public.rpc_propose_specification(
  uuid, text, text, text, text, public.sample_stage,
  text, text, text, text, text, numeric, numeric, text
);

create or replace function public.rpc_propose_specification(
  p_actor uuid,
  p_idempotency_key text,
  p_payload_hash text,
  p_app_version text,
  p_parameter_key text,
  p_stage public.sample_stage,
  p_material text,
  p_feed_type text,
  p_sampling_point text,
  p_test_method text,
  p_unit text,
  p_lower_bound numeric,
  p_upper_bound numeric,
  p_reason text,
  p_grind_purpose text
)
returns table (
  specification_version_id uuid,
  parameter_key text,
  stage public.sample_stage,
  version integer,
  status text,
  proposed_by uuid,
  recorded_at timestamptz
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
  -- Added by 0045. Same shape as the three above, and for the same reason: a
  -- purpose that is not in the list would otherwise surface as a constraint
  -- name, and `grind_purposes` is an administrator-managed list.
  if p_grind_purpose is not null and not exists (
    select 1 from public.grind_purposes g where g.code = p_grind_purpose
  ) then
    raise exception 'BFF_UNKNOWN_GRIND_PURPOSE: "%" is not a recorded grind purpose',
      p_grind_purpose using errcode = '23503';
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
    material_code, feed_type_code, sampling_point, test_method, grind_purpose,
    unit, lower_bound, upper_bound,
    status, effective_from,
    proposed_by, proposed_at,
    source_evidence
  )
  values (
    v_spec, v_version, p_parameter_key, p_stage,
    p_material, p_feed_type, p_sampling_point, p_test_method, p_grind_purpose,
    p_unit, p_lower_bound, p_upper_bound,
    'draft',
    -- The proposal instant, and it is immutable. 0045 removes a claim that
    -- stood here: that approve-specification "refuses a version whose
    -- plant-local effective date has already passed, so a draft is approvable
    -- on the plant-local DAY IT WAS PROPOSED and must be re-proposed after
    -- that". There is no such check in rpc_approve_specification and there
    -- never was one. A draft stays approvable. The comment was describing an
    -- expiry the system does not implement, which is worse than no comment:
    -- it would have had somebody re-propose twenty-one limits for nothing.
    v_now,
    p_actor, v_now,
    btrim(p_reason)
  );

  select sv.id into v_id
  from public.specification_versions sv
  where sv.specification_id = v_spec and sv.version = v_version;

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
                              'unit', p_unit,
                              -- The scope is part of what was proposed. An
                              -- audit entry that records 1200-1300 um without
                              -- recording WHICH grind it applies to does not
                              -- describe the rule that was created.
                              'material_code', p_material,
                              'grind_purpose', p_grind_purpose
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

-- The same grant the 14-argument function carried. A SECURITY DEFINER
-- function left callable by `authenticated` is a privileged write path open to
-- every signed-in account; every write here goes through the Edge Functions,
-- which hold the service role.
revoke all on function public.rpc_propose_specification(
  uuid, text, text, text, text, public.sample_stage,
  text, text, text, text, text, numeric, numeric, text, text
) from public, anon, authenticated;
grant execute on function public.rpc_propose_specification(
  uuid, text, text, text, text, public.sample_stage,
  text, text, text, text, text, numeric, numeric, text, text
) to service_role;


-- ---------------------------------------------------------------------------
-- 2. Approval supersedes the rule it actually replaces.
--
-- `create or replace`: the signature and return type are unchanged, so this
-- is a whole-artefact rewrite of the body. The two edits are both in the
-- block that handles `p_decision = 'approve'`, and everything else below is
-- carried across verbatim from the definition this replaces.
-- ---------------------------------------------------------------------------
create or replace function public.rpc_approve_specification(
  p_actor uuid,
  p_idempotency_key text,
  p_payload_hash text,
  p_app_version text,
  p_specification_version_id uuid,
  p_decision text,
  p_reason text,
  p_override_approved_by uuid default null
)
returns table (
  specification_version_id uuid,
  parameter_key text,
  status text,
  version integer,
  effective_from timestamptz,
  approved_by uuid,
  recorded_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_basis    text;
  v_version  public.specification_versions;
  v_approver uuid;
  v_failure  text;
  v_status   public.spec_status;
  v_now      timestamptz := now();
begin
  v_basis := public.require_permission(p_actor, 'spec.approve');
  perform public.claim_mutation(
    p_idempotency_key, 'approve_specification', p_actor, p_payload_hash
  );

  if p_decision not in ('approve', 'reject') then
    raise exception
      'BFF_BAD_DECISION: a specification is approved or rejected, not %', p_decision
      using errcode = '22023';
  end if;

  if coalesce(btrim(p_reason), '') = '' then
    raise exception
      'BFF_REASON_REQUIRED: an approval or rejection of a limit must record why. A limit with no stated basis cannot be defended in an audit.'
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

  -- An imported workbook row "exists to be read, and it can never decide
  -- anything". All 34 Limits entries are reference_only, so this is the branch
  -- a well-meaning attempt to "approve the workbook" lands on, and it deserves
  -- its own message rather than a generic lifecycle refusal.
  if v_version.status = 'reference_only' then
    raise exception
      'BFF_REFERENCE_ONLY: this row was imported from the workbook Limits tab for reference and can never be approved. Propose a rule of your own, with its source evidence, and approve that.'
      using errcode = '23514';
  end if;

  if v_version.status <> 'proposed' then
    raise exception
      'BFF_NOT_PROPOSED: specification %.% is % and only a proposed version can be decided on',
      v_version.parameter_key, v_version.version, v_version.status
      using errcode = '23514';
  end if;

  if p_decision = 'approve' then
    if p_override_approved_by is not null then
      if p_override_approved_by = p_actor then
        raise exception
          'BFF_OVERRIDE_INVALID: naming yourself as the second approver is the same self-approval under another name.'
          using errcode = '42501';
      end if;
      if p_override_approved_by = v_version.proposed_by then
        raise exception
          'BFF_OVERRIDE_INVALID: the proposer of a limit cannot be recorded as its approver.'
          using errcode = '42501';
      end if;
      if not public.actor_has_permission(p_override_approved_by, 'spec.approve') then
        raise exception
          'BFF_OVERRIDE_INVALID: the person named as approver is not an active account holding spec.approve.'
          using errcode = '42501';
      end if;
    end if;

    v_approver := coalesce(p_override_approved_by, p_actor);

    v_failure := public.separation_of_duties_failure(
      'approve_specification', v_approver, v_version.proposed_by, null
    );
    if v_failure is not null then
      raise exception
        'BFF_SEPARATION_OF_DUTIES: % -- a limit must be approved by somebody other than the person who proposed it.',
        v_failure
        using errcode = '42501';
    end if;

    -- Supersede the rule this one replaces, and refuse rather than create an
    -- overlap. Two approved versions of one specification covering the same
    -- instant AND THE SAME SCOPE would make evaluate_measurement see ambiguous
    -- rules, which it reports as `ambiguous_rules` and cannot assess -- so an
    -- overlap would silently turn every future measurement of that parameter
    -- into "not assessable".
    --
    -- SCOPE, added by 0045, is the whole point of the five-dimension engine.
    -- Before this, both statements matched on specification_id alone, which
    -- made "one approved rule per parameter" a hard rule of the system and
    -- every applicability dimension decorative: approving a rice grind target
    -- superseded the corn one. Two rules that differ in any dimension are not
    -- ambiguous, and must be allowed to stand together.
    --
    -- `is not distinct from` throughout, so two FULLY UNSCOPED rules (every
    -- dimension null) still collide with each other. That is the ordinary case
    -- -- thirteen of the twenty-one limits proposed on top of this migration
    -- are unscoped -- and its behaviour is unchanged.
    if exists (
      select 1 from public.specification_versions sv
      where sv.specification_id = v_version.specification_id
        and sv.status = 'approved'
        and sv.id <> v_version.id
        and sv.material_code   is not distinct from v_version.material_code
        and sv.feed_type_code  is not distinct from v_version.feed_type_code
        and sv.sampling_point  is not distinct from v_version.sampling_point
        and sv.test_method     is not distinct from v_version.test_method
        and sv.grind_purpose   is not distinct from v_version.grind_purpose
        and sv.effective_from >= v_version.effective_from
    ) then
      raise exception
        'BFF_EFFECTIVE_OVERLAP: an approved version of % with the same scope already takes effect at or after %. Propose this rule with a later effective date.',
        v_version.parameter_key, v_version.effective_from
        using errcode = '23514';
    end if;

    update public.specification_versions sv
       set status       = 'superseded',
           effective_to = v_version.effective_from
     where sv.specification_id = v_version.specification_id
       and sv.status = 'approved'
       and sv.id <> v_version.id
       and sv.material_code   is not distinct from v_version.material_code
       and sv.feed_type_code  is not distinct from v_version.feed_type_code
       and sv.sampling_point  is not distinct from v_version.sampling_point
       and sv.test_method     is not distinct from v_version.test_method
       and sv.grind_purpose   is not distinct from v_version.grind_purpose
       and sv.effective_from < v_version.effective_from;

    update public.specification_versions
       set status          = 'approved',
           approved_by     = v_approver,
           approved_at     = v_now,
           decision_reason = btrim(p_reason)
     where id = p_specification_version_id;

    v_status := 'approved';
  else
    update public.specification_versions
       set status          = 'rejected',
           rejected_by     = p_actor,
           rejected_at     = v_now,
           decision_reason = btrim(p_reason)
     where id = p_specification_version_id;

    v_status := 'rejected';
    v_approver := null;
  end if;

  perform public.record_audit_event(
    p_action             => 'specification.' || p_decision || 'd',
    p_entity_type        => 'specification_version',
    p_entity_id          => p_specification_version_id::text,
    p_sample_uuid        => null,
    p_reason             => btrim(p_reason),
    p_before             => jsonb_build_object(
                              'status', v_version.status,
                              'proposed_by', v_version.proposed_by
                            ),
    p_after              => jsonb_build_object(
                              'status', v_status,
                              'approved_by', v_approver,
                              'parameter_key', v_version.parameter_key,
                              'version', v_version.version,
                              'effective_from', v_version.effective_from,
                              -- The scope decides which measurements this rule
                              -- reaches, so it belongs in the record of the
                              -- decision alongside the figures.
                              'material_code', v_version.material_code,
                              'grind_purpose', v_version.grind_purpose,
                              -- The rule decides measurements from its
                              -- effective date forward ONLY. Assessments
                              -- already recorded keep the rule version that
                              -- decided them.
                              'applies_prospectively_only', true
                            ),
    p_outcome            => 'succeeded',
    p_authority_basis    => v_basis,
    p_actor_id           => p_actor,
    p_deployment_version => p_app_version
  );

  perform public.mark_mutation_committed(p_idempotency_key, null);

  return query
  select sv.id, sv.parameter_key, sv.status::text, sv.version, sv.effective_from,
         sv.approved_by, v_now
  from public.specification_versions sv
  where sv.id = p_specification_version_id;
end;
$$;


-- ---------------------------------------------------------------------------
-- 3. Prove it end to end against the real database, then undo it.
--
-- This migration narrows a refusal and narrows an UPDATE. Each of those has a
-- failure mode in the opposite direction from the bug being fixed:
--
--   * narrowing the refusal too far -> two same-scope rules both approved, and
--     every measurement of that parameter becomes `ambiguous_rules` forever;
--   * narrowing the UPDATE too far  -> the old rule is never superseded, with
--     the same result.
--
-- So the probe asserts all three behaviours: that differently-scoped rules now
-- coexist (the fix), that a same-scope approval still supersedes its
-- predecessor (the UPDATE still reaches), and that a same-scope overlap is
-- still refused (the refusal still fires). A probe that only proved the fix
-- would pass just as happily with both statements deleted.
--
-- Everything is rolled back. The project records real samples; a probe that
-- committed would leave approved limits deciding real measurements.
-- ---------------------------------------------------------------------------
do $$
declare
  -- Two real accounts, because two-person approval is a CHECK constraint and
  -- cannot be probed with one. The proposer is the account that holds
  -- spec.propose without being the one approving here.
  v_proposer uuid;
  v_approver uuid;
  v_spec     uuid;
  v_maxv     integer;
  v_a        uuid;   -- corn_pelleted, approved, yesterday
  v_b        uuid;   -- rice_pelleted, approved, yesterday
  v_c        uuid;   -- corn_pelleted, proposed today
  v_e        uuid;   -- rice_pelleted, proposed today
  v_t        timestamptz := now();
  v_n        integer;
  v_status   text;
  v_purpose  text;
  v_to       timestamptz;
  v_raised   text;
  -- `idempotency_requests_hash_shape` requires 'sha256:' + 64 hex. The value
  -- is only compared against itself on a replay, so one constant across the
  -- probe's distinct keys is correct -- but it has to be a real digest, which
  -- is what the first run of this migration found out.
  v_hash     text := 'sha256:' || encode(sha256('bff0045-probe'::bytea), 'hex');
begin
  select id into v_proposer from public.profiles where email = 'stefan_gravesande@yahoo.com';
  select id into v_approver from public.profiles where email = 'stefan.gravesande@gmail.com';
  if v_proposer is null or v_approver is null or v_proposer = v_approver then
    raise notice 'BFF_0045: skipped -- needs two distinct accounts holding spec.propose/spec.approve.';
    return;
  end if;

  select id into v_spec from public.specifications where parameter_key = 'ground.avg_particle_size';
  select coalesce(max(version), 0) into v_maxv
    from public.specification_versions where specification_id = v_spec;

  begin
    -- -- Two approved rules already in force, differing ONLY in grind purpose,
    -- -- back-dated so that today's approval is entitled to supersede them.
    -- -- Inserted directly rather than through the RPCs because effective_from
    -- -- is immutable and the RPC always writes `now()`; there is no supported
    -- -- way to create a rule that took effect yesterday, which is exactly
    -- -- why this is a probe and not a fixture.
    insert into public.specification_versions (
      specification_id, version, parameter_key, stage, grind_purpose, unit,
      lower_bound, upper_bound, status, effective_from,
      proposed_by, proposed_at, approved_by, approved_at, source_evidence
    ) values
      (v_spec, v_maxv + 1, 'ground.avg_particle_size', 'ground', 'corn_pelleted', 'µm',
       1200, 1300, 'approved', v_t - interval '1 day',
       v_proposer, v_t - interval '1 day', v_approver, v_t - interval '1 day',
       'BFF_0045 probe row. Rolled back.'),
      (v_spec, v_maxv + 2, 'ground.avg_particle_size', 'ground', 'rice_pelleted', 'µm',
       950, 1050, 'approved', v_t - interval '1 day',
       v_proposer, v_t - interval '1 day', v_approver, v_t - interval '1 day',
       'BFF_0045 probe row. Rolled back.');

    select id into v_a from public.specification_versions
      where specification_id = v_spec and version = v_maxv + 1;
    select id into v_b from public.specification_versions
      where specification_id = v_spec and version = v_maxv + 2;

    -- ---------------------------------------------------------------------
    -- a. A new corn rule, proposed and approved through the real write path.
    -- ---------------------------------------------------------------------
    select specification_version_id into v_c from public.rpc_propose_specification(
      v_proposer, 'bff0045-propose-c', v_hash, '0045',
      'ground.avg_particle_size', 'ground',
      null, null, null, null, 'µm', 1210, 1290,
      'BFF_0045 probe. Rolled back.', 'corn_pelleted'
    );
    perform public.rpc_submit_specification_for_review(
      v_proposer, 'bff0045-submit-c', v_hash, '0045', v_c, 'BFF_0045 probe.'
    );
    perform public.rpc_approve_specification(
      v_approver, 'bff0045-approve-c', v_hash, '0045', v_c, 'approve', 'BFF_0045 probe.'
    );

    -- The purpose survived the round trip. If p_grind_purpose were dropped on
    -- the floor this would be null and every assertion below would still pass,
    -- because an unscoped rule collides with nothing here.
    select grind_purpose into v_purpose
      from public.specification_versions where id = v_c;
    if v_purpose is distinct from 'corn_pelleted' then
      raise exception
        'BFF_0045_PURPOSE: the proposed rule stored grind_purpose %, not corn_pelleted',
        coalesce(v_purpose, '<null>') using errcode = '22023';
    end if;

    -- THE FIX. The rice rule must still be approved. Before 0045 the UPDATE
    -- matched on specification_id alone and this row would read `superseded`,
    -- which is the whole bug: approving a corn grind target silently retired
    -- the rice one.
    select status::text into v_status from public.specification_versions where id = v_b;
    if v_status <> 'approved' then
      raise exception
        'BFF_0045_CROSS_SCOPE: approving the corn rule made the rice rule %; a rule in a different scope must be left alone',
        v_status using errcode = '22023';
    end if;

    -- THE UPDATE STILL REACHES. The previous corn rule must have been retired,
    -- and its window must close exactly where the new one opens -- otherwise
    -- there is an instant covered by two rules or by none.
    select status::text, effective_to into v_status, v_to
      from public.specification_versions where id = v_a;
    if v_status <> 'superseded' then
      raise exception
        'BFF_0045_SUPERSEDE: the previous corn rule is % -- a same-scope approval must retire it, or both decide at once',
        v_status using errcode = '22023';
    end if;
    if v_to is distinct from (select effective_from from public.specification_versions where id = v_c) then
      raise exception
        'BFF_0045_WINDOW: the retired corn rule ends at %, not where the new one begins',
        v_to using errcode = '22023';
    end if;

    -- And exactly two corn-scoped versions are involved: no stray row picked
    -- up or left behind by the narrowed statements.
    select count(*) into v_n from public.specification_versions
     where specification_id = v_spec and status = 'approved';
    if v_n <> 2 then
      raise exception
        'BFF_0045_COUNT: % approved versions of ground.avg_particle_size; expected 2 (new corn + untouched rice)',
        v_n using errcode = '22023';
    end if;

    -- ---------------------------------------------------------------------
    -- b. CONTROL: the refusal still fires on a SAME-scope overlap.
    --
    -- `now()` is the transaction start time, so this proposal's
    -- effective_from equals the approved corn rule's exactly, and `>=` holds.
    -- Nested, because the refusal rolls back to the start of its own block.
    -- ---------------------------------------------------------------------
    v_raised := null;
    begin
      declare v_d uuid;
      begin
        select specification_version_id into v_d from public.rpc_propose_specification(
          v_proposer, 'bff0045-propose-d', v_hash, '0045',
          'ground.avg_particle_size', 'ground',
          null, null, null, null, 'µm', 1215, 1285,
          'BFF_0045 probe. Rolled back.', 'corn_pelleted'
        );
        perform public.rpc_submit_specification_for_review(
          v_proposer, 'bff0045-submit-d', v_hash, '0045', v_d, 'BFF_0045 probe.'
        );
        perform public.rpc_approve_specification(
          v_approver, 'bff0045-approve-d', v_hash, '0045', v_d, 'approve', 'BFF_0045 probe.'
        );
      exception
        when others then v_raised := sqlerrm;
      end;
    end;
    if v_raised is null or position('BFF_EFFECTIVE_OVERLAP' in v_raised) = 0 then
      raise exception
        'BFF_0045_NO_REFUSAL: a second corn rule at the same instant was accepted (%) -- two same-scope rules in force make every measurement ambiguous',
        coalesce(v_raised, 'no error') using errcode = '22023';
    end if;

    -- ---------------------------------------------------------------------
    -- c. CONTROL: and stays quiet on a DIFFERENT-scope rule at the SAME
    --    instant. This is the pair to (b): together they show the refusal
    --    turns on scope and not on the clock.
    -- ---------------------------------------------------------------------
    select specification_version_id into v_e from public.rpc_propose_specification(
      v_proposer, 'bff0045-propose-e', v_hash, '0045',
      'ground.avg_particle_size', 'ground',
      null, null, null, null, 'µm', 960, 1040,
      'BFF_0045 probe. Rolled back.', 'rice_pelleted'
    );
    perform public.rpc_submit_specification_for_review(
      v_proposer, 'bff0045-submit-e', v_hash, '0045', v_e, 'BFF_0045 probe.'
    );
    perform public.rpc_approve_specification(
      v_approver, 'bff0045-approve-e', v_hash, '0045', v_e, 'approve', 'BFF_0045 probe.'
    );

    select status::text into v_status from public.specification_versions where id = v_e;
    if v_status <> 'approved' then
      raise exception
        'BFF_0045_CROSS_SCOPE_REFUSED: a rice rule at the same instant as the corn rule was refused (%)',
        v_status using errcode = '22023';
    end if;

    -- ---------------------------------------------------------------------
    -- d. CONTROL: an unknown purpose is named, not surfaced as a constraint.
    -- ---------------------------------------------------------------------
    v_raised := null;
    begin
      perform public.rpc_propose_specification(
        v_proposer, 'bff0045-propose-bad', v_hash, '0045',
        'ground.avg_particle_size', 'ground',
        null, null, null, null, 'µm', 1, 2,
        'BFF_0045 probe. Rolled back.', 'barley_pelleted'
      );
    exception
      when others then v_raised := sqlerrm;
    end;
    if v_raised is null or position('BFF_UNKNOWN_GRIND_PURPOSE' in v_raised) = 0 then
      raise exception
        'BFF_0045_BAD_PURPOSE: an unrecorded grind purpose was not rejected by name (%)',
        coalesce(v_raised, 'no error') using errcode = '22023';
    end if;

    -- Everything above is a probe. Undo it.
    raise exception 'BFF_0045_ROLLBACK';
  exception
    when others then
      if sqlerrm <> 'BFF_0045_ROLLBACK' then
        raise;
      end if;
  end;

  raise notice 'BFF_0045: end-to-end probe passed and was rolled back.';
end
$$;


-- ---------------------------------------------------------------------------
-- 4. The project is as it was: the probe left nothing behind, and nothing is
--    approved. Asserted outside the probe's block, so a rollback that only
--    half-happened is caught here rather than at the next migration.
-- ---------------------------------------------------------------------------
do $$
declare
  v_n integer;
begin
  select count(*) into v_n from public.specification_versions
   where source_evidence like 'BFF_0045 probe%';
  if v_n <> 0 then
    raise exception 'BFF_0045_RESIDUE: % probe version(s) survived the rollback', v_n
      using errcode = '22023';
  end if;

  select count(*) into v_n from public.specification_versions
   where status = 'approved' or approved_by is not null;
  if v_n <> 0 then
    raise exception
      'BFF_0045_APPROVED: % version(s) are approved; 0045 approves nothing and its probe rolls back',
      v_n using errcode = '22023';
  end if;

  -- One overload of the propose RPC, not two. A second one still accepting a
  -- proposal it cannot scope is the hole this migration exists to close.
  select count(*) into v_n
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'rpc_propose_specification';
  if v_n <> 1 then
    raise exception 'BFF_0045_OVERLOAD: % versions of rpc_propose_specification exist', v_n
      using errcode = '22023';
  end if;
end
$$;


-- ---------------------------------------------------------------------------
-- 5. The steam pressure unit is `bar`. Open decision D-05 is closed.
--
-- The workbook's `Limits` row 13 Unit cell reads "to confirm" (bar or kg/cm²
-- per its own note), and both the registry and this table have said so since
-- 0002. `assessment.ts` gates on it before rule lookup, so the reading could
-- never be assessed as conforming whatever bounds were approved — PRD §5.3,
-- R-02, UAT-07.
--
-- The Polinutri process audit of 21/10/2026 states the conditioner steam
-- pressure in bar, and Bounty Farm confirmed bar on 2026-11-03. Without this
-- row the registry would say `bar` while the database still said "no unit":
-- `tests/registryDatabaseContract.test.ts` compares the two column by column
-- and is what caught the omission, which is the only reason this section
-- exists rather than being discovered by a limit that silently never applied.
--
-- The sheet header is deliberately left as "Steam pressure reading". Row 4 is
-- diffed against the registry before every write and the Edge Functions latch
-- on a mismatch, so renaming it here without editing the live workbook in the
-- same breath would fence the system off from its own spreadsheet.
-- ---------------------------------------------------------------------------
update public.stage_fields
   set unit = 'bar', unit_confirmed = true
 where stage = 'conditioned' and field_key = 'steam_pressure_reading';

do $$
declare
  v_unit      text;
  v_ok        boolean;
  v_remaining text;
begin
  select unit, unit_confirmed into v_unit, v_ok
    from public.stage_fields
   where stage = 'conditioned' and field_key = 'steam_pressure_reading';

  if v_unit is distinct from 'bar' or v_ok is not true then
    raise exception
      'BFF_0045_UNIT: conditioned.steam_pressure_reading reads unit %, confirmed % -- expected bar/true',
      coalesce(v_unit, '<null>'), coalesce(v_ok::text, '<null>')
      using errcode = '22023';
  end if;

  -- And nothing else moved. The browser's unit gate is a real control, and
  -- confirming one field's unit must not leave it with nothing to act on --
  -- `raw_materials.other_mycotoxin_result` has no agreed unit by design,
  -- because the source workbook defines none for that column. If this ever
  -- reads anything else, either the update above was wider than one row or
  -- the registry and this table have drifted again.
  select string_agg(stage::text || '.' || field_key, ', ' order by stage::text, field_key)
    into v_remaining
    from public.stage_fields
   where unit_confirmed is false;

  if v_remaining is distinct from 'raw_materials.other_mycotoxin_result' then
    raise exception
      'BFF_0045_UNIT_SWEEP: fields with no confirmed unit are now [%]; expected raw_materials.other_mycotoxin_result alone',
      coalesce(v_remaining, '<none>') using errcode = '22023';
  end if;
end
$$;
