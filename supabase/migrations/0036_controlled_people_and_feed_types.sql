-- ===========================================================================
-- 0036 — three free-text fields become controlled vocabularies.
--
-- `feed_type`, `sampled_by` and `tested_by_qo` were `text`. An operator typed
-- whatever they liked, and the database shows what that produced: the same
-- feed recorded as "Pellet" and "Pellets", a sampler as "Stefan" on one row
-- and "Live Form Check" on another, and a feed TYPE column holding the feed
-- FORM ("Crumble") on eight records. None of that is searchable, groupable or
-- comparable, which is most of what a quality record is for.
--
-- ---------------------------------------------------------------------------
-- WHY THE CODE IS THE LABEL
-- ---------------------------------------------------------------------------
-- Every other select in this schema stores a short code and writes a human
-- label to the sheet — `AM` becomes "AM after mill". These three store what
-- they display, because all three were free text until now and the database
-- already holds `Grower`, `Stefan` and `Kayla` as an operator typed them.
-- Codes equal to labels mean NOT ONE STORED MEASUREMENT HAS TO BE REWRITTEN:
-- every existing row is already a valid code, and every sheet cell keeps the
-- characters it has always had.
--
-- ---------------------------------------------------------------------------
-- WHY THE LISTS CARRY VALUES NOBODY WANTS
-- ---------------------------------------------------------------------------
-- The option lists include `Crumble`, `TEST OPERATOR` and six others that no
-- operator should ever pick again. They are in the list because
-- `assert_measurement_in_options` (0008) and `encodeEnum` in the TypeScript
-- both REFUSE a value the list does not contain — so without them, the eight
-- DGM records that say "Crumble" could never be written to the spreadsheet
-- again, and reopening one would show an empty dropdown over a record that
-- holds an answer.
--
-- They are a snapshot of what `sample_measurements` actually contained on
-- 2026-11-02, not a design. The registry marks each of them `retired`, which
-- is a UI concept and is deliberately NOT mirrored here: the database's job
-- is to say which values are LEGAL, and a retired value is legal — it is
-- simply not offered. Which values are offered is a question about a screen.
--
-- ---------------------------------------------------------------------------
-- WHAT IS NOT HERE
-- ---------------------------------------------------------------------------
-- `sieve_series` loses its place on the form in the same release and is NOT
-- touched below. It stays `select`, keeps its one option, keeps its column
-- and its heading, and the registry marks it `hidden` with a default: a
-- dropdown with one answer is not a question, but WHICH STACK a sample was
-- weighed on is still provenance worth recording, and a column deleted now
-- could not answer it the day a second series exists.
-- ===========================================================================

update public.stage_fields
   set field_type = 'select',
       select_options = array['Pre-starter', 'Starter', 'Grower', 'Finisher', 'Crumble', 'Pellet', 'Pellets', 'Broiler Starter (TEST)', 'TEST Broiler Starter', 'TEST BROILER STARTER CRUMBLE (E2E)', 'TEST LAYER MASH (E2E)']::text[]
 where field_key = 'feed_type';

update public.stage_fields
   set field_type = 'select',
       select_options = array['Stefan', 'Satesh', 'Kayla', 'TEST E2E (do not action)', 'TEST OPERATOR', 'TEST Quality Officer', 'TEST Quality Manager', 'Autosync Check', 'Live Form Check', 'Test Account (BFF QA)']::text[]
 where field_key = 'sampled_by';

update public.stage_fields
   set field_type = 'select',
       select_options = array['Stefan', 'Kayla']::text[]
 where field_key = 'tested_by_qo';


-- ---------------------------------------------------------------------------
-- Prove it, against the rows that exist rather than against the intention.
--
-- The whole point of the retired entries is that no stored measurement
-- becomes illegal. That is a claim about data, so it is checked against the
-- data — here, now, in the same transaction as the change. A row this leaves
-- behind would be invisible until the day somebody re-saved that sample.
-- ---------------------------------------------------------------------------

do $$
declare
  v_orphans text;
  v_untyped integer;
begin
  select string_agg(format('%s.%s = %L', m.stage, m.field_key, m.text_value), '; ')
    into v_orphans
  from (
    select distinct m.stage, m.field_key, m.text_value
    from public.sample_measurements m
    where m.field_key in ('feed_type', 'sampled_by', 'tested_by_qo')
      and m.text_value is not null
  ) m
  join public.stage_fields f on f.stage = m.stage and f.field_key = m.field_key
  where not (m.text_value = any (f.select_options));

  if v_orphans is not null then
    raise exception
      'These recorded values are not in the new option lists, so the records holding them could never be written to the spreadsheet again: %. Add them to the list as retired values rather than dropping them.',
      v_orphans using errcode = '23514';
  end if;

  -- And the lists arrived at all. A typo in a field_key would leave the
  -- column `text` with no options and the check above would pass vacuously,
  -- because a text field has nothing to be outside of.
  select count(*) into v_untyped
  from public.stage_fields f
  where f.field_key in ('feed_type', 'sampled_by', 'tested_by_qo')
    and (f.field_type <> 'select' or f.select_options is null);

  if v_untyped > 0 then
    raise exception '% of the three controlled fields did not become a select.', v_untyped;
  end if;
end;
$$;
