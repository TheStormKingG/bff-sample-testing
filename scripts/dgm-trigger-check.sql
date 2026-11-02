\set ON_ERROR_STOP on
\i :rows_file

begin;

-- Identity the FKs require. Nothing here is under test.
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-00000000000a', 'harness@example.test');
-- No explicit profiles insert: `on_auth_user_created` already made one.
-- Discovered by running this, not by reading the migrations.

-- One DGM sample. The trigger reads only `samples.stage` off this.
insert into public.samples
  (id, sample_id, stage, prefix, collection_instant, collection_local_date, collection_local_time,
   created_by, registered_by, registered_at, capture_state)
values
  ('bbbbbbbb-0000-0000-0000-00000000000b', 'DG-261029-01', 'dgm', 'DG',
   '2026-10-29T13:30:00Z', '2026-10-29', '09:30',
   'aaaaaaaa-0000-0000-0000-00000000000a',
   'aaaaaaaa-0000-0000-0000-00000000000a', now(), 'registered');

-- ===========================================================================
-- CASE A — registration. The row the TypeScript actually produced.
-- ===========================================================================
insert into public.sheet_sync_outbox
  (sample_uuid, target_tab, event_kind, payload_revision, payload_hash, payload, projected_row)
values
  ('bbbbbbbb-0000-0000-0000-00000000000b', '8 DGM', 'register', 1, repeat('a',64), '{}'::jsonb,
   :'worked_row'::text[]);

do $$
declare got text; want text;
begin
  select string_agg(result_key || '=' || display_text, '|' order by result_key)
    into got from public.sample_derived_results
   where sample_uuid = 'bbbbbbbb-0000-0000-0000-00000000000b';
  want := 'dgm_um=1472.6131|dpg_legacy_index=4.520676|fineness_module=3.821782|'
       || 'gsd=1.672121|gsd_basis=series-ratio-top-bound/pan-excluded|'
       || 'total_retained_g=202.00|ui_average_pct=77.2277|ui_coarse_pct=22.7723|ui_fine_pct=0.0000';
  if got is distinct from want then
    raise exception E'CASE A stored the wrong cells.\n  got:  %\n  want: %', got, want;
  end if;
  raise notice 'CASE A  ok  9 cells stored, every one byte-identical to the projected row';
end $$;

-- The numeric parse: eight numbers, and the basis string must NOT parse.
do $$
declare bad text;
begin
  select string_agg(result_key || ' numeric=' || coalesce(numeric_value::text,'NULL'), ', ')
    into bad from public.sample_derived_results
   where sample_uuid = 'bbbbbbbb-0000-0000-0000-00000000000b'
     and ((result_key = 'gsd_basis' and numeric_value is not null)
       or (result_key <> 'gsd_basis' and numeric_value is null));
  if bad is not null then
    raise exception 'numeric_value parsed wrongly: %', bad;
  end if;
  raise notice 'CASE A  ok  8 numerics parsed, gsd_basis kept as text with numeric_value NULL';
end $$;

-- A calculated zero is STORED, not dropped. ui_fine_pct is 0.0000 here.
do $$
declare v text;
begin
  select display_text into v from public.sample_derived_results
   where sample_uuid='bbbbbbbb-0000-0000-0000-00000000000b' and result_key='ui_fine_pct';
  if v is distinct from '0.0000' then
    raise exception 'a calculated zero was not stored verbatim: %', coalesce(v,'<missing>');
  end if;
  raise notice 'CASE A  ok  a calculated zero (ui_fine_pct 0.0000) is stored, not dropped';
end $$;

-- ===========================================================================
-- CASE B — a CORRECTION to an all-zero weighing. Seven cells go blank.
-- This is the path nothing else tests: a blank must DELETE the stored row,
-- not leave the previous value standing and not write a zero.
-- ===========================================================================
insert into public.sheet_sync_outbox
  (sample_uuid, target_tab, event_kind, payload_revision, payload_hash, payload, projected_row)
values
  ('bbbbbbbb-0000-0000-0000-00000000000b', '8 DGM', 'correction', 2, repeat('b',64), '{}'::jsonb,
   :'nothing_row'::text[]);

do $$
declare got text; want text; n int;
begin
  select string_agg(result_key || '=' || display_text, '|' order by result_key), count(*)
    into got, n from public.sample_derived_results
   where sample_uuid = 'bbbbbbbb-0000-0000-0000-00000000000b';
  want := 'dpg_legacy_index=0.000000|total_retained_g=0.00';
  if got is distinct from want then
    raise exception E'CASE B left the wrong cells.\n  got:  %\n  want: %', got, want;
  end if;
  raise notice 'CASE B  ok  7 blanked cells DELETED, % remain (a measured zero and a calculated one)', n;
end $$;

-- The surviving rows were UPDATED in place, not duplicated: revision bumped.
do $$
declare r int;
begin
  select revision into r from public.sample_derived_results
   where sample_uuid='bbbbbbbb-0000-0000-0000-00000000000b' and result_key='total_retained_g';
  if r <> 2 then
    raise exception 'expected revision 2 after the correction, got %', r;
  end if;
  raise notice 'CASE B  ok  surviving cell updated in place, revision now %', r;
end $$;

