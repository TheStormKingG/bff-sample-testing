-- ===========================================================================
-- 0001_identity.sql
--
-- Identity, roles, permissions, account lifecycle and recorded delegation.
--
-- This migration is the security boundary that `src/lib/roles.ts` describes.
-- The TypeScript copy of the matrix drives the UI and is unit-tested; it is
-- NOT the boundary. Everything below is enforced by Postgres privileges, row
-- level security and SECURITY DEFINER functions, so a client that calls the
-- REST API directly  bypassing the UI entirely  gets the same answers.
--
-- Three rules from the PRD are structural here rather than procedural:
--   * An Administrator has NO quality authority. It cannot approve a
--     specification, clear a hold or release material (PRD section 2).
--   * A Quality Officer may RAISE a hold but not CLEAR one.
--   * `disposition.override_release` is granted to NO role. It exists only as
--     a time-bounded, recorded delegation.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- Controlled vocabularies, as enum types.
--
-- An enum rather than a text column with a CHECK: a typo in a role name then
-- fails at parse time in every statement that mentions it, including inside a
-- policy, instead of silently never matching a row.
-- ---------------------------------------------------------------------------

create type public.app_role as enum (
  'operator',
  'quality_officer',
  'quality_supervisor',
  'administrator',
  'auditor'
);

create type public.user_status as enum (
  'pending',
  'active',
  'suspended',
  'disabled'
);

-- The 22 permissions of src/lib/roles.ts, in the same order.
create type public.app_permission as enum (
  'sample.view',
  'sample.draft',
  'sample.register',
  'sample.enter_results',
  'sample.correct',
  'sample.void',
  'sample.review',
  'disposition.accept',
  'disposition.reject',
  'disposition.rework',
  'hold.raise',
  'hold.clear',
  'disposition.override_release',
  'spec.propose',
  'spec.approve',
  'user.manage',
  'user.approve_access',
  'sync.view',
  'sync.retry',
  'audit.view',
  'report.view',
  'export.run'
);


-- ---------------------------------------------------------------------------
-- profiles  one row per authenticated identity.
--
-- A Google sign-in creates an `auth.users` row, which creates a profile here
-- with status 'pending'. A pending profile holds no permission at all, so
-- proving who you are grants nothing (rule 4).
-- ---------------------------------------------------------------------------

create table public.profiles (
  id                    uuid primary key references auth.users (id) on delete restrict,
  email                 text not null,
  display_name          text not null,
  status                public.user_status not null default 'pending',
  -- How this account came to be active. Null while pending.
  --   'approved_by_administrator'    a named person with user.approve_access
  --   'first_administrator_bootstrap' the one-shot founding grant, which by
  --                                   definition has no approver yet
  approval_basis        text,
  approved_by           uuid references public.profiles (id),
  approved_at           timestamptz,
  -- NFR-002 periodic access recertification.
  last_access_review_at timestamptz,
  last_seen_at          timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  constraint profiles_email_present check (length(btrim(email)) > 0),
  constraint profiles_display_name_present check (length(btrim(display_name)) > 0),
  constraint profiles_approval_basis_valid check (
    approval_basis is null
    or approval_basis in ('approved_by_administrator', 'first_administrator_bootstrap')
  ),
  -- An active account must carry evidence of HOW it was let in. Peer approval
  -- names the approver; the founding bootstrap cannot, because there is nobody
  -- else in the system at that moment, so it records the basis and the time
  -- and leaves the approver explicitly absent rather than pointing at itself.
  constraint profiles_active_requires_approval check (
    status <> 'active'
    or (approval_basis = 'approved_by_administrator'
        and approved_by is not null and approved_at is not null)
    or (approval_basis = 'first_administrator_bootstrap'
        and approved_by is null and approved_at is not null)
  ),
  -- Nobody approves their own access (mirrors checkSeparationOfDuties).
  constraint profiles_no_self_approval check (approved_by is distinct from id)
);

-- Email identity is case-insensitive; Google returns a canonical address but a
-- hand-entered allowlist row may not match its case.
create unique index profiles_email_lower_key on public.profiles (lower(email));
create index profiles_status_idx on public.profiles (status);

