-- ===========================================================================
-- 0035 — the two configuration writers could never write, and nothing noticed.
--
-- ---------------------------------------------------------------------------
-- WHAT WAS WRONG
-- ---------------------------------------------------------------------------
-- `record_audit_event` takes `p_actor_id`, `p_authority_basis` and
-- `p_deployment_version`. Both `rpc_set_sieve_series` (0032) and
-- `rpc_set_dgm_target_ranges` (0034) called it with `p_actor`, `p_basis` and
-- `p_app_version` — three names that exist on no overload — so every call
-- raised 42883 at the LAST statement before the return:
--
--     function public.record_audit_event(p_action => unknown, ... ,
--     p_actor => uuid, p_basis => text, p_app_version => text) does not exist
--
-- The administrator saw "Something went wrong. Nothing was saved." and
-- nothing was saved, which is the correct behaviour for a function that
-- cannot finish — the whole call is one transaction, so the configuration
-- row was never left changed without its audit event. The defect was that
-- the function could NEVER finish. `select count(*) from audit_events where
-- action in ('sieve_series.updated','dgm_target_ranges.updated')` returned
-- zero: neither writer had ever succeeded, on any deployment.
--
-- ---------------------------------------------------------------------------
-- WHY EVERY GATE MISSED IT, AND WHAT NOW CATCHES IT
-- ---------------------------------------------------------------------------
-- plpgsql resolves a called function's NAME at execution, not at `create`
-- time, so a wrong argument name is accepted by the server, type-checks
-- clean, deploys clean and passes every TypeScript test — this repository
-- has 1280 of them and not one executes SQL. 0032 shipped on 2026-11-02 and
-- its editor was simply unusable until somebody pressed Save.
--
-- Two things close it. `tests/auditCallContract.test.ts` reads every
-- migration, finds each `record_audit_event(...)` call and compares its named
-- arguments against the parameter list of the function's own `create` —
-- statically, so it runs in the ordinary suite. And the block at the end of
-- this file asks the LIVE catalogue the same question about every function in
-- the schema, so this migration cannot apply while a call site is still
-- wrong, including one no migration in this repository wrote.
--
-- Nothing else changes: the bodies below are 0032's and 0034's, verbatim,
-- with three argument names corrected.
-- ===========================================================================


