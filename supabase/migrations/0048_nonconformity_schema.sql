-- ===========================================================================
-- 0048 — nonconformity and corrective action: the record itself.
--
-- Design: docs/superpowers/specs/2026-11-04-nonconformity-corrective-action-design.md
-- Plan:   docs/superpowers/plans/2026-11-04-nonconformity-capa-phase-1-database.md
--
-- ---------------------------------------------------------------------------
-- WHAT THIS IS FOR
-- ---------------------------------------------------------------------------
-- ISO 9001 clause 10.2 requires that when a nonconformity occurs the plant
-- reacts to it, evaluates whether action is needed to stop it recurring,
-- takes that action, and reviews whether it worked. Until now none of that
-- existed here. A hold stops material and a disposition records a decision
-- about it; nothing recorded WHAT WENT WRONG, WHY, WHAT WAS DONE and WHETHER
-- IT WORKED.
--
-- ---------------------------------------------------------------------------
-- D-09 GETS SOMEWHERE TO LAND
-- ---------------------------------------------------------------------------
-- Open decision D-09 asks whether a machine setting outside its range makes
-- MATERIAL non-conforming. It does not. Until now there was nowhere to put a
-- process deviation, so the only available response was a quality hold on
-- feed that may be perfectly good, and a Quality Supervisor being asked to
-- make a release decision about an engineering problem.
--
-- `classification` gives it a home: a mis-set roll gap is a `process`
-- nonconformity against the equipment, not a `product` one against the feed.
-- The policy still needs ratifying. The model no longer forces the wrong
-- answer in the meantime.
--
-- ---------------------------------------------------------------------------
-- SEVERITY HAS AN OBJECTIVE TEST
-- ---------------------------------------------------------------------------
-- `major` means non-conforming feed left the mill, or could affect bird
-- health. `minor` is everything else. Two values with a decidable rule, in
-- preference to three with a matter of taste — which is how a severity field
-- becomes uniformly major.
-- ===========================================================================

create type public.nc_status         as enum ('open','awaiting_verification','closed','voided');
create type public.nc_classification as enum ('product','process','system','supplier','customer_complaint');
create type public.nc_severity       as enum ('major','minor');
create type public.nc_rc_method      as enum ('five_whys','other');


-- ---------------------------------------------------------------------------
-- 1. The sequence behind NC-YYYY-NNN.
--
-- Its own table because the allocation must be one atomic statement. See
-- `allocate_nc_number` below for why `max(nc_number) + 1` is not acceptable.
-- ---------------------------------------------------------------------------
create table public.nc_number_sequence (
  year        integer primary key,
  last_number integer not null
);

comment on table public.nc_number_sequence is
  'One row per plant-local year. Written only by allocate_nc_number(), never by hand.';


-- ---------------------------------------------------------------------------
-- 2. The nonconformity.
--
-- `classification` and `severity` are NULLABLE on purpose. A nonconformity
-- raised automatically by a hold (0051, phase 4) is created at the mill by
-- whoever stopped the material, and guessing those two there would fill the
-- columns with defaults nobody chose. They are required at the first gate,
-- which is the moment somebody is actually thinking about it.
-- ---------------------------------------------------------------------------
create table public.nonconformities (
  id                uuid primary key default gen_random_uuid(),
  nc_number         text not null unique,
  status            public.nc_status not null default 'open',
  classification    public.nc_classification,
  severity          public.nc_severity,
  title             text not null,
  description       text not null,

  -- Null for a nonconformity with no sample behind it: a customer complaint,
  -- an audit finding, a supplier problem, a procedure not followed.
  sample_uuid       uuid references public.samples(id),
  hold_id           uuid references public.holds(id),

  -- A recurrence is a NEW record pointing at the earlier one, never a
  -- reopening. That is what makes "this is the third time" a queryable fact
  -- rather than somebody's memory.
  recurrence_of     uuid references public.nonconformities(id),

  detected_by       uuid not null references public.profiles(id),
  detected_at       timestamptz not null default now(),

  correction        text,
  root_cause        text,
  root_cause_method public.nc_rc_method,
  five_whys         text[],

  -- The ISO 10.2.1(b) evaluation. NULL means "not yet evaluated", which is
  -- a different fact from `false`, and the gate below tells them apart.
  ca_required       boolean,
  ca_rationale      text,

  verified_by       uuid references public.profiles(id),
  verified_at       timestamptz,
  verification_note text,
  -- Stamped at closure rather than derived at read time: the record must
  -- still say so years later, whatever happens to the rows around it.
  self_verified     boolean,

  void_reason       text,
  revision          integer not null default 1,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint nc_number_shape check (nc_number ~ '^NC-[0-9]{4}-[0-9]{3,}$'),
  constraint nc_verification_pair check ((verified_by is null) = (verified_at is null)),
  constraint nc_closed_is_verified check (
    status <> 'closed' or (verified_by is not null
                           and length(btrim(coalesce(verification_note,''))) > 0
                           and self_verified is not null)),
  constraint nc_voided_has_reason check (
    status <> 'voided' or length(btrim(coalesce(void_reason,''))) > 0),
  -- A method that names five whys and carries none is a label, not a method.
  constraint nc_five_whys_present check (
    root_cause_method is distinct from 'five_whys'
    or (five_whys is not null and array_length(five_whys,1) >= 1))
);

