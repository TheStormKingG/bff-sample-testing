-- ===========================================================================
-- 0018 — COMMISSIONING GRANT: every role in public.app_role to ONE account.
--
--        *** THIS DEFEATS ROLE SEPARATION FOR THE NAMED ACCOUNT. ***
--
-- WHAT IT DOES. It gives one named identity every role the system defines, so
-- that a SINGLE OPERATOR can exercise every function during commissioning and
-- acceptance testing. One person then holds, simultaneously: the authority to
-- register a sample, the authority to enter its results, the authority to
-- review it, the authority to accept or reject the material, the authority to
-- clear a hold, the authority to approve a specification limit, and the
-- authority to administer accounts.
--
-- That combination is exactly what this system exists to prevent. PRD §2 and
-- Master Prompt §1 require segregation of duties, and `role_permissions`
-- deliberately keeps quality authority away from the administrator. This
-- migration does not change `role_permissions` — it changes who holds the
-- roles, which has the same practical effect for the one account it names.
--
-- WHY IT IS ACCEPTABLE HERE, AND ONLY HERE. The environment has exactly one
-- identity. There is nobody to be segregated FROM. A test that cannot reach
-- the quality-officer screens cannot find the defects in them, and shipping
-- untested quality screens is the larger risk. The grant is therefore a
-- TEST-ENVIRONMENT INSTRUMENT, not a permission model.
--
-- WHAT MUST HAPPEN BEFORE PRODUCTION CUTOVER — both, not either:
--
--   1. A SECOND REAL IDENTITY must exist and be approved, held by a different
--      person, so that the separation-of-duties checks have somebody to point
--      at. Several of them (see below) cannot be satisfied by one identity in
--      any way at all, including by the database custodian.
--   2. THIS ACCOUNT MUST BE REDUCED TO ITS TRUE ROLE. The surplus rows must be
--      deleted — through `rpc_set_user_roles`, called by the OTHER
--      administrator, so the reduction is itself audited and attributable.
--      Re-running this migration does not undo it; nothing undoes it
--      automatically. Treat it as an open finding until it is done.
--
-- WHAT IT DOES NOT DO, and cannot. Holding every role does NOT unlock every
-- action. `disposition.override_release` is held by no role at all, and four
-- separation-of-duties checks are keyed on IDENTITY rather than role, so they
-- refuse this account no matter what it holds. The complete list is at the
-- foot of this file.
--
-- ---------------------------------------------------------------------------
-- HOW TO RUN IT
--
-- NO PERSONAL EMAIL ADDRESS APPEARS IN THIS FILE, and none may ever be added
-- — the same prohibition, for the same reason, as
-- `supabase/seed/bootstrap_first_administrator.sql`: a committed address is a
-- standing grant of every privilege in the system to one named person,
-- readable by anyone with repository access, that outlives their employment.
--
-- A migration is additionally applied UNATTENDED, to every environment,
-- including production. An address compiled into this file would re-grant
-- every role to that person on every `supabase db reset` and every deploy,
-- silently reversing step 2 above each time it ran. So the address is supplied
-- out of band, at run time, and WITHOUT IT THIS MIGRATION DOES NOTHING:
--
--   psql "$DB_URL" -v ON_ERROR_STOP=1 \
--     -c "set app.commissioning_role_grant_email = 'person@bountyfarm.example';" \
--     -f supabase/migrations/0018_commissioning_all_roles_grant.sql
--
-- Applied through the normal migration path, with no setting, it creates the
-- function, announces that it granted nothing, and moves on. That is what
-- `scripts/verify-migrations.sh` exercises, and it is the only behaviour
-- production should ever see.
--
-- PRECEDENT. `0016_bootstrap_existing_identity.sql` is the existing example of
-- a server-side grant the application layer forbids: a SECURITY DEFINER
-- function, service_role only, idempotent, which writes an audit event and
-- raises rather than silently doing nothing when its precondition is unmet.
-- This follows that shape. 0016's own comment explains why
-- `assert_administers_other` exists; nothing here contradicts it — this does
-- not weaken that check, it bypasses the application entirely, which is the
-- only honest way to do something the application is right to refuse.
-- ===========================================================================


