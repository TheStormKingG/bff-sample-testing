-- ===========================================================================
-- 0025 — the DGM stage: its definition, its 35 columns, its prefix, and a
--        home for the values the server computes rather than the operator
--        measures.
--
-- Depends on 0024, which adds the enum label and explains the sequencing trap
-- that governs both files. Read that header first.
--
-- ---------------------------------------------------------------------------
-- WHY THERE IS A NEW TABLE HERE
-- ---------------------------------------------------------------------------
-- A DGM record holds nine values nobody types: total retained, the fineness
-- module, DGM in micrometres, three uniformity bands, the legacy DPG index, a
-- real geometric standard deviation, and the basis the last of those was
-- computed on. The obvious home is `sample_measurements`, and the schema
-- refuses it — deliberately, and in so many words:
--
--     if v_field.field_type = 'system' or v_field.requiredness = 'system' then
--       raise exception 'Column % is assigned by the server and cannot be
--       submitted', p_field_key          -- 0008_assessment_engine.sql:386
--
-- That rule is why `sample_id` lives on `samples` rather than as a
-- measurement row, and it is correct: `sample_measurements.recorded_by`
-- defaults to the submitting user, so filing arithmetic there would enter
-- computed numbers into the audit trail as an operator's attested
-- measurement. For a quality system that is the wrong claim to make, and it
-- would be indistinguishable afterwards from a real one.
--
-- So derived values get their own table, with no `recorded_by` at all, and
-- `sample_measurements` is left exactly as it is.
--
-- ---------------------------------------------------------------------------
-- WHY A TRIGGER AND NOT A NEW RPC PARAMETER
-- ---------------------------------------------------------------------------
-- The values must be written in the SAME transaction as the sample, or a
-- failure leaves a registered test whose results are missing. The Edge
-- Function makes exactly one call — `rpc_register_sample` — so an in-
-- transaction write has to originate inside it.
--
-- Adding a parameter would mean `drop function` plus a verbatim re-creation of
-- a two-hundred-line body, forking it for one line. Instead this hangs on the
-- outbox insert, which `rpc_register_sample` already performs inside its
-- transaction (0013:717) and `rpc_update_results` performs again on a
-- correction (0013:879). The projected row it inserts ALREADY carries the
-- computed cells, because the Edge Function merges them in before serialising.
-- One trigger therefore covers registration, correction, and any future path
-- that projects a row — rather than one line in each, which is how a path gets
-- missed.
--
-- The trigger is deliberately incapable of breaking the seven existing stages:
-- it does nothing unless the stage has `system` columns other than column A,
-- and only `dgm` does.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. Room for an eighth stage.
--
-- `stage_definitions_ordinal_range` is the ONLY constraint in the schema that
-- hardcodes the number seven. Everything else that counts stages counts the
-- enum.
-- ---------------------------------------------------------------------------

alter table public.stage_definitions
  drop constraint stage_definitions_ordinal_range;

alter table public.stage_definitions
  add constraint stage_definitions_ordinal_range check (ordinal between 1 and 8);


-- ---------------------------------------------------------------------------
-- 2. The prefix.
--
-- 'DG', not 'DGM': `sample_prefixes_shape` is `check (prefix ~ '^[A-Z]{2}$')`,
-- so a three-letter prefix is not expressible. Mirrors `ALL_PREFIXES` in
-- src/forms/registry.ts, which compiles into the sample-ID regex at
-- src/lib/sampleId.ts.
-- ---------------------------------------------------------------------------

insert into public.sample_prefixes (prefix, stage, sampling_point, label) values
  ('DG', 'dgm', null, 'DGM granulometry');


-- ---------------------------------------------------------------------------
-- 3. The stage.
--
-- `frequency_approved` is false: the lab has not stated how often this test is
-- run, so no overdue flag and no sampling-adherence percentage may be computed
-- for it — the figure would be fabricated (FR-020, risk R-08). The
-- `stage_definitions_unset_frequency_not_approved` constraint enforces the
-- pairing.
-- ---------------------------------------------------------------------------

