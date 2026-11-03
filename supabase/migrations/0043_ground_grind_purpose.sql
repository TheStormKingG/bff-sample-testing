-- ===========================================================================
-- 0043 — `2 Ground`: what is being ground, and what for.
--
-- Four changes to one tab, all from the Polinutri visit report of
-- 21 October 2026 and the plant's reading of it:
--
--   E  `Material or feed type`  free text -> four codes. The grind target is
--      not one number; it depends on the grain AND on what the meal is for.
--   I  `Hammer distance from screen (mm)`  RETIRED (hidden, not deleted).
--   J  `Mill rotational speed (rpm)`  NEW. What the report specifies on.
--   M  `Moisture (%) at BC`  REMOVED. The plant does not measure it.
--
-- The tab stays 39 columns wide, A:AM: one column leaves and one arrives.
-- Only letters I to M move; the sieve block from N is untouched.
--
-- ---------------------------------------------------------------------------
-- WHY THE PURPOSE IS ONE FIELD AND NOT TWO
-- ---------------------------------------------------------------------------
-- The report gives four grind targets: 950-1050 um for rice destined for
-- pelleted feed, 1200-1300 for corn for pelleted, 1550-1650 for corn for
-- mash, 1850-1950 for rice for mash. The thing it specifies on is the
-- COMBINATION, so the combination is what the form records. Two fields — a
-- grain and a destination — would need two applicability dimensions to
-- express one rule, and the engine scores specificity per dimension, so
-- "corn, for pellets" would be two half-matches rather than one match.
--
-- THE CODE IS NOT THE LABEL, for the reason `sampling_point` gives: a code
-- is what an approved limit is scoped by. Renaming "Corn for pelletized
-- feed" must never detach a sample from the rule that judged it.
--
-- `Corn` is kept as a RETIRED option. One ground sample exists, a voided
-- commissioning record, and that is what it holds. `encodeEnum` throws on a
-- code it does not know, so without it that record could never be projected
-- to the spreadsheet again.
--
-- ---------------------------------------------------------------------------
-- THE HAMMER DISTANCE IS HIDDEN, AND THE SCHEMA IS WHAT DECIDED THAT
-- ---------------------------------------------------------------------------
-- The plant asked for it to be replaced by the mill's rotational speed. It
-- cannot be deleted. One figure was recorded against it on that voided
-- record; `assessments` holds the decision made on that figure and is
-- append-only; `sample_measurements` will not release a row an assessment
-- cites. Removing the column would mean destroying a quality decision, which
-- this system refuses by design and rightly.
--
-- So it keeps its column, its heading and its one figure, and simply stops
-- being asked for — the same treatment `sieve_series` and `action_taken`
-- got. Its `parameter_key` goes and limit entry 7 is superseded, because a
-- limit on a field nobody will fill in is a permanent gap on the Limits
-- screen that no action can ever close.
--
-- Moisture at BC had no such obstacle: zero values were ever recorded, so it
-- is deleted outright. That asymmetry is not inconsistency — it is the rule
-- working. A column that has held a figure is part of the record; one that
-- never has is not.
--
-- ---------------------------------------------------------------------------
-- WHAT THIS DOES *NOT* DO
-- ---------------------------------------------------------------------------
-- It does not set the four grind limits. It cannot yet: the engine matches a
-- rule on material, feed type, sampling point and test method, and the grind
-- purpose is none of those. Material is null on a ground sample, and feed
-- type and test method are passed as hard-coded nulls at every call site, so
-- a rule scoped on either matches nothing — silently, for ever. Giving the
-- engine a dimension it can score the purpose on is the next migration, and
-- the four ranges are useless until it lands.
--
-- Four limit rows are superseded here rather than left standing: entries 8
-- and 10 (average particle size at AM and at BC), 12 (moisture at BC) and 29
-- (crumble average particle size). None describes a measurement this system
-- now takes.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 0. One more lifecycle move: `draft -> superseded`.
--
-- 0042 carried the retired 900-1200 um administrator band into a DRAFT on
-- each of the five sieve stages, so the figures would not be lost. The plant
-- has now read the Polinutri report and chosen its plant-specific figures
-- instead, which means those five drafts carry numbers nobody intends to
-- propose — and a draft can only move to `proposed` or `rejected`.
--
-- Neither fits. Nobody proposed these, so nobody can reject them: `rejected`
-- demands a `rejected_by`, and naming a person who made no such decision is
-- the same false attribution this codebase refuses elsewhere.
--
-- 0042's own header said leaving two inert drafts alone was the right trade
-- and that widening the guard a second time "to make a listing look neater"
-- would be a poor one — and that if drafts ever needed retiring for a real
-- reason, THAT would be the moment to add the move. This is that moment. A
-- draft holding figures the plant has decided against is not untidy, it is
-- loaded: it sits one proposal and one approval away from colouring every
-- results screen with a range contradicted by the plant's own specialist.
--
-- Restated verbatim from 0039 apart from the single added line.
-- ---------------------------------------------------------------------------
create or replace function public.tg_specification_versions_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception
      'A specification version is immutable and cannot be deleted. Supersede it instead.'
      using errcode = '23514';
  end if;

  if new.id is distinct from old.id
     or new.specification_id is distinct from old.specification_id
     or new.version is distinct from old.version
     or new.parameter_key is distinct from old.parameter_key
     or new.stage is distinct from old.stage
     or new.material_code is distinct from old.material_code
     or new.feed_type_code is distinct from old.feed_type_code
     or new.sampling_point is distinct from old.sampling_point
     or new.test_method is distinct from old.test_method
     or new.unit is distinct from old.unit
     or new.lower_bound is distinct from old.lower_bound
     or new.upper_bound is distinct from old.upper_bound
     or new.effective_from is distinct from old.effective_from
     or new.proposed_by is distinct from old.proposed_by
     or new.source_evidence is distinct from old.source_evidence
     or new.workbook_entry_no is distinct from old.workbook_entry_no
     or new.created_at is distinct from old.created_at
  then
    raise exception
      'Specification version %.% is immutable. Propose a new version instead of editing this one.',
      old.parameter_key, old.version
      using errcode = '23514';
  end if;

  -- Approval, once recorded, cannot be reassigned to somebody else.
  if old.approved_by is not null and new.approved_by is distinct from old.approved_by then
    raise exception 'The approver of a specification version cannot be changed'
      using errcode = '23514';
  end if;

  -- Only these lifecycle moves exist.
  if new.status is distinct from old.status then
    if not (
         (old.status = 'draft'    and new.status in ('proposed', 'rejected'))
      or (old.status = 'proposed' and new.status in ('approved', 'rejected'))
      or (old.status = 'approved' and new.status = 'superseded')
      -- An imported workbook row whose test the plant no longer performs, or
      -- whose figures describe a method it no longer uses. Not a rejection
      -- (nobody proposed it) and not a retired approval (it was never
      -- approved). Added by 0039; see that migration's header.
      or (old.status = 'reference_only' and new.status = 'superseded')
      -- A draft nobody will take forward, for the same reason: a rejection
      -- names a rejector, and nobody decided against a proposal that was
      -- never made. Added by 0043; see that migration's header.
      or (old.status = 'draft' and new.status = 'superseded')
    ) then
      raise exception 'A specification version cannot move from % to %', old.status, new.status
        using errcode = '23514';
    end if;
  end if;

  return new;
