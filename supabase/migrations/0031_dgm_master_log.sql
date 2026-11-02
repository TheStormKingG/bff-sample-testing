-- ===========================================================================
-- 0031 — the `8 DGM` tab becomes a MASTER LOG of every sieve test.
--
-- The sieve test moved inline onto `2 Ground`, `6 Crumble` and `7 Mash` in
-- 0029, and `8 DGM` stopped receiving rows. This gives it a second life: a
-- single granulometry log across the plant, written automatically, alongside
-- the row that already goes to the sample's own tab.
--
-- ---------------------------------------------------------------------------
-- THE ASSUMPTION THIS BREAKS, WHICH WAS WRITTEN DOWN
-- ---------------------------------------------------------------------------
-- Every piece of delivery state in this system is keyed by the SAMPLE, on a
-- stated invariant. 0021 says it in the header of
-- `rpc_read_sample_projected_rows`:
--
--     "A sample has one stage, so every projected_row in the result has the
--      same width and no per-stage filter is needed; the sample's own stage
--      is the only one it can have."
--
-- That stops being true the moment one sample writes to two tabs, and the
-- consequences are not cosmetic. `rpc_read_sample_sync_state` returns "the
-- row this sample was confirmed on", and the worker uses that number to
-- decide WHICH ROW TO OVERWRITE. A Ground sample confirmed on row 5 of
-- `2 Ground` would have had row 5 of `8 DGM` offered as its target: the first
-- write would look like a success and the second would overwrite an unrelated
-- record, in a file nobody diffs.
--
-- So the key becomes (sample, TARGET STAGE) everywhere delivery state is
-- read, and `sheet_sync_outbox` grows the column that makes that askable.
--
-- ---------------------------------------------------------------------------
-- WHY A TRIGGER AND NOT A SECOND CALL FROM THE EDGE FUNCTION
-- ---------------------------------------------------------------------------
-- Same reasoning as `tg_record_derived_results` in 0025. The master-log row
-- must be enqueued in the SAME transaction as the sample, or a failure leaves
-- a sieve test recorded on one tab and absent from the log that exists to be
-- complete. Hanging it on the outbox insert covers registration, correction
-- and any future path that projects a row — rather than one line in each,
-- which is how a path gets missed.
--
-- ---------------------------------------------------------------------------
-- WHAT IT DOES NOT DO
-- ---------------------------------------------------------------------------
-- It does not compute anything. The master-log row is a RE-PROJECTION of
-- cells the source row already carries, mapped column by column through
-- `stage_fields`, so the figures on `8 DGM` are the same strings as the
-- figures on `2 Ground` by construction and cannot drift from them.
--
-- It does not fire for a sample with no sieve test: the guard is that the
-- source row's computed `DGM (µm)` cell is non-blank, which is true only when
-- the whole stack was weighed and the derivation ran.
--
-- It does not recurse: a `dgm_log` event never produces another.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. Which tab an outbox event is FOR.
--
-- Until now this was always the sample's own stage, read by joining
-- `samples`. A master-log row is the first event whose tab differs from its
-- sample's, so the queue has to carry it rather than derive it.
-- ---------------------------------------------------------------------------

alter table public.sheet_sync_outbox
  add column if not exists target_stage public.sample_stage;

update public.sheet_sync_outbox o
   set target_stage = s.stage
  from public.samples s
 where s.id = o.sample_uuid
   and o.target_stage is null;

-- Defaulted by trigger rather than by DEFAULT, because the value comes from
-- another row. Every existing caller — `rpc_register_sample`,
-- `rpc_update_results`, `rpc_set_disposition` — inserts without this column
-- and keeps working untouched.
create or replace function public.tg_outbox_default_target_stage()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.target_stage is null then
    select s.stage into new.target_stage
    from public.samples s
    where s.id = new.sample_uuid;
  end if;
  return new;
end;
$$;

