-- ===========================================================================
-- 0033 — the durability test where it belongs, and the drum speed only where
--        there is a drum.
--
-- Four changes to four tabs, all of them asked for by the plant:
--
--   2 Ground  loses `Durability tester RPM`. Ground meal is never tumbled,
--             so the column was a question the tab could not answer, and a
--             blank on a quality record reads as a step that was skipped
--             rather than one that does not exist. A:AN -> A:AM.
--   7 Mash    loses the same column for the same reason. A:AJ -> A:AI.
--   4 Pellets gains the whole sieve test — four settings, fourteen weights,
--             nine computed columns — plus the two durability weighings and
--             the computed PDI. The pellet is the product the plant sells
--             and the one the durability tester was bought for, and the tab
--             held no particle-size measurement at all. A:K -> A:AO.
--   6 Crumble keeps its drum speed and trades its typed-in PDI percentage
--             for the two weighings that produce it, plus the percentage as
--             a computed column. A:AM -> A:AO.
--
-- ---------------------------------------------------------------------------
-- PDI STOPS BEING A FIGURE SOMEBODY TYPES
-- ---------------------------------------------------------------------------
-- `6 Crumble` carried `Pellet durability (PDI, %)` as a `testing` number the
-- operator keyed, which made the record hold a conclusion with no trace of
-- what produced it: 97.6 said nothing about whether 500 g or 480 g went into
-- the drum, and nothing could be recomputed or checked afterwards. The method
-- is a ratio of two weighings,
--
--     PDI (%) = whole pellets after tumbling / sample before tumbling x 100
--
-- so the two weighings are now what the operator records and the percentage
-- is `system`, computed by `src/forms/derived.ts` exactly as the nine sieve
-- columns are. `apply_measurement` raises for any field whose type OR
-- requiredness is `system` (0008:386), so an operator can no longer submit a
-- durability figure at all; it arrives through the projected row.
--
-- NOTHING MEASURED IS LOST, checked against this project before this was
-- written rather than assumed:
--
--     select m.stage, m.field_key, count(*) from sample_measurements m
--      where (m.stage, m.field_key) in (
--              ('ground','durability_tester_rpm'),
--              ('mash','durability_tester_rpm'),
--              ('crumble','pellet_durability_pdi_pct'))
--      group by 1, 2;
--     -> 0 rows
--
-- `sample_measurements` carries a composite foreign key on
-- (stage, field_key), so if that is ever untrue on a project this is applied
-- to, the deletes below FAIL rather than cascading. That is the behaviour we
-- want: it means somebody recorded a value and this migration must not
-- silently discard it.
--
-- `specifications` keeps `crumble.pellet_durability_pdi`. There is no foreign
-- key between the two tables, the row is a draft with no approved version,
-- and the engine only ever reads a specification through a measurement that
-- cites its parameter key — of which there are now none and can be none,
-- because the column is `system`. Deleting somebody's draft limit to tidy up
-- a row that costs nothing would be the worse choice.
--
-- ---------------------------------------------------------------------------
-- WHY THIS ONE DOES NOT SHUFFLE COLUMNS ONE AT A TIME
-- ---------------------------------------------------------------------------
-- 0029 moved columns individually, rightmost first, because
-- `unique (stage, column_letter)` would otherwise be violated the moment a
-- left-shift landed on a letter still occupied. That worked, and it made 0029
-- four hundred lines of hand-ordered `update` statements whose correctness
-- depended entirely on the author's ordering being right.
--
-- It was not necessary. PostgreSQL checks a unique CONSTRAINT at the end of
-- the STATEMENT, not per row — which is why `update t set n = n + 1` works on
-- a unique column at all. So one `insert ... on conflict do update` naming
-- every field of a tab in registry order is checked once, against the
-- arrangement it leaves behind, and the intermediate states it passes through
-- are nobody's business. The ordering this migration does depend on is much
-- weaker and is stated where it matters: the two DELETED columns go first,
-- because no statement ever moves anything out of their letters.
--
-- The constraint is additionally made DEFERRABLE INITIALLY DEFERRED below.
-- That is a permanent schema improvement for future migrations — a column
-- move spanning several statements becomes possible — and this migration is
-- deliberately written NOT to rely on it, because whether it bites depends on
-- the transaction the runner wraps the file in, and a migration whose
-- correctness turns on its runner's autocommit setting is a trap.
--
alter table public.stage_fields
  drop constraint stage_fields_stage_column_letter_key;

alter table public.stage_fields
  add constraint stage_fields_stage_column_letter_key
  unique (stage, column_letter) deferrable initially deferred;

comment on constraint stage_fields_stage_column_letter_key on public.stage_fields is
  'One column letter per tab. Deferrable, so a migration that moves a tab''s columns across several statements is judged on the arrangement it leaves behind rather than on each step of getting there.';


-- ---------------------------------------------------------------------------
-- 1. The alias map first, because it holds foreign keys into the rows below.
--
-- `dgm_log_column_map` points at (stage, field_key) in `stage_fields`, so the
-- two entries naming a drum speed on a tab that is about to lose one have to
-- go before the column does. The three pellets entries are added in step 3,
-- after the columns they reference exist.
-- ---------------------------------------------------------------------------
delete from public.dgm_log_column_map
 where source_stage = 'ground' and dgm_field_key = 'mill_rpm';
