-- ===========================================================================
-- 0029 — the sieve test on `2 Ground`, `6 Crumble` and `7 Mash`.
--
-- Three tabs carried a column called `Average particle size (µm)` and two of
-- them a `Size spread (GSD)` beside it: a figure and a spread, typed in from
-- an analyser reading. This migration removes them and gives each tab the
-- granulometry test that produces those two quantities — four settings,
-- fourteen sieve weights and the nine columns the server computes from them,
-- the same set `8 DGM` has carried since 0025.
--
-- ---------------------------------------------------------------------------
-- WHY REMOVING THEM LOSES NOTHING
-- ---------------------------------------------------------------------------
-- Both columns were `requiredness = 'testing'`, and this application has no
-- results-entry screen: `StageFormPage` hardcodes `phase = 'registration'`,
-- and `fieldsRequiredAt` matches the phase EXACTLY rather than cumulatively.
-- No operator could ever be prompted for them. Checked against the live
-- project before this was written:
--
--     select m.field_key, count(*) from sample_measurements m
--       join samples s on s.id = m.sample_uuid
--      where s.stage in ('ground','crumble','mash')
--        and m.field_key in ('avg_particle_size_um','size_spread_gsd')
--      group by 1;
--     -> 0 rows
--
-- So the composite foreign key `sample_measurements (stage, field_key)` has
-- nothing pointing at either column on these three stages and the deletes
-- below cannot orphan a measurement. If that query ever returns a row on a
-- project this is applied to, the delete FAILS rather than cascading, which
-- is the behaviour we want: it means somebody recorded a value and this
-- migration must not silently discard it.
--
-- The two quantities survive the change. `DGM (µm)` is the geometric mean
-- diameter — the same thing `Average particle size` named — and `Geometric
-- standard deviation` is the same thing `Size spread (GSD)` named. Both are
-- now computed from the weights that produced them rather than transcribed
-- from an instrument, and the weights stay in the record beside them.
--
-- ---------------------------------------------------------------------------
-- WHAT IS DELIBERATELY LEFT ALONE
-- ---------------------------------------------------------------------------
-- `specifications` still holds five rows whose `parameter_key` names a column
-- this migration removes: ground.avg_particle_size, ground.size_spread_gsd,
-- crumble.avg_particle_size, mash.avg_particle_size, mash.size_spread_gsd.
-- They are NOT deleted. There is no foreign key between the two tables, every
-- one of them is a draft with no approved version, and the assessment engine
-- only ever reads a specification through a measurement that cites its
-- parameter key — of which there are now none. Deleting them would destroy
-- somebody's draft limits to tidy up rows that cost nothing and that the lab
-- may still want to re-point at the computed columns later.
--
-- The nine computed columns carry NO parameter_key, here or on `8 DGM`. They
-- could not be assessed if they did: the engine assesses `sample_measurements`
-- rows, and a `system` column can never be one (0008:386 raises for exactly
-- that). A key on them would imply an acceptance limit exists (PRD FR-009,
-- UAT-05) for a figure the engine never looks at.
--
-- `8 DGM`'s own three setting keys — `mill_rpm`, `mill_hz_position`,
-- `grind_time` — are not renamed to match the `durability_tester_rpm`,
-- `sieve_shaker_hz`, `sieve_vibration_min` seeded below. Renaming them means
-- rewriting `sample_measurements.field_key` on live rows for the one stage
-- that was verified figure-by-figure against the lab's own workbook, and it
-- buys nothing this change needs. See the note in `src/forms/registry.ts`.
--
-- ---------------------------------------------------------------------------
-- WHY THE MOVES RUN RIGHTMOST FIRST
-- ---------------------------------------------------------------------------
-- `stage_fields` carries `unique (stage, column_letter)`, and it is not
-- deferrable, so it is checked per statement. Moving `moisture_pct_bc` from L
-- to N while `tested_by_qo` still sits at N would fail. Every block below
-- therefore moves the RIGHTMOST column first and walks left, so each target
-- letter has already been vacated by the time anything lands on it.
--
-- ---------------------------------------------------------------------------
-- THE SPREADSHEET MUST BE RESTRUCTURED TOO, AND BEFORE THIS
-- ---------------------------------------------------------------------------
-- `verifyWorkbook()` compares every `sheet_header` against row 4 of the live
-- tab and FAILS CLOSED on any mismatch, so between the workbook changing and
-- this migration landing, writes to these three tabs are refused. They are
-- refused, not corrupted — a registration returns an error and nothing
-- commits — but the window should still be short and should not span a
-- production shift. The columns are inserted into the workbook in place, so
-- the existing rows shift with them and no cell changes meaning.
-- ===========================================================================


