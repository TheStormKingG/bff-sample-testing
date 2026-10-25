-- ===========================================================================
-- 0003_specifications.sql
--
-- The approved-limit ruleset, its immutable version history, two-person
-- approval, and the append-only record of every assessment ever made.
--
-- The workbook `Limits` tab is NOT this ruleset. Its own row 2 warns: "Do not
-- add, delete or move rows, because the test tabs read these cells by their
-- position." A rule keyed by spreadsheet row would silently re-point when
-- somebody inserts a line, so nothing here is keyed by row number; the 34
-- imported entries carry their original number as PROVENANCE only
-- (`workbook_entry_no`), and the rule key is the stable `parameter_key` from
-- src/forms/registry.ts.
--
-- As at the 2026-10-24 workbook read, 0 of the 34 entries are approved. The
-- seed imports them all as `reference_only` with no approver, so every
-- measurement assesses as Not Assessable until a Quality Supervisor approves a
-- rule here. That is the specified behaviour (FR-009, UAT-05, risk R-01), not
-- a gap to be filled in by seeding a plausible number. Rule 7: no numeric
-- acceptance limit is invented anywhere.
-- ===========================================================================


-- Mirrors SPEC_STATUSES in src/lib/assessment.ts, in the same order.
-- `reference_only` is the status of an imported workbook entry: preserved for
-- reference, never assessable.
create type public.spec_status as enum (
  'draft',
  'proposed',
  'approved',
  'rejected',
  'superseded',
  'reference_only'
);

-- The four status strings found in the live workbook `Limits` tab. The fourth
-- is undocumented in the PRD and was discovered in the 2026-10-24 read. NONE
-- of them maps to `approved`.
create type public.workbook_limit_status as enum (
  'To set',
  'Set',
  'Confirm with Polinutri',
  'To set with Polinutri'
);


-- ---------------------------------------------------------------------------
-- specifications  one row per quality parameter.
--
-- `parameter_key` is the stable identity. It is the same string the registry
-- puts on a field (`conditioned.temperature`), which is how a measurement
-- finds its candidate rules without anything knowing a column index or a
-- spreadsheet row.
-- ---------------------------------------------------------------------------

