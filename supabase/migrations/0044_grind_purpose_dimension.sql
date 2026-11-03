-- ===========================================================================
-- 0044 — the engine learns the dimension the grind targets are scoped on.
--
-- ---------------------------------------------------------------------------
-- WHY
-- ---------------------------------------------------------------------------
-- Polinutri's visit report of 21 October 2026 gives four grind targets, and
-- the thing it scopes them on is what is being ground AND what the meal is
-- for: 950-1050 um for rice to pelleted feed, 1200-1300 for corn to pelleted,
-- 1550-1650 for corn to mash, 1850-1950 for rice to mash. 0043 made the form
-- record exactly that, as four codes on `2 Ground`.
--
-- The engine could not use it. A rule is matched on four dimensions —
-- material, feed type, sampling point, test method — and the grind purpose is
-- none of them. Worse, three of the four are DEAD on that tab: `material_code`
-- is null on a ground sample, and feed type and test method are passed as
-- hard-coded nulls at every call site, so a rule scoped on either matches
-- nothing, silently, for ever. Only the sampling point works.
--
-- So the four ranges could be written down and could never decide anything.
-- This migration gives the engine a fifth dimension it can score them on.
--
-- IT DOES NOT FIX `material_code` ON GROUND, which was the plan until the
-- database refused it: `samples_material_only_for_raw_materials` restricts
-- that column to tab 1, deliberately, because a material is what arrives at
-- the gate and not what a mill is running. The grind purpose carries the
-- grain anyway — `grind_purposes.material_code` records which grain each
-- code means — so nothing is lost but an assumption.
--
-- ---------------------------------------------------------------------------
-- WHY A NEW DIMENSION AND NOT AN EXISTING ONE
-- ---------------------------------------------------------------------------
-- `feed_type_code` was the tempting shortcut: the form value already lands in
-- `samples.feed_type_label`, and one changed call site would have wired it up.
-- But a grind purpose is not a feed type. "Corn for pelletized feed" is an
-- intent for an INGREDIENT; `feed_types` holds Pre-starter, Starter, Grower,
-- Finisher and is the dropdown on five other tabs. Putting four grind codes in
-- that list to satisfy a foreign key would corrupt five forms to save one
-- column here, and the same argument rules out `test_method`.
--
-- A dimension is named after what it means. The next stage that needs one
-- gets a sixth, explicitly, rather than inheriting a misused fifth.
--
-- ---------------------------------------------------------------------------
-- HOW THE REPLACED FUNCTIONS WERE PRODUCED, BECAUSE IT MATTERS
-- ---------------------------------------------------------------------------
-- `evaluate_measurement` is 203 lines with three repeated CTEs, and
-- `apply_measurement` is 159 lines of privileged write path. `create or
-- replace` rewrites a whole body, so retyping either to change one line is how
-- a guarantee goes missing in a diff that looks like a one-line change.
--
-- Neither was retyped. Both bodies below were read out of the live catalogue
-- with `pg_get_functiondef`, patched programmatically, and the resulting diff
-- inspected line by line before being written here:
--
--   evaluate_measurement  14 changed lines: one signature, three filters,
--                         three specificity terms. Nothing else.
--   apply_measurement      3 changed lines: one call site.
--   reassess_parameter     5 changed lines: one select, one call site.
--   tg_assess_derived_result  5 changed lines: the same two.
--
-- Step 7 then asserts the properties that must have survived, so the claim
-- above is checked rather than trusted.
--
-- ---------------------------------------------------------------------------
-- THE ELEVEN-ARGUMENT VERSION IS DROPPED, DELIBERATELY
-- ---------------------------------------------------------------------------
-- `create or replace` with a different argument count creates an OVERLOAD,
-- not a replacement. Left in place, every existing caller would keep
-- resolving to the old one and keep ignoring the new dimension — silently,
-- which is the exact failure mode this migration exists to end. It is dropped
-- once the three callers have been moved, and step 7 asserts it is gone.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. The vocabulary. Code-driven, not administrator-editable: the CODE is
--    what an approved limit is scoped by, exactly as with `sampling_points`,
--    and a code somebody invented would have no rule behind it.
-- ---------------------------------------------------------------------------
create table if not exists public.grind_purposes (
  code          text primary key,
  label         text not null,
  -- Which grain the code means. Documentation, not a second dimension: the
  -- engine scopes on the whole code, and `samples.material_code` is reserved
  -- for tab 1 by `samples_material_only_for_raw_materials`.
  material_code text not null references public.materials (code),
  -- What the meal is destined for. Recorded for readers; the engine scopes on
  -- the whole code, because the report specifies on the combination.
  destination   text not null,
  sort_order    integer not null,
  active        boolean not null default true,
  constraint grind_purposes_label_present check (length(btrim(label)) > 0),
  constraint grind_purposes_destination_valid check (destination in ('pelleted', 'mashed'))
);

insert into public.grind_purposes (code, label, material_code, destination, sort_order) values
  ('corn_pelleted',  'Corn for pelletized feed', 'corn', 'pelleted', 1),
  ('corn_mashed',    'Corn for mashed feed',     'corn', 'mashed',   2),
  ('rice_pelleted',  'Rice for pelletized feed', 'rice', 'pelleted', 3),
  ('rice_mashed',    'Rice for mashed feed',     'rice', 'mashed',   4)
