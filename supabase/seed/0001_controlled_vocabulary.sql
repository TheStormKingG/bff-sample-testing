-- ===========================================================================
-- supabase/seed/0001_controlled_vocabulary.sql
--
-- PRODUCTION-SAFE SEED. Listed first in `[db.seed].sql_paths` of
-- supabase/config.toml and applied by `supabase db reset`.
--
-- The controlled vocabularies an operator picks from. Every code and label
-- here is taken from the option constants in src/forms/registry.ts, which are
-- themselves taken from the workbook `Read me` tab, so the value written to a
-- Google Sheets cell is the value the plant already uses. A code that drifts
-- from the registry is a silent data-quality fault: the form would offer a
-- choice the ledger cannot store, or store one the sheet does not recognise.
--
-- WHAT IS NOT HERE, AND WHY:
--   * `suppliers`        ships EMPTY. 0002_samples.sql: "inventing a supplier
--                        name would put a fabricated party on a quality
--                        record." An administrator adds the real ones.
--   * `feed_types`       ships EMPTY. The registry's `feed_type` and
--                        `material_or_feed_type` fields are `type: 'text'`
--                        with no option list, so the workbook has never
--                        published a closed set of feed types. Seeding a
--                        guessed list would invent production vocabulary.
--   * `sample_prefixes`, `stage_definitions`, `stage_fields` are STRUCTURAL
--                        and ship with 0002_samples.sql, not with this seed.
--   * No acceptance limit of any kind. Limits are imported, unapproved, by
--     0002_specification_reference_import.sql (build rule 7).
--
-- Re-runnable. `on conflict` refreshes `label` and `sort_order` so the display
-- text stays in lockstep with the registry, but deliberately does NOT touch
-- `active`: deactivating a vocabulary item is an administrator's decision and
-- must survive a re-seed.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- materials  MATERIAL_OPTIONS in src/forms/registry.ts.
-- Codes are lower-case: `materials_code_lower` enforces it.
-- ---------------------------------------------------------------------------

insert into public.materials (code, label, sort_order) values
  ('corn',  'Corn',  10),
  ('rice',  'Rice',  20),
  ('soya',  'Soya',  30),
  ('other', 'Other', 40)
on conflict (code) do update
  set label = excluded.label,
      sort_order = excluded.sort_order;


-- ---------------------------------------------------------------------------
-- sampling_points  SAMPLING_POINT_OPTIONS in src/forms/registry.ts.
--
-- Codes are UPPER-case 'AM' and 'BC', and that casing is load-bearing:
-- public.sample_prefixes already references these two codes (0002_samples.sql)
-- to resolve a sample-ID prefix server-side, and the BC-moisture
-- applicability rule keys off the code rather than the display text
-- (PRD section 5.2 forbids substring-matching the label). There is no
-- `sampling_points_code_lower` constraint, precisely because of this.
--
-- NOTE: because the structural `sample_prefixes` rows in 0002_samples.sql hold
-- a foreign key to this table, these two rows must exist BEFORE that insert
-- runs. A seed file cannot satisfy a constraint checked during a migration,
-- so the two rows also belong in 0002_samples.sql. The `on conflict` below
-- makes this statement a harmless no-op once they are there.
-- ---------------------------------------------------------------------------

insert into public.sampling_points (code, label, sort_order) values
  ('AM', 'AM after mill',           10),
  ('BC', 'BC before conditioning',  20)
on conflict (code) do update
  set label = excluded.label,
      sort_order = excluded.sort_order;


-- ---------------------------------------------------------------------------
-- mill_screen_sizes  MILL_SCREEN_OPTIONS in src/forms/registry.ts.
--
-- `Read me`: "Mill screen size (5 or 7 mm)". Categorical, not a measurement:
-- 6 is not "between" these two values, and an operator cannot add a third.
-- The label is the bare digit, exactly as the registry offers it; the unit is
-- carried by the field, not by the option.
-- ---------------------------------------------------------------------------

insert into public.mill_screen_sizes (code, label, sort_order) values
  ('5', '5', 10),
  ('7', '7', 20)
on conflict (code) do update
  set label = excluded.label,
      sort_order = excluded.sort_order;


-- ---------------------------------------------------------------------------
-- End-state gate.
--
-- Asserting over what is actually in the table, not over the fact that the
-- statements above were issued. An insert that silently did nothing  a
-- conflict target that stopped matching, a code whose case changed  leaves no
-- other trace, and the application would then render an empty picker with no
-- error anywhere. This block runs in every environment, not only in tests.
-- ---------------------------------------------------------------------------

do $$
declare
  v_materials  integer;
  v_points     integer;
  v_screens    integer;
  v_bad_labels text;
begin
  select count(*) into v_materials from public.materials
   where code in ('corn', 'rice', 'soya', 'other');
  select count(*) into v_points from public.sampling_points
   where code in ('AM', 'BC');
  select count(*) into v_screens from public.mill_screen_sizes
   where code in ('5', '7');

  if v_materials <> 4 then
    raise exception 'Controlled vocabulary seed: expected 4 materials, found %', v_materials;
  end if;
  if v_points <> 2 then
    raise exception 'Controlled vocabulary seed: expected sampling points AM and BC, found %', v_points;
  end if;
  if v_screens <> 2 then
    raise exception 'Controlled vocabulary seed: expected mill screen sizes 5 and 7, found %', v_screens;
  end if;

  -- The labels are what reaches a Google Sheets cell, so a drifted label is a
  -- data fault even though every code is present.
  select string_agg(format('%s=%L', code, label), ', ' order by code)
    into v_bad_labels
    from (
      select code, label from public.sampling_points
       where (code = 'AM' and label <> 'AM after mill')
          or (code = 'BC' and label <> 'BC before conditioning')
      union all
      select code, label from public.materials
       where (code = 'corn'  and label <> 'Corn')
          or (code = 'rice'  and label <> 'Rice')
          or (code = 'soya'  and label <> 'Soya')
          or (code = 'other' and label <> 'Other')
    ) drifted;

  if v_bad_labels is not null then
    raise exception
      'Controlled vocabulary seed: label does not match src/forms/registry.ts (%)',
      v_bad_labels;
  end if;

  raise notice
    'Controlled vocabulary seeded: % materials, % sampling points, % mill screen sizes. suppliers and feed_types are intentionally empty.',
    v_materials, v_points, v_screens;
end $$;
