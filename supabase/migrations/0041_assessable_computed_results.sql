-- ===========================================================================
-- 0041 — a computed result can be judged.
--
-- ---------------------------------------------------------------------------
-- WHAT WAS WRONG
-- ---------------------------------------------------------------------------
-- This system stores test results in two tables. Values an operator types go
-- to `sample_measurements`, which carries five fields beside each number —
-- the verdict, the reason, the deciding rule, its version, and when it was
-- decided. Values the server computes go to `sample_derived_results`, which
-- carried the number and nothing else.
--
-- So DGM, GSD and PDI — the three characteristics the plant actually steers
-- the mill by — could not be given a limit. Not "nobody had", but "there is
-- nowhere for the answer to go". That is why the 900-1200 um grind target
-- had to be built as a separate administrator screen with its own colouring,
-- outside the approval workflow: no two-person approval, no version, no
-- effective date, no audit of who set it.
--
-- Three things each blocked it independently, so fixing any two would have
-- produced the same `not_assessable` with more code:
--
--   1. The computed fields carried no unit and no parameter key. The engine
--      refuses a value whose unit is unconfirmed, so it would have answered
--      `not_assessable / unit_not_confirmed` for ever.
--   2. `sample_derived_results` had no columns to hold a verdict.
--   3. Nothing called the engine on that path.
--
-- All three are fixed here. The registry change for (1) is in
-- `src/forms/registry.ts`; this migration mirrors it, and
-- `tests/registryDatabaseContract.test.ts` compares the two.
--
-- ---------------------------------------------------------------------------
-- THREE DECISIONS, TAKEN DELIBERATELY
-- ---------------------------------------------------------------------------
-- A COMPUTED RESULT NEVER RAISES A HOLD. An `outside_limit` on a typed
-- measurement puts material on quality hold; a grind slightly coarse is a
-- process signal, not a contaminated batch, and auto-holding on it would ask
-- a Quality Supervisor to make a release decision about an engineering
-- problem. This needs NO code: the hold path reads
-- `sample_measurements.assessment_result`, and a derived verdict is not in
-- that table. Step 6 asserts that stays true rather than trusting it.
--
-- ONE PHYSICAL TEST IS STILL JUDGED ONCE. A sieve test run on `2 Ground`
-- also appears in the `8 DGM` master log, and the worry was that approving
-- limits on both tabs would judge the same test twice under rules that could
-- disagree. It cannot: `tg_record_derived_results` returns early for a
-- `dgm_log` event, because a master-log row is a RE-PROJECTION of a sample
-- that lives on another tab, not a sample of its own. The log copy is a
-- spreadsheet row and carries no verdict. `dgm.*` parameters therefore apply
-- only to the sieve tests registered directly on `8 DGM`, of which there are
-- six, and which would otherwise be the only ones in the plant with no
-- parameter at all. Step 6 asserts the early return survives.
--
-- GSD'S UNIT IS THE WORD `dimensionless`, AND THAT IS NOT A FUDGE. The
-- engine refuses a value whose unit is unconfirmed, and a NULL unit counts
-- as unconfirmed — correctly, because the case that rule exists for is
-- `3 Conditioned` steam pressure, whose source cell literally reads "to
-- confirm" (UAT-07, risk R-02). But GSD is not a quantity whose unit nobody
-- established; it is a ratio of two particle sizes and HAS no unit.
-- Conflating "no unit" with "unit unknown" would leave it permanently
-- unassessable, and the alternative — loosening the gate so a null unit
-- passes — would weaken the one control that stops a steam pressure in
-- unknown units being called conforming. Saying `dimensionless` in the data
-- costs nothing and changes no rule: it is a confirmed unit like any other,
-- and an approved GSD limit must state the same word, so the unit-equality
-- check still has to pass.
--
-- ---------------------------------------------------------------------------
-- WHY A SEPARATE TRIGGER AND NOT AN EDIT TO `tg_record_derived_results`
-- ---------------------------------------------------------------------------
-- The same reasoning as 0040. `create or replace` rewrites a whole body, and
-- that function parses a projected spreadsheet row cell by cell, deletes a
-- derived row when a computation had no answer, and tolerates a text column
-- among eight numeric ones. Restating all of it to add an evaluation is
-- fifty lines of copying for five lines of new behaviour, and a line dropped
-- in the copy fails silently.
--
-- A BEFORE INSERT OR UPDATE trigger on `sample_derived_results` fills the
-- verdict in the same write, whoever inserted the row and for whatever
-- reason. No second write, no restatement, and it cannot be bypassed.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Somewhere for the answer to go.
--
-- The same five fields `sample_measurements` carries, with the same
-- pairing constraints, so a reader of one table is not surprised by the
-- other. `recorded_by` is deliberately NOT added: nobody attested to a
-- computed value, and a person's name against arithmetic is the confusion
-- this table was split off to avoid.
-- ---------------------------------------------------------------------------
alter table public.sample_derived_results
  add column if not exists assessment_result public.assessment_result,
  add column if not exists assessment_reason public.assessment_reason,
  add column if not exists rule_id           uuid references public.specification_versions (id),
  add column if not exists rule_version      integer,
  add column if not exists assessed_at       timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'sample_derived_results_assessment_pair'
  ) then
    alter table public.sample_derived_results
      add constraint sample_derived_results_assessment_pair
        check ((assessment_result is null) = (assessment_reason is null)),
      add constraint sample_derived_results_assessed_at_pair
        check ((assessment_result is null) = (assessed_at is null)),
      add constraint sample_derived_results_rule_pair
        check ((rule_id is null) = (rule_version is null)),
      -- The same refusal `assessments` makes: a conformity decision with no
      -- approved rule behind it is exactly what this system exists to
      -- prevent, and a computed column is not an exception to that.
      add constraint sample_derived_results_decision_requires_rule
        check (
          case when assessment_result in ('within_limit', 'outside_limit')
               then rule_id is not null else true end
        );
  end if;
