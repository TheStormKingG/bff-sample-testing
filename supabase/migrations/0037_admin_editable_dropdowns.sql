-- ===========================================================================
-- 0037 — the dropdowns become the administrator's, and the admin screen that
-- always looked as if it edited them finally does.
--
-- ---------------------------------------------------------------------------
-- WHAT WAS ALREADY THERE, AND WHY IT DID NOTHING
-- ---------------------------------------------------------------------------
-- 0002 created five controlled-vocabulary tables and 0015 gave them a writer.
-- The admin "Controlled lists" screen has been editing them since. NOTHING
-- HAS EVER READ THEM: every dropdown in the application takes its options
-- from a static list in `src/forms/registry.ts`, and `materials`,
-- `sampling_points` and `mill_screen_sizes` hold rows that happen to match
-- those lists exactly — a coincidence maintained by hand.
--
-- So an administrator could add a material, see it saved, see it listed, and
-- never see it on a form. This release makes `feed_types` real and adds the
-- two people lists beside it; the three of them are read by the browser AND
-- by the Edge Functions, which is what makes them enforceable rather than
-- decorative.
--
-- The other four lists are deliberately NOT wired up here:
--   * `sampling_points` drives the sample-ID PREFIX and the BC-only moisture
--     rule. A code an administrator invents has no prefix and no rule, so it
--     must stay a code change.
--   * `materials` and `mill_screen_sizes` are small, physical, and nobody
--     asked; wiring them would widen this change without a reason.
--   * `suppliers` is free text on the form and stays free text.
-- Those four keep their static lists, and `optionsListKey` in the registry is
-- the single place that says which is which.
--
-- ---------------------------------------------------------------------------
-- WHY feed_types LOSES ITS LOWER-CASE CONSTRAINT
-- ---------------------------------------------------------------------------
-- Every other vocabulary stores a short lower-case code and a human label:
-- `corn` displays as "Corn" and the sheet receives "Corn". These three cannot,
-- and the reason is history rather than taste. `feed_type`, `sampled_by` and
-- `tested_by_qo` were FREE TEXT until 0036, so the database already holds
-- `Grower`, `Stefan` and `Kayla` exactly as an operator typed them. If the
-- code were `grower`, then one feed type would exist under two spellings
-- across the life of the record and nothing would group correctly — and the
-- alternative, rewriting recorded measurements, is the one thing a quality
-- system must not do.
--
-- `feed_types` is EMPTY, so dropping the constraint rewrites nothing.
-- `sampling_points` already has no such constraint, for its own reasons, so
-- this is a precedent rather than a novelty.
-- ===========================================================================


alter table public.feed_types drop constraint feed_types_code_lower;


-- ---------------------------------------------------------------------------
-- 1. The two people lists.
--
-- Two tables and not one with a flag: the existing five are one table per
-- list and the writer branches on the name, so a sixth shape would be the
-- odd one out. Somebody who both samples and tests appears in both, which is
-- the truth about them rather than a duplication.
--
-- These name who DID the work. They confer nothing: the permission matrix
-- decides who may record a result, on the server, and a name in this table
-- is not a grant.
-- ---------------------------------------------------------------------------

create table public.samplers (
  code       text primary key,
  label      text not null,
  sort_order integer not null default 100,
  active     boolean not null default true,
  constraint samplers_label_present check (length(btrim(label)) > 0)
);

create table public.testers (
  code       text primary key,
  label      text not null,
  sort_order integer not null default 100,
  active     boolean not null default true,
  constraint testers_label_present check (length(btrim(label)) > 0)
);

alter table public.samplers enable row level security;
alter table public.testers  enable row level security;

-- Readable by any active user, like every other vocabulary: the forms need
-- them. Not readable by a pending account. No write policy — writes go
-- through `rpc_upsert_controlled_value` under `user.manage`.
create policy samplers_select_active on public.samplers
  for select to authenticated using (public.is_active_user());
create policy testers_select_active on public.testers
  for select to authenticated using (public.is_active_user());

grant select on public.samplers to authenticated;
grant select on public.testers  to authenticated;