insert into public.stage_definitions (
  stage, ordinal, title, sheet_tab, last_column, column_count,
  default_prefix, frequency, frequency_approved
) values
  ('dgm', 8, 'DGM', '8 DGM', 'AI', 35, 'DG', 'To set', false);


-- ---------------------------------------------------------------------------
-- 4. The 35 columns.
--
-- GENERATED from src/forms/registry.ts rather than transcribed — the registry
-- is the single source of truth (NFR-006) and a hand-copied fourth spelling of
-- 35 rows is how the other tabs' copies came to be unverified.
--
-- `tests/registryDatabaseContract.test.ts` parses this block and compares it
-- back to the registry, in both directions, for EVERY stage. That gate did not
-- exist when the first seven tabs were seeded; 0002_samples.sql:24-27 claims
-- it did ("asserted against the registry by the dry-run harness and by CI"),
-- and nothing in the repository ever performed that comparison.
-- ---------------------------------------------------------------------------

insert into public.stage_fields (
  stage, field_key, column_letter, sheet_header,
  field_type, section, requiredness,
  unit, unit_confirmed, parameter_key,
  hard_min, hard_max, implausible_above, decimals,
  adverse_value, applies_when_field, applies_when_values, select_options
) values
  ('dgm', 'sample_id', 'A', 'Sample ID',
   'system', 'sample_details', 'system',
   null, null, null,
   null, null, null, null,
   null, null, null, null),
  ('dgm', 'collection_date', 'B', 'Date',
   'date', 'sample_details', 'registration',
   null, null, null,
   null, null, null, null,
   null, null, null, null),
  ('dgm', 'collection_time', 'C', 'Time',
   'time', 'sample_details', 'registration',
   null, null, null,
   null, null, null, null,
   null, null, null, null),
  ('dgm', 'feed_type', 'D', 'Feed type',
   'text', 'sample_details', 'registration',
   null, null, null,
   null, null, null, null,
   null, null, null, null),
  ('dgm', 'batch_no', 'E', 'Batch no.',
   'text', 'sample_details', 'registration',
   null, null, null,
   null, null, null, null,
   null, null, null, null),
  ('dgm', 'sampled_by', 'F', 'Sampled by',
   'text', 'sample_details', 'registration',
   null, null, null,
   null, null, null, null,
   null, null, null, null),
  ('dgm', 'mill_rpm', 'G', 'Mill RPM',
   'number', 'settings', 'optional',
   null, null, null,
   0, null, 10000, 0,
   null, null, null, null),
  ('dgm', 'mill_hz_position', 'H', 'Mill Hz or position',
   'text', 'settings', 'optional',
   null, null, null,
   null, null, null, null,
   null, null, null, null),
  ('dgm', 'grind_time', 'I', 'Grind time',
   'text', 'settings', 'optional',
   null, null, null,
   null, null, null, null,
   null, null, null, null),
  ('dgm', 'sieve_series', 'J', 'Sieve series',
   'select', 'settings', 'registration',
   null, null, null,
   null, null, null, null,
   null, null, null, array['abnt-standard-7']),
  ('dgm', 'sieve1_tare_g', 'K', 'ABNT 5 empty sieve (g)',
   'number', 'test_results', 'registration',
   'g', true, null,
   0, null, 2000, 2,
   null, null, null, null),
  ('dgm', 'sieve1_gross_g', 'L', 'ABNT 5 sieve + sample (g)',
   'number', 'test_results', 'registration',
   'g', true, null,
   0, null, 2000, 2,
   null, null, null, null),
  ('dgm', 'sieve2_tare_g', 'M', 'ABNT 10 empty sieve (g)',
   'number', 'test_results', 'registration',
   'g', true, null,
   0, null, 2000, 2,
   null, null, null, null),
  ('dgm', 'sieve2_gross_g', 'N', 'ABNT 10 sieve + sample (g)',
   'number', 'test_results', 'registration',
   'g', true, null,
   0, null, 2000, 2,
   null, null, null, null),
  ('dgm', 'sieve3_tare_g', 'O', 'ABNT 16 empty sieve (g)',
   'number', 'test_results', 'registration',
   'g', true, null,
   0, null, 2000, 2,
   null, null, null, null),
  ('dgm', 'sieve3_gross_g', 'P', 'ABNT 16 sieve + sample (g)',
   'number', 'test_results', 'registration',
   'g', true, null,
   0, null, 2000, 2,
   null, null, null, null),
  ('dgm', 'sieve4_tare_g', 'Q', 'ABNT 30 empty sieve (g)',
   'number', 'test_results', 'registration',
   'g', true, null,
   0, null, 2000, 2,
   null, null, null, null),
  ('dgm', 'sieve4_gross_g', 'R', 'ABNT 30 sieve + sample (g)',
   'number', 'test_results', 'registration',
   'g', true, null,
   0, null, 2000, 2,
   null, null, null, null),
  ('dgm', 'sieve5_tare_g', 'S', 'ABNT 50 empty sieve (g)',
   'number', 'test_results', 'registration',
   'g', true, null,
   0, null, 2000, 2,
   null, null, null, null),
  ('dgm', 'sieve5_gross_g', 'T', 'ABNT 50 sieve + sample (g)',
   'number', 'test_results', 'registration',
   'g', true, null,
   0, null, 2000, 2,
   null, null, null, null),
  ('dgm', 'sieve6_tare_g', 'U', 'ABNT 400 empty sieve (g)',
   'number', 'test_results', 'registration',
   'g', true, null,
   0, null, 2000, 2,
   null, null, null, null),
  ('dgm', 'sieve6_gross_g', 'V', 'ABNT 400 sieve + sample (g)',
   'number', 'test_results', 'registration',
   'g', true, null,
   0, null, 2000, 2,
   null, null, null, null),
  ('dgm', 'sieve7_tare_g', 'W', 'Pan empty (g)',
   'number', 'test_results', 'registration',
   'g', true, null,
   0, null, 2000, 2,
   null, null, null, null),
  ('dgm', 'sieve7_gross_g', 'X', 'Pan + sample (g)',
   'number', 'test_results', 'registration',
   'g', true, null,
   0, null, 2000, 2,
   null, null, null, null),
  ('dgm', 'total_retained_g', 'Y', 'Total retained (g)',
   'system', 'test_results', 'system',
   null, null, null,
   null, null, null, null,
   null, null, null, null),
  ('dgm', 'fineness_module', 'Z', 'Fineness module (MF)',
   'system', 'test_results', 'system',
   null, null, null,
   null, null, null, null,
   null, null, null, null),
  ('dgm', 'dgm_um', 'AA', 'DGM (µm)',
   'system', 'test_results', 'system',
   null, null, null,
   null, null, null, null,
   null, null, null, null),
  ('dgm', 'ui_coarse_pct', 'AB', 'UI coarse (%)',
   'system', 'test_results', 'system',
   null, null, null,
   null, null, null, null,
   null, null, null, null),
  ('dgm', 'ui_average_pct', 'AC', 'UI average (%)',
   'system', 'test_results', 'system',
   null, null, null,
   null, null, null, null,
   null, null, null, null),
  ('dgm', 'ui_fine_pct', 'AD', 'UI fine (%)',
   'system', 'test_results', 'system',
   null, null, null,
   null, null, null, null,
   null, null, null, null),
  ('dgm', 'dpg_legacy_index', 'AE', 'DPG legacy index',
   'system', 'test_results', 'system',
   null, null, null,
   null, null, null, null,
   null, null, null, null),
  ('dgm', 'gsd', 'AF', 'Geometric standard deviation',
   'system', 'test_results', 'system',
   null, null, null,
   null, null, null, null,
   null, null, null, null),
  ('dgm', 'gsd_basis', 'AG', 'GSD basis',
   'system', 'test_results', 'system',
   null, null, null,
   null, null, null, null,
   null, null, null, null),
  ('dgm', 'tested_by_qo', 'AH', 'Tested by (QO)',
   'text', 'follow_up', 'registration',
   null, null, null,
   null, null, null, null,
   null, null, null, null),
  ('dgm', 'comments', 'AI', 'Comments',
   'textarea', 'follow_up', 'optional',
   null, null, null,
   null, null, null, null,
   null, null, null, null)
