-- ===========================================================================
-- 0040 — approving a limit re-judges the records it applies to.
--
-- ---------------------------------------------------------------------------
-- THE DEFECT
-- ---------------------------------------------------------------------------
-- `apply_measurement` evaluates a value at the moment it is recorded and
-- stores the verdict on `sample_measurements`, with an append-only copy in
-- `assessments`. `rpc_approve_specification` approves a rule and stops.
--
-- Nothing connects the two. So the stored verdict on every measurement is
-- the verdict that applied WHEN IT WAS TYPED, for ever. Today that is
-- harmless only because nothing is approved: all 398 rows read
-- `not_assessable`, which is true. The first approval breaks it — every
-- historical record keeps saying `not_assessable` while the screens, which
-- re-evaluate live in the browser, say something else. The database and the
-- screen would then disagree about the same sample, and the database is the
-- one an auditor reads.
--
-- `assessments` was built for this: `evaluation_kind` admits
-- `controlled_reassessment`, and `supersedes` points at the decision being
-- replaced, so the old and the new verdict sit side by side (PRD §7.3,
-- UAT-12). Nothing ever wrote one. All 398 rows are `initial`.
--
-- ---------------------------------------------------------------------------
-- WHY A TRIGGER AND NOT A CALL INSIDE `rpc_approve_specification`
-- ---------------------------------------------------------------------------
-- Two reasons, and the second is the one that decided it.
--
-- A GUARANTEE, NOT A STEP. As a trigger, "an approved limit is reflected in
-- the stored verdicts" holds however the approval happened — the RPC today,
-- an administrative correction tomorrow, a data fix in a console. As a line
-- inside one function it holds only for callers that remember.
--
-- AND IT AVOIDS RESTATING A 200-LINE PRIVILEGED FUNCTION. `create or replace`
-- rewrites the whole body, so adding one line to `rpc_approve_specification`
-- means re-asserting its two-person check, its idempotency claim, its
-- permission check and its self-approval refusal from a copy. A line dropped
-- there fails silently and in the worst possible place. The trigger adds
-- behaviour without touching any of it.
--
-- ---------------------------------------------------------------------------
-- WHAT IT DOES AND DOES NOT TOUCH
-- ---------------------------------------------------------------------------
-- It fires only on a transition INTO `approved`. Not on rejection, not on
-- supersession, and not on an update that leaves an already-approved row
-- approved.
--
-- Supersession deserves its own note, because the gap is real. When a new
-- version is approved, `rpc_approve_specification` first supersedes the older
-- approved one and then approves the new one, in that order and in one
-- transaction — so the approval's own sweep sees the final state and gets the
-- right answer. A rule superseded with NO replacement would leave verdicts
-- standing that no approved rule supports any more, and nothing here fixes
-- that. It is not reachable through the application: the only code that
-- supersedes an approved version is the approval path itself. Step 4 asserts
-- that remains true, so the day someone adds a withdrawal path, this comment
-- stops being an excuse and starts being a failing test.
--
-- IT WRITES NOTHING WHEN NOTHING CHANGED. An approval that leaves a verdict
-- exactly as it was — a unit still unconfirmed, a rule that does not match
-- this sample's material — records no reassessment. An evidence table with a
-- no-op row per measurement per approval is an evidence table nobody reads.
--
-- IT IS BOUNDED BY THE PARAMETER, NOT THE PLANT. One approval re-evaluates
-- only the measurements of that parameter. At today's scale the largest
-- parameter has 6 rows and the whole table has 398, so this runs inside the
-- approval transaction without comment. At a hundred thousand records it
-- would need to move out of the request; that is a real future limit and it
-- is written down here rather than discovered.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. The sweep.
--
-- `security definer` and granted to nobody: it is reached through the
-- trigger, which runs as the owner, and never from a client.
-- ---------------------------------------------------------------------------
create or replace function public.reassess_parameter(
  p_parameter_key text,
  p_actor         uuid
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row       record;
  v_outcome   public.assessment_outcome;
  v_prior     record;
  v_version   text;
  v_changed   integer := 0;
begin
  select c.value into v_version from public.system_config c where c.key = 'deployment_version';

  for v_row in
    select m.id, m.sample_uuid, m.stage, m.field_key, m.numeric_value, m.entered_text,
           m.assessment_result, m.assessment_reason, m.rule_id,
           f.unit, f.unit_confirmed,
           s.material_code, s.stage_detail, s.collection_instant
      from public.sample_measurements m
      join public.stage_fields f on f.stage = m.stage and f.field_key = m.field_key
      join public.samples s on s.id = m.sample_uuid
     where f.parameter_key = p_parameter_key
     -- Deterministic, so a reassessment's audit trail reads in a stable
     -- order rather than in whatever order the planner chose that day.
     order by m.sample_uuid, m.field_key
  loop
    -- The same eleven arguments `apply_measurement` passes, in the same
    -- order, so a measurement re-judged here cannot differ from one judged
    -- at entry for any reason other than the rule having changed.
    v_outcome := public.evaluate_measurement(
      v_row.stage,
      v_row.field_key,
      v_row.numeric_value,
      v_row.unit,
      v_row.unit_confirmed,
      public.is_field_applicable(v_row.sample_uuid, v_row.stage, v_row.field_key),
      v_row.material_code,
      null,
      v_row.stage_detail,
      null,
      v_row.collection_instant
    );

    -- Nothing changed: no row, no update, no audit noise.
    if v_outcome.result is not distinct from v_row.assessment_result
       and v_outcome.reason is not distinct from v_row.assessment_reason
       and v_outcome.rule_id is not distinct from v_row.rule_id then
      continue;
    end if;

    -- THE HEAD OF THE SUPERSESSION CHAIN, not the newest by timestamp.
    --
    -- `evaluated_at` defaults to now(), which in PostgreSQL is the
    -- TRANSACTION start time — so two assessments written in one
    -- transaction carry the same instant and `order by evaluated_at` picks
    -- between them arbitrarily. That is not hypothetical: approving two
    -- versions of one parameter in a single transaction would make this
    -- sweep supersede a row that had already been superseded, forking the
    -- chain and losing a decision.
    --
    -- The head is the row nothing else supersedes. It is unique by
    -- construction, needs no clock, and is the correct answer whatever order
    -- the rows were written in.
    select a.id into v_prior
      from public.assessments a
     where a.measurement_id = v_row.id
       and not exists (select 1 from public.assessments b where b.supersedes = a.id)
     limit 1;

    insert into public.assessments (
      sample_uuid, measurement_id, stage, field_key, parameter_key,
      measured_numeric, measured_entered_text, measured_unit,
      result, reason,
      rule_id, rule_version, rule_lower_bound, rule_upper_bound, rule_unit,
      candidate_count, explanation, evaluation_kind, supersedes,
      evaluated_by, deployment_version
    )
    values (
      v_row.sample_uuid, v_row.id, v_row.stage, v_row.field_key, p_parameter_key,
      v_row.numeric_value, v_row.entered_text, v_row.unit,
      v_outcome.result, v_outcome.reason,
      v_outcome.rule_id, v_outcome.rule_version, v_outcome.lower_bound,
      v_outcome.upper_bound, v_outcome.unit,
      v_outcome.candidate_count, v_outcome.explanation,
      -- A measurement with no assessment on file has never been judged, so
      -- this IS its first decision. Calling it a reassessment would both
      -- break `assessments_reassessment_supersedes` and misdescribe it.
      case when v_prior.id is null then 'initial' else 'controlled_reassessment' end,
      v_prior.id,
      p_actor, v_version
    );

    update public.sample_measurements
       set assessment_result = v_outcome.result,
           assessment_reason = v_outcome.reason,
           rule_id           = v_outcome.rule_id,
           rule_version      = v_outcome.rule_version,
           assessed_at       = now()
     where id = v_row.id;

    v_changed := v_changed + 1;
  end loop;

  return v_changed;
end;
$$;

revoke all on function public.reassess_parameter(text, uuid) from public, anon, authenticated;

comment on function public.reassess_parameter(text, uuid) is
  'Re-evaluate every stored measurement of one parameter against the rules as they now stand, appending a controlled_reassessment to `assessments` and updating the stored verdict — but only where the verdict actually changed. Called by the approval trigger; never from a client.';


-- ---------------------------------------------------------------------------
-- 2. The trigger that calls it.
-- ---------------------------------------------------------------------------
create or replace function public.tg_specification_approved_reassess()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_changed integer;
begin
  if new.status <> 'approved' or old.status is not distinct from 'approved' then
    return new;
  end if;

  -- `new.approved_by` and not the session user: the approver is who caused
  -- these decisions, and `assessments.evaluated_by` is the field an auditor
  -- reads to ask who is answerable for them.
  v_changed := public.reassess_parameter(new.parameter_key, new.approved_by);

  -- Recorded even when zero, because "approving this changed nothing" is
  -- itself a fact worth being able to show.
  perform public.record_audit_event(
    p_action      => 'specification.reassessment',
    p_entity_type => 'specification_version',
    p_entity_id   => new.id::text,
    p_sample_uuid => null,
    p_reason      => format(
      'Approving %s version %s re-judged %s stored measurement(s).',
      new.parameter_key, new.version, v_changed
    ),
    p_before      => jsonb_build_object('parameter_key', new.parameter_key),
    p_after       => jsonb_build_object(
      'parameter_key', new.parameter_key,
      'specification_version_id', new.id,
      'measurements_reassessed', v_changed
    )
  );

  return new;
end;
$$;

-- A trigger function is only ever invoked by the trigger, but it is still a
-- `security definer` function with a name any signed-in account could call.
-- `tests/rpcContract.test.ts` requires an explicit revoke on every one of the
-- 92 of them, and it caught this one missing — the rule exists precisely
-- because "nobody would call it directly" is an assumption, not a control.
revoke all on function public.tg_specification_approved_reassess() from public, anon, authenticated;

drop trigger if exists specification_versions_reassess on public.specification_versions;

create trigger specification_versions_reassess
  after update on public.specification_versions
  for each row execute function public.tg_specification_approved_reassess();

comment on function public.tg_specification_approved_reassess() is
  'On a transition into `approved`, re-judge that parameter''s stored measurements so the database agrees with what the screens compute. A trigger rather than a line in rpc_approve_specification, so the guarantee holds however an approval happened.';


-- ---------------------------------------------------------------------------
-- 3. Prove it, in the same transaction that did it.
--
-- Not a smoke test. The sweep is the thing that will rewrite stored quality
-- verdicts in bulk, so it is exercised end to end here against a real
-- measurement, and then rolled back — every assertion below runs inside a
-- savepoint that is released by raising, so this migration leaves no sample,
-- no rule and no assessment behind.
-- ---------------------------------------------------------------------------
do $$
declare
  v_sample     uuid;
  v_spec       uuid;
  v_version    uuid;
  v_proposer   uuid;
  v_approver   uuid;
  v_before     public.assessment_result;
  v_after      public.assessment_result;
  v_kind       text;
  v_supersedes uuid;
  v_count      integer;
begin
  -- Two distinct people, because the two-person rule is a CHECK constraint
  -- and a single-profile fixture would fail for the wrong reason.
  select id into v_proposer from public.profiles order by created_at limit 1;
  select id into v_approver from public.profiles where id <> v_proposer
   order by created_at limit 1;
  if v_proposer is null or v_approver is null then
    raise notice 'BFF_0040: fewer than two profiles exist; the end-to-end probe is skipped.';
    return;
  end if;

  begin
    -- A sample and one measured value on a parameter nothing else touches.
    -- `awaiting_results`, not the `draft` default: `samples_draft_has_no_id`
    -- refuses a draft that carries a sample id, and a draft is the wrong
    -- state for a probe about recorded results anyway.
    insert into public.samples (
      sample_id, stage, prefix, collection_instant, collection_local_date,
      collection_local_time, created_by, registered_by, registered_at, capture_state
    ) values (
      'ZZ-000000-99', 'conditioned', 'AC', now(), current_date, '00:00', v_proposer,
      v_proposer, now(), 'awaiting_results'
    ) returning id into v_sample;

    perform public.apply_measurement(
      v_sample, 'mash_temperature_c', 85, null, '85', v_proposer, 'initial'
    );

    select assessment_result into v_before
      from public.sample_measurements
     where sample_uuid = v_sample and field_key = 'mash_temperature_c';
    if v_before <> 'not_assessable' then
      raise exception 'BFF_0040_PRECONDITION: expected not_assessable before approval, got %',
        v_before using errcode = '22023';
    end if;

    -- A rule that would decide it, approved by a second person.
    select id into v_spec from public.specifications
     where parameter_key = 'conditioned.temperature';
    insert into public.specification_versions (
      specification_id, version, parameter_key, stage, unit,
      lower_bound, upper_bound, status, effective_from, source_evidence,
      proposed_by, proposed_at
    ) values (
      v_spec, 99, 'conditioned.temperature', 'conditioned', '°C',
      84, 86, 'proposed', now() - interval '1 day',
      '0040 end-to-end probe. Rolled back.', v_proposer, now()
    ) returning id into v_version;

    update public.specification_versions
       set status = 'approved', approved_by = v_approver, approved_at = now()
     where id = v_version;

    -- a. The stored verdict moved, which is the whole point.
    select assessment_result into v_after
      from public.sample_measurements
     where sample_uuid = v_sample and field_key = 'mash_temperature_c';
    if v_after <> 'within_limit' then
      raise exception
        'BFF_0040_SWEEP: the stored verdict is % after approving a rule that covers it; '
        'the sweep did not run or did not decide', v_after
        using errcode = '22023';
    end if;

    -- b. The evidence says what it is and what it replaces. A reassessment
    --    that overwrote the old decision instead of superseding it would
    --    satisfy (a) and destroy the audit trail.
    --
    --    Read by CHAIN POSITION and not by timestamp, for the reason given
    --    on `reassess_parameter`'s own lookup: both rows were written in this
    --    transaction and share an `evaluated_at`, so "the latest" by clock is
    --    a coin toss. This assertion got that wrong on its first run and
    --    reported the sweep as broken when the sweep was right.
    select a.evaluation_kind, a.supersedes into v_kind, v_supersedes
      from public.assessments a
     where a.sample_uuid = v_sample and a.field_key = 'mash_temperature_c'
       and not exists (select 1 from public.assessments b where b.supersedes = a.id);
    if v_kind <> 'controlled_reassessment' or v_supersedes is null then
      raise exception 'BFF_0040_EVIDENCE: the head of the chain is kind=% supersedes=%',
        coalesce(v_kind, 'none'), coalesce(v_supersedes::text, 'null') using errcode = '22023';
    end if;

    select count(*) into v_count
      from public.assessments
     where sample_uuid = v_sample and field_key = 'mash_temperature_c';
    if v_count <> 2 then
      raise exception 'BFF_0040_EVIDENCE: expected 2 assessments (initial + reassessment), found %',
        v_count using errcode = '22023';
    end if;

    -- c. THE NO-OP CONTROL. Approving a second rule for a parameter this
    --    sample does not carry must write nothing at all. Without this, a
    --    sweep that re-wrote every measurement on every approval would pass
    --    every assertion above.
    select count(*) into v_count from public.assessments where sample_uuid = v_sample;
    declare
      v_spec2    uuid;
      v_version2 uuid;
      v_after2   integer;
    begin
      select id into v_spec2 from public.specifications
       where parameter_key = 'pellets.pellet_diameter';
      insert into public.specification_versions (
        specification_id, version, parameter_key, stage, unit,
        lower_bound, upper_bound, status, effective_from, source_evidence,
        proposed_by, proposed_at
      ) values (
        v_spec2, 99, 'pellets.pellet_diameter', 'pellets', 'mm',
        1, 10, 'proposed', now() - interval '1 day',
        '0040 no-op control. Rolled back.', v_proposer, now()
      ) returning id into v_version2;
      update public.specification_versions
         set status = 'approved', approved_by = v_approver, approved_at = now()
       where id = v_version2;
      select count(*) into v_after2 from public.assessments where sample_uuid = v_sample;
      if v_after2 <> v_count then
        raise exception
          'BFF_0040_NOOP: approving an unrelated parameter wrote % extra assessment row(s)',
          v_after2 - v_count using errcode = '22023';
      end if;
    end;

    -- Everything above is a probe. Undo it.
    raise exception 'BFF_0040_ROLLBACK';
  exception
    when others then
      if sqlerrm <> 'BFF_0040_ROLLBACK' then
        raise;
      end if;
  end;

  raise notice 'BFF_0040: end-to-end probe passed and was rolled back.';
end
$$;


-- ---------------------------------------------------------------------------
-- 4. The assumption the comment above rests on, asserted rather than trusted.
--
-- The sweep fires only on a transition into `approved`, which is safe only
-- while nothing supersedes an approved rule except the approval path itself.
-- `rpc_approve_specification` is the only function that does, and this
-- catalogue sweep is what tells the next author that adding a second one is
-- a decision, not a detail.
-- ---------------------------------------------------------------------------
do $$
declare
  v_bad text;
begin
  select string_agg(p.proname, ', ')
    into v_bad
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    join pg_language l on l.oid = p.prolang
   where n.nspname = 'public'
     and l.lanname = 'plpgsql'
     and p.prokind = 'f'
     and p.proname <> 'rpc_approve_specification'
     -- `[^.\w]` is load-bearing. Without it this matches
     -- `new.status = 'superseded'` inside the lifecycle guard, which is a
     -- COMPARISON — the guard decides whether a supersession is permitted,
     -- it never performs one — and the first run of this sweep failed on
     -- exactly that. What is being looked for is an ASSIGNMENT, which is
     -- never written against a qualified column here.
     and pg_get_functiondef(p.oid) ~* '[^.\w]status\s*=\s*''superseded''';
  if v_bad is not null then
    raise exception
      'BFF_0040_SUPERSEDE: % also supersedes a specification version. The reassessment '
      'trigger fires only on approval, so a supersession with no replacement would leave '
      'stale verdicts standing. Extend the trigger or justify the exception.', v_bad
      using errcode = '22023';
  end if;
end
$$;