end;
$$;


-- ---------------------------------------------------------------------------
-- 0b. The five carried 900-1200 um drafts, withdrawn.
--
-- Superseded on every sieve stage, not just the two this migration touches.
-- The report contradicts the band everywhere it applies: 950-1050 or
-- 1200-1300 on ground depending on the grind, 1550-1950 for a grind destined
-- for mash, and for a finished pellet or crumble it gives a texture
-- distribution rather than a mean diameter at all.
-- ---------------------------------------------------------------------------
update public.specification_versions
   set status = 'superseded',
       effective_to = now(),
       decision_reason =
         'Withdrawn 2026-11-03. Carried from the retired administrator setting by 0042 as a '
         || 'placeholder for the generic 900-1200 um guidance (Auburn University 2025; '
         || 'Aviagen 2025). The Polinutri visit report of 2026-10-21 gives plant-specific '
         || 'figures that contradict it on every stage, and the plant has chosen those. Never '
         || 'proposed and never approved; it coloured nothing.'
 where status = 'draft' and lower_bound = 900 and upper_bound = 1200;


-- ---------------------------------------------------------------------------
-- 1. Vacate M, then shift the settings right one at a time.
--
-- `unique (stage, column_letter)` is deferrable since 0033, but 0040's rule
-- applies: a migration whose correctness depends on the runner's transaction
-- handling is a trap. Every statement below leaves a valid arrangement.
-- ---------------------------------------------------------------------------
delete from public.stage_fields
 where stage = 'ground' and field_key = 'moisture_pct_bc';

update public.stage_fields
   set column_letter = 'M'
 where stage = 'ground' and field_key = 'sieve_series';

update public.stage_fields
   set column_letter = 'L'
 where stage = 'ground' and field_key = 'sieve_vibration_min';

