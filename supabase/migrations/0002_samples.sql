-- ===========================================================================
-- 0002_samples.sql
--
-- The sample ledger: controlled vocabularies, the 98-column field registry as
-- a database constraint, the samples table, typed measurements, traceability
-- links, and the atomic sample-identifier allocator.
--
-- The Google Sheet is the operational spreadsheet record. THIS is the
-- transactional ledger: every acknowledged save is readable back from here by
-- UUID whether or not the spreadsheet has been written yet (NFR-001).
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- Enum types, mirroring the TypeScript contract exactly.
--
--   public.sample_stage      <- STAGES          in src/forms/types.ts
--   public.form_section      <- SECTIONS        in src/forms/types.ts
--   public.field_type        <- FieldType       in src/forms/types.ts
--   public.requiredness      <- Requiredness    in src/forms/types.ts
--   public.capture_state     <- CAPTURE_STATES  in src/lib/workflow.ts
--   public.disposition_state <- DISPOSITIONS    in src/lib/workflow.ts
--
-- A value that exists on one side and not the other is a defect, so these are
-- asserted against the registry by the dry-run harness and by CI rather than
-- being trusted to stay aligned.
-- ---------------------------------------------------------------------------

create type public.sample_stage as enum (
  'raw_materials',
  'ground',
  'conditioned',
  'pellets',
  'extruded_soya',
  'crumble',
  'mash'
);

create type public.form_section as enum (
  'sample_details',
  'settings',
  'test_results',
  'follow_up'
);

create type public.field_type as enum (
  'system',
  'text',
  'textarea',
  'number',
  'date',
  'time',
  'select',
  'yesno'
);

create type public.requiredness as enum (
  'system',
  'registration',
  'testing',
  'review',
  'optional'
);

create type public.capture_state as enum (
  'draft',
  'registered',
  'awaiting_results',
  'ready_for_review',
  'reviewed',
  'correction_required',
  'voided'
);

create type public.disposition_state as enum (
  'undetermined',
  'on_hold',
  'accepted',
  'rejected',
  'rework_required',
  'released_by_authorized_override'
);

create type public.sheet_sync_state as enum (
  'pending',
  'leased',
  'confirmed',
  'failed',
  'dead_letter'
);


-- ---------------------------------------------------------------------------
-- Controlled vocabularies.
--
-- "Reject unknown enum values server-side" (PRD section 6.1). These are
-- foreign-key targets, so an unrecognised material is rejected by the database
-- and not merely absent from a dropdown.
--
-- Rows live in supabase/seed/0001_controlled_vocabulary.sql, except
-- sample_prefixes and stage_fields, which are structural: they mirror
-- src/forms/registry.ts and every insert into the ledger depends on them, so
-- they ship with the schema rather than with the seed.
-- ---------------------------------------------------------------------------

create table public.materials (
  code       text primary key,
  label      text not null,
  sort_order integer not null default 100,
  active     boolean not null default true,
  constraint materials_code_lower check (code = lower(btrim(code))),
  constraint materials_label_present check (length(btrim(label)) > 0)
);

create table public.feed_types (
  code       text primary key,
  label      text not null,
  sort_order integer not null default 100,
  active     boolean not null default true,
  constraint feed_types_code_lower check (code = lower(btrim(code))),
  constraint feed_types_label_present check (length(btrim(label)) > 0)
);

-- Suppliers are operational data, not a fixed list. The seed ships it EMPTY on
-- purpose: inventing a supplier name would put a fabricated party on a quality
-- record. An administrator adds the real ones through the admin screen.
create table public.suppliers (
  code       text primary key,
  label      text not null,
  sort_order integer not null default 100,
  active     boolean not null default true,
  constraint suppliers_code_lower check (code = lower(btrim(code))),
  constraint suppliers_label_present check (length(btrim(label)) > 0)
);

-- The structured AM/BC point codes. The CODE drives the sample-ID prefix and
-- the BC-moisture applicability rule; the LABEL is what the spreadsheet cell
-- receives. PRD section 5.2 forbids deriving the prefix by substring-matching
-- display text, which is why the code is a first-class value here.
create table public.sampling_points (
  code       text primary key,
  label      text not null,
  sort_order integer not null default 100,
  active     boolean not null default true,
  constraint sampling_points_label_present check (length(btrim(label)) > 0)
);

-- 'Mill screen size (5 or 7 mm)', per the workbook `Read me` tab. Stored as
-- text because it is a categorical setting, not a measurement: an operator
-- cannot introduce a third value, and a value of 6 is not "between" the two.
create table public.mill_screen_sizes (
  code       text primary key,
  label      text not null,
  sort_order integer not null default 100,
  active     boolean not null default true,
  constraint mill_screen_sizes_label_present check (length(btrim(label)) > 0)
);


-- ---------------------------------------------------------------------------
-- sample_prefixes  the eight identifier prefixes and what they mean.
--
-- Verbatim from the workbook `Read me` tab: "RM raw material, AM after the
-- mill, BC before conditioning, AC after conditioning, AP after pelleting,
-- ES extruded soya, CR crumble, MS mash."
--
-- This table is also the server-side implementation of resolvePrefix(): the
-- prefix of a sample is LOOKED UP from (stage, stage_detail) by a trigger and
-- whatever the client sent is discarded. Ground is the only stage with two
-- prefixes, and it is the only one whose stage_detail is non-null.
-- ---------------------------------------------------------------------------

create table public.sample_prefixes (
  prefix         text primary key,
  stage          public.sample_stage not null,
  sampling_point text references public.sampling_points (code),
  label          text not null,
  constraint sample_prefixes_shape check (prefix ~ '^[A-Z]{2}$'),
  -- Exactly one prefix per (stage, sampling_point) pair. A null sampling_point
  -- is not distinct here, so the uniqueness really does hold for the six
  -- single-prefix stages too.
  constraint sample_prefixes_unique_per_point
    unique nulls not distinct (stage, sampling_point)
);

-- The two sampling-point codes, inserted HERE and not in the seed.
--
-- sample_prefixes.sampling_point holds a FOREIGN KEY to this table and the
-- constraint is checked while this migration runs, so the rows it needs are
-- structural, not seed data. Migrations run before seeds, so a row that a
-- migration's own constraint depends on can never be supplied by a seed file:
-- `supabase db reset` would abort here with
-- "violates foreign key constraint sample_prefixes_sampling_point_fkey".
--
-- The labels are the two SAMPLING_POINT_OPTIONS of src/forms/registry.ts,
-- verbatim. supabase/seed/0001_controlled_vocabulary.sql repeats these rows
-- with an `on conflict (code) do update`, so loading the seed after this
-- migration refreshes the label and sort order instead of failing on a
-- duplicate key.
insert into public.sampling_points (code, label, sort_order) values
  ('AM', 'AM after mill',          10),
  ('BC', 'BC before conditioning', 20);

insert into public.sample_prefixes (prefix, stage, sampling_point, label) values
  ('RM', 'raw_materials', null, 'Raw material'),
  ('AM', 'ground',       'AM', 'Ground, after the mill'),
  ('BC', 'ground',       'BC', 'Ground, before conditioning'),
  ('AC', 'conditioned',   null, 'After conditioning'),
  ('AP', 'pellets',       null, 'After pelleting'),
  ('ES', 'extruded_soya', null, 'Extruded soya'),
  ('CR', 'crumble',       null, 'Crumble'),
  ('MS', 'mash',          null, 'Finished mash');