create table public.specifications (
  id                    uuid primary key default gen_random_uuid(),
  parameter_key         text not null unique,
  stage                 public.sample_stage not null,
  title                 text not null,
  -- The `Limits` tab's own wording for the thing being limited, kept so a
  -- process owner can recognise the row they signed off.
  workbook_sample_label text,
  workbook_test_label   text,
  -- True where the parameter describes a MACHINE SETTING rather than a product
  -- test result. A setting outside a working range is a process-control
  -- signal, not a product conformity decision, and the two must not be
  -- conflated when a rule is eventually approved (workbook verification
  -- decision D-09).
  is_machine_setting    boolean not null default false,
  notes                 text,
  created_at            timestamptz not null default now(),
  created_by            uuid references public.profiles (id),

  constraint specifications_parameter_key_shape
    check (parameter_key ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$'),
  constraint specifications_title_present check (length(btrim(title)) > 0)
);

create index specifications_stage_idx on public.specifications (stage);

comment on column public.specifications.parameter_key is
  'Stable rule key, matching FieldDef.parameterKey in src/forms/registry.ts. No spreadsheet row number is ever a rule key (PRD section 7.1).';


-- ---------------------------------------------------------------------------
-- specification_versions  immutable rule versions.
--
-- A version is written once. After that only its lifecycle may move:
--   draft -> proposed -> approved | rejected,  approved -> superseded
-- and the fields that record those transitions. Every value that decides an
-- assessment  bounds, unit, applicability, effective dates  is frozen, so a
-- past decision stays reproducible (UAT-12, PRD section 7.3).
--
-- Two-person approval is a CHECK, not a convention: an approved version must
-- name BOTH a proposer and an approver, and they must be different people.
-- There is no code path that can produce a self-approved rule, because the row
-- itself would be rejected by the database.
-- ---------------------------------------------------------------------------

create table public.specification_versions (
  id               uuid primary key default gen_random_uuid(),
  specification_id uuid not null references public.specifications (id) on delete restrict,
  version          integer not null,
  -- Denormalised from the parent so the assessment query needs one table.
  parameter_key    text not null,
  stage            public.sample_stage not null,

  -- Applicability filters. NULL means "applies regardless", which scores lower
  -- on specificity than a filter that pins the value down (src/lib/assessment.ts).
  material_code    text references public.materials (code),
  feed_type_code   text references public.feed_types (code),
  sampling_point   text references public.sampling_points (code),
  test_method      text,

  -- Unit VERBATIM from the source, including the literal string 'to confirm'
  -- for workbook entry 13. A non-dimensional unit string is what makes
  -- isUnitConfirmed() false, so the unconfirmed-unit gate is driven by data
  -- and not by a hardcoded field name (UAT-07, risk R-02).
  unit             text,
  lower_bound      numeric,
  upper_bound      numeric,

  status           public.spec_status not null default 'draft',
  effective_from   timestamptz not null,
  effective_to     timestamptz,

  proposed_by      uuid references public.profiles (id),
  proposed_at      timestamptz,
  approved_by      uuid references public.profiles (id),
  approved_at      timestamptz,
  rejected_by      uuid references public.profiles (id),
  rejected_at      timestamptz,
  decision_reason  text,

  -- Where the rule came from. Mandatory: a limit with no stated source cannot
  -- be defended in an audit (PRD section 7.3).
  source_evidence  text not null,
  -- Provenance of an imported workbook row. NEVER a rule key.
  workbook_entry_no integer,
  workbook_status   public.workbook_limit_status,

  supersedes       uuid references public.specification_versions (id),
  created_at       timestamptz not null default now(),

  unique (specification_id, version),
  constraint specification_versions_version_positive check (version >= 1),
  constraint specification_versions_bounds_ordered
    check (lower_bound is null or upper_bound is null or upper_bound >= lower_bound),
  constraint specification_versions_bounds_finite check (
    (lower_bound is null or (lower_bound = lower_bound
       and lower_bound > '-Infinity'::numeric and lower_bound < 'Infinity'::numeric))
    and
    (upper_bound is null or (upper_bound = upper_bound
       and upper_bound > '-Infinity'::numeric and upper_bound < 'Infinity'::numeric))
  ),
  constraint specification_versions_window
    check (effective_to is null or effective_to > effective_from),
  constraint specification_versions_source_present
    check (length(btrim(source_evidence)) > 0),

  -- TWO-PERSON APPROVAL. An approved rule names a proposer and a different
  -- approver, and records when. Nothing else may carry an approver at all.
  constraint specification_versions_two_person_approval check (
    case
      when status = 'approved' then
        proposed_by is not null
        and approved_by is not null
        and approved_by <> proposed_by
        and approved_at is not null
      when status = 'superseded' then
        -- A superseded rule was approved once and keeps that evidence.
        approved_by is null or approved_by is distinct from proposed_by
      else
        approved_by is null and approved_at is null
    end
  ),
  constraint specification_versions_approval_pair
    check ((approved_by is null) = (approved_at is null)),
  constraint specification_versions_rejection_pair
    check ((rejected_by is null) = (rejected_at is null)),
  constraint specification_versions_rejected_has_reason
    check (status <> 'rejected'
           or (rejected_by is not null and length(btrim(coalesce(decision_reason, ''))) > 0)),
  constraint specification_versions_proposal_pair
    check ((proposed_by is null) = (proposed_at is null)),
  -- An imported reference row has no proposer and no approver. It exists to be
  -- read, and it can never decide anything.
  constraint specification_versions_reference_only_unapproved
    check (status <> 'reference_only' or (approved_by is null and proposed_by is null)),
  -- An imported row carries its workbook provenance; a locally authored rule
  -- carries neither field.
  constraint specification_versions_workbook_provenance
    check ((workbook_entry_no is null) = (workbook_status is null)),
  constraint specification_versions_superseded_has_end
    check (status <> 'superseded' or effective_to is not null)
);

create index specification_versions_lookup_idx
  on public.specification_versions (parameter_key, stage, status);

-- The hot path of the assessment engine: approved, effective rules for one
-- parameter. Partial, so the 34 unapproved reference rows are not scanned.
create index specification_versions_approved_idx
  on public.specification_versions (parameter_key, stage, effective_from, effective_to)
  where status = 'approved';

create index specification_versions_spec_idx
  on public.specification_versions (specification_id, version desc);

comment on constraint specification_versions_two_person_approval on public.specification_versions is
  'Two-person approval as a database constraint: approved_by must exist and must differ from proposed_by. A self-approved rule cannot be stored, whatever the calling code does.';


-- Now that specification_versions exists, close the measurement evidence link.
alter table public.sample_measurements
  add constraint sample_measurements_rule_fk
  foreign key (rule_id) references public.specification_versions (id) on delete restrict;


-- ---------------------------------------------------------------------------
-- Immutability.
--
-- A trigger rather than a privilege, because REVOKE cannot bind a table's
-- owner and the SECURITY DEFINER functions that write this table run as the
-- owner. The frozen list is every column that could change an assessment.
-- ---------------------------------------------------------------------------

create function public.tg_specification_versions_guard()
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
    ) then
      raise exception 'A specification version cannot move from % to %', old.status, new.status
        using errcode = '23514';
    end if;
  end if;

  return new;
