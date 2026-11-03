-- ===========================================================================
-- 0039 — the Limits sheet, reconciled against the forms as they now stand.
--
--   guard               gains ONE lifecycle move: reference_only -> superseded.
--   #26 protein solubility  SUPERSEDED. The column was removed by 0038.
--   #25 urease              SUPERSEDED, and replaced by a version 2 that
--                           states the question that actually has to be asked.
--   six new parameters      ADDED, as drafts with no figures, for sieve and
--                           durability results that have no row at all.
--
-- No form, no column and no stored measurement moves, and nothing becomes
-- approved or assessable. Step 5 asserts that last part.
--
-- ---------------------------------------------------------------------------
-- THE FIRST ATTEMPT AT THIS MIGRATION WAS REFUSED, AND THE REFUSAL WAS RIGHT
-- ---------------------------------------------------------------------------
-- It tried to edit the two rows in place: clear the urease bounds, mark the
-- protein-solubility row superseded. `tg_specification_versions_guard` threw
-- twice over.
--
-- A specification version is IMMUTABLE. Its bounds, unit, source evidence and
-- workbook provenance cannot be changed after insert, because an assessment
-- recorded against version 1 cites figures that must still be readable years
-- later. Editing them would rewrite the rule a past decision was made under.
-- The designed answer is to propose a NEW version, and that is what #25 gets
-- below.
--
-- And `reference_only` was a TERMINAL state. The legal moves were
-- draft -> proposed -> approved -> superseded, with rejection off the first
-- two. Nothing left `reference_only` at all.
--
-- That is a gap rather than a decision. These rows were imported from the
-- workbook `Limits` tab, and a workbook row can stop describing reality in
-- two ways the lifecycle never anticipated: the TEST can be withdrawn (#26 —
-- the column is gone), or the METHOD can change so that the figures measure
-- something the plant no longer produces (#25 — a pH rise, where the mill now
-- reads a colour). Neither is a rejection: nobody proposed these and nobody
-- refused them. Neither is an approval being retired.
--
-- Without an exit, such a row is an immortal warning on the Limits screen
-- that no action can ever clear, which trains people to ignore the screen.
-- So one move is added: `reference_only -> superseded`. It is the narrowest
-- change that closes the gap. The immutability rules are untouched — a
-- superseded row still cannot have its figures edited — and the existing
-- `specification_versions_superseded_has_end` constraint already forces an
-- `effective_to`, so a withdrawal has to say when it took effect.
--
-- ---------------------------------------------------------------------------
-- WHY #26 IS SUPERSEDED AND NOT DELETED
-- ---------------------------------------------------------------------------
-- The instruction was to delete it. The guard refuses a DELETE outright —
-- "A specification version is immutable and cannot be deleted. Supersede it
-- instead." — and that is the correct instrument here anyway. This is the
-- only record that Bounty Farm once intended to hold extruded soya to 70-85%
-- protein solubility, and that the figures were awaiting Polinutri. An
-- auditor asking "was this ever a controlled characteristic, and who stopped
-- it being one?" is entitled to an answer, and a deleted row answers nothing.
--
-- `SpecificationsPage` draws a superseded row in the neutral tone with an
-- archive icon, where `reference_only` gets the warning tone. So superseding
-- takes it off the list of things needing attention — which is what "delete
-- it, it's dead" meant — while leaving it readable.
--
-- ---------------------------------------------------------------------------
-- WHY #25 GETS A VERSION 2 INSTEAD
-- ---------------------------------------------------------------------------
-- The urease TEST still happens. What changed in 0038 is how it is read: the
-- mill runs the visual urea-phenol-red comparison, not the quantitative
-- buffer method, and 0.05-0.20 is a pH RISE the buffer method reports. The
-- parameter is live; its bounds describe a different procedure.
--
-- Leaving "0.05 to 0.20 pH rise, confirm with Polinutri" as the current word
-- on the sheet sends somebody to ask the wrong question and come back with an
-- answer that cannot be applied to anything the plant records. So version 1
-- is superseded intact — it remains the true record of what the workbook
-- said — and version 2 carries no bounds, no unit, and states what to ask
-- instead: WHICH OF THE FOUR VISUAL GRADES ARE ACCEPTED.
--
-- The unit goes with the bounds. A visual grade has no dimension, and
-- 'pH rise' left on an empty row would still read as a pH measurement.
--
-- IT STAYS UNLINKED TO A FIELD, DELIBERATELY. `urease_qualitative` carries no
-- `parameter_key` and must not be given one yet: `evaluate_measurement`
-- compares a numeric value against numeric bounds, and there is nowhere in
-- `specification_versions` to record "these codes pass". A link today would
-- make a visual grade look assessable and return `not_assessable` for ever,
-- which reads as a broken rule rather than a deliberate absence. Accepting a
-- SET OF CODES is a schema change and belongs with the computed-column work.
--
-- ---------------------------------------------------------------------------
-- WHY THE SIX NEW ROWS ARE `draft` AND NOT `reference_only`
-- ---------------------------------------------------------------------------
-- `reference_only` means "imported from the workbook `Limits` tab", and the
-- constraint comment says so. None of these six was ever on that tab — the
-- tab predates both the sieve test moving onto `4 Pellets` and the `8 DGM`
-- log existing. Importing them as reference would assert a source document
-- that does not exist, and `workbook_entry_no` / `workbook_status` are null
-- on all six for the same reason.
--
-- `draft` is what they are: a named parameter, no figures, waiting for
-- somebody to propose some. Neither status can assess anything — `assess()`
-- admits only `approved` with a recorded approver — so this changes no
-- verdict. It changes what the Limits screen shows as outstanding, which is
-- the point: six measurements the plant now takes were invisible there.
--
-- THEY CANNOT BE ENFORCED YET, and adding them does not pretend otherwise.
-- All six are produced by COMPUTED columns, which carry no `parameter_key`,
-- live in `sample_derived_results` rather than `sample_measurements`, and are
-- never passed to `evaluate_measurement`. Making them assessable is separate,
-- scoped work. What these rows do is make the gap countable instead of
-- invisible: `4 Pellets` runs a full sieve test and a durability test on the
-- finished product and had no entry on the sheet at all.
--
-- `6 Crumble` gains a GSD row for the same reason. It never had one — the tab
-- had no size-spread column before the sieve test arrived — so it was missing
-- from the audit of what is missing.
--
-- ONE PRECEDENCE QUESTION IS CREATED AND NOT ANSWERED HERE. A sieve test run
-- on a process tab also projects into the `8 DGM` master log, so the same
-- physical test would answer to two parameters once either is approved. That
-- is not yet live — nothing is approved and computed columns cannot be
-- assessed at all — and resolving it by leaving `8 DGM` off the sheet would
-- hide it rather than settle it. Direct registrations on `8 DGM` (six of them
-- exist today, with no originating sample) would then be the only sieve tests
-- in the plant with no parameter at all.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. One more lifecycle move, and nothing else.
--
-- Restated verbatim from 0003 apart from the single added line, so a reader
-- diffing the two sees one change. Every immutability rule above it is
-- unchanged, including the DELETE refusal.
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
      -- approved). Added by 0039; see that migration's header. The
      -- superseded_has_end constraint still forces a date on it.
      or (old.status = 'reference_only' and new.status = 'superseded')
    ) then
      raise exception 'A specification version cannot move from % to %', old.status, new.status
        using errcode = '23514';
    end if;
  end if;

  return new;