-- At most one profile may ever carry the founding basis. All such rows hold
-- the same literal value, so a unique index on that value permits exactly one.
-- This is the structural half of the one-shot bootstrap: even if the allowlist
-- were refilled by hand, a second founding administrator cannot be recorded.
create unique index profiles_single_bootstrap_basis
  on public.profiles (approval_basis)
  where approval_basis = 'first_administrator_bootstrap';

comment on table public.profiles is
  'One row per authenticated identity. New sign-ins are pending and hold no permission.';
comment on column public.profiles.status is
  'pending | active | suspended | disabled. Only active holds any permission.';


-- ---------------------------------------------------------------------------
-- user_roles  role membership.
--
-- There is no INSERT, UPDATE or DELETE policy on this table and no DML
-- privilege for `authenticated`, so self-elevation is not merely denied, it is
-- unreachable: the only writer is public.grant_role(), which refuses to act on
-- the calling user.
-- ---------------------------------------------------------------------------

create table public.user_roles (
  user_id    uuid not null references public.profiles (id) on delete restrict,
  role       public.app_role not null,
  granted_by uuid references public.profiles (id),
  granted_at timestamptz not null default now(),
  reason     text,
  primary key (user_id, role),
  -- A user cannot be the source of their own role grant. The founding
  -- administrator's row carries a null grantor and the audit event carries the
  -- bootstrap evidence instead.
  constraint user_roles_no_self_grant check (granted_by is distinct from user_id)
);

create index user_roles_role_idx on public.user_roles (role);


-- ---------------------------------------------------------------------------
-- role_permissions  the base matrix, mirroring src/lib/roles.ts exactly.
-- ---------------------------------------------------------------------------

-- The permissions that are delegation-only: never a base grant for any role.
-- IMMUTABLE so it can be used inside a CHECK constraint, which is what makes
-- the exclusion structural. Seeding the matrix correctly is not enough on its
-- own  a later migration, or an operator with table access, could add the
-- row. The constraint means that insert fails.
create function public.delegation_only_permissions()
returns public.app_permission[]
language sql
immutable
parallel safe
set search_path = ''
as $$
  select array['disposition.override_release']::public.app_permission[];
$$;

create table public.role_permissions (
  role       public.app_role not null,
  permission public.app_permission not null,
  primary key (role, permission),
  constraint role_permissions_excludes_delegation_only
    check (not (permission = any (public.delegation_only_permissions())))
);

comment on constraint role_permissions_excludes_delegation_only on public.role_permissions is
  'disposition.override_release is granted to no role. It is reachable only through user_delegations, which is time-bounded and audited.';

-- operator  may take and register a sample, and may stop material (hold.raise).
-- Stopping material never needs an override; only releasing it does.
insert into public.role_permissions (role, permission) values
  ('operator', 'sample.view'),
  ('operator', 'sample.draft'),
  ('operator', 'sample.register'),
  ('operator', 'hold.raise');

-- quality_officer  tests and corrects, proposes limits, raises holds.
-- Deliberately WITHOUT hold.clear, spec.approve and every disposition.
insert into public.role_permissions (role, permission) values
  ('quality_officer', 'sample.view'),
  ('quality_officer', 'sample.draft'),
  ('quality_officer', 'sample.register'),
  ('quality_officer', 'sample.enter_results'),
  ('quality_officer', 'sample.correct'),
  ('quality_officer', 'sample.review'),
  ('quality_officer', 'hold.raise'),
  ('quality_officer', 'spec.propose'),
  ('quality_officer', 'report.view'),
  ('quality_officer', 'sync.view');

-- quality_supervisor  the quality authority: clears holds, approves limits,
-- records dispositions. Still cannot record an override release without a
-- delegation.
insert into public.role_permissions (role, permission) values
  ('quality_supervisor', 'sample.view'),
  ('quality_supervisor', 'sample.draft'),
  ('quality_supervisor', 'sample.register'),
  ('quality_supervisor', 'sample.enter_results'),
  ('quality_supervisor', 'sample.correct'),
  ('quality_supervisor', 'sample.void'),
  ('quality_supervisor', 'sample.review'),
  ('quality_supervisor', 'disposition.accept'),
  ('quality_supervisor', 'disposition.reject'),
  ('quality_supervisor', 'disposition.rework'),
  ('quality_supervisor', 'hold.raise'),
  ('quality_supervisor', 'hold.clear'),
  ('quality_supervisor', 'spec.propose'),
  ('quality_supervisor', 'spec.approve'),
  ('quality_supervisor', 'report.view'),
  ('quality_supervisor', 'export.run'),
  ('quality_supervisor', 'audit.view'),
  ('quality_supervisor', 'sync.view');