on conflict (code) do nothing;

alter table public.grind_purposes enable row level security;
revoke all on public.grind_purposes from anon, authenticated;
grant select on public.grind_purposes to authenticated, service_role;

drop policy if exists grind_purposes_select_active on public.grind_purposes;
create policy grind_purposes_select_active on public.grind_purposes
  for select to authenticated using (public.is_active_user());

comment on table public.grind_purposes is
  'What the hammer mill is grinding and what the meal is for. The fifth applicability dimension: the Polinutri report of 2026-10-21 scopes its grind targets on this combination, so a rule is scoped on it too.';


-- ---------------------------------------------------------------------------
-- 2. The column on both sides of the match.
-- ---------------------------------------------------------------------------
alter table public.samples
  add column if not exists grind_purpose text references public.grind_purposes (code);

alter table public.specification_versions
  add column if not exists grind_purpose text references public.grind_purposes (code);

comment on column public.samples.grind_purpose is
  'Derived from the `material_or_feed_type` measurement on `2 Ground` by tg_sample_grind_purpose. Null on every other stage, which makes a purpose-scoped rule inapplicable there rather than wrongly applicable.';


-- ---------------------------------------------------------------------------
-- 3. Carry the form value onto the sample.
--
-- A trigger on the measurement rather than a line inside
-- `rpc_register_sample`: that function is 200 lines of privileged registration
-- path, and this way an AMENDMENT to the purpose updates the sample too — a
-- projection written only at registration would silently keep the first answer.
-- ---------------------------------------------------------------------------
create or replace function public.tg_sample_grind_purpose()
returns trigger
language plpgsql
security definer

set search_path = ''
as $fn$
declare
  v_purpose record;
begin
  if new.stage <> 'ground' or new.field_key <> 'material_or_feed_type' then
    return new;
  end if;

  select g.code into v_purpose
    from public.grind_purposes g where g.code = new.text_value;

  -- A value that is not a purpose leaves both columns alone rather than
  -- clearing them. `Corn` is the retired free-text code one voided
  -- commissioning record holds; it is a legal option and must stay
  -- projectable, but it names no grain and no destination.
  if v_purpose.code is null then
    return new;
  end if;

  -- `material_code` is deliberately NOT set here. The database reserves it
  -- for tab 1 and refuses it on any other stage.
  update public.samples
     set grind_purpose = v_purpose.code
   where id = new.sample_uuid;

  return new;
end;
$fn$;

revoke all on function public.tg_sample_grind_purpose() from public, anon, authenticated;

drop trigger if exists sample_measurements_grind_purpose on public.sample_measurements;

create trigger sample_measurements_grind_purpose
  after insert or update on public.sample_measurements
  for each row execute function public.tg_sample_grind_purpose();


-- ---------------------------------------------------------------------------
-- 4. The engine, with the fifth dimension. Derived from the live catalogue;
--    see the header for the diff.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.evaluate_measurement(p_stage sample_stage, p_field_key text, p_numeric_value numeric, p_unit text, p_unit_confirmed boolean, p_applicable boolean, p_material_code text, p_feed_type_code text, p_sampling_point text, p_test_method text, p_collection_instant timestamp with time zone, p_grind_purpose text)
 RETURNS assessment_outcome
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_out           public.assessment_outcome;
  v_parameter_key text;
  v_top_score     integer;
  v_matches       integer;
  v_rule          record;
  v_bounds        text;
