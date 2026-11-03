-- ===========================================================================
-- 0047 — a sample knows whether any of its results is outside an approved
--        limit, so the Flagged screen can ask for those samples.
--
-- ---------------------------------------------------------------------------
-- WHY THIS IS NEEDED NOW
-- ---------------------------------------------------------------------------
-- The navigation is being reorganised around a single "Flagged" screen that
-- merges what were three separate lists — Holds, Awaiting results and
-- Reviews — and sorts them into three bands:
--
--   Critical  the material is on hold
--   High      a recorded result is outside an approved limit
--   Other     results are still to be entered, or a review is waiting
--
-- Critical and Other are already answerable from `samples`: `hold_flag` and
-- `capture_state` are columns on the row, so the list query can filter and
-- the counts can be head requests. HIGH IS NOT. A verdict lives in
-- `sample_measurements.assessment_result`, one row per field, and "does this
-- sample have any outside-limit result" is an EXISTS over a second table —
-- which the list query (PostgREST over `samples`) cannot express, and which
-- a per-row lookup would turn into one query per sample with a wrong count
-- at the bottom of the page.
--
-- ---------------------------------------------------------------------------
-- WHY A MAINTAINED COLUMN AND NOT A VIEW
-- ---------------------------------------------------------------------------
-- A view was the first instinct and is the tidier idea: derive it at read
-- time, nothing to keep in step. Two things argued against it here.
--
-- This schema has no views at all, so one would be the first — and a view
-- over an RLS-protected table needs `security_invoker = true` or it quietly
-- runs as its owner and becomes a way around `samples_select_viewers`. That
-- is a sharp edge to introduce for one screen.
--
-- `hold_flag` already solves exactly this problem in exactly this way: a
-- boolean on `samples`, refreshed by a trigger on the table that owns the
-- truth (`tg_refresh_sample_hold_flag`, 0004). Following the pattern that is
-- already here, already understood and already tested beats introducing a
-- second mechanism beside it.
--
-- SEVERITY ITSELF IS STILL NOT STORED. This column records one fact — "some
-- result on this sample is outside its limit" — which is the same kind of
-- fact as `hold_flag`. Which band that puts a sample in is decided when the
-- screen is drawn, so the ordering can change without a migration and
-- nobody can edit a sample to look less serious than it is.
--
-- ---------------------------------------------------------------------------
-- WHY THE TRIGGER IS ON `sample_measurements` AND THAT IS ENOUGH
-- ---------------------------------------------------------------------------
-- Checked rather than assumed: `reassess_parameter` is the ONLY function in
-- the schema that updates `sample_measurements` after the fact, and it does
-- update it — so when approving a limit re-judges an old measurement, this
-- trigger fires on that update and the flag follows. Entry goes through
-- `apply_measurement`, which inserts or updates the same table. There is no
-- third path.
--
-- Deliberately NOT triggered on `sample_derived_results`: a computed result
-- carries its own verdict (0041) but is not a measurement anyone attested
-- to, and `release_blockers` does not count one as a blocker either. Adding
-- it here would make the screen disagree with the release rules. If that is
-- wanted it is a decision, not an oversight.
-- ===========================================================================

alter table public.samples
  add column if not exists outside_limit_flag boolean not null default false;

comment on column public.samples.outside_limit_flag is
  'True while any sample_measurements row for this sample reads assessment_result = ''outside_limit''. Maintained by tg_refresh_outside_limit_flag; never written by hand. A cached EXISTS, not a severity: the Flagged screen decides what band it puts the sample in.';


-- ---------------------------------------------------------------------------
-- The refresh, shaped after `tg_refresh_sample_hold_flag` (0004).
--
-- Unconditional and idempotent, and it does NOT touch `revision`: that is
-- the optimistic-concurrency token a calling RPC is holding in the same
-- transaction, and bumping it from a side-effect trigger would invalidate
-- the expected_revision that RPC is about to check.
--
-- It also does NOT touch `disposition`. Raising a hold moves the material
-- decision, because a hold IS a decision to stop the material. A result
-- outside a limit is an observation; what to do about it is a person's call
-- (FR-009), and a trigger that set a disposition here would be making that
-- call automatically — which is the thing this application exists not to do.
-- ---------------------------------------------------------------------------
create or replace function public.tg_refresh_outside_limit_flag()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sample uuid := coalesce(new.sample_uuid, old.sample_uuid);
  v_outside boolean;