-- ---------------------------------------------------------------------------
-- stage_definitions  the seven operational tabs themselves.
--
-- Mirrors StageSchema in src/forms/registry.ts. The server needs three of
-- these facts and must not be told them by a client:
--   * `sheet_tab`  the exact tab name, which is the Sheets API addressing
--     key and which an outbox event must carry;
--   * `last_column` / `column_count`  what a schema verification compares
--     against;
--   * `frequency_approved`  FALSE for Ground, Conditioned, Pellets and
--     Crumble, because the workbook states their sampling frequency as
--     "To set". No overdue flag and no sampling-adherence percentage may be
--     computed for those four: the figure would be fabricated (FR-020,
--     risk R-08).
-- ---------------------------------------------------------------------------

create table public.stage_definitions (
  stage              public.sample_stage primary key,
  ordinal            integer not null unique,
  title              text not null,
  sheet_tab          text not null unique,
  last_column        text not null,
  column_count       integer not null,
  -- NULL for Ground, whose prefix is AM or BC depending on the sampling point.
  default_prefix     text references public.sample_prefixes (prefix),
  frequency          text not null,
  frequency_approved boolean not null,

  constraint stage_definitions_ordinal_range check (ordinal between 1 and 7),
  constraint stage_definitions_title_present check (length(btrim(title)) > 0),
  constraint stage_definitions_tab_present check (length(btrim(sheet_tab)) > 0),
  constraint stage_definitions_last_column_shape check (last_column ~ '^[A-Z]{1,2}$'),
  constraint stage_definitions_column_count_positive check (column_count > 0),
  -- A frequency the workbook has not set cannot be treated as approved.
  constraint stage_definitions_unset_frequency_not_approved
    check (frequency <> 'To set' or frequency_approved = false)
);

insert into public.stage_definitions (
  stage, ordinal, title, sheet_tab, last_column, column_count,
  default_prefix, frequency, frequency_approved
) values
  ('raw_materials', 1, 'Raw Materials', '1 Raw materials', 'S', 19, 'RM', 'Every load', true),
  ('ground', 2, 'Ground', '2 Ground', 'O', 15, null, 'To set', false),
  ('conditioned', 3, 'Conditioned', '3 Conditioned', 'M', 13, 'AC', 'To set', false),
  ('pellets', 4, 'Pellets', '4 Pellets', 'K', 11, 'AP', 'To set', false),
  ('extruded_soya', 5, 'Extruded Soya', '5 Extruded soya', 'P', 16, 'ES', 'Every run', true),
  ('crumble', 6, 'Crumble', '6 Crumble', 'M', 13, 'CR', 'To set', false),
  ('mash', 7, 'Mash', '7 Mash', 'K', 11, 'MS', 'Once per production run', true);

comment on column public.stage_definitions.frequency_approved is
  'False where the workbook says "To set". Four of seven stages. Gates every overdue flag and sampling KPI.';


-- ---------------------------------------------------------------------------
-- stage_fields  the 98 columns of the seven operational tabs.
--
-- Generated from src/forms/registry.ts, which is the single source of truth
-- (NFR-006). Its purpose here is to make `field_key` a FOREIGN KEY rather than
-- free text: a measurement naming a column that does not exist on that stage's
-- tab is rejected by the database, not by a validator somebody might forget to
-- call. It also carries the server-side copies of the hard bounds, the unit,
-- the unit-confirmed flag and the specification parameter key, because every
-- client input is untrusted and the server must be able to decide all of this
-- without being told.
--
-- `column_letter` and `sheet_header` are here so the outbox payload can be
-- projected onto the spreadsheet row without any module hardcoding a column
-- offset.
-- ---------------------------------------------------------------------------

create table public.stage_fields (
  stage               public.sample_stage not null,
  field_key           text not null,
  column_letter       text not null,
  sheet_header        text not null,
  field_type          public.field_type not null,
  section             public.form_section not null,
  requiredness        public.requiredness not null,
  unit                text,
  -- NULL where the field has no dimension at all (a text column, a date).
  -- FALSE where the workbook states no confirmed unit: `3 Conditioned` steam
  -- pressure, whose Limits Unit cell contains the literal string
  -- 'to confirm'. A measurement whose unit is unconfirmed can never be
  -- assessed as conforming (PRD section 5.3, UAT-07).
  unit_confirmed      boolean,
  -- Links the column to a specification parameter. Only fields with one can
  -- ever be assessed; the rest are recorded only.
  parameter_key       text,
  -- Physical or logical impossibilities only  a percentage above 100, a
  -- negative mass. NEVER an operational acceptance limit (rule 7).
  hard_min            numeric,
  hard_max            numeric,
  -- Soft typo guard. A value beyond this is accepted once the operator
  -- confirms it. It never contributes to a conformity assessment.
  implausible_above   numeric,
  decimals            integer,
  -- For a yes/no observation, the answer that forces a hold regardless of
  -- numeric results (FR-010, UAT-08).
  adverse_value       text,
  applies_when_field  text,
  applies_when_values text[],
  select_options      text[],

  primary key (stage, field_key),
  constraint stage_fields_stage_fk foreign key (stage)
    references public.stage_definitions (stage),
  constraint stage_fields_column_letter_shape check (column_letter ~ '^[A-Z]{1,2}$'),
  constraint stage_fields_header_present check (length(btrim(sheet_header)) > 0),
  constraint stage_fields_bounds_ordered
    check (hard_min is null or hard_max is null or hard_max >= hard_min),
  constraint stage_fields_adverse_value_shape
    check (adverse_value is null or adverse_value in ('yes', 'no')),
  constraint stage_fields_applies_when_complete
    check ((applies_when_field is null) = (applies_when_values is null)),
  -- A select must offer something to select.
  constraint stage_fields_select_has_options
    check (field_type not in ('select', 'yesno') or select_options is not null),
  -- One column letter per tab.
  unique (stage, column_letter)
);

create index stage_fields_parameter_key_idx
  on public.stage_fields (parameter_key)
  where parameter_key is not null;

comment on table public.stage_fields is
  'The 98 operational columns, mirroring src/forms/registry.ts. Makes sample_measurements.field_key a controlled vocabulary rather than free text.';