update public.stage_fields
   set column_letter = 'K'
 where stage = 'ground' and field_key = 'sieve_shaker_hz';


-- ---------------------------------------------------------------------------
-- 2. The new column, in the letter that is now free.
-- ---------------------------------------------------------------------------
insert into public.stage_fields (
  stage, field_key, column_letter, sheet_header,
  field_type, section, requiredness,
  unit, unit_confirmed, parameter_key,
  hard_min, hard_max, implausible_above, decimals,
  adverse_value, applies_when_field, applies_when_values, select_options
) values
  ('ground', 'mill_rpm', 'J', 'Mill rotational speed (rpm)', 'number', 'settings', 'registration', 'rpm', true, 'ground.mill_rpm', 0, null, 10000, 0, null, null, null, null);


-- ---------------------------------------------------------------------------
-- 3. The purpose becomes a controlled list; the hammer distance retires.
-- ---------------------------------------------------------------------------
update public.stage_fields
   set field_type = 'select',
       select_options = array['corn_pelleted', 'corn_mashed', 'rice_pelleted', 'rice_mashed', 'Corn']::text[]
 where stage = 'ground' and field_key = 'material_or_feed_type';

update public.stage_fields
   set requiredness = 'optional',
       parameter_key = null
 where stage = 'ground' and field_key = 'hammer_distance_mm';


-- ---------------------------------------------------------------------------
-- 4. The parameter the new column can one day carry a limit on.
--
-- Draft and figureless. The report gives 1,300 rpm for corn to pellets,
-- 2,300 for rice to pellets and 1,200 for either to mash — three figures
-- scoped on the grind purpose, which is exactly the dimension the engine
-- cannot yet see. Recording them as one range would be inventing a fourth
-- number nobody specified.
-- ---------------------------------------------------------------------------
insert into public.specifications (
  parameter_key, stage, title, workbook_sample_label, workbook_test_label,
  is_machine_setting, notes
) values
  ('ground.mill_rpm', 'ground', 'Mill rotational speed', 'Ground meal',
   'Mill rotational speed', true,
   'EQUIPMENT SETTING. Replaces ground.hammer_distance, superseded by 0043. The Polinutri '
   || 'visit report of 2026-10-21 gives 1,300 rpm for corn to pelleted feed, 2,300 for rice to '
   || 'pelleted feed and 1,200 for either to mash — three figures scoped on the grind purpose, '
   || 'which the engine cannot yet match on.');

insert into public.specification_versions (
  specification_id, version, parameter_key, stage, unit,
  lower_bound, upper_bound, status, effective_from, source_evidence
)
select s.id, 1, s.parameter_key, s.stage, 'rpm',
       null, null, 'draft', now(),
       'Authored 2026-11-03 by migration 0043, not imported. The measurement is recorded; no '
       || 'single limit applies to it, because the report specifies three figures by grind '
       || 'purpose.'
  from public.specifications s where s.parameter_key = 'ground.mill_rpm';


-- ---------------------------------------------------------------------------
-- 5. Four limit entries that no longer describe anything measured.
--
-- Each `reference_only -> superseded`, the move 0039 added for exactly this:
-- an imported workbook row whose test the plant no longer performs.
-- ---------------------------------------------------------------------------
update public.specification_versions
   set status = 'superseded',
       effective_to = now(),
       decision_reason =
         'Withdrawn 2026-11-03. The Hammer distance from screen column was retired by 0043 '
         || 'in favour of the mill rotational speed, which is what the Polinutri report of '
         || '2026-10-21 specifies on. The column is hidden rather than deleted because one '
         || 'figure was recorded against it, so this limit could never be measured again.'
 where parameter_key = 'ground.hammer_distance'
   and status = 'reference_only';

update public.specification_versions
   set status = 'superseded',
       effective_to = now(),
       decision_reason =
         'Withdrawn 2026-11-03. Average particle size on 2 Ground was an analyser reading '
         || 'typed into a column that 0029 replaced with the sieve test; it never held a '
         || 'value. The grind target is now scoped on the grind purpose and will be proposed '
         || 'against the computed DGM once the engine can match on it.'
 where parameter_key = 'ground.avg_particle_size'
   and status = 'reference_only';

update public.specification_versions
   set status = 'superseded',
       effective_to = now(),
       decision_reason =
         'Withdrawn 2026-11-03. The Moisture (%) at BC column was removed by 0043: the plant '
         || 'does not measure moisture on ground meal, and no value was ever recorded.'
 where parameter_key = 'ground.moisture'
   and status = 'reference_only';

