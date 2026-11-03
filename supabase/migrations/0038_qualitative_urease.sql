-- ===========================================================================
-- 0038 — `5 Extruded soya`: the urease test as the plant actually runs it,
--        and one column that was never going to be filled in.
--
-- Two changes to one tab, both asked for by the plant:
--
--   `Urease (pH rise)`        a 3-dp number, becomes `Qualitative urease`, a
--                             four-option controlled vocabulary read off a
--                             reference card. M stays M.
--   `Protein solubility (%)`  removed. N goes; `Tested by (QO)` and
--                             `Comments` slide left into N and O.
--
--   A:P (16 columns) -> A:O (15 columns).
--
-- ---------------------------------------------------------------------------
-- WHY THE UREASE COLUMN STOPS BEING A NUMBER
-- ---------------------------------------------------------------------------
-- The quantitative method needs a phosphate buffer, a urea buffer, a 30-
-- minute water bath at 30 degrees, a filtration and a pH meter, and reports
-- the pH RISE between the two tubes. What the mill runs is the visual test:
-- 0.2 g of meal wetted with urea-phenol red, read by eye against four
-- reference dishes. Any urease left in the soya splits the urea, the pH
-- climbs, and the indicator turns red exactly where it happened — so the
-- dish ends up speckled in proportion to how much raw enzyme survived
-- extrusion.
--
-- There is no number in that procedure. A `number` column asks the operator
-- to invent one, and the figure they would most likely reach for is the
-- reference band printed on the card — which is what the OTHER method would
-- have reported for a dish that looks like this, not what anybody measured
-- here. Storing it would put a reading nobody took on a quality record. So
-- the stored value is the assessment, the band is shown beside the
-- photograph as orientation, and the four codes are:
--
--     over_cooked                 no visible red           pH rise ~ 0.00
--     properly_cooked_slight      a few scattered specks    pH rise 0.05-0.10
--     properly_cooked_moderate    about a quarter red       pH rise 0.10-0.20
--     under_cooked                about half or more red    pH rise > 0.20
--
-- Source: Table 1, "Visual examination of soybean meal treated with
-- Urea-Phenol Red solution", supplied by Bounty Farm 2026-11-02. The two
-- middle options are both "Properly cooked" in that table and are separated
-- by activity, which is the honest reading of it: the difference between
-- them is how much enzyme is left, not whether the batch passes.
--
-- IT KEEPS NO `parameter_key`. `extruded_soya.urease` carries a draft limit
-- of 0.05 to 0.20 pH rise, unapproved and marked "Confirm with Polinutri". A
-- visual grade cannot be compared against a numeric bound, so a field that
-- cited the parameter would be a measurement the engine must forever return
-- `not_assessable` for — a link that looks like an assessment path and is
-- not one. Recorded only, which is what it is.
--
-- ---------------------------------------------------------------------------
-- NOTHING MEASURED IS LOST, checked against this project before this was
-- written rather than assumed:
--
--     select stage, field_key, count(*) from sample_measurements
--      where stage = 'extruded_soya'
--        and field_key in ('urease_ph_rise', 'protein_solubility_pct')
--      group by 1, 2;
--     -> 0 rows
--
-- The same query over `assessments` and `holds` also returns 0, and
-- `dgm_log_column_map` has no entry sourced from this tab. All four tables
-- carry a composite foreign key on (stage, field_key), so if any of that is
-- untrue on a project this is applied to, the deletes below FAIL rather than
-- cascade. That is the behaviour we want: it means somebody recorded a value
-- and this migration must not silently discard it.
--
-- `specification_parameters` keeps BOTH `extruded_soya.urease` and
-- `extruded_soya.protein_solubility`, for the reason 0033 kept
-- `crumble.pellet_durability_pdi`: there is no foreign key between the two
-- tables, both rows are drafts with no approved version, and the engine only
-- ever reaches a specification through a measurement citing its parameter
-- key — of which there are now none and can be none. Deleting somebody's
-- draft limit to tidy up a row that costs nothing would be the worse choice,
-- and the protein-solubility figures (70-85%) are the only written record
-- that the question was once asked.
--
-- ---------------------------------------------------------------------------
-- THE ORDER OF THE FIVE STATEMENTS IS LOAD-BEARING
-- ---------------------------------------------------------------------------
-- `unique (stage, column_letter)` was made DEFERRABLE INITIALLY DEFERRED by
-- 0033, but 0033's own warning stands: whether that helps depends on the
-- transaction the runner wraps the file in, and a migration whose
-- correctness turns on its runner's autocommit setting is a trap. So this is
-- written to be valid after EVERY statement, with no deferral needed —
-- vacate a letter before anything moves into it:
--
--     1. delete protein_solubility_pct   frees N
--     2. delete urease_ph_rise           frees M
--     3. tested_by_qo  O -> N            N is free
--     4. comments      P -> O            O is free
--     5. insert urease_qualitative at M  M is free
--
-- Stated as five narrow statements rather than as one whole-tab upsert,
-- which is where 0033 landed. That shape was right for 0033, which rewrote
-- four tabs — but a whole-tab upsert now would have to restate `sampled_by`
-- and `tested_by_qo` INCLUDING the `select_options` arrays 0036 gave them,
-- and getting one of those arrays slightly wrong would silently revert an
-- administrator-editable list while appearing to touch only column letters.
-- Two letters move. Move two letters.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1 and 2. The two columns that go, BEFORE anything slides into their
-- letters. Two statements rather than one with an `or`:
-- `tests/registryDatabaseContract.test.ts` parses these DELETEs to model the
-- seed's end state and refuses a WHERE it cannot read rather than skipping
-- it. A migration it cannot parse is a migration it cannot police.
-- ---------------------------------------------------------------------------
delete from public.stage_fields
 where stage = 'extruded_soya' and field_key = 'protein_solubility_pct';