insert into public.stage_fields (
  stage, field_key, column_letter, sheet_header,
  field_type, section, requiredness,
  unit, unit_confirmed, parameter_key,
  hard_min, hard_max, implausible_above, decimals,
  adverse_value, applies_when_field, applies_when_values, select_options
) values
  ('raw_materials', 'sample_id', 'A', 'Sample ID', 'system', 'sample_details', 'system', null, null, null, null, null, null, null, null, null, null, null),
  ('raw_materials', 'collection_date', 'B', 'Date', 'date', 'sample_details', 'registration', null, null, null, null, null, null, null, null, null, null, null),
  ('raw_materials', 'collection_time', 'C', 'Time', 'time', 'sample_details', 'registration', null, null, null, null, null, null, null, null, null, null, null),
  ('raw_materials', 'material', 'D', 'Material', 'select', 'sample_details', 'registration', null, null, null, null, null, null, null, null, null, null, array['corn', 'rice', 'soya', 'other']::text[]),
  ('raw_materials', 'supplier', 'E', 'Supplier', 'text', 'sample_details', 'registration', null, null, null, null, null, null, null, null, null, null, null),
  ('raw_materials', 'delivery_or_lot_no', 'F', 'Delivery or lot no.', 'text', 'sample_details', 'registration', null, null, null, null, null, null, null, null, null, null, null),
  ('raw_materials', 'truck_or_container_no', 'G', 'Truck or container no.', 'text', 'sample_details', 'registration', null, null, null, null, null, null, null, null, null, null, null),
  ('raw_materials', 'quantity_received_t', 'H', 'Quantity received (tonnes)', 'number', 'sample_details', 'registration', 'tonnes', true, null, 0, null, 1000, 3, null, null, null, null),
  ('raw_materials', 'sampled_by', 'I', 'Sampled by', 'text', 'sample_details', 'registration', null, null, null, null, null, null, null, null, null, null, null),
  ('raw_materials', 'moisture_pct', 'J', 'Moisture (%)', 'number', 'test_results', 'testing', '%', true, 'raw_materials.moisture', 0, 100, null, 2, null, null, null, null),
  ('raw_materials', 'aflatoxin_ppb', 'K', 'Aflatoxin (ppb)', 'number', 'test_results', 'testing', 'ppb', true, 'raw_materials.aflatoxin', 0, null, 1000, 2, null, null, null, null),
  ('raw_materials', 'other_mycotoxin_name', 'L', 'Other mycotoxin tested (name)', 'text', 'test_results', 'optional', null, null, null, null, null, null, null, null, null, null, null),
  ('raw_materials', 'other_mycotoxin_result', 'M', 'Other mycotoxin result', 'number', 'test_results', 'optional', null, false, null, 0, null, null, 4, null, null, null, null),
  ('raw_materials', 'mould_seen', 'N', 'Mould seen?', 'yesno', 'test_results', 'registration', null, null, null, null, null, null, null, 'yes', null, null, array['yes', 'no']::text[]),
  ('raw_materials', 'insects_seen', 'O', 'Insects seen?', 'yesno', 'test_results', 'registration', null, null, null, null, null, null, null, 'yes', null, null, array['yes', 'no']::text[]),
  ('raw_materials', 'foreign_matter_seen', 'P', 'Foreign matter seen?', 'yesno', 'test_results', 'registration', null, null, null, null, null, null, null, 'yes', null, null, array['yes', 'no']::text[]),
  ('raw_materials', 'bad_smell', 'Q', 'Bad smell?', 'yesno', 'test_results', 'registration', null, null, null, null, null, null, null, 'yes', null, null, array['yes', 'no']::text[]),
  ('raw_materials', 'tested_by_qo', 'R', 'Tested by (QO)', 'text', 'follow_up', 'testing', null, null, null, null, null, null, null, null, null, null, null),
  ('raw_materials', 'comments', 'S', 'Comments', 'textarea', 'follow_up', 'optional', null, null, null, null, null, null, null, null, null, null, null),
  ('ground', 'sample_id', 'A', 'Sample ID', 'system', 'sample_details', 'system', null, null, null, null, null, null, null, null, null, null, null),
  ('ground', 'collection_date', 'B', 'Date', 'date', 'sample_details', 'registration', null, null, null, null, null, null, null, null, null, null, null),
  ('ground', 'collection_time', 'C', 'Time', 'time', 'sample_details', 'registration', null, null, null, null, null, null, null, null, null, null, null),
  ('ground', 'sampling_point', 'D', 'Sampling point', 'select', 'sample_details', 'registration', null, null, null, null, null, null, null, null, null, null, array['AM', 'BC']::text[]),
  ('ground', 'material_or_feed_type', 'E', 'Material or feed type', 'text', 'sample_details', 'registration', null, null, null, null, null, null, null, null, null, null, null),
  ('ground', 'batch_or_bin_no', 'F', 'Batch or bin no.', 'text', 'sample_details', 'registration', null, null, null, null, null, null, null, null, null, null, null),
  ('ground', 'sampled_by', 'G', 'Sampled by', 'text', 'sample_details', 'registration', null, null, null, null, null, null, null, null, null, null, null),
  ('ground', 'mill_screen_size_mm', 'H', 'Mill screen size (mm)', 'select', 'settings', 'registration', 'mm', true, null, null, null, null, null, null, null, null, array['5', '7']::text[]),
  ('ground', 'hammer_distance_mm', 'I', 'Hammer distance from screen (mm)', 'number', 'settings', 'registration', 'mm', true, 'ground.hammer_distance', 0, null, 500, 1, null, null, null, null),
  ('ground', 'avg_particle_size_um', 'J', 'Average particle size (µm)', 'number', 'test_results', 'testing', 'µm', true, 'ground.avg_particle_size', 0, null, 10000, 1, null, null, null, null),
  ('ground', 'size_spread_gsd', 'K', 'Size spread (GSD)', 'number', 'test_results', 'testing', null, null, 'ground.size_spread_gsd', 0, null, 100, 2, null, null, null, null),
  ('ground', 'moisture_pct_bc', 'L', 'Moisture (%) at BC', 'number', 'test_results', 'testing', '%', true, 'ground.moisture', 0, 100, null, 2, null, 'sampling_point', array['BC']::text[], null),
  ('ground', 'action_taken', 'M', 'Action taken', 'textarea', 'follow_up', 'optional', null, null, null, null, null, null, null, null, null, null, null),
  ('ground', 'tested_by_qo', 'N', 'Tested by (QO)', 'text', 'follow_up', 'testing', null, null, null, null, null, null, null, null, null, null, null),
  ('ground', 'comments', 'O', 'Comments', 'textarea', 'follow_up', 'optional', null, null, null, null, null, null, null, null, null, null, null),
  ('conditioned', 'sample_id', 'A', 'Sample ID', 'system', 'sample_details', 'system', null, null, null, null, null, null, null, null, null, null, null),
  ('conditioned', 'collection_date', 'B', 'Date', 'date', 'sample_details', 'registration', null, null, null, null, null, null, null, null, null, null, null),
  ('conditioned', 'collection_time', 'C', 'Time', 'time', 'sample_details', 'registration', null, null, null, null, null, null, null, null, null, null, null),
  ('conditioned', 'feed_type', 'D', 'Feed type', 'text', 'sample_details', 'registration', null, null, null, null, null, null, null, null, null, null, null),
  ('conditioned', 'batch_no', 'E', 'Batch no.', 'text', 'sample_details', 'registration', null, null, null, null, null, null, null, null, null, null, null),
  ('conditioned', 'sampled_by', 'F', 'Sampled by', 'text', 'sample_details', 'registration', null, null, null, null, null, null, null, null, null, null, null),
  ('conditioned', 'steam_pressure_reading', 'G', 'Steam pressure reading', 'number', 'settings', 'registration', null, false, 'conditioned.steam_pressure', 0, null, 100, 2, null, null, null, null),
  ('conditioned', 'water_added_pct', 'H', 'Water added (%)', 'number', 'settings', 'registration', '%', true, 'conditioned.water_added', 0, 100, null, 2, null, null, null, null),
  ('conditioned', 'mash_temperature_c', 'I', 'Mash temperature (°C)', 'number', 'test_results', 'testing', '°C', true, 'conditioned.temperature', 0, null, 300, 1, null, null, null, null),
  ('conditioned', 'moisture_pct', 'J', 'Moisture (%)', 'number', 'test_results', 'testing', '%', true, 'conditioned.moisture', 0, 100, null, 2, null, null, null, null),
  ('conditioned', 'action_taken', 'K', 'Action taken', 'textarea', 'follow_up', 'optional', null, null, null, null, null, null, null, null, null, null, null),
  ('conditioned', 'tested_by_qo', 'L', 'Tested by (QO)', 'text', 'follow_up', 'testing', null, null, null, null, null, null, null, null, null, null, null),
  ('conditioned', 'comments', 'M', 'Comments', 'textarea', 'follow_up', 'optional', null, null, null, null, null, null, null, null, null, null, null),
  ('pellets', 'sample_id', 'A', 'Sample ID', 'system', 'sample_details', 'system', null, null, null, null, null, null, null, null, null, null, null),
  ('pellets', 'collection_date', 'B', 'Date', 'date', 'sample_details', 'registration', null, null, null, null, null, null, null, null, null, null, null),
  ('pellets', 'collection_time', 'C', 'Time', 'time', 'sample_details', 'registration', null, null, null, null, null, null, null, null, null, null, null),
  ('pellets', 'feed_type', 'D', 'Feed type', 'text', 'sample_details', 'registration', null, null, null, null, null, null, null, null, null, null, null),
  ('pellets', 'batch_no', 'E', 'Batch no.', 'text', 'sample_details', 'registration', null, null, null, null, null, null, null, null, null, null, null),
  ('pellets', 'sampled_by', 'F', 'Sampled by', 'text', 'sample_details', 'registration', null, null, null, null, null, null, null, null, null, null, null),
  ('pellets', 'pellet_temperature_c', 'G', 'Pellet temperature (°C)', 'number', 'test_results', 'testing', '°C', true, 'pellets.temperature', 0, null, 300, 1, null, null, null, null),
  ('pellets', 'pellet_diameter_mm', 'H', 'Pellet diameter (mm)', 'number', 'test_results', 'testing', 'mm', true, 'pellets.pellet_diameter', 0, null, 100, 2, null, null, null, null),
  ('pellets', 'action_taken', 'I', 'Action taken', 'textarea', 'follow_up', 'optional', null, null, null, null, null, null, null, null, null, null, null),
  ('pellets', 'tested_by_qo', 'J', 'Tested by (QO)', 'text', 'follow_up', 'testing', null, null, null, null, null, null, null, null, null, null, null),
  ('pellets', 'comments', 'K', 'Comments', 'textarea', 'follow_up', 'optional', null, null, null, null, null, null, null, null, null, null, null),
  ('extruded_soya', 'sample_id', 'A', 'Sample ID', 'system', 'sample_details', 'system', null, null, null, null, null, null, null, null, null, null, null),
  ('extruded_soya', 'collection_date', 'B', 'Date', 'date', 'sample_details', 'registration', null, null, null, null, null, null, null, null, null, null, null),
  ('extruded_soya', 'collection_time', 'C', 'Time', 'time', 'sample_details', 'registration', null, null, null, null, null, null, null, null, null, null, null),
  ('extruded_soya', 'run_no', 'D', 'Run no.', 'text', 'sample_details', 'registration', null, null, null, null, null, null, null, null, null, null, null),
  ('extruded_soya', 'raw_soya_lot_no', 'E', 'Raw soya lot no.', 'text', 'sample_details', 'registration', null, null, null, null, null, null, null, null, null, null, null),
  ('extruded_soya', 'sampled_by', 'F', 'Sampled by', 'text', 'sample_details', 'registration', null, null, null, null, null, null, null, null, null, null, null),
  ('extruded_soya', 'crusher_roller_gap_mm', 'G', 'Crusher roller gap (mm)', 'number', 'settings', 'registration', 'mm', true, 'extruded_soya.crusher_roller_gap', 0, null, 100, 2, null, null, null, null),
  ('extruded_soya', 'steam_line_pct', 'H', 'Steam line (%)', 'number', 'settings', 'registration', '%', true, 'extruded_soya.steam_line', 0, 100, null, 1, null, null, null, null),
  ('extruded_soya', 'steam_line_temperature_c', 'I', 'Steam line temperature (°C)', 'number', 'settings', 'registration', '°C', true, 'extruded_soya.steam_line_temperature', 0, null, 400, 1, null, null, null, null),
  ('extruded_soya', 'extruder_temperature_c', 'J', 'Extruder temperature (°C)', 'number', 'settings', 'registration', '°C', true, 'extruded_soya.extruder_temperature', 0, null, 400, 1, null, null, null, null),
  ('extruded_soya', 'amount_ton_hr', 'K', 'Amount (ton/hr)', 'number', 'settings', 'registration', 'ton/hr', true, 'extruded_soya.amount', 0, null, 200, 2, null, null, null, null),
  ('extruded_soya', 'moisture_pct', 'L', 'Moisture (%)', 'number', 'test_results', 'testing', '%', true, 'extruded_soya.moisture', 0, 100, null, 2, null, null, null, null),
  ('extruded_soya', 'urease_ph_rise', 'M', 'Urease (pH rise)', 'number', 'test_results', 'testing', 'pH rise', true, 'extruded_soya.urease', 0, null, 14, 3, null, null, null, null),
  ('extruded_soya', 'protein_solubility_pct', 'N', 'Protein solubility (%)', 'number', 'test_results', 'testing', '%', true, 'extruded_soya.protein_solubility', 0, 100, null, 1, null, null, null, null),
  ('extruded_soya', 'tested_by_qo', 'O', 'Tested by (QO)', 'text', 'follow_up', 'testing', null, null, null, null, null, null, null, null, null, null, null),
  ('extruded_soya', 'comments', 'P', 'Comments', 'textarea', 'follow_up', 'optional', null, null, null, null, null, null, null, null, null, null, null),
  ('crumble', 'sample_id', 'A', 'Sample ID', 'system', 'sample_details', 'system', null, null, null, null, null, null, null, null, null, null, null),
  ('crumble', 'collection_date', 'B', 'Date', 'date', 'sample_details', 'registration', null, null, null, null, null, null, null, null, null, null, null),
  ('crumble', 'collection_time', 'C', 'Time', 'time', 'sample_details', 'registration', null, null, null, null, null, null, null, null, null, null, null),
  ('crumble', 'feed_type', 'D', 'Feed type', 'text', 'sample_details', 'registration', null, null, null, null, null, null, null, null, null, null, null),
  ('crumble', 'batch_no', 'E', 'Batch no.', 'text', 'sample_details', 'registration', null, null, null, null, null, null, null, null, null, null, null),
  ('crumble', 'sampled_by', 'F', 'Sampled by', 'text', 'sample_details', 'registration', null, null, null, null, null, null, null, null, null, null, null),
  ('crumble', 'crumbler_roll_gap_mm', 'G', 'Crumbler roll gap (mm)', 'number', 'settings', 'registration', 'mm', true, 'crumble.roll_gap', 0, null, 100, 2, null, null, null, null),
  ('crumble', 'moisture_pct', 'H', 'Moisture (%)', 'number', 'test_results', 'testing', '%', true, 'crumble.moisture', 0, 100, null, 2, null, null, null, null),
  ('crumble', 'avg_particle_size_um', 'I', 'Average particle size (µm)', 'number', 'test_results', 'testing', 'µm', true, 'crumble.avg_particle_size', 0, null, 10000, 1, null, null, null, null),
  ('crumble', 'pellet_durability_pdi_pct', 'J', 'Pellet durability (PDI, %)', 'number', 'test_results', 'testing', '%', true, 'crumble.pellet_durability_pdi', 0, 100, null, 1, null, null, null, null),
  ('crumble', 'crumble_size_mm', 'K', 'Crumble size (mm)', 'number', 'test_results', 'testing', 'mm', true, 'crumble.crumble_size', 0, null, 100, 2, null, null, null, null),
  ('crumble', 'tested_by_qo', 'L', 'Tested by (QO)', 'text', 'follow_up', 'testing', null, null, null, null, null, null, null, null, null, null, null),
  ('crumble', 'comments', 'M', 'Comments', 'textarea', 'follow_up', 'optional', null, null, null, null, null, null, null, null, null, null, null),
  ('mash', 'sample_id', 'A', 'Sample ID', 'system', 'sample_details', 'system', null, null, null, null, null, null, null, null, null, null, null),
  ('mash', 'collection_date', 'B', 'Date', 'date', 'sample_details', 'registration', null, null, null, null, null, null, null, null, null, null, null),
  ('mash', 'collection_time', 'C', 'Time', 'time', 'sample_details', 'registration', null, null, null, null, null, null, null, null, null, null, null),
  ('mash', 'feed_type', 'D', 'Feed type', 'text', 'sample_details', 'registration', null, null, null, null, null, null, null, null, null, null, null),
  ('mash', 'batch_no', 'E', 'Batch no.', 'text', 'sample_details', 'registration', null, null, null, null, null, null, null, null, null, null, null),
  ('mash', 'sampled_by', 'F', 'Sampled by', 'text', 'sample_details', 'registration', null, null, null, null, null, null, null, null, null, null, null),
  ('mash', 'moisture_pct', 'G', 'Moisture (%)', 'number', 'test_results', 'testing', '%', true, 'mash.moisture', 0, 100, null, 2, null, null, null, null),
  ('mash', 'avg_particle_size_um', 'H', 'Average particle size (µm)', 'number', 'test_results', 'testing', 'µm', true, 'mash.avg_particle_size', 0, null, 10000, 1, null, null, null, null),
  ('mash', 'size_spread_gsd', 'I', 'Size spread (GSD)', 'number', 'test_results', 'testing', null, null, 'mash.size_spread_gsd', 0, null, 100, 2, null, null, null, null),
  ('mash', 'tested_by_qo', 'J', 'Tested by (QO)', 'text', 'follow_up', 'testing', null, null, null, null, null, null, null, null, null, null, null),
  ('mash', 'comments', 'K', 'Comments', 'textarea', 'follow_up', 'optional', null, null, null, null, null, null, null, null, null, null, null);