end;
$$;

comment on function public.tg_specification_versions_guard() is
  'Immutability and lifecycle guard for specification_versions. A version''s figures, unit, provenance and source evidence can never be edited after insert, and a version can never be deleted: both would rewrite the rule a past assessment was made under. Status may only move draft -> proposed -> approved -> superseded, with rejection off the first two, plus reference_only -> superseded for an imported workbook row whose test or method no longer exists (0039).';


-- ---------------------------------------------------------------------------
-- 2. #26 protein solubility — withdrawn.
-- ---------------------------------------------------------------------------
update public.specification_versions
   set status = 'superseded',
       effective_to = now(),
       decision_reason =
         'Withdrawn 2026-11-02. The Protein solubility (%) column was removed from '
         || '5 Extruded soya by migration 0038 at the plant''s request; it held no value '
         || 'in the workbook or the database and no sample was ever tested for it. Kept '
         || 'superseded rather than deleted so the record that this was once intended as '
         || 'a controlled characteristic, with figures awaiting Polinutri, survives.'
 where parameter_key = 'extruded_soya.protein_solubility'
   and status = 'reference_only';

update public.specifications
   set notes =
         'WITHDRAWN 2026-11-02 (migration 0039). The column was removed from the form by '
         || '0038. The workbook figures were 70-85 %, never approved, awaiting Polinutri. '
         || 'Kept for the audit trail; no sample was ever tested.'
 where parameter_key = 'extruded_soya.protein_solubility';


