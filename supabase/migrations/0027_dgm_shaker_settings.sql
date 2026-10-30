--
-- The two sieve-test settings become numbers with sensible starting points.
--
-- WHAT CHANGED AND WHY. Two DGM settings columns were seeded as free text,
-- copied from a workbook whose headers describe how the product was MILLED:
--
--   H  "Mill Hz or position"  ->  the frequency the SIEVE SHAKER ran at
--   I  "Grind time"           ->  how long the stack ran in the VIBRATOR
--
-- Neither is a property of milling. Both are properties of the sieve test
-- itself, both are numbers, and both take the same value on nearly every run
-- (8 Hz for 10 minutes), which the form now offers as an editable starting
-- point rather than asking an operator to retype each time.
--
-- Typing them lets the existing machinery do its work: a number is range
-- checked, stored in `numeric_value` rather than `text_value`, and carries a
-- unit, so "8" can no longer be recorded as "eight" or "8hz" and mean nothing
-- to anything reading it back.
--
-- THE HEADERS ARE NOT TOUCHED. `sheetHeader` must match the live workbook
-- character for character or `verifyWorkbook()` fails closed and NO DGM write
-- succeeds. Re-heading columns G, H and I is a workbook edit that has to land
-- first; until it does, the registry keeps the workbook's words and the form
-- shows the operator's. `FieldDef` allows exactly this, and says so.
--
-- NO BACKFILL. `text_value` is where these were stored for any record written
-- before this migration. There is one DGM sample and both columns are blank on
-- it, so nothing needs converting; a non-empty text value would need a human
-- to decide what "position 3" means as a frequency, which is not a thing a
-- migration should guess.
--

update public.stage_fields
   set field_type       = 'number',
       unit             = 'Hz',
       hard_min         = 0,
       implausible_above = 200,
       decimals         = 0
 where stage = 'dgm' and field_key = 'mill_hz_position';

update public.stage_fields
   set field_type       = 'number',
       unit             = 'min',
       hard_min         = 0,
       implausible_above = 240,
       decimals         = 0
 where stage = 'dgm' and field_key = 'grind_time';

-- Both rows must exist. An UPDATE that matches nothing is a silent no-op, and
-- a silent no-op here would leave the database disagreeing with the registry
-- while this migration reported success.
do $$
declare n int;
begin
  select count(*) into n
    from public.stage_fields
   where stage = 'dgm'
     and field_key in ('mill_hz_position', 'grind_time')
     and field_type = 'number';
  if n <> 2 then
    raise exception
      'expected 2 DGM settings columns to be numeric after this migration, found %', n;
  end if;
end $$;