-- ---------------------------------------------------------------------------
-- sample_id_counters  one row per (prefix, plant-local collection date).
--
-- The sequence key is the PLANT-LOCAL collection date, never a server UTC
-- calendar date, so a sample taken at 21:00 in Guyana is filed under that day
-- and not the following UTC one (Master Prompt section 5, src/lib/time.ts).
--
-- AM and BC count independently even though they share the `2 Ground` tab,
-- because the prefix is part of the key.
-- ---------------------------------------------------------------------------

create table public.sample_id_counters (
  prefix               text not null references public.sample_prefixes (prefix),
  collection_local_date date not null,
  -- The sequence number most recently ISSUED. The allocator returns the value
  -- it has just written, so the first allocation of a day returns 1.
  next_sequence        integer not null default 1,
  updated_at           timestamptz not null default now(),
  constraint sample_id_counters_pkey primary key (prefix, collection_local_date),
  constraint sample_id_counters_sequence_positive check (next_sequence >= 1)
);

comment on table public.sample_id_counters is
  'Atomic per-prefix, per-plant-local-date sequence. UNIQUE (prefix, collection_local_date) is the primary key.';


-- ---------------------------------------------------------------------------
-- allocate_sample_id  the atomic allocator.
--
-- A single INSERT ... ON CONFLICT DO UPDATE ... RETURNING. That statement
-- takes a row-level lock on the counter before computing the new value, so
-- concurrent callers serialise on the row and each receives a distinct
-- sequence. 20 simultaneous registrations on the same prefix and date yield 20
-- distinct identifiers (UAT-03).
--
-- What this deliberately is NOT:
--   * not SELECT-then-UPDATE  two sessions read the same value and both write
--     the same successor;
--   * not a Postgres sequence per day  it leaks on rollback, and a day's
--     sequence object would have to be created on demand, which is itself a
--     race;
--   * not COUNT(*) over the samples table  it counts committed rows only, so
--     two concurrent registrations both count N and both mint N+1;
--   * not a spreadsheet COUNTIF or a scan of the last sheet row  explicitly
--     forbidden by Master Prompt section 5, and a read-modify-write against a
--     system with no transactions.
--
-- Rollback behaviour is deliberate: an aborted registration does NOT return
-- its number to the pool, so identifiers can have gaps. A gap in a quality
-- record is harmless; a reused identifier is not.
-- ---------------------------------------------------------------------------