-- ---------------------------------------------------------------------------
-- 3. #25 urease — version 1 superseded, version 2 asks the right question.
-- ---------------------------------------------------------------------------
update public.specification_versions
   set status = 'superseded',
       effective_to = now(),
       decision_reason =
         'Superseded by version 2 on 2026-11-02. 0.05-0.20 is the pH RISE reported by the '
         || 'quantitative buffer method (phosphate and urea buffers, 30 min at 30 C, '
         || 'filter, pH meter). The mill runs the VISUAL urea-phenol-red comparison '
         || 'instead, which has no number in it, so these figures cannot be compared with '
         || 'anything the system records. Kept intact as the true record of what the '
         || 'workbook said.'
 where parameter_key = 'extruded_soya.urease'
   and status = 'reference_only';

insert into public.specification_versions (
  specification_id, version, parameter_key, stage, unit,
  lower_bound, upper_bound, status, effective_from, source_evidence, supersedes
)
select v.specification_id, 2, v.parameter_key, v.stage, null,
       null, null, 'draft', now(),
       'Authored 2026-11-02 by migration 0039, replacing workbook Limits entry 25. The '
       || 'method changed: migration 0038 replaced the typed pH-rise figure with the '
       || 'four-grade visual comparison the plant actually performs, per Table 1, '
       || '"Visual examination of soybean meal treated with Urea-Phenol Red solution", '
       || 'supplied by Bounty Farm 2026-11-02. No bounds and no unit, because a visual '
       || 'grade has neither. OUTSTANDING QUESTION FOR POLINUTRI: which of the four '
       || 'grades are accepted?',
       v.id
  from public.specification_versions v
 where v.parameter_key = 'extruded_soya.urease' and v.version = 1;

update public.specifications
   set title = 'Urease (visual grade)',
       notes =
         'Read as a VISUAL GRADE, not a number: 0.2 g of meal wetted with urea-phenol red '
         || 'and matched against four reference dishes. The four codes are over_cooked, '
         || 'properly_cooked_slight, properly_cooked_moderate and under_cooked (field '
         || 'urease_qualitative, 5 Extruded soya column M). '
         || 'OUTSTANDING QUESTION FOR POLINUTRI: which grades are accepted? '
         || 'NOT LINKED TO THE FIELD and must not be until specification_versions can '
         || 'express an accepted SET OF CODES; evaluate_measurement compares numbers to '
         || 'numeric bounds, so a link today would return not_assessable for ever.'
 where parameter_key = 'extruded_soya.urease';