-- ground: 2 Ground -> A:AN (40 columns)

-- a. The two analyser-reading columns the sieve test replaces.
delete from public.stage_fields where stage = 'ground' and field_key = 'avg_particle_size_um';
delete from public.stage_fields where stage = 'ground' and field_key = 'size_spread_gsd';

-- b. Columns that keep their meaning and move right. Rightmost first, so
--    no move ever lands on a letter still occupied (unique (stage, column_letter)).
update public.stage_fields set column_letter = 'AN'
  where stage = 'ground' and field_key = 'comments';   -- was O
update public.stage_fields set column_letter = 'AM'
  where stage = 'ground' and field_key = 'tested_by_qo';   -- was N
update public.stage_fields set column_letter = 'AL'
  where stage = 'ground' and field_key = 'action_taken';   -- was M
update public.stage_fields set column_letter = 'N'
  where stage = 'ground' and field_key = 'moisture_pct_bc';   -- was L

-- c. The sieve test: four settings, fourteen weights, nine computed results.
insert into public.stage_fields (
  stage, field_key, column_letter, sheet_header,
  field_type, section, requiredness,
  unit, unit_confirmed, parameter_key,
  hard_min, hard_max, implausible_above, decimals,
  adverse_value, applies_when_field, applies_when_values, select_options
) values
  ('ground', 'durability_tester_rpm', 'J', 'Durability tester RPM',
   'number', 'settings', 'optional',
   null, null, null,
   0, null, 10000, 0,
   null, null, null, null),
  ('ground', 'sieve_shaker_hz', 'K', 'Sieve shaker frequency (Hz)',
   'number', 'settings', 'optional',
   'Hz', true, null,
   0, null, 200, 0,
   null, null, null, null),
  ('ground', 'sieve_vibration_min', 'L', 'Vibration time (min)',
   'number', 'settings', 'optional',
   'min', true, null,
   0, null, 240, 0,
   null, null, null, null),
  ('ground', 'sieve_series', 'M', 'Sieve series',
   'select', 'settings', 'optional',
   null, null, null,
   null, null, null, null,
   null, null, null, array['abnt-standard-7']),
  ('ground', 'sieve1_tare_g', 'O', 'ABNT 5 empty sieve (g)',
   'number', 'test_results', 'optional',
   'g', true, null,
   0, null, 2000, 2,
   null, null, null, null),
  ('ground', 'sieve1_gross_g', 'P', 'ABNT 5 sieve + sample (g)',
   'number', 'test_results', 'optional',
   'g', true, null,
   0, null, 2000, 2,
   null, null, null, null),
  ('ground', 'sieve2_tare_g', 'Q', 'ABNT 10 empty sieve (g)',
   'number', 'test_results', 'optional',
   'g', true, null,
   0, null, 2000, 2,
   null, null, null, null),
  ('ground', 'sieve2_gross_g', 'R', 'ABNT 10 sieve + sample (g)',
   'number', 'test_results', 'optional',
   'g', true, null,
   0, null, 2000, 2,
   null, null, null, null),
  ('ground', 'sieve3_tare_g', 'S', 'ABNT 16 empty sieve (g)',
   'number', 'test_results', 'optional',
   'g', true, null,
   0, null, 2000, 2,
   null, null, null, null),
  ('ground', 'sieve3_gross_g', 'T', 'ABNT 16 sieve + sample (g)',
   'number', 'test_results', 'optional',
   'g', true, null,
   0, null, 2000, 2,
   null, null, null, null),
  ('ground', 'sieve4_tare_g', 'U', 'ABNT 30 empty sieve (g)',
   'number', 'test_results', 'optional',
   'g', true, null,
   0, null, 2000, 2,
   null, null, null, null),
  ('ground', 'sieve4_gross_g', 'V', 'ABNT 30 sieve + sample (g)',
   'number', 'test_results', 'optional',
   'g', true, null,
   0, null, 2000, 2,
   null, null, null, null),
  ('ground', 'sieve5_tare_g', 'W', 'ABNT 50 empty sieve (g)',
   'number', 'test_results', 'optional',
   'g', true, null,
   0, null, 2000, 2,
   null, null, null, null),
  ('ground', 'sieve5_gross_g', 'X', 'ABNT 50 sieve + sample (g)',
   'number', 'test_results', 'optional',
   'g', true, null,
   0, null, 2000, 2,
   null, null, null, null),
  ('ground', 'sieve6_tare_g', 'Y', 'ABNT 400 empty sieve (g)',
   'number', 'test_results', 'optional',
   'g', true, null,
   0, null, 2000, 2,
   null, null, null, null),
  ('ground', 'sieve6_gross_g', 'Z', 'ABNT 400 sieve + sample (g)',
   'number', 'test_results', 'optional',
   'g', true, null,
   0, null, 2000, 2,
   null, null, null, null),
  ('ground', 'sieve7_tare_g', 'AA', 'Pan empty (g)',
   'number', 'test_results', 'optional',
   'g', true, null,
   0, null, 2000, 2,
   null, null, null, null),
  ('ground', 'sieve7_gross_g', 'AB', 'Pan + sample (g)',
   'number', 'test_results', 'optional',
   'g', true, null,
   0, null, 2000, 2,
   null, null, null, null),
  ('ground', 'total_retained_g', 'AC', 'Total retained (g)',
   'system', 'test_results', 'system',
   null, null, null,
   null, null, null, null,
   null, null, null, null),
  ('ground', 'fineness_module', 'AD', 'Fineness module (MF)',
   'system', 'test_results', 'system',
   null, null, null,
   null, null, null, null,
   null, null, null, null),
  ('ground', 'dgm_um', 'AE', 'DGM (µm)',
   'system', 'test_results', 'system',
   null, null, null,
   null, null, null, null,
   null, null, null, null),
  ('ground', 'ui_coarse_pct', 'AF', 'UI coarse (%)',
   'system', 'test_results', 'system',
   null, null, null,
   null, null, null, null,
   null, null, null, null),
  ('ground', 'ui_average_pct', 'AG', 'UI average (%)',
   'system', 'test_results', 'system',
   null, null, null,
   null, null, null, null,
   null, null, null, null),
  ('ground', 'ui_fine_pct', 'AH', 'UI fine (%)',
   'system', 'test_results', 'system',
   null, null, null,
   null, null, null, null,
   null, null, null, null),
  ('ground', 'dpg_legacy_index', 'AI', 'DPG legacy index',
   'system', 'test_results', 'system',
   null, null, null,
   null, null, null, null,
   null, null, null, null),
  ('ground', 'gsd', 'AJ', 'Geometric standard deviation',
   'system', 'test_results', 'system',
   null, null, null,
   null, null, null, null,
   null, null, null, null),
  ('ground', 'gsd_basis', 'AK', 'GSD basis',
   'system', 'test_results', 'system',
   null, null, null,
   null, null, null, null,
   null, null, null, null);