begin
  v_out.candidate_count := 0;

  if not p_applicable then
    v_out.result := 'not_applicable';
    v_out.reason := 'field_not_applicable';
    v_out.explanation := 'This test does not apply to the selected sampling point.';
    return v_out;
  end if;

  -- NULL means not measured. ZERO IS A REAL MEASURED VALUE and falls through
  -- to the rule lookup like any other number (rule 8).
  if p_numeric_value is null then
    v_out.result := 'not_tested';
    v_out.reason := 'no_result_recorded';
    v_out.explanation := 'No result has been recorded yet.';
    return v_out;
  end if;

  if not (p_numeric_value = p_numeric_value
          and p_numeric_value > '-Infinity'::numeric
          and p_numeric_value < 'Infinity'::numeric) then
    v_out.result := 'not_assessable';
    v_out.reason := 'value_not_finite';
    v_out.explanation := 'The recorded value is not a finite number.';
    return v_out;
  end if;

  if not coalesce(p_unit_confirmed, false) or not public.is_unit_confirmed(p_unit) then
    v_out.result := 'not_assessable';
    v_out.reason := 'unit_not_confirmed';
    v_out.explanation :=
      'The unit for this measurement is not confirmed, so it cannot be compared against a limit.';
    return v_out;
  end if;

  select f.parameter_key into v_parameter_key
  from public.stage_fields f
  where f.stage = p_stage and f.field_key = p_field_key;

  -- A column with no parameter key is recorded only; it is never assessed.
  if v_parameter_key is null then
    v_out.result := 'not_assessable';
    v_out.reason := 'no_approved_rule';
    v_out.explanation :=
      'This column records a value but is not linked to a quality parameter, so conformity cannot be decided.';
    return v_out;
  end if;

  -- Candidates: approved, effective at the COLLECTION instant, and matching
  -- every applicability filter the rule pins down. A NULL filter on the rule
  -- is a wildcard.
  with candidates as (
    select
      v.id, v.version, v.lower_bound, v.upper_bound, v.unit,
      (case when v.material_code  is not null then 1 else 0 end)
      + (case when v.feed_type_code is not null then 1 else 0 end)
      + (case when v.sampling_point is not null then 1 else 0 end)
      + (case when v.test_method    is not null then 1 else 0 end)
      + (case when v.grind_purpose  is not null then 1 else 0 end) as specificity
    from public.specification_versions v
    where v.status = 'approved'
      and v.approved_by is not null
      and v.parameter_key = v_parameter_key
      and v.stage = p_stage
      and v.effective_from <= p_collection_instant
      and (v.effective_to is null or v.effective_to > p_collection_instant)
      and (v.material_code  is null or lower(v.material_code)  = lower(coalesce(p_material_code, '')))
      and (v.feed_type_code is null or lower(v.feed_type_code) = lower(coalesce(p_feed_type_code, '')))
      and (v.sampling_point is null or lower(v.sampling_point) = lower(coalesce(p_sampling_point, '')))
      and (v.test_method    is null or lower(v.test_method)    = lower(coalesce(p_test_method, '')))
      and (v.grind_purpose  is null or lower(v.grind_purpose)  = lower(coalesce(p_grind_purpose, '')))
  )
  select max(c.specificity) into v_top_score from candidates c;

  if v_top_score is null then
    v_out.result := 'not_assessable';
    v_out.reason := 'no_approved_rule';
    v_out.explanation :=
      'No approved limit applies to this test, so conformity cannot be decided.';
    return v_out;
  end if;

  -- The most specific rule wins. Two rules tied at the top score are "equally
  -- applicable" and therefore ambiguous: Quality must resolve it, and the
  -- engine must not pick one.
  with candidates as (
    select
      v.id, v.version, v.lower_bound, v.upper_bound, v.unit,
      (case when v.material_code  is not null then 1 else 0 end)
      + (case when v.feed_type_code is not null then 1 else 0 end)
      + (case when v.sampling_point is not null then 1 else 0 end)
      + (case when v.test_method    is not null then 1 else 0 end)
      + (case when v.grind_purpose  is not null then 1 else 0 end) as specificity
    from public.specification_versions v
    where v.status = 'approved'
      and v.approved_by is not null
      and v.parameter_key = v_parameter_key
      and v.stage = p_stage
      and v.effective_from <= p_collection_instant
      and (v.effective_to is null or v.effective_to > p_collection_instant)
      and (v.material_code  is null or lower(v.material_code)  = lower(coalesce(p_material_code, '')))
      and (v.feed_type_code is null or lower(v.feed_type_code) = lower(coalesce(p_feed_type_code, '')))
      and (v.sampling_point is null or lower(v.sampling_point) = lower(coalesce(p_sampling_point, '')))
      and (v.test_method    is null or lower(v.test_method)    = lower(coalesce(p_test_method, '')))
      and (v.grind_purpose  is null or lower(v.grind_purpose)  = lower(coalesce(p_grind_purpose, '')))
  )
  select count(*) into v_matches from candidates c where c.specificity = v_top_score;

  if v_matches > 1 then
    v_out.result := 'not_assessable';
    v_out.reason := 'ambiguous_rules';
    v_out.candidate_count := v_matches;
    v_out.explanation := v_matches
      || ' equally applicable approved limits were found. Ambiguity must be resolved by Quality before this test can be assessed.';
    return v_out;
  end if;

  with candidates as (
    select
      v.id, v.version, v.lower_bound, v.upper_bound, v.unit,
      (case when v.material_code  is not null then 1 else 0 end)
      + (case when v.feed_type_code is not null then 1 else 0 end)
      + (case when v.sampling_point is not null then 1 else 0 end)
      + (case when v.test_method    is not null then 1 else 0 end)
      + (case when v.grind_purpose  is not null then 1 else 0 end) as specificity
    from public.specification_versions v
    where v.status = 'approved'
      and v.approved_by is not null
      and v.parameter_key = v_parameter_key
      and v.stage = p_stage
      and v.effective_from <= p_collection_instant
      and (v.effective_to is null or v.effective_to > p_collection_instant)
      and (v.material_code  is null or lower(v.material_code)  = lower(coalesce(p_material_code, '')))
      and (v.feed_type_code is null or lower(v.feed_type_code) = lower(coalesce(p_feed_type_code, '')))
      and (v.sampling_point is null or lower(v.sampling_point) = lower(coalesce(p_sampling_point, '')))
      and (v.test_method    is null or lower(v.test_method)    = lower(coalesce(p_test_method, '')))
      and (v.grind_purpose  is null or lower(v.grind_purpose)  = lower(coalesce(p_grind_purpose, '')))
  )
  select c.id, c.version, c.lower_bound, c.upper_bound, c.unit
    into v_rule
  from candidates c
  where c.specificity = v_top_score;

  v_out.rule_id         := v_rule.id;
  v_out.rule_version    := v_rule.version;
  v_out.lower_bound     := v_rule.lower_bound;
  v_out.upper_bound     := v_rule.upper_bound;
  v_out.unit            := v_rule.unit;
  v_out.candidate_count := 1;

  -- No conversion table exists, so unit equivalence means unit equality. An
  -- approved conversion would be a reviewed change, never an inference here.
  if not public.is_unit_confirmed(v_rule.unit)
     or lower(btrim(v_rule.unit)) <> lower(btrim(p_unit)) then
    v_out.result := 'not_assessable';
    v_out.reason := 'unit_mismatch';
    v_out.explanation := 'The approved limit is expressed in '
      || coalesce(v_rule.unit, 'an unconfirmed unit')
      || ' but the result was recorded in ' || p_unit || '.';
    return v_out;
  end if;

  if v_rule.lower_bound is null and v_rule.upper_bound is null then
    v_out.result := 'not_assessable';
    v_out.reason := 'rule_has_no_bounds';
    v_out.explanation := 'The approved rule records no limit on either side.';
    return v_out;
  end if;

  v_bounds := case
    when v_rule.lower_bound is not null and v_rule.upper_bound is not null
      then v_rule.lower_bound::text || ' to ' || v_rule.upper_bound::text || ' ' || v_rule.unit
    when v_rule.lower_bound is not null
      then 'at least ' || v_rule.lower_bound::text || ' ' || v_rule.unit
    else 'at most ' || v_rule.upper_bound::text || ' ' || v_rule.unit
  end;

  -- BOUNDS ARE INCLUSIVE. For an approved 84-86 degC rule, 84 and 86 are
  -- Within Limit and 83.9 and 86.1 are Outside (UAT-06).
  if (v_rule.lower_bound is not null and p_numeric_value < v_rule.lower_bound)
     or (v_rule.upper_bound is not null and p_numeric_value > v_rule.upper_bound) then
    v_out.result := 'outside_limit';
    v_out.reason := 'outside_approved_bounds';
    v_out.explanation := p_numeric_value::text || ' ' || v_rule.unit
      || ' is outside the approved limit of ' || v_bounds || '.';
    return v_out;
  end if;

  v_out.result := 'within_limit';
  v_out.reason := 'within_approved_bounds';
  v_out.explanation := p_numeric_value::text || ' ' || v_rule.unit
    || ' is within the approved limit of ' || v_bounds || '.';
  return v_out;