-- ---------------------------------------------------------------------------
-- 4. Six parameters the sheet never had.
--
-- Naming follows the rows that already exist — `<stage>.avg_particle_size`,
-- `<stage>.size_spread_gsd`, `<stage>.pellet_durability_pdi` — rather than
-- the computed field keys, because a parameter key is the stable identity of
-- a CHARACTERISTIC and three stages already name this one that way.
-- ---------------------------------------------------------------------------
insert into public.specifications (
  parameter_key, stage, title, workbook_sample_label, workbook_test_label,
  is_machine_setting, notes
) values
  ('pellets.avg_particle_size', 'pellets', 'Average particle size',
   'Pellets before crumbling', 'Average particle size', false,
   'NOT ON THE WORKBOOK LIMITS TAB. 4 Pellets gained the sieve test in migration 0033, '
   || 'after the tab was written. Produced by the computed column dgm_um, which carries no '
   || 'parameter_key and therefore cannot be assessed until computed results are made '
   || 'assessable.'),
  ('pellets.size_spread_gsd', 'pellets', 'Size spread (GSD)',
   'Pellets before crumbling', 'Size spread (GSD)', false,
   'NOT ON THE WORKBOOK LIMITS TAB; see pellets.avg_particle_size. Produced by the computed '
   || 'column gsd. Dimensionless by definition — a ratio of two particle sizes.'),
  ('pellets.pellet_durability_pdi', 'pellets', 'Pellet durability (PDI)',
   'Pellets before crumbling', 'Pellet durability (PDI)', false,
   'NOT ON THE WORKBOOK LIMITS TAB. The durability test moved onto 4 Pellets in migration '
   || '0033 — the pellet is the product the tumbler was bought for. Produced by the computed '
   || 'column pellet_durability_pdi_pct from the two tumbling weights.'),
  ('crumble.size_spread_gsd', 'crumble', 'Size spread (GSD)',
   'Finished crumble', 'Size spread (GSD)', false,
   'NOT ON THE WORKBOOK LIMITS TAB. 6 Crumble never had a size-spread column before the '
   || 'sieve test arrived in migration 0029, so it was absent from the audit of what was '
   || 'missing. Produced by the computed column gsd.'),
  ('dgm.avg_particle_size', 'dgm', 'Average particle size',
   'Any sieve test', 'Average particle size', false,
   'NOT ON THE WORKBOOK LIMITS TAB; the 8 DGM master log was added after it was written. '
   || 'PRECEDENCE IS UNRESOLVED: a sieve test run on a process tab projects into this log, '
   || 'so one physical test would answer to this parameter and to the process tab''s. Six '
   || 'samples registered directly on 8 DGM have no originating tab and would otherwise '
   || 'have no parameter at all.'),
  ('dgm.size_spread_gsd', 'dgm', 'Size spread (GSD)',
   'Any sieve test', 'Size spread (GSD)', false,
   'NOT ON THE WORKBOOK LIMITS TAB; see dgm.avg_particle_size, including the unresolved '
   || 'precedence question.');

-- One version each: named, no figures, no workbook provenance.
insert into public.specification_versions (
  specification_id, version, parameter_key, stage, unit,
  lower_bound, upper_bound, status, effective_from, source_evidence
)
select s.id, 1, s.parameter_key, s.stage,
       case
         when s.parameter_key like '%.avg_particle_size' then 'µm'
         when s.parameter_key like '%.pellet_durability_pdi' then '%'
         else null                       -- GSD is dimensionless
       end,
       null, null, 'draft', now(),
       'Authored 2026-11-02 by migration 0039, not imported. The measurement is taken and '
       || 'recorded; no limit has ever been stated for it. Added so the Limits screen counts '
       || 'it as outstanding rather than omitting it.'
  from public.specifications s
 where s.parameter_key in (
   'pellets.avg_particle_size', 'pellets.size_spread_gsd', 'pellets.pellet_durability_pdi',
   'crumble.size_spread_gsd', 'dgm.avg_particle_size', 'dgm.size_spread_gsd'
 );


-- ---------------------------------------------------------------------------
-- 5. Prove it, in the same transaction that did it.
--
-- Several statements rather than one. A single count would pass on a
-- migration that superseded the wrong row and added the right ones, and the
-- assertion most worth making is the NEGATIVE one: that nothing here became
-- assessable.
-- ---------------------------------------------------------------------------
do $$
declare
  v_bad text;
  v_n   integer;