update public.stage_definitions set last_column = 'AN', column_count = 40
  where stage = 'ground';

-- crumble: 6 Crumble -> A:AM (39 columns)

-- a. The two analyser-reading columns the sieve test replaces.
delete from public.stage_fields where stage = 'crumble' and field_key = 'avg_particle_size_um';

-- b. Columns that keep their meaning and move right. Rightmost first, so
--    no move ever lands on a letter still occupied (unique (stage, column_letter)).
update public.stage_fields set column_letter = 'AM'
  where stage = 'crumble' and field_key = 'comments';   -- was M
update public.stage_fields set column_letter = 'AL'
  where stage = 'crumble' and field_key = 'tested_by_qo';   -- was L
update public.stage_fields set column_letter = 'N'
  where stage = 'crumble' and field_key = 'crumble_size_mm';   -- was K
update public.stage_fields set column_letter = 'M'
  where stage = 'crumble' and field_key = 'pellet_durability_pdi_pct';   -- was J
update public.stage_fields set column_letter = 'L'
  where stage = 'crumble' and field_key = 'moisture_pct';   -- was H

-- c. The sieve test: four settings, fourteen weights, nine computed results.
insert into public.stage_fields (
  stage, field_key, column_letter, sheet_header,
  field_type, section, requiredness,
  unit, unit_confirmed, parameter_key,
  hard_min, hard_max, implausible_above, decimals,
  adverse_value, applies_when_field, applies_when_values, select_options
) values
  ('crumble', 'durability_tester_rpm', 'H', 'Durability tester RPM',
   'number', 'settings', 'optional',
   null, null, null,
   0, null, 10000, 0,
   null, null, null, null),
  ('crumble', 'sieve_shaker_hz', 'I', 'Sieve shaker frequency (Hz)',
   'number', 'settings', 'optional',
   'Hz', true, null,
   0, null, 200, 0,
   null, null, null, null),
  ('crumble', 'sieve_vibration_min', 'J', 'Vibration time (min)',
   'number', 'settings', 'optional',
   'min', true, null,
   0, null, 240, 0,
   null, null, null, null),
  ('crumble', 'sieve_series', 'K', 'Sieve series',
   'select', 'settings', 'optional',
   null, null, null,
   null, null, null, null,
   null, null, null, array['abnt-standard-7']),
  ('crumble', 'sieve1_tare_g', 'O', 'ABNT 5 empty sieve (g)',
   'number', 'test_results', 'optional',
   'g', true, null,
   0, null, 2000, 2,
   null, null, null, null),
  ('crumble', 'sieve1_gross_g', 'P', 'ABNT 5 sieve + sample (g)',
   'number', 'test_results', 'optional',
   'g', true, null,
   0, null, 2000, 2,
   null, null, null, null),
  ('crumble', 'sieve2_tare_g', 'Q', 'ABNT 10 empty sieve (g)',
   'number', 'test_results', 'optional',
   'g', true, null,
   0, null, 2000, 2,
   null, null, null, null),
  ('crumble', 'sieve2_gross_g', 'R', 'ABNT 10 sieve + sample (g)',
   'number', 'test_results', 'optional',
   'g', true, null,
   0, null, 2000, 2,
   null, null, null, null),
  ('crumble', 'sieve3_tare_g', 'S', 'ABNT 16 empty sieve (g)',
   'number', 'test_results', 'optional',
   'g', true, null,
   0, null, 2000, 2,
   null, null, null, null),
  ('crumble', 'sieve3_gross_g', 'T', 'ABNT 16 sieve + sample (g)',
   'number', 'test_results', 'optional',
   'g', true, null,
   0, null, 2000, 2,
   null, null, null, null),
  ('crumble', 'sieve4_tare_g', 'U', 'ABNT 30 empty sieve (g)',
   'number', 'test_results', 'optional',
   'g', true, null,
   0, null, 2000, 2,
   null, null, null, null),
  ('crumble', 'sieve4_gross_g', 'V', 'ABNT 30 sieve + sample (g)',
   'number', 'test_results', 'optional',
   'g', true, null,
   0, null, 2000, 2,
   null, null, null, null),
  ('crumble', 'sieve5_tare_g', 'W', 'ABNT 50 empty sieve (g)',
   'number', 'test_results', 'optional',
   'g', true, null,
   0, null, 2000, 2,
   null, null, null, null),
  ('crumble', 'sieve5_gross_g', 'X', 'ABNT 50 sieve + sample (g)',
   'number', 'test_results', 'optional',
   'g', true, null,
   0, null, 2000, 2,
   null, null, null, null),
  ('crumble', 'sieve6_tare_g', 'Y', 'ABNT 400 empty sieve (g)',
   'number', 'test_results', 'optional',
   'g', true, null,
   0, null, 2000, 2,
   null, null, null, null),
  ('crumble', 'sieve6_gross_g', 'Z', 'ABNT 400 sieve + sample (g)',
   'number', 'test_results', 'optional',
   'g', true, null,
   0, null, 2000, 2,
   null, null, null, null),
  ('crumble', 'sieve7_tare_g', 'AA', 'Pan empty (g)',
   'number', 'test_results', 'optional',
   'g', true, null,
   0, null, 2000, 2,
   null, null, null, null),
  ('crumble', 'sieve7_gross_g', 'AB', 'Pan + sample (g)',
   'number', 'test_results', 'optional',
   'g', true, null,
   0, null, 2000, 2,
   null, null, null, null),
  ('crumble', 'total_retained_g', 'AC', 'Total retained (g)',
   'system', 'test_results', 'system',
   null, null, null,
   null, null, null, null,
   null, null, null, null),
  ('crumble', 'fineness_module', 'AD', 'Fineness module (MF)',
   'system', 'test_results', 'system',
   null, null, null,
   null, null, null, null,
   null, null, null, null),
  ('crumble', 'dgm_um', 'AE', 'DGM (µm)',
   'system', 'test_results', 'system',
   null, null, null,
   null, null, null, null,
   null, null, null, null),
  ('crumble', 'ui_coarse_pct', 'AF', 'UI coarse (%)',
   'system', 'test_results', 'system',
   null, null, null,
   null, null, null, null,
   null, null, null, null),
  ('crumble', 'ui_average_pct', 'AG', 'UI average (%)',
   'system', 'test_results', 'system',
   null, null, null,
   null, null, null, null,
   null, null, null, null),
  ('crumble', 'ui_fine_pct', 'AH', 'UI fine (%)',
   'system', 'test_results', 'system',
   null, null, null,
   null, null, null, null,
   null, null, null, null),
  ('crumble', 'dpg_legacy_index', 'AI', 'DPG legacy index',
   'system', 'test_results', 'system',
   null, null, null,
   null, null, null, null,
   null, null, null, null),
  ('crumble', 'gsd', 'AJ', 'Geometric standard deviation',
   'system', 'test_results', 'system',
   null, null, null,
   null, null, null, null,
   null, null, null, null),
  ('crumble', 'gsd_basis', 'AK', 'GSD basis',
   'system', 'test_results', 'system',
   null, null, null,
   null, null, null, null,
   null, null, null, null);