end
$$;

comment on column public.sample_derived_results.assessment_result is
  'The verdict on a computed result. Added by 0041; before that a computed result could not be judged at all, which is why the DGM grind target had to live outside the approval workflow.';


-- ---------------------------------------------------------------------------
-- 2. A unit and a parameter on the three that can carry a limit.
--
-- Mirrors `src/forms/registry.ts`. The other six computed columns stay bare
-- on purpose: `total_retained_g` is a control total, the three UI
-- percentages are a distribution summary, `dpg_legacy_index` carries units
-- and scales with sample mass so a bound on it would mean different things
-- for different weigh-outs, and `gsd_basis` is text.
-- ---------------------------------------------------------------------------
-- Twelve statements, one per (tab, column), and NOT three using
-- `parameter_key = stage::text || '.avg_particle_size'`. That expression is
-- shorter and it is unreadable to `tests/registryDatabaseContract.test.ts`,
-- which models this table by parsing the migration corpus and understands
-- only `set col = literal`. It read the concatenation as a literal string
-- and reported the registry and the seed as disagreeing on five tabs. A
-- migration the contract test cannot parse is a migration it cannot police.

update public.stage_fields
   set unit = 'µm', unit_confirmed = true, parameter_key = 'ground.avg_particle_size'
 where stage = 'ground' and field_key = 'dgm_um';

update public.stage_fields
   set unit = 'µm', unit_confirmed = true, parameter_key = 'pellets.avg_particle_size'
 where stage = 'pellets' and field_key = 'dgm_um';

update public.stage_fields
   set unit = 'µm', unit_confirmed = true, parameter_key = 'crumble.avg_particle_size'
 where stage = 'crumble' and field_key = 'dgm_um';

update public.stage_fields
   set unit = 'µm', unit_confirmed = true, parameter_key = 'mash.avg_particle_size'
 where stage = 'mash' and field_key = 'dgm_um';

update public.stage_fields
   set unit = 'µm', unit_confirmed = true, parameter_key = 'dgm.avg_particle_size'
 where stage = 'dgm' and field_key = 'dgm_um';

update public.stage_fields
   set unit = 'dimensionless', unit_confirmed = true, parameter_key = 'ground.size_spread_gsd'
 where stage = 'ground' and field_key = 'gsd';

update public.stage_fields
   set unit = 'dimensionless', unit_confirmed = true, parameter_key = 'pellets.size_spread_gsd'
 where stage = 'pellets' and field_key = 'gsd';

update public.stage_fields
   set unit = 'dimensionless', unit_confirmed = true, parameter_key = 'crumble.size_spread_gsd'
 where stage = 'crumble' and field_key = 'gsd';

