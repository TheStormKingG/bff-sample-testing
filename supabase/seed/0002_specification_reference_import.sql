-- ===========================================================================
-- supabase/seed/0002_specification_reference_import.sql
--
-- The 34 entries of the workbook `Limits` tab, imported for REFERENCE ONLY.
--
--   *** ZERO of the 34 entries is approved. NONE may ever be approved here. ***
--
-- Every row below is written with status = 'reference_only', approved_by NULL
-- and proposed_by NULL. That is not a gap waiting to be filled in; it is the
-- state of the source. The live `Limits` tab as read on 2026-10-24 contains
-- 27 "To set", 4 "Set", 2 "Confirm with Polinutri" and 1 "To set with
-- Polinutri" - and not one "Approved". Specifically:
--
--   * The four "Set" rows (#13, #14, #15, #27) are POLINUTRI VENDOR REFERENCE
--     values recorded at the feed factory specialist's visit of 23 October
--     2026. A vendor's recommendation is not a Bounty Farm acceptance limit.
--   * Two rows (#25, #26) carry bounds that explicitly await Polinutri
--     confirmation.
--   * One row (#8) carries an OBSERVATION - "850 to 950 µm seen after the
--     feed factory specialist's changes, October 2026" - with the Lowest and
--     Highest cells left empty. An observation of what was seen is not a
--     limit, so no bounds are recorded for it.
--
-- The consequence is intended: on this data EVERY measurement assesses as
-- Not Assessable, with reason `no_approved_rule`. That is FR-009, UAT-05 and
-- risk R-01 behaving correctly. Making the application look "finished" by
-- seeding a plausible number would put an invented acceptance limit on a
-- quality record, which build rule 7 forbids outright. A limit becomes
-- assessable only when a Quality Supervisor proposes and a DIFFERENT person
-- approves a new version through public.approve_specification() - a
-- separation the database enforces with the
-- `specification_versions_two_person_approval` CHECK, not by convention.
--
-- NOTHING IS KEYED BY SPREADSHEET ROW. `Limits` row 2 warns: "Do not add,
-- delete or move rows, because the test tabs read these cells by their
-- position." The rule key is the stable `parameter_key` from
-- src/forms/registry.ts; the workbook's own entry number travels as
-- provenance in `workbook_entry_no` and is never used to find a rule.
--
-- Values are VERBATIM from docs/workbook-verification.md section 5, including
-- the literal unit string 'to confirm' for #13, the empty unit for the three
-- GSD entries (#9, #11, #34 - a dimensionless ratio), and all four status
-- strings.
--
-- Nine entries (#7, #13, #14, #19, #20, #21, #22, #23, #27) describe an
-- EQUIPMENT SETTING rather than a product test result and are flagged
-- `is_machine_setting = true`. A setting outside a working range is a
-- process-control signal, not a product conformity decision, and the two must
-- not be conflated when a rule is eventually approved (workbook decision
-- D-09).
--
-- PRODUCTION-SAFE. Listed in `[db.seed].sql_paths` of supabase/config.toml.
-- Re-runnable: both inserts are keyed on their natural identity and conflict
-- to DO NOTHING, so a re-seed cannot duplicate a limit or revive an entry a
-- Quality Supervisor has since superseded.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- One `specifications` row per quality parameter: 28 of them, one for each
-- `parameterKey` in src/forms/registry.ts.
--
-- 28 parameters carry 34 workbook entries because six parameters are limited
-- per material or per sampling point: raw-material moisture and aflatoxin are
-- each stated three times (Corn / Rice / Soya), and ground average particle
-- size and size spread are each stated twice (AM / BC). Those distinctions
-- live in the VERSION's applicability filters (`material_code`,
-- `sampling_point`), which is what src/lib/assessment.ts scores for
-- specificity - not in the parameter identity.
--
-- `workbook_sample_label` is therefore left NULL for exactly those six
-- parameters: the workbook's Sample column holds the material or the sampling
-- point there, and copying one of three values onto the shared parent would
-- misrepresent the other two.
--
-- `title` is the registry's own field label, so a process owner signing off a
-- limit sees the words the form shows the operator.
-- ---------------------------------------------------------------------------

insert into public.specifications (
  parameter_key, stage, title, workbook_sample_label, workbook_test_label,
  is_machine_setting, notes
) values
  -- 1 Raw materials -------------------------------------------------------
  ('raw_materials.moisture', 'raw_materials', 'Moisture',
   null, 'Moisture', false,
   'Stated three times in the workbook, once per material (entries 1-3: Corn, Rice, Soya). The material is the version applicability filter.'),
  ('raw_materials.aflatoxin', 'raw_materials', 'Aflatoxin',
   null, 'Aflatoxin', false,
   'Stated three times in the workbook, once per material (entries 4-6: Corn, Rice, Soya). The material is the version applicability filter.'),

  -- 2 Ground --------------------------------------------------------------
  ('ground.hammer_distance', 'ground', 'Hammer distance from screen',
   'Hammer mill setting', 'Hammer distance from screen', true,
   'EQUIPMENT SETTING (workbook decision D-09): a hammer mill adjustment, not a product test result.'),
  ('ground.avg_particle_size', 'ground', 'Average particle size',
   null, 'Average particle size', false,
   'Stated twice in the workbook, once per sampling point (entries 8 and 10: AM and BC). The sampling point is the version applicability filter.'),
  ('ground.size_spread_gsd', 'ground', 'Size spread (GSD)',
   null, 'Size spread (GSD)', false,
   'Stated twice in the workbook, once per sampling point (entries 9 and 11: AM and BC). GSD is a dimensionless ratio and the workbook Unit cell is empty for both.'),
  ('ground.moisture', 'ground', 'Moisture at BC',
   'Before conditioning (BC)', 'Moisture', false,
   'Applies at the BC sampling point only; moisture is not tested at AM.'),

  -- 3 Conditioned ---------------------------------------------------------
  ('conditioned.steam_pressure', 'conditioned', 'Steam pressure reading',
   'Conditioner setting', 'Steam pressure', true,
   'EQUIPMENT SETTING (workbook decision D-09). The workbook Unit cell literally reads "to confirm" (bar or kg/cm2 per its own note), so this reading can never be assessed as conforming until a unit is approved (R-02, UAT-07).'),
  ('conditioned.water_added', 'conditioned', 'Water added',
   'Conditioner setting', 'Water added', true,
   'EQUIPMENT SETTING (workbook decision D-09): a conditioner adjustment, not a product test result.'),
  ('conditioned.temperature', 'conditioned', 'Mash temperature',
   'Mash after conditioning', 'Temperature', false,
   'The UAT-06 boundary parameter. Its 84-86 degC Polinutri reference range is imported unapproved here; an APPROVED 84-86 rule exists only in supabase/seed/test_fixtures.sql and must never be loaded into production.'),
  ('conditioned.moisture', 'conditioned', 'Moisture',
   'Mash after conditioning', 'Moisture', false, null),

  -- 4 Pellets -------------------------------------------------------------
  ('pellets.temperature', 'pellets', 'Pellet temperature',
   'Pellets before crumbling', 'Temperature', false, null),
  ('pellets.pellet_diameter', 'pellets', 'Pellet diameter',
   'Pellets before crumbling', 'Pellet diameter', false, null),

  -- 5 Extruded soya -------------------------------------------------------
  ('extruded_soya.crusher_roller_gap', 'extruded_soya', 'Crusher roller gap',
   'Extruder setting', 'Crusher roller gap', true,
   'EQUIPMENT SETTING (workbook decision D-09).'),
  ('extruded_soya.steam_line', 'extruded_soya', 'Steam line',
   'Extruder setting', 'Steam line', true,
   'EQUIPMENT SETTING (workbook decision D-09).'),
  ('extruded_soya.steam_line_temperature', 'extruded_soya', 'Steam line temperature',
   'Extruder setting', 'Steam line temperature', true,
   'EQUIPMENT SETTING (workbook decision D-09).'),
  ('extruded_soya.extruder_temperature', 'extruded_soya', 'Extruder temperature',
   'Extruder setting', 'Extruder temperature', true,
   'EQUIPMENT SETTING (workbook decision D-09).'),
  ('extruded_soya.amount', 'extruded_soya', 'Amount',
   'Extruder setting', 'Amount', true,
   'EQUIPMENT SETTING (workbook decision D-09): extruder throughput, not a product test result.'),
  ('extruded_soya.moisture', 'extruded_soya', 'Moisture',
   'Extruded soya', 'Moisture', false, null),
  ('extruded_soya.urease', 'extruded_soya', 'Urease',
   'Extruded soya', 'Urease', false,
   'Workbook bounds 0.05-0.20 pH rise await Polinutri confirmation and are imported unapproved.'),
  ('extruded_soya.protein_solubility', 'extruded_soya', 'Protein solubility',
   'Extruded soya', 'Protein solubility', false,
   'Workbook bounds 70-85 % await Polinutri confirmation and are imported unapproved.'),

  -- 6 Crumble -------------------------------------------------------------
  ('crumble.roll_gap', 'crumble', 'Crumbler roll gap',
   'Crumbler setting', 'Roll gap', true,
   'EQUIPMENT SETTING (workbook decision D-09): a crumbler adjustment, not a product test result.'),
  ('crumble.moisture', 'crumble', 'Moisture',
   'Finished crumble', 'Moisture', false, null),
  ('crumble.avg_particle_size', 'crumble', 'Average particle size',
   'Finished crumble', 'Average particle size', false, null),
  ('crumble.pellet_durability_pdi', 'crumble', 'Pellet durability (PDI)',
   'Finished crumble', 'Pellet durability (PDI)', false, null),
  ('crumble.crumble_size', 'crumble', 'Crumble size',
   'Finished crumble', 'Crumble size', false, null),

  -- 7 Mash ----------------------------------------------------------------
  ('mash.moisture', 'mash', 'Moisture',
   'Finished mash', 'Moisture', false, null),
  ('mash.avg_particle_size', 'mash', 'Average particle size',
   'Finished mash', 'Average particle size', false, null),
  ('mash.size_spread_gsd', 'mash', 'Size spread (GSD)',
   'Finished mash', 'Size spread (GSD)', false,
   'GSD is a dimensionless ratio and the workbook Unit cell is empty.')
on conflict (parameter_key) do nothing;


-- ---------------------------------------------------------------------------
-- The 34 workbook entries as `reference_only` versions.
--
-- status, proposed_by and approved_by are NOT columns of the VALUES list
-- below: they are constants in the SELECT, so there is no per-row place where
-- an approval could be introduced by editing a tuple. The database would
-- refuse it anyway - `specification_versions_reference_only_unapproved`
-- requires both actors to be NULL at this status - but the shape of the
-- statement should make the intent unmistakable to a reader too.
--
-- `effective_from` is the workbook read instant, which is when the entry
-- entered this ledger as provenance. It is deliberately a literal and not
-- now(), so the seed is reproducible and two environments agree. It does not
-- make anything effective: `reference_only` is excluded from the approved-rule
-- index and from every assessment path.
--
-- Bounds are recorded only where the workbook actually carries them (6 of 34
-- entries: #13, #14, #15, #25, #26, #27). Everywhere else both bounds are
-- NULL because both source cells are empty. A NULL bound is the honest
-- representation of "not set"; it is never a zero.
-- ---------------------------------------------------------------------------

insert into public.specification_versions (
  specification_id, version, parameter_key, stage,
  material_code, sampling_point, unit, lower_bound, upper_bound,
  status, effective_from, source_evidence, workbook_entry_no, workbook_status
)
select
  s.id,
  v.version,
  v.parameter_key,
  s.stage,
  v.material_code,
  v.sampling_point,
  v.unit,
  v.lower_bound,
  v.upper_bound,
  'reference_only'::public.spec_status,            -- never anything else
  '2026-10-24 00:00:00+00'::timestamptz,
  format(
    'Workbook "BFF-FRM-06_18_Sample_Test_Log_DRAFT", `Limits` tab entry %s, read 2026-10-24 '
    || '(docs/workbook-verification.md section 5). Status in source: "%s". '
    || 'Imported for reference only and NOT a Bounty Farm approval. %s',
    v.entry_no, v.workbook_status, v.note
  ),
  v.entry_no,
  v.workbook_status::public.workbook_limit_status
from (values
  -- entry, parameter_key, ver, material, point, unit, low, high, workbook status, note
  --
  -- 1 Raw materials ------------------------------------------------------
  (1,  'raw_materials.moisture',  1, 'corn', null::text, '%', null::numeric, null::numeric, 'To set',
   'Both bound cells are empty, so no bounds are recorded.'),
  (2,  'raw_materials.moisture',  2, 'rice', null, '%', null, null, 'To set',
   'Both bound cells are empty, so no bounds are recorded.'),
  (3,  'raw_materials.moisture',  3, 'soya', null, '%', null, null, 'To set',
   'Both bound cells are empty, so no bounds are recorded.'),
  (4,  'raw_materials.aflatoxin', 1, 'corn', null, 'ppb', null, null, 'To set',
   'Both bound cells are empty, so no bounds are recorded.'),
  (5,  'raw_materials.aflatoxin', 2, 'rice', null, 'ppb', null, null, 'To set',
   'Both bound cells are empty, so no bounds are recorded.'),
  (6,  'raw_materials.aflatoxin', 3, 'soya', null, 'ppb', null, null, 'To set',
   'Both bound cells are empty, so no bounds are recorded.'),

  -- 2 Ground -------------------------------------------------------------
  (7,  'ground.hammer_distance',  1, null, null, 'mm', null, null, 'To set',
   'EQUIPMENT SETTING (decision D-09), not a product test result. Both bound cells are empty.'),
  (8,  'ground.avg_particle_size', 1, null, 'AM', 'µm', null, null, 'To set with Polinutri',
   'A fourth status value, undocumented in the PRD and found in the 2026-10-24 live read. '
   || 'The Lowest and Highest cells are EMPTY; the workbook note reads "850 to 950 µm seen after '
   || 'the feed factory specialist''s changes, October 2026". That is an observation of what was '
   || 'seen, not an acceptance limit, so no bounds are recorded from it.'),
  (9,  'ground.size_spread_gsd',  1, null, 'AM', null, null, null, 'To set',
   'The Unit cell is empty: GSD is a dimensionless ratio. A NULL unit is unconfirmed, '
   || 'so this parameter could not be assessed even if bounds were approved.'),
  (10, 'ground.avg_particle_size', 2, null, 'BC', 'µm', null, null, 'To set',
   'Both bound cells are empty, so no bounds are recorded.'),
  (11, 'ground.size_spread_gsd',  2, null, 'BC', null, null, null, 'To set',
   'The Unit cell is empty: GSD is a dimensionless ratio. A NULL unit is unconfirmed, '
   || 'so this parameter could not be assessed even if bounds were approved.'),
  (12, 'ground.moisture',         1, null, 'BC', '%', null, null, 'To set',
   'Both bound cells are empty, so no bounds are recorded.'),

  -- 3 Conditioned --------------------------------------------------------
  (13, 'conditioned.steam_pressure', 1, null, null, 'to confirm', 2.2, 2.8, 'Set',
   'EQUIPMENT SETTING (decision D-09). The bounds are a POLINUTRI VENDOR REFERENCE from the feed '
   || 'factory specialist''s visit of 23 October 2026, not a Bounty Farm acceptance limit. '
   || 'The Unit cell literally reads "to confirm" (bar or kg/cm2 per its own note), so '
   || 'isUnitConfirmed() is false and this reading can never be assessed as conforming (R-02, UAT-07).'),
  (14, 'conditioned.water_added',    1, null, null, '%', 0.5, 1, 'Set',
   'EQUIPMENT SETTING (decision D-09). The bounds are a POLINUTRI VENDOR REFERENCE from the feed '
   || 'factory specialist''s visit of 23 October 2026, not a Bounty Farm acceptance limit.'),
  (15, 'conditioned.temperature',    1, null, null, '°C', 84, 86, 'Set',
   'The bounds are a POLINUTRI VENDOR REFERENCE from the feed factory specialist''s visit of '
   || '23 October 2026, not a Bounty Farm acceptance limit. This is the UAT-06 boundary range; '
   || 'an APPROVED copy of it exists only in supabase/seed/test_fixtures.sql, never in production.'),
  (16, 'conditioned.moisture',       1, null, null, '%', null, null, 'To set',
   'Both bound cells are empty, so no bounds are recorded.'),

  -- 4 Pellets ------------------------------------------------------------
  (17, 'pellets.temperature',      1, null, null, '°C', null, null, 'To set',
   'Both bound cells are empty, so no bounds are recorded.'),
  (18, 'pellets.pellet_diameter',  1, null, null, 'mm', null, null, 'To set',
   'Both bound cells are empty, so no bounds are recorded.'),

  -- 5 Extruded soya ------------------------------------------------------
  (19, 'extruded_soya.crusher_roller_gap',    1, null, null, 'mm', null, null, 'To set',
   'EQUIPMENT SETTING (decision D-09), not a product test result. Both bound cells are empty.'),
  (20, 'extruded_soya.steam_line',            1, null, null, '%', null, null, 'To set',
   'EQUIPMENT SETTING (decision D-09), not a product test result. Both bound cells are empty.'),
  (21, 'extruded_soya.steam_line_temperature', 1, null, null, '°C', null, null, 'To set',
   'EQUIPMENT SETTING (decision D-09), not a product test result. Both bound cells are empty.'),
  (22, 'extruded_soya.extruder_temperature',  1, null, null, '°C', null, null, 'To set',
   'EQUIPMENT SETTING (decision D-09), not a product test result. Both bound cells are empty.'),
  (23, 'extruded_soya.amount',                1, null, null, 'ton/hr', null, null, 'To set',
   'EQUIPMENT SETTING (decision D-09): extruder throughput, not a product test result. '
   || 'Both bound cells are empty.'),
  (24, 'extruded_soya.moisture',              1, null, null, '%', null, null, 'To set',
   'Both bound cells are empty, so no bounds are recorded.'),
  (25, 'extruded_soya.urease',                1, null, null, 'pH rise', 0.05, 0.20, 'Confirm with Polinutri',
   'Bounds are present in the workbook but explicitly await Polinutri confirmation, so they are '
   || 'preserved as reference and cannot drive an assessment.'),
  (26, 'extruded_soya.protein_solubility',    1, null, null, '%', 70, 85, 'Confirm with Polinutri',
   'Bounds are present in the workbook but explicitly await Polinutri confirmation, so they are '
   || 'preserved as reference and cannot drive an assessment.'),

  -- 6 Crumble ------------------------------------------------------------
  (27, 'crumble.roll_gap',              1, null, null, 'mm', 1.2, 1.8, 'Set',
   'EQUIPMENT SETTING (decision D-09). The bounds are a POLINUTRI VENDOR REFERENCE from the feed '
   || 'factory specialist''s visit of 23 October 2026, not a Bounty Farm acceptance limit.'),
  (28, 'crumble.moisture',              1, null, null, '%', null, null, 'To set',
   'Both bound cells are empty, so no bounds are recorded.'),
  (29, 'crumble.avg_particle_size',     1, null, null, 'µm', null, null, 'To set',
   'Both bound cells are empty, so no bounds are recorded.'),
  (30, 'crumble.pellet_durability_pdi', 1, null, null, '%', null, null, 'To set',
   'Both bound cells are empty, so no bounds are recorded.'),
  (31, 'crumble.crumble_size',          1, null, null, 'mm', null, null, 'To set',
   'Both bound cells are empty, so no bounds are recorded.'),

  -- 7 Mash ---------------------------------------------------------------
  (32, 'mash.moisture',          1, null, null, '%', null, null, 'To set',
   'Both bound cells are empty, so no bounds are recorded.'),
  (33, 'mash.avg_particle_size', 1, null, null, 'µm', null, null, 'To set',
   'Both bound cells are empty, so no bounds are recorded.'),
  (34, 'mash.size_spread_gsd',   1, null, null, null, null, null, 'To set',
   'The Unit cell is empty: GSD is a dimensionless ratio. A NULL unit is unconfirmed, '
   || 'so this parameter could not be assessed even if bounds were approved.')
) as v(entry_no, parameter_key, version, material_code, sampling_point,
       unit, lower_bound, upper_bound, workbook_status, note)
join public.specifications s on s.parameter_key = v.parameter_key
on conflict (specification_id, version) do nothing;


-- ---------------------------------------------------------------------------
-- End-state gate.
--
-- This reads back what is actually in the tables. It does not check that the
-- statements above were issued: a statement can be syntactically valid,
-- semantically meaningful and still change nothing - an ON CONFLICT whose
-- target stopped matching, a join that silently dropped rows because a
-- parameter_key was renamed in the registry. Either leaves a short, clean,
-- entirely plausible dataset and no error anywhere.
--
-- The "0 approved" assertion is deliberately made AFTER the "34
-- reference_only" assertion, because a zero means two different things - the
-- population is empty, or the question never reached any rows - and only one
-- of them is the state we want. Counting 34 rows with the same `filter (where
-- status = ...)` mechanism first proves the instrument discriminates and that
-- the table is populated, so the following zero is evidence rather than
-- silence.
-- ---------------------------------------------------------------------------

do $$
declare
  v_specs       integer;
  v_versions    integer;
  v_reference   integer;
  v_approved    integer;
  v_has_actor   integer;
  v_settings    integer;
  v_with_bounds integer;
  v_entry_gaps  text;
  v_tally       text;
  v_unit_13     text;
  v_blank_units integer;
begin
  select count(*) into v_specs    from public.specifications;
  select count(*) into v_versions from public.specification_versions
   where workbook_entry_no is not null;

  -- Positive control: the instrument can find rows, and finds all 34.
  select count(*) filter (where status = 'reference_only')
    into v_reference
    from public.specification_versions
   where workbook_entry_no is not null;

  -- The assertion that matters, using the same mechanism just proven to work.
  select count(*) filter (where status = 'approved')
    into v_approved
    from public.specification_versions
   where workbook_entry_no is not null;

  select count(*) into v_has_actor from public.specification_versions
   where workbook_entry_no is not null
     and (approved_by is not null or proposed_by is not null
          or approved_at is not null or proposed_at is not null);

  select count(*) into v_settings from public.specifications
   where is_machine_setting;

  select count(*) into v_with_bounds from public.specification_versions
   where workbook_entry_no is not null
     and (lower_bound is not null or upper_bound is not null);

  if v_specs <> 28 then
    raise exception
      'Specification import: expected 28 parameters (one per parameterKey in src/forms/registry.ts), found %',
      v_specs;
  end if;

  if v_reference <> 34 then
    raise exception
      'Specification import: expected 34 reference_only workbook entries, found % (of % imported rows). The import did not land.',
      v_reference, v_versions;
  end if;

  if v_approved <> 0 then
    raise exception
      'Specification import: % workbook entry/entries carry status approved. ZERO of the 34 may be approved: none is approved in the source, and an approval here would let a vendor reference value or an unset limit decide material conformity.',
      v_approved;
  end if;

  if v_has_actor <> 0 then
    raise exception
      'Specification import: % imported entry/entries name a proposer or an approver. An imported workbook row has neither; it exists to be read and can never decide anything.',
      v_has_actor;
  end if;

  -- Every workbook entry number 1..34 present exactly once. A gap or a
  -- duplicate means a tuple was edited or dropped.
  select string_agg(n::text, ', ' order by n) into v_entry_gaps
    from generate_series(1, 34) n
   where not exists (
     select 1 from public.specification_versions sv
      where sv.workbook_entry_no = n
   );
  if v_entry_gaps is not null then
    raise exception 'Specification import: workbook entries missing: %', v_entry_gaps;
  end if;

  -- Status tally, verbatim from docs/workbook-verification.md section 5:
  -- 27 "To set", 4 "Set", 2 "Confirm with Polinutri", 1 "To set with Polinutri".
  select string_agg(format('%s=%s', workbook_status, c), ' ' order by workbook_status)
    into v_tally
    from (
      select workbook_status, count(*) c
        from public.specification_versions
       where workbook_entry_no is not null
       group by workbook_status
    ) t;
  if (select count(*) from public.specification_versions
       where workbook_entry_no is not null and workbook_status = 'To set') <> 27
     or (select count(*) from public.specification_versions
          where workbook_entry_no is not null and workbook_status = 'Set') <> 4
     or (select count(*) from public.specification_versions
          where workbook_entry_no is not null and workbook_status = 'Confirm with Polinutri') <> 2
     or (select count(*) from public.specification_versions
          where workbook_entry_no is not null and workbook_status = 'To set with Polinutri') <> 1
  then
    raise exception
      'Specification import: status tally does not match the verified workbook read (expected To set=27 Set=4 "Confirm with Polinutri"=2 "To set with Polinutri"=1, found %)',
      coalesce(v_tally, 'nothing');
  end if;

  if v_settings <> 9 then
    raise exception
      'Specification import: expected 9 equipment-setting parameters (workbook entries 7, 13, 14, 19-23, 27), found %',
      v_settings;
  end if;

  -- Exactly six source rows carry a bound: 13, 14, 15, 25, 26, 27. Any other
  -- row holding a number would be an invented acceptance limit (build rule 7).
  if v_with_bounds <> 6 then
    raise exception
      'Specification import: expected bounds on exactly 6 entries (13, 14, 15, 25, 26, 27), found % entries with a bound. A bound on any other entry is an invented limit.',
      v_with_bounds;
  end if;

  -- The unconfirmed-unit gate is driven by data, so the data must be right.
  select unit into v_unit_13 from public.specification_versions
   where workbook_entry_no = 13;
  if v_unit_13 is distinct from 'to confirm' then
    raise exception
      'Specification import: entry 13 unit must be the literal string "to confirm" as the workbook cell reads, found %',
      coalesce(quote_literal(v_unit_13), 'NULL');
  end if;

  select count(*) into v_blank_units from public.specification_versions
   where workbook_entry_no in (9, 11, 34) and unit is null;
  if v_blank_units <> 3 then
    raise exception
      'Specification import: the three GSD entries (9, 11, 34) have an empty Unit cell in the workbook and must carry a NULL unit; % of 3 do',
      v_blank_units;
  end if;

  raise notice
    'Specification reference import complete: % parameters, 34 workbook entries, ALL reference_only, 0 approved, % equipment settings, bounds on 6. Every measurement will assess as Not Assessable until a Quality Supervisor approves a rule (FR-009, UAT-05, R-01).',
    v_specs, v_settings;
end $$;
