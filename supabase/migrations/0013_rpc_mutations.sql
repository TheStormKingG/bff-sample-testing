-- ---------------------------------------------------------------------------
-- 0013_rpc_mutations.sql
--
-- The five mutating RPCs, each ONE transaction:
--
--   rpc_register_sample   rpc_update_results   rpc_review_sample
--   rpc_set_disposition   rpc_approve_specification
--
-- Every one of them re-derives authority from the database, re-derives the
-- state machine, re-derives the release blockers and re-evaluates the
-- assessments. The client-side equivalents in src/lib/workflow.ts and
-- src/lib/assessment.ts are there so the operator sees the answer before
-- pressing save; they are not the control, and nothing a client claims is
-- believed here.
--
-- Argument names come from the call sites, which are named in a comment on
-- each function. PostgREST passes named arguments, so a renamed parameter is a
-- PGRST202 at runtime rather than a compile error anywhere.
-- ---------------------------------------------------------------------------


-- ---------------------------------------------------------------------------
-- The capture-state whitelist, server side.
--
-- A literal mirror of TRANSITIONS in src/lib/workflow.ts, including the
-- permission and the reason requirement for each move. It is a WHITELIST: a
-- pair that is not listed is denied, so a capture_state added later cannot
-- quietly become reachable by everybody.
-- ---------------------------------------------------------------------------

create function public.assert_capture_transition(
  p_from   public.capture_state,
  p_to     public.capture_state,
  p_actor  uuid,
  p_reason text
)
returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  v_permission      public.app_permission;
  v_requires_reason boolean;
begin
  if p_from = p_to then
    return null;
  end if;

  -- A voided sample is terminal, checked before the whitelist so the message
  -- says why rather than "not allowed".
  if p_from = 'voided' then
    raise exception
      'BFF_TERMINAL_STATE: a voided sample cannot change state. Register a new sample instead.'
      using errcode = '23514';
  end if;

  select t.permission, t.requires_reason into v_permission, v_requires_reason
  from (values
    ('draft',               'registered',          'sample.register',     false),
    ('draft',               'voided',              'sample.void',         true),
    ('registered',          'awaiting_results',    'sample.register',     false),
    ('registered',          'ready_for_review',    'sample.enter_results', false),
    ('awaiting_results',    'ready_for_review',    'sample.enter_results', false),
    ('awaiting_results',    'correction_required', 'sample.review',       true),
    ('awaiting_results',    'voided',              'sample.void',         true),
    ('ready_for_review',    'reviewed',            'sample.review',       false),
    ('ready_for_review',    'correction_required', 'sample.review',       true),
    ('ready_for_review',    'awaiting_results',    'sample.enter_results', true),
    ('ready_for_review',    'voided',              'sample.void',          true),
    -- A reviewed sample is corrected through a NEW reasoned event, never by
    -- silently reopening it (PRD section 11, FR-013).
    ('reviewed',            'correction_required', 'sample.correct',      true),
    ('reviewed',            'voided',              'sample.void',         true),
    ('correction_required', 'awaiting_results',    'sample.enter_results', true),
    ('correction_required', 'ready_for_review',    'sample.enter_results', true),
    ('correction_required', 'voided',              'sample.void',          true)
  ) as t(from_state, to_state, permission, requires_reason)
  where t.from_state = p_from::text
    and t.to_state = p_to::text;

  if v_permission is null then
    raise exception
      'BFF_TRANSITION_NOT_ALLOWED: % cannot move directly to %', p_from, p_to
      using errcode = '23514';
  end if;

  if v_requires_reason and coalesce(btrim(p_reason), '') = '' then
    raise exception
      'BFF_REASON_REQUIRED: moving % to % needs a written reason, which is recorded in the sample history.',
      p_from, p_to
      using errcode = '22023';
  end if;

  return public.require_permission(p_actor, v_permission);
end;
$$;


-- ---------------------------------------------------------------------------
-- The idempotency claim, inside a mutation's own transaction.
--
-- The Edge Functions claim the key through rpc_begin_idempotent_request before
-- invoking a mutation, so the normal path arrives here with the claim already
-- recorded by this same actor for this same payload. This function is what
-- makes the mutation safe WITHOUT that: calling the RPC twice directly cannot
-- create two samples, because the second call finds a succeeded record and is
-- refused rather than running.
--
-- It must therefore accept its own caller's live claim and refuse everything
-- else. Returns nothing; it either permits the mutation to proceed or raises.
-- ---------------------------------------------------------------------------