;


-- ---------------------------------------------------------------------------
-- 5. Column letter -> 1-based index, for the whole A..ZZ range.
--
-- `apply_submitted_values` does this inline (0013:330) and only for a SINGLE
-- letter, with a comment stating the assumption plainly: "The column letters
-- are A..S, one character". That was true of seven tabs and is not true of
-- this one, which runs to AI. This function is the general form; the inline
-- version is deliberately left alone, because no DGM column it reads is
-- beyond Z (every numeric field sits in K..X) and widening a shared RPC is
-- not this migration's business.
-- ---------------------------------------------------------------------------

create or replace function public.column_letter_to_index(p_letter text)
returns integer
language sql
immutable
parallel safe
set search_path = ''
as $$
  select case
    when p_letter is null or p_letter !~ '^[A-Z]{1,2}$' then null
    when length(p_letter) = 1 then ascii(p_letter) - ascii('A') + 1
    else (ascii(substr(p_letter, 1, 1)) - ascii('A') + 1) * 26
         + (ascii(substr(p_letter, 2, 1)) - ascii('A') + 1)
  end;
$$;

-- PostgreSQL grants EXECUTE to PUBLIC on a new function by default, and
-- `assert_function_privileges()` (0009) refuses that for anything in `public`.
-- It caught this one on the first apply. Nothing is granted in its place: the
-- only caller is the SECURITY DEFINER trigger below, which runs as the owner.
revoke all on function public.column_letter_to_index(text) from public, anon, authenticated;

