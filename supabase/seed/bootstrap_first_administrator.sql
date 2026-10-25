-- ===========================================================================
-- supabase/seed/bootstrap_first_administrator.sql
--
-- ONE-SHOT: provisions the very first administrator by placing one address on
-- public.bootstrap_admin_grants.
--
-- DELIBERATELY NOT IN `[db.seed].sql_paths` of supabase/config.toml.
-- It is applied BY HAND, once, per environment. It is unnumbered for the same
-- reason supabase/seed/test_fixtures.sql is: a `000N_` prefix beside the two
-- files that ARE listed would read as "applied in sequence with them", and
-- this file must never run unattended. It takes its input from a session
-- setting that `supabase db reset` does not set, so an accidental automatic
-- run would in any case refuse rather than guess.
--
-- NO PERSONAL EMAIL ADDRESS APPEARS IN THIS FILE, and none may ever be added.
-- A committed address is a standing grant of the highest privilege in the
-- system to one named person, readable by anyone with repository access, that
-- outlives their employment. The address is supplied out of band at run time.
--
-- ---------------------------------------------------------------------------
-- HOW TO RUN IT
--
-- Local (Supabase CLI):
--
--   psql "$(supabase status -o env | grep '^DB_URL=' | cut -d= -f2- | tr -d '\"')" \
--     -v ON_ERROR_STOP=1 \
--     -c "set local app.bootstrap_admin_email = 'person@bountyfarm.example';" \
--     -f supabase/seed/bootstrap_first_administrator.sql
--
--   (`set local` keeps the address out of the session's later statements. It
--   requires a transaction, which the -c/-f pair below provides via the
--   explicit BEGIN at the top of this file.)
--
-- Hosted project:
--
--   psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 \
--     -c "set local app.bootstrap_admin_email = 'person@bountyfarm.example';" \
--     -f supabase/seed/bootstrap_first_administrator.sql
--
-- Supply the address on the command line, never by editing this file. Shell
-- history is a credential store nobody audits, so prefer a deployment runner's
-- secret-injection step where one exists.
--
-- ---------------------------------------------------------------------------
-- WHAT IT DOES, AND WHAT IT DOES NOT DO
--
-- It does NOT create an account, a profile or a role. It cannot: a profile is
-- keyed to an auth.users row, which only a real Google sign-in creates. It
-- writes ONE allowlist row. The next time that identity signs in,
-- public.tg_handle_new_auth_user() sees that no administrator exists, finds
-- the unconsumed row, sets the profile active with
-- approval_basis = 'first_administrator_bootstrap', grants the administrator
-- role with a NULL grantor, consumes the row and writes an
-- `identity.bootstrap_administrator` audit event.
--
-- So the founding grant still requires the person to authenticate as
-- themselves. This file only decides WHO may become the first administrator,
-- not that anyone has.
--
-- Three independent limits make it one-shot:
--   1. this file refuses to run if any administrator already exists;
--   2. the grant row is consumed on use and `consumed_at` is then non-null,
--      so the trigger will not match it again;
--   3. `profiles_single_bootstrap_basis` is a UNIQUE INDEX permitting exactly
--      one profile to carry the founding basis, ever - so even a hand-refilled
--      allowlist cannot record a second founding administrator.
--
-- Remember what the first administrator is and is not: an Administrator has NO
-- quality authority. They cannot approve a specification, clear a hold or
-- release material (verified: public.role_permissions grants administrator
-- none of spec.approve, hold.clear or any disposition). The first quality
-- appointment is a separate, audited act performed by this administrator
-- through public.grant_role().
-- ===========================================================================

begin;

do $$
declare
  v_email       text := lower(btrim(coalesce(current_setting('app.bootstrap_admin_email', true), '')));
  v_admins      integer;
  v_grants      integer;
  v_inserted    integer;
begin
  -- -----------------------------------------------------------------------
  -- Refuse without an address. `current_setting(..., true)` returns NULL for
  -- a setting that was never set, so an unattended run lands here and stops.
  -- -----------------------------------------------------------------------
  if v_email = '' then
    raise exception
      'app.bootstrap_admin_email is not set, so there is no address to allow.'
      using hint = 'Run psql with: -c "set local app.bootstrap_admin_email = ''person@example.com'';" before -f this file. Never hardcode an address in the file.';
  end if;

  -- Shape check. The same two constraints guard the table, but failing here
  -- names the problem instead of surfacing a constraint violation.
  if v_email not like '%_@_%._%' then
    raise exception 'app.bootstrap_admin_email is not a usable email address: %', v_email;
  end if;
  if v_email ~ '\s' then
    raise exception 'app.bootstrap_admin_email contains whitespace: %', quote_literal(v_email);
  end if;

  -- -----------------------------------------------------------------------
  -- Refuse if the system already has an administrator.
  --
  -- This is the real one-shot gate, and it is a question about STATE, not
  -- about whether this file has run before. A file that recorded "I have run"
  -- could be reset; an administrator either exists or does not.
  -- -----------------------------------------------------------------------
  select count(*) into v_admins
    from public.user_roles
   where role = 'administrator';

  if v_admins > 0 then
    raise exception
      'Refusing to run: % administrator(s) already exist. The founding bootstrap is for an empty system.',
      v_admins
      using hint = 'A further administrator is appointed by an existing administrator through public.grant_role(), which records who granted it and why. That is an audited act; this file is not.';
  end if;

  -- An unconsumed grant already waiting means somebody has run this before
  -- and the intended person has not yet signed in. Overwriting it silently
  -- would redirect the founding grant to a different person, so stop and make
  -- a human decide.
  select count(*) into v_grants
    from public.bootstrap_admin_grants
   where consumed_at is null;

  if v_grants > 0 then
    raise exception
      'Refusing to run: % unconsumed bootstrap grant(s) already exist. Somebody has already been nominated and has not yet signed in.',
      v_grants
      using hint = 'Inspect public.bootstrap_admin_grants. Delete the stale row deliberately if the nomination has changed; do not let this file silently replace it.';
  end if;

  insert into public.bootstrap_admin_grants (email, created_note)
  values (v_email, 'first-administrator bootstrap, applied by hand from supabase/seed/bootstrap_first_administrator.sql')
  on conflict (email) do nothing;

  -- -----------------------------------------------------------------------
  -- End-state gate.
  --
  -- Read back the row rather than trusting that the INSERT above did
  -- anything. An ON CONFLICT DO NOTHING succeeds when it inserts nothing, so
  -- the statement's success says nothing about the state, and a bootstrap
  -- that silently allowed nobody looks exactly like one that worked - until
  -- the first sign-in lands on `pending` with no administrator anywhere to
  -- approve it, which is an unrecoverable system.
  -- -----------------------------------------------------------------------
  select count(*) into v_inserted
    from public.bootstrap_admin_grants
   where email = v_email
     and consumed_at is null;

  if v_inserted <> 1 then
    raise exception
      'Bootstrap gate failed: expected exactly 1 unconsumed grant for the supplied address, found %. Nothing has been provisioned.',
      v_inserted;
  end if;

  raise notice
    'First-administrator bootstrap armed for the supplied address. Nothing is active yet: that identity must now sign in with Google, at which point the grant is consumed and the administrator role is recorded with an audit event. Remember an Administrator holds NO quality authority.';
end $$;

commit;