update public.stage_definitions set last_column = 'AM', column_count = 39
  where stage = 'crumble';

-- mash: 7 Mash -> A:AJ (36 columns)

-- a. The two analyser-reading columns the sieve test replaces.
delete from public.stage_fields where stage = 'mash' and field_key = 'avg_particle_size_um';
delete from public.stage_fields where stage = 'mash' and field_key = 'size_spread_gsd';

-- b. Columns that keep their meaning and move right. Rightmost first, so
--    no move ever lands on a letter still occupied (unique (stage, column_letter)).
update public.stage_fields set column_letter = 'AJ'
  where stage = 'mash' and field_key = 'comments';   -- was K
update public.stage_fields set column_letter = 'AI'
  where stage = 'mash' and field_key = 'tested_by_qo';   -- was J
update public.stage_fields set column_letter = 'K'
  where stage = 'mash' and field_key = 'moisture_pct';   -- was G

-- c. The sieve test: four settings, fourteen weights, nine computed results.
insert into public.stage_fields (
  stage, field_key, column_letter, sheet_header,
  field_type, section, requiredness,
  unit, unit_confirmed, parameter_key,
  hard_min, hard_max, implausible_above, decimals,
  adverse_value, applies_when_field, applies_when_values, select_options
) values
  ('mash', 'durability_tester_rpm', 'G', 'Durability tester RPM',
   'number', 'settings', 'optional',
   null, null, null,
   0, null, 10000, 0,
   null, null, null, null),
  ('mash', 'sieve_shaker_hz', 'H', 'Sieve shaker frequency (Hz)',
   'number', 'settings', 'optional',
   'Hz', true, null,
   0, null, 200, 0,
   null, null, null, null),
  ('mash', 'sieve_vibration_min', 'I', 'Vibration time (min)',
   'number', 'settings', 'optional',
   'min', true, null,
   0, null, 240, 0,
   null, null, null, null),
  ('mash', 'sieve_series', 'J', 'Sieve series',
   'select', 'settings', 'optional',
   null, null, null,
   null, null, null, null,
   null, null, null, array['abnt-standard-7']),
  ('mash', 'sieve1_tare_g', 'L', 'ABNT 5 empty sieve (g)',
   'number', 'test_results', 'optional',
   'g', true, null,
   0, null, 2000, 2,
   null, null, null, null),
  ('mash', 'sieve1_gross_g', 'M', 'ABNT 5 sieve + sample (g)',
   'number', 'test_results', 'optional',
   'g', true, null,
   0, null, 2000, 2,
   null, null, null, null),
  ('mash', 'sieve2_tare_g', 'N', 'ABNT 10 empty sieve (g)',
   'number', 'test_results', 'optional',
   'g', true, null,
   0, null, 2000, 2,
   null, null, null, null),
  ('mash', 'sieve2_gross_g', 'O', 'ABNT 10 sieve + sample (g)',
   'number', 'test_results', 'optional',
   'g', true, null,
   0, null, 2000, 2,
   null, null, null, null),
  ('mash', 'sieve3_tare_g', 'P', 'ABNT 16 empty sieve (g)',
   'number', 'test_results', 'optional',
   'g', true, null,
   0, null, 2000, 2,
   null, null, null, null),
  ('mash', 'sieve3_gross_g', 'Q', 'ABNT 16 sieve + sample (g)',
   'number', 'test_results', 'optional',
   'g', true, null,
   0, null, 2000, 2,
   null, null, null, null),
  ('mash', 'sieve4_tare_g', 'R', 'ABNT 30 empty sieve (g)',
   'number', 'test_results', 'optional',
   'g', true, null,
   0, null, 2000, 2,
   null, null, null, null),
  ('mash', 'sieve4_gross_g', 'S', 'ABNT 30 sieve + sample (g)',
   'number', 'test_results', 'optional',
   'g', true, null,
   0, null, 2000, 2,
   null, null, null, null),
  ('mash', 'sieve5_tare_g', 'T', 'ABNT 50 empty sieve (g)',
   'number', 'test_results', 'optional',
   'g', true, null,
   0, null, 2000, 2,
   null, null, null, null),
  ('mash', 'sieve5_gross_g', 'U', 'ABNT 50 sieve + sample (g)',
   'number', 'test_results', 'optional',
   'g', true, null,
   0, null, 2000, 2,
   null, null, null, null),
  ('mash', 'sieve6_tare_g', 'V', 'ABNT 400 empty sieve (g)',
   'number', 'test_results', 'optional',
   'g', true, null,
   0, null, 2000, 2,
   null, null, null, null),
  ('mash', 'sieve6_gross_g', 'W', 'ABNT 400 sieve + sample (g)',
   'number', 'test_results', 'optional',
   'g', true, null,
   0, null, 2000, 2,
   null, null, null, null),
  ('mash', 'sieve7_tare_g', 'X', 'Pan empty (g)',
   'number', 'test_results', 'optional',
   'g', true, null,
   0, null, 2000, 2,
   null, null, null, null),
  ('mash', 'sieve7_gross_g', 'Y', 'Pan + sample (g)',
   'number', 'test_results', 'optional',
   'g', true, null,
   0, null, 2000, 2,
   null, null, null, null),
  ('mash', 'total_retained_g', 'Z', 'Total retained (g)',
   'system', 'test_results', 'system',
   null, null, null,
   null, null, null, null,
   null, null, null, null),
  ('mash', 'fineness_module', 'AA', 'Fineness module (MF)',
   'system', 'test_results', 'system',
   null, null, null,
   null, null, null, null,
   null, null, null, null),
  ('mash', 'dgm_um', 'AB', 'DGM (µm)',
   'system', 'test_results', 'system',
   null, null, null,
   null, null, null, null,
   null, null, null, null),
  ('mash', 'ui_coarse_pct', 'AC', 'UI coarse (%)',
   'system', 'test_results', 'system',
   null, null, null,
   null, null, null, null,
   null, null, null, null),
  ('mash', 'ui_average_pct', 'AD', 'UI average (%)',
   'system', 'test_results', 'system',
   null, null, null,
   null, null, null, null,
   null, null, null, null),
  ('mash', 'ui_fine_pct', 'AE', 'UI fine (%)',
   'system', 'test_results', 'system',
   null, null, null,
   null, null, null, null,
   null, null, null, null),
  ('mash', 'dpg_legacy_index', 'AF', 'DPG legacy index',
   'system', 'test_results', 'system',
   null, null, null,
   null, null, null, null,
   null, null, null, null),
  ('mash', 'gsd', 'AG', 'Geometric standard deviation',
   'system', 'test_results', 'system',
   null, null, null,
   null, null, null, null,
   null, null, null, null),
  ('mash', 'gsd_basis', 'AH', 'GSD basis',
   'system', 'test_results', 'system',
   null, null, null,
   null, null, null, null,
   null, null, null, null);

update public.stage_definitions set last_column = 'AJ', column_count = 36
  where stage = 'mash';