-- ---------------------------------------------------------------------------
-- 2. The rows.
--
-- `active` carries the retirement. The values an operator should pick are
-- active; the ones already recorded before the field had a list are INACTIVE
-- — still legal, still encodable, still shown on the record that holds them,
-- and not offered for a new one. That is exactly what `active` was for, and
-- it means retiring a value is now a toggle on the admin screen rather than
-- a release.
-- ---------------------------------------------------------------------------

insert into public.feed_types (code, label, sort_order, active) values
  ('Pre-starter', 'Pre-starter', 10, true),
  ('Starter',     'Starter',     20, true),
  ('Grower',      'Grower',      30, true),
  ('Finisher',    'Finisher',    40, true),
  -- Recorded before the list existed. `Crumble`, `Pellet` and `Pellets` are
  -- feed FORMS that were entered where a feed TYPE was asked for, which is
  -- itself the argument for having a list.
  ('Crumble', 'Crumble', 900, false),
  ('Pellet',  'Pellet',  901, false),
  ('Pellets', 'Pellets', 902, false),
  ('Broiler Starter (TEST)', 'Broiler Starter (TEST)', 903, false),
  ('TEST Broiler Starter', 'TEST Broiler Starter', 904, false),
  ('TEST BROILER STARTER CRUMBLE (E2E)', 'TEST BROILER STARTER CRUMBLE (E2E)', 905, false),
  ('TEST LAYER MASH (E2E)', 'TEST LAYER MASH (E2E)', 906, false)
on conflict (code) do nothing;

insert into public.samplers (code, label, sort_order, active) values
  ('Stefan', 'Stefan', 10, true),
  ('Satesh', 'Satesh', 20, true),
  ('Kayla',  'Kayla',  30, true),
  ('TEST E2E (do not action)', 'TEST E2E (do not action)', 900, false),
  ('TEST OPERATOR', 'TEST OPERATOR', 901, false),
  ('TEST Quality Officer', 'TEST Quality Officer', 902, false),
  ('TEST Quality Manager', 'TEST Quality Manager', 903, false),
  ('Autosync Check', 'Autosync Check', 904, false),
  ('Live Form Check', 'Live Form Check', 905, false),
  ('Test Account (BFF QA)', 'Test Account (BFF QA)', 906, false)
on conflict (code) do nothing;

insert into public.testers (code, label, sort_order, active) values
  ('Stefan', 'Stefan', 10, true),
  ('Kayla',  'Kayla',  20, true)
on conflict (code) do nothing;


-- ---------------------------------------------------------------------------
-- 3. The writer learns the two new lists, and stops lower-casing feed types.
-- ---------------------------------------------------------------------------