end;
$$;

create trigger specification_versions_guard
  before update or delete on public.specification_versions
  for each row execute function public.tg_specification_versions_guard();


-- ---------------------------------------------------------------------------
-- assessments  append-only evidence of every evaluation.
--
-- sample_measurements carries the CURRENT assessment so a list query is one
-- scan. This table carries every assessment ever made, with the measured value
-- and the rule bounds as they stood at that moment. A later approval therefore
-- cannot rewrite a past decision; a controlled reassessment writes a NEW row
-- pointing at the one it supersedes, so the old and new decisions sit side by
-- side (PRD section 7.3, UAT-12).
-- ---------------------------------------------------------------------------

create table public.assessments (
  id                 uuid primary key default gen_random_uuid(),
  sample_uuid        uuid not null references public.samples (id) on delete restrict,
  -- RESTRICT, not SET NULL: this table is append-only, and SET NULL is an
  -- UPDATE, which the append-only trigger would refuse  turning a legitimate
  -- cascade into a confusing failure. A measurement with an assessment against
  -- it is part of the quality record and is not deletable at all.
  measurement_id     uuid references public.sample_measurements (id) on delete restrict,
  stage              public.sample_stage not null,
  field_key          text not null,
  parameter_key      text,

  -- The value as it stood when this assessment was made.
  measured_numeric   numeric,
  measured_entered_text text,
  measured_unit      text,

  result             public.assessment_result not null,
  reason             public.assessment_reason not null,

  -- The deciding rule, snapshotted. rule_id may be null (no approved rule
  -- applied), but when it is present the bounds are copied so the decision can
  -- be re-read without joining to a row that may since have been superseded.
  rule_id            uuid references public.specification_versions (id) on delete restrict,
  rule_version       integer,
  rule_lower_bound   numeric,
  rule_upper_bound   numeric,
  rule_unit          text,
  -- How many equally applicable approved rules were found. More than one is
  -- `ambiguous_rules`, which is Not Assessable and must be resolved by Quality.
  candidate_count    integer not null default 0,

  explanation        text not null,
  evaluation_kind    text not null default 'initial',
  supersedes         uuid references public.assessments (id) on delete restrict,
  evaluated_at       timestamptz not null default now(),
  evaluated_by       uuid references public.profiles (id),
  -- The deployment that produced the decision, so a behaviour change can be
  -- attributed (NFR-005).
  deployment_version text,

  foreign key (stage, field_key) references public.stage_fields (stage, field_key),
  constraint assessments_explanation_present check (length(btrim(explanation)) > 0),
  constraint assessments_rule_pair check ((rule_id is null) = (rule_version is null)),
  constraint assessments_candidate_count_nonneg check (candidate_count >= 0),
  constraint assessments_evaluation_kind_valid
    check (evaluation_kind in ('initial', 'correction', 'controlled_reassessment')),
  -- A reassessment must say what it replaces.
  constraint assessments_reassessment_supersedes
    check (evaluation_kind <> 'controlled_reassessment' or supersedes is not null),
  -- within_limit and outside_limit are the only results that may name a rule,
  -- and they MUST name one: a conformity decision without an approved rule
  -- behind it is exactly what this system exists to prevent.
  constraint assessments_decision_requires_rule check (
    case
      when result in ('within_limit', 'outside_limit') then rule_id is not null
      else true
    end
  ),
  constraint assessments_reason_matches_result check (
    case result
      when 'within_limit'   then reason = 'within_approved_bounds'
      when 'outside_limit'  then reason = 'outside_approved_bounds'
      when 'not_applicable' then reason = 'field_not_applicable'
      when 'not_tested'     then reason = 'no_result_recorded'
      when 'not_assessable' then reason in (
        'value_not_finite', 'unit_not_confirmed', 'no_approved_rule',
        'ambiguous_rules', 'unit_mismatch', 'rule_has_no_bounds'
      )
    end
  )
);