delete from public.dgm_log_column_map
 where source_stage = 'mash' and dgm_field_key = 'mill_rpm';

-- And then the two columns themselves, BEFORE anything moves into the
-- letters they occupy. `2 Ground` holds its drum speed at J and `7 Mash` at
-- G; the upsert below slides each tab's settings one column left into
-- exactly those letters. Deleting first is what makes the upsert's end state
-- a valid arrangement — see the note on statement-level uniqueness above.
-- Two statements rather than one with an `or`: the contract test parses
-- these DELETEs to model the seed's end state, and it refuses a WHERE it
-- cannot read rather than skipping it. A migration it cannot parse is a
-- migration it cannot police.
delete from public.stage_fields
 where stage = 'ground' and field_key = 'durability_tester_rpm';
delete from public.stage_fields
 where stage = 'mash' and field_key = 'durability_tester_rpm';


-- ---------------------------------------------------------------------------
-- 2. The columns themselves: every field of the four tabs, in registry order.
--
-- Stated as an upsert over the whole tab rather than as a diff. A diff would
-- be shorter and would be a second, hand-maintained opinion about what the
-- registry says; this way `tests/registryDatabaseContract.test.ts` compares
-- one list against one list. Every column of every row is assigned on
-- conflict, so a field that merely MOVED is corrected rather than left at its
-- old letter.
-- ---------------------------------------------------------------------------
insert into public.stage_fields (
  stage, field_key, column_letter, sheet_header,
  field_type, section, requiredness,
  unit, unit_confirmed, parameter_key,
  hard_min, hard_max, implausible_above, decimals,
  adverse_value, applies_when_field, applies_when_values, select_options
) values
  ('ground', 'sample_id', 'A', 'Sample ID', 'system', 'sample_details', 'system', null, null, null, null, null, null, null, null, null, null, null),
  ('ground', 'collection_date', 'B', 'Date', 'date', 'sample_details', 'registration', null, null, null, null, null, null, null, null, null, null, null),
  ('ground', 'collection_time', 'C', 'Time', 'time', 'sample_details', 'registration', null, null, null, null, null, null, null, null, null, null, null),
  ('ground', 'sampling_point', 'D', 'Sampling point', 'select', 'sample_details', 'registration', null, null, null, null, null, null, null, null, null, null, array['AM', 'BC']::text[]),
  ('ground', 'material_or_feed_type', 'E', 'Material or feed type', 'text', 'sample_details', 'registration', null, null, null, null, null, null, null, null, null, null, null),
  ('ground', 'batch_or_bin_no', 'F', 'Batch or bin no.', 'text', 'sample_details', 'registration', null, null, null, null, null, null, null, null, null, null, null),
  ('ground', 'sampled_by', 'G', 'Sampled by', 'text', 'sample_details', 'registration', null, null, null, null, null, null, null, null, null, null, null),
  ('ground', 'mill_screen_size_mm', 'H', 'Mill screen size (mm)', 'select', 'settings', 'registration', 'mm', true, null, null, null, null, null, null, null, null, array['5', '7']::text[]),
  ('ground', 'hammer_distance_mm', 'I', 'Hammer distance from screen (mm)', 'number', 'settings', 'registration', 'mm', true, 'ground.hammer_distance', 0, null, 500, 1, null, null, null, null),
  ('ground', 'sieve_shaker_hz', 'J', 'Sieve shaker frequency (Hz)', 'number', 'settings', 'optional', 'Hz', true, null, 0, null, 200, 0, null, null, null, null),
  ('ground', 'sieve_vibration_min', 'K', 'Vibration time (min)', 'number', 'settings', 'optional', 'min', true, null, 0, null, 240, 0, null, null, null, null),
  ('ground', 'sieve_series', 'L', 'Sieve series', 'select', 'settings', 'optional', null, null, null, null, null, null, null, null, null, null, array['abnt-standard-7']::text[]),
  ('ground', 'moisture_pct_bc', 'M', 'Moisture (%) at BC', 'number', 'test_results', 'testing', '%', true, 'ground.moisture', 0, 100, null, 2, null, 'sampling_point', array['BC']::text[], null),
  ('ground', 'sieve1_tare_g', 'N', 'ABNT 5 empty sieve (g)', 'number', 'test_results', 'optional', 'g', true, null, 0, null, 2000, 2, null, null, null, null),
  ('ground', 'sieve1_gross_g', 'O', 'ABNT 5 sieve + sample (g)', 'number', 'test_results', 'optional', 'g', true, null, 0, null, 2000, 2, null, null, null, null),
  ('ground', 'sieve2_tare_g', 'P', 'ABNT 10 empty sieve (g)', 'number', 'test_results', 'optional', 'g', true, null, 0, null, 2000, 2, null, null, null, null),
  ('ground', 'sieve2_gross_g', 'Q', 'ABNT 10 sieve + sample (g)', 'number', 'test_results', 'optional', 'g', true, null, 0, null, 2000, 2, null, null, null, null),
  ('ground', 'sieve3_tare_g', 'R', 'ABNT 16 empty sieve (g)', 'number', 'test_results', 'optional', 'g', true, null, 0, null, 2000, 2, null, null, null, null),
  ('ground', 'sieve3_gross_g', 'S', 'ABNT 16 sieve + sample (g)', 'number', 'test_results', 'optional', 'g', true, null, 0, null, 2000, 2, null, null, null, null),
  ('ground', 'sieve4_tare_g', 'T', 'ABNT 30 empty sieve (g)', 'number', 'test_results', 'optional', 'g', true, null, 0, null, 2000, 2, null, null, null, null),
  ('ground', 'sieve4_gross_g', 'U', 'ABNT 30 sieve + sample (g)', 'number', 'test_results', 'optional', 'g', true, null, 0, null, 2000, 2, null, null, null, null),
  ('ground', 'sieve5_tare_g', 'V', 'ABNT 50 empty sieve (g)', 'number', 'test_results', 'optional', 'g', true, null, 0, null, 2000, 2, null, null, null, null),
  ('ground', 'sieve5_gross_g', 'W', 'ABNT 50 sieve + sample (g)', 'number', 'test_results', 'optional', 'g', true, null, 0, null, 2000, 2, null, null, null, null),
  ('ground', 'sieve6_tare_g', 'X', 'ABNT 400 empty sieve (g)', 'number', 'test_results', 'optional', 'g', true, null, 0, null, 2000, 2, null, null, null, null),
  ('ground', 'sieve6_gross_g', 'Y', 'ABNT 400 sieve + sample (g)', 'number', 'test_results', 'optional', 'g', true, null, 0, null, 2000, 2, null, null, null, null),
  ('ground', 'sieve7_tare_g', 'Z', 'Pan empty (g)', 'number', 'test_results', 'optional', 'g', true, null, 0, null, 2000, 2, null, null, null, null),
  ('ground', 'sieve7_gross_g', 'AA', 'Pan + sample (g)', 'number', 'test_results', 'optional', 'g', true, null, 0, null, 2000, 2, null, null, null, null),
  ('ground', 'total_retained_g', 'AB', 'Total retained (g)', 'system', 'test_results', 'system', null, null, null, null, null, null, null, null, null, null, null),
  ('ground', 'fineness_module', 'AC', 'Fineness module (MF)', 'system', 'test_results', 'system', null, null, null, null, null, null, null, null, null, null, null),
  ('ground', 'dgm_um', 'AD', 'DGM (µm)', 'system', 'test_results', 'system', null, null, null, null, null, null, null, null, null, null, null),
  ('ground', 'ui_coarse_pct', 'AE', 'UI coarse (%)', 'system', 'test_results', 'system', null, null, null, null, null, null, null, null, null, null, null),
  ('ground', 'ui_average_pct', 'AF', 'UI average (%)', 'system', 'test_results', 'system', null, null, null, null, null, null, null, null, null, null, null),
  ('ground', 'ui_fine_pct', 'AG', 'UI fine (%)', 'system', 'test_results', 'system', null, null, null, null, null, null, null, null, null, null, null),
  ('ground', 'dpg_legacy_index', 'AH', 'DPG legacy index', 'system', 'test_results', 'system', null, null, null, null, null, null, null, null, null, null, null),
  ('ground', 'gsd', 'AI', 'Geometric standard deviation', 'system', 'test_results', 'system', null, null, null, null, null, null, null, null, null, null, null),
  ('ground', 'gsd_basis', 'AJ', 'GSD basis', 'system', 'test_results', 'system', null, null, null, null, null, null, null, null, null, null, null),
  ('ground', 'action_taken', 'AK', 'Action taken', 'textarea', 'follow_up', 'optional', null, null, null, null, null, null, null, null, null, null, null),
  ('ground', 'tested_by_qo', 'AL', 'Tested by (QO)', 'text', 'follow_up', 'testing', null, null, null, null, null, null, null, null, null, null, null),
  ('ground', 'comments', 'AM', 'Comments', 'textarea', 'follow_up', 'optional', null, null, null, null, null, null, null, null, null, null, null),
  ('pellets', 'sample_id', 'A', 'Sample ID', 'system', 'sample_details', 'system', null, null, null, null, null, null, null, null, null, null, null),
  ('pellets', 'collection_date', 'B', 'Date', 'date', 'sample_details', 'registration', null, null, null, null, null, null, null, null, null, null, null),
  ('pellets', 'collection_time', 'C', 'Time', 'time', 'sample_details', 'registration', null, null, null, null, null, null, null, null, null, null, null),
  ('pellets', 'feed_type', 'D', 'Feed type', 'text', 'sample_details', 'registration', null, null, null, null, null, null, null, null, null, null, null),
  ('pellets', 'batch_no', 'E', 'Batch no.', 'text', 'sample_details', 'registration', null, null, null, null, null, null, null, null, null, null, null),
  ('pellets', 'sampled_by', 'F', 'Sampled by', 'text', 'sample_details', 'registration', null, null, null, null, null, null, null, null, null, null, null),
  ('pellets', 'durability_tester_rpm', 'G', 'Durability tester RPM', 'number', 'settings', 'optional', null, null, null, 0, null, 10000, 0, null, null, null, null),
  ('pellets', 'sieve_shaker_hz', 'H', 'Sieve shaker frequency (Hz)', 'number', 'settings', 'optional', 'Hz', true, null, 0, null, 200, 0, null, null, null, null),
  ('pellets', 'sieve_vibration_min', 'I', 'Vibration time (min)', 'number', 'settings', 'optional', 'min', true, null, 0, null, 240, 0, null, null, null, null),
  ('pellets', 'sieve_series', 'J', 'Sieve series', 'select', 'settings', 'optional', null, null, null, null, null, null, null, null, null, null, array['abnt-standard-7']::text[]),
  ('pellets', 'pellet_temperature_c', 'K', 'Pellet temperature (°C)', 'number', 'test_results', 'testing', '°C', true, 'pellets.temperature', 0, null, 300, 1, null, null, null, null),
  ('pellets', 'pellet_diameter_mm', 'L', 'Pellet diameter (mm)', 'number', 'test_results', 'testing', 'mm', true, 'pellets.pellet_diameter', 0, null, 100, 2, null, null, null, null),
  ('pellets', 'pdi_before_g', 'M', 'Sample before tumbling (g)', 'number', 'test_results', 'optional', 'g', true, null, 0, null, 5000, 2, null, null, null, null),
  ('pellets', 'pdi_after_g', 'N', 'Whole pellets after tumbling (g)', 'number', 'test_results', 'optional', 'g', true, null, 0, null, 5000, 2, null, null, null, null),
  ('pellets', 'pellet_durability_pdi_pct', 'O', 'Pellet durability (PDI, %)', 'system', 'test_results', 'system', null, null, null, null, null, null, null, null, null, null, null),
  ('pellets', 'sieve1_tare_g', 'P', 'ABNT 5 empty sieve (g)', 'number', 'test_results', 'optional', 'g', true, null, 0, null, 2000, 2, null, null, null, null),
  ('pellets', 'sieve1_gross_g', 'Q', 'ABNT 5 sieve + sample (g)', 'number', 'test_results', 'optional', 'g', true, null, 0, null, 2000, 2, null, null, null, null),
  ('pellets', 'sieve2_tare_g', 'R', 'ABNT 10 empty sieve (g)', 'number', 'test_results', 'optional', 'g', true, null, 0, null, 2000, 2, null, null, null, null),
  ('pellets', 'sieve2_gross_g', 'S', 'ABNT 10 sieve + sample (g)', 'number', 'test_results', 'optional', 'g', true, null, 0, null, 2000, 2, null, null, null, null),
  ('pellets', 'sieve3_tare_g', 'T', 'ABNT 16 empty sieve (g)', 'number', 'test_results', 'optional', 'g', true, null, 0, null, 2000, 2, null, null, null, null),
  ('pellets', 'sieve3_gross_g', 'U', 'ABNT 16 sieve + sample (g)', 'number', 'test_results', 'optional', 'g', true, null, 0, null, 2000, 2, null, null, null, null),
  ('pellets', 'sieve4_tare_g', 'V', 'ABNT 30 empty sieve (g)', 'number', 'test_results', 'optional', 'g', true, null, 0, null, 2000, 2, null, null, null, null),
  ('pellets', 'sieve4_gross_g', 'W', 'ABNT 30 sieve + sample (g)', 'number', 'test_results', 'optional', 'g', true, null, 0, null, 2000, 2, null, null, null, null),
  ('pellets', 'sieve5_tare_g', 'X', 'ABNT 50 empty sieve (g)', 'number', 'test_results', 'optional', 'g', true, null, 0, null, 2000, 2, null, null, null, null),
  ('pellets', 'sieve5_gross_g', 'Y', 'ABNT 50 sieve + sample (g)', 'number', 'test_results', 'optional', 'g', true, null, 0, null, 2000, 2, null, null, null, null),
  ('pellets', 'sieve6_tare_g', 'Z', 'ABNT 400 empty sieve (g)', 'number', 'test_results', 'optional', 'g', true, null, 0, null, 2000, 2, null, null, null, null),
  ('pellets', 'sieve6_gross_g', 'AA', 'ABNT 400 sieve + sample (g)', 'number', 'test_results', 'optional', 'g', true, null, 0, null, 2000, 2, null, null, null, null),
  ('pellets', 'sieve7_tare_g', 'AB', 'Pan empty (g)', 'number', 'test_results', 'optional', 'g', true, null, 0, null, 2000, 2, null, null, null, null),
  ('pellets', 'sieve7_gross_g', 'AC', 'Pan + sample (g)', 'number', 'test_results', 'optional', 'g', true, null, 0, null, 2000, 2, null, null, null, null),
  ('pellets', 'total_retained_g', 'AD', 'Total retained (g)', 'system', 'test_results', 'system', null, null, null, null, null, null, null, null, null, null, null),
  ('pellets', 'fineness_module', 'AE', 'Fineness module (MF)', 'system', 'test_results', 'system', null, null, null, null, null, null, null, null, null, null, null),
  ('pellets', 'dgm_um', 'AF', 'DGM (µm)', 'system', 'test_results', 'system', null, null, null, null, null, null, null, null, null, null, null),
  ('pellets', 'ui_coarse_pct', 'AG', 'UI coarse (%)', 'system', 'test_results', 'system', null, null, null, null, null, null, null, null, null, null, null),
  ('pellets', 'ui_average_pct', 'AH', 'UI average (%)', 'system', 'test_results', 'system', null, null, null, null, null, null, null, null, null, null, null),
  ('pellets', 'ui_fine_pct', 'AI', 'UI fine (%)', 'system', 'test_results', 'system', null, null, null, null, null, null, null, null, null, null, null),
  ('pellets', 'dpg_legacy_index', 'AJ', 'DPG legacy index', 'system', 'test_results', 'system', null, null, null, null, null, null, null, null, null, null, null),
  ('pellets', 'gsd', 'AK', 'Geometric standard deviation', 'system', 'test_results', 'system', null, null, null, null, null, null, null, null, null, null, null),
  ('pellets', 'gsd_basis', 'AL', 'GSD basis', 'system', 'test_results', 'system', null, null, null, null, null, null, null, null, null, null, null),
  ('pellets', 'action_taken', 'AM', 'Action taken', 'textarea', 'follow_up', 'optional', null, null, null, null, null, null, null, null, null, null, null),
  ('pellets', 'tested_by_qo', 'AN', 'Tested by (QO)', 'text', 'follow_up', 'testing', null, null, null, null, null, null, null, null, null, null, null),
  ('pellets', 'comments', 'AO', 'Comments', 'textarea', 'follow_up', 'optional', null, null, null, null, null, null, null, null, null, null, null),
  ('crumble', 'sample_id', 'A', 'Sample ID', 'system', 'sample_details', 'system', null, null, null, null, null, null, null, null, null, null, null),
  ('crumble', 'collection_date', 'B', 'Date', 'date', 'sample_details', 'registration', null, null, null, null, null, null, null, null, null, null, null),
  ('crumble', 'collection_time', 'C', 'Time', 'time', 'sample_details', 'registration', null, null, null, null, null, null, null, null, null, null, null),
  ('crumble', 'feed_type', 'D', 'Feed type', 'text', 'sample_details', 'registration', null, null, null, null, null, null, null, null, null, null, null),
  ('crumble', 'batch_no', 'E', 'Batch no.', 'text', 'sample_details', 'registration', null, null, null, null, null, null, null, null, null, null, null),
  ('crumble', 'sampled_by', 'F', 'Sampled by', 'text', 'sample_details', 'registration', null, null, null, null, null, null, null, null, null, null, null),
  ('crumble', 'crumbler_roll_gap_mm', 'G', 'Crumbler roll gap (mm)', 'number', 'settings', 'registration', 'mm', true, 'crumble.roll_gap', 0, null, 100, 2, null, null, null, null),
  ('crumble', 'durability_tester_rpm', 'H', 'Durability tester RPM', 'number', 'settings', 'optional', null, null, null, 0, null, 10000, 0, null, null, null, null),
  ('crumble', 'sieve_shaker_hz', 'I', 'Sieve shaker frequency (Hz)', 'number', 'settings', 'optional', 'Hz', true, null, 0, null, 200, 0, null, null, null, null),
  ('crumble', 'sieve_vibration_min', 'J', 'Vibration time (min)', 'number', 'settings', 'optional', 'min', true, null, 0, null, 240, 0, null, null, null, null),
  ('crumble', 'sieve_series', 'K', 'Sieve series', 'select', 'settings', 'optional', null, null, null, null, null, null, null, null, null, null, array['abnt-standard-7']::text[]),
  ('crumble', 'moisture_pct', 'L', 'Moisture (%)', 'number', 'test_results', 'testing', '%', true, 'crumble.moisture', 0, 100, null, 2, null, null, null, null),
  ('crumble', 'pdi_before_g', 'M', 'Sample before tumbling (g)', 'number', 'test_results', 'optional', 'g', true, null, 0, null, 5000, 2, null, null, null, null),
  ('crumble', 'pdi_after_g', 'N', 'Whole pellets after tumbling (g)', 'number', 'test_results', 'optional', 'g', true, null, 0, null, 5000, 2, null, null, null, null),
  ('crumble', 'pellet_durability_pdi_pct', 'O', 'Pellet durability (PDI, %)', 'system', 'test_results', 'system', null, null, null, null, null, null, null, null, null, null, null),
  ('crumble', 'crumble_size_mm', 'P', 'Crumble size (mm)', 'number', 'test_results', 'testing', 'mm', true, 'crumble.crumble_size', 0, null, 100, 2, null, null, null, null),
  ('crumble', 'sieve1_tare_g', 'Q', 'ABNT 5 empty sieve (g)', 'number', 'test_results', 'optional', 'g', true, null, 0, null, 2000, 2, null, null, null, null),
  ('crumble', 'sieve1_gross_g', 'R', 'ABNT 5 sieve + sample (g)', 'number', 'test_results', 'optional', 'g', true, null, 0, null, 2000, 2, null, null, null, null),
  ('crumble', 'sieve2_tare_g', 'S', 'ABNT 10 empty sieve (g)', 'number', 'test_results', 'optional', 'g', true, null, 0, null, 2000, 2, null, null, null, null),
  ('crumble', 'sieve2_gross_g', 'T', 'ABNT 10 sieve + sample (g)', 'number', 'test_results', 'optional', 'g', true, null, 0, null, 2000, 2, null, null, null, null),
  ('crumble', 'sieve3_tare_g', 'U', 'ABNT 16 empty sieve (g)', 'number', 'test_results', 'optional', 'g', true, null, 0, null, 2000, 2, null, null, null, null),
  ('crumble', 'sieve3_gross_g', 'V', 'ABNT 16 sieve + sample (g)', 'number', 'test_results', 'optional', 'g', true, null, 0, null, 2000, 2, null, null, null, null),
  ('crumble', 'sieve4_tare_g', 'W', 'ABNT 30 empty sieve (g)', 'number', 'test_results', 'optional', 'g', true, null, 0, null, 2000, 2, null, null, null, null),
  ('crumble', 'sieve4_gross_g', 'X', 'ABNT 30 sieve + sample (g)', 'number', 'test_results', 'optional', 'g', true, null, 0, null, 2000, 2, null, null, null, null),
  ('crumble', 'sieve5_tare_g', 'Y', 'ABNT 50 empty sieve (g)', 'number', 'test_results', 'optional', 'g', true, null, 0, null, 2000, 2, null, null, null, null),
  ('crumble', 'sieve5_gross_g', 'Z', 'ABNT 50 sieve + sample (g)', 'number', 'test_results', 'optional', 'g', true, null, 0, null, 2000, 2, null, null, null, null),
  ('crumble', 'sieve6_tare_g', 'AA', 'ABNT 400 empty sieve (g)', 'number', 'test_results', 'optional', 'g', true, null, 0, null, 2000, 2, null, null, null, null),
  ('crumble', 'sieve6_gross_g', 'AB', 'ABNT 400 sieve + sample (g)', 'number', 'test_results', 'optional', 'g', true, null, 0, null, 2000, 2, null, null, null, null),
  ('crumble', 'sieve7_tare_g', 'AC', 'Pan empty (g)', 'number', 'test_results', 'optional', 'g', true, null, 0, null, 2000, 2, null, null, null, null),
  ('crumble', 'sieve7_gross_g', 'AD', 'Pan + sample (g)', 'number', 'test_results', 'optional', 'g', true, null, 0, null, 2000, 2, null, null, null, null),
  ('crumble', 'total_retained_g', 'AE', 'Total retained (g)', 'system', 'test_results', 'system', null, null, null, null, null, null, null, null, null, null, null),
  ('crumble', 'fineness_module', 'AF', 'Fineness module (MF)', 'system', 'test_results', 'system', null, null, null, null, null, null, null, null, null, null, null),
  ('crumble', 'dgm_um', 'AG', 'DGM (µm)', 'system', 'test_results', 'system', null, null, null, null, null, null, null, null, null, null, null),
  ('crumble', 'ui_coarse_pct', 'AH', 'UI coarse (%)', 'system', 'test_results', 'system', null, null, null, null, null, null, null, null, null, null, null),
  ('crumble', 'ui_average_pct', 'AI', 'UI average (%)', 'system', 'test_results', 'system', null, null, null, null, null, null, null, null, null, null, null),
  ('crumble', 'ui_fine_pct', 'AJ', 'UI fine (%)', 'system', 'test_results', 'system', null, null, null, null, null, null, null, null, null, null, null),
  ('crumble', 'dpg_legacy_index', 'AK', 'DPG legacy index', 'system', 'test_results', 'system', null, null, null, null, null, null, null, null, null, null, null),
  ('crumble', 'gsd', 'AL', 'Geometric standard deviation', 'system', 'test_results', 'system', null, null, null, null, null, null, null, null, null, null, null),
  ('crumble', 'gsd_basis', 'AM', 'GSD basis', 'system', 'test_results', 'system', null, null, null, null, null, null, null, null, null, null, null),
  ('crumble', 'tested_by_qo', 'AN', 'Tested by (QO)', 'text', 'follow_up', 'testing', null, null, null, null, null, null, null, null, null, null, null),
  ('crumble', 'comments', 'AO', 'Comments', 'textarea', 'follow_up', 'optional', null, null, null, null, null, null, null, null, null, null, null),
  ('mash', 'sample_id', 'A', 'Sample ID', 'system', 'sample_details', 'system', null, null, null, null, null, null, null, null, null, null, null),
  ('mash', 'collection_date', 'B', 'Date', 'date', 'sample_details', 'registration', null, null, null, null, null, null, null, null, null, null, null),
  ('mash', 'collection_time', 'C', 'Time', 'time', 'sample_details', 'registration', null, null, null, null, null, null, null, null, null, null, null),
  ('mash', 'feed_type', 'D', 'Feed type', 'text', 'sample_details', 'registration', null, null, null, null, null, null, null, null, null, null, null),
  ('mash', 'batch_no', 'E', 'Batch no.', 'text', 'sample_details', 'registration', null, null, null, null, null, null, null, null, null, null, null),
  ('mash', 'sampled_by', 'F', 'Sampled by', 'text', 'sample_details', 'registration', null, null, null, null, null, null, null, null, null, null, null),
  ('mash', 'sieve_shaker_hz', 'G', 'Sieve shaker frequency (Hz)', 'number', 'settings', 'optional', 'Hz', true, null, 0, null, 200, 0, null, null, null, null),
  ('mash', 'sieve_vibration_min', 'H', 'Vibration time (min)', 'number', 'settings', 'optional', 'min', true, null, 0, null, 240, 0, null, null, null, null),
  ('mash', 'sieve_series', 'I', 'Sieve series', 'select', 'settings', 'optional', null, null, null, null, null, null, null, null, null, null, array['abnt-standard-7']::text[]),
  ('mash', 'moisture_pct', 'J', 'Moisture (%)', 'number', 'test_results', 'testing', '%', true, 'mash.moisture', 0, 100, null, 2, null, null, null, null),
  ('mash', 'sieve1_tare_g', 'K', 'ABNT 5 empty sieve (g)', 'number', 'test_results', 'optional', 'g', true, null, 0, null, 2000, 2, null, null, null, null),
  ('mash', 'sieve1_gross_g', 'L', 'ABNT 5 sieve + sample (g)', 'number', 'test_results', 'optional', 'g', true, null, 0, null, 2000, 2, null, null, null, null),
  ('mash', 'sieve2_tare_g', 'M', 'ABNT 10 empty sieve (g)', 'number', 'test_results', 'optional', 'g', true, null, 0, null, 2000, 2, null, null, null, null),
  ('mash', 'sieve2_gross_g', 'N', 'ABNT 10 sieve + sample (g)', 'number', 'test_results', 'optional', 'g', true, null, 0, null, 2000, 2, null, null, null, null),
  ('mash', 'sieve3_tare_g', 'O', 'ABNT 16 empty sieve (g)', 'number', 'test_results', 'optional', 'g', true, null, 0, null, 2000, 2, null, null, null, null),
  ('mash', 'sieve3_gross_g', 'P', 'ABNT 16 sieve + sample (g)', 'number', 'test_results', 'optional', 'g', true, null, 0, null, 2000, 2, null, null, null, null),
  ('mash', 'sieve4_tare_g', 'Q', 'ABNT 30 empty sieve (g)', 'number', 'test_results', 'optional', 'g', true, null, 0, null, 2000, 2, null, null, null, null),
  ('mash', 'sieve4_gross_g', 'R', 'ABNT 30 sieve + sample (g)', 'number', 'test_results', 'optional', 'g', true, null, 0, null, 2000, 2, null, null, null, null),
  ('mash', 'sieve5_tare_g', 'S', 'ABNT 50 empty sieve (g)', 'number', 'test_results', 'optional', 'g', true, null, 0, null, 2000, 2, null, null, null, null),
  ('mash', 'sieve5_gross_g', 'T', 'ABNT 50 sieve + sample (g)', 'number', 'test_results', 'optional', 'g', true, null, 0, null, 2000, 2, null, null, null, null),
  ('mash', 'sieve6_tare_g', 'U', 'ABNT 400 empty sieve (g)', 'number', 'test_results', 'optional', 'g', true, null, 0, null, 2000, 2, null, null, null, null),
  ('mash', 'sieve6_gross_g', 'V', 'ABNT 400 sieve + sample (g)', 'number', 'test_results', 'optional', 'g', true, null, 0, null, 2000, 2, null, null, null, null),
  ('mash', 'sieve7_tare_g', 'W', 'Pan empty (g)', 'number', 'test_results', 'optional', 'g', true, null, 0, null, 2000, 2, null, null, null, null),
  ('mash', 'sieve7_gross_g', 'X', 'Pan + sample (g)', 'number', 'test_results', 'optional', 'g', true, null, 0, null, 2000, 2, null, null, null, null),
  ('mash', 'total_retained_g', 'Y', 'Total retained (g)', 'system', 'test_results', 'system', null, null, null, null, null, null, null, null, null, null, null),
  ('mash', 'fineness_module', 'Z', 'Fineness module (MF)', 'system', 'test_results', 'system', null, null, null, null, null, null, null, null, null, null, null),
  ('mash', 'dgm_um', 'AA', 'DGM (µm)', 'system', 'test_results', 'system', null, null, null, null, null, null, null, null, null, null, null),
  ('mash', 'ui_coarse_pct', 'AB', 'UI coarse (%)', 'system', 'test_results', 'system', null, null, null, null, null, null, null, null, null, null, null),
  ('mash', 'ui_average_pct', 'AC', 'UI average (%)', 'system', 'test_results', 'system', null, null, null, null, null, null, null, null, null, null, null),
  ('mash', 'ui_fine_pct', 'AD', 'UI fine (%)', 'system', 'test_results', 'system', null, null, null, null, null, null, null, null, null, null, null),
  ('mash', 'dpg_legacy_index', 'AE', 'DPG legacy index', 'system', 'test_results', 'system', null, null, null, null, null, null, null, null, null, null, null),
  ('mash', 'gsd', 'AF', 'Geometric standard deviation', 'system', 'test_results', 'system', null, null, null, null, null, null, null, null, null, null, null),
  ('mash', 'gsd_basis', 'AG', 'GSD basis', 'system', 'test_results', 'system', null, null, null, null, null, null, null, null, null, null, null),
  ('mash', 'tested_by_qo', 'AH', 'Tested by (QO)', 'text', 'follow_up', 'testing', null, null, null, null, null, null, null, null, null, null, null),
  ('mash', 'comments', 'AI', 'Comments', 'textarea', 'follow_up', 'optional', null, null, null, null, null, null, null, null, null, null, null)