create function public.claim_mutation(
  p_key          text,
  p_operation    text,
  p_actor        uuid,
  p_payload_hash text
)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_row public.idempotency_requests;
begin
  if coalesce(btrim(p_key), '') = '' then
    raise exception
      'BFF_IDEMPOTENCY_KEY_REQUIRED: every save must carry an idempotency key so a retry cannot create a second record'
      using errcode = '22023';
  end if;

  -- FOR UPDATE: two concurrent calls on one key serialise here, and the loser
  -- re-reads the winner's row after the lock is released rather than deciding
  -- from a stale read.
  select * into v_row
  from public.idempotency_requests
  where idempotency_key = p_key
  for update;

  if v_row.request_id is null then
    insert into public.idempotency_requests (
      idempotency_key, operation, actor_id, payload_hash, outcome, response_payload
    )
    values (p_key, p_operation, p_actor, p_payload_hash, 'in_progress', null);
    return;
  end if;

  -- Identity before payload. A key presented by a different person is not a
  -- retry at all, so it must never reach the branch that compares payloads.
  if v_row.actor_id <> p_actor then
    raise exception 'BFF_IDEMPOTENCY_CONFLICT: actor_mismatch' using errcode = '42501';
  end if;
  if v_row.operation <> p_operation then
    raise exception 'BFF_IDEMPOTENCY_CONFLICT: operation_mismatch' using errcode = '22023';
  end if;
  if v_row.payload_hash <> p_payload_hash then
    raise exception 'BFF_IDEMPOTENCY_CONFLICT: payload_mismatch' using errcode = '22023';
  end if;

  -- The work under this key ALREADY COMMITTED, even if its response was never
  -- stored. This is the branch that stops a retry creating a second record: the
  -- Edge Function claims the key, calls this mutation, and stores the response
  -- in a separate call, so between the second and the third the row still reads
  -- `in_progress` while the sample exists.
  if v_row.committed_at is not null then
    raise exception
      'BFF_IDEMPOTENT_REPLAY: key % already committed at %', p_key, v_row.committed_at
      using errcode = '23505';
  end if;

  if v_row.outcome = 'succeeded' then
    -- The work is already done and its response is stored. The Edge Function
    -- replays that body; a direct caller is told, rather than being given a
    -- second sample.
    raise exception 'BFF_IDEMPOTENT_REPLAY: key % already completed', p_key
      using errcode = '23505';
  end if;

  -- 'in_progress' owned by this actor for this payload is this very request --
  -- the claim the Edge Function recorded a moment ago -- and 'failed' left
  -- nothing committed, so both proceed.
  update public.idempotency_requests
     set outcome = 'in_progress', completed_at = null, updated_at = now()
   where idempotency_key = p_key;
end;
$$;


-- ---------------------------------------------------------------------------
-- Mark the key's work as committed.
--
-- Called as the LAST statement of every mutation RPC, inside the same
-- transaction, so the marker and the record it describes commit together. If
-- the mutation rolls back so does this, and the key is free to be retried --
-- which is correct, because nothing was written.
--
-- It does NOT set `outcome = 'succeeded'`: that state promises the stored
-- response can be replayed verbatim, and a mutation RPC has no HTTP body to
-- store. rpc_complete_idempotent_request does that afterwards, with the real
-- one.
-- ---------------------------------------------------------------------------

create function public.mark_mutation_committed(
  p_key         text,
  p_sample_uuid uuid default null
)
returns void
language plpgsql
set search_path = ''
as $$
begin
  update public.idempotency_requests
     set committed_at = now(),
         updated_at   = now(),
         sample_uuid  = coalesce(p_sample_uuid, sample_uuid)
   where idempotency_key = p_key;

  if not found then
    -- Unreachable: claim_mutation inserted or locked this row earlier in the
    -- same transaction. Refuse rather than commit a mutation whose key was not
    -- marked, because an unmarked key is a key a retry would run again.
    raise exception
      'BFF_IDEMPOTENCY_LOST: key % vanished between the claim and the commit', p_key
      using errcode = 'XX000';
  end if;
end;
$$;


-- ---------------------------------------------------------------------------
-- Writing one submitted value.
--
-- p_values arrives as the OUTPUT of validateStagePayload() in
-- _shared/validation.ts, so its shape is known exactly and is not guessed:
--
--   number field  -> `{"value": 84.2, "enteredText": "84.20"}` when the client
--                    sent a string, because "Keep the operator's own text so
--                    entered precision survives", or a bare JSON number when it
--                    sent a number;
--   select/yesno  -> the option's canonical `value` string;
--   date / time   -> 'YYYY-MM-DD' / 'HH:mm';
--   text/textarea -> the trimmed string.
--
-- A JSON null, or a key absent altogether, means NOT MEASURED and writes no
-- row: a measurement row exists because something was recorded, and a row of
-- nulls would make "blank" indistinguishable from a recorded value. Zero is a
-- real measured value and takes the numeric path like any other number.
-- ---------------------------------------------------------------------------

create function public.apply_submitted_values(
  p_sample_uuid     uuid,
  p_stage           public.sample_stage,
  p_values          jsonb,
  p_row             text[],
  p_actor           uuid,
  p_evaluation_kind text
)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_applied integer := 0;
  v_field   record;
  v_raw     jsonb;
  v_numeric numeric;
  v_text    text;
  v_entered text;
  v_index   integer;