end;
$function$;

revoke all on function public.evaluate_measurement(public.sample_stage, text, numeric, text, boolean, boolean, text, text, text, text, timestamptz, text) from public, anon, authenticated;


-- ---------------------------------------------------------------------------
-- 5. The three callers, each moved to the twelve-argument form.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.apply_measurement(p_sample_uuid uuid, p_field_key text, p_numeric_value numeric, p_text_value text, p_entered_text text, p_actor_id uuid, p_evaluation_kind text DEFAULT 'initial'::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_sample     public.samples;
  v_field      public.stage_fields;
  v_applicable boolean;
  v_outcome    public.assessment_outcome;
  v_id         uuid;
  v_previous   public.sample_measurements;
  v_version    text;
begin
  select * into v_sample from public.samples where id = p_sample_uuid;
  if v_sample.id is null then
    raise exception 'Unknown sample %', p_sample_uuid using errcode = '23503';
  end if;

  select * into v_field
  from public.stage_fields
  where stage = v_sample.stage and field_key = p_field_key;

  if v_field.field_key is null then
    raise exception 'Column % does not exist on the % form', p_field_key, v_sample.stage
      using errcode = '23503';
  end if;

  if v_field.field_type = 'system' or v_field.requiredness = 'system' then
    raise exception 'Column % is assigned by the server and cannot be submitted', p_field_key
      using errcode = '42501';
  end if;

  -- Controlled vocabulary: an unrecognised enum value is rejected, not stored
  -- and not silently normalised (PRD section 6.1).
  if v_field.select_options is not null and p_text_value is not null then
    if not (p_text_value = any (v_field.select_options)) then
      raise exception 'Value % is not a permitted option for %', p_text_value, p_field_key
        using errcode = '23514';
    end if;
  end if;

  -- Hard bounds are physical impossibilities, never acceptance limits.
  if p_numeric_value is not null then
    if v_field.hard_min is not null and p_numeric_value < v_field.hard_min then
      raise exception '% must not be below %', p_field_key, v_field.hard_min
        using errcode = '23514';
    end if;
    if v_field.hard_max is not null and p_numeric_value > v_field.hard_max then
      raise exception '% must not be above %', p_field_key, v_field.hard_max
        using errcode = '23514';
    end if;
  end if;

  -- A numeric column must receive a number, and a number must arrive with the
  -- text the operator typed so the entered precision survives.
  if v_field.field_type = 'number' and p_numeric_value is not null
     and coalesce(btrim(p_entered_text), '') = '' then
    raise exception 'A numeric result for % must carry the text as entered', p_field_key
      using errcode = '23514';
  end if;

  select * into v_previous
  from public.sample_measurements
  where sample_uuid = p_sample_uuid and field_key = p_field_key;

  v_applicable := public.is_field_applicable(p_sample_uuid, v_sample.stage, p_field_key);

  v_outcome := public.evaluate_measurement(
    v_sample.stage,
    p_field_key,
    p_numeric_value,
    v_field.unit,
    v_field.unit_confirmed,
    v_applicable,
    v_sample.material_code,
    null,
    v_sample.stage_detail,
    null,
    v_sample.collection_instant,
    v_sample.grind_purpose
  );

  insert into public.sample_measurements as m (
    sample_uuid, stage, field_key,
    numeric_value, text_value, entered_text,
    unit, unit_confirmed,
    assessment_result, assessment_reason, rule_id, rule_version, assessed_at,
    recorded_by
  )
  values (
    p_sample_uuid, v_sample.stage, p_field_key,
    p_numeric_value, p_text_value, p_entered_text,
    v_field.unit, coalesce(v_field.unit_confirmed, false),
    v_outcome.result, v_outcome.reason, v_outcome.rule_id, v_outcome.rule_version, now(),
    p_actor_id
  )
  on conflict (sample_uuid, field_key) do update
    set numeric_value     = excluded.numeric_value,
        text_value        = excluded.text_value,
        entered_text      = excluded.entered_text,
        unit              = excluded.unit,
        unit_confirmed    = excluded.unit_confirmed,
        assessment_result = excluded.assessment_result,
        assessment_reason = excluded.assessment_reason,
        rule_id           = excluded.rule_id,
        rule_version      = excluded.rule_version,
        assessed_at       = excluded.assessed_at,
        recorded_by       = excluded.recorded_by,
        revision          = m.revision + 1
  returning m.id into v_id;

  select c.value into v_version from public.system_config c where c.key = 'deployment_version';

  -- The assessment is appended as evidence every time, so a later limit change
  -- cannot rewrite a past decision (UAT-12).
  insert into public.assessments (
    sample_uuid, measurement_id, stage, field_key, parameter_key,
    measured_numeric, measured_entered_text, measured_unit,
    result, reason,
    rule_id, rule_version, rule_lower_bound, rule_upper_bound, rule_unit,
    candidate_count, explanation, evaluation_kind, evaluated_by, deployment_version
  )
  values (
    p_sample_uuid, v_id, v_sample.stage, p_field_key, v_field.parameter_key,
    p_numeric_value, p_entered_text, v_field.unit,
    v_outcome.result, v_outcome.reason,
    v_outcome.rule_id, v_outcome.rule_version, v_outcome.lower_bound,
    v_outcome.upper_bound, v_outcome.unit,
    v_outcome.candidate_count, v_outcome.explanation, p_evaluation_kind,
    p_actor_id, v_version
  );

  -- Amendment history. A correction records the old and the new value, which is
  -- what makes "preserve before/after audit history" true rather than claimed.
  if v_previous.id is not null then
    perform public.record_audit_event(
      'measurement.amended', 'sample_measurement', v_id::text, p_sample_uuid, null,
      jsonb_build_object(
        'field_key', p_field_key,
        'numeric_value', v_previous.numeric_value,
        'text_value', v_previous.text_value,
        'entered_text', v_previous.entered_text,
        'assessment_result', v_previous.assessment_result
      ),
      jsonb_build_object(
        'field_key', p_field_key,
        'numeric_value', p_numeric_value,
        'text_value', p_text_value,
        'entered_text', p_entered_text,
        'assessment_result', v_outcome.result
      ),
      null, 'succeeded', null, null, p_actor_id
    );
  end if;

  return v_id;
end;
$function$;

revoke all on function public.apply_measurement(uuid, text, numeric, text, text, uuid, text) from public, anon, authenticated;

CREATE OR REPLACE FUNCTION public.reassess_parameter(p_parameter_key text, p_actor uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
           s.material_code, s.stage_detail, s.collection_instant, s.grind_purpose
      from public.sample_measurements m
      join public.stage_fields f on f.stage = m.stage and f.field_key = m.field_key
      join public.samples s on s.id = m.sample_uuid
     where f.parameter_key = p_parameter_key
     order by m.sample_uuid, m.field_key
  loop
    v_outcome := public.evaluate_measurement(
      v_row.stage, v_row.field_key, v_row.numeric_value, v_row.unit, v_row.unit_confirmed,
      public.is_field_applicable(v_row.sample_uuid, v_row.stage, v_row.field_key),
      v_row.material_code, null, v_row.stage_detail, null, v_row.collection_instant,
      v_row.grind_purpose
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
$function$;

revoke all on function public.reassess_parameter(text, uuid) from public, anon, authenticated;

CREATE OR REPLACE FUNCTION public.tg_assess_derived_result()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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

  select s.material_code, s.stage_detail, s.collection_instant, s.grind_purpose into v_sample
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
    v_sample.collection_instant,
    v_sample.grind_purpose
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
$function$;

revoke all on function public.tg_assess_derived_result() from public, anon, authenticated;


-- ---------------------------------------------------------------------------
-- 5b. A FOURTH caller, which step 7's assertion found and I had not.
--
-- `rpc_review_sample` re-evaluates every measurement before accepting a
-- review and refuses the review if any verdict has moved since it was
-- recorded — a staleness guard, and a good one. It calls the engine too.
--
-- Nothing in the plan said so; the catalogue sweep in step 7 did, on the
-- first run of this migration, before anything shipped. Three callers was a
-- guess from grepping the migration I expected them to be in. The assertion
-- was written because a caller left on the old signature would fail at
-- runtime on an operator's review rather than here — and it earned its place
-- immediately.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rpc_review_sample(p_actor uuid, p_idempotency_key text, p_payload_hash text, p_app_version text, p_sample_uuid uuid, p_expected_revision integer, p_outcome text, p_claimed_assessments jsonb DEFAULT '[]'::jsonb, p_reason text DEFAULT NULL::text)
 RETURNS TABLE(sample_uuid uuid, sample_id text, revision integer, capture_state text, disposition text, outbox_event_id uuid, recorded_at timestamp with time zone, holds_raised jsonb, sheet_sync_state text, sheet_confirmed_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_basis   text;
  v_sample  public.samples;
  v_target  public.capture_state;
  v_row     record;
  v_fresh   public.assessment_outcome;
  v_claim   text;
  v_failure text;
begin
  v_basis := public.require_permission(p_actor, 'sample.review');
  perform public.claim_mutation(p_idempotency_key, 'review_sample', p_actor, p_payload_hash);

  if p_outcome not in ('reviewed', 'correction_required') then
    raise exception
      'BFF_BAD_OUTCOME: a review is recorded as reviewed or correction_required, not %', p_outcome
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

  -- Re-evaluate every measurement, and compare three ways: the fresh result
  -- against what is stored, and both against what the client claimed.
  for v_row in
    select m.field_key, m.numeric_value, m.assessment_result,
           f.unit, f.unit_confirmed, f.sheet_header, m.recorded_by
    from public.sample_measurements m
    join public.stage_fields f on f.stage = m.stage and f.field_key = m.field_key
    where m.sample_uuid = p_sample_uuid
    order by length(f.column_letter), f.column_letter
  loop
    v_fresh := public.evaluate_measurement(
      v_sample.stage,
      v_row.field_key,
      v_row.numeric_value,
      v_row.unit,
      v_row.unit_confirmed,
      public.is_field_applicable(p_sample_uuid, v_sample.stage, v_row.field_key),
      v_sample.material_code,
      null,
      v_sample.stage_detail,
      null,
      v_sample.collection_instant,
      v_sample.grind_purpose
    );

    if v_fresh.result is distinct from v_row.assessment_result then
      raise exception
        'BFF_ASSESSMENT_STALE: % now assesses as % but was recorded as %. Reload the sample before reviewing it.',
        v_row.sheet_header, v_fresh.result, v_row.assessment_result
        using errcode = '40001';
    end if;

    select c.value ->> 'result' into v_claim
    from jsonb_array_elements(coalesce(p_claimed_assessments, '[]'::jsonb)) as c(value)
    where c.value ->> 'field_key' = v_row.field_key;

    if v_claim is not null and v_claim <> v_fresh.result::text then
      raise exception
        'BFF_ASSESSMENT_STALE: the review claims % for % but the approved ruleset says %.',
        v_claim, v_row.sheet_header, v_fresh.result
        using errcode = '40001';
    end if;

    -- Separation of duties on an EXCEPTION. Reviewing your own clean result is
    -- ordinary work; signing off your own adverse finding is not.
    if v_fresh.result = 'outside_limit' then
      v_failure := public.separation_of_duties_failure(
        'review_exception', p_actor, v_row.recorded_by, null
      );
      if v_failure is not null then
        raise exception
          'BFF_SEPARATION_OF_DUTIES: % -- % was recorded by you and is outside the approved limit, so somebody else must review it.',
          v_failure, v_row.sheet_header
          using errcode = '42501';
      end if;
    end if;
  end loop;

  -- A claim for a field with no measurement at all is not a stale assessment,
  -- it is a claim about something that was never recorded. Refuse: accepting it
  -- would let a client assert a result for an empty column.
  if exists (
    select 1
    from jsonb_array_elements(coalesce(p_claimed_assessments, '[]'::jsonb)) as c(value)
    where not exists (
      select 1 from public.sample_measurements m
      where m.sample_uuid = p_sample_uuid
        and m.field_key = c.value ->> 'field_key'
    )
  ) then
    raise exception
      'BFF_ASSESSMENT_STALE: the review claims a result for a column that holds no measurement.'
      using errcode = '40001';
  end if;

  v_target := p_outcome::public.capture_state;
  perform public.assert_capture_transition(v_sample.capture_state, v_target, p_actor, p_reason);

  update public.samples
     set capture_state = v_target,
         revision      = v_sample.revision + 1
   where id = p_sample_uuid;

  perform public.record_audit_event(
    p_action             => 'sample.reviewed',
    p_entity_type        => 'sample',
    p_entity_id          => p_sample_uuid::text,
    p_sample_uuid        => p_sample_uuid,
    p_reason             => p_reason,
    p_before             => jsonb_build_object(
                              'capture_state', v_sample.capture_state,
                              'revision', v_sample.revision
                            ),
    p_after              => jsonb_build_object(
                              'capture_state', v_target,
                              'revision', v_sample.revision + 1
                            ),
    p_outcome            => 'succeeded',
    p_authority_basis    => v_basis,
    p_actor_id           => p_actor,
    p_deployment_version => p_app_version
  );

  perform public.mark_mutation_committed(p_idempotency_key, p_sample_uuid);

  return query
  select s.id, s.sample_id, s.revision, s.capture_state::text, s.disposition::text,
         null::uuid, s.updated_at, '[]'::jsonb,
         public.outbox_state_to_client(s.sheet_sync_state), s.sheet_confirmed_at
  from public.samples s where s.id = p_sample_uuid;
end;
$function$;


-- ---------------------------------------------------------------------------
-- 6. Now the old signature goes, so nothing can resolve to it by accident.
-- ---------------------------------------------------------------------------
drop function if exists public.evaluate_measurement(public.sample_stage, text, numeric, text, boolean, boolean, text, text, text, text, timestamptz);


-- ---------------------------------------------------------------------------
-- 6b. Carry the purpose onto the ground samples already on file.
-- ---------------------------------------------------------------------------
update public.sample_measurements
   set text_value = text_value
 where stage = 'ground' and field_key = 'material_or_feed_type';


-- ---------------------------------------------------------------------------
-- 7. Prove it, in the same transaction that did it.
--
-- The restatements above were produced mechanically, but "produced
-- mechanically" is a claim about a process. These are claims about the
-- database.
-- ---------------------------------------------------------------------------
do $$
declare
  v_bad text;
  v_n   integer;
begin
  -- a. THE OLD SIGNATURE IS GONE. Left behind it would be an overload every
  --    existing caller silently resolves to, ignoring the new dimension —
  --    the exact failure this migration exists to end.
  select count(*) into v_n
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'evaluate_measurement';
  if v_n <> 1 then
    raise exception
      'BFF_0044_OVERLOAD: % definitions of evaluate_measurement exist; there must be exactly 1',
      v_n using errcode = '22023';
  end if;

  -- b. EVERY CALLER PASSES TWELVE ARGUMENTS. A caller left on eleven would
  --    now fail at runtime rather than silently — but it would fail on an
  --    operator's measurement, in production, not here.
  select string_agg(p.proname, ', ') into v_bad
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    join pg_language l on l.oid = p.prolang
   where n.nspname = 'public' and l.lanname = 'plpgsql' and p.prokind = 'f'
     and pg_get_functiondef(p.oid) ~ 'evaluate_measurement\s*\('
     and p.proname <> 'evaluate_measurement'
     and pg_get_functiondef(p.oid) !~ 'grind_purpose';
  if v_bad is not null then
    raise exception
      'BFF_0044_CALLER: % calls evaluate_measurement without passing a grind purpose', v_bad
      using errcode = '22023';
  end if;

  -- c. THE IMMUTABILITY GUARANTEES OF THE RESTATED FUNCTIONS SURVIVED.
  --    `apply_measurement` is the privileged write path; a line lost in a
  --    159-line restatement is invisible in a diff that shows one change.
  select string_agg(x.missing, '; ') into v_bad
    from (
      select 'apply_measurement no longer refuses a system column' as missing
       where pg_get_functiondef('public.apply_measurement(uuid,text,numeric,text,text,uuid,text)'::regprocedure)
             !~ 'system'
      union all
      select 'apply_measurement no longer appends to assessments'
       where pg_get_functiondef('public.apply_measurement(uuid,text,numeric,text,text,uuid,text)'::regprocedure)
             !~ 'insert into public.assessments'
      union all
      select 'apply_measurement no longer records an amendment audit event'
       where pg_get_functiondef('public.apply_measurement(uuid,text,numeric,text,text,uuid,text)'::regprocedure)
             !~ 'measurement.amended'
      union all
      select 'evaluate_measurement lost its unconfirmed-unit gate'
       where pg_get_functiondef('public.evaluate_measurement(public.sample_stage,text,numeric,text,boolean,boolean,text,text,text,text,timestamptz,text)'::regprocedure)
             !~ 'unit_not_confirmed'
      union all
      select 'evaluate_measurement lost its ambiguous-rules refusal'
       where pg_get_functiondef('public.evaluate_measurement(public.sample_stage,text,numeric,text,boolean,boolean,text,text,text,text,timestamptz,text)'::regprocedure)
             !~ 'ambiguous_rules'
      union all
      select 'evaluate_measurement no longer requires an approver'
       where pg_get_functiondef('public.evaluate_measurement(public.sample_stage,text,numeric,text,boolean,boolean,text,text,text,text,timestamptz,text)'::regprocedure)
             !~ 'v.approved_by is not null'
    ) x;
  if v_bad is not null then
    raise exception 'BFF_0044_SURVIVED: %', v_bad using errcode = '22023';
  end if;

  -- d. The new filter and its specificity term are in ALL THREE CTEs. Two of
  --    three would make the engine find a candidate, score it, and then
  --    fetch a different one.
  select count(*) into v_n
    from regexp_matches(
      pg_get_functiondef('public.evaluate_measurement(public.sample_stage,text,numeric,text,boolean,boolean,text,text,text,text,timestamptz,text)'::regprocedure),
      'v\.grind_purpose  is null or', 'g');
  if v_n <> 3 then
    raise exception 'BFF_0044_CTE: the grind-purpose filter appears in % of 3 CTEs', v_n
      using errcode = '22023';
  end if;

  select count(*) into v_n
    from regexp_matches(
      pg_get_functiondef('public.evaluate_measurement(public.sample_stage,text,numeric,text,boolean,boolean,text,text,text,text,timestamptz,text)'::regprocedure),
      'when v\.grind_purpose  is not null', 'g');
  if v_n <> 3 then
    raise exception 'BFF_0044_SPEC: the specificity term appears in % of 3 CTEs', v_n
      using errcode = '22023';
  end if;

  -- e. The ground sample on file carried its purpose through.
  select string_agg(s.sample_id || ' purpose=' || coalesce(s.grind_purpose, 'null'), '; ')
    into v_bad
    from public.samples s
    join public.sample_measurements m
      on m.sample_uuid = s.id and m.field_key = 'material_or_feed_type'
   where s.stage = 'ground'
     and m.text_value in (select code from public.grind_purposes)
     and s.grind_purpose is null;
  if v_bad is not null then
    raise exception 'BFF_0044_BACKFILL: %', v_bad using errcode = '22023';
  end if;
end
$$;


-- ---------------------------------------------------------------------------
-- 8. And prove it DECIDES, end to end, rolled back.
--
-- Everything above is structural. This is the only assertion that shows the
-- fifth dimension actually selects between two rules — which is the whole
-- point, and which every structural check above would pass without.
-- ---------------------------------------------------------------------------
do $$
declare
  v_proposer uuid;
  v_approver uuid;
  v_sample   uuid;
  v_spec     uuid;
  v_corn     uuid;
  v_rice     uuid;
  v_result   public.assessment_result;
  v_rule     uuid;
begin
  select id into v_proposer from public.profiles order by created_at limit 1;
  select id into v_approver from public.profiles where id <> v_proposer order by created_at limit 1;
  if v_proposer is null or v_approver is null then
    raise notice 'BFF_0044: fewer than two profiles; probe skipped.';
    return;
  end if;

  begin
    insert into public.samples (
      sample_id, stage, prefix, collection_instant, collection_local_date,
      collection_local_time, created_by, registered_by, registered_at, capture_state,
      stage_detail, grind_purpose
    ) values (
      'ZZ-000000-44', 'ground', 'AM', now(), current_date, '00:00', v_proposer,
      v_proposer, now(), 'awaiting_results', 'AM', 'corn_pelleted'
    ) returning id into v_sample;

    -- A computed DGM of 1250 um: inside corn-for-pellets (1200-1300) and
    -- outside rice-for-pellets (950-1050). One number, two rules, and only
    -- the grind purpose can tell them apart.
    insert into public.sample_derived_results (sample_uuid, stage, result_key, numeric_value, display_text)
    values (v_sample, 'ground', 'dgm_um', 1250, '1250');

    select id into v_spec from public.specifications where parameter_key = 'ground.avg_particle_size';

    insert into public.specification_versions (
      specification_id, version, parameter_key, stage, unit, grind_purpose,
      lower_bound, upper_bound, status, effective_from, source_evidence, proposed_by, proposed_at
    ) values
      (v_spec, 901, 'ground.avg_particle_size', 'ground', 'µm', 'corn_pelleted',
       1200, 1300, 'proposed', now() - interval '10 years', '0044 probe. Rolled back.',
       v_proposer, now()),
      (v_spec, 902, 'ground.avg_particle_size', 'ground', 'µm', 'rice_pelleted',
       950, 1050, 'proposed', now() - interval '10 years', '0044 probe. Rolled back.',
       v_proposer, now());

    -- Re-selected rather than RETURNING: a two-row insert returns two rows,
    -- and `into` wants one.
    select id into v_corn from public.specification_versions where version = 901;
    select id into v_rice from public.specification_versions where version = 902;

    update public.specification_versions
       set status = 'approved', approved_by = v_approver, approved_at = now()
     where id in (v_corn, v_rice);

    select d.assessment_result, d.rule_id into v_result, v_rule
      from public.sample_derived_results d
     where d.sample_uuid = v_sample and d.result_key = 'dgm_um';

    -- a. It decided, and it chose the CORN rule. Without the new dimension
    --    both rules would be equally applicable and the answer would be
    --    `not_assessable / ambiguous_rules` — which is precisely the state
    --    the plant has been in.
    if v_result <> 'within_limit' or v_rule is distinct from v_corn then
      raise exception
        'BFF_0044_DECIDE: 1250 um on a corn-for-pellets sample assessed as % citing rule %; '
        'expected within_limit citing the corn rule', v_result, coalesce(v_rule::text, 'none')
        using errcode = '22023';
    end if;

    -- b. THE CONTROL. Change nothing but the purpose, and the same number
    --    must now fail against the rice rule. If it does not, the engine is
    --    matching on something else and (a) passed for the wrong reason.
    update public.samples set grind_purpose = 'rice_pelleted' where id = v_sample;
    update public.sample_derived_results set numeric_value = numeric_value
     where sample_uuid = v_sample and result_key = 'dgm_um';

    select d.assessment_result, d.rule_id into v_result, v_rule
      from public.sample_derived_results d
     where d.sample_uuid = v_sample and d.result_key = 'dgm_um';
    if v_result <> 'outside_limit' or v_rule is distinct from v_rice then
      raise exception
        'BFF_0044_CONTROL: the same 1250 um assessed as % citing % after switching the purpose '
        'to rice-for-pellets; expected outside_limit citing the rice rule',
        v_result, coalesce(v_rule::text, 'none') using errcode = '22023';
    end if;

    raise exception 'BFF_0044_ROLLBACK';
  exception
    when others then
      if sqlerrm <> 'BFF_0044_ROLLBACK' then raise; end if;
  end;

  raise notice 'BFF_0044: the grind purpose selects between two rules. Probe rolled back.';
end
$$;