comment on function public.column_letter_to_index(text) is
  'Spreadsheet column letter to 1-based index, A..ZZ. Mirrors columnLetterToIndex in src/forms/sheetMapping.ts.';


-- ---------------------------------------------------------------------------
-- 6. Where a computed value lives.
--
-- No `recorded_by`, and that absence is the design: nobody recorded these.
-- `computed_at` is when the server worked them out, which is not the same
-- instant as `samples.recorded_at` and must not be inferred from it.
--
-- `display_text` is the cell the spreadsheet actually received. It is stored
-- next to the exact `numeric_value` rather than derived from it, because the
-- two answer different questions — what the record SAYS and what the number
-- IS — and a rounding rule that changes later must not silently rewrite the
-- first.
-- ---------------------------------------------------------------------------

create table public.sample_derived_results (
  sample_uuid   uuid not null references public.samples (id) on delete cascade,
  stage         public.sample_stage not null,
  result_key    text not null,
  numeric_value numeric,
  display_text  text not null,
  computed_at   timestamptz not null default now(),
  revision      integer not null default 1,

  primary key (sample_uuid, result_key),
  -- The same controlled vocabulary the measurements use: a derived key that is
  -- not a column on that stage's tab cannot be stored.
  constraint sample_derived_results_field_fk
    foreign key (stage, result_key) references public.stage_fields (stage, field_key),
  constraint sample_derived_results_display_present
    check (length(btrim(display_text)) > 0),
  -- NaN and the infinities are not results. `numeric` accepts all three since
  -- PostgreSQL 14; NaN = NaN is false, which excludes it.
  constraint sample_derived_results_numeric_is_finite
    check (
      numeric_value is null
      or (numeric_value = numeric_value
          and numeric_value > '-Infinity'::numeric
          and numeric_value < 'Infinity'::numeric)
    )
);

comment on table public.sample_derived_results is
  'Values the server computed for a sample, never submitted by anyone. Kept out of sample_measurements because apply_measurement refuses a server-assigned column, and because recorded_by there would file arithmetic as an operator''s attested measurement.';

create index sample_derived_results_stage_idx
  on public.sample_derived_results (stage, result_key);

alter table public.sample_derived_results enable row level security;

