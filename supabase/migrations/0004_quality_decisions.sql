-- ===========================================================================
-- 0004_quality_decisions.sql
--
-- Holds and dispositions: who decided what about the material, on what
-- authority, and why.
--
-- Three things are kept strictly apart, as src/lib/workflow.ts requires:
--   CAPTURE STATE  is the record complete?
--   ASSESSMENT     does a measurement sit inside an approved limit?
--   DISPOSITION    what did an authorised person decide about the material?
--
-- Nothing in this schema can produce an acceptance on its own. Every
-- disposition row names an actor and the authority they acted under, and a
-- hold outranks every permissive signal (Master Prompt section 6).
-- ===========================================================================


create type public.hold_trigger_kind as enum (
  'adverse_observation',
  'outside_approved_limit',
  'manual'
);


-- ---------------------------------------------------------------------------
-- holds.
--
-- RAISING a hold is the safe direction and needs only `hold.raise`, which
-- every role that touches a sample has. CLEARING one needs `hold.clear`,
-- which a Quality Officer does NOT have and an Administrator does NOT have.
--
-- A sample may carry several holds at once  mould seen AND an out-of-limit
-- moisture are two findings, not one  so there is no "one hold per sample"
-- constraint. samples.hold_flag is maintained by trigger as "any uncleared
-- hold exists".
-- ---------------------------------------------------------------------------

create table public.holds (
  id                uuid primary key default gen_random_uuid(),
  sample_uuid       uuid not null references public.samples (id) on delete restrict,
  trigger_kind      public.hold_trigger_kind not null,
  -- The column that caused it, where one did. NULL for a manual hold.
  stage             public.sample_stage,
  field_key         text,
  detail            text not null,
  -- The assessment that triggered it, for an out-of-limit hold.
  assessment_id     uuid references public.assessments (id) on delete restrict,

  raised_by         uuid not null references public.profiles (id),
  raised_at         timestamptz not null default now(),
  -- 'base_role:quality_officer', 'delegation:<uuid>'. Recorded, not inferred,
  -- because role membership changes and the decision must stay explicable.
  raised_authority  text not null,
  raise_reason      text,

  cleared_by        uuid references public.profiles (id),
  cleared_at        timestamptz,
  cleared_authority text,
  clear_reason      text,

  constraint holds_detail_present check (length(btrim(detail)) > 0),
  constraint holds_authority_present check (length(btrim(raised_authority)) > 0),
  constraint holds_clearance_complete
    check ((cleared_by is null) = (cleared_at is null)),
  -- Clearing a hold always requires a written reason and a recorded authority.
  -- Letting material go is never a silent act.
  constraint holds_clearance_justified check (
    cleared_at is null
    or (length(btrim(coalesce(clear_reason, ''))) > 0
        and length(btrim(coalesce(cleared_authority, ''))) > 0)
  ),
  constraint holds_field_pair check ((stage is null) = (field_key is null)),
  -- A triggered hold names the finding that caused it; a manual one does not.
  constraint holds_trigger_shape check (
    case trigger_kind
      when 'manual' then assessment_id is null
      when 'outside_approved_limit' then field_key is not null
      when 'adverse_observation' then field_key is not null
    end
  ),
  foreign key (stage, field_key) references public.stage_fields (stage, field_key)
);

create index holds_sample_idx on public.holds (sample_uuid);
create index holds_active_idx on public.holds (sample_uuid) where cleared_at is null;

comment on table public.holds is
  'A hold outranks every permissive signal. Raising needs hold.raise; clearing needs hold.clear, which quality_officer and administrator do not have.';


-- ---------------------------------------------------------------------------
-- dispositions  append-only decisions about the material.
--
-- An ACCEPT over outstanding findings is never recorded as a plain
-- acceptance. It is recorded as an override, with the blocker list that stood
-- at the time, so the audit trail cannot later be read as a clean pass
-- (src/lib/workflow.ts checkDisposition).
-- ---------------------------------------------------------------------------