begin
  if p_values is null or jsonb_typeof(p_values) <> 'object' then
    raise exception 'BFF_VALUES_REQUIRED: the submitted values must be an object'
      using errcode = '22023';
  end if;

  -- Registry order, so the audit events for one save read in the same order as
  -- the form and the spreadsheet row.
  for v_field in
    select f.field_key, f.column_letter, f.field_type
    from public.stage_fields f
    where f.stage = p_stage
    order by length(f.column_letter), f.column_letter
  loop
    if not p_values ? v_field.field_key then
      continue;
    end if;

    v_raw := p_values -> v_field.field_key;
    if v_raw is null or jsonb_typeof(v_raw) = 'null' then
      continue;
    end if;

    v_numeric := null;
    v_text    := null;
    v_entered := null;

    case jsonb_typeof(v_raw)
      when 'object' then
        if not (v_raw ? 'value') then
          raise exception
            'BFF_BAD_VALUE: % arrived as an object without a "value"', v_field.field_key
            using errcode = '22023';
        end if;
        v_numeric := (v_raw ->> 'value')::numeric;
        v_entered := nullif(btrim(coalesce(v_raw ->> 'enteredText', '')), '');
      when 'number' then
        v_numeric := v_raw::text::numeric;
      when 'string' then
        v_text := v_raw #>> '{}';
        if btrim(v_text) = '' then
          -- An empty string is not a measurement. Storing it would create a row
          -- whose only content is the absence of content.
          continue;
        end if;
      else
        raise exception
          'BFF_BAD_VALUE: % arrived as a %, which is not a recordable value',
          v_field.field_key, jsonb_typeof(v_raw)
          using errcode = '22023';
    end case;

    -- sample_measurements_numeric_keeps_precision requires a numeric result to
    -- carry the text it was entered as. When the client sent a bare number
    -- there is no keystroke text to keep, so the next best witness is the cell
    -- the row projection produced for that column -- which is what the
    -- spreadsheet will actually show. The column letters are A..S, one
    -- character, and p_row is column-A-first, so the position is derivable.
    if v_numeric is not null and v_entered is null then
      if length(v_field.column_letter) = 1 then
        v_index := ascii(v_field.column_letter) - ascii('A') + 1;
        if p_row is not null and v_index between 1 and cardinality(p_row) then
          v_entered := nullif(btrim(coalesce(p_row[v_index], '')), '');
        end if;
      end if;
      v_entered := coalesce(v_entered, trim(to_char(v_numeric, 'FM999999999999.999999')));
    end if;

    -- apply_measurement owns the rest: it refuses a system column, refuses an
    -- option outside the controlled vocabulary, enforces the hard physical
    -- bounds, assesses the value against the approved ruleset and appends the
    -- assessment as evidence. The unit, the unit-confirmed flag and the bounds
    -- come from stage_fields and never from the caller.
    perform public.apply_measurement(
      p_sample_uuid, v_field.field_key, v_numeric, v_text, v_entered,
      p_actor, p_evaluation_kind
    );
    v_applied := v_applied + 1;
  end loop;

  return v_applied;
end;
$$;


-- ---------------------------------------------------------------------------
-- Does the sample hold every result it needs to be reviewable?
--
-- readyForReview() in src/lib/workflow.ts: "Non-applicable fields are
-- excluded, so an AM ground sample is not held back by the BC-only moisture
-- column."
-- ---------------------------------------------------------------------------

create function public.sample_results_complete(p_sample_uuid uuid)
returns boolean
language sql
stable
set search_path = ''
as $$
  select not exists (
    select 1
    from public.samples s
    join public.stage_fields f on f.stage = s.stage
    where s.id = p_sample_uuid
      and f.requiredness = 'testing'
      and public.is_field_applicable(p_sample_uuid, s.stage, f.field_key)
      and not exists (
        select 1 from public.sample_measurements m
        where m.sample_uuid = p_sample_uuid and m.field_key = f.field_key
      )
  );
$$;


-- ---------------------------------------------------------------------------
-- The release blockers, server side.
--
-- evaluateRelease() in src/lib/workflow.ts, re-derived from stored rows. A
-- hold outranks every permissive signal, an approved out-of-limit finding
-- blocks, a missing REQUIRED result blocks, and `not_assessable` blocks --
-- which is why a production seed with no approved limits cannot be
-- auto-accepted: all 34 workbook entries are reference_only, so every
-- measurement assesses as not_assessable and every acceptance is an override.
-- That is correct behaviour, not a defect.
-- ---------------------------------------------------------------------------

create function public.release_blockers(p_sample_uuid uuid)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_blockers jsonb := '[]'::jsonb;
  v_sample   public.samples;
  v_detail   text;
  v_row      record;