-- administrator  runs the system, has NO quality authority. No spec.approve,
-- no hold.clear, no disposition of any kind, and no sample.register.
insert into public.role_permissions (role, permission) values
  ('administrator', 'sample.view'),
  ('administrator', 'user.manage'),
  ('administrator', 'user.approve_access'),
  ('administrator', 'sync.view'),
  ('administrator', 'sync.retry'),
  ('administrator', 'audit.view'),
  ('administrator', 'report.view');

-- auditor  reads only.
insert into public.role_permissions (role, permission) values
  ('auditor', 'sample.view'),
  ('auditor', 'audit.view'),
  ('auditor', 'report.view');


-- ---------------------------------------------------------------------------
-- user_delegations  recorded, time-bounded grants beyond the base role.
--
-- This is how a Quality Officer may be given disposition authority for a
-- fortnight without widening the role for everyone (PRD section 2:
-- "segregation of duties is configurable").
-- ---------------------------------------------------------------------------

create table public.user_delegations (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.profiles (id) on delete restrict,
  permission      public.app_permission not null,
  granted_by      uuid not null references public.profiles (id),
  granted_at      timestamptz not null default now(),
  effective_from  timestamptz not null,
  effective_to    timestamptz,
  reason          text not null,
  authority_basis text not null,
  revoked_by      uuid references public.profiles (id),
  revoked_at      timestamptz,
  revoke_reason   text,

  constraint user_delegations_reason_present check (length(btrim(reason)) > 0),
  constraint user_delegations_window check (effective_to is null or effective_to > effective_from),
  -- Nobody delegates authority to themselves.
  constraint user_delegations_no_self_grant check (granted_by <> user_id),
  constraint user_delegations_revocation_complete
    check ((revoked_by is null) = (revoked_at is null)),
  constraint user_delegations_revoke_reason
    check (revoked_at is null or length(btrim(coalesce(revoke_reason, ''))) > 0)
);

create index user_delegations_lookup_idx
  on public.user_delegations (user_id, permission)
  where revoked_at is null;

comment on table public.user_delegations is
  'Time-bounded recorded delegations. The only route to disposition.override_release.';


-- ---------------------------------------------------------------------------
-- Authority functions.
--
-- These mirror `can()` in src/lib/roles.ts: a non-active account holds
-- nothing, a delegation wins, and a delegation-only permission never comes
-- from a base role.
--
-- All of them are SECURITY DEFINER with `search_path = ''`. The empty search
-- path means every unqualified name fails to resolve, so each object is named
-- in full below. Without it, a caller who can create objects in a schema that
-- precedes `public` in their own search_path could substitute a table or an
-- operator and change what the function sees  the function runs with the
-- definer's privileges, so that substitution would run privileged.
--
-- They read public.profiles and public.user_roles, which have row level
-- security enabled. A SECURITY DEFINER function executes as the table owner,
-- and RLS does not apply to a table's owner unless FORCE ROW LEVEL SECURITY
-- is set. It deliberately is not set anywhere in this schema: these functions
-- must see every row to answer the question, and the policies that call them
-- would otherwise recurse.
-- ---------------------------------------------------------------------------

create function public.current_user_status()
returns public.user_status
language sql
stable
security definer
set search_path = ''
as $$
  select p.status from public.profiles p where p.id = auth.uid();
$$;

comment on function public.current_user_status() is
  'Account status of the calling identity, or NULL when unauthenticated or not provisioned.';

create function public.is_active_user()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(public.current_user_status() = 'active', false);
$$;

create function public.has_permission(p_permission public.app_permission)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    public.is_active_user()
    and (
      -- An active, unrevoked, in-window delegation grants the permission
      -- outright. Checked first because it is the only route to a
      -- delegation-only permission.
      exists (
        select 1
        from public.user_delegations d
        where d.user_id = auth.uid()
          and d.permission = p_permission
          and d.revoked_at is null
          and d.effective_from <= now()
          and (d.effective_to is null or d.effective_to > now())
      )
      or (
        not (p_permission = any (public.delegation_only_permissions()))
        and exists (
          select 1
          from public.user_roles ur
          join public.role_permissions rp on rp.role = ur.role
          where ur.user_id = auth.uid()
            and rp.permission = p_permission
        )
      )
    );