create table public.dispositions (
  id               uuid primary key default gen_random_uuid(),
  sample_uuid      uuid not null references public.samples (id) on delete restrict,
  decision         public.disposition_state not null,
  reason           text not null,
  -- True when the decision was taken over outstanding blockers and therefore
  -- required the delegation-only disposition.override_release.
  records_override boolean not null default false,
  -- Snapshot of evaluateRelease() at the moment of the decision. This is
  -- EVIDENCE, not a result: the authoritative per-measurement outcomes are
  -- typed rows in sample_measurements and assessments. Stored as jsonb because
  -- its shape is the blocker union, which is a frontend type, and because
  -- nothing queries inside it.
  blockers         jsonb not null default '[]'::jsonb,
  authority_basis  text not null,
  decided_by       uuid not null references public.profiles (id),
  decided_at       timestamptz not null default now(),
  -- A later decision on the same sample points back at the one it replaces, so
  -- the sequence of decisions is readable without a timestamp sort.
  supersedes       uuid references public.dispositions (id) on delete restrict,
  deployment_version text,

  constraint dispositions_reason_present check (length(btrim(reason)) > 0),
  constraint dispositions_authority_present check (length(btrim(authority_basis)) > 0),
  constraint dispositions_blockers_is_array check (jsonb_typeof(blockers) = 'array'),
  -- An override release is always an override. The two cannot disagree.
  constraint dispositions_override_consistent check (
    decision <> 'released_by_authorized_override' or records_override
  ),
  -- A recorded override must have had something to override.
  constraint dispositions_override_has_blockers check (
    not records_override or jsonb_array_length(blockers) > 0
  ),
  -- 'undetermined' is the initial state of a sample, not a decision somebody
  -- takes. It is never written here.
  constraint dispositions_not_undetermined check (decision <> 'undetermined')
);

create index dispositions_sample_idx on public.dispositions (sample_uuid, decided_at desc);
create index dispositions_override_idx on public.dispositions (sample_uuid) where records_override;

create trigger dispositions_append_only
  before update or delete on public.dispositions
  for each row execute function public.tg_append_only();


-- ---------------------------------------------------------------------------
-- samples.hold_flag and samples.disposition, maintained from the facts.
--
-- Derived state is computed from the rows, never set by a caller. A client
-- that could write hold_flag could clear a hold without holding hold.clear.
-- ---------------------------------------------------------------------------

create function public.tg_refresh_sample_hold_flag()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sample uuid := coalesce(new.sample_uuid, old.sample_uuid);
  v_active boolean;
begin
  select exists (
    select 1 from public.holds h
    where h.sample_uuid = v_sample and h.cleared_at is null
  ) into v_active;

  -- Unconditional and idempotent. `revision` is deliberately NOT touched: it
  -- is the optimistic-concurrency token for client edits, and bumping it from
  -- a side-effect trigger would invalidate the expected_revision the calling
  -- RPC is holding in the same transaction.
  update public.samples s
     set hold_flag = v_active,
         -- Raising a hold moves the material decision to on_hold immediately.
         -- Clearing one does NOT grant an acceptance: it returns the decision
         -- to undetermined, so an authorised person still has to decide.
         disposition = case
           when v_active then 'on_hold'::public.disposition_state
           when s.disposition = 'on_hold' then 'undetermined'::public.disposition_state
           else s.disposition
         end
   where s.id = v_sample;

  return null;
end;
$$;

create trigger holds_refresh_sample_flag
  after insert or update or delete on public.holds
  for each row execute function public.tg_refresh_sample_hold_flag();

create function public.tg_apply_disposition_to_sample()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Same reasoning as the hold trigger: the decision is projected onto the
  -- sample, but `revision` is bumped by the RPC that owns the transaction, not
  -- here.
  update public.samples s
     set disposition = new.decision
   where s.id = new.sample_uuid;

  return null;
end;
$$;

create trigger dispositions_apply_to_sample
  after insert on public.dispositions
  for each row execute function public.tg_apply_disposition_to_sample();


-- ---------------------------------------------------------------------------
-- Row level security.
-- ---------------------------------------------------------------------------

alter table public.holds        enable row level security;
alter table public.dispositions enable row level security;

create policy holds_select_viewers on public.holds
  for select to authenticated
  using (public.has_permission('sample.view'));

create policy dispositions_select_viewers on public.dispositions
  for select to authenticated
  using (public.has_permission('sample.view'));

-- No write policy on either table. Holds are raised and cleared by
-- public.raise_hold() / public.clear_hold(); dispositions are written by
-- public.record_disposition(). Both check authority server-side, and neither
-- can be reached by a direct table write because `authenticated` has no INSERT
-- privilege here at all.


-- ---------------------------------------------------------------------------
-- Privileges.
-- ---------------------------------------------------------------------------

revoke all on public.holds        from anon, authenticated;
revoke all on public.dispositions from anon, authenticated;

grant select on public.holds        to authenticated;
grant select on public.dispositions to authenticated;

revoke all on function public.tg_refresh_sample_hold_flag() from public;
revoke all on function public.tg_apply_disposition_to_sample() from public;