comment on column public.nonconformities.self_verified is
  'True when the verifier is also the person who detected the nonconformity or completed one of its actions. Computed once, at closure, and stored. The record says on its face that the work was checked by the person who did it.';


-- ---------------------------------------------------------------------------
-- 3. Assigned actions.
--
-- `assigned_to` is deliberately NOT immutable. An action owned by somebody
-- who has left the company could otherwise never be completed and never
-- cleared, and the nonconformity holding it could never reach its first
-- gate — a row stuck in a warning state no action can resolve. The same
-- trap existed in the specification lifecycle, where `reference_only` had no
-- outgoing transition at all; a list with permanently unclearable items
-- stops being read, which costs more than the stuck row.
-- ---------------------------------------------------------------------------
create table public.nc_actions (
  id              uuid primary key default gen_random_uuid(),
  nc_id           uuid not null references public.nonconformities(id) on delete restrict,
  description     text not null,
  assigned_to     uuid not null references public.profiles(id),
  due_date        date not null,
  completed_at    timestamptz,
  completed_by    uuid references public.profiles(id),
  completion_note text,
  created_by      uuid not null references public.profiles(id),
  created_at      timestamptz not null default now(),

  constraint nc_action_completion_pair check (
    (completed_at is null) = (completed_by is null)),
  constraint nc_action_complete_has_note check (
    completed_at is null or length(btrim(coalesce(completion_note,''))) > 0)
);

-- OVERDUE IS NOT A COLUMN. It is `completed_at is null and due_date < today`,
-- evaluated against the plant-local date when the screen is drawn. Storing it
-- would mean a row somebody could edit to look less late than it is, and
-- would need a job to keep current.
create index nc_status_idx      on public.nonconformities (status);
create index nc_sample_idx      on public.nonconformities (sample_uuid) where sample_uuid is not null;
create index nc_actions_due_idx on public.nc_actions (due_date) where completed_at is null;


-- ---------------------------------------------------------------------------
-- 4. The allocator.
--
-- ONE STATEMENT. `max(nc_number) + 1` reads a value a concurrent session is
-- about to write, and two simultaneous raises then receive the same number.
-- That collision never reproduces in single-user testing, which is why
-- `scripts/verify-nc-numbering.sh` drives it from twenty connections at once.
-- ---------------------------------------------------------------------------
create function public.allocate_nc_number(p_year integer)
returns text
language plpgsql
set search_path = ''
as $$
declare v_next integer;
begin
  insert into public.nc_number_sequence (year, last_number)
  values (p_year, 1)
  on conflict (year) do update
    set last_number = public.nc_number_sequence.last_number + 1
  returning last_number into v_next;
  return 'NC-' || p_year::text || '-' || lpad(v_next::text, 3, '0');
end $$;

revoke all on function public.allocate_nc_number(integer) from public, anon, authenticated;