-- ===========================================================================
-- CASE C — a stage with no computed columns must store nothing at all.
--
-- `4 Pellets`, NOT `7 Mash`. This case used to use Mash on the reasoning that
-- "its only system column is A", and that stopped being true with migration
-- 0029: Mash, Ground and Crumble each gained the sieve test and its nine
-- computed columns. The assertion would still have passed — the short
-- projected row below carries nothing for the trigger to store — so it would
-- have gone on reporting a clean result while testing a stage that no longer
-- had the property the case exists to check. Pellets has no `system` column
-- but A, so the loop body genuinely never executes.
-- ===========================================================================
insert into public.samples
  (id, sample_id, stage, prefix, collection_instant, collection_local_date, collection_local_time,
   created_by, registered_by, registered_at, capture_state)
values
  ('cccccccc-0000-0000-0000-00000000000c', 'AP-261029-01', 'pellets', 'AP',
   '2026-10-29T13:30:00Z', '2026-10-29', '09:30',
   'aaaaaaaa-0000-0000-0000-00000000000a',
   'aaaaaaaa-0000-0000-0000-00000000000a', now(), 'registered');
insert into public.sheet_sync_outbox
  (sample_uuid, target_tab, event_kind, payload_revision, payload_hash, payload, projected_row)
values
  ('cccccccc-0000-0000-0000-00000000000c', '4 Pellets', 'register', 1, repeat('c',64), '{}'::jsonb,
   array['','2026-10-29','09:30','x','','','','','','','']::text[]);

do $$
declare n int;
begin
  select count(*) into n from public.sample_derived_results
   where sample_uuid = 'cccccccc-0000-0000-0000-00000000000c';
  if n <> 0 then raise exception 'a stage with no computed columns stored % derived rows', n; end if;
  raise notice 'CASE C  ok  pellets stored 0 derived rows (its only system column is A)';
end $$;

-- ===========================================================================
-- CASE D — the same trigger, on a tab where the sieve test is only PART of
--          the row.
--
-- `6 Crumble` carries the sieve test alongside a roll gap, a moisture, a
-- durability index and a crumble size, and its computed block sits at AC..AK
-- rather than at Y..AG. Nothing in the trigger is told that: it reads
-- `stage_fields` for
-- whichever columns are `system` and indexes the projected row by letter. If
-- `column_letter_to_index` and the row's own width ever disagreed, this is
-- where a two-letter column past Z would land on the wrong slot — and the
-- DGM cases above could not show it, because they only ever exercise one tab.
-- ===========================================================================
insert into public.samples
  (id, sample_id, stage, prefix, collection_instant, collection_local_date, collection_local_time,
   created_by, registered_by, registered_at, capture_state)
values
  ('dddddddd-0000-0000-0000-00000000000d', 'CR-261029-01', 'crumble', 'CR',
   '2026-10-29T13:30:00Z', '2026-10-29', '09:30',
   'aaaaaaaa-0000-0000-0000-00000000000a',
   'aaaaaaaa-0000-0000-0000-00000000000a', now(), 'registered');
insert into public.sheet_sync_outbox
  (sample_uuid, target_tab, event_kind, payload_revision, payload_hash, payload, projected_row)
values
  ('dddddddd-0000-0000-0000-00000000000d', '6 Crumble', 'register', 1, repeat('d',64), '{}'::jsonb,
   -- A:AM, 39 cells. AC..AK (29..37, 1-indexed) hold the computed block;
   -- everything else is blank or an operator value.
   array[
     '','2026-10-29','09:30','Broiler starter','B-12','R. Singh',                       -- A..F
     '2.5',                                                                             -- G  roll gap
     '','8','10','abnt-standard-7',                                                     -- H..K settings
     '','','',                                                                          -- L..N moisture, PDI, size
     '','','','','','','','','','','','','','',                                         -- O..AB weights
     '512.00','3.821782','1472.6131','22.7723','55.0000','22.2277','4.520676','1.9','series-ratio-top-bound/pan-excluded',
     '',''                                                                              -- AL..AM
   ]::text[]);

do $$
declare got text; want text;
begin
  select string_agg(result_key || '=' || display_text, '|' order by result_key)
    into got
    from public.sample_derived_results
   where sample_uuid = 'dddddddd-0000-0000-0000-00000000000d';
  want := 'dgm_um=1472.6131|dpg_legacy_index=4.520676|fineness_module=3.821782|'
       || 'gsd=1.9|gsd_basis=series-ratio-top-bound/pan-excluded|'
       || 'total_retained_g=512.00|ui_average_pct=55.0000|ui_coarse_pct=22.7723|ui_fine_pct=22.2277';
  if got is distinct from want then
    raise exception E'CASE D stored the wrong cells.\n  got:  %\n  want: %', got, want;
  end if;
  raise notice 'CASE D  ok  crumble stored all 9 computed cells from AC..AK, past the Z boundary';
end $$;

do $$
declare v numeric;
begin
  select numeric_value into v from public.sample_derived_results
   where sample_uuid='dddddddd-0000-0000-0000-00000000000d' and result_key='dgm_um';
  if v is distinct from 1472.6131 then
    raise exception 'CASE D parsed dgm_um as %, expected 1472.6131', v;
  end if;
  raise notice 'CASE D  ok  a two-letter column parsed as a number, not as text';
end $$;

rollback;