on conflict (stage, field_key) do update set
  column_letter       = excluded.column_letter,
  sheet_header        = excluded.sheet_header,
  field_type          = excluded.field_type,
  section             = excluded.section,
  requiredness        = excluded.requiredness,
  unit                = excluded.unit,
  unit_confirmed      = excluded.unit_confirmed,
  parameter_key       = excluded.parameter_key,
  hard_min            = excluded.hard_min,
  hard_max            = excluded.hard_max,
  implausible_above   = excluded.implausible_above,
  decimals            = excluded.decimals,
  adverse_value       = excluded.adverse_value,
  applies_when_field  = excluded.applies_when_field,
  applies_when_values = excluded.applies_when_values,
  select_options      = excluded.select_options;



-- ---------------------------------------------------------------------------
-- 3. `4 Pellets` joins the master log.
--
-- `tg_enqueue_dgm_master_log` is already generic: it mirrors any tab that has
-- a `dgm_um` column and produced a value, so Pellets starts being logged the
-- moment its columns exist. Only the aliases are per-tab — the three settings
-- `8 DGM` still names after milling. `feed_type` and `batch_no` need no entry
-- because Pellets spells them exactly as DGM does, and the trigger falls back
-- to the field key when the map has nothing to say.
-- ---------------------------------------------------------------------------
insert into public.dgm_log_column_map (source_stage, dgm_field_key, source_field_key) values
  ('pellets', 'mill_rpm',         'durability_tester_rpm'),
  ('pellets', 'mill_hz_position', 'sieve_shaker_hz'),
  ('pellets', 'grind_time',       'sieve_vibration_min')
