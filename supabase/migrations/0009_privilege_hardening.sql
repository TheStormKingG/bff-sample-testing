-- ---------------------------------------------------------------------------
-- 0009_privilege_hardening.sql
--
-- Closes a CONFIRMED, exploitable gap in 0001-0008: every one of those
-- migrations revokes function privileges with
--
--     revoke all on function public.<name>(<args>) from public;
--
-- and that statement does not remove the grants this project actually has. A
-- Supabase project configures
--
--     alter default privileges in schema public
--       grant all on functions to postgres, anon, authenticated, service_role;
--
-- so every function created by a migration arrives with EXECUTE **recorded**
-- for `anon` and `authenticated`. `PUBLIC` is a different grantee from either
-- of them, so revoking PUBLIC deletes nothing that was granted and leaves both
-- roles holding EXECUTE. 0001 and 0002 already state this mechanism in their
-- own comments -- "A Supabase project's default privileges grant new tables in
-- `public` to `anon`" -- and defend against it for TABLES with an explicit
-- `revoke all on <table> from anon, authenticated`. The same defence was never
-- written for FUNCTIONS, so the threat model the migrations describe is only
-- half implemented.
--
-- Measured in a database built from 0001-0008: 25 of 25 functions in `public`
-- were executable by both `anon` and `authenticated`, including every one the
-- author granted to `service_role` alone. Acting as a brand-new sign-in whose
-- profile is `pending` and for which `public.is_active_user()` returns false:
--
--   * public.record_audit_event(...) RETURNED AN EVENT UUID. Its actor and
--     outcome are parameters, so a pending account could append an audit event
--     attributed to any person with outcome 'succeeded'. An audit trail that an
--     unprivileged caller can write to is not an audit trail.
--   * public.allocate_sample_id('RM', current_date) RETURNED 'RM-261024-01',
--     consuming a real identifier from the atomic counter. 0002 grants that
--     function to `service_role` and to nothing else.
--   * public.sample_snapshot(uuid) is SECURITY DEFINER and reads the samples
--     and sample_measurements tables as their owner, so row level security does
--     not apply inside it: a whole quality record, readable by an account that
--     must be able to read nothing.
--   * public.apply_measurement(...), public.apply_hold_triggers(...) and
--     public.enqueue_sheet_sync_event(...) are SECURITY DEFINER writers that
--     0008 grants to NO role at all.
--
-- Two controls, in this order, because only the first is a control:
--
--   1. An explicit per-signature `revoke ... from anon, authenticated` for
--      every function in 0001-0008, followed by the grants the design actually
--      needs. A revoke can only delete a grant that was RECORDED, and these
--      were recorded, so these statements do remove them.
--   2. `alter default privileges ... revoke ... from anon, authenticated`, so
--      a later migration does not reintroduce the grant on every new object.
--      This is DEFENCE IN DEPTH and NOT the control: it only deletes a default
--      that was recorded for the role running this migration, and it does
--      nothing at all for objects that already exist. Never delete the
--      per-signature revokes above on the grounds that this statement is here;
--      on its own it is the inert revoke that caused this defect.
--
-- An assertion at the end of the file fails the migration if any function in
-- `public` is still reachable by `anon`, or if a function outside a named
-- allowlist is reachable by `authenticated`. That is what stops the divergence
-- recurring silently: a future migration that forgets its revoke cannot be
-- applied.
-- ---------------------------------------------------------------------------


-- ---------------------------------------------------------------------------
-- 1. Default privileges. Defence in depth only -- see the note above.
--
-- `alter default privileges` with no `for role` applies to objects created by
-- the role executing this statement, which is the role that runs the
-- migrations. It has no effect on the 25 functions that already exist; part 2
-- deals with those.
-- ---------------------------------------------------------------------------

alter default privileges in schema public revoke all on functions from anon, authenticated;
alter default privileges in schema public revoke all on tables    from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;


-- ---------------------------------------------------------------------------
-- 2. Every function created in 0001-0008, by exact signature.
--
-- `from public` is kept beside each one. It is not redundant: it covers the
-- SQL-standard default, which is what applies if this schema is ever built
-- somewhere that does not configure Supabase's default privileges. The two
-- revokes defend against two different recorded grants and neither implies
-- the other.
-- ---------------------------------------------------------------------------

-- 2a. The authority helpers (0001). `authenticated` genuinely needs EXECUTE on
--     these: they are called from the RLS policy expressions on profiles,
--     samples, assessments and the rest, and a policy expression is evaluated
--     as the invoking role, so without EXECUTE every policy that calls one
--     would error instead of filtering. `anon` holds no privilege on any table
--     in this schema, so no policy is ever evaluated for it and it needs none
--     of these.
revoke all on function public.delegation_only_permissions() from public, anon, authenticated;
grant execute on function public.delegation_only_permissions() to authenticated, service_role;