create function public.allocate_sample_id(
  p_prefix               text,
  p_collection_local_date date
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sequence integer;
begin
  if p_prefix is null or p_collection_local_date is null then
    raise exception 'allocate_sample_id requires a prefix and a plant-local collection date'
      using errcode = '22023';
  end if;

  if not exists (select 1 from public.sample_prefixes sp where sp.prefix = p_prefix) then
    raise exception 'Unknown sample prefix %', p_prefix using errcode = '23503';
  end if;

  insert into public.sample_id_counters as c (prefix, collection_local_date, next_sequence)
  values (p_prefix, p_collection_local_date, 1)
  on conflict (prefix, collection_local_date) do update
    set next_sequence = c.next_sequence + 1,
        updated_at    = now()
  returning c.next_sequence into v_sequence;

  -- PREFIX-YYMMDD-NN, padded to at least two digits and widening naturally
  -- past 99 (99 -> '99', 100 -> '100'), matching formatSampleId() in
  -- src/lib/sampleId.ts.
  --
  -- DO NOT "simplify" this back to lpad(v_sequence::text, 2, '0').
  -- Postgres lpad TRUNCATES when the input is longer than the target length:
  -- lpad('100', 2, '0') is '10', and lpad('1000', 2, '0') is also '10'. That
  -- is the opposite of JavaScript's padStart, which returns the string
  -- unchanged when it is already longer — so the TypeScript formatter in
  -- src/lib/sampleId.ts was correct while this one silently collided.
  -- Measured by UAT-03: 200 allocations produced only 99 distinct
  -- identifiers, duplicating from -10 onwards, while the counter itself
  -- advanced correctly to 200. The atomicity was never the problem; the
  -- rendering was. Guarded by scripts/verify-uat03-concurrency.sh, which
  -- fails if no identifier above 99 is issued.
  return p_prefix
         || '-' || to_char(p_collection_local_date, 'YYMMDD')
         || '-' || case when v_sequence < 10
                          then '0' || v_sequence::text
                          else v_sequence::text
                   end;
end;
$$;

comment on function public.allocate_sample_id(text, date) is
  'Atomically allocates the next PREFIX-YYMMDD-NN identifier. Safe under concurrency: the ON CONFLICT DO UPDATE takes a row lock before computing the successor.';


-- ---------------------------------------------------------------------------
-- samples.
--
-- A draft carries no sample_id. Registration allocates one, once, and it is
-- immutable thereafter even if the record is corrected or the spreadsheet is
-- re-sorted (PRD section 6.2, Master Prompt section 5).
-- ---------------------------------------------------------------------------

create table public.samples (
  id                     uuid primary key default gen_random_uuid(),
  -- NULL while the sample is a draft: "a draft should not silently reserve an
  -- official sample ID". Unique and immutable once allocated.
  sample_id              text unique,
  stage                  public.sample_stage not null,
  -- The structured sampling-point code. Non-null for `2 Ground` only, where it
  -- is 'AM' or 'BC'.
  stage_detail           text references public.sampling_points (code),
  -- Looked up from (stage, stage_detail) by trigger. Any client value is
  -- discarded.
  prefix                 text not null references public.sample_prefixes (prefix),

  -- Time. A full UTC instant, plus the plant-local date and time that belong
  -- in the operational log (NFR-008).
  collection_instant     timestamptz not null,
  collection_local_date  date not null,
  collection_local_time  time not null,

  -- Source context, denormalised from the measurements for search
  -- (Master Prompt section 8). The authoritative per-column values are the
  -- sample_measurements rows.
  material_code          text references public.materials (code),
  supplier_code          text references public.suppliers (code),
  supplier_label         text,
  feed_type_label        text,
  -- Delivery or lot no. / batch or bin no. / batch no. / run no., by stage.
  source_reference       text,
  -- Raw soya lot no. for extruded soya; the upstream identity where one exists.
  upstream_reference     text,
  mill_screen_size       text references public.mill_screen_sizes (code),
  sampled_by_name        text,

  created_by             uuid not null default auth.uid() references public.profiles (id),
  registered_by          uuid references public.profiles (id),
  registered_at          timestamptz,

  -- Monotonic optimistic-concurrency token. Every accepted mutation increments
  -- it; a writer passing a stale expected_revision is rejected (UAT-11).
  revision               integer not null default 1,

  capture_state          public.capture_state not null default 'draft',
  disposition            public.disposition_state not null default 'undetermined',
  -- Maintained by trigger from the holds table: true while any hold is
  -- uncleared. A hold outranks every permissive signal.
  hold_flag              boolean not null default false,

  -- Rollup of the outbox for this sample. A DRAFT has no outbox event and no
  -- sync obligation, so its value here is not meaningful and no sync status
  -- may be shown for it at all.
  --
  -- RENDERING RULE (rule 6): only
  -- 'confirmed' with a non-null sheet_confirmed_at may be shown as "Confirmed
  -- in Google Sheets". Every other value is "Recorded securely, Google Sheets
  -- sync pending", and 'failed'/'dead_letter' must additionally be surfaced as
  -- needing attention. There is no third, optimistic state.
  sheet_sync_state       public.sheet_sync_state not null default 'pending',
  sheet_row_hint         integer,
  sheet_confirmed_at     timestamptz,

  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),

  -- A draft has no identifier; anything past draft must have one.
  constraint samples_id_matches_state
    check ((capture_state = 'draft') or (sample_id is not null)),
  constraint samples_draft_has_no_id
    check ((capture_state <> 'draft') or (sample_id is null)),
  constraint samples_registration_pair
    check ((registered_by is null) = (registered_at is null)),
  constraint samples_registered_has_evidence
    check ((capture_state = 'draft') or (registered_by is not null)),
  -- `2 Ground` is the only stage with a sampling point, and the only one
  -- without one would be a sample whose identifier prefix is ambiguous.
  constraint samples_stage_detail_only_for_ground
    check ((stage = 'ground') = (stage_detail is not null)),
  constraint samples_mill_screen_only_for_ground
    check (mill_screen_size is null or stage = 'ground'),
  constraint samples_material_only_for_raw_materials
    check (material_code is null or stage = 'raw_materials'),
  constraint samples_supplier_only_for_raw_materials
    check ((supplier_code is null and supplier_label is null) or stage = 'raw_materials'),
  constraint samples_revision_positive check (revision >= 1),
  constraint samples_sheet_confirmation_pair
    check ((sheet_sync_state = 'confirmed') = (sheet_confirmed_at is not null))
);