begin
  select * into v_sample from public.samples where id = p_sample_uuid;
  if v_sample.id is null then
    raise exception 'Unknown sample %' , p_sample_uuid using errcode = '23503';
  end if;

  if v_sample.hold_flag then
    select string_agg(h.detail, '; ' order by h.raised_at) into v_detail
    from public.holds h
    where h.sample_uuid = p_sample_uuid and h.cleared_at is null;

    v_blockers := v_blockers || jsonb_build_object(
      'kind', 'active_hold',
      'detail', coalesce(v_detail, 'The sample is on quality hold.')
    );
  end if;

  for v_row in
    select m.field_key, f.sheet_header, m.assessment_result, m.assessment_reason,
           f.requiredness
    from public.sample_measurements m
    join public.stage_fields f on f.stage = m.stage and f.field_key = m.field_key
    where m.sample_uuid = p_sample_uuid
    order by length(f.column_letter), f.column_letter
  loop
    if v_row.assessment_result = 'outside_limit' then
      v_blockers := v_blockers || jsonb_build_object(
        'kind', 'outside_approved_limit',
        'fieldKey', v_row.field_key,
        'detail', v_row.sheet_header || ': outside the approved limit'
      );
    elsif v_row.assessment_result = 'not_assessable' then
      v_blockers := v_blockers || jsonb_build_object(
        'kind', 'not_assessable',
        'fieldKey', v_row.field_key,
        'detail', v_row.sheet_header || ': ' || coalesce(v_row.assessment_reason::text, 'not assessable')
      );
    end if;
  end loop;

  -- A required result that was never recorded. The absence of a row is the
  -- fact here, which is why this is a separate pass over stage_fields rather
  -- than a branch inside the loop above.
  for v_row in
    select f.field_key, f.sheet_header
    from public.stage_fields f
    where f.stage = v_sample.stage
      and f.requiredness = 'testing'
      and public.is_field_applicable(p_sample_uuid, v_sample.stage, f.field_key)
      and not exists (
        select 1 from public.sample_measurements m
        where m.sample_uuid = p_sample_uuid and m.field_key = f.field_key
      )
    order by length(f.column_letter), f.column_letter
  loop
    v_blockers := v_blockers || jsonb_build_object(
      'kind', 'missing_required_result',
      'fieldKey', v_row.field_key,
      'detail', v_row.sheet_header || ' has no recorded result.'
    );
  end loop;

  return v_blockers;
end;
$$;


-- ---------------------------------------------------------------------------
-- rpc_register_sample
--
-- Call site: register-sample/index.ts:124, thirteen named arguments.
-- Return shape: RegisterSampleResult.
--
-- One transaction: claim the key, verify the actor and the permission, allocate
-- the identifier atomically, insert the sample and its measurements, raise any
-- automatic hold, write the audit event and enqueue EXACTLY ONE outbox event.
-- A crash anywhere takes all of it, so there is no sample with no outbox event
-- that nothing retries, and no outbox event for a sample that does not exist.
-- ---------------------------------------------------------------------------

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
    end,
    case p_stage
      when 'raw_materials' then p_values ->> 'delivery_or_lot_no'
      when 'ground'        then p_values ->> 'batch_or_bin_no'
      when 'conditioned'   then p_values ->> 'batch_no'
      when 'pellets'       then p_values ->> 'batch_no'
      when 'extruded_soya' then p_values ->> 'run_no'
      when 'crumble'       then p_values ->> 'batch_no'
      when 'mash'          then p_values ->> 'batch_no'
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
-- rpc_update_results
--
-- Call site: update-results/index.ts:79, ten named arguments.
-- Return shape: MutationResult.
--
-- Amending an already-reviewed sample is the FR-013 correction path and takes
-- TWO whitelisted legs: reviewed -> correction_required needs `sample.correct`
-- and a written reason, then correction_required -> ready_for_review needs
-- `sample.enter_results` and a written reason. Both are asserted, so an actor
-- holding only one of the two cannot reach the far side by passing through the
-- middle state inside one call.
-- ---------------------------------------------------------------------------

