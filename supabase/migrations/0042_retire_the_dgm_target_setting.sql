-- ===========================================================================
-- 0042 — the grind target moves into the approval workflow, and the
--        administrator setting that stood in for it is removed.
--
-- ---------------------------------------------------------------------------
-- WHY THE SETTING EXISTED, AND WHY IT NO LONGER SHOULD
-- ---------------------------------------------------------------------------
-- The 900-1200 µm band was stored as a JSON document in `system_config` and
-- edited on an admin screen, because when it was built (0034) a computed
-- result could not be assessed at all: `sample_derived_results` had no
-- verdict column and the engine was never called on that path, so the
-- specification workflow had nowhere to put an answer. The setting was the
-- only way to get a band onto a chart.
--
-- It worked, and it was governed by nothing. No proposer, no second-person
-- approval, no version, no effective date — one administrator could change
-- what every results screen shaded green, and the only trace was an audit
-- row. That is not how a limit is controlled in a quality system, and the
-- screen itself had to carry a paragraph explaining that the figures were
-- "a target for the mill, not an approved specification" precisely because
-- nothing structural made that true.
--
-- 0041 removed the constraint. So the band now comes from the same place
-- every other limit does.
--
-- ---------------------------------------------------------------------------
-- THE BAND DISAPPEARS UNTIL SOMEBODY APPROVES ONE. THAT IS THE POINT.
-- ---------------------------------------------------------------------------
-- Chosen with the plant rather than imposed. A green band on a quality
-- record with nobody's approval behind it is the thing this application
-- exists not to do, and the honest intermediate state is no band.
--
-- The figures are not lost. The document's own text is carried verbatim into
-- a DRAFT specification version on each of the five sieve stages, so nobody
-- has to retype a citation. A draft decides nothing and draws nothing — it
-- is the proposal form, filled in and waiting. To bring the band back:
-- propose one of them, and have a second person approve it.
--
-- ---------------------------------------------------------------------------
-- WHY THESE ARE VERSION max+1 AND THE EMPTY ONES STAY
-- ---------------------------------------------------------------------------
-- 0039 added figureless placeholder drafts for `pellets.avg_particle_size`
-- and `dgm.avg_particle_size`. A version is immutable, so they cannot be
-- given figures, and the lifecycle has no `draft -> superseded` move, so
-- they cannot be retired either.
--
-- That is the same gap 0039 opened `reference_only -> superseded` to close,
-- one state along, and widening the guard twice in two days to tidy two
-- inert rows would be a poor trade: a draft is visible, decides nothing, and
-- is plainly older than the version beside it. They are left, and this
-- comment is why. If drafts ever need retiring for a real reason, that is
-- the moment to add the move — not now, to make a listing look neater.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. The figures, as a draft on each sieve stage.
--
-- `source_evidence` is the stored document's `basis` text verbatim, plus
-- where it came from. The schema requires it to be non-empty, which is the
-- same rule the retired admin screen enforced by disabling its Save button —
-- now a constraint instead of a form validation.
-- ---------------------------------------------------------------------------
insert into public.specification_versions (
  specification_id, version, parameter_key, stage, unit,
  lower_bound, upper_bound, status, effective_from, source_evidence
)
select
  s.id,
  coalesce((select max(v.version) from public.specification_versions v
             where v.specification_id = s.id), 0) + 1,
  s.parameter_key, s.stage, 'µm',
  900, 1200, 'draft', now(),
  'Carried from the retired `dgm_target_ranges` administrator setting by migration 0042, '
  || 'verbatim: "Single range set by Bounty Farm for every sieve form. 900-1200 um is the '
  || 'pre-pelleting grind target (Auburn University 2025; Aviagen 2025). That guidance gives '
  || 'a wider 1200-2000 um range for mash feed, and no figure at all for a finished crumble '
  || 'or pellet." Bounty Farm set one range across all five forms on 2026-11-02. This is a '
  || 'DRAFT: it decides nothing and draws nothing until it is proposed and approved by a '
  || 'second person.'
  from public.specifications s
 where s.parameter_key in (
   'ground.avg_particle_size', 'pellets.avg_particle_size',
   'crumble.avg_particle_size', 'mash.avg_particle_size', 'dgm.avg_particle_size'
 );


-- ---------------------------------------------------------------------------
-- 2. The setting, and the function that wrote it.
--
-- `rpc_set_dgm_target_ranges` is dropped rather than left in place: an RPC
-- nothing calls is a privileged write path nobody is watching, and
-- `tests/rpcContract.test.ts` fails on one, which is how this was caught.
-- ---------------------------------------------------------------------------
drop function if exists public.rpc_set_dgm_target_ranges(uuid, text, text, text, jsonb, text);
drop function if exists public.rpc_set_dgm_target_ranges(uuid, text, text, text, jsonb);

delete from public.system_config where key = 'dgm_target_ranges';


-- ---------------------------------------------------------------------------
-- 3. Prove it, in the same transaction that did it.
-- ---------------------------------------------------------------------------
do $$
declare
  v_bad text;
  v_n   integer;
begin
  -- a. Five drafts, each with the figures and a stated source.
  select count(*) into v_n
    from public.specification_versions v
   where v.parameter_key like '%.avg_particle_size'
     and v.status = 'draft' and v.lower_bound = 900 and v.upper_bound = 1200
     and v.unit = 'µm' and length(btrim(v.source_evidence)) > 100;
  if v_n <> 5 then
    raise exception 'BFF_0042_DRAFTS: expected 5 carried drafts, found %', v_n
      using errcode = '22023';
  end if;

  -- b. NOTHING IS APPROVED. The band is meant to be absent until a person
  --    approves one; a migration that quietly approved its own figures would
  --    satisfy (a) and defeat the entire point of moving them.
  select count(*) into v_n
    from public.specification_versions where status = 'approved' or approved_by is not null;
  if v_n <> 0 then
    raise exception 'BFF_0042_APPROVED: % version(s) are approved; 0042 approves nothing', v_n
      using errcode = '22023';
  end if;

  -- c. The setting and its writer are gone, and no other caller is left
  --    holding a reference to the function.
  if exists (select 1 from public.system_config where key = 'dgm_target_ranges') then
    raise exception 'BFF_0042_CONFIG: the dgm_target_ranges row is still present'
      using errcode = '22023';
  end if;

  select string_agg(p.proname, ', ') into v_bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'rpc_set_dgm_target_ranges';
  if v_bad is not null then
    raise exception 'BFF_0042_RPC: % still exists' , v_bad using errcode = '22023';
  end if;

  select string_agg(p.proname, ', ') into v_bad
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    join pg_language l on l.oid = p.prolang
   where n.nspname = 'public' and l.lanname = 'plpgsql' and p.prokind = 'f'
     and pg_get_functiondef(p.oid) ~ 'dgm_target_ranges';
  if v_bad is not null then
    raise exception
      'BFF_0042_DANGLING: % still refers to dgm_target_ranges, which no longer exists',
      v_bad using errcode = '22023';
  end if;
end
$$;