create or replace function public.rpc_upsert_controlled_value(
  p_actor           uuid,
  p_idempotency_key text,
  p_payload_hash    text,
  p_app_version     text,
  p_list_key        text,
  p_value           text,
  p_label           text,
  p_active          boolean,
  p_reason          text
)
returns table (
  list_key    text,
  value       text,
  label       text,
  active      boolean,
  recorded_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_basis  text;
  v_code   text;
  v_label  text;
  v_active boolean;
  v_now    timestamptz := now();
begin
  v_basis := public.require_permission(p_actor, 'user.manage');
  perform public.claim_mutation(
    p_idempotency_key, 'upsert_controlled_value', p_actor, p_payload_hash
  );

  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'BFF_REASON_REQUIRED: record why this list entry is changing'
      using errcode = '22023';
  end if;

  if coalesce(btrim(p_value), '') = '' then
    raise exception 'BFF_VALUE_REQUIRED: a list entry needs a value' using errcode = '22023';
  end if;

  -- Five static branches rather than one dynamic statement. This function is
  -- SECURITY DEFINER, so a table name assembled from an argument and run
  -- through EXECUTE would be privileged dynamic SQL built from caller input --
  -- avoidable here, and so avoided. An unrecognised list is refused, which also
  -- makes p_list_key a controlled vocabulary in its own right.
  --
  -- The label defaults to the value for a NEW entry: every one of these tables
  -- has `label not null` with a non-empty check, and inventing a prettier label
  -- would be inventing data. Leaving p_label null on an EXISTING entry keeps the
  -- label it has.
  if p_list_key = 'materials' then
    v_code := lower(btrim(p_value));
    insert into public.materials (code, label, active)
    values (v_code, coalesce(nullif(btrim(coalesce(p_label, '')), ''), v_code),
            coalesce(p_active, true))
    on conflict (code) do update
      set label  = coalesce(nullif(btrim(coalesce(p_label, '')), ''), public.materials.label),
          active = coalesce(p_active, public.materials.active)
    returning public.materials.code, public.materials.label, public.materials.active
      into v_code, v_label, v_active;

  elsif p_list_key = 'feed_types' then
    -- NOT lower-cased any more, and 0037 drops the constraint that required
    -- it. The code for this list IS the text that is stored on the
    -- measurement and written to the sheet, because the column was free text
    -- until 0036 and the database already holds `Grower` as an operator
    -- typed it. A lower-cased code would have split one feed type into two
    -- spellings across the history of the record.
    v_code := btrim(p_value);
    insert into public.feed_types (code, label, active)
    values (v_code, coalesce(nullif(btrim(coalesce(p_label, '')), ''), v_code),
            coalesce(p_active, true))
    on conflict (code) do update
      set label  = coalesce(nullif(btrim(coalesce(p_label, '')), ''), public.feed_types.label),
          active = coalesce(p_active, public.feed_types.active)
    returning public.feed_types.code, public.feed_types.label, public.feed_types.active
      into v_code, v_label, v_active;

  elsif p_list_key = 'suppliers' then
    v_code := lower(btrim(p_value));
    insert into public.suppliers (code, label, active)
    values (v_code, coalesce(nullif(btrim(coalesce(p_label, '')), ''), btrim(p_value)),
            coalesce(p_active, true))
    on conflict (code) do update
      set label  = coalesce(nullif(btrim(coalesce(p_label, '')), ''), public.suppliers.label),
          active = coalesce(p_active, public.suppliers.active)
    returning public.suppliers.code, public.suppliers.label, public.suppliers.active
      into v_code, v_label, v_active;

  elsif p_list_key = 'sampling_points' then
    -- NOT lower-cased: the codes are 'AM' and 'BC', they drive the sample-ID
    -- prefix, and this table deliberately carries no lower-case constraint.
    v_code := btrim(p_value);
    insert into public.sampling_points (code, label, active)
    values (v_code, coalesce(nullif(btrim(coalesce(p_label, '')), ''), v_code),
            coalesce(p_active, true))
    on conflict (code) do update
      set label  = coalesce(nullif(btrim(coalesce(p_label, '')), ''), public.sampling_points.label),
          active = coalesce(p_active, public.sampling_points.active)
    returning public.sampling_points.code, public.sampling_points.label,
              public.sampling_points.active
      into v_code, v_label, v_active;

  elsif p_list_key = 'mill_screen_sizes' then
    v_code := btrim(p_value);
    insert into public.mill_screen_sizes (code, label, active)
    values (v_code, coalesce(nullif(btrim(coalesce(p_label, '')), ''), v_code),
            coalesce(p_active, true))
    on conflict (code) do update
      set label  = coalesce(nullif(btrim(coalesce(p_label, '')), ''),
                            public.mill_screen_sizes.label),
          active = coalesce(p_active, public.mill_screen_sizes.active)
    returning public.mill_screen_sizes.code, public.mill_screen_sizes.label,
              public.mill_screen_sizes.active
      into v_code, v_label, v_active;

  elsif p_list_key = 'samplers' then
    -- Case preserved, for the same reason as feed_types above.
    v_code := btrim(p_value);
    insert into public.samplers (code, label, active)
    values (v_code, coalesce(nullif(btrim(coalesce(p_label, '')), ''), v_code),
            coalesce(p_active, true))
    on conflict (code) do update
      set label  = coalesce(nullif(btrim(coalesce(p_label, '')), ''), public.samplers.label),
          active = coalesce(p_active, public.samplers.active)
    returning public.samplers.code, public.samplers.label, public.samplers.active
      into v_code, v_label, v_active;

  elsif p_list_key = 'testers' then
    -- Case preserved, for the same reason as feed_types above.
    v_code := btrim(p_value);
    insert into public.testers (code, label, active)
    values (v_code, coalesce(nullif(btrim(coalesce(p_label, '')), ''), v_code),
            coalesce(p_active, true))
    on conflict (code) do update
      set label  = coalesce(nullif(btrim(coalesce(p_label, '')), ''), public.testers.label),
          active = coalesce(p_active, public.testers.active)
    returning public.testers.code, public.testers.label, public.testers.active
      into v_code, v_label, v_active;

  else
    raise exception
      'BFF_UNKNOWN_LIST: "%" is not a controlled vocabulary. The lists are materials, feed_types, suppliers, sampling_points, mill_screen_sizes, samplers and testers.',
      p_list_key
      using errcode = '22023';
  end if;

  perform public.record_audit_event(
    p_action             => 'controlled_value.upserted',
    p_entity_type        => 'controlled_value',
    p_entity_id          => p_list_key || ':' || v_code,
    p_reason             => btrim(p_reason),
    p_after              => jsonb_build_object(
                              'list_key', p_list_key,
                              'value', v_code,
                              'label', v_label,
                              'active', v_active,
                              -- Recorded when the stored code differs from what
                              -- was sent, so the normalisation is visible in the
                              -- trail and not only in the reply.
                              'submitted_value', p_value
                            ),
    p_outcome            => 'succeeded',
    p_authority_basis    => v_basis,
    p_actor_id           => p_actor,
    p_deployment_version => p_app_version
  );

  perform public.mark_mutation_committed(p_idempotency_key, null);

  return query select p_list_key, v_code, v_label, v_active, v_now;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. The read grants the Edge Functions now need, declared with the change.
--
-- 0023 established that every table an Edge Function reads directly carries
-- an explicit `service_role` select grant — the service role has no blanket
-- access in this project — and `tests/serviceRoleReadContract.test.ts`
-- compares the two sides. `register-sample` and `update-results` now read
-- these three before validating a payload, because the option list is the
-- validation contract and the SERVER is where it is enforced. A list the
-- browser could read and the server could not would be a dropdown that
-- offers values the server refuses.
-- ---------------------------------------------------------------------------

grant select on public.feed_types to service_role;
grant select on public.samplers   to service_role;
grant select on public.testers    to service_role;

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
    'system_config',
    -- Added 0037: the three controlled vocabularies the forms validate
    -- against. The server enforces the option list, so the server reads it.
    'feed_types',
    'samplers',
    'testers'
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

select public.assert_service_role_reads();


-- ---------------------------------------------------------------------------
-- 5. Prove no recorded value became unreachable.
--
-- The same check 0036 made against `stage_fields`, now against the tables
-- that supersede it as the source of truth. A measurement whose value is in
-- neither the active nor the inactive rows could never be written to the
-- spreadsheet again.
-- ---------------------------------------------------------------------------

do $$
declare
  v_orphans text;
begin
  select string_agg(format('%s = %L', x.field_key, x.text_value), '; ')
    into v_orphans
  from (
    select distinct m.field_key, m.text_value
    from public.sample_measurements m
    where m.field_key in ('feed_type', 'sampled_by', 'tested_by_qo')
      and m.text_value is not null
  ) x
  where not exists (
    select 1 from public.feed_types f
     where x.field_key = 'feed_type' and f.code = x.text_value
    union all
    select 1 from public.samplers s
     where x.field_key = 'sampled_by' and s.code = x.text_value
    union all
    select 1 from public.testers t
     where x.field_key = 'tested_by_qo' and t.code = x.text_value
  );

  if v_orphans is not null then
    raise exception
      'These recorded values are in no list, so the records holding them could never be written to the spreadsheet again: %. Add them as inactive rows rather than dropping them.',
      v_orphans using errcode = '23514';
  end if;
end;
$$;