create index assessments_sample_idx on public.assessments (sample_uuid, evaluated_at desc);
create index assessments_measurement_idx on public.assessments (measurement_id);
create index assessments_result_idx on public.assessments (result)
  where result in ('outside_limit', 'not_assessable');

comment on constraint assessments_reason_matches_result on public.assessments is
  'Keeps result and reason from drifting apart. A row claiming within_limit for the reason no_approved_rule is incoherent evidence and is rejected.';

-- Append-only. UPDATE and DELETE are blocked by trigger, which binds the owner
-- and every SECURITY DEFINER writer, not only `authenticated`.
create function public.tg_append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception '% is append-only: % is not permitted', tg_table_name, tg_op
    using errcode = '23514',
          hint = 'Write a new row that supersedes the old one.';
end;
$$;

create trigger assessments_append_only
  before update or delete on public.assessments
  for each row execute function public.tg_append_only();


-- ---------------------------------------------------------------------------
-- Row level security.
-- ---------------------------------------------------------------------------

alter table public.specifications          enable row level security;
alter table public.specification_versions  enable row level security;
alter table public.assessments             enable row level security;

-- Any active user may READ the ruleset. Seeing that a limit is unapproved is
-- the point: an operator must be able to tell that nothing has been decided.
create policy specifications_select_active on public.specifications
  for select to authenticated using (public.is_active_user());

create policy specification_versions_select_active on public.specification_versions
  for select to authenticated using (public.is_active_user());

create policy assessments_select_viewers on public.assessments
  for select to authenticated
  using (public.has_permission('sample.view'));

-- No INSERT, UPDATE or DELETE policy on any of the three. Specifications are
-- written by public.propose_specification() and public.approve_specification()
-- and assessments by the evaluation path, all SECURITY DEFINER. A client
-- cannot author a limit, approve one, or write an assessment, by any route.


-- ---------------------------------------------------------------------------
-- Privileges.
-- ---------------------------------------------------------------------------

revoke all on public.specifications         from anon, authenticated;
revoke all on public.specification_versions from anon, authenticated;
revoke all on public.assessments            from anon, authenticated;

grant select on public.specifications         to authenticated;
grant select on public.specification_versions to authenticated;
grant select on public.assessments            to authenticated;

revoke all on function public.tg_specification_versions_guard() from public;
revoke all on function public.tg_append_only() from public;
