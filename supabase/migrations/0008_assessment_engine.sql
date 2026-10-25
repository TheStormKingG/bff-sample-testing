-- ===========================================================================
-- 0008_assessment_engine.sql
--
-- The server-side assessment engine, the sample snapshot, and the outbox
-- enqueue helper.
--
-- WHY THE ENGINE IS HERE AS WELL AS IN TYPESCRIPT.
-- src/lib/assessment.ts drives the UI so an operator sees the verdict as they
-- type. It is not the decision. "All client-originating inputs are untrusted,
-- including ... threshold values" (Master Prompt section 4), so the assessment
-- that is STORED is computed here, from the approved ruleset, using the unit
-- and the bounds the server looks up for itself. A client cannot submit an
-- assessment result at all.
--
-- The two implementations must agree. They are checked against each other by
-- the dry-run harness and by CI rather than by inspection.
-- ===========================================================================


-- A unit string that names no dimension cannot be compared against anything.
-- Mirrors UNCONFIRMED_UNIT_TOKENS in src/lib/assessment.ts. The live workbook
-- supplies the reason this is data-driven: entry 13's Unit cell contains the
-- literal string 'to confirm'.
create function public.is_unit_confirmed(p_unit text)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $$
  select p_unit is not null
     and lower(btrim(p_unit)) <> all (array['to confirm', 'tbc', 'unconfirmed', 'unknown', '']);
$$;


-- The shape of an evaluation, so the engine returns one value and every caller
-- stores the same evidence.
create type public.assessment_outcome as (
  result          public.assessment_result,
  reason          public.assessment_reason,
  rule_id         uuid,
  rule_version    integer,
  lower_bound     numeric,
  upper_bound     numeric,
  unit            text,
  candidate_count integer,
  explanation     text
);


-- ---------------------------------------------------------------------------
-- Applicability.
--
-- Mirrors isFieldApplicable(). The only conditional column in the registry is
-- `2 Ground` moisture, which applies when the sampling point is BC, so an AM
-- sample is not held back by a column that does not apply to it (UAT-02). The
-- implementation is generic: the controlling field is read from stage_fields,
-- and `sampling_point` resolves to the sample's own structured point code
-- rather than to a recorded measurement, because that is where it lives.
-- ---------------------------------------------------------------------------