create function public.rpc_update_results(
  p_actor                 uuid,
  p_idempotency_key       text,
  p_payload_hash          text,
  p_app_version           text,
  p_sample_uuid           uuid,
  p_expected_revision     integer,
  p_values                jsonb,
  p_row                   text[],
  p_reason                text default null,
  p_tested_by_attestation text default null
)
returns table (
  sample_uuid        uuid,
  sample_id          text,
  revision           integer,
  capture_state      text,
  disposition        text,
  outbox_event_id    uuid,
  recorded_at        timestamptz,
  holds_raised       jsonb,
  sheet_sync_state   text,
  sheet_confirmed_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_basis    text;
  v_sample   public.samples;
  v_before   public.capture_state;
  v_target   public.capture_state;
  v_kind     public.sheet_sync_event_kind;
  v_event_id uuid;
  v_holds    jsonb;
begin
  v_basis := public.require_permission(p_actor, 'sample.enter_results');
  perform public.claim_mutation(p_idempotency_key, 'update_results', p_actor, p_payload_hash);

  -- FOR UPDATE before the revision comparison. Reading first and locking
  -- afterwards is the lost-update race the revision token exists to prevent:
  -- two writers would both see the same revision and both believe they won.
  select * into v_sample from public.samples where id = p_sample_uuid for update;
  if v_sample.id is null then
    raise exception 'BFF_UNKNOWN_SAMPLE: no sample %', p_sample_uuid using errcode = '23503';
  end if;

  -- No `using errcode`: plpgsql raises P0001 by default, which is
  -- PG_REVISION_CONFLICT in _shared/rpc.ts and is how the Edge Function tells a
  -- stale write from a server fault.
  if v_sample.revision <> p_expected_revision then
    raise exception
      'BFF_REVISION_CONFLICT: % has moved on to revision % since you loaded it (you sent %)',
      coalesce(v_sample.sample_id, v_sample.id::text), v_sample.revision, p_expected_revision;
  end if;

  v_before := v_sample.capture_state;

  if v_before = 'voided' then
    raise exception
      'BFF_TERMINAL_STATE: a voided sample cannot change state. Register a new sample instead.'
      using errcode = '23514';
  end if;

  -- First leg of the amendment path. The reason is mandatory here by the
  -- whitelist, which is FR-013's "mandatory when amending an already-reviewed
  -- value" enforced in the one place that cannot be skipped.
  if v_before = 'reviewed' then
    perform public.assert_capture_transition('reviewed', 'correction_required', p_actor, p_reason);
    update public.samples set capture_state = 'correction_required' where id = p_sample_uuid;
    v_before := 'correction_required';
  end if;

  perform public.apply_submitted_values(
    p_sample_uuid, v_sample.stage, p_values, p_row, p_actor,
    case when v_sample.capture_state in ('reviewed', 'correction_required')
         then 'correction' else 'initial' end
  );

  perform public.apply_hold_triggers(p_sample_uuid, p_actor);

  if public.sample_results_complete(p_sample_uuid) then
    v_target := 'ready_for_review';
  else
    v_target := 'awaiting_results';
  end if;

  perform public.assert_capture_transition(v_before, v_target, p_actor, p_reason);

  update public.samples
     set capture_state = v_target,
         revision      = v_sample.revision + 1
   where id = p_sample_uuid;

  -- Holds raised by THIS transaction. holds.raised_at defaults to now(), which
  -- is the transaction timestamp, so the comparison is exact rather than a
  -- window guess.
  select coalesce(jsonb_agg(jsonb_build_object('field_key', h.field_key, 'detail', h.detail)
                            order by h.field_key), '[]'::jsonb)
    into v_holds
  from public.holds h
  where h.sample_uuid = p_sample_uuid
    and h.cleared_at is null
    and h.raised_at = now();

  -- A reasoned amendment of an already-written value is a CORRECTION in the
  -- spreadsheet's terms, not a first write of results.
  v_kind := case when v_before = 'correction_required' then 'correction' else 'results' end;

  perform public.record_audit_event(
    p_action             => 'sample.results_recorded',
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
                              'revision', v_sample.revision + 1,
                              'event_kind', v_kind,
                              -- PRD section 6.1: recorded when the tester is
                              -- not the signed-in user, so the record says who
                              -- actually performed the test.
                              'tested_by_attestation', p_tested_by_attestation,
                              'holds_raised', v_holds
                            ),
    p_outcome            => 'succeeded',
    p_authority_basis    => v_basis,
    p_actor_id           => p_actor,
    p_deployment_version => p_app_version
  );

  v_event_id := public.enqueue_sheet_sync_event(p_sample_uuid, v_kind, p_row);

  perform public.mark_mutation_committed(p_idempotency_key, p_sample_uuid);

  return query
  select s.id, s.sample_id, s.revision, s.capture_state::text, s.disposition::text,
         v_event_id, s.updated_at, v_holds,
         -- The sample's CURRENT sync state, never inferred from whether THIS
         -- change queued an event. An absent event id means "no new write
         -- queued", not "already confirmed".
         public.outbox_state_to_client(s.sheet_sync_state), s.sheet_confirmed_at
  from public.samples s where s.id = p_sample_uuid;
end;
$$;


-- ---------------------------------------------------------------------------
-- rpc_review_sample
--
-- Call site: review-sample/index.ts:111, nine named arguments.
-- Return shape: MutationResult.
--
-- TWO controls that only this function can apply, because only it holds the
-- row lock:
--
--   1. Re-evaluation. p_claimed_assessments is the client's view, "for
--      comparison ONLY". Every measurement is re-evaluated against the
--      approved ruleset and the transaction raises BFF_ASSESSMENT_STALE on any
--      disagreement, "so a client cannot submit `within_limit` for a
--      measurement that has no approved rule". The stored assessment is
--      checked too: if the ruleset moved since the results were entered, the
--      reviewer is looking at a stale screen and must reload rather than sign
--      off numbers that are no longer current.
--   2. Separation of duties. separation_of_duties_failure('review_exception',
--      ...) refuses a reviewer who is reviewing their OWN exception -- a hold
--      or an out-of-limit finding on a measurement they recorded themselves.
--
-- NO outbox event is enqueued and `outbox_event_id` is null, because
-- ReviewSampleArgs carries no p_row: a review outcome changes no spreadsheet
-- cell. Inventing a row here would mean projecting the column mapping in SQL,
-- which is exactly the duplication src/forms/sheetMapping.ts exists to
-- prevent. `sheet_sync_state` is therefore reported from the sample's own
-- state, so "a review that touches no sheet cell leaves the row exactly as
-- confirmed -- or as pending -- as it was".
-- ---------------------------------------------------------------------------