delete from public.stage_fields
 where stage = 'extruded_soya' and field_key = 'urease_ph_rise';


-- ---------------------------------------------------------------------------
-- 3 and 4. The follow-up pair slides one column left.
--
-- `select_options` is deliberately NOT named here. 0036 made both of these
-- administrator-editable lists; this statement moves a letter and must not
-- have an opinion about their contents.
-- ---------------------------------------------------------------------------
update public.stage_fields
   set column_letter = 'N'
 where stage = 'extruded_soya' and field_key = 'tested_by_qo';

update public.stage_fields
   set column_letter = 'O'
 where stage = 'extruded_soya' and field_key = 'comments';


-- ---------------------------------------------------------------------------
-- 5. The new column, in the letter the old one vacated.
--
-- `select_options` holds the CODES, which is what `assert_measurement_in_
-- options` (0008:393) compares a stored `text_value` against. The labels
-- live in `src/forms/registry.ts` and are what reaches the sheet cell;
-- `tests/registryDatabaseContract.test.ts` compares the two lists.
--
-- No `unit`: a grade has no dimension, the way GSD has none. No
-- `parameter_key`, for the reason in the header.
-- ---------------------------------------------------------------------------
insert into public.stage_fields (
  stage, field_key, column_letter, sheet_header,
  field_type, section, requiredness,
  unit, unit_confirmed, parameter_key,
  hard_min, hard_max, implausible_above, decimals,
  adverse_value, applies_when_field, applies_when_values, select_options
) values
  ('extruded_soya', 'urease_qualitative', 'M', 'Qualitative urease', 'select', 'test_results', 'testing', null, null, null, null, null, null, null, null, null, null, array['over_cooked', 'properly_cooked_slight', 'properly_cooked_moderate', 'under_cooked']::text[]);


-- ---------------------------------------------------------------------------
-- 6. The tab is one column narrower.
-- ---------------------------------------------------------------------------
update public.stage_definitions
   set last_column = 'O', column_count = 15
 where stage = 'extruded_soya';


-- ---------------------------------------------------------------------------
-- 7. Prove it, in the same transaction that did it.
--
-- Three independent statements of the same expectation. Counting the rows
-- would pass on a tab holding fifteen columns lettered A..L, N..P; checking
-- the letters would pass on a tab whose `column_count` still said sixteen.
-- Neither alone is the claim being made, which is that the registry and the
-- database describe the same spreadsheet.
-- ---------------------------------------------------------------------------
do $$
declare
  v_bad text;
begin
  -- a. The declared width is the number of columns that exist.
  select format('%s declares %s columns and has %s', d.stage, d.column_count, c.n)
    into v_bad
    from public.stage_definitions d
    join (select stage, count(*) n from public.stage_fields group by stage) c
      on c.stage = d.stage
   where d.stage = 'extruded_soya' and c.n <> d.column_count;
  if v_bad is not null then
    raise exception 'BFF_0038_WIDTH: %', v_bad using errcode = '22023';
  end if;

  -- b. The letters are exactly A..O, with no gap and no duplicate. Expressed
  --    as a set difference in both directions, so a missing letter and a
  --    stray one are both caught — a count would see neither.
  select string_agg(x.letter, ', ' order by x.letter)
    into v_bad
    --    The parentheses around each arm are not decoration: EXCEPT and
    --    UNION bind equally and associate left, so without them this reads
    --    as ((A except B) union all C) except D and silently tests nothing.
    from (
      (select chr(64 + g) as letter from generate_series(1, 15) g
       except
       select column_letter from public.stage_fields where stage = 'extruded_soya')
      union all
      (select column_letter from public.stage_fields where stage = 'extruded_soya'
       except
       select chr(64 + g) from generate_series(1, 15) g)
    ) x;
  if v_bad is not null then
    raise exception 'BFF_0038_LETTERS: 5 Extruded soya letters disagree with A..O: %', v_bad
      using errcode = '22023';
  end if;

  -- c. The new column is a select that actually offers the four codes, and
  --    it is NOT linked to a specification parameter. The second half is the
  --    one worth asserting: a `parameter_key` added here later would make a
  --    visual grade look assessable, and nothing else in the system would
  --    object — the engine would simply return `not_assessable` forever and
  --    the screen would say so, which reads as a broken rule rather than as
  --    a deliberate absence.
  select format('urease_qualitative is %s with options %s and parameter_key %s',
                field_type, coalesce(array_to_string(select_options, '|'), '(none)'),
                coalesce(parameter_key, '(none)'))
    into v_bad
    from public.stage_fields
   where stage = 'extruded_soya' and field_key = 'urease_qualitative'
     and (field_type <> 'select'
          or parameter_key is not null
          or select_options is distinct from
             array['over_cooked', 'properly_cooked_slight',
                   'properly_cooked_moderate', 'under_cooked']::text[]);
  if v_bad is not null then
    raise exception 'BFF_0038_OPTIONS: %', v_bad using errcode = '22023';
  end if;
end
$$;