$$;

comment on function public.has_permission(public.app_permission) is
  'Server-side authority check mirroring can() in src/lib/roles.ts. Hiding a UI button is not a control; this is.';

-- The authority basis actually used, recorded on holds, dispositions and audit
-- events so a decision can be explained years later (NFR-005).
create function public.authority_basis(p_permission public.app_permission)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_delegation uuid;
  v_role       public.app_role;
begin
  select d.id into v_delegation
  from public.user_delegations d
  where d.user_id = auth.uid()
    and d.permission = p_permission
    and d.revoked_at is null
    and d.effective_from <= now()
    and (d.effective_to is null or d.effective_to > now())
  order by d.granted_at desc
  limit 1;

  if v_delegation is not null then
    return 'delegation:' || v_delegation::text;
  end if;

  if p_permission = any (public.delegation_only_permissions()) then
    return null;
  end if;

  select ur.role into v_role
  from public.user_roles ur
  join public.role_permissions rp on rp.role = ur.role
  where ur.user_id = auth.uid()
    and rp.permission = p_permission
  order by ur.role
  limit 1;

  if v_role is null then
    return null;
  end if;

  return 'base_role:' || v_role::text;
end;
$$;


-- ---------------------------------------------------------------------------
-- Separation of duties, mirroring checkSeparationOfDuties().
-- Returns NULL when the action is permitted, or the failure reason.
-- ---------------------------------------------------------------------------

create function public.separation_of_duties_failure(
  p_action               text,
  p_actor_id             uuid,
  p_subject_actor_id     uuid,
  p_override_approved_by uuid default null
)
returns text
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_subject_actor_id is null or p_actor_id <> p_subject_actor_id then
    return null;
  end if;

  -- An override must come from a different person, or it is the same
  -- self-approval wearing a second name.
  if p_override_approved_by is not null and p_override_approved_by <> p_actor_id then
    return null;
  end if;

  case p_action
    when 'approve_specification' then return 'self_approval_of_specification';
    when 'review_exception'      then return 'self_review_of_own_exception';
    when 'approve_access'        then return 'self_access_approval';
    else
      raise exception 'Unknown separation-of-duties action %', p_action
        using errcode = '22023';
  end case;
end;
$$;


-- ---------------------------------------------------------------------------
-- updated_at maintenance.
-- ---------------------------------------------------------------------------

create function public.tg_set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.tg_set_updated_at();


-- ---------------------------------------------------------------------------
-- First-administrator bootstrap allowlist.
--
-- No personal email is hardcoded anywhere. An administrator's address is
-- supplied once, out of band, as a session setting (see
-- 0014_bootstrap_first_admin.sql), lands here, and is CONSUMED the first time
-- that identity signs in. A consumed row cannot provision a second
-- administrator, and public.bootstrap_first_administrator() refuses outright
-- once any administrator exists.
-- ---------------------------------------------------------------------------

create table public.bootstrap_admin_grants (
  email        text primary key,
  created_at   timestamptz not null default now(),
  created_note text not null default 'first-administrator bootstrap',
  consumed_at  timestamptz,
  consumed_by  uuid references public.profiles (id),
  constraint bootstrap_admin_grants_email_lower check (email = lower(btrim(email))),
  constraint bootstrap_admin_grants_email_shaped check (email like '%_@_%._%'),
  constraint bootstrap_admin_grants_consumption
    check ((consumed_at is null) = (consumed_by is null))
);

comment on table public.bootstrap_admin_grants is
  'One-shot allowlist for the very first administrator. Rows are consumed on first sign-in and never reusable.';


-- ---------------------------------------------------------------------------
-- auth.users -> profiles.
--
-- The documented Supabase pattern. SECURITY DEFINER because the inserting
-- role is `supabase_auth_admin`, which holds no privilege on public tables.
--
-- It references public.audit_events, created in 0005. A plpgsql body is
-- resolved when it runs, not when it is created, and the trigger cannot fire
-- before the whole migration set has been applied, so the forward reference is
-- safe. 0013_security_posture.sql proves it by executing the path.
-- ---------------------------------------------------------------------------

create function public.tg_handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email       text := lower(btrim(coalesce(new.email, '')));
  v_display     text;
  v_grant_email text;
  v_admin_count integer;