update public.stage_fields
   set unit = 'dimensionless', unit_confirmed = true, parameter_key = 'mash.size_spread_gsd'
 where stage = 'mash' and field_key = 'gsd';

update public.stage_fields
   set unit = 'dimensionless', unit_confirmed = true, parameter_key = 'dgm.size_spread_gsd'
 where stage = 'dgm' and field_key = 'gsd';

update public.stage_fields
   set unit = '%', unit_confirmed = true, parameter_key = 'pellets.pellet_durability_pdi'
 where stage = 'pellets' and field_key = 'pellet_durability_pdi_pct';

update public.stage_fields
   set unit = '%', unit_confirmed = true, parameter_key = 'crumble.pellet_durability_pdi'
 where stage = 'crumble' and field_key = 'pellet_durability_pdi_pct';


-- ---------------------------------------------------------------------------
-- 3. Judge it when it is computed.
-- ---------------------------------------------------------------------------
create or replace function public.tg_assess_derived_result()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_field      record;
  v_sample     record;
  v_outcome    public.assessment_outcome;
  v_prior      record;
  v_record     boolean;
  v_deployment text;
begin
  select f.unit, f.unit_confirmed, f.parameter_key into v_field
    from public.stage_fields f
   where f.stage = new.stage and f.field_key = new.result_key;

  -- A computed column with no parameter key is recorded only. Left NULL
  -- rather than written as `not_assessable`, because "nothing judged this"
  -- and "something judged this and could not decide" are different facts,
  -- and a screen that shows the second for a control total is noise.
  if v_field.parameter_key is null then
    new.assessment_result := null;
    new.assessment_reason := null;
    new.rule_id           := null;
    new.rule_version      := null;
    new.assessed_at       := null;
    return new;
  end if;

  select s.material_code, s.stage_detail, s.collection_instant into v_sample
    from public.samples s where s.id = new.sample_uuid;

  -- The same eleven arguments `apply_measurement` and `reassess_parameter`
  -- pass, in the same order. A measurement and a computed result must be
  -- judged by one engine with one context, or the two tables will disagree
  -- about the same sample.
  v_outcome := public.evaluate_measurement(
    new.stage,
    new.result_key,
    new.numeric_value,
    v_field.unit,
    v_field.unit_confirmed,
    public.is_field_applicable(new.sample_uuid, new.stage, new.result_key),
    v_sample.material_code,
    null,
    v_sample.stage_detail,
    null,
    v_sample.collection_instant
  );

  new.assessment_result := v_outcome.result;
  new.assessment_reason := v_outcome.reason;
  new.rule_id           := v_outcome.rule_id;
  new.rule_version      := v_outcome.rule_version;
  new.assessed_at       := now();

  -- Evidence, on the same terms as a typed measurement: appended when the
  -- verdict is new or has changed, and never when it has not. `assessments`
  -- allows a null `measurement_id`, which is what a computed result is —
  -- there is no measurement row and no person who attested to it.
  --
  -- `tg_op` is branched on explicitly rather than relied on to short-circuit
  -- an `old.` reference: OLD is unassigned in an INSERT trigger, and reading
  -- through it is an error rather than a null.
  if tg_op = 'INSERT' then
    v_record := true;
  else
    v_record := old.assessment_result is distinct from new.assessment_result
             or old.assessment_reason is distinct from new.assessment_reason
             or old.rule_id is distinct from new.rule_id;
  end if;

  if v_record then
    -- The head of the supersession chain, for the reason 0040 gives:
    -- `evaluated_at` is the transaction start time, so two rows written in
    -- one transaction cannot be ordered by it.
    select a.id into v_prior
      from public.assessments a
     where a.sample_uuid = new.sample_uuid
       and a.field_key = new.result_key
       and not exists (select 1 from public.assessments b where b.supersedes = a.id)
     limit 1;

    select c.value into v_deployment
      from public.system_config c where c.key = 'deployment_version';

    insert into public.assessments (
      sample_uuid, measurement_id, stage, field_key, parameter_key,
      measured_numeric, measured_entered_text, measured_unit,
      result, reason,
      rule_id, rule_version, rule_lower_bound, rule_upper_bound, rule_unit,
      candidate_count, explanation, evaluation_kind, supersedes,
      evaluated_by, deployment_version
    )
    values (
      new.sample_uuid, null, new.stage, new.result_key, v_field.parameter_key,
      new.numeric_value, new.display_text, v_field.unit,
      v_outcome.result, v_outcome.reason,
      v_outcome.rule_id, v_outcome.rule_version, v_outcome.lower_bound,
      v_outcome.upper_bound, v_outcome.unit,
      v_outcome.candidate_count, v_outcome.explanation,
      case when v_prior.id is null then 'initial' else 'controlled_reassessment' end,
      v_prior.id,
      -- No `evaluated_by`. Nobody decided this; the server computed the
      -- value and the engine judged it. A name here would be a person
      -- attesting to arithmetic they never saw.
      null,
      v_deployment
    );
  end if;

  return new;