-- ---------------------------------------------------------------------------
-- 5. The guard: what may change, and when.
--
-- Editable while open or awaiting verification, because a nonconformity is a
-- working document until somebody decides it is finished. Frozen once closed
-- or voided, which is the rule `specification_versions` already follows.
--
-- `awaiting_verification -> open` IS PERMITTED, and that is the important
-- line here. A verifier who finds the work incomplete must be able to send
-- it back; without that move the record sits in a state no action clears.
-- A state machine is designed from the happy path outward, so the terminal
-- states are the ones thought about last — and an entry state that is also
-- terminal is invisible until a row needs to leave it, by which time there
-- is data in it.
-- ---------------------------------------------------------------------------
create function public.tg_nonconformities_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception
      'A nonconformity is a quality record and cannot be deleted. Void it instead.'
      using errcode = '23514';
  end if;

  if old.status in ('closed','voided') then
    raise exception
      'Nonconformity % is % and cannot be changed. A recurrence is a new record.',
      old.nc_number, old.status using errcode = '23514';
  end if;

  if new.id is distinct from old.id
     or new.nc_number is distinct from old.nc_number
     or new.detected_by is distinct from old.detected_by
     or new.detected_at is distinct from old.detected_at
     or new.created_at is distinct from old.created_at then
    raise exception 'The identity of nonconformity % is immutable', old.nc_number
      using errcode = '23514';
  end if;

  if new.status is distinct from old.status then
    if not (
         (old.status = 'open' and new.status in ('awaiting_verification','voided'))
      or (old.status = 'awaiting_verification' and new.status in ('closed','voided','open'))
    ) then
      raise exception 'A nonconformity cannot move from % to %', old.status, new.status
        using errcode = '23514';
    end if;
  end if;

  new.updated_at := now();
  return new;
end $$;

create trigger nonconformities_guard
  before update or delete on public.nonconformities
  for each row execute function public.tg_nonconformities_guard();


-- ---------------------------------------------------------------------------
-- 6. Prove it against the real database, then undo it.
--
-- EVERY REFUSAL ASSERTION HAS TWO HALVES: the attempt, wrapped in a handler
-- that swallows the expected error, AND a post-condition query proving the
-- state did not change. A bare attempt is not an assertion — it terminates
-- the block on the SUCCESS of the thing being tested, so a correct schema
-- and a broken one both end the script early and neither reaches the notice
-- at the bottom.
--
-- Each refusal is paired with a control that performs the same write with
-- the offending part corrected, so a refusal cannot be passing because the
-- statement was malformed for some unrelated reason.
-- ---------------------------------------------------------------------------
do $$
declare
  v_n      integer;
  v_num    text;
  v_who    uuid;
  v_id     uuid;
  v_raised text;