update public.specification_versions
   set status = 'superseded',
       effective_to = now(),
       decision_reason =
         'Withdrawn 2026-11-03 at the plant''s instruction. Average particle size on 6 Crumble '
         || 'was an analyser reading whose column 0029 replaced with the sieve test. The '
         || 'Polinutri report of 2026-10-21 specifies crumble texture as a four-band size '
         || 'distribution rather than a mean diameter.'
 where parameter_key = 'crumble.avg_particle_size'
   and status = 'reference_only';


-- ---------------------------------------------------------------------------
-- 6. Prove it, in the same transaction that did it.
-- ---------------------------------------------------------------------------
do $$
declare
  v_bad text;
  v_n   integer;
begin
  -- a. The tab is still 39 columns, lettered A..AM with no gap and no
  --    duplicate. One column left and one arrived, so a count alone would
  --    pass on a migration that deleted the wrong one.
  select count(*) into v_n from public.stage_fields where stage = 'ground';
  if v_n <> 39 then
    raise exception 'BFF_0043_WIDTH: 2 Ground has % columns, expected 39', v_n
      using errcode = '22023';
  end if;

  select string_agg(x.letter, ', ' order by x.letter) into v_bad
    from (
      (select chr(64 + g) as letter from generate_series(1, 26) g
       union all select 'A' || chr(64 + g) from generate_series(1, 13) g
       except
       select column_letter from public.stage_fields where stage = 'ground')
      union all
      (select column_letter from public.stage_fields where stage = 'ground'
       except
       (select chr(64 + g) from generate_series(1, 26) g
        union all select 'A' || chr(64 + g) from generate_series(1, 13) g))
    ) x;
  if v_bad is not null then
    raise exception 'BFF_0043_LETTERS: 2 Ground letters disagree with A..AM: %', v_bad
      using errcode = '22023';
  end if;

  -- b. The five settings sit where they should, in order.
  select string_agg(f.column_letter || '=' || f.field_key, ' ' order by f.column_letter)
    into v_bad
    from public.stage_fields f
   where f.stage = 'ground' and f.section = 'settings';
  if v_bad <> 'H=mill_screen_size_mm I=hammer_distance_mm J=mill_rpm K=sieve_shaker_hz '
              'L=sieve_vibration_min M=sieve_series' then
    raise exception 'BFF_0043_SETTINGS: %', v_bad using errcode = '22023';
  end if;

  -- c. The purpose is a list, and it still contains the one value on file.
  --    Without the retired code, the voided commissioning record could never
  --    be projected to the spreadsheet again.
  if not exists (
    select 1 from public.stage_fields
     where stage = 'ground' and field_key = 'material_or_feed_type'
       and field_type = 'select' and 'Corn' = any (select_options)
       and 'corn_pelleted' = any (select_options)
  ) then
    raise exception 'BFF_0043_PURPOSE: the grind purpose is not a list, or dropped a stored value'
      using errcode = '22023';
  end if;

  select string_agg(m.text_value, ', ') into v_bad
    from public.sample_measurements m
    join public.stage_fields f on f.stage = m.stage and f.field_key = m.field_key
   where f.select_options is not null
     and m.text_value is not null
     and not (m.text_value = any (f.select_options));
  if v_bad is not null then
    raise exception
      'BFF_0043_ORPHAN: stored value(s) % are no longer a permitted option for their column',
      v_bad using errcode = '22023';
  end if;

  -- d. Nothing became assessable or approved, and the retired column no
  --    longer claims a parameter.
  select count(*) into v_n
    from public.specification_versions where status = 'approved' or approved_by is not null;
  if v_n <> 0 then
    raise exception 'BFF_0043_APPROVED: % version(s) approved; 0043 approves nothing', v_n
      using errcode = '22023';
  end if;

  if exists (
    select 1 from public.stage_fields
     where stage = 'ground' and field_key = 'hammer_distance_mm' and parameter_key is not null
  ) then
    raise exception 'BFF_0043_RETIRED: the hammer distance still claims a parameter'
      using errcode = '22023';
  end if;

  -- e. All four limit entries withdrew, each with a date.
  select string_agg(v.parameter_key, ', ') into v_bad
    from public.specification_versions v
   where v.parameter_key in ('ground.hammer_distance', 'ground.avg_particle_size',
                             'ground.moisture', 'crumble.avg_particle_size')
     and (v.status <> 'superseded' or v.effective_to is null);
  if v_bad is not null then
    raise exception 'BFF_0043_WITHDRAWN: % did not withdraw cleanly', v_bad using errcode = '22023';
  end if;
end
$$;