begin
  -- a. Nothing is approved, and nothing acquired an approver. This migration
  --    touches the sheet; it must not change a single verdict.
  select count(*) into v_n
    from public.specification_versions
   where status = 'approved' or approved_by is not null;
  if v_n <> 0 then
    raise exception 'BFF_0039_APPROVED: % version(s) are approved; 0039 must approve nothing', v_n
      using errcode = '22023';
  end if;

  -- b. Both withdrawals landed, each with an end date.
  select string_agg(format('%s v%s status=%s effective_to=%s',
                           parameter_key, version, status,
                           coalesce(effective_to::text, 'null')), '; ')
    into v_bad
    from public.specification_versions
   where parameter_key in ('extruded_soya.protein_solubility', 'extruded_soya.urease')
     and version = 1
     and (status <> 'superseded' or effective_to is null);
  if v_bad is not null then
    raise exception 'BFF_0039_WITHDRAWN: %', v_bad using errcode = '22023';
  end if;

  -- c. Urease version 2 exists, carries no figures and no unit, and points
  --    back at the version it replaces. The `supersedes` link is the half a
  --    careless insert would omit, and without it the two rows are a
  --    coincidence rather than a history.
  select format('urease v2: lower=%s upper=%s unit=%s supersedes=%s',
                coalesce(lower_bound::text, 'null'), coalesce(upper_bound::text, 'null'),
                coalesce(unit, 'null'), coalesce(supersedes::text, 'null'))
    into v_bad
    from public.specification_versions
   where parameter_key = 'extruded_soya.urease' and version = 2
     and (lower_bound is not null or upper_bound is not null
          or unit is not null or supersedes is null);
  if v_bad is not null then
    raise exception 'BFF_0039_UREASE_V2: %', v_bad using errcode = '22023';
  end if;

  select count(*) into v_n
    from public.specification_versions
   where parameter_key = 'extruded_soya.urease' and version = 2;
  if v_n <> 1 then
    raise exception 'BFF_0039_UREASE_V2: expected exactly 1 version 2, found %', v_n
      using errcode = '22023';
  end if;

  -- d. The six exist, each with exactly one version, and none of them claims
  --    a workbook entry it never had.
  select string_agg(format('%s has %s version(s), workbook_entry_no %s',
                           x.parameter_key, x.n, coalesce(x.wb::text, 'null')), '; ')
    into v_bad
    from (
      select s.parameter_key, count(v.id) n, max(v.workbook_entry_no) wb
        from public.specifications s
        left join public.specification_versions v on v.specification_id = s.id
       where s.parameter_key in (
         'pellets.avg_particle_size', 'pellets.size_spread_gsd',
         'pellets.pellet_durability_pdi', 'crumble.size_spread_gsd',
         'dgm.avg_particle_size', 'dgm.size_spread_gsd')
       group by s.parameter_key
    ) x
   where x.n <> 1 or x.wb is not null;
  if v_bad is not null then
    raise exception 'BFF_0039_NEW_ROWS: %', v_bad using errcode = '22023';
  end if;

  select count(*) into v_n
    from public.specifications
   where parameter_key in (
     'pellets.avg_particle_size', 'pellets.size_spread_gsd',
     'pellets.pellet_durability_pdi', 'crumble.size_spread_gsd',
     'dgm.avg_particle_size', 'dgm.size_spread_gsd');
  if v_n <> 6 then
    raise exception 'BFF_0039_COUNT: expected 6 new parameters, found %', v_n
      using errcode = '22023';
  end if;

  -- e. No parameter here points at a field. Asserted BECAUSE it is the thing
  --    a well-meaning later edit would "fix": linking a computed column or
  --    the urease grade would make either look assessable while the engine
  --    could only ever answer not_assessable.
  select string_agg(f.stage || '.' || f.field_key || ' -> ' || f.parameter_key, '; ')
    into v_bad
    from public.stage_fields f
   where f.parameter_key in (
     'extruded_soya.urease', 'extruded_soya.protein_solubility',
     'pellets.avg_particle_size', 'pellets.size_spread_gsd',
     'pellets.pellet_durability_pdi', 'crumble.size_spread_gsd',
     'dgm.avg_particle_size', 'dgm.size_spread_gsd');
  if v_bad is not null then
    raise exception
      'BFF_0039_LINKED: % — these parameters must stay unlinked until a computed result '
      'and a coded grade can actually be assessed', v_bad
      using errcode = '22023';
  end if;

  -- f. The guard still refuses everything it refused before. Three probes,
  --    each rolled back, because a `create or replace` that widened more
  --    than one transition would pass every assertion above.
  begin
    update public.specification_versions set lower_bound = 99
     where parameter_key = 'conditioned.temperature';
    raise exception 'BFF_0039_GUARD: an immutable bound was editable' using errcode = '22023';
  exception
    when check_violation then null;       -- expected: immutability
  end;

  begin
    update public.specification_versions set status = 'approved'
     where parameter_key = 'pellets.avg_particle_size';
    raise exception 'BFF_0039_GUARD: draft -> approved was permitted' using errcode = '22023';
  exception
    when check_violation then null;       -- expected: not a legal move
  end;

  begin
    delete from public.specification_versions where parameter_key = 'pellets.size_spread_gsd';
    raise exception 'BFF_0039_GUARD: a version was deletable' using errcode = '22023';
  exception
    when check_violation then null;       -- expected: immutability
  end;
end
$$;