end;
$$;

revoke all on function public.tg_assess_derived_result() from public, anon, authenticated;

comment on function public.tg_assess_derived_result() is
  'Judges a computed result as it is written, with the same engine and the same context a typed measurement gets, and appends the decision to `assessments` when it changes. A separate BEFORE trigger rather than an edit to tg_record_derived_results, so that function is not restated to add five lines.';

drop trigger if exists sample_derived_results_assess on public.sample_derived_results;

create trigger sample_derived_results_assess
  before insert or update on public.sample_derived_results
  for each row execute function public.tg_assess_derived_result();


-- ---------------------------------------------------------------------------
-- 4. The sweep covers computed results too.
--
-- Restating `reassess_parameter` in full — it is 0040's, it is sixty lines,
-- and the alternative is a second function that does nearly the same thing.
-- The measurement half below is unchanged; the derived half is new.
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
     order by m.sample_uuid, m.field_key
  loop
    v_outcome := public.evaluate_measurement(
      v_row.stage, v_row.field_key, v_row.numeric_value, v_row.unit, v_row.unit_confirmed,
      public.is_field_applicable(v_row.sample_uuid, v_row.stage, v_row.field_key),
      v_row.material_code, null, v_row.stage_detail, null, v_row.collection_instant
    );

    if v_outcome.result is not distinct from v_row.assessment_result
       and v_outcome.reason is not distinct from v_row.assessment_reason
       and v_outcome.rule_id is not distinct from v_row.rule_id then
      continue;
    end if;

    -- THE HEAD OF THE SUPERSESSION CHAIN, not the newest by timestamp.
    -- `evaluated_at` defaults to now(), which is the TRANSACTION start time,
    -- so two assessments written in one transaction share it exactly and
    -- ordering by it picks between them arbitrarily — forking the chain and
    -- losing a decision. The head is the row nothing else supersedes: unique
    -- by construction, and it needs no clock.
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

  -- Computed results. A no-op UPDATE is enough: the BEFORE trigger from step
  -- 3 re-evaluates the row and appends the evidence, so the rule lives in
  -- one place instead of being written out twice and drifting.
  --
  -- `touched_at` is set to itself rather than nothing at all, because
  -- PostgreSQL skips an UPDATE whose SET list is empty — there is no
  -- `update ... set` with no assignments — and a column assigned its own
  -- value still fires a BEFORE ROW trigger.
  for v_row in
    select d.sample_uuid, d.result_key
      from public.sample_derived_results d
      join public.stage_fields f on f.stage = d.stage and f.field_key = d.result_key
     where f.parameter_key = p_parameter_key
     order by d.sample_uuid, d.result_key
  loop
    update public.sample_derived_results
       set numeric_value = numeric_value
     where sample_uuid = v_row.sample_uuid and result_key = v_row.result_key;
    v_changed := v_changed + 1;
  end loop;

  return v_changed;
end;
$$;

revoke all on function public.reassess_parameter(text, uuid) from public, anon, authenticated;


-- ---------------------------------------------------------------------------
-- 5. Judge the computed results already on file.
--
-- The trigger only fires on a write, so every row stored before today has a
-- NULL verdict. The same no-op update brings them all through it.
-- ---------------------------------------------------------------------------
update public.sample_derived_results set numeric_value = numeric_value;


-- ---------------------------------------------------------------------------
-- 6. Prove it, in the same transaction that did it.
-- ---------------------------------------------------------------------------
do $$
declare
  v_bad   text;
  v_n     integer;