on conflict (source_stage, dgm_field_key) do update
  set source_field_key = excluded.source_field_key;


-- ---------------------------------------------------------------------------
-- 4. The declared widths.
-- ---------------------------------------------------------------------------
update public.stage_definitions set last_column = 'AM', column_count = 39 where stage = 'ground';
update public.stage_definitions set last_column = 'AO', column_count = 41 where stage = 'pellets';
update public.stage_definitions set last_column = 'AO', column_count = 41 where stage = 'crumble';
update public.stage_definitions set last_column = 'AI', column_count = 35 where stage = 'mash';

-- The two stage instructions that changed are NOT updated here: they live in
-- `src/forms/registry.ts` only. `stage_definitions` has no `instruction`
-- column — the sentence above a form has never been a database fact, and
-- adding one now would create a second place for it to be wrong.


-- ---------------------------------------------------------------------------
-- 5. Prove it, in the same transaction that did it.
--
-- Three independent statements of the same expectation, because a single
-- count would pass over a tab that gained a column and lost one. If any of
-- them is false the whole migration rolls back.
-- ---------------------------------------------------------------------------
do $$
declare
  v_bad text;
begin
  -- a. Declared width equals the number of columns actually present.
  select string_agg(format('%s declares %s but has %s', d.stage, d.column_count, c.n), '; ')
    into v_bad
  from public.stage_definitions d
  join (select stage, count(*) n from public.stage_fields group by stage) c
    on c.stage = d.stage
  where c.n <> d.column_count;
  if v_bad is not null then
    raise exception 'BFF_0033_WIDTH: %', v_bad using errcode = '22023';
  end if;

  -- b. Every tab's letters are exactly A .. last_column with no gap and no
  --    repeat. This is what the deferred unique constraint does NOT say: it
  --    forbids a repeat, it does not require contiguity, and a left-shift
  --    that skipped a letter would satisfy it while leaving a blank column
  --    in the middle of a quality record.
  select string_agg(format('%s is not contiguous A..%s', d.stage, d.last_column), '; ')
    into v_bad
  from public.stage_definitions d
  where exists (
    select 1
    from public.stage_fields f
    where f.stage = d.stage
    group by f.stage
    having count(distinct public.column_letter_to_index(f.column_letter)) <> d.column_count
        or min(public.column_letter_to_index(f.column_letter)) <> 1
        or max(public.column_letter_to_index(f.column_letter)) <> d.column_count
  );
  if v_bad is not null then
    raise exception 'BFF_0033_CONTIGUOUS: %', v_bad using errcode = '22023';
  end if;

  -- c. Every computed column really is `system` on both axes. A PDI an
  --    operator could submit would be silently overwritten by the server's
  --    own figure, which is the failure mode this whole change exists to
  --    remove.
  select string_agg(format('%s.%s is %s/%s', stage, field_key, field_type, requiredness), '; ')
    into v_bad
  from public.stage_fields
  where field_key in (
          'pellet_durability_pdi_pct', 'total_retained_g', 'fineness_module', 'dgm_um',
          'ui_coarse_pct', 'ui_average_pct', 'ui_fine_pct', 'dpg_legacy_index',
          'gsd', 'gsd_basis')
    and (field_type <> 'system' or requiredness <> 'system');
  if v_bad is not null then
    raise exception 'BFF_0033_NOT_SYSTEM: %', v_bad using errcode = '22023';
  end if;
end $$;

comment on table public.stage_fields is
  'The 239 operational columns, mirroring src/forms/registry.ts. Makes sample_measurements.field_key a controlled vocabulary rather than free text.';