revoke all on function public.current_user_status() from public, anon, authenticated;
grant execute on function public.current_user_status() to authenticated, service_role;

revoke all on function public.is_active_user() from public, anon, authenticated;
grant execute on function public.is_active_user() to authenticated, service_role;

revoke all on function public.has_permission(public.app_permission) from public, anon, authenticated;
grant execute on function public.has_permission(public.app_permission) to authenticated, service_role;

revoke all on function public.authority_basis(public.app_permission) from public, anon, authenticated;
grant execute on function public.authority_basis(public.app_permission) to authenticated, service_role;

revoke all on function public.separation_of_duties_failure(text, uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.separation_of_duties_failure(text, uuid, uuid, uuid)
  to authenticated, service_role;

revoke all on function public.payload_hash(jsonb) from public, anon, authenticated;
grant execute on function public.payload_hash(jsonb) to authenticated, service_role;

-- 2b. Privileged writers. `service_role` where the Edge Functions call them
--     directly; NO role where they are only ever called from inside another
--     SECURITY DEFINER function, because such a call is authorised as the
--     outer function's definer -- the owner -- and needs no grant at all.
revoke all on function public.record_audit_event(
  text, text, text, uuid, text, jsonb, jsonb, uuid, text, text, text, uuid
) from public, anon, authenticated;
grant execute on function public.record_audit_event(
  text, text, text, uuid, text, jsonb, jsonb, uuid, text, text, text, uuid
) to service_role;

revoke all on function public.allocate_sample_id(text, date) from public, anon, authenticated;
grant execute on function public.allocate_sample_id(text, date) to service_role;

revoke all on function public.sample_snapshot(uuid) from public, anon, authenticated;
grant execute on function public.sample_snapshot(uuid) to service_role;

revoke all on function public.is_unit_confirmed(text) from public, anon, authenticated;
grant execute on function public.is_unit_confirmed(text) to service_role;

revoke all on function public.is_field_applicable(uuid, public.sample_stage, text)
  from public, anon, authenticated;
grant execute on function public.is_field_applicable(uuid, public.sample_stage, text)
  to service_role;

revoke all on function public.evaluate_measurement(
  public.sample_stage, text, numeric, text, boolean, boolean, text, text, text, text, timestamptz
) from public, anon, authenticated;
grant execute on function public.evaluate_measurement(
  public.sample_stage, text, numeric, text, boolean, boolean, text, text, text, text, timestamptz
) to service_role;

revoke all on function public.apply_measurement(uuid, text, numeric, text, text, uuid, text)
  from public, anon, authenticated;
revoke all on function public.apply_hold_triggers(uuid, uuid) from public, anon, authenticated;
revoke all on function public.enqueue_sheet_sync_event(uuid, public.sheet_sync_event_kind)
  from public, anon, authenticated;

-- 2c. Trigger functions. A trigger fires as part of a statement on its table
--     and does not consult EXECUTE on the function, so no role needs a grant.
--     Calling one directly raises "trigger functions can only be called as
--     triggers", which is a refusal and not a control: several of these are
--     SECURITY DEFINER, and a reachable SECURITY DEFINER entry point whose
--     safety rests on a runtime error message is not a boundary worth keeping.
revoke all on function public.tg_set_updated_at()                 from public, anon, authenticated;
revoke all on function public.tg_handle_new_auth_user()           from public, anon, authenticated;
revoke all on function public.tg_samples_derive_prefix()          from public, anon, authenticated;
revoke all on function public.tg_samples_guard_immutable()        from public, anon, authenticated;
revoke all on function public.tg_samples_guard_delete()           from public, anon, authenticated;
revoke all on function public.tg_specification_versions_guard()   from public, anon, authenticated;
revoke all on function public.tg_append_only()                    from public, anon, authenticated;
revoke all on function public.tg_refresh_sample_hold_flag()       from public, anon, authenticated;
revoke all on function public.tg_apply_disposition_to_sample()    from public, anon, authenticated;
revoke all on function public.tg_block_truncate()                 from public, anon, authenticated;
revoke all on function public.tg_guard_fence_token()              from public, anon, authenticated;
revoke all on function public.tg_refresh_sample_sync_state()      from public, anon, authenticated;


-- ---------------------------------------------------------------------------
-- 3. Tables and sequences: assert rather than assume.
--
-- 0001-0008 each revoke their own tables from `anon, authenticated` before
-- granting SELECT back to `authenticated` where a screen needs it, so the
-- table side is already explicit. This statement exists so the claim is
-- checked rather than trusted, and so a table added later without its revoke
-- is caught here.
-- ---------------------------------------------------------------------------

do $$
declare
  v_tables text;
begin
  select string_agg(format('%s (%s)', c.relname, p.privilege_type), ', ' order by c.relname)
    into v_tables
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  cross join lateral aclexplode(c.relacl) p
  where n.nspname = 'public'
    and c.relkind in ('r', 'p', 'v', 'm')
    and p.grantee = 'anon'::regrole::oid;

  if v_tables is not null then
    raise exception
      'anon holds privileges on tables in schema public: %. Every table must be revoked from anon explicitly; the Supabase default privilege grants it ALL on creation and a revoke from PUBLIC does not remove that grant.',
      v_tables
      using errcode = '42501';
  end if;
end $$;


-- ---------------------------------------------------------------------------
-- 4. The structural guard. This is the part that stops the defect recurring.
--
-- A comment asking the next author to remember a revoke is not enforcement:
-- 0001-0008 each carry such a comment and all 25 functions were reachable
-- anyway. An assertion fails the migration instead, so a function added without
-- its revoke cannot reach a deployed database.
--
-- The allowlist is the set of functions `authenticated` must be able to call
-- from an RLS policy expression. It is small and it is meant to stay small:
-- anything an application user needs to DO goes through an Edge Function and a
-- service-role RPC, never through a direct PostgREST call.
-- ---------------------------------------------------------------------------

create function public.assert_function_privileges()
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_allowed_for_authenticated text[] := array[
    'delegation_only_permissions()',
    'current_user_status()',
    'is_active_user()',
    -- regprocedure renders a non-built-in argument type schema-qualified, so
    -- these two read `public.app_permission`, not `app_permission`.
    'has_permission(public.app_permission)',
    'authority_basis(public.app_permission)',
    'separation_of_duties_failure(text,uuid,uuid,uuid)',
    'payload_hash(jsonb)'
  ];
  v_anon      text;
  v_extra     text;
begin
  -- `anon` is the unauthenticated browser key. It may execute nothing here.
  select string_agg(sig, ', ' order by sig) into v_anon
  from (
    select pg_catalog.regexp_replace(p.oid::regprocedure::text, '^public\.', '') as sig
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and exists (
        select 1 from pg_catalog.aclexplode(p.proacl) a
        where a.grantee = 'anon'::regrole::oid and a.privilege_type = 'EXECUTE'
      )
  ) s;

  if v_anon is not null then
    raise exception
      'anon can execute functions in schema public: %. Add "revoke all on function <exact signature> from anon, authenticated;" -- revoking from PUBLIC does not remove the grant the Supabase default privilege records at creation.',
      v_anon
      using errcode = '42501';
  end if;

  -- A function with no ACL at all is PUBLIC EXECUTE by the SQL default, which
  -- reaches anon and authenticated through their membership of PUBLIC.
  select string_agg(sig, ', ' order by sig) into v_extra
  from (
    select pg_catalog.regexp_replace(p.oid::regprocedure::text, '^public\.', '') as sig
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and (
        p.proacl is null
        or exists (
          select 1 from pg_catalog.aclexplode(p.proacl) a
          where a.grantee = 0 and a.privilege_type = 'EXECUTE'
        )
      )
  ) s;

  if v_extra is not null then
    raise exception
      'functions in schema public still grant EXECUTE to PUBLIC: %.', v_extra
      using errcode = '42501';
  end if;

  -- `authenticated` may execute only the RLS helpers.
  select string_agg(sig, ', ' order by sig) into v_extra
  from (
    select pg_catalog.regexp_replace(p.oid::regprocedure::text, '^public\.', '') as sig
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and exists (
        select 1 from pg_catalog.aclexplode(p.proacl) a
        where a.grantee = 'authenticated'::regrole::oid and a.privilege_type = 'EXECUTE'
      )
  ) s
  where sig <> all (v_allowed_for_authenticated);

  if v_extra is not null then
    raise exception
      'authenticated can execute functions outside the RLS-helper allowlist: %. A signed-in application user reaches the database through an Edge Function and a service-role RPC, never through a direct PostgREST call; if this function really must be callable from a policy expression, add it to the allowlist in public.assert_function_privileges() with a reason.',
      v_extra
      using errcode = '42501';
  end if;
end;
$$;

revoke all on function public.assert_function_privileges() from public, anon, authenticated;
grant execute on function public.assert_function_privileges() to service_role;

comment on function public.assert_function_privileges() is
  'Fails if anon can execute anything in public, if any function still grants EXECUTE to PUBLIC, or if authenticated can execute anything outside the RLS-helper allowlist. Called at the end of every migration that creates a function, so a forgotten per-signature revoke fails the migration instead of shipping.';

select public.assert_function_privileges();
