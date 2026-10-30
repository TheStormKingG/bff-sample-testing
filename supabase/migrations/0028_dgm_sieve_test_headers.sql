--
-- Re-head three DGM columns that were named after milling, not sieving.
--
-- The workbook's row 4 is the contract: `verifyWorkbook()` compares it to the
-- registry character for character before any write, and a mismatch fails
-- CLOSED -- no DGM row reaches the sheet. These three headers were inherited
-- from a source sheet that described how the product was MADE:
--
--   G  Mill RPM             -> Durability tester RPM
--   H  Mill Hz or position  -> Sieve shaker frequency (Hz)
--   I  Grind time           -> Vibration time (min)
--
-- None of them is a property of milling. G is filled only when the Particle
-- Durability Tester was used; H is the frequency the sieve stack was shaken
-- at; I is how long the stack ran in the vibrator, which 0027 already turned
-- from free text into a number with a unit.
--
-- ORDER OF OPERATIONS, which is the whole risk here. The spreadsheet row 4
-- was edited FIRST, by hand, and the Edge Functions carrying the new registry
-- were deployed immediately after. Between those two moments the deployed
-- registry disagreed with the sheet and DGM writes were refused -- correctly,
-- and that refusal is the feature. This migration only brings the database's
-- copy of the header into line; it is not what the verification reads.
--

update public.stage_fields
   set sheet_header = 'Durability tester RPM'
 where stage = 'dgm' and field_key = 'mill_rpm';

update public.stage_fields
   set sheet_header = 'Sieve shaker frequency (Hz)'
 where stage = 'dgm' and field_key = 'mill_hz_position';

update public.stage_fields
   set sheet_header = 'Vibration time (min)'
 where stage = 'dgm' and field_key = 'grind_time';

do $$
declare n int;
begin
  select count(*) into n
    from public.stage_fields
   where stage = 'dgm'
     and sheet_header in
       ('Durability tester RPM', 'Sieve shaker frequency (Hz)', 'Vibration time (min)');
  if n <> 3 then
    raise exception 'expected 3 re-headed DGM columns, found %', n;
  end if;
end $$;
