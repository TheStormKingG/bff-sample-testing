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
-- CASE C — the other seven stages must store nothing at all.
-- ===========================================================================
insert into public.samples
  (id, sample_id, stage, prefix, collection_instant, collection_local_date, collection_local_time,
   created_by, registered_by, registered_at, capture_state)
values
  ('cccccccc-0000-0000-0000-00000000000c', 'MS-261029-01', 'mash', 'MS',
   '2026-10-29T13:30:00Z', '2026-10-29', '09:30',
   'aaaaaaaa-0000-0000-0000-00000000000a',
   'aaaaaaaa-0000-0000-0000-00000000000a', now(), 'registered');
insert into public.sheet_sync_outbox
  (sample_uuid, target_tab, event_kind, payload_revision, payload_hash, payload, projected_row)
values
  ('cccccccc-0000-0000-0000-00000000000c', '7 Mash', 'register', 1, repeat('c',64), '{}'::jsonb,
   array['','2026-10-29','09:30','x','','','','','','','','','']::text[]);

do $$
declare n int;
begin
  select count(*) into n from public.sample_derived_results
   where sample_uuid = 'cccccccc-0000-0000-0000-00000000000c';
  if n <> 0 then raise exception 'a non-DGM stage stored % derived rows', n; end if;
  raise notice 'CASE C  ok  mash stored 0 derived rows (its only system column is A)';
end $$;

rollback;