create or replace function public.rpc_set_sieve_series(
  p_actor           uuid,
  p_idempotency_key text,
  p_payload_hash    text,
  p_app_version     text,
  p_table           jsonb,
  p_reason          text
)
returns table (
  key         text,
  value       text,
  updated_at  timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_basis    text;
  v_key      text := 'sieve_series';
  v_editable boolean;
  v_before   text;
  v_count    integer;
  v_prev     numeric := null;
  v_entry    jsonb;
  v_aperture numeric;
  v_tare     numeric;
  v_abnt     text;
  v_index    integer := 0;
  v_expected integer;
begin
  v_basis := public.require_permission(p_actor, 'user.manage');
  perform public.claim_mutation(
    p_idempotency_key, 'set_sieve_series', p_actor, p_payload_hash
  );

  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'BFF_REASON_REQUIRED: record why the sieve table is changing'
      using errcode = '22023';
  end if;

  -- The editable flag is the gate 0005's comment promised. A key without it
  -- is refused here rather than by convention.
  select sc.operator_editable, sc.value into v_editable, v_before
  from public.system_config sc
  where sc.key = v_key;

  if v_editable is null then
    raise exception 'BFF_UNKNOWN_CONFIG: "%" is not a configuration key', v_key
      using errcode = '22023';
  end if;
  if v_editable is not true then
    raise exception 'BFF_CONFIG_NOT_EDITABLE: "%" may not be changed from the application', v_key
      using errcode = '22023';
  end if;

  if p_table is null or jsonb_typeof(p_table) <> 'object' then
    raise exception 'BFF_SIEVE_TABLE_SHAPE: the sieve table must be an object'
      using errcode = '22023';
  end if;
  if (p_table ->> 'version') is distinct from '1' then
    raise exception 'BFF_SIEVE_TABLE_VERSION: unsupported sieve table version %',
      coalesce(p_table ->> 'version', 'null') using errcode = '22023';
  end if;
  if jsonb_typeof(p_table -> 'positions') <> 'array' then
    raise exception 'BFF_SIEVE_TABLE_SHAPE: the sieve table needs a positions array'
      using errcode = '22023';
  end if;

  -- The stack width is a property of the METHOD, not of the table: kj runs
  -- 6..0 by position and the uniformity bands are three fixed SUM ranges over
  -- seven sieves. Read from the registry mirror rather than written here, so
  -- the two cannot disagree.
  select count(*) into v_expected
  from public.stage_fields f
  where f.stage = 'dgm' and f.field_key ~ '^sieve[0-9]+_tare_g$';

  v_count := jsonb_array_length(p_table -> 'positions');
  if v_count <> v_expected then
    raise exception 'BFF_SIEVE_TABLE_COUNT: the sieve table must have exactly % positions, got %',
      v_expected, v_count using errcode = '22023';
  end if;

  for v_entry in select * from jsonb_array_elements(p_table -> 'positions')
  loop
    v_index := v_index + 1;

    v_abnt := btrim(coalesce(v_entry ->> 'abnt', ''));
    if v_abnt = '' then
      raise exception 'BFF_SIEVE_TABLE_ABNT: position % has no ABNT designation', v_index
        using errcode = '22023';
    end if;
    if length(v_abnt) > 12 then
      raise exception 'BFF_SIEVE_TABLE_ABNT: position %''s designation is longer than 12 characters',
        v_index using errcode = '22023';
    end if;

    begin
      v_aperture := (v_entry ->> 'apertureMicrons')::numeric;
      v_tare     := (v_entry ->> 'tareDefaultGrams')::numeric;
    exception when others then
      raise exception 'BFF_SIEVE_TABLE_NUMBER: position % has a value that is not a number', v_index
        using errcode = '22023';
    end;

    if v_aperture is null or not (v_aperture > 0) then
      raise exception 'BFF_SIEVE_TABLE_APERTURE: position % has no usable aperture', v_index
        using errcode = '22023';
    end if;
    if v_tare is null or v_tare < 0 or v_tare > 2000 then
      raise exception 'BFF_SIEVE_TABLE_TARE: position %''s empty weight must be between 0 and 2000 g',
        v_index using errcode = '22023';
    end if;

    -- See the header: this is the rule that protects the arithmetic.
    if v_prev is not null and v_aperture >= v_prev then
      raise exception
        'BFF_SIEVE_TABLE_ORDER: position % (% µm) is not finer than the one above it (% µm). A sieve stack runs coarsest at the top.',
        v_index, v_aperture, v_prev using errcode = '22023';
    end if;
    v_prev := v_aperture;
  end loop;

  update public.system_config sc
     set value      = p_table::text,
         updated_by = p_actor
   where sc.key = v_key;

  perform public.record_audit_event(
    p_action      => 'sieve_series.updated',
    p_entity_type => 'system_config',
    p_entity_id   => v_key,
    p_reason      => btrim(p_reason),
    -- BEFORE AND AFTER BOTH. This table decides what every future sieve test
    -- is measured against, so "what did it say when that sample was tested"
    -- has to be answerable from the trail alone.
    p_before      => jsonb_build_object('value', v_before),
    p_after       => jsonb_build_object('value', p_table),
    p_actor_id           => p_actor,
    p_authority_basis    => v_basis,
    p_deployment_version => p_app_version
  );

  return query
  select sc.key, sc.value, sc.updated_at
  from public.system_config sc
  where sc.key = v_key;
end;
$$;

create or replace function public.rpc_set_dgm_target_ranges(
  p_actor           uuid,
  p_idempotency_key text,
  p_payload_hash    text,
  p_app_version     text,
  p_document        jsonb,
  p_reason          text
)
returns table (
  key         text,
  value       text,
  updated_at  timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_basis    text;
  v_key      text := 'dgm_target_ranges';
  v_editable boolean;
  v_before   text;
  v_stage    text;
  v_entry    jsonb;
  v_lower    numeric;
  v_upper    numeric;
  v_note     text;
  v_has      boolean;
begin
  v_basis := public.require_permission(p_actor, 'user.manage');
  perform public.claim_mutation(
    p_idempotency_key, 'set_dgm_target_ranges', p_actor, p_payload_hash
  );

  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'BFF_REASON_REQUIRED: record why the DGM targets are changing'
      using errcode = '22023';
  end if;

  select sc.operator_editable, sc.value into v_editable, v_before
  from public.system_config sc
  where sc.key = v_key;

  if v_editable is null then
    raise exception 'BFF_UNKNOWN_CONFIG: "%" is not a configuration key', v_key
      using errcode = '22023';
  end if;
  if v_editable is not true then
    raise exception 'BFF_CONFIG_NOT_EDITABLE: "%" may not be changed from the application', v_key
      using errcode = '22023';
  end if;

  if p_document is null or jsonb_typeof(p_document) <> 'object' then
    raise exception 'BFF_DGM_TARGET_SHAPE: the DGM targets must be an object'
      using errcode = '22023';
  end if;
  if (p_document ->> 'version') is distinct from '1' then
    raise exception 'BFF_DGM_TARGET_VERSION: unsupported DGM target version %',
      coalesce(p_document ->> 'version', 'null') using errcode = '22023';
  end if;
  if jsonb_typeof(p_document -> 'ranges') <> 'object' then
    raise exception 'BFF_DGM_TARGET_SHAPE: the DGM targets need a ranges object'
      using errcode = '22023';
  end if;

  for v_stage, v_entry in select * from jsonb_each(p_document -> 'ranges')
  loop
    -- A target may only be set on a form that actually weighs a sieve stack.
    -- Read from the registry mirror rather than from a list written here, so
    -- a sixth sieve tab needs no edit to this function and a form without one
    -- cannot be given a setting that would never be drawn.
    select exists (
      select 1 from public.stage_fields f
      -- `stage` is the `sample_stage` ENUM and `v_stage` is a key out of a
      -- JSON object, so the comparison is made on text. Casting the other way
      -- would raise `invalid_text_representation` on a key that is not a
      -- member — a bare 22P02 where this function owes the caller a sentence
      -- saying which form it did not recognise.
      where f.stage::text = v_stage and f.field_key = 'sieve1_tare_g'
    ) into v_has;

    if not v_has then
      raise exception 'BFF_DGM_TARGET_STAGE: the % form has no sieve test, so it produces no DGM',
        v_stage using errcode = '22023';
    end if;

    if jsonb_typeof(v_entry) <> 'object' then
      raise exception 'BFF_DGM_TARGET_SHAPE: the target for % is not an object', v_stage
        using errcode = '22023';
    end if;

    begin
      v_lower := (v_entry ->> 'lowerMicrons')::numeric;
      v_upper := (v_entry ->> 'upperMicrons')::numeric;
    exception when others then
      raise exception 'BFF_DGM_TARGET_NUMBER: the target for % has a value that is not a number',
        v_stage using errcode = '22023';
    end;

    if v_lower is null or not (v_lower > 0) then
      raise exception 'BFF_DGM_TARGET_BOUND: the target for % has no usable lower figure', v_stage
        using errcode = '22023';
    end if;
    if v_upper is null or not (v_upper > 0) then
      raise exception 'BFF_DGM_TARGET_BOUND: the target for % has no usable upper figure', v_stage
        using errcode = '22023';
    end if;

    -- An inverted pair would not fail anywhere else: it would shade a band of
    -- zero width and report every sample as outside it, which looks like a
    -- result rather than a mistake.
    if v_upper <= v_lower then
      raise exception
        'BFF_DGM_TARGET_ORDER: the target for % has its upper figure (% µm) at or below its lower figure (% µm)',
        v_stage, v_upper, v_lower using errcode = '22023';
    end if;
    if v_upper > 20000 then
      raise exception 'BFF_DGM_TARGET_RANGE: the target for % is above 20000 µm, which is a mis-keyed decimal point',
        v_stage using errcode = '22023';
    end if;

    -- The screen prints this beside the figures. A target shown with no
    -- stated origin invites a reader to take it for an approved specification.
    v_note := btrim(coalesce(v_entry ->> 'basis', ''));
    if v_note = '' then
      raise exception 'BFF_DGM_TARGET_BASIS: the target for % does not say where its figures came from',
        v_stage using errcode = '22023';
    end if;
    if length(v_note) > 300 then
      raise exception 'BFF_DGM_TARGET_BASIS: the source note for % is longer than 300 characters',
        v_stage using errcode = '22023';
    end if;
  end loop;

  update public.system_config sc
     set value      = p_document::text,
         updated_by = p_actor
   where sc.key = v_key;

  perform public.record_audit_event(
    p_action      => 'dgm_target_ranges.updated',
    p_entity_type => 'system_config',
    p_entity_id   => v_key,
    p_reason      => btrim(p_reason),
    -- BEFORE AND AFTER BOTH. This is the figure a reader of an old record
    -- will measure that record against, so the trail has to be able to say
    -- what it was on the day.
    p_before      => jsonb_build_object('value', v_before),
    p_after       => jsonb_build_object('value', p_document),
    p_actor_id           => p_actor,
    p_authority_basis    => v_basis,
    p_deployment_version => p_app_version
  );

  return query
  select sc.key, sc.value, sc.updated_at
  from public.system_config sc
  where sc.key = v_key;
end;
$$;

-- ---------------------------------------------------------------------------
-- The live check. Not "did I fix the two I know about" — "does any function
-- in this schema name an argument of `record_audit_event` that the function
-- does not have". That is the question whose answer was wrong for two days.
-- ---------------------------------------------------------------------------

do $$
declare
  v_params text[];
  v_bad    text;
begin
  select p.proargnames into v_params
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'record_audit_event';

  if v_params is null then
    raise exception 'record_audit_event has no named parameters to check against.';
  end if;

  select string_agg(format('%s uses %s', f.name, f.arg), '; ' order by f.name, f.arg)
    into v_bad
  from (
    select d.name,
           btrim((regexp_matches(d.src, '(p_[a-z_]+)\s*=>', 'g'))[1]) as arg
    from (
      -- `pg_get_functiondef` RAISES on an aggregate and on several internal
      -- forms, so the set it is applied to is narrowed first, in its own
      -- subquery. A WHERE clause beside the call is not enough: the planner
      -- may evaluate the call before the filter, and the first attempt here
      -- died on `array_agg`.
      select p.proname as name, pg_get_functiondef(p.oid) as src
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      join pg_language l on l.oid = p.prolang
      where n.nspname = 'public' and p.prokind = 'f' and l.lanname = 'plpgsql'
    ) d
    where d.src like '%record_audit_event%'
  ) f
  -- Every named argument in a body that calls `record_audit_event` must be a
  -- parameter of SOMETHING callable. Restricting the comparison to that one
  -- function's parameters is deliberate over-reach: a body that calls it is
  -- the only place this project uses named-argument syntax at all, so a name
  -- outside its parameter list is a defect even if some other function
  -- happens to have it.
  where not (f.arg = any(v_params));

  if v_bad is not null then
    raise exception
      'A function names an argument record_audit_event does not have: %. Its parameters are %.',
      v_bad, array_to_string(v_params, ', ')
      using errcode = '42883';
  end if;
end;
$$;
