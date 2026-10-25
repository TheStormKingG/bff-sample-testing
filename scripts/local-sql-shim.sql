-- ---------------------------------------------------------------------------
-- Minimal Supabase-compatible shim for verifying migrations on a plain
-- PostgreSQL server, when Docker (and therefore `supabase start`) is not
-- available.
--
-- This exists so that "the migrations apply cleanly" can be an EXECUTED claim
-- rather than a read-the-SQL claim. Reading found two migration-aborting
-- defects in this project (a foreign key inserted before its referent, and a
-- function redefined with a widened return type); execution is what catches
-- the rest.
--
-- WHAT THIS IS NOT: it is not Supabase. It creates only the surface the
-- migrations actually reference — `auth.uid()`, `auth.users(id)` and the three
-- grant target roles. In particular it does NOT reproduce:
--
--   * GoTrue's real `auth.users` columns, triggers or constraints;
--   * the `supabase_auth_admin` / `authenticator` role hierarchy;
--   * PostgREST's request handling, so a passing run here says nothing about
--     how a REST request is actually authorised;
--   * Supabase's own default privileges, which differ from a stock server —
--     this matters, because the whole point of the explicit per-function
--     `revoke ... from public` is to defend against a default grant that a
--     stock server may not even make.
--
-- So a clean run here proves the SQL is VALID and self-consistent, and that
-- the migration ORDER works. It does not prove the RLS policies deny what
-- they are meant to deny under a real JWT. Run `supabase db reset` for that.
-- ---------------------------------------------------------------------------

-- Grant targets. NOLOGIN: nothing authenticates as these here, they exist so
-- `grant ... to authenticated` resolves.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end
$$;

create schema if not exists auth;
grant usage on schema auth to anon, authenticated, service_role;

-- auth.users.
--
-- A grep for `auth.users` across the migrations shows it used only as a
-- foreign-key target on `id`, and a first version of this shim had just
-- (id, email) on that basis. Applying it then failed with
--   record "new" has no field "raw_user_meta_data"
-- because migration 0001 puts an AFTER INSERT trigger on auth.users whose
-- FUNCTION BODY reads `new.raw_user_meta_data`, `new.email` and
-- `new.created_at`. The dependency is real but invisible to a search for the
-- table name, because it lives in a trigger function that merely mentions
-- `new`. Columns below are the ones the trigger bodies actually read; keep
-- them in step with `grep -oE 'new\.[a-z_]+' supabase/migrations/*.sql`.
create table if not exists auth.users (
  id                  uuid primary key default gen_random_uuid(),
  email               text,
  -- GoTrue stores the identity-provider profile here; the new-user trigger
  -- reads 'full_name' out of it to seed a display name.
  raw_user_meta_data  jsonb not null default '{}'::jsonb,
  raw_app_meta_data   jsonb not null default '{}'::jsonb,
  created_at          timestamptz not null default now()
);

/**
 * The signed-in user's id.
 *
 * Reads the same request settings PostgREST populates, so a verification
 * script can impersonate a user with
 *   set local request.jwt.claims = '{"sub":"<uuid>","role":"authenticated"}';
 * and exercise an RLS policy. Returns NULL when unset, which is the
 * unauthenticated case every policy must deny by default.
 */
create or replace function auth.uid()
returns uuid
language plpgsql
stable
as $$
declare
  claims text;
  sub    text;
begin
  begin
    claims := current_setting('request.jwt.claims', true);
  exception when others then
    claims := null;
  end;

  if claims is not null and length(btrim(claims)) > 0 then
    begin
      sub := (claims::jsonb) ->> 'sub';
    exception when others then
      sub := null;
    end;
  end if;

  if sub is null then
    begin
      sub := current_setting('request.jwt.claim.sub', true);
    exception when others then
      sub := null;
    end;
  end if;

  if sub is null or length(btrim(sub)) = 0 then
    return null;
  end if;

  begin
    return sub::uuid;
  exception when others then
    return null;
  end;
end
$$;

grant execute on function auth.uid() to anon, authenticated, service_role;