begin
  -- a. The three fields are linked and carry a confirmed unit, on every tab
  --    that has them, and each names a parameter that exists.
  select string_agg(format('%s.%s unit=%s key=%s', f.stage, f.field_key,
                           coalesce(f.unit, 'null'), coalesce(f.parameter_key, 'null')), '; ')
    into v_bad
    from public.stage_fields f
   where f.field_key in ('dgm_um', 'gsd', 'pellet_durability_pdi_pct')
     and (f.parameter_key is null
          or f.unit is null
          or coalesce(f.unit_confirmed, false) = false
          or not public.is_unit_confirmed(f.unit)
          or not exists (select 1 from public.specifications s
                          where s.parameter_key = f.parameter_key));
  if v_bad is not null then
    raise exception 'BFF_0041_FIELDS: %', v_bad using errcode = '22023';
  end if;

  -- b. The other six computed columns were NOT linked. Without this, a
  --    careless `update ... where field_type = 'system'` would pass (a).
  select string_agg(f.stage || '.' || f.field_key, '; ') into v_bad
    from public.stage_fields f
   where f.requiredness = 'system' and f.section = 'test_results'
     and f.field_key not in ('dgm_um', 'gsd', 'pellet_durability_pdi_pct')
     and f.parameter_key is not null;
  if v_bad is not null then
    raise exception
      'BFF_0041_OVERREACH: % acquired a parameter key; a control total and a '
      'distribution summary are not characteristics anybody specifies', v_bad
      using errcode = '22023';
  end if;

  -- c. Every stored computed result has been judged, and the ones with no
  --    parameter were left alone rather than marked not_assessable.
  select count(*) into v_n
    from public.sample_derived_results d
    join public.stage_fields f on f.stage = d.stage and f.field_key = d.result_key
   where f.parameter_key is not null and d.assessment_result is null;
  if v_n <> 0 then
    raise exception 'BFF_0041_BACKFILL: % linked computed result(s) still unjudged', v_n
      using errcode = '22023';
  end if;

  select count(*) into v_n
    from public.sample_derived_results d
    join public.stage_fields f on f.stage = d.stage and f.field_key = d.result_key
   where f.parameter_key is null and d.assessment_result is not null;
  if v_n <> 0 then
    raise exception 'BFF_0041_UNLINKED: % unlinked computed result(s) carry a verdict', v_n
      using errcode = '22023';
  end if;

  -- d. NOTHING BECAME CONFORMING. No limit is approved, so every one of
  --    those verdicts must be `not_assessable`. This is the assertion that
  --    would catch an engine change smuggled in alongside a plumbing one.
  select string_agg(distinct d.assessment_result::text, ', ') into v_bad
    from public.sample_derived_results d
   where d.assessment_result is not null
     and d.assessment_result not in ('not_assessable', 'not_tested');
  if v_bad is not null then
    raise exception
      'BFF_0041_DECIDED: a computed result assessed as % while no limit is approved',
      v_bad using errcode = '22023';
  end if;

  -- e. A COMPUTED RESULT CANNOT RAISE A HOLD. The hold path reads
  --    `sample_measurements`; if anything ever reads an `outside_limit` out
  --    of the derived table, that decision has been reversed by accident.
  select string_agg(p.proname, ', ') into v_bad
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    join pg_language l on l.oid = p.prolang
   where n.nspname = 'public' and l.lanname = 'plpgsql' and p.prokind = 'f'
     and pg_get_functiondef(p.oid) ~* 'sample_derived_results'
     and pg_get_functiondef(p.oid) ~* 'outside_limit'
     and p.proname <> 'tg_assess_derived_result';
  if v_bad is not null then
    raise exception
      'BFF_0041_HOLD: % reads outside_limit from the derived table. A computed result '
      'is a process signal, not a contaminated batch, and must not hold material.', v_bad
      using errcode = '22023';
  end if;

  -- f. The master-log early return survives, so one physical sieve test is
  --    still judged once. Remove it and a Ground test would also be written
  --    as a `dgm` derived row and judged a second time under dgm.*.
  if pg_get_functiondef('public.tg_record_derived_results()'::regprocedure)
     !~ 'event_kind = ''dgm_log''' then
    raise exception
      'BFF_0041_DOUBLE: tg_record_derived_results no longer skips a dgm_log event, so a '
      'sieve test projected into the master log would be judged twice'
      using errcode = '22023';
  end if;
