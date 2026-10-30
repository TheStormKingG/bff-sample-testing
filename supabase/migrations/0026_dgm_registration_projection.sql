--
-- Give the eighth stage its arm in the registration projection.
--
-- THE DEFECT. `rpc_register_sample` projects two denormalised columns onto
-- `samples` for the search screen: `sample_label` (the feed type) and
-- `test_label` (the batch number). Both are filled by a `case p_stage` whose
-- arms were written when there were seven stages. A CASE with no matching WHEN
-- and no ELSE evaluates to NULL, so every DGM registration stored NULL in both
-- columns -- silently, because NULL is exactly what those columns legitimately
-- hold for a stage that has no such field, and both are nullable.
--
-- WHAT IT COST. Nothing authoritative: the per-column truth is the
-- `sample_measurements` rows, and `feed_type` and `batch_no` were written
-- there correctly, as they were to the workbook row. What broke is everything
-- reading the projection -- the Samples list renders a blank subtitle where
-- every other stage shows "feed type / batch", and the search box offering
-- "Sample ID, batch, lot or run number" cannot match a DGM batch number,
-- because it searches these columns.
--
-- WHY IT SHIPPED. `0025_dgm_stage.sql` added the stage, its 35 fields, its
-- prefix and its derived-results table, and the registry-to-database contract
-- test added alongside it compares `stage_definitions`, `stage_fields` and
-- `sample_prefixes` -- the DECLARATIVE tables. This projection is procedural,
-- buried in a CASE inside a 130-line function in a migration that predates the
-- stage, and no gate reads it. Two independent review lenses found it; nothing
-- mechanical did.
--
-- BACKFILL. A DGM sample WAS registered before this migration -- the live
-- end-to-end verification -- so at least one record already carries the NULL
-- the missing arms produced. The fix to the function does nothing for a row
-- already written, so the two columns are rebuilt from `sample_measurements`,
-- which is the authoritative per-column store and holds both values
-- correctly: `apply_submitted_values` wrote them there from the same payload
-- the CASE ignored.
--
-- The update is narrow on purpose. Only `stage = 'dgm'`, only where the
-- column is still NULL, so it cannot touch a record an operator later
-- corrected by hand, and cannot touch the seven stages that were never
-- affected.
--
-- The function below is 0013's definition verbatim, with two lines added. It
-- is reproduced in full because Postgres replaces a function wholesale, and
-- it is DROPPED first rather than replaced: tests/rpcContract.test.ts requires
-- that of every rpc_* redefinition, because this project has already been bitten
-- by a function whose return type `create or replace` cannot change. The drop
-- discards the ACL with the function, so the revoke and grant from 0013 are
-- restated at the foot of this file -- without them the service-role connection
-- that every registration runs on would lose execute and all eight stages would
-- stop registering, not just the one this migration fixes.
--

drop function public.rpc_register_sample(
  uuid, text, text, text, public.sample_stage, text, date, text, timestamptz, jsonb, text[], jsonb, text
);

