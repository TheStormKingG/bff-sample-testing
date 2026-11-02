-- ===========================================================================
-- 0034 — the grind gets a target, and the target gets a trail.
--
-- ---------------------------------------------------------------------------
-- THIS IS THE FIRST LIMIT IN THE SYSTEM
-- ---------------------------------------------------------------------------
-- Every screen in this application reports and declines to judge. `Limits` in
-- the workbook holds 34 figures and not one of them is approved, which is why
-- `DerivedResultsTable` says "no pass, no fail, no colour, no chip" and why
-- the particle-size chart said "there is no band to shade".
--
-- The owner has now set a target for DGM, and the design question was not
-- whether to have one but WHERE TO PUT IT. Two of the figures come from
-- published guidance that an auditor can look up; the rest have to come from
-- a nutritionist. A constant in a TypeScript file would have been half a
-- day's work and would have left "what was the target when that sample was
-- tested" answerable only by reading a git history that the quality system
-- does not own. So it is a configuration row with a writer, like the sieve
-- table in 0032, and for the same reason: the person who knows must be able
-- to change it without a deployment, and the change must be on the record.
--
-- ---------------------------------------------------------------------------
-- WHAT IS DELIBERATELY NOT SEEDED
-- ---------------------------------------------------------------------------
-- `ranges` is a PARTIAL map and ships with three of the five sieve forms set.
--
--   2 Ground  900–1200 µm   the two pre-pelleting targets, taken together
--   8 DGM     900–1200 µm   the same material, measured on the dedicated tab
--   7 Mash    1200–2000 µm  the mash-feed range
--
-- `6 Crumble` and `4 Pellets` are LEFT UNSET. The cited guidance covers the
-- grind before pelleting and mash feed; it gives no geometric-mean target for
-- a finished crumble or pellet, which the literature sizes by sieve cut
-- instead. Seeding a plausible-looking figure there would have painted a
-- green acceptance band across a quality record on the strength of nothing.
-- The admin screen shows those two as unset and asks for a figure, which an
-- administrator can supply in a minute — that is the whole point of this
-- migration existing rather than a constant.
--
-- ---------------------------------------------------------------------------
-- NO EDGE FUNCTION READS THIS
-- ---------------------------------------------------------------------------
-- Unlike the sieve table, this document is an input to nothing the server
-- computes or stores. It shades a region of a chart and orders three numbers
-- on a card. There is therefore no server-side reader to keep in step, and no
-- new `service_role` grant: `system_config` already carries one from 0032 and
-- this adds no second consumer of it.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. The row.
--
-- `operator_editable` is TRUE, which is the flag the writer below enforces.
-- ---------------------------------------------------------------------------

insert into public.system_config (key, value, description, operator_editable) values
  ('dgm_target_ranges',
   '{"version":1,"ranges":{'
     || '"ground":{"lowerMicrons":900,"upperMicrons":1200,'
     || '"basis":"Pre-pelleting grind, starter and grower/finisher targets taken together (Auburn University 2025 feed-milling guidance; Aviagen 2025 broiler nutrition supplement)."},'
     || '"dgm":{"lowerMicrons":900,"upperMicrons":1200,'
     || '"basis":"Pre-pelleting grind, starter and grower/finisher targets taken together (Auburn University 2025 feed-milling guidance; Aviagen 2025 broiler nutrition supplement)."},'
     || '"mash":{"lowerMicrons":1200,"upperMicrons":2000,'
     || '"basis":"Mash feed range (Auburn University 2025 feed-milling guidance; Aviagen 2025 broiler nutrition supplement)."}'
     || '}}',
   'The DGM range each sieve form is aiming at, in micrometres, with a note saying where the figures came from. Shown as a green band on the particle-size chart and as the two limits either side of the sample''s own figure. It is a TARGET for the miller, not a disposition: nothing in the application releases, rejects or holds a sample on the strength of it. A form absent from the map has no target and shows no band.',
   true)
on conflict (key) do nothing;


-- ---------------------------------------------------------------------------
-- 2. The writer.
--
-- The same three checks 0032 established: the permission, the editable flag,
-- and the audit of before and after. The validation re-states the browser's
-- rules in SQL because a value reaching this function has not passed through
-- `src/lib/dgmTargets.ts`, which runs in a browser and is not a control.
-- ---------------------------------------------------------------------------

create function public.rpc_set_dgm_target_ranges(
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
    p_actor       => p_actor,
    p_basis       => v_basis,
    p_app_version => p_app_version
  );

  return query
  select sc.key, sc.value, sc.updated_at
  from public.system_config sc
  where sc.key = v_key;
end;
$$;

comment on function public.rpc_set_dgm_target_ranges(uuid, text, text, text, jsonb, text) is
  'Replaces the per-form DGM target ranges under user.manage, refusing a target on a form with no sieve test, an inverted or absurd pair of figures, or a target with no stated source, and auditing the old and new document.';

revoke all on function public.rpc_set_dgm_target_ranges(uuid, text, text, text, jsonb, text)
  from public, anon, authenticated;
grant execute on function public.rpc_set_dgm_target_ranges(uuid, text, text, text, jsonb, text)
  to service_role;


-- ---------------------------------------------------------------------------
-- 3. Prove the seed is one this system would accept.
--
-- The row above is written by an INSERT, which runs none of the checks in the
-- function. A seed that the writer would refuse is the worst kind of
-- configuration: in force, unverifiable, and impossible to re-save.
-- ---------------------------------------------------------------------------

do $$
declare
  v_doc   jsonb;
  v_stage text;
  v_entry jsonb;
  v_has   boolean;
begin
  select sc.value::jsonb into v_doc from public.system_config sc where sc.key = 'dgm_target_ranges';
  if v_doc is null then
    raise exception 'dgm_target_ranges was not seeded.';
  end if;
  if (v_doc ->> 'version') is distinct from '1' then
    raise exception 'The seeded dgm_target_ranges is not version 1.';
  end if;

  for v_stage, v_entry in select * from jsonb_each(v_doc -> 'ranges')
  loop
    select exists (
      select 1 from public.stage_fields f
      where f.stage::text = v_stage and f.field_key = 'sieve1_tare_g'
    ) into v_has;
    if not v_has then
      raise exception 'The seeded target for % is on a form with no sieve test.', v_stage;
    end if;
    if (v_entry ->> 'upperMicrons')::numeric <= (v_entry ->> 'lowerMicrons')::numeric then
      raise exception 'The seeded target for % is inverted.', v_stage;
    end if;
    if coalesce(btrim(v_entry ->> 'basis'), '') = '' then
      raise exception 'The seeded target for % has no stated source.', v_stage;
    end if;
  end loop;
end;
$$;
