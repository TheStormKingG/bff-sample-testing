-- ===========================================================================
-- 0032 — the lab's sieve table becomes a setting.
--
-- Three things per position: the ABNT designation, the aperture in µm, and
-- what the sieve weighs empty. 0029 seeded the empty weights as defaults on
-- the tare fields and said in `SievePosition.tareDefaultGrams` why they had
-- to be editable rather than fixed in a source file:
--
--     "Every retained mass is `gross − tare`, so a tare that does not match
--      the sieve actually on the bench biases that sieve's share and
--      therefore DGM, MF and the uniformity bands — silently, with a
--      plausible-looking number. That is why the figures are
--      ADMINISTRATOR-EDITABLE rather than fixed in this file: when a sieve is
--      replaced or re-calibrated, the person who knows must be able to change
--      the figure without a deployment."
--
-- This is that path.
--
-- ---------------------------------------------------------------------------
-- WHY THERE WAS NO WRITE PATH TO system_config AT ALL
-- ---------------------------------------------------------------------------
-- 0005 says, in a comment beside the table: "No write policy. Changes go
-- through public.set_system_config(), which checks `user.manage`, refuses a
-- key that is not operator-editable, and audits the old and new values."
--
-- That function does not exist. It never did — `grep -rn set_system_config`
-- over every migration returns the comment and nothing else. The table has
-- been read-only since it was created, and the sentence describing its
-- guardrails was the only thing standing in for them.
--
-- So this creates the write path the comment promised, for ONE key, with
-- exactly the three checks it named: the permission, the editable flag, and
-- the audit of before and after.
--
-- ---------------------------------------------------------------------------
-- WHAT THE SERVER CHECKS, AND WHY IT CHECKS IT AGAIN
-- ---------------------------------------------------------------------------
-- `src/lib/sieveSeries.ts` validates the same table in TypeScript, and that
-- is the richer implementation — it is what the editor uses to tell an
-- administrator which row is wrong. It is not a control: it runs in the
-- browser. The rules below are the ones that protect the ARITHMETIC, and they
-- are re-stated here because a value that reaches this function has not
-- passed through that one.
--
-- The important one is STRICTLY DESCENDING. `computeDgm` takes each bin's
-- geometric mean between its own aperture and the one above it. A series that
-- does not fall coarsest-to-finest produces a bin whose mean diameter lies
-- outside the bin, and every figure built on it — DGM, the uniformity bands,
-- the GSD — would be a number with no meaning, returned without complaint.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. The row, seeded with the table the application already uses.
--
-- `operator_editable` is TRUE, and it is the flag the writer below enforces:
-- this function refuses any key that does not carry it, so it cannot become a
-- general-purpose back door into `system_config`.
-- ---------------------------------------------------------------------------

insert into public.system_config (key, value, description, operator_editable) values
  ('sieve_series',
   '{"version":1,"positions":['
     || '{"abnt":"5","apertureMicrons":4000,"tareDefaultGrams":370},'
     || '{"abnt":"10","apertureMicrons":2000,"tareDefaultGrams":398},'
     || '{"abnt":"16","apertureMicrons":1200,"tareDefaultGrams":388},'
     || '{"abnt":"30","apertureMicrons":600,"tareDefaultGrams":368},'
     || '{"abnt":"50","apertureMicrons":300,"tareDefaultGrams":362},'
     || '{"abnt":"400","apertureMicrons":38,"tareDefaultGrams":330},'
     || '{"abnt":"Fundo","apertureMicrons":37,"tareDefaultGrams":330}]}',
   'The lab''s sieve stack: ABNT designation, aperture in micrometres and empty weight, one entry per position, coarsest first. Seeds the tare fields on every sieve form and supplies the apertures DGM and GSD are computed from. Kj, the uniformity bands and which position is the pan are fixed by the method and are NOT configurable.',
   true)
on conflict (key) do nothing;


-- ---------------------------------------------------------------------------
-- 2. The writer.
-- ---------------------------------------------------------------------------

create function public.rpc_set_sieve_series(
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

comment on function public.rpc_set_sieve_series(uuid, text, text, text, jsonb, text) is
  'Replaces the lab sieve table under user.manage, refusing any table that is not exactly as wide as the method or that does not run coarsest-to-finest, and auditing the old and new value.';

revoke all on function public.rpc_set_sieve_series(uuid, text, text, text, jsonb, text)
  from public, anon, authenticated;
grant execute on function public.rpc_set_sieve_series(uuid, text, text, text, jsonb, text)
  to service_role;


-- ---------------------------------------------------------------------------
-- 3. The read grant, declared with the change that needs it.
--
-- `register-sample` and `update-results` now read `system_config` directly to
-- get the table above. 0023 established that every table an Edge Function
-- reads directly must carry an explicit `service_role` select grant — the
-- service role has no blanket table access in this project — and
-- `tests/serviceRoleReadContract.test.ts` compares the two sides.
--
-- The grant lives HERE rather than being appended to 0023, because 0023 is
-- already applied everywhere and a migration that has run is a record of what
-- happened. The contract test reads every migration, so a grant is a
-- declaration wherever it is written.
-- ---------------------------------------------------------------------------

grant select on public.system_config to service_role;

-- The runtime half of the same contract. 0023 created
-- `assert_service_role_reads()` over a declared list and ran it; this adds the
-- new table to that list and runs it again, so the migration cannot apply
-- while the grant is missing.
create or replace function public.assert_service_role_reads()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  -- The declared contract. Keep in step with tests/serviceRoleReadContract.
  c_tables constant text[] := array[
    'profiles',
    'samples',
    'sample_measurements',
    'specification_versions',
    'sheet_sync_outbox',
    'audit_events',
    -- Added 0032: `register-sample` and `update-results` read the lab's sieve
    -- table out of here before validating a sieve test.
    'system_config'
  ];
  v_missing text;
begin
  select string_agg(t, ', ' order by t)
    into v_missing
  from unnest(c_tables) as t
  where not has_table_privilege('service_role', format('public.%I', t), 'SELECT');

  if v_missing is not null then
    raise exception
      'service_role cannot SELECT from: %. An Edge Function reads each of these directly through the service-role client, so without the grant the request fails with a bare "internal" and the operator is told nothing useful. Grant SELECT, or stop reading the table directly.',
      v_missing
      using errcode = '42501';
  end if;
end;
$$;

revoke all on function public.assert_service_role_reads() from public, anon, authenticated;
grant execute on function public.assert_service_role_reads() to service_role;

-- Prove it now, so this migration cannot apply while the defect is present.
select public.assert_service_role_reads();