create index samples_stage_date_idx on public.samples (stage, collection_local_date desc);
create index samples_capture_state_idx on public.samples (capture_state);
create index samples_hold_idx on public.samples (hold_flag) where hold_flag;
create index samples_sync_idx on public.samples (sheet_sync_state)
  where sheet_sync_state <> 'confirmed';
create index samples_created_by_idx on public.samples (created_by);
create index samples_source_reference_idx on public.samples (lower(source_reference))
  where source_reference is not null;
create index samples_instant_idx on public.samples (collection_instant desc);

comment on column public.samples.sample_id is
  'Durable human identifier PREFIX-YYMMDD-NN. NULL while draft, immutable once allocated.';
comment on column public.samples.revision is
  'Monotonic. A mutation carrying a stale expected_revision is rejected rather than silently overwriting.';


-- ---------------------------------------------------------------------------
-- sample_measurements  one row per recorded column.
--
-- Typed columns, not free JSON: a result is a numeric or a controlled text
-- value with its unit, its assessment and the identity of the rule that
-- decided it. `field_key` is a foreign key into the 98-row registry, so a
-- column that does not exist on that stage's tab cannot be written at all.
--
-- ZERO IS A REAL MEASURED VALUE. A missing measurement is the ABSENCE OF A
-- ROW, never a row of nulls, which is why the table requires at least one
-- value to be present (rule 8).
-- ---------------------------------------------------------------------------

create type public.assessment_result as enum (
  'within_limit',
  'outside_limit',
  'not_assessable',
  'not_tested',
  'not_applicable'
);

create type public.assessment_reason as enum (
  'within_approved_bounds',
  'outside_approved_bounds',
  'field_not_applicable',
  'no_result_recorded',
  'value_not_finite',
  'unit_not_confirmed',
  'no_approved_rule',
  'ambiguous_rules',
  'unit_mismatch',
  'rule_has_no_bounds'
);

create table public.sample_measurements (
  id                 uuid primary key default gen_random_uuid(),
  -- CASCADE is safe here only because tg_samples_guard_delete() refuses to
  -- delete anything but an unregistered draft. Abandoning a draft should take
  -- its half-typed values with it; nothing with an identifier is deletable at
  -- all.
  sample_uuid        uuid not null references public.samples (id) on delete cascade,
  stage              public.sample_stage not null,
  field_key          text not null,

  numeric_value      numeric,
  text_value         text,
  -- The operator's keystrokes, verbatim. '84.0' and '84' are the same number
  -- and different records: the trailing zero states the precision of the
  -- instrument reading, and the spreadsheet row must show what was written
  -- down. numeric would silently normalise it away.
  entered_text       text,

  unit               text,
  unit_confirmed     boolean not null default false,

  assessment_result  public.assessment_result,
  assessment_reason  public.assessment_reason,
  -- The rule that decided it, by version, as immutable evidence. A later limit
  -- change cannot rewrite this decision (UAT-12).
  rule_id            uuid,
  rule_version       integer,
  assessed_at        timestamptz,

  recorded_by        uuid not null default auth.uid() references public.profiles (id),
  recorded_at        timestamptz not null default now(),
  revision           integer not null default 1,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  -- One current row per column per sample. History lives in audit_events and
  -- assessments.
  unique (sample_uuid, field_key),
  foreign key (stage, field_key)
    references public.stage_fields (stage, field_key),
  -- A row exists because something was recorded.
  constraint sample_measurements_has_a_value
    check (numeric_value is not null or text_value is not null),
  -- A numeric result must carry the text the operator actually typed, so the
  -- entered precision is never lost.
  constraint sample_measurements_numeric_keeps_precision
    check (numeric_value is null or entered_text is not null),
  -- NaN and the infinities are not measurements, and `numeric` accepts all
  -- three since PostgreSQL 14. NaN = NaN is false, which excludes NaN; the
  -- two comparisons exclude the infinities.
  constraint sample_measurements_numeric_is_finite
    check (
      numeric_value is null
      or (numeric_value = numeric_value
          and numeric_value > '-Infinity'::numeric
          and numeric_value < 'Infinity'::numeric)
    ),
  constraint sample_measurements_assessment_pair
    check ((assessment_result is null) = (assessment_reason is null)),
  constraint sample_measurements_assessment_time
    check ((assessment_result is null) = (assessed_at is null)),
  constraint sample_measurements_rule_pair
    check ((rule_id is null) = (rule_version is null)),
  constraint sample_measurements_revision_positive check (revision >= 1)
);