end
$$;


-- ---------------------------------------------------------------------------
-- 7. The assertions above prove the plumbing. This proves the DECISION.
--
-- Every check in step 6 would pass on a system that stored a verdict field
-- and never put anything but `not_assessable` in it — which is exactly the
-- state this migration exists to leave behind. So an approved limit is put
-- in front of a real computed result, end to end, through the approval
-- trigger and the sweep, and then rolled back.
-- ---------------------------------------------------------------------------
do $$
declare
  v_proposer uuid;
  v_approver uuid;
  v_sample   uuid;
  v_dgm      numeric;
  v_spec     uuid;
  v_version  uuid;
  v_after    public.assessment_result;
  v_rule     uuid;
  v_kind     text;
  v_sup      uuid;
begin
  select id into v_proposer from public.profiles order by created_at limit 1;
  select id into v_approver from public.profiles where id <> v_proposer
   order by created_at limit 1;
  select d.sample_uuid, d.numeric_value into v_sample, v_dgm
    from public.sample_derived_results d
   where d.stage = 'dgm' and d.result_key = 'dgm_um' and d.numeric_value is not null
   limit 1;

  if v_proposer is null or v_approver is null or v_sample is null then
    raise notice 'BFF_0041: no computed DGM result or fewer than two profiles; probe skipped.';
    return;
  end if;

  begin
    select id into v_spec from public.specifications
     where parameter_key = 'dgm.avg_particle_size';

    -- Bounds straddling the value that is actually on file, so a pass is a
    -- pass for the right reason rather than because the bounds were wide.
    insert into public.specification_versions (
      specification_id, version, parameter_key, stage, unit,
      lower_bound, upper_bound, status, effective_from, source_evidence,
      proposed_by, proposed_at
    ) values (
      v_spec, 99, 'dgm.avg_particle_size', 'dgm', 'µm',
      v_dgm - 1, v_dgm + 1, 'proposed', now() - interval '10 years',
      '0041 end-to-end probe. Rolled back.', v_proposer, now()
    ) returning id into v_version;

    update public.specification_versions
       set status = 'approved', approved_by = v_approver, approved_at = now()
     where id = v_version;

    -- a. A COMPUTED RESULT WAS DECIDED. This is the whole migration.
    select d.assessment_result, d.rule_id into v_after, v_rule
      from public.sample_derived_results d
     where d.sample_uuid = v_sample and d.result_key = 'dgm_um';
    if v_after <> 'within_limit' or v_rule is distinct from v_version then
      raise exception
        'BFF_0041_DECIDE: a computed DGM of %µm against an approved %-%µm limit assessed '
        'as % citing rule %', v_dgm, v_dgm - 1, v_dgm + 1, v_after,
        coalesce(v_rule::text, 'none') using errcode = '22023';
    end if;

    -- b. And it said so in the evidence, as a reassessment of the earlier
    --    not_assessable rather than by overwriting it.
    select a.evaluation_kind, a.supersedes into v_kind, v_sup
      from public.assessments a
     where a.sample_uuid = v_sample and a.field_key = 'dgm_um'
       and not exists (select 1 from public.assessments b where b.supersedes = a.id);
    if v_kind <> 'controlled_reassessment' or v_sup is null then
      raise exception 'BFF_0041_EVIDENCE: head of chain is kind=% supersedes=%',
        coalesce(v_kind, 'none'), coalesce(v_sup::text, 'null') using errcode = '22023';
    end if;

    -- c. AND IT HELD NOTHING. A computed result outside its limit is a
    --    process signal; the hold flag must be untouched whatever the
    --    verdict. Checked against the same sample, after the decision.
    if exists (select 1 from public.samples s where s.id = v_sample and s.hold_flag) then
      raise exception 'BFF_0041_HELD: deciding a computed result put the sample on hold'
        using errcode = '22023';
    end if;

    raise exception 'BFF_0041_ROLLBACK';
  exception
    when others then
      if sqlerrm <> 'BFF_0041_ROLLBACK' then raise; end if;
  end;

  raise notice 'BFF_0041: end-to-end probe passed and was rolled back.';
end
$$;