begin
  if v_email = '' then
    -- Fail closed. Every identity in this system is a named person with a
    -- verifiable address; an anonymous one must not reach the ledger.
    raise exception 'A sign-in without an email address cannot be provisioned'
      using errcode = '23514';
  end if;

  v_display := nullif(btrim(coalesce(new.raw_user_meta_data ->> 'full_name', '')), '');
  if v_display is null then
    v_display := nullif(btrim(coalesce(new.raw_user_meta_data ->> 'name', '')), '');
  end if;
  if v_display is null then
    v_display := split_part(v_email, '@', 1);
  end if;

  insert into public.profiles (id, email, display_name, status)
  values (new.id, v_email, v_display, 'pending')
  on conflict (id) do nothing;

  insert into public.audit_events (
    actor_id, actor_email, action, entity_type, entity_id, after_payload, outcome
  )
  values (
    new.id, v_email, 'identity.provisioned', 'profile', new.id::text,
    jsonb_build_object('email', v_email, 'status', 'pending'), 'succeeded'
  );

  -- One-shot first-administrator bootstrap.
  select count(*) into v_admin_count
  from public.user_roles ur
  where ur.role = 'administrator';

  if v_admin_count = 0 then
    -- FOR UPDATE serialises two first sign-ins racing for the same grant; in
    -- READ COMMITTED the predicate is re-evaluated after the lock is acquired,
    -- so the loser sees the row already consumed.
    select g.email into v_grant_email
    from public.bootstrap_admin_grants g
    where g.email = v_email
      and g.consumed_at is null
    for update;

    if v_grant_email is not null then
      update public.profiles
         set status         = 'active',
             approval_basis = 'first_administrator_bootstrap',
             approved_by    = null,
             approved_at    = now()
       where id = new.id;

      insert into public.user_roles (user_id, role, granted_by, reason)
      values (new.id, 'administrator', null, 'first-administrator bootstrap');

      update public.bootstrap_admin_grants
         set consumed_at = now(),
             consumed_by = new.id
       where email = v_grant_email;

      insert into public.audit_events (
        actor_id, actor_email, action, entity_type, entity_id, reason, after_payload, outcome
      )
      values (
        new.id, v_email, 'identity.bootstrap_administrator', 'profile', new.id::text,
        'First-administrator bootstrap allowlist consumed',
        jsonb_build_object('role', 'administrator', 'status', 'active'), 'succeeded'
      );
    end if;
  end if;

  return new;
end;
$$;

comment on function public.tg_handle_new_auth_user() is
  'Creates a pending profile for every new identity, and consumes the first-administrator allowlist when one is present and no administrator exists.';

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.tg_handle_new_auth_user();


-- ---------------------------------------------------------------------------
-- Row level security.
--
-- Deny by default: RLS is enabled on every table and a table with no policy
-- returns nothing to anyone but its owner. Policies below are additive and
-- each one re-checks that the caller is an active user, because a suspended
-- account must lose access the moment its status changes, not at next login.
-- ---------------------------------------------------------------------------

alter table public.profiles               enable row level security;
alter table public.user_roles             enable row level security;
alter table public.role_permissions       enable row level security;
alter table public.user_delegations       enable row level security;
alter table public.bootstrap_admin_grants enable row level security;

-- A pending user may read their OWN profile, and nothing else. Without this
-- the application cannot tell them they are awaiting approval. It discloses
-- only what they already supplied at sign-in.
create policy profiles_select_self on public.profiles
  for select to authenticated
  using (id = auth.uid());

-- Active users may read the staff directory: a sample shows who registered it
-- and who tested it, so names must resolve. Still restricted to active
-- accounts, so a pending identity sees no colleague.
create policy profiles_select_directory on public.profiles
  for select to authenticated
  using (public.is_active_user());

-- Self-service display name only. The column list on the GRANT below is what
-- actually prevents a user from writing `status`; this policy restricts which
-- ROW may be updated, the grant restricts which COLUMN.
create policy profiles_update_own_display_name on public.profiles
  for update to authenticated
  using (id = auth.uid() and public.is_active_user())
  with check (id = auth.uid());

create policy user_roles_select_self_or_manager on public.user_roles
  for select to authenticated
  using (
    user_id = auth.uid()
    or public.has_permission('user.manage')
    or public.has_permission('audit.view')
  );