-- CREATE OR REPLACE, not CREATE, and deliberately unlike 0016. The HOW TO RUN
-- block above tells an operator to apply THIS FILE by hand with `psql -f` and
-- a session setting — so the file itself must survive being run twice. A plain
-- `create function` would abort the second run with "function already exists",
-- which reads as a failure of the grant rather than of the file, and would
-- leave the operator unsure whether the roles are in place. Idempotency has to
-- hold for the whole file, not only for the insert inside it.
create or replace function public.apply_commissioning_role_grant(p_email text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email    text := lower(btrim(coalesce(p_email, '')));
  v_user_id  uuid;
  v_status   public.user_status;
  v_before   text[];
  v_after    text[];
  v_granted  integer;
begin
  if v_email = '' then
    raise exception
      'BFF_EMAIL_REQUIRED: name the account to be commissioned, by email address.'
      using errcode = '22023';
  end if;

  -- RESOLVE BY EMAIL, never by a hardcoded uuid: a uuid is meaningless to the
  -- person running this, cannot be checked by eye against the account they
  -- meant, and would be wrong in every other environment.
  select p.id, p.status into v_user_id, v_status
    from public.profiles p
   where lower(p.email) = v_email;

  -- Does nothing and SAYS SO. Reporting success here would tell an operator
  -- that an account they cannot see has been commissioned.
  if v_user_id is null then
    raise exception
      'BFF_UNKNOWN_ACCOUNT: no profile has the address %. A profile exists only after that identity has signed in through Google at least once, so sign in first, then run this.',
      v_email
      using errcode = 'P0002';
  end if;

  -- Roles on a non-active account grant NOTHING: public.require_permission()
  -- checks status before permission, and can() in src/lib/roles.ts returns
  -- false for any non-active account. Granting five roles to a pending
  -- profile would therefore report success and change nothing observable —
  -- the operator would conclude the roles do not work. Refuse instead, and
  -- say which problem they actually have.
  if v_status <> 'active' then
    raise exception
      'BFF_ACCOUNT_NOT_ACTIVE: % is %, and a non-active account holds no permission whatever its roles. Approve the account first; this grant would otherwise look applied and do nothing.',
      v_email, v_status
      using errcode = '42501';
  end if;

  select coalesce(array_agg(ur.role::text order by ur.role), '{}'::text[])
    into v_before
    from public.user_roles ur
   where ur.user_id = v_user_id;

  -- EVERY role, derived from the enum rather than from a list typed here. The
  -- requirement is "all roles", and a literal five-name list would quietly
  -- become a partial grant the day a sixth role is added to public.app_role —
  -- while still reporting success.
  --
  -- INSERT ... ON CONFLICT DO NOTHING, never DELETE-then-INSERT. This is the
  -- opposite choice from `rpc_set_user_roles`, which is declarative and
  -- REPLACES the role set; that is right for an administrator stating a final
  -- state and wrong here. A role already granted by a named person, with
  -- their reason, must keep that provenance: re-running this must not
  -- overwrite `granted_by` and `reason` with the system's, and must not wipe a
  -- role granted another way. DO NOTHING is also what makes a re-run a no-op
  -- rather than a duplicate-key error on the (user_id, role) primary key.
  insert into public.user_roles (user_id, role, granted_by, reason)
  select v_user_id,
         e.v,
         -- granted_by = NULL means GRANTED BY THE SYSTEM DURING COMMISSIONING,
         -- NOT BY A PERSON. It is not missing data and it is not a bug.
         --
         -- It is also the ONLY reason this insert passes
         -- `user_roles_no_self_grant`, which is
         -- CHECK (granted_by IS DISTINCT FROM user_id). Naming the account
         -- itself as its own grantor is refused by that constraint; NULL
         -- satisfies it because `NULL IS DISTINCT FROM <uuid>` is TRUE under
         -- three-valued logic. Verified empirically against a local build of
         -- this schema: the NULL insert is accepted, and the same insert with
         -- granted_by = user_id is rejected by name.
         --
         -- The founding administrator's row carries a NULL grantor for exactly
         -- the same reason (see the constraint's own comment in
         -- 0001_identity.sql, and 0016), so this is the established meaning of
         -- NULL in this column and not a new convention.
         null,
         -- `reason` is mandatory in practice: `rpc_set_user_roles` refuses an
         -- empty one, because a role grant nobody can account for is the thing
         -- this system exists to prevent. The column is nullable, so nothing
         -- would stop a NULL here — which is precisely why it is stated.
         'Commissioning / test grant: all roles to the single operator of a one-identity test environment, so every function can be exercised. DEFEATS role separation for this account. Must be reduced to its true role by another administrator before production cutover.'
    from unnest(enum_range(null::public.app_role)) as e(v)
  on conflict (user_id, role) do nothing;

  get diagnostics v_granted = row_count;

  select coalesce(array_agg(ur.role::text order by ur.role), '{}'::text[])
    into v_after
    from public.user_roles ur
   where ur.user_id = v_user_id;

  -- A re-run that changed nothing writes NO audit event. The audit timeline
  -- records changes of authority; a call that granted nothing changed no
  -- authority, and an event per invocation would bury the one that matters
  -- under identical copies. The operator is still told, by the return value,
  -- that it was already in place — so the no-op is silent in the database and
  -- explicit to the person who ran it.
  if v_granted = 0 then
    return format(
      'No change: %s already holds all %s role(s) — %s. Nothing was written.',
      v_email, cardinality(v_after), array_to_string(v_after, ', ')
    );
  end if;

  -- Written through the same path 0016 uses — a direct insert into
  -- public.audit_events — so the grant appears in the audit timeline rather
  -- than from nowhere. `record_audit_event()` is not used because it resolves
  -- an actor's roles and authority basis from a profile, and the actor here is
  -- not a profile.
  --
  -- actor_id IS NULL, and that is deliberate: the schema documents NULL as "a
  -- system action", and the system is what performed this. 0016 names the
  -- target as the actor because the founding identity's own sign-in triggered
  -- it; nothing triggered this but a commissioning procedure, and recording
  -- the beneficiary as the actor would read as a person granting themselves
  -- every role — a claim the database has no evidence for. The NULL actor and
  -- the NULL `granted_by` therefore say the same thing, in the same way.
  insert into public.audit_events (
    actor_id, actor_email, action, entity_type, entity_id,
    reason, before_payload, after_payload, outcome
  )
  values (
    null, null,
    'identity.commissioning_role_grant', 'profile', v_user_id::text,
    'Commissioning grant: all roles in public.app_role to a single named account for test coverage of every function. Role separation is defeated for this account until it is reduced to its true role.',
    jsonb_build_object('roles', v_before),
    jsonb_build_object('roles', v_after, 'email', v_email, 'roles_added', v_granted),
    'succeeded'
  );

  return format(
    'Granted %s role(s) to %s. Now holds: %s. ROLE SEPARATION IS DEFEATED for this account.',
    v_granted, v_email, array_to_string(v_after, ', ')
  );
end;
$$;

-- A SECURITY DEFINER function is granted EXECUTE to PUBLIC by default, and
-- `alter default privileges ... revoke` cannot remove a grant that was never
-- recorded as a default. State the revoke per signature.
revoke all on function public.apply_commissioning_role_grant(text)
  from public, anon, authenticated;
grant execute on function public.apply_commissioning_role_grant(text) to service_role;

comment on function public.apply_commissioning_role_grant(text) is
  'TEST ENVIRONMENTS ONLY. Grants every role in public.app_role to the account with the given email, with granted_by = NULL meaning "granted by the system during commissioning". Idempotent; refuses an unknown or non-active account. DEFEATS role separation for that account. service_role only.';

select public.assert_function_privileges();


-- ---------------------------------------------------------------------------
-- Apply it, IF AND ONLY IF an address was supplied out of band.
--
-- `current_setting(..., true)` returns NULL rather than raising when the
-- setting is absent, which is the whole gate: the normal migration path, and
-- `scripts/verify-migrations.sh`, apply this file with a plain `psql -f` and
-- no setting, so they take the notice branch. A `raise exception` here would
-- abort the migration chain for everyone; this is the one precondition whose
-- correct answer is to skip, so it announces the skip instead of failing.
-- ---------------------------------------------------------------------------
do $$
declare
  v_email  text := lower(btrim(coalesce(current_setting('app.commissioning_role_grant_email', true), '')));
  v_result text;
begin
  if v_email = '' then
    raise notice '0018: no app.commissioning_role_grant_email supplied — NO ROLES GRANTED. The function public.apply_commissioning_role_grant(text) now exists and does nothing until it is called with an address. This is the correct outcome for production.';
    return;
  end if;

  v_result := public.apply_commissioning_role_grant(v_email);
  raise notice '0018: %', v_result;
end;
$$;


-- ===========================================================================
-- WHAT HOLDING EVERY ROLE DOES AND DOES NOT UNLOCK.
--
-- Established by querying this schema, not by reading the TypeScript:
--
--   select e.v from unnest(enum_range(null::public.app_permission)) e(v)
--    where not exists (select 1 from public.role_permissions rp
--                       where rp.permission = e.v);
--   => disposition.override_release
--
-- UNLOCKED: 21 of the 22 permissions in public.app_permission — the union of
-- all five roles' base grants. Every sample action, every disposition, hold
-- raise AND hold clear, spec propose AND spec approve, user management,
-- access approval, sync, audit, report and export.
--
-- STILL BLOCKED, whatever roles are held:
--
--   1. disposition.override_release. Held by NO role (query above), so roles
--      cannot reach it. It is reachable only through a row in
--      `user_delegations` — and `rpc_grant_delegation` refuses this permission
--      outright (BFF_NOT_DELEGATABLE), for every caller, so no application
--      path exists at all.
--
--      It is unreachable for a ONE-IDENTITY environment even outside the
--      application: `user_delegations.granted_by` is NOT NULL and
--      CHECK (granted_by <> user_id). There is no NULL escape hatch here, so
--      unlike `user_roles` this cannot be satisfied by "granted by the
--      system". A SECOND REAL PROFILE is structurally required, even for the
--      database custodian. Verified empirically: granted_by = user_id is
--      rejected by user_delegations_no_self_grant, and granted_by = NULL is
--      rejected by the NOT NULL constraint.
--
--   2. Approving your own specification version. 0013_rpc_mutations.sql:1469,
--      via separation_of_duties_failure('approve_specification', ...). Naming
--      yourself as the override approver is refused separately (:1447), as is
--      naming the proposer (:1452).
--
--   3. Reviewing an out-of-limit measurement you recorded.
--      0013_rpc_mutations.sql:1031, via
--      separation_of_duties_failure('review_exception', ...). Only applies to
--      an `outside_limit` result; reviewing your own in-limit result is
--      ordinary work and is allowed.
--
--   4. Approving your own account access, or your own reinstatement.
--      `profiles_no_self_approval` is a CHECK on public.profiles
--      (approved_by IS DISTINCT FROM id), so it binds EVERY writer including
--      service_role — a table constraint is not an application rule. The
--      founding bootstrap's exemption cannot be reused:
--      `profiles_single_bootstrap_basis` is a unique index permitting exactly
--      one profile ever to carry that basis.
--
--   5. Changing your own roles, or administering your own account at all.
--      `assert_administers_other` (0015_rpc_domain_and_admin.sql:862) raises
--      BFF_SELF_ADMINISTRATION when actor = target, and gates
--      rpc_approve_account, rpc_set_user_status, rpc_set_user_roles and
--      rpc_grant_delegation. THIS IS WHY TICKING ALL FIVE BOXES ON YOUR OWN
--      ACCOUNT IN THE ADMIN UI IS REJECTED, and why this migration exists.
--
--   6. Delegating any permission to yourself. `assert_administers_other` on
--      rpc_grant_delegation, plus user_delegations_no_self_grant. (Revoking
--      your OWN delegation is deliberately allowed — giving up authority is
--      the safe direction.)
--
-- rpc_revoke_delegation is the only administration RPC with no
-- self-administration gate, by design and with that reason stated at the call
-- site.
-- ===========================================================================