create function public.is_field_applicable(
  p_sample_uuid uuid,
  p_stage       public.sample_stage,
  p_field_key   text
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_when_field  text;
  v_when_values text[];
  v_actual      text;
begin
  select f.applies_when_field, f.applies_when_values
    into v_when_field, v_when_values
  from public.stage_fields f
  where f.stage = p_stage and f.field_key = p_field_key;

  if v_when_field is null then
    return true;
  end if;

  if v_when_field = 'sampling_point' then
    select s.stage_detail into v_actual
    from public.samples s where s.id = p_sample_uuid;
  else
    select coalesce(m.text_value, m.entered_text) into v_actual
    from public.sample_measurements m
    where m.sample_uuid = p_sample_uuid and m.field_key = v_when_field;
  end if;

  return v_actual is not null and v_actual = any (v_when_values);
end;
$$;


-- ---------------------------------------------------------------------------
-- evaluate_measurement  the port of assess().
--
-- Order matters, and it is the same order as the TypeScript. Applicability and
-- absence are settled BEFORE any rule lookup, so a missing result can never be
-- reported as a limit decision. The unconfirmed-unit gate also runs before the
-- lookup, because the workbook's only bounded `Set` steam-pressure rule has
-- the literal unit 'to confirm': a lookup first would find a bounded rule and
-- compare against it (UAT-07, risk R-02).
--
-- `within_limit` is returned only when exactly one APPROVED, EFFECTIVE,
-- UNIT-COMPATIBLE, CONTEXT-MATCHED rule says so. Every other situation is
-- `not_assessable`. On the seeded production dataset that is every single
-- measurement, because 0 of the 34 workbook limits are approved. That is the
-- specified behaviour, not a defect to be worked around.
-- ---------------------------------------------------------------------------

create function public.evaluate_measurement(
  p_stage              public.sample_stage,
  p_field_key          text,
  p_numeric_value      numeric,
  p_unit               text,
  p_unit_confirmed     boolean,
  p_applicable         boolean,
  p_material_code      text,
  p_feed_type_code     text,
  p_sampling_point     text,
  p_test_method        text,
  p_collection_instant timestamptz
)
returns public.assessment_outcome
language plpgsql
stable
security definer
set search_path = ''
as $$
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
      + (case when v.test_method    is not null then 1 else 0 end) as specificity
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
      + (case when v.test_method    is not null then 1 else 0 end) as specificity
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
      + (case when v.test_method    is not null then 1 else 0 end) as specificity
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
$$;

comment on function public.evaluate_measurement is
  'Server-side port of assess() in src/lib/assessment.ts. Returns within_limit only for exactly one approved, effective, unit-compatible, context-matched rule.';


-- ---------------------------------------------------------------------------
-- apply_measurement  validate, assess and store one recorded column.
--
-- The unit, the unit-confirmed flag and the hard bounds come from
-- stage_fields, NOT from the caller. A client that submits
-- `unit: 'bar', unit_confirmed: true` for the steam-pressure column changes
-- nothing: the registry says that column's unit is unconfirmed, and the
-- registry is what the server reads.
-- ---------------------------------------------------------------------------

create function public.apply_measurement(
  p_sample_uuid    uuid,
  p_field_key      text,
  p_numeric_value  numeric,
  p_text_value     text,
  p_entered_text   text,
  p_actor_id       uuid,
  p_evaluation_kind text default 'initial'
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
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
    v_sample.collection_instant
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
$$;


-- ---------------------------------------------------------------------------
-- apply_hold_triggers  the automatic holds.
--
-- Any adverse visual observation forces a hold REGARDLESS of numeric results
-- (Master Prompt section 6, FR-010, UAT-08), and an approved out-of-limit
-- finding creates one. `not_assessable` does NOT create a hold: it blocks
-- automatic ACCEPTANCE, which is a different control and lives in the
-- disposition path.
--
-- Idempotent: it will not raise a second hold for a finding that already has
-- an uncleared one, so re-recording the same result does not pile up holds.
-- ---------------------------------------------------------------------------

create function public.apply_hold_triggers(
  p_sample_uuid uuid,
  p_actor_id    uuid
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_raised integer := 0;
  v_row    record;
begin
  -- Adverse yes/no observations.
  for v_row in
    select m.field_key, m.stage, f.sheet_header, m.text_value
    from public.sample_measurements m
    join public.stage_fields f on f.stage = m.stage and f.field_key = m.field_key
    where m.sample_uuid = p_sample_uuid
      and f.adverse_value is not null
      and lower(coalesce(m.text_value, '')) = lower(f.adverse_value)
      and not exists (
        select 1 from public.holds h
        where h.sample_uuid = p_sample_uuid
          and h.field_key = m.field_key
          and h.trigger_kind = 'adverse_observation'
          and h.cleared_at is null
      )
  loop
    insert into public.holds (
      sample_uuid, trigger_kind, stage, field_key, detail,
      raised_by, raised_authority, raise_reason
    )
    values (
      p_sample_uuid, 'adverse_observation', v_row.stage, v_row.field_key,
      v_row.sheet_header || ' answered Yes.',
      p_actor_id,
      'automatic:adverse_observation',
      'Automatic hold: an adverse visual observation holds the material regardless of numeric results.'
    );
    v_raised := v_raised + 1;
  end loop;

  -- Approved out-of-limit findings.
  for v_row in
    select m.field_key, m.stage, f.sheet_header, a.assessment_id, a.explanation
    from public.sample_measurements m
    join public.stage_fields f on f.stage = m.stage and f.field_key = m.field_key
    -- The LATEST assessment for this measurement, exactly one row. Matching on
    -- max(evaluated_at) would return two rows when two evaluations share an
    -- instant, and the loop would then raise two holds for one finding.
    cross join lateral (
      select a2.id as assessment_id, a2.explanation, a2.result
      from public.assessments a2
      where a2.measurement_id = m.id
      order by a2.evaluated_at desc, a2.id desc
      limit 1
    ) a
    where m.sample_uuid = p_sample_uuid
      and m.assessment_result = 'outside_limit'
      and a.result = 'outside_limit'
      and not exists (
        select 1 from public.holds h
        where h.sample_uuid = p_sample_uuid
          and h.field_key = m.field_key
          and h.trigger_kind = 'outside_approved_limit'
          and h.cleared_at is null
      )
  loop
    insert into public.holds (
      sample_uuid, trigger_kind, stage, field_key, detail, assessment_id,
      raised_by, raised_authority, raise_reason
    )
    values (
      p_sample_uuid, 'outside_approved_limit', v_row.stage, v_row.field_key,
      v_row.sheet_header || ': ' || v_row.explanation,
      v_row.assessment_id,
      p_actor_id,
      'automatic:outside_approved_limit',
      'Automatic hold: a result outside an approved limit.'
    );
    v_raised := v_raised + 1;
  end loop;

  if v_raised > 0 then
    perform public.record_audit_event(
      'hold.raised_automatically', 'sample', p_sample_uuid::text, p_sample_uuid,
      'Automatic quality hold', null,
      jsonb_build_object('holds_raised', v_raised),
      null, 'succeeded', null, 'automatic', p_actor_id
    );
  end if;

  return v_raised;
end;
$$;


-- ---------------------------------------------------------------------------
-- sample_snapshot  the payload an outbox event carries.
--
-- Deliberately a FIELD-KEYED snapshot, not a rendered spreadsheet row. The
-- column mapping lives in src/forms/sheetMapping.ts (toSheetRow), which is the
-- single source of truth for it (NFR-006); duplicating that mapping in SQL
-- would create a second place for it to drift. The Edge Function reads this
-- snapshot and calls toSheetRow() on it.
--
-- The snapshot is frozen at enqueue time, so what the worker eventually writes
-- is what was committed, not what the row looks like by then.
-- ---------------------------------------------------------------------------

create function public.sample_snapshot(p_sample_uuid uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_sample public.samples;
  v_fields jsonb;
begin
  select * into v_sample from public.samples where id = p_sample_uuid;
  if v_sample.id is null then
    raise exception 'Unknown sample %', p_sample_uuid using errcode = '23503';
  end if;

  select coalesce(jsonb_object_agg(m.field_key, jsonb_build_object(
           'numeric_value', m.numeric_value,
           -- entered_text is what the spreadsheet cell should show: it carries
           -- the operator's decimal precision, which the numeric would lose.
           'entered_text', m.entered_text,
           'text_value', m.text_value,
           'unit', m.unit,
           'assessment_result', m.assessment_result
         )), '{}'::jsonb)
    into v_fields
  from public.sample_measurements m
  where m.sample_uuid = p_sample_uuid;

  return jsonb_build_object(
    'sample_uuid', v_sample.id,
    'sample_id', v_sample.sample_id,
    'stage', v_sample.stage,
    'stage_detail', v_sample.stage_detail,
    'revision', v_sample.revision,
    -- The plant-local date and time are what belong in the operational log.
    'collection_local_date', v_sample.collection_local_date,
    'collection_local_time', to_char(v_sample.collection_local_time, 'HH24:MI'),
    'collection_instant', v_sample.collection_instant,
    'material_code', v_sample.material_code,
    'supplier_label', v_sample.supplier_label,
    'feed_type_label', v_sample.feed_type_label,
    'source_reference', v_sample.source_reference,
    'upstream_reference', v_sample.upstream_reference,
    'mill_screen_size', v_sample.mill_screen_size,
    'sampled_by_name', v_sample.sampled_by_name,
    'capture_state', v_sample.capture_state,
    'disposition', v_sample.disposition,
    'hold_flag', v_sample.hold_flag,
    'fields', v_fields
  );
end;
$$;


-- ---------------------------------------------------------------------------
-- enqueue_sheet_sync_event  exactly one event, in the caller's transaction.
--
-- Called from inside register_sample(), record_measurements() and the
-- correction path, so the event and the data it describes commit together or
-- not at all. There is no separate "now tell the worker" step that could be
-- lost (Master Prompt section 7).
--
-- ON CONFLICT DO NOTHING against the one-per-revision unique constraint, so a
-- replayed RPC enqueues nothing new rather than producing a second
-- spreadsheet row.
-- ---------------------------------------------------------------------------

create function public.enqueue_sheet_sync_event(
  p_sample_uuid uuid,
  p_event_kind  public.sheet_sync_event_kind
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sample   public.samples;
  v_tab      text;
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

  select d.sheet_tab into v_tab
  from public.stage_definitions d
  where d.stage = v_sample.stage;

  v_payload := public.sample_snapshot(p_sample_uuid);

  insert into public.sheet_sync_outbox (
    sample_uuid, target_tab, event_kind,
    payload_revision, payload_hash, payload,
    external_record_key
  )
  values (
    p_sample_uuid, v_tab, p_event_kind,
    v_sample.revision, public.payload_hash(v_payload), v_payload,
    v_sample.sample_id
  )
  on conflict (sample_uuid, event_kind, payload_revision) do nothing
  returning event_id into v_event_id;

  return v_event_id;
end;
$$;


-- ---------------------------------------------------------------------------
-- Function privileges.
--
-- Every signature revoked from PUBLIC by name. `apply_measurement`,
-- `apply_hold_triggers` and `enqueue_sheet_sync_event` are internal: they are
-- called by the RPCs in 0009-0012 and are granted to NO client role, because
-- each of them writes tables that a client must not be able to reach.
-- ---------------------------------------------------------------------------

-- NOT granted to `authenticated`, deliberately. All three were, and that was a
-- confidentiality defect: a brand-new Google sign-in sitting on the
-- pending-access screen already holds a role=authenticated JWT, so it could
-- POST /rest/v1/rpc/evaluate_measurement and read back approved bounds.
-- `evaluate_measurement` is SECURITY DEFINER and reads
-- public.specification_versions as the table owner, so row level security does
-- not apply inside it and the pending-account gate was bypassed entirely
-- ("a pending/suspended/disabled account can read NOTHING").
--
-- Removing the grant rather than adding a status check, for two reasons:
--
--  1. `service_role` is the only caller the design needs. Nothing in
--     src/, supabase/functions/ or the rest of supabase/migrations/ calls these
--     three names; the client-side engine that actually drives the UI is
--     src/lib/assessment.ts, and the server path reaches them through
--     public.apply_measurement, which runs under the service-role RPCs.
--  2. An `is_active_user()` guard could not be added to these three anyway. It
--     resolves the caller through auth.uid(), which is NULL on a service-role
--     connection, so the guard would reject the only legitimate caller while
--     leaving the PostgREST endpoint reachable. Withdrawing the grant removes
--     the endpoint instead of policing it.
revoke all on function public.is_unit_confirmed(text) from public;
revoke all on function public.is_unit_confirmed(text) from anon, authenticated;
grant execute on function public.is_unit_confirmed(text) to service_role;

revoke all on function public.is_field_applicable(uuid, public.sample_stage, text) from public;
revoke all on function public.is_field_applicable(uuid, public.sample_stage, text)
  from anon, authenticated;
grant execute on function public.is_field_applicable(uuid, public.sample_stage, text)
  to service_role;

revoke all on function public.evaluate_measurement(
  public.sample_stage, text, numeric, text, boolean, boolean, text, text, text, text, timestamptz
) from public;
revoke all on function public.evaluate_measurement(
  public.sample_stage, text, numeric, text, boolean, boolean, text, text, text, text, timestamptz
) from anon, authenticated;
grant execute on function public.evaluate_measurement(
  public.sample_stage, text, numeric, text, boolean, boolean, text, text, text, text, timestamptz
) to service_role;

revoke all on function public.apply_measurement(uuid, text, numeric, text, text, uuid, text) from public;
revoke all on function public.apply_hold_triggers(uuid, uuid) from public;

revoke all on function public.sample_snapshot(uuid) from public;
grant execute on function public.sample_snapshot(uuid) to service_role;

revoke all on function public.enqueue_sheet_sync_event(uuid, public.sheet_sync_event_kind) from public;