create index sample_measurements_sample_idx on public.sample_measurements (sample_uuid);
create index sample_measurements_field_idx on public.sample_measurements (stage, field_key);
create index sample_measurements_adverse_idx
  on public.sample_measurements (sample_uuid, field_key)
  where assessment_result = 'outside_limit';

comment on constraint sample_measurements_numeric_is_finite on public.sample_measurements is
  'numeric accepts the literal NaN, and NaN = NaN is false, so this rejects it. Guards PRD section 6.1 "validate finite measurements".';


-- ---------------------------------------------------------------------------
-- sample_links  traceability, including the recorded absence of it.
--
-- "Where a stage can have multiple samples per batch, keep one-to-many
-- relationships; never automatically claim a one-to-one match. A MISSING
-- UPSTREAM LINK IS A RECORDED EXCEPTION, NOT SILENT INFERENCE"
-- (PRD section 6.4).
--
-- So the exception is a row of its own, with a reason, and not the absence of
-- a row. "No upstream batch was identifiable" and "nobody has looked yet" are
-- different facts and are stored differently.
-- ---------------------------------------------------------------------------

create type public.sample_link_type as enum (
  'upstream',
  'downstream',
  'traceability_exception'
);

create table public.sample_links (
  id              uuid primary key default gen_random_uuid(),
  link_type       public.sample_link_type not null,
  from_sample     uuid not null references public.samples (id) on delete restrict,
  to_sample       uuid references public.samples (id) on delete restrict,
  -- What kind of chain this is: 'rm_lot_to_es_run', 'batch_chain',
  -- 'production_run'. Free text so a new linkage does not need a migration,
  -- but never empty.
  relationship    text not null,
  -- The value the two records were matched ON  the batch, lot or run number.
  -- Recorded so the basis of the claim is inspectable.
  match_basis     text,
  exception_reason text,
  recorded_by     uuid not null default auth.uid() references public.profiles (id),
  recorded_at     timestamptz not null default now(),

  constraint sample_links_relationship_present check (length(btrim(relationship)) > 0),
  constraint sample_links_no_self_link check (to_sample is distinct from from_sample),
  -- An exception names no counterpart and must give a reason; a real link
  -- names a counterpart and carries no exception reason.
  constraint sample_links_shape check (
    (link_type = 'traceability_exception'
      and to_sample is null
      and length(btrim(coalesce(exception_reason, ''))) > 0)
    or
    (link_type <> 'traceability_exception'
      and to_sample is not null
      and exception_reason is null)
  ),
  -- No duplicate claims of the same relationship. Deliberately NOT unique on
  -- (from_sample, relationship): one batch may legitimately have several
  -- upstream samples.
  unique nulls not distinct (from_sample, to_sample, relationship, link_type)
);

create index sample_links_from_idx on public.sample_links (from_sample);
create index sample_links_to_idx on public.sample_links (to_sample) where to_sample is not null;
create index sample_links_exception_idx on public.sample_links (from_sample)
  where link_type = 'traceability_exception';


-- ---------------------------------------------------------------------------
-- Triggers: derived prefix, immutable identifier, monotonic revision.
-- ---------------------------------------------------------------------------

-- The prefix is DERIVED, not accepted. A client that sends 'AM' for a mash
-- sample gets 'MS' written, because the prefix is looked up from the stage and
-- the structured sampling point (PRD section 5.2).
create function public.tg_samples_derive_prefix()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_prefix text;
begin
  select sp.prefix into v_prefix
  from public.sample_prefixes sp
  where sp.stage = new.stage
    and sp.sampling_point is not distinct from new.stage_detail;

  if v_prefix is null then
    raise exception 'No sample prefix is defined for stage % with sampling point %',
      new.stage, coalesce(new.stage_detail, '(none)')
      using errcode = '23514';
  end if;

  new.prefix := v_prefix;
  return new;
end;
$$;

create trigger samples_derive_prefix
  before insert or update of stage, stage_detail on public.samples
  for each row execute function public.tg_samples_derive_prefix();

-- The identifier and the creation facts are immutable; the revision only ever
-- goes up. Enforced for every writer, including a SECURITY DEFINER function
-- and the table owner, because a trigger is not a privilege and cannot be
-- revoked away.
create function public.tg_samples_guard_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.sample_id is not null and new.sample_id is distinct from old.sample_id then
    raise exception 'sample_id % is immutable once allocated', old.sample_id
      using errcode = '23514';
  end if;

  if new.id is distinct from old.id then
    raise exception 'A sample UUID is immutable' using errcode = '23514';
  end if;

  if new.created_by is distinct from old.created_by then
    raise exception 'The creator of a sample is immutable' using errcode = '23514';
  end if;

  if new.created_at is distinct from old.created_at then
    raise exception 'The creation time of a sample is immutable' using errcode = '23514';
  end if;

  if new.revision < old.revision then
    raise exception 'revision is monotonic: cannot move from % to %', old.revision, new.revision
      using errcode = '23514';
  end if;

  if old.capture_state = 'voided' and new.capture_state <> 'voided' then
    raise exception 'A voided sample cannot change state. Register a new sample instead.'
      using errcode = '23514';
  end if;

  new.updated_at := now();
  return new;
end;
$$;

create trigger samples_guard_immutable
  before update on public.samples
  for each row execute function public.tg_samples_guard_immutable();

-- Only an unregistered draft is deletable, by anyone, by any route. This is
-- what makes the ON DELETE CASCADE from sample_measurements safe, and it holds
-- for a SECURITY DEFINER function and for the table owner as well, because a
-- trigger is not a privilege. Past draft the only exit is a reasoned void,
-- which leaves the record in place (NFR-005: no unlogged destructive changes).
--
-- SECURITY DEFINER so the abandonment can be audited: `authenticated` has no
-- INSERT privilege on public.audit_events and must not be given one.
create function public.tg_samples_guard_delete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.capture_state <> 'draft' or old.sample_id is not null then
    raise exception
      'Sample % cannot be deleted. Void it with a recorded reason instead.',
      coalesce(old.sample_id, old.id::text)
      using errcode = '23514';
  end if;

  insert into public.audit_events (
    actor_id, action, entity_type, entity_id, sample_uuid, before_payload, outcome
  )
  values (
    auth.uid(), 'sample.draft_abandoned', 'sample', old.id::text, null,
    jsonb_build_object(
      'stage', old.stage,
      'stage_detail', old.stage_detail,
      'created_by', old.created_by,
      'created_at', old.created_at
    ),
    'succeeded'
  );

  return old;
end;
$$;

create trigger samples_guard_delete
  before delete on public.samples
  for each row execute function public.tg_samples_guard_delete();

create trigger sample_measurements_set_updated_at
  before update on public.sample_measurements
  for each row execute function public.tg_set_updated_at();


-- ---------------------------------------------------------------------------
-- Row level security.
-- ---------------------------------------------------------------------------

alter table public.materials           enable row level security;
alter table public.feed_types          enable row level security;
alter table public.suppliers           enable row level security;
alter table public.sampling_points     enable row level security;
alter table public.mill_screen_sizes   enable row level security;
alter table public.sample_prefixes     enable row level security;
alter table public.stage_definitions   enable row level security;
alter table public.stage_fields        enable row level security;
alter table public.sample_id_counters  enable row level security;
alter table public.samples             enable row level security;
alter table public.sample_measurements enable row level security;
alter table public.sample_links        enable row level security;

-- Controlled vocabularies are readable by any active user; the forms need
-- them. They are not readable by a pending account.
create policy materials_select_active on public.materials
  for select to authenticated using (public.is_active_user());