begin
  select exists (
    select 1 from public.sample_measurements m
    where m.sample_uuid = v_sample
      and m.assessment_result = 'outside_limit'
  ) into v_outside;

  update public.samples s
     set outside_limit_flag = v_outside
   where s.id = v_sample
     and s.outside_limit_flag is distinct from v_outside;

  return null;
end;
$$;

revoke all on function public.tg_refresh_outside_limit_flag() from public, anon, authenticated;

drop trigger if exists sample_measurements_refresh_outside_limit on public.sample_measurements;
create trigger sample_measurements_refresh_outside_limit
  after insert or update or delete on public.sample_measurements
  for each row execute function public.tg_refresh_outside_limit_flag();


-- ---------------------------------------------------------------------------
-- Backfill. The column defaults to false, which is a claim about every
-- existing sample, and it has to be made true of them before anything reads
-- it.
-- ---------------------------------------------------------------------------
update public.samples s
   set outside_limit_flag = exists (
     select 1 from public.sample_measurements m
     where m.sample_uuid = s.id and m.assessment_result = 'outside_limit'
   )
 where s.outside_limit_flag is distinct from exists (
     select 1 from public.sample_measurements m
     where m.sample_uuid = s.id and m.assessment_result = 'outside_limit'
   );


-- ---------------------------------------------------------------------------
-- Prove it, including the part a backfill cannot: that the trigger keeps up.
-- ---------------------------------------------------------------------------
do $$
declare
  v_wrong integer;
  v_probe uuid;
  v_field text;
  v_flag  boolean;
begin
  -- a. The backfill agrees with the source, for every sample.
  select count(*) into v_wrong
    from public.samples s
   where s.outside_limit_flag is distinct from exists (
     select 1 from public.sample_measurements m
     where m.sample_uuid = s.id and m.assessment_result = 'outside_limit'
   );
  if v_wrong <> 0 then
    raise exception 'BFF_0047_BACKFILL: % sample(s) disagree with their measurements', v_wrong
      using errcode = '22023';
  end if;

  -- b. THE TRIGGER ACTUALLY FIRES. A backfilled column and a dead trigger
  --    look identical the day they are created and diverge silently
  --    afterwards, so the flag is driven from a real measurement row and
  --    read back, then undone.
  select m.sample_uuid, m.field_key into v_probe, v_field
    from public.sample_measurements m
   where m.assessment_result is distinct from 'outside_limit'
   limit 1;

  if v_probe is null then
    raise notice 'BFF_0047: no measurement to probe with; trigger unproven.';
  else
    begin
      update public.sample_measurements
         set assessment_result = 'outside_limit'
       where sample_uuid = v_probe and field_key = v_field;

      select outside_limit_flag into v_flag from public.samples where id = v_probe;
      if v_flag is not true then
        raise exception
          'BFF_0047_TRIGGER: a measurement went outside_limit and the sample flag stayed %',
          coalesce(v_flag::text, '<null>') using errcode = '22023';
      end if;

      raise exception 'BFF_0047_ROLLBACK';
    exception
      when others then
        if sqlerrm <> 'BFF_0047_ROLLBACK' then raise; end if;
    end;

    -- c. And the rollback really restored it, so the probe left nothing.
    select count(*) into v_wrong
      from public.samples s
     where s.outside_limit_flag is distinct from exists (
       select 1 from public.sample_measurements m
       where m.sample_uuid = s.id and m.assessment_result = 'outside_limit'
     );
    if v_wrong <> 0 then
      raise exception 'BFF_0047_RESIDUE: the probe left % sample(s) wrong', v_wrong
        using errcode = '22023';
    end if;
  end if;
end
$$;