create function public.rpc_register_sample(
  p_actor            uuid,
  p_idempotency_key  text,
  p_payload_hash     text,
  p_app_version      text,
  p_stage            public.sample_stage,
  p_prefix           text,
  p_collection_date  date,
  p_collection_time  text,
  p_collected_at     timestamptz,
  p_values           jsonb,
  p_row              text[],
  p_links            jsonb default '[]'::jsonb,
  p_notes            text default null
)
returns table (
  sample_uuid     uuid,
  sample_id       text,
  revision        integer,
  capture_state   text,
  outbox_event_id uuid,
  recorded_at     timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_basis        text;
  v_detail       text;
  v_prefix       text;
  v_sample_id    text;
  v_uuid         uuid;
  v_event_id     uuid;
  v_state        public.capture_state;
  v_time         time;
  v_link         jsonb;
  v_counterpart  uuid;
  v_recorded_at  timestamptz;
begin
  v_basis := public.require_permission(p_actor, 'sample.register');
  perform public.claim_mutation(p_idempotency_key, 'register_sample', p_actor, p_payload_hash);

  begin
    v_time := p_collection_time::time;
  exception when others then
    raise exception
      'BFF_BAD_TIME: % is not a plant-local time in HH:mm form', p_collection_time
      using errcode = '22023';
  end;

  -- The plant-local collection DATE is the sequence key, so a disagreement
  -- between the argument and the submitted value would file the sample under
  -- the wrong day and mint an identifier for it. Refuse rather than pick one.
  if (p_values ->> 'collection_date') is not null
     and (p_values ->> 'collection_date')::date <> p_collection_date then
    raise exception
      'BFF_DATE_DISAGREEMENT: the collection date argument (%) and the submitted value (%) differ',
      p_collection_date, p_values ->> 'collection_date'
      using errcode = '22023';
  end if;

  -- `2 Ground` is the only stage with a sampling point, and it is the only
  -- stage whose identifier prefix depends on one.
  if p_stage = 'ground' then
    v_detail := p_values ->> 'sampling_point';
    if v_detail is null then
      raise exception 'BFF_SAMPLING_POINT_REQUIRED: a ground sample is taken at AM or BC'
        using errcode = '22023';
    end if;
  else
    v_detail := null;
  end if;

  -- The prefix is DERIVED from (stage, sampling point) and never accepted. A
  -- client value that disagrees is reported rather than silently replaced: the
  -- identifier is the one durable fact about this record, and a client that
  -- computed it differently has a bug the operator needs to hear about.
  select sp.prefix into v_prefix
  from public.sample_prefixes sp
  where sp.stage = p_stage
    and sp.sampling_point is not distinct from v_detail;

  if v_prefix is null then
    raise exception
      'BFF_NO_PREFIX: no sample prefix is defined for stage % at sampling point %',
      p_stage, coalesce(v_detail, '(none)')
      using errcode = '23514';
  end if;

  if p_prefix is not null and p_prefix <> v_prefix then
    raise exception
      'BFF_PREFIX_DISAGREEMENT: this sample is %, not %', v_prefix, p_prefix
      using errcode = '22023';
  end if;

  -- Atomic. A single INSERT ... ON CONFLICT DO UPDATE ... RETURNING that takes
  -- a row lock on the counter before computing the successor, so 20 concurrent
  -- registrations on the same prefix and date receive 20 distinct identifiers.
  v_sample_id := public.allocate_sample_id(v_prefix, p_collection_date);

  insert into public.samples (
    sample_id, stage, stage_detail, prefix,
    collection_instant, collection_local_date, collection_local_time,
    material_code, supplier_label, feed_type_label,
    source_reference, upstream_reference, mill_screen_size, sampled_by_name,
    created_by, registered_by, registered_at,
    revision, capture_state
  )
  values (
    v_sample_id, p_stage, v_detail, v_prefix,
    p_collected_at, p_collection_date, v_time,
    -- The denormalised source context, for the search screen. The
    -- AUTHORITATIVE per-column values are the sample_measurements rows written
    -- below; these columns are a projection of them and the table constraints
    -- keep each one to the stage it belongs to.
    case when p_stage = 'raw_materials' then p_values ->> 'material' end,
    case when p_stage = 'raw_materials' then p_values ->> 'supplier' end,
    case p_stage
      when 'ground'        then p_values ->> 'material_or_feed_type'
      when 'conditioned'   then p_values ->> 'feed_type'
      when 'pellets'       then p_values ->> 'feed_type'
      when 'crumble'       then p_values ->> 'feed_type'
      when 'mash'          then p_values ->> 'feed_type'
      when 'dgm'           then p_values ->> 'feed_type'
    end,
    case p_stage
      when 'raw_materials' then p_values ->> 'delivery_or_lot_no'
      when 'ground'        then p_values ->> 'batch_or_bin_no'
      when 'conditioned'   then p_values ->> 'batch_no'
      when 'pellets'       then p_values ->> 'batch_no'
      when 'extruded_soya' then p_values ->> 'run_no'
      when 'crumble'       then p_values ->> 'batch_no'
      when 'mash'          then p_values ->> 'batch_no'
      when 'dgm'           then p_values ->> 'batch_no'
    end,
    case when p_stage = 'extruded_soya' then p_values ->> 'raw_soya_lot_no' end,
    case when p_stage = 'ground' then p_values ->> 'mill_screen_size_mm' end,
    p_values ->> 'sampled_by',
    -- created_by defaults to auth.uid(), which is NULL on the service-role
    -- connection these RPCs run on, so the verified actor is passed explicitly.
    p_actor, p_actor, now(),
    1, 'registered'
  )
  returning id, created_at into v_uuid, v_recorded_at;

  perform public.apply_submitted_values(v_uuid, p_stage, p_values, p_row, p_actor, 'initial');

  -- Any adverse visual observation forces a hold REGARDLESS of numeric
  -- results, and an approved out-of-limit finding creates one.
  perform public.apply_hold_triggers(v_uuid, p_actor);

  -- Registration performs the second leg too: "Registration moves straight on
  -- to awaiting results; a registered sample always has outstanding tests
  -- unless the QO filled them in the same visit." Both legs are checked against
  -- the transition whitelist, so landing on ready_for_review requires
  -- sample.enter_results and not merely sample.register.
  if public.sample_results_complete(v_uuid)
     and public.actor_has_permission(p_actor, 'sample.enter_results') then
    v_state := 'ready_for_review';
  else
    v_state := 'awaiting_results';
  end if;

  perform public.assert_capture_transition('registered', v_state, p_actor, null);

  update public.samples set capture_state = v_state where id = v_uuid;

  -- Declared traceability links. PRD section 6.4: "never automatically claim a
  -- one-to-one match. A MISSING UPSTREAM LINK IS A RECORDED EXCEPTION, NOT
  -- SILENT INFERENCE." So a reference is resolved ONLY against an immutable
  -- sample identifier -- which is a declaration, not an inference -- and
  -- anything else is written as a traceability exception naming what could not
  -- be resolved. Matching on a batch number would be the silent inference the
  -- PRD forbids, because one batch legitimately has many samples.
  for v_link in select * from jsonb_array_elements(coalesce(p_links, '[]'::jsonb))
  loop
    select s.id into v_counterpart
    from public.samples s
    where s.sample_id = v_link ->> 'reference';

    if v_counterpart is not null and v_counterpart <> v_uuid then
      insert into public.sample_links (
        link_type, from_sample, to_sample, relationship, match_basis, recorded_by
      )
      values (
        'upstream', v_uuid, v_counterpart,
        v_link ->> 'kind', v_link ->> 'reference', p_actor
      )
      on conflict do nothing;
    else
      insert into public.sample_links (
        link_type, from_sample, to_sample, relationship, exception_reason, recorded_by
      )
      values (
        'traceability_exception', v_uuid, null,
        v_link ->> 'kind',
        format(
          'The declared %s reference "%s" does not identify a single recorded sample, so no link is claimed.',
          v_link ->> 'kind', v_link ->> 'reference'
        ),
        p_actor
      )
      on conflict do nothing;
    end if;
  end loop;

  perform public.record_audit_event(
    p_action             => 'sample.registered',
    p_entity_type        => 'sample',
    p_entity_id          => v_uuid::text,
    p_sample_uuid        => v_uuid,
    p_reason             => null,
    p_before             => null,
    -- The free-text note is kept HERE and never in a legacy spreadsheet
    -- column: samples has no notes column by design.
    p_after              => jsonb_build_object(
                              'sample_id', v_sample_id,
                              'stage', p_stage,
                              'prefix', v_prefix,
                              'capture_state', v_state,
                              'notes', p_notes
                            ),
    p_outcome            => 'succeeded',
    p_authority_basis    => v_basis,
    p_actor_id           => p_actor,
    p_deployment_version => p_app_version
  );

  -- EXACTLY ONE event, in this transaction. The unique constraint on
  -- (sample, kind, revision) is what makes that structural.
  v_event_id := public.enqueue_sheet_sync_event(v_uuid, 'register', p_row);

  perform public.mark_mutation_committed(p_idempotency_key, v_uuid);

  return query
  select v_uuid, v_sample_id, s.revision, s.capture_state::text, v_event_id, v_recorded_at
  from public.samples s where s.id = v_uuid;
end;
$$;

-- ---------------------------------------------------------------------------
-- Backfill: records written while the arms were missing.
-- ---------------------------------------------------------------------------
update public.samples s
   set feed_type_label = m.text_value
  from public.sample_measurements m
 where m.sample_uuid = s.id
   and m.field_key   = 'feed_type'
   and s.stage       = 'dgm'
   and s.feed_type_label is null
   and m.text_value  is not null;

update public.samples s
   set source_reference = m.text_value
  from public.sample_measurements m
 where m.sample_uuid = s.id
   and m.field_key   = 'batch_no'
   and s.stage       = 'dgm'
   and s.source_reference is null
   and m.text_value  is not null;

-- Report what moved, so a run on a database with no such rows is visibly a
-- no-op rather than an unexamined success.
do $$
declare n_blank int;
begin
  select count(*) into n_blank
    from public.samples
   where stage = 'dgm'
     and (feed_type_label is null or source_reference is null);
  if n_blank > 0 then
    raise notice
      'DGM samples still missing a projection value: % (expected only where the '
      'measurement itself is absent)', n_blank;
  else
    raise notice 'Every DGM sample now carries both projection values.';
  end if;
end $$;

-- The ACL went with the dropped function. These two statements are 0013's,
-- unchanged, and they are what keeps registration working at all.
revoke all on function public.rpc_register_sample(
  uuid, text, text, text, public.sample_stage, text, date, text, timestamptz, jsonb, text[], jsonb, text
) from public, anon, authenticated;
grant execute on function public.rpc_register_sample(
  uuid, text, text, text, public.sample_stage, text, date, text, timestamptz, jsonb, text[], jsonb, text
) to service_role;

-- Re-run anyway: the whole point of this migration is that an unexercised
-- path went unnoticed, and a dropped-and-recreated function is exactly where
-- a grant goes missing.
do $$ begin perform public.assert_function_privileges(); end $$;