create policy feed_types_select_active on public.feed_types
  for select to authenticated using (public.is_active_user());
create policy suppliers_select_active on public.suppliers
  for select to authenticated using (public.is_active_user());
create policy sampling_points_select_active on public.sampling_points
  for select to authenticated using (public.is_active_user());
create policy mill_screen_sizes_select_active on public.mill_screen_sizes
  for select to authenticated using (public.is_active_user());
create policy sample_prefixes_select_active on public.sample_prefixes
  for select to authenticated using (public.is_active_user());
create policy stage_definitions_select_active on public.stage_definitions
  for select to authenticated using (public.is_active_user());
create policy stage_fields_select_active on public.stage_fields
  for select to authenticated using (public.is_active_user());

-- sample_id_counters gets NO policy. The allocator is the only reader and
-- writer; exposing the counter would leak the day's sample volume to any
-- signed-in account and invite a read-modify-write client.

create policy samples_select_viewers on public.samples
  for select to authenticated
  using (
    public.has_permission('sample.view')
    -- The author of a draft can always see their own unfinished work, even
    -- before anybody has granted them sample.view.
    or (capture_state = 'draft' and created_by = auth.uid() and public.is_active_user())
  );

-- Drafts are the one thing a client writes directly, because a draft is
-- private, carries no identifier and has no effect on the quality record. The
-- column grants below are what stop a draft insert from setting its own
-- capture_state, sample_id, revision or disposition.
create policy samples_insert_own_draft on public.samples
  for insert to authenticated
  with check (
    public.has_permission('sample.draft')
    and created_by = auth.uid()
    and capture_state = 'draft'
    and sample_id is null
  );

create policy samples_update_own_draft on public.samples
  for update to authenticated
  using (
    capture_state = 'draft'
    and created_by = auth.uid()
    and public.has_permission('sample.draft')
  )
  with check (capture_state = 'draft' and created_by = auth.uid());

-- Abandoning a draft is allowed; abandoning anything with an identifier is
-- not. Past draft, the only exit is a reasoned void, which is a state change
-- and leaves the record in place.
create policy samples_delete_own_draft on public.samples
  for delete to authenticated
  using (
    capture_state = 'draft'
    and sample_id is null
    and created_by = auth.uid()
    and public.has_permission('sample.draft')
  );

create policy sample_measurements_select_viewers on public.sample_measurements
  for select to authenticated
  using (
    exists (
      select 1 from public.samples s
      where s.id = sample_measurements.sample_uuid
        and (
          public.has_permission('sample.view')
          or (s.capture_state = 'draft' and s.created_by = auth.uid() and public.is_active_user())
        )
    )
  );

-- Draft measurements only. Results on a registered sample go through
-- public.record_measurements(), which assesses them, snapshots the deciding
-- rule and enqueues the spreadsheet projection in one transaction.
create policy sample_measurements_write_own_draft on public.sample_measurements
  for insert to authenticated
  with check (
    public.has_permission('sample.draft')
    and recorded_by = auth.uid()
    and exists (
      select 1 from public.samples s
      where s.id = sample_measurements.sample_uuid
        and s.capture_state = 'draft'
        and s.created_by = auth.uid()
    )
  );

create policy sample_measurements_update_own_draft on public.sample_measurements
  for update to authenticated
  using (
    public.has_permission('sample.draft')
    and exists (
      select 1 from public.samples s
      where s.id = sample_measurements.sample_uuid
        and s.capture_state = 'draft'
        and s.created_by = auth.uid()
    )
  )
  with check (recorded_by = auth.uid());

create policy sample_measurements_delete_own_draft on public.sample_measurements
  for delete to authenticated
  using (
    public.has_permission('sample.draft')
    and exists (
      select 1 from public.samples s
      where s.id = sample_measurements.sample_uuid
        and s.capture_state = 'draft'
        and s.created_by = auth.uid()
    )
  );

create policy sample_links_select_viewers on public.sample_links
  for select to authenticated
  using (public.has_permission('sample.view'));

-- Links and recorded exceptions are written by public.record_sample_link(),
-- which audits them. No direct client write.


-- ---------------------------------------------------------------------------
-- Table privileges.
--
-- The project's default privileges grant every new table in `public` to `anon`
-- and `authenticated` at CREATE TABLE time. That grant is recorded, so this
-- revoke removes it; `anon` ends with nothing at all, and `authenticated` is
-- re-granted only what RLS is supposed to mediate.
-- ---------------------------------------------------------------------------

revoke all on public.materials           from anon, authenticated;
revoke all on public.feed_types          from anon, authenticated;
revoke all on public.suppliers           from anon, authenticated;
revoke all on public.sampling_points     from anon, authenticated;
revoke all on public.mill_screen_sizes   from anon, authenticated;
revoke all on public.sample_prefixes     from anon, authenticated;
revoke all on public.stage_definitions   from anon, authenticated;
revoke all on public.stage_fields        from anon, authenticated;
revoke all on public.sample_id_counters  from anon, authenticated;
revoke all on public.samples             from anon, authenticated;
revoke all on public.sample_measurements from anon, authenticated;
revoke all on public.sample_links        from anon, authenticated;

grant select on public.materials         to authenticated;
grant select on public.feed_types        to authenticated;
grant select on public.suppliers         to authenticated;
grant select on public.sampling_points   to authenticated;
grant select on public.mill_screen_sizes to authenticated;
grant select on public.sample_prefixes   to authenticated;
grant select on public.stage_definitions to authenticated;
grant select on public.stage_fields      to authenticated;
grant select on public.sample_links      to authenticated;

-- Column-level INSERT and UPDATE on drafts. Everything a client may set is
-- listed; everything it may not  sample_id, prefix, revision, capture_state,
-- disposition, hold_flag, sheet_sync_state, sheet_row_hint,
-- sheet_confirmed_at, registered_by, registered_at, created_by, created_at
-- is absent, so a statement naming one is rejected by the privilege system
-- before any policy runs. `created_by` defaults to auth.uid(), which is why it
-- need not be grantable.
grant select on public.samples to authenticated;
grant insert (
  stage, stage_detail, collection_instant, collection_local_date,
  collection_local_time, material_code, supplier_code, supplier_label,
  feed_type_label, source_reference, upstream_reference, mill_screen_size,
  sampled_by_name
) on public.samples to authenticated;
grant update (
  stage, stage_detail, collection_instant, collection_local_date,
  collection_local_time, material_code, supplier_code, supplier_label,
  feed_type_label, source_reference, upstream_reference, mill_screen_size,
  sampled_by_name
) on public.samples to authenticated;
grant delete on public.samples to authenticated;

grant select on public.sample_measurements to authenticated;
grant insert (
  sample_uuid, stage, field_key, numeric_value, text_value, entered_text,
  unit, unit_confirmed
) on public.sample_measurements to authenticated;
grant update (
  numeric_value, text_value, entered_text, unit, unit_confirmed
) on public.sample_measurements to authenticated;
grant delete on public.sample_measurements to authenticated;


-- ---------------------------------------------------------------------------
-- Function privileges. Revoked from PUBLIC by name, then granted explicitly.
-- The allocator is NOT granted to `authenticated`: a client must never be able
-- to burn identifiers. Only register_sample(), which runs as definer, calls it.
-- ---------------------------------------------------------------------------

revoke all on function public.allocate_sample_id(text, date) from public;
grant execute on function public.allocate_sample_id(text, date) to service_role;

revoke all on function public.tg_samples_derive_prefix() from public;
revoke all on function public.tg_samples_guard_immutable() from public;
revoke all on function public.tg_samples_guard_delete() from public;