begin
  select id into v_who from public.profiles where status = 'active' limit 1;
  if v_who is null then
    raise notice 'BFF_0048: no active profile; probe skipped.';
    return;
  end if;

  begin
    -- A1-A3. The allocator counts from one, increments, and keeps years apart.
    v_num := public.allocate_nc_number(2026);
    if v_num <> 'NC-2026-001' then
      raise exception 'BFF_0048_A1: first number was %, expected NC-2026-001', v_num
        using errcode = '22023';
    end if;
    v_num := public.allocate_nc_number(2026);
    if v_num <> 'NC-2026-002' then
      raise exception 'BFF_0048_A2: second number was %, expected NC-2026-002', v_num
        using errcode = '22023';
    end if;
    v_num := public.allocate_nc_number(2027);
    if v_num <> 'NC-2027-001' then
      raise exception 'BFF_0048_A3: a new year gave %, expected NC-2027-001', v_num
        using errcode = '22023';
    end if;

    -- A4. A malformed number is refused. Attempt, then post-condition.
    v_raised := null;
    begin
      insert into public.nonconformities (nc_number, title, description, detected_by)
      values ('NC-26-1', 't', 'd', v_who);
    exception when others then v_raised := sqlerrm;
    end;
    if v_raised is null then
      raise exception 'BFF_0048_A4: a malformed nc_number was accepted'
        using errcode = '22023';
    end if;
    select count(*) into v_n from public.nonconformities where nc_number = 'NC-26-1';
    if v_n <> 0 then
      raise exception 'BFF_0048_A4_POST: the malformed row exists anyway'
        using errcode = '22023';
    end if;

    -- A5. five_whys must carry a why. Attempt, then post-condition.
    v_raised := null;
    begin
      insert into public.nonconformities (nc_number, title, description, detected_by,
                                          root_cause_method)
      values ('NC-2026-900', 't', 'd', v_who, 'five_whys');
    exception when others then v_raised := sqlerrm;
    end;
    if v_raised is null then
      raise exception 'BFF_0048_A5: the five-whys method was accepted with no whys'
        using errcode = '22023';
    end if;
    select count(*) into v_n from public.nonconformities where nc_number = 'NC-2026-900';
    if v_n <> 0 then
      raise exception 'BFF_0048_A5_POST: the row exists anyway' using errcode = '22023';
    end if;

    -- A6. CONTROL for A5. The same insert WITH a why is accepted, so A5 is
    --     not passing because of something else wrong with the statement.
    insert into public.nonconformities (nc_number, title, description, detected_by,
                                        root_cause_method, five_whys)
    values ('NC-2026-901', 't', 'd', v_who, 'five_whys',
            array['the conditioner was below temperature'])
    returning id into v_id;
    if v_id is null then
      raise exception 'BFF_0048_A6: a well-formed five-whys row was rejected'
        using errcode = '22023';
    end if;

    -- A7. Closing without verification is refused. Attempt, then post-condition.
    v_raised := null;
    begin
      update public.nonconformities set status = 'closed' where id = v_id;
    exception when others then v_raised := sqlerrm;
    end;
    if v_raised is null then
      raise exception 'BFF_0048_A7: a nonconformity was closed with no verification'
        using errcode = '22023';
    end if;
    select count(*) into v_n from public.nonconformities
     where id = v_id and status = 'closed';
    if v_n <> 0 then
      raise exception 'BFF_0048_A7_POST: the row is closed anyway' using errcode = '22023';
    end if;

    -- A8. An illegal lifecycle move is refused: open -> closed skips the gate.
    v_raised := null;
    begin
      update public.nonconformities
         set status = 'closed', verified_by = v_who, verified_at = now(),
             verification_note = 'x', self_verified = true
       where id = v_id;
    exception when others then v_raised := sqlerrm;
    end;
    if v_raised is null then
      raise exception 'BFF_0048_A8: open jumped straight to closed'
        using errcode = '22023';
    end if;
    select status::text into v_num from public.nonconformities where id = v_id;
    if v_num <> 'open' then
      raise exception 'BFF_0048_A8_POST: the row is now %, not open', v_num
        using errcode = '22023';
    end if;

    -- A9. THE RETURN PATH EXISTS. A verifier who finds the work incomplete
    --     must be able to send it back; without this the record is stuck
    --     where no action clears it.
    update public.nonconformities set status = 'awaiting_verification' where id = v_id;
    update public.nonconformities set status = 'open' where id = v_id;
    select status::text into v_num from public.nonconformities where id = v_id;
    if v_num <> 'open' then
      raise exception
        'BFF_0048_A9: awaiting_verification could not return to open (now %)', v_num
        using errcode = '22023';
    end if;

    -- A10. A closed record is frozen. Attempt, then post-condition.
    update public.nonconformities set status = 'awaiting_verification' where id = v_id;
    update public.nonconformities
       set status = 'closed', verified_by = v_who, verified_at = now(),
           verification_note = 'checked', self_verified = true
     where id = v_id;
    v_raised := null;
    begin
      update public.nonconformities set title = 'edited after closure' where id = v_id;
    exception when others then v_raised := sqlerrm;
    end;
    if v_raised is null then
      raise exception 'BFF_0048_A10: a closed nonconformity was edited'
        using errcode = '22023';
    end if;
    select count(*) into v_n from public.nonconformities
     where id = v_id and title = 'edited after closure';
    if v_n <> 0 then
      raise exception 'BFF_0048_A10_POST: the edit landed anyway' using errcode = '22023';
    end if;

    -- A11. A nonconformity cannot be deleted. Attempt, then post-condition.
    v_raised := null;
    begin
      delete from public.nonconformities where id = v_id;
    exception when others then v_raised := sqlerrm;
    end;
    if v_raised is null then
      raise exception 'BFF_0048_A11: a nonconformity was deleted' using errcode = '22023';
    end if;
    select count(*) into v_n from public.nonconformities where id = v_id;
    if v_n <> 1 then
      raise exception 'BFF_0048_A11_POST: the row is gone anyway' using errcode = '22023';
    end if;

    raise exception 'BFF_0048_ROLLBACK';
  exception
    when others then
      if sqlerrm <> 'BFF_0048_ROLLBACK' then raise; end if;
  end;

  raise notice 'BFF_0048: probe passed and was rolled back.';
end $$;


-- ---------------------------------------------------------------------------
-- 7. The probe left nothing. Asserted outside its block, so a rollback that
--    only half-happened is caught here rather than at the next migration.
-- ---------------------------------------------------------------------------
do $$
declare v_n integer;
begin
  select count(*) into v_n from public.nonconformities;
  if v_n <> 0 then
    raise exception 'BFF_0048_RESIDUE: % nonconformity row(s) survived the probe', v_n
      using errcode = '22023';
  end if;
  select count(*) into v_n from public.nc_number_sequence;
  if v_n <> 0 then
    raise exception 'BFF_0048_RESIDUE_SEQ: % sequence row(s) survived the probe', v_n
      using errcode = '22023';
  end if;
end $$;
