-- ===========================================================================
-- 0046 — sampling frequency leaves the system.
--
-- ---------------------------------------------------------------------------
-- WHAT IS BEING REMOVED, AND WHY IT WAS HERE
-- ---------------------------------------------------------------------------
-- `stage_definitions` carried two columns from 0002: `frequency`, the cadence
-- the workbook's `Read me` tab stated for a stage, and `frequency_approved`,
-- false wherever that cadence read "To set" — which was five of the eight
-- stages. A CHECK kept the pair honest, so a frequency the workbook had not
-- set could never be stored as approved.
--
-- Everything built on them was a refusal. The forms printed "How often: not
-- decided yet" instead of a rule nobody had approved; the home screen and the
-- dashboard carried a marker per affected stage; the reports page withheld a
-- sampling-adherence percentage and said which stages and why; and
-- `system_config.sampling_frequency_kpi_enabled` stayed false so the KPI
-- could not be switched on by accident. All of it existed to stop the system
-- claiming compliance against a target the plant had never set (FR-020,
-- risk R-08, open decision D-04).
--
-- Bounty Farm removed sampling frequency from the system on 2026-11-03. How
-- often to sample is a process instruction the plant gives its operators; it
-- is not a figure this application records, tracks, or measures adherence
-- against. With the target gone, adherence is a ratio with no denominator and
-- the warnings describe a gap in a feature that no longer exists.
--
-- ---------------------------------------------------------------------------
-- WHY THE COLUMNS ARE DROPPED RATHER THAN LEFT
-- ---------------------------------------------------------------------------
-- These are not a quality record. No sample, measurement or assessment refers
-- to them, no function reads them, and no decision was ever made on them --
-- checked before writing this, not assumed. They are reference text copied
-- from a spreadsheet tab, and the spreadsheet still says what it says.
--
-- That is the opposite of a withdrawn specification version, which is kept
-- for ever precisely BECAUSE something may have been decided under it. A
-- column nothing ever decided anything with is just a column.
--
-- `tests/registryDatabaseContract.test.ts` compares this table against the
-- registry column by column, so the two must move together or that gate
-- fails. It is what makes this migration and the registry edit one change.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. The constraint first: it names both columns, so it cannot outlive them.
-- ---------------------------------------------------------------------------
alter table public.stage_definitions
  drop constraint if exists stage_definitions_unset_frequency_not_approved;

alter table public.stage_definitions drop column if exists frequency;
alter table public.stage_definitions drop column if exists frequency_approved;


-- ---------------------------------------------------------------------------
-- 2. The setting that existed to keep the KPI switched off.
--
-- A flag whose only purpose was to disable a measure that no longer exists is
-- not a safety feature, it is a loose end: the next person to read it would
-- reasonably ask what turning it on would do, and the answer is nothing.
-- ---------------------------------------------------------------------------
delete from public.system_config where key = 'sampling_frequency_kpi_enabled';


-- ---------------------------------------------------------------------------
-- 3. Prove it, in the same transaction.
-- ---------------------------------------------------------------------------
do $$
declare
  v_n   integer;
  v_bad text;
begin
  -- a. Both columns gone, and the stage rows still all present. A DROP COLUMN
  --    cannot remove rows, but asserting the count makes the failure mode of
  --    a mistyped statement -- dropping the wrong thing -- visible here.
  select count(*) into v_n
    from information_schema.columns
   where table_schema = 'public' and table_name = 'stage_definitions'
     and column_name in ('frequency', 'frequency_approved');
  if v_n <> 0 then
    raise exception 'BFF_0046_COLUMNS: % frequency column(s) still on stage_definitions', v_n
      using errcode = '22023';
  end if;

  select count(*) into v_n from public.stage_definitions;
  if v_n <> 8 then
    raise exception 'BFF_0046_STAGES: % stage definitions remain; expected 8', v_n
      using errcode = '22023';
  end if;

  -- b. The config row is gone.
  if exists (select 1 from public.system_config where key = 'sampling_frequency_kpi_enabled') then
    raise exception 'BFF_0046_CONFIG: sampling_frequency_kpi_enabled is still present'
      using errcode = '22023';
  end if;

  -- c. NOTHING ELSE refers to the dropped columns. A view or function left
  --    reading one would not fail until it ran, which for a report could be
  --    weeks later and in front of whoever asked for the report.
  select string_agg(p.proname, ', ') into v_bad
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    join pg_language l on l.oid = p.prolang
   where n.nspname = 'public' and l.lanname = 'plpgsql' and p.prokind = 'f'
     and pg_get_functiondef(p.oid) ~ 'frequency_approved';
  if v_bad is not null then
    raise exception 'BFF_0046_DANGLING: % still refers to frequency_approved', v_bad
      using errcode = '22023';
  end if;

  select string_agg(table_name, ', ') into v_bad
    from information_schema.views
   where table_schema = 'public' and view_definition ~ 'frequency_approved';
  if v_bad is not null then
    raise exception 'BFF_0046_DANGLING_VIEW: % still refers to frequency_approved', v_bad
      using errcode = '22023';
  end if;

  -- d. The sieve shaker frequency is a DIFFERENT THING and must survive. It
  --    is a measured quantity in hertz on five tabs -- how fast the shaker
  --    runs -- and shares only the word. Dropping it while removing a
  --    sampling cadence would delete a real measurement, so it is asserted
  --    rather than trusted to a careful reading.
  select count(*) into v_n
    from public.stage_fields
   where field_key = 'sieve_shaker_hz';
  if v_n < 1 then
    raise exception
      'BFF_0046_SHAKER: the sieve shaker frequency columns are gone; those are a measurement in Hz, not a sampling cadence'
      using errcode = '22023';
  end if;
end
$$;