create function public.rpc_review_sample(
  p_actor                uuid,
  p_idempotency_key      text,
  p_payload_hash         text,
  p_app_version          text,
  p_sample_uuid          uuid,
  p_expected_revision    integer,
  p_outcome              text,
  p_claimed_assessments  jsonb default '[]'::jsonb,
  p_reason               text default null
)
returns table (
  sample_uuid        uuid,
  sample_id          text,
  revision           integer,
  capture_state      text,
  disposition        text,
  outbox_event_id    uuid,
  recorded_at        timestamptz,
  holds_raised       jsonb,
  sheet_sync_state   text,
  sheet_confirmed_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
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
      v_sample.collection_instant
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
$$;


-- ---------------------------------------------------------------------------
-- rpc_set_disposition
--
-- Call site: set-disposition/index.ts:427, nine named arguments.
-- Return shape: MutationResult.
--
-- checkDisposition() from src/lib/workflow.ts, re-derived here from stored
-- rows while holding the row lock. Three rules carry the weight:
--
--   * ACCEPTING a sample that is ON HOLD is refused outright, whatever
--     authority the actor holds. "An acceptance must not be a back door around
--     hold-clearing authority": the hold has to be cleared by its own audited
--     action first, and `hold.clear` belongs to neither quality_officer nor
--     administrator.
--   * Accepting over any OTHER outstanding blocker requires
--     `disposition.override_release`, which is granted to NO role and reachable
--     only through a recorded delegation -- and the decision is STORED AS
--     `released_by_authorized_override`, never as a clean `accepted`. The
--     request asked for an acceptance; what is recorded is what it actually
--     was, so the audit trail cannot later be read as a clean pass.
--   * `undetermined` is refused. It is the ABSENCE of a decision, maps to no
--     permission, and allowing it would let an unauthorised actor clear a
--     hold-blocked sample back to "no decision" with no permission, no reason
--     and no hold check. Anything not handled explicitly is refused too: the
--     default for an unrecognised decision is denial.
-- ---------------------------------------------------------------------------

create function public.rpc_set_disposition(
  p_actor             uuid,
  p_idempotency_key   text,
  p_payload_hash      text,
  p_app_version       text,
  p_sample_uuid       uuid,
  p_expected_revision integer,
  p_decision          public.disposition_state,
  p_reason            text,
  p_records_override  boolean
)
returns table (
  sample_uuid        uuid,
  sample_id          text,
  revision           integer,
  capture_state      text,
  disposition        text,
  outbox_event_id    uuid,
  recorded_at        timestamptz,
  holds_raised       jsonb,
  sheet_sync_state   text,
  sheet_confirmed_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_permission public.app_permission;
  v_basis      text;
  v_sample     public.samples;
  v_blockers   jsonb;
  v_held       boolean;
  v_effective  public.disposition_state;
  v_override   boolean := false;
  v_previous   uuid;
  v_holds      jsonb := '[]'::jsonb;
begin
  -- The permission map, including the deliberate absence of one for
  -- `undetermined`. Refused before anything else so an unrecordable decision
  -- never reaches the authority check and cannot fall through to an allow.
  v_permission := case p_decision
    when 'on_hold'                         then 'hold.raise'
    when 'accepted'                        then 'disposition.accept'
    when 'rejected'                        then 'disposition.reject'
    when 'rework_required'                 then 'disposition.rework'
    when 'released_by_authorized_override' then 'disposition.override_release'
    else null
  end;

  if v_permission is null then
    raise exception
      'BFF_NOT_A_DECISION: "%" is not a decision that can be recorded. A sample starts undetermined; record Accepted, Rejected, Rework required or On hold instead.',
      p_decision
      using errcode = '22023';
  end if;

  v_basis := public.require_permission(p_actor, v_permission);
  perform public.claim_mutation(p_idempotency_key, 'set_disposition', p_actor, p_payload_hash);

  if coalesce(btrim(p_reason), '') = '' then
    raise exception
      'BFF_REASON_REQUIRED: a reason is required and will be recorded in the sample history.'
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
    raise exception
      'BFF_TERMINAL_STATE: a voided sample has no material decision to record.'
      using errcode = '23514';
  end if;

  v_blockers := public.release_blockers(p_sample_uuid);
  v_held := exists (
    select 1 from jsonb_array_elements(v_blockers) as b(value)
    where b.value ->> 'kind' = 'active_hold'
  );

  v_effective := p_decision;

  if p_decision = 'accepted' then
    if v_held then
      raise exception
        'BFF_HOLD_MUST_BE_CLEARED: this sample is on hold. The hold must be cleared by an authorised approver before the material can be accepted.'
        using errcode = '42501';
    end if;

    if jsonb_array_length(v_blockers) > 0 then
      if not public.actor_has_permission(p_actor, 'disposition.override_release') then
        raise exception
          'BFF_OVERRIDE_NOT_AUTHORISED: outstanding quality findings mean this acceptance would be an authorised override, which you are not delegated to record.'
          using errcode = '42501';
      end if;
      -- Recorded as what it is. The requested decision was `accepted`; over
      -- outstanding findings that is an override release, and storing the
      -- milder word would make the audit trail say something untrue.
      v_effective := 'released_by_authorized_override';
      v_override  := true;
      v_basis     := public.actor_authority_basis(p_actor, 'disposition.override_release');
    end if;

  elsif p_decision = 'released_by_authorized_override' then
    -- dispositions_override_has_blockers: a recorded override must have had
    -- something to override. An override release of a clean sample is either a
    -- client bug or an attempt to mark a clean pass as an exception.
    if jsonb_array_length(v_blockers) = 0 then
      raise exception
        'BFF_NOTHING_TO_OVERRIDE: this sample carries no outstanding finding, so there is nothing for an override release to override. Record an acceptance instead.'
        using errcode = '22023';
    end if;
    if v_held then
      raise exception
        'BFF_HOLD_MUST_BE_CLEARED: this sample is on hold. The hold must be cleared by an authorised approver before the material can be released.'
        using errcode = '42501';
    end if;
    v_override := true;

  elsif p_decision not in ('rejected', 'rework_required', 'on_hold') then
    -- Unreachable today: every member of disposition_state is handled above.
    -- FAIL CLOSED anyway, so a value added to the enum later is denied rather
    -- than inheriting whatever the last branch happened to do.
    raise exception
      'BFF_NOT_A_DECISION: "%" is not a decision that can be recorded.', p_decision
      using errcode = '22023';
  end if;

  -- The edge derives p_records_override from the state it read a moment ago.
  -- Only this transaction holds the lock, so a disagreement means the sample
  -- changed underneath the operator and the decision they are confirming is
  -- not the decision they were shown.
  if coalesce(p_records_override, false) <> v_override then
    raise exception
      'BFF_OVERRIDE_DISAGREEMENT: this decision is % an authorised override; the request said %. Reload the sample.',
      case when v_override then '' else 'not' end, p_records_override;
  end if;

  if v_effective = 'on_hold' then
    -- A hold is a row with a reason and a recorded authority, not a flag. The
    -- trigger on holds sets samples.hold_flag and moves the decision to
    -- on_hold; clearing one returns it to undetermined rather than granting an
    -- acceptance.
    insert into public.holds (
      sample_uuid, trigger_kind, detail, raised_by, raised_authority, raise_reason
    )
    values (
      p_sample_uuid, 'manual', btrim(p_reason), p_actor, v_basis, btrim(p_reason)
    );

    select coalesce(jsonb_agg(jsonb_build_object('field_key', h.field_key, 'detail', h.detail)
                              order by h.raised_at), '[]'::jsonb)
      into v_holds
    from public.holds h
    where h.sample_uuid = p_sample_uuid
      and h.cleared_at is null
      and h.raised_at = now();
  end if;

  select d.id into v_previous
  from public.dispositions d
  where d.sample_uuid = p_sample_uuid
  order by d.decided_at desc, d.id desc
  limit 1;

  insert into public.dispositions (
    sample_uuid, decision, reason, records_override, blockers,
    authority_basis, decided_by, supersedes, deployment_version
  )
  values (
    p_sample_uuid, v_effective, btrim(p_reason), v_override, v_blockers,
    v_basis, p_actor, v_previous, p_app_version
  );

  update public.samples
     set revision = v_sample.revision + 1
   where id = p_sample_uuid;

  perform public.record_audit_event(
    p_action             => 'sample.disposition_recorded',
    p_entity_type        => 'sample',
    p_entity_id          => p_sample_uuid::text,
    p_sample_uuid        => p_sample_uuid,
    p_reason             => btrim(p_reason),
    p_before             => jsonb_build_object(
                              'disposition', v_sample.disposition,
                              'capture_state', v_sample.capture_state,
                              'revision', v_sample.revision,
                              'hold_flag', v_sample.hold_flag
                            ),
    p_after              => jsonb_build_object(
                              'requested_decision', p_decision,
                              'recorded_decision', v_effective,
                              'records_override', v_override,
                              'blockers', v_blockers,
                              'revision', v_sample.revision + 1
                            ),
    p_outcome            => 'succeeded',
    p_authority_basis    => v_basis,
    p_actor_id           => p_actor,
    p_deployment_version => p_app_version
  );

  perform public.mark_mutation_committed(p_idempotency_key, p_sample_uuid);

  -- No outbox event: SetDispositionArgs carries no projected row, and a
  -- decision changes no cell of the operational tab. See the note on
  -- rpc_review_sample.
  return query
  select s.id, s.sample_id, s.revision, s.capture_state::text, s.disposition::text,
         null::uuid, s.updated_at, v_holds,
         public.outbox_state_to_client(s.sheet_sync_state), s.sheet_confirmed_at
  from public.samples s where s.id = p_sample_uuid;
end;
$$;


-- ---------------------------------------------------------------------------
-- rpc_approve_specification
--
-- Call site: approve-specification/index.ts:251, eight named arguments.
-- Return shape: ApproveSpecificationResult.
--
-- THE TWO-PERSON RULE. approved_by must never equal proposed_by. The database
-- already refuses it through specification_versions_two_person_approval, so
-- this check is not the only line of defence -- but a constraint violation is a
-- 500 with no explanation, and an operator who has just tried to approve their
-- own proposed limit needs to be told why, and the ATTEMPT needs to be
-- auditable. separation_of_duties_failure() is the same predicate the client
-- uses, asked server side.
--
-- p_override_approved_by exists for the case where a second approver's
-- identity is recorded instead of the caller's. It is not an escape hatch: the
-- named person must be a different, active account that actually holds
-- `spec.approve`, and must not be the proposer either. Without those checks it
-- would be the self-approval wearing a second name.
-- ---------------------------------------------------------------------------

create function public.rpc_approve_specification(
  p_actor                   uuid,
  p_idempotency_key         text,
  p_payload_hash            text,
  p_app_version             text,
  p_specification_version_id uuid,
  p_decision                text,
  p_reason                  text,
  p_override_approved_by    uuid default null
)
returns table (
  specification_version_id uuid,
  parameter_key            text,
  status                   text,
  version                  integer,
  effective_from           timestamptz,
  approved_by              uuid,
  recorded_at              timestamptz
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
    -- instant would make evaluate_measurement see ambiguous rules, which it
    -- reports as `ambiguous_rules` and cannot assess -- so an overlap would
    -- silently turn every future measurement of that parameter into "not
    -- assessable".
    if exists (
      select 1 from public.specification_versions sv
      where sv.specification_id = v_version.specification_id
        and sv.status = 'approved'
        and sv.id <> v_version.id
        and sv.effective_from >= v_version.effective_from
    ) then
      raise exception
        'BFF_EFFECTIVE_OVERLAP: an approved version of % already takes effect at or after %. Propose this rule with a later effective date.',
        v_version.parameter_key, v_version.effective_from
        using errcode = '23514';
    end if;

    update public.specification_versions sv
       set status       = 'superseded',
           effective_to = v_version.effective_from
     where sv.specification_id = v_version.specification_id
       and sv.status = 'approved'
       and sv.id <> v_version.id
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
-- Privileges. Per signature, from anon and authenticated as well as PUBLIC: a
-- revoke only deletes a grant that was RECORDED, and Supabase's default
-- privileges record EXECUTE for anon and authenticated on every new function
-- in `public`, which `revoke ... from public` does not remove. Never collapse
-- these to the `from public` form -- that is the inert revoke 0009 corrects.
--
-- NOT ONE is granted to `authenticated`. Each takes the actor as an argument,
-- so a client able to call one directly could name somebody else as the
-- registrant, the reviewer or the approver. The boundary is that only an Edge
-- Function, holding the service-role key and a JWT it verified itself, can
-- reach them.
-- ---------------------------------------------------------------------------

revoke all on function public.assert_capture_transition(
  public.capture_state, public.capture_state, uuid, text
) from public, anon, authenticated;
grant execute on function public.assert_capture_transition(
  public.capture_state, public.capture_state, uuid, text
) to service_role;

revoke all on function public.mark_mutation_committed(text, uuid)
  from public, anon, authenticated;

revoke all on function public.claim_mutation(text, text, uuid, text)
  from public, anon, authenticated;
grant execute on function public.claim_mutation(text, text, uuid, text) to service_role;

revoke all on function public.apply_submitted_values(
  uuid, public.sample_stage, jsonb, text[], uuid, text
) from public, anon, authenticated;

revoke all on function public.sample_results_complete(uuid) from public, anon, authenticated;
grant execute on function public.sample_results_complete(uuid) to service_role;

revoke all on function public.release_blockers(uuid) from public, anon, authenticated;
grant execute on function public.release_blockers(uuid) to service_role;

revoke all on function public.rpc_register_sample(
  uuid, text, text, text, public.sample_stage, text, date, text, timestamptz, jsonb, text[], jsonb, text
) from public, anon, authenticated;
grant execute on function public.rpc_register_sample(
  uuid, text, text, text, public.sample_stage, text, date, text, timestamptz, jsonb, text[], jsonb, text
) to service_role;

revoke all on function public.rpc_update_results(
  uuid, text, text, text, uuid, integer, jsonb, text[], text, text
) from public, anon, authenticated;
grant execute on function public.rpc_update_results(
  uuid, text, text, text, uuid, integer, jsonb, text[], text, text
) to service_role;

revoke all on function public.rpc_review_sample(
  uuid, text, text, text, uuid, integer, text, jsonb, text
) from public, anon, authenticated;
grant execute on function public.rpc_review_sample(
  uuid, text, text, text, uuid, integer, text, jsonb, text
) to service_role;

revoke all on function public.rpc_set_disposition(
  uuid, text, text, text, uuid, integer, public.disposition_state, text, boolean
) from public, anon, authenticated;
grant execute on function public.rpc_set_disposition(
  uuid, text, text, text, uuid, integer, public.disposition_state, text, boolean
) to service_role;

revoke all on function public.rpc_approve_specification(
  uuid, text, text, text, uuid, text, text, uuid
) from public, anon, authenticated;
grant execute on function public.rpc_approve_specification(
  uuid, text, text, text, uuid, text, text, uuid
) to service_role;

select public.assert_function_privileges();