revoke all on function public.tg_outbox_default_target_stage() from public, anon, authenticated;

drop trigger if exists sheet_sync_outbox_default_target_stage on public.sheet_sync_outbox;
create trigger sheet_sync_outbox_default_target_stage
  before insert on public.sheet_sync_outbox
  for each row
  execute function public.tg_outbox_default_target_stage();

alter table public.sheet_sync_outbox
  alter column target_stage set not null;

comment on column public.sheet_sync_outbox.target_stage is
  'The tab this event writes to. Equals the sample''s own stage for every event except a dgm_log master-log row, whose sample lives on another tab.';

create index if not exists sheet_sync_outbox_sample_target_idx
  on public.sheet_sync_outbox (sample_uuid, target_stage);


-- ---------------------------------------------------------------------------
-- 2. The new kind has a client name.
--
-- `outbox_kind_to_client` RAISES on anything unmapped — deliberately, so a
-- label added to the enum and forgotten here fails loudly at the claim rather
-- than reaching the worker as a surprise string.
-- ---------------------------------------------------------------------------

create or replace function public.outbox_kind_to_client(p_kind public.sheet_sync_event_kind)
returns text
language plpgsql
immutable
set search_path = ''
as $$
begin
  case p_kind
    when 'register'    then return 'sample_registered';
    when 'results'     then return 'results_recorded';
    when 'correction'  then return 'correction_applied';
    when 'disposition' then return 'review_recorded';
    when 'dgm_log'     then return 'dgm_master_log';
    else
      raise exception 'BFF_UNMAPPED_OUTBOX_KIND: % has no client kind', p_kind
        using errcode = '22023';
  end case;
end;
$$;


-- ---------------------------------------------------------------------------
-- 3. Delivery state, keyed by (sample, target stage).
--
-- Both are dropped and recreated rather than `create or replace`d: the
-- signature changes, and this project requires the drop to be explicit so the
-- ACL is restated rather than silently inherited.
-- ---------------------------------------------------------------------------

drop function if exists public.rpc_read_sample_sync_state(uuid);