-- Readable by anyone who may read the sample it belongs to, on exactly the
-- predicate `sample_measurements_select_viewers` uses. `has_permission`
-- consults the forced-password-change gate, which is what
-- `assert_password_gate_on_every_policy` (0020) requires of every policy.
create policy sample_derived_results_select_viewers on public.sample_derived_results
  for select to authenticated
  using (
    exists (
      select 1 from public.samples s
      where s.id = sample_derived_results.sample_uuid
        and (
          public.has_permission('sample.view')
          or (s.capture_state = 'draft' and s.created_by = auth.uid() and public.is_active_user())
        )
    )
  );

-- No insert, update or delete policy exists, for anyone. Every write goes
-- through the SECURITY DEFINER trigger below, which runs as the table owner
-- and is therefore not subject to RLS. A client cannot write a computed
-- result by any route.


-- ---------------------------------------------------------------------------
-- 7. The write, hung on the outbox insert.
--
-- The projected row is the authoritative serialisation of the sample, built by
-- `toSheetRow` and already carrying the computed cells. Reading them back out
-- of it means the stored values and the spreadsheet cells cannot disagree:
-- they are the same strings.
--
-- SAFETY FOR THE SEVEN EXISTING STAGES. The loop below selects `system`
-- columns other than `sample_id`. Those stages have none, so the loop body
-- never executes and the trigger is a single indexed lookup on every existing
-- write path. It cannot raise for them.
-- ---------------------------------------------------------------------------

create or replace function public.tg_record_derived_results()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_stage   public.sample_stage;
  v_field   record;
  v_cell    text;
  v_numeric numeric;
begin
  if new.projected_row is null then
    return new;
  end if;

  select s.stage into v_stage from public.samples s where s.id = new.sample_uuid;
  if v_stage is null then
    return new;
  end if;

  for v_field in
    select f.field_key, f.column_letter
    from public.stage_fields f
    where f.stage = v_stage
      and f.field_type = 'system'
      and f.field_key <> 'sample_id'
    order by public.column_letter_to_index(f.column_letter)
  loop
    v_cell := new.projected_row[public.column_letter_to_index(v_field.column_letter)];

    -- A blank cell is the absence of a result, not a result of zero. The row
    -- carries one when the computation had no answer to give -- every gross
    -- mass equal to its tare makes R% a 0/0 -- and writing a row here would
    -- turn "undefined" into "measured and it was nothing".
    if v_cell is null or btrim(v_cell) = '' then
      delete from public.sample_derived_results
      where sample_uuid = new.sample_uuid and result_key = v_field.field_key;
      continue;
    end if;

    -- `gsd_basis` is text; the other eight are numbers. Parse rather than
    -- assume, and keep the cell either way: the display text is the record.
    begin
      v_numeric := v_cell::numeric;
      if not (v_numeric = v_numeric
              and v_numeric > '-Infinity'::numeric
              and v_numeric < 'Infinity'::numeric) then
        v_numeric := null;
      end if;
    exception when others then
      v_numeric := null;
    end;

    insert into public.sample_derived_results as d
      (sample_uuid, stage, result_key, numeric_value, display_text)
    values
      (new.sample_uuid, v_stage, v_field.field_key, v_numeric, v_cell)
    on conflict (sample_uuid, result_key) do update
      set numeric_value = excluded.numeric_value,
          display_text  = excluded.display_text,
          computed_at   = now(),
          revision      = d.revision + 1;
  end loop;

  return new;
end;
$$;

comment on function public.tg_record_derived_results() is
  'Stores a stage''s server-computed columns from the projected row, in the transaction that enqueued it. No-op for stages whose only system column is A.';

revoke all on function public.tg_record_derived_results() from public, anon, authenticated;

create trigger sheet_sync_outbox_record_derived
  after insert on public.sheet_sync_outbox
  for each row
  execute function public.tg_record_derived_results();

grant select on public.sample_derived_results to authenticated;
-- The Edge Functions read it back to show the operator their results; the
-- same positive-direction assertion 0023 introduced covers it.
grant select on public.sample_derived_results to service_role;


-- ---------------------------------------------------------------------------
-- 8. Re-run every standing assertion, because this migration created
--    functions, a policy and a grant.
-- ---------------------------------------------------------------------------

select public.assert_function_privileges();
select public.assert_password_gate_on_every_policy();
select public.assert_service_role_reads();