create policy role_permissions_select_active on public.role_permissions
  for select to authenticated
  using (public.is_active_user());

create policy user_delegations_select_self_or_manager on public.user_delegations
  for select to authenticated
  using (
    user_id = auth.uid()
    or public.has_permission('user.manage')
    or public.has_permission('audit.view')
  );

-- bootstrap_admin_grants gets no policy at all. It is readable and writable
-- only by the SECURITY DEFINER functions that own the bootstrap path.


-- ---------------------------------------------------------------------------
-- Table privileges.
--
-- A Supabase project's default privileges grant new tables in `public` to
-- `anon` and `authenticated`. That grant IS recorded at CREATE TABLE time, so
-- revoking it here works. The reverse  relying on
-- `ALTER DEFAULT PRIVILEGES ... REVOKE ... FROM PUBLIC` to protect objects
-- created later  does not: a revoke can only delete a grant that was
-- recorded, and for functions the hazard comes from a built-in default that
-- is never recorded anywhere. See the function grants below, and
-- 0013_security_posture.sql, which reads the catalogue back rather than
-- trusting that these statements had the intended effect.
-- ---------------------------------------------------------------------------

revoke all on public.profiles               from anon, authenticated;
revoke all on public.user_roles             from anon, authenticated;
revoke all on public.role_permissions       from anon, authenticated;
revoke all on public.user_delegations       from anon, authenticated;
revoke all on public.bootstrap_admin_grants from anon, authenticated;

-- `anon` is granted nothing anywhere in this schema. An unauthenticated caller
-- gets an empty result or a permission error, never a row.
grant select on public.profiles         to authenticated;
grant select on public.user_roles       to authenticated;
grant select on public.role_permissions to authenticated;
grant select on public.user_delegations to authenticated;

-- Column-level UPDATE. This is the control that makes self-elevation
-- impossible rather than unlikely: `status`, `approval_basis`, `approved_by`
-- and `email` are not in the list, so an UPDATE naming any of them is
-- rejected by the privilege system before any policy or trigger runs.
grant update (display_name) on public.profiles to authenticated;


-- ---------------------------------------------------------------------------
-- Function privileges.
--
-- CREATE FUNCTION grants EXECUTE to PUBLIC by default, and that default is
-- NOT a recorded ACL entry  the function's `proacl` is simply null, which
-- means "the built-in default applies". Two consequences:
--
--   1. `ALTER DEFAULT PRIVILEGES ... REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC`
--      is INERT. It runs, returns success, and changes nothing, because there
--      is no recorded grant for it to delete and no negative entry is created.
--      Observed behaviour, not caution: pg_default_acl stays empty and a
--      function created afterwards still answers true to
--      has_function_privilege('public', oid, 'execute').
--   2. An explicit `REVOKE ALL ON FUNCTION <sig> FROM PUBLIC` DOES work,
--      because it forces Postgres to materialise the default ACL first and
--      then removes the PUBLIC entry from it.
--
-- So every function in this schema is revoked and re-granted by name, one
-- signature at a time. Nothing relies on a default, and
-- 0013_security_posture.sql enumerates the catalogue to prove it.
-- ---------------------------------------------------------------------------

revoke all on function public.delegation_only_permissions() from public;
grant execute on function public.delegation_only_permissions() to authenticated, service_role;

revoke all on function public.current_user_status() from public;
grant execute on function public.current_user_status() to authenticated, service_role;

revoke all on function public.is_active_user() from public;
grant execute on function public.is_active_user() to authenticated, service_role;

revoke all on function public.has_permission(public.app_permission) from public;
grant execute on function public.has_permission(public.app_permission) to authenticated, service_role;

revoke all on function public.authority_basis(public.app_permission) from public;
grant execute on function public.authority_basis(public.app_permission) to authenticated, service_role;

revoke all on function public.separation_of_duties_failure(text, uuid, uuid, uuid) from public;
grant execute on function public.separation_of_duties_failure(text, uuid, uuid, uuid) to authenticated, service_role;

-- Trigger functions are invoked by the trigger, never called directly. No role
-- needs EXECUTE, so none is granted  only the PUBLIC default is removed.
revoke all on function public.tg_set_updated_at() from public;
revoke all on function public.tg_handle_new_auth_user() from public;