create function public.rpc_read_sample_sync_state(
  p_sample_uuid  uuid,
  p_target_stage public.sample_stage default null
)
returns table (
  sample_uuid            uuid,
  stage                  public.sample_stage,
  confirmed_revision     integer,
  confirmed_row_number   integer,
  confirmed_at           timestamptz,
  confirmed_payload_hash text
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    s.id,
    s.stage,
    latest.payload_revision,
    latest.external_row_number,
    latest.confirmed_at,
    latest.confirmed_payload_hash
  from public.samples s
  join lateral (
    select o.payload_revision, o.external_row_number, o.confirmed_at,
           o.confirmed_payload_hash
    from public.sheet_sync_outbox o
    where o.sample_uuid = s.id
      and o.state = 'confirmed'
      -- THE ROW NUMBER IS PER TAB. Null means "the sample's own tab", which
      -- is what every caller written before the master log meant by it.
      and o.target_stage = coalesce(p_target_stage, s.stage)
    order by o.payload_revision desc, o.confirmed_at desc
    limit 1
  ) as latest on true
  where s.id = p_sample_uuid;
$$;

comment on function public.rpc_read_sample_sync_state(uuid, public.sample_stage) is
  'The highest revision CONFIRMED for one sample on one tab, with the row it landed on. Keyed by target stage because a sieve test writes to its own tab and to the DGM master log, and the row numbers are unrelated.';

revoke all on function public.rpc_read_sample_sync_state(uuid, public.sample_stage)
  from public, anon, authenticated;
grant execute on function public.rpc_read_sample_sync_state(uuid, public.sample_stage)
  to service_role;


drop function if exists public.rpc_read_sample_projected_rows(uuid);

create function public.rpc_read_sample_projected_rows(
  p_sample_uuid  uuid,
  p_target_stage public.sample_stage default null
)
returns table (
  payload_revision integer,
  was_confirmed    boolean,
  projected_row    text[]
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    o.payload_revision,
    o.state = 'confirmed',
    o.projected_row
  from public.sheet_sync_outbox o
  join public.samples s on s.id = o.sample_uuid
  where o.sample_uuid = p_sample_uuid
    and o.last_attempt_at is not null
    -- 0021's header said no per-stage filter was needed because "a sample has
    -- one stage". A sample now projects to two tabs with DIFFERENT WIDTHS, so
    -- mixing them would hand the writer a 40-cell row to compare against a
    -- 35-cell one and call a correct row a hand-edit.
    and o.target_stage = coalesce(p_target_stage, s.stage)
  order by o.payload_revision desc, o.created_at desc;
$$;

comment on function public.rpc_read_sample_projected_rows(uuid, public.sample_stage) is
  'Every row this system has projected for one sample ON ONE TAB in an outbox event claimed at least once, newest first, with the confirmed one flagged.';

revoke all on function public.rpc_read_sample_projected_rows(uuid, public.sample_stage)
  from public, anon, authenticated;
grant execute on function public.rpc_read_sample_projected_rows(uuid, public.sample_stage)
  to service_role;


-- ---------------------------------------------------------------------------
-- 4. The claim hands the worker the TARGET stage.
--
-- One line of the body changes — `c.target_stage` instead of `s.stage` — and
-- it is the line that decides which tab the worker verifies, locates in and
-- writes to.
-- ---------------------------------------------------------------------------

drop function if exists public.rpc_claim_outbox_batch(text, text, bigint, integer);

create function public.rpc_claim_outbox_batch(
  p_workbook_key text,
  p_owner        text,
  p_fence        bigint,
  p_limit        integer
)
returns table (
  id                   uuid,
  sample_uuid          uuid,
  sample_id            text,
  stage                public.sample_stage,
  kind                 text,
  revision             integer,
  payload_hash         text,
  "row"                text[],
  state                text,
  attempts             integer,
  next_attempt_at      timestamptz,
  reconcile_first      boolean,
  last_error           text,
  confirmed_row_number integer,
  confirmed_at         timestamptz,
  created_at           timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_until timestamptz;
begin
  perform public.assert_sheet_lease(p_workbook_key, p_owner, p_fence);

  select l.leased_until into v_until
  from public.sheet_sync_worker_lease l
  where l.workbook_key = p_workbook_key;

  return query
  with due as (
    select o.event_id
    from public.sheet_sync_outbox o
    where (
            (o.state in ('pending', 'failed') and o.next_retry_at <= now())
            or (o.state = 'leased' and o.leased_until is not null and o.leased_until <= now())
          )
    order by o.next_retry_at, o.created_at
    limit greatest(coalesce(p_limit, 0), 0)
    for update skip locked
  ),
  claimed as (
    update public.sheet_sync_outbox o
       set state           = 'leased',
           lease_holder    = p_owner,
           leased_until    = v_until,
           fence_token     = p_fence,
           last_attempt_at = now()
     where o.event_id in (select event_id from due)
    returning o.*
  )
  select c.event_id, c.sample_uuid, s.sample_id, c.target_stage,
         public.outbox_kind_to_client(c.event_kind),
         c.payload_revision, c.payload_hash, c.projected_row,
         public.outbox_state_to_client(c.state),
         c.attempt_count, c.next_retry_at, c.reconcile_first, c.last_error,
         c.external_row_number, c.confirmed_at, c.created_at
  from claimed c
  join public.samples s on s.id = c.sample_uuid
  order by c.next_retry_at, c.created_at;
end;
$$;

revoke all on function public.rpc_claim_outbox_batch(text, text, bigint, integer)
  from public, anon, authenticated;
grant execute on function public.rpc_claim_outbox_batch(text, text, bigint, integer)
  to service_role;


-- ---------------------------------------------------------------------------
-- 5. The derived-results trigger ignores master-log rows.
--
-- It reads a stage's `system` columns out of the projected row by column
-- letter. A master-log row is DGM-shaped while its sample is a Ground one, so
-- without this it would read AC..AK out of a row whose computed block is at
-- Y..AG — nine cells of the wrong thing, written over results that were
-- already correct. The figures are stored from the source row; there is
-- nothing here for the copy to add.
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

  -- A master-log row is a re-projection of figures already stored from the
  -- event that produced it. See the block comment above.
  if new.event_kind = 'dgm_log' then
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

    if v_cell is null or btrim(v_cell) = '' then
      delete from public.sample_derived_results
      where sample_uuid = new.sample_uuid and result_key = v_field.field_key;
      continue;
    end if;

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

revoke all on function public.tg_record_derived_results() from public, anon, authenticated;


-- ---------------------------------------------------------------------------
-- 6. Which column of `8 DGM` is fed by which column of the source tab.
--
-- Everything matches by FIELD KEY. These five do not, and every one of them
-- is a name the two tabs chose differently for the same thing:
--
--   `8 DGM` keeps three legacy setting keys from when the tab was thought to
--   be about milling (0028 re-headed them; 0029 declined to rename the keys
--   over a stage verified against the lab's own workbook), and it calls the
--   feed and the batch by the short names the other tabs use for them —
--   except `2 Ground`, which calls them "Material or feed type" and "Batch or
--   bin no.".
--
-- Held as a TABLE rather than a CASE so the mapping is inspectable, testable
-- and extendable without rewriting a function body.
-- ---------------------------------------------------------------------------

create table if not exists public.dgm_log_column_map (
  source_stage    public.sample_stage not null,
  dgm_field_key   text not null,
  source_field_key text not null,
  primary key (source_stage, dgm_field_key),
  -- The SOURCE side is a real foreign key: a mapping naming a column the
  -- source tab does not have would silently project a blank. The DGM side
  -- cannot be one — `stage_fields`'s primary key is (stage, field_key), so
  -- there is no single-column key to reference — and is checked by the
  -- assertion after the insert below instead.
  constraint dgm_log_column_map_source_fk
    foreign key (source_stage, source_field_key)
      references public.stage_fields (stage, field_key)
);

comment on table public.dgm_log_column_map is
  'The five columns whose name differs between a source tab and 8 DGM. Everything else is copied by matching field_key.';

insert into public.dgm_log_column_map (source_stage, dgm_field_key, source_field_key) values
  ('ground',  'feed_type',        'material_or_feed_type'),
  ('ground',  'batch_no',         'batch_or_bin_no'),
  ('ground',  'mill_rpm',         'durability_tester_rpm'),
  ('ground',  'mill_hz_position', 'sieve_shaker_hz'),
  ('ground',  'grind_time',       'sieve_vibration_min'),
  ('crumble', 'mill_rpm',         'durability_tester_rpm'),
  ('crumble', 'mill_hz_position', 'sieve_shaker_hz'),
  ('crumble', 'grind_time',       'sieve_vibration_min'),
  ('mash',    'mill_rpm',         'durability_tester_rpm'),
  ('mash',    'mill_hz_position', 'sieve_shaker_hz'),
  ('mash',    'grind_time',       'sieve_vibration_min')
on conflict (source_stage, dgm_field_key) do update
  set source_field_key = excluded.source_field_key;

-- The DGM side, checked rather than constrained. A typo here would project a
-- blank into a column of the master log and nothing would say so.
do $$
declare v_missing text;
begin
  select string_agg(m.dgm_field_key, ', ') into v_missing
  from public.dgm_log_column_map m
  where not exists (
    select 1 from public.stage_fields f
    where f.stage = 'dgm' and f.field_key = m.dgm_field_key
  );
  if v_missing is not null then
    raise exception 'BFF_DGM_LOG_MAP: 8 DGM has no column named %', v_missing
      using errcode = '22023';
  end if;
end $$;

alter table public.dgm_log_column_map enable row level security;
revoke all on public.dgm_log_column_map from anon, authenticated;
grant select on public.dgm_log_column_map to service_role;


-- ---------------------------------------------------------------------------
-- 7. The master-log row itself.
-- ---------------------------------------------------------------------------

create or replace function public.tg_enqueue_dgm_master_log()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_stage    public.sample_stage;
  v_dgm_col  integer;
  v_row      text[];
  v_tab      text;
begin
  -- A master-log row never produces another.
  if new.event_kind = 'dgm_log' then
    return new;
  end if;
  if new.projected_row is null then
    return new;
  end if;

  v_stage := new.target_stage;

  -- `8 DGM` logs the other tabs; it does not log itself.
  if v_stage = 'dgm' then
    return new;
  end if;

  -- Does this tab carry a sieve test at all, and did this row produce a
  -- result? `dgm_um` is `system`, so it is non-blank only when the whole
  -- stack was weighed and the derivation ran. A sample registered at the mill
  -- before the lab weighed anything therefore enqueues nothing, which is the
  -- ordinary case on all three tabs.
  select public.column_letter_to_index(f.column_letter) into v_dgm_col
  from public.stage_fields f
  where f.stage = v_stage and f.field_key = 'dgm_um';

  if v_dgm_col is null then
    return new;
  end if;
  if new.projected_row[v_dgm_col] is null
     or btrim(new.projected_row[v_dgm_col]) = '' then
    return new;
  end if;

  -- Re-project: for every column of `8 DGM`, in its own order, take the cell
  -- the source row holds for the same field — through the alias map where the
  -- two tabs name it differently. A DGM column the source tab has no field
  -- for yields '', which is the honest rendering of "this tab does not record
  -- that".
  select array_agg(
           coalesce(new.projected_row[public.column_letter_to_index(src.column_letter)], '')
           order by public.column_letter_to_index(d.column_letter)
         )
    into v_row
  from public.stage_fields d
  left join public.dgm_log_column_map m
         on m.source_stage = v_stage and m.dgm_field_key = d.field_key
  left join public.stage_fields src
         on src.stage = v_stage
        and src.field_key = coalesce(m.source_field_key, d.field_key)
  where d.stage = 'dgm';

  if v_row is null then
    return new;
  end if;

  select sd.sheet_tab into v_tab
  from public.stage_definitions sd
  where sd.stage = 'dgm';

  insert into public.sheet_sync_outbox
    (sample_uuid, target_stage, target_tab, event_kind,
     payload_revision, payload_hash, payload, projected_row)
  values
    (new.sample_uuid, 'dgm', v_tab, 'dgm_log',
     new.payload_revision,
     -- The hash is over this row, not the source's: it identifies what will
     -- be written to `8 DGM`, and the two rows are different renderings.
     -- Unit separator as the delimiter, so a cell containing a comma or a tab
     -- cannot make two different rows hash alike.
     encode(sha256(convert_to(array_to_string(v_row, E'\u001f'), 'UTF8')), 'hex'),
     new.payload,
     v_row)
  on conflict (sample_uuid, event_kind, payload_revision) do nothing;

  return new;
end;
$$;

comment on function public.tg_enqueue_dgm_master_log() is
  'Writes a second outbox row to 8 DGM whenever a sieve test is recorded on another tab, re-projecting the same cells into DGM column order. Computes nothing: the figures are the source row''s own strings.';

revoke all on function public.tg_enqueue_dgm_master_log() from public, anon, authenticated;

drop trigger if exists sheet_sync_outbox_dgm_master_log on public.sheet_sync_outbox;
create trigger sheet_sync_outbox_dgm_master_log
  after insert on public.sheet_sync_outbox
  for each row
  execute function public.tg_enqueue_dgm_master_log();
