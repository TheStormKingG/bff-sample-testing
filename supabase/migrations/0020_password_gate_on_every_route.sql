-- ===========================================================================
-- 0020_password_gate_on_every_route.sql
--
-- Closes two defects in 0019_admin_managed_passwords.sql. 0019 is not edited:
-- it is unreleased but it is another agent's work, and the delta is easier to
-- review as its own file than as a diff inside a 600-line one.
--
-- ---------------------------------------------------------------------------
-- D1. THE GATE WAS COSMETIC ON THE POSTGREST ROUTE.
--
-- 0019 put public.must_change_password() inside public.require_permission(),
-- and its header stated the consequence as an absolute: an account with an
-- outstanding change "holds NO permission by ANY route". That sentence is
-- false for one of the three routes it names, and three frontend files repeat
-- it as the reason their own screen-level gate is cosmetic-by-design.
--
-- This system answers "may this actor do X" in TWO independent families of
-- functions, and they share nothing:
--
--   ACTOR-KEYED, raising (0011): actor_status -> actor_is_active ->
--     actor_has_permission, all reached through require_permission(). Used by
--     every authority-bearing RPC. 0019 amended this family.
--
--   CALLER-KEYED, boolean (0001): current_user_status -> is_active_user ->
--     has_permission. Used by the row-level-security policies, which is how
--     PostgREST authorises a direct table request. 0019 did not touch it.
--
-- Note that has_permission() is NOT a wrapper over actor_has_permission(), and
-- is_active_user() is NOT a wrapper over actor_is_active(). Each family
-- reimplements the same rules against a different subject. So a check inserted
-- into one is absent from the other by construction, and `create or replace`
-- touches exactly one name.
--
-- PROVED BY EXECUTION on a local build of this schema, before this file was
-- written, in ONE transaction, for ONE actor, with ONE permission:
--
--   require_permission(armed,'sample.draft')  -> raises
--                                                BFF_PASSWORD_CHANGE_REQUIRED
--   as role authenticated, same subject in request.jwt.claims:
--     has_permission('sample.draft')          -> TRUE
--     is_active_user()                        -> TRUE
--     delete from public.samples (own draft)  -> 1 row deleted
--     select from public.profiles             -> 3 rows (the staff directory)
--
--   Positive control, without which the refusal proves nothing: the same
--   require_permission() call for an account whose two columns are NULL was
--   ALLOWED. So the route works when it should, and the refusal above is the
--   gate rather than a broken probe.
--
-- ONE CORRECTION TO THE REPORTED EXTENT, because the remedy should not rest on
-- a claim that does not reproduce. The finding as handed over said INSERT,
-- UPDATE and DELETE of a draft were all reproduced. On this schema INSERT and
-- UPDATE are not reachable by `authenticated` AT ALL, by either route: the
-- role holds SELECT on 28 tables plus DELETE on exactly `samples` and
-- `sample_measurements`, and no INSERT or UPDATE anywhere (information_schema
-- .role_table_grants). The policies samples_insert_own_draft,
-- samples_update_own_draft and profiles_update_own_display_name are therefore
-- unreachable today — refused by the absence of a table privilege, not by the
-- gate. What an armed account could actually do through PostgREST is DELETE
-- its own draft samples and draft measurements, and READ every record its view
-- permission covers. That is still the defect, and still worth this file: a
-- deletion and a wholesale read performed under a credential two people know
-- are exactly the acts a quality record cannot attribute to one person. It is
-- stated here because the grant table bounds every RLS claim and a later
-- `grant insert` would silently widen this one.
--
-- WHERE THE GATE GOES, and what that costs. Derived from pg_policy rather than
-- argued, counting every policy on a `public` table reachable by the
-- `authenticated` role (37 of 37 policies in this schema are such policies):
--
--   * the authorizing predicates named across all 37 are exactly TWO:
--     has_permission and is_active_user. There is no third.
--   * 21 policies name has_permission. These carry both DELETE paths and every
--     sensitive read: audit_events, holds, dispositions, assessments,
--     sample_links, the four sheet_* tables, user_roles, user_delegations and
--     the auditors' view of idempotency_requests.
--   * 15 further policies name is_active_user and NOT has_permission: the
--     controlled vocabulary (feed_types, materials, mill_screen_sizes,
--     sample_prefixes, sampling_points, suppliers, specifications,
--     specification_versions, stage_definitions, stage_fields, system_config,
--     role_permissions), the staff directory, each actor's own
--     idempotency_requests rows, and own-display-name UPDATE.
--   * exactly ONE policy names neither: profiles_select_self, whose qualifier
--     is `id = auth.uid()` and nothing else.
--
-- So gating has_permission alone would leave 15 policies open, including the
-- staff directory and each actor's own idempotency rows — and the latter is
-- the table whose payload_hash is the subject of a separate finding. Gating
-- is_active_user covers 36 of the 37, because has_permission() begins with
-- is_active_user() and inherits it.
--
-- The brief's caution that broader is not automatically better is answered by
-- the enumeration rather than by argument. Gating is_active_user can only ever
-- turn TRUE into FALSE, and only for an account that is active AND armed:
--   * the one policy that intentionally applies to a non-active account is
--     profiles_select_self, and it does so by containing no status predicate
--     at all, so it cannot be affected by a change to is_active_user;
--   * the other 36 already refuse pending, suspended and disabled accounts, so
--     no account that was being refused changes answer;
--   * no account with both columns NULL changes answer, because
--     must_change_password() is false for it.
-- And the ordering 0019 designed is untouched: a suspended AND armed account
-- still gets the ACCOUNT answer from require_permission(), because that
-- function consults actor_is_active() — a different family — and this file
-- does not alter it.
--
-- THE GATE IS THEREFORE WRITTEN INTO BOTH is_active_user() AND
-- has_permission(). is_active_user() is the chokepoint and does the work. The
-- restatement in has_permission() is NOT a second layer and must not be
-- counted as one: has_permission() calls is_active_user(), so no request can
-- reach one gate without passing the other, and no runtime probe can exercise
-- either alone. It is there because the two functions are separately
-- replaceable with `create or replace` — which is precisely how this hole came
-- to exist — and because a reader of the 21 policies that NAME has_permission
-- should find the gate in the predicate they are reading rather than one level
-- down. Its presence is asserted structurally at the end of this file, not
-- behaviourally, because a redundant guard that cannot be exercised alone can
-- be lost without any test failing -- so section 5 pins it by name.
--
-- THE RULE ITSELF IS NOT RESTATED. Both functions call
-- public.must_change_password(), which stays the single home of the
-- comparison, including the deliberate `<=` tie. Two spellings of one rule is
-- the defect this file closes; introducing a second spelling to close it would
-- be the same mistake one level down.
--
-- WHAT MUST KEEP WORKING, and is proved by scripts/verify-0020-password-gate.sh
-- rather than asserted here:
--   * profiles_select_self. The client computes its own mustChangePassword
--     from password_set_by_admin_at and password_changed_at on its own profile
--     row (src/hooks/useProfile.ts), read through this policy. Policies for one
--     command are OR'ed, so the armed account keeps its own row even once
--     profiles_select_directory starts refusing it. If this broke, the holder
--     could not discover the obligation and the feature would be a brick.
--   * public.rpc_record_password_changed(). It is SECURITY DEFINER, is granted
--     to service_role only, and calls assert_actor_is_caller() — which, like
--     record_audit_event() and rpc_authority_context(), references none of the
--     caller-keyed predicates (checked against pg_proc.prosrc, not by reading).
--     The only escape from the gate is therefore unaffected by the gate.
--   * every pre-0019 account: both columns NULL, must_change_password() false,
--     so no predicate changes value. Proved by comparing a pre-0019 account's
--     answers on both routes against the same account before this migration.
--   * sign-in, which is authentication in auth.users and not a permission.
--
-- ONE CONSEQUENCE WORTH STATING PLAINLY: an administrator who is themselves
-- armed loses the admin screen, because useAdmin reads public.profiles through
-- profiles_select_directory. That is the feature working. An administrator
-- cannot arm themselves — assert_administers_other refuses a self-target — so
-- this only happens when a second administrator resets their password, and the
-- remedy is the same change-password screen everybody else uses.
--
-- ---------------------------------------------------------------------------
-- D3. BOTH NEW AUDIT EVENTS RECORDED THE POST-STATE AS THEIR BEFORE-STATE.
--
-- In each of 0019's two RPCs the raw timestamp was correctly captured into a
-- variable ahead of the UPDATE, and then public.must_change_password(...) was
-- called INSIDE the p_before jsonb_build_object. That argument list is
-- evaluated when the audit statement runs, which is after the update, so the
-- derived field reported the post-state under the before label. Every audit
-- row in a fresh build had before == after for the one field the pair exists to
-- show, including the arming event claiming the account already owed the
-- obligation that event was creating.
--
-- The fix is structural rather than local: the WHOLE before-object is built
-- into one variable before the mutation, so there is no argument position left
-- in which a later recomputation could be written. A variable was evaluated
-- when it was assigned; a call is evaluated now.
--
-- Nothing else in either function changes. Both are reproduced in full because
-- `create or replace` takes a whole body.
--
-- ---------------------------------------------------------------------------
-- PRECEDENT FOLLOWED
--   * 0001_identity.sql:317-375 — the caller-keyed family, reproduced below
--     with one conjunct added to two of its three members.
--   * 0019_admin_managed_passwords.sql — the rule, the message, the two RPCs.
--   * 0009_privilege_hardening.sql:101-108 — is_active_user() and
--     has_permission() are on the `authenticated` allowlist inside
--     public.assert_function_privileges(). That allowlist is why this file
--     introduces NO new function that `authenticated` must execute: adding one
--     would require editing 0009, which this file does not own. The gate is
--     therefore called directly rather than through a caller-keyed wrapper.
--     public.must_change_password() stays revoked from `authenticated`; both
--     callers are SECURITY DEFINER, so EXECUTE is checked against the owner.
--     That is a claim about privilege, so the verification script executes it.
--   * 0018 / 0019 house style: idempotent, revoke from public/anon/
--     authenticated, grant to service_role, end with
--     public.assert_function_privileges().
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. THE GATE, on the chokepoint of the caller-keyed chain.
--
-- Reproduces 0001_identity.sql:330 exactly, with one conjunct added.
--
-- The NULL cases are stated rather than inherited. When auth.uid() is NULL
-- there is no row, so must_change_password() coalesces to false and `not
-- false` is true — but current_user_status() is also NULL, so coalesce makes
-- the first conjunct false and the whole expression false. An unauthenticated
-- caller is refused by the status half, which is where that decision belongs.
-- ---------------------------------------------------------------------------

create or replace function public.is_active_user()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(public.current_user_status() = 'active', false)
     and not public.must_change_password(auth.uid());
$$;

comment on function public.is_active_user() is
  'True when the calling identity is active AND holds no outstanding administrator-set password. The second half is the gate added by 0020: this function is the predicate 20 row-level-security policies evaluate and the first conjunct of has_permission(), so it is the chokepoint of the boolean authorization chain that 0019 left ungated. The one policy it deliberately does not reach is profiles_select_self, which must keep working so the holder can discover the obligation.';


-- ---------------------------------------------------------------------------
-- 2. The gate restated where the 21 highest-consequence policies name it.
--
-- Reproduces 0001_identity.sql:340 exactly, with one conjunct added.
--
-- NOT AN INDEPENDENT LAYER. This function's first conjunct is
-- is_active_user(), which carries the same gate, so there is no request that
-- passes here and fails there, and no probe can exercise this conjunct alone.
-- Counting it as a second line of defence would be the error where a working
-- outer layer starves an inner one of the test that would show it had been
-- lost. It is here for drift: the two functions are separately replaceable,
-- and a future `create or replace` of either must not silently reopen the
-- route. Section 5 asserts its presence by reading this function's own body
-- (c_must_state_gate), which is a separate check from the reachability
-- closure: the closure counts this function as gated through
-- is_active_user() whether or not the line below is here, so the closure
-- alone would let it be deleted silently.
-- ---------------------------------------------------------------------------

create or replace function public.has_permission(p_permission public.app_permission)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    public.is_active_user()
    -- The gate, restated. See section 2 of 0020: defence against a future
    -- redefinition of is_active_user(), not a second layer.
    and not public.must_change_password(auth.uid())
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
  'Server-side authority check mirroring can() in src/lib/roles.ts. Hiding a UI button is not a control; this is. Named by 21 row-level-security policies. Since 0020 it also withholds every permission from an account holding an administrator-set password it has not replaced -- inherited from is_active_user() and restated here so the gate is visible in the predicate those policies actually name.';


-- ---------------------------------------------------------------------------
-- 3. D3 in rpc_record_admin_password_set: the before-object is built BEFORE
--    the update.
--
-- Reproduces 0019 section 4a in full. The only change is that
-- jsonb_build_object for p_before is assigned to v_before_json ahead of the
-- UPDATE instead of being written in the audit call's argument list. Every
-- check, message, order and comment is otherwise as 0019 left it.
-- ---------------------------------------------------------------------------

-- THE DROP IS REQUIRED BY THIS PROJECT'S OWN RULE, not by this change.
-- tests/rpcContract.test.ts asserts that any rpc_* name defined in more than
-- one migration is preceded, in the redefining file, by an explicit
-- `drop function`. The reason given there is sound and is a real hazard in
-- this repository: `create or replace` is the one idiom that CANNOT widen a
-- return type, and a bare `create function` cannot overload an identical
-- argument list, so a redefinition that happens to change the return type
-- aborts the migration. Reading the two bodies cannot distinguish the safe
-- case from the fatal one, which is exactly why the rule is mechanical.
--
-- The drop takes the function's ACL with it, so the revokes and grants 0019
-- section 5 made are re-issued below. That is not optional: a dropped and
-- recreated SECURITY DEFINER function arrives with EXECUTE granted to PUBLIC
-- by the SQL default, and on a Supabase project with EXECUTE additionally
-- recorded for anon and authenticated. public.assert_function_privileges() at
-- the end of this file would catch an omission, but the grants are restated
-- deliberately rather than left to an assertion to discover.
--
-- The two caller-keyed predicates in sections 1 and 2 are NOT dropped, and
-- cannot be: `drop function public.is_active_user()` is refused with
-- "cannot drop function is_active_user() because other objects depend on it",
-- naming the policies. `create or replace` is the only idiom available there,
-- and it is safe because neither signature nor return type changes. The
-- project's rule is scoped to rpc_* names for that reason.

drop function if exists public.rpc_record_admin_password_set(uuid, text, text, text, uuid, text);

create or replace function public.rpc_record_admin_password_set(
  p_actor           uuid,
  p_idempotency_key text,
  p_payload_hash    text,
  p_app_version     text,
  p_target_user     uuid,
  p_reason          text
)
returns table (
  target_user uuid,
  status      text,
  recorded_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  -- The endpoints that may claim an idempotency key for this RPC. Derived from
  -- the two Edge actions in the contract plus the `admin_action.` prefix that
  -- adminSpec() puts on every one of them. A key claimed by any other endpoint
  -- is not a retry of this operation and is refused below.
  c_operations constant text[] := array[
    'admin_action.create_account',
    'admin_action.set_password'
  ];
  v_basis       text;
  v_operation   text;
  v_before      timestamptz;
  v_before_json jsonb;
  v_now         timestamptz := now();
begin
  v_basis := public.require_permission(p_actor, 'user.manage');

  select r.operation into v_operation
    from public.idempotency_requests r
   where r.idempotency_key = p_idempotency_key;

  if v_operation is null then
    -- No prior claim: a direct caller rather than the Edge path. Claim the key
    -- under the canonical name so the row records which operation owns it.
    v_operation := 'admin_action.set_password';
  elsif v_operation <> all (c_operations) then
    raise exception
      'BFF_IDEMPOTENCY_CONFLICT: operation_mismatch -- key % was claimed by %, which is not a password-setting endpoint',
      p_idempotency_key, v_operation
      using errcode = '22023';
  end if;

  perform public.claim_mutation(p_idempotency_key, v_operation, p_actor, p_payload_hash);
  perform public.assert_administers_other(p_actor, p_target_user);

  if coalesce(btrim(p_reason), '') = '' then
    raise exception
      'BFF_REASON_REQUIRED: record why this account is being given a password it did not choose'
      using errcode = '22023';
  end if;

  select p.password_set_by_admin_at into v_before
    from public.profiles p
   where p.id = p_target_user;

  -- THE WHOLE BEFORE-OBJECT, BEFORE THE MUTATION. 0019 captured v_before
  -- correctly and then called must_change_password() inside the audit call's
  -- argument list, which is evaluated after the update below -- so the derived
  -- field reported the post-state under the before label and every row read
  -- before == after. Assigning the object here removes the argument position in
  -- which that could be rewritten, rather than fixing this one instance of it.
  v_before_json := jsonb_build_object(
    'password_set_by_admin_at', v_before,
    'must_change_password',     public.must_change_password(p_target_user)
  );

  update public.profiles p
     set password_set_by_admin_at = v_now
   where p.id = p_target_user;

  -- NO PASSWORD IN THE PAYLOAD, and none is available to put there: this
  -- function is never told what the credential is. before/after carry the two
  -- instants and the resulting obligation, which is the whole of what a
  -- reviewer needs to see.
  perform public.record_audit_event(
    p_action             => 'identity.password_set_by_administrator',
    p_entity_type        => 'profile',
    p_entity_id          => p_target_user::text,
    p_reason             => btrim(p_reason),
    p_before             => v_before_json,
    p_after              => jsonb_build_object(
                              'password_set_by_admin_at', v_now,
                              'must_change_password', true
                            ),
    p_outcome            => 'succeeded',
    p_authority_basis    => v_basis,
    p_actor_id           => p_actor,
    p_deployment_version => p_app_version
  );

  perform public.mark_mutation_committed(p_idempotency_key, null);

  return query
  select p.id, p.status::text, v_now
    from public.profiles p
   where p.id = p_target_user;
end;
$$;

comment on function public.rpc_record_admin_password_set(uuid, text, text, text, uuid, text) is
  'Records that an administrator set another account a password, which arms the forced change. Refuses a self-target through assert_administers_other: an administrator exempting themselves by using the control is the one case that would defeat it. Never receives or stores the password. Since 0020 the audit event records the obligation as it stood BEFORE the update, so the row shows the transition.';


-- ---------------------------------------------------------------------------
-- 4. D3 in rpc_record_password_changed: same fix, same reasoning.
--
-- Reproduces 0019 section 4b in full. The `select ... into v_before` is kept
-- as its own statement and kept BEFORE the `if not found` check, because that
-- check reads the FOUND flag that this statement sets — an assignment would
-- not set it, and folding the two together would silently retire the
-- row-existence refusal.
-- ---------------------------------------------------------------------------

-- Dropped first for the reason given in section 3; privileges re-issued in
-- section 6.

drop function if exists public.rpc_record_password_changed(uuid, text);

create or replace function public.rpc_record_password_changed(
  p_actor       uuid,
  p_app_version text
)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_before      timestamptz;
  v_before_json jsonb;
  v_now         timestamptz := now();
begin
  perform public.assert_actor_is_caller(p_actor);

  select p.password_changed_at into v_before
    from public.profiles p
   where p.id = p_actor;

  -- Refuse rather than report success over nothing. A profile is created by
  -- tg_handle_new_auth_user() on the auth.users insert, so an id with no
  -- profile is not "a new user" -- it is a uuid that never signed in, and
  -- recording a password change for it would also violate the audit table's
  -- actor foreign key a statement later.
  if not found then
    raise exception 'BFF_UNKNOWN_USER: no account %', p_actor using errcode = '23503';
  end if;

  -- Before the mutation, for the reason given in section 3.
  v_before_json := jsonb_build_object(
    'password_changed_at',  v_before,
    'must_change_password', public.must_change_password(p_actor)
  );

  update public.profiles p
     set password_changed_at = v_now
   where p.id = p_actor;

  perform public.record_audit_event(
    p_action             => 'identity.password_changed',
    p_entity_type        => 'profile',
    p_entity_id          => p_actor::text,
    p_reason             => 'The holder set their own password.',
    p_before             => v_before_json,
    p_after              => jsonb_build_object(
                              'password_changed_at', v_now,
                              -- Stated, not computed from the row again: this
                              -- is the obligation this call discharges, and a
                              -- later administrator reset re-arms it with its
                              -- own event rather than editing this one.
                              'must_change_password', false
                            ),
    p_outcome            => 'succeeded',
    p_actor_id           => p_actor,
    p_deployment_version => p_app_version
  );

  return v_now;
end;
$$;

comment on function public.rpc_record_password_changed(uuid, text) is
  'Records that the holder set their own password, clearing an outstanding administrator-set credential. Deliberately does NOT call require_permission(): the caller holds no permission at that moment, by design, and requiring one would make the gate inescapable. Verifies the actor is the caller instead, and has no target parameter. Since 0020 the audit event records the obligation as it stood BEFORE the update.';


-- ---------------------------------------------------------------------------
-- 5. THE DRIFT ASSERTION.
--
-- Sections 1 and 2 close the two predicates that exist TODAY. The reason this
-- hole existed is not that someone forgot a call site: it is that nothing in
-- the build could see a policy authorising through a predicate that does not
-- consult the gate. A list of 37 policies checked by hand on one afternoon
-- cannot see the 38th.
--
-- So this reads pg_policy and pg_proc and fails the build if any policy on a
-- `public` table that the `authenticated` role can reach authorises through a
-- predicate from which public.must_change_password() is NOT reachable.
-- Reachability is transitive, so a future helper that merely wraps
-- has_permission() passes without being named here.
--
-- ONE DECLARED EXEMPTION, and it is declared rather than inferred.
-- profiles_select_self has the qualifier `id = auth.uid()` and calls no
-- function in `public` at all. It MUST stay ungated: it is how the holder of
-- an armed account reads its own profile row and discovers it has to change
-- the password. Gating it would make the feature a brick.
--
-- The check is symmetric, which is what stops the list rotting: a policy that
-- is exempt and no longer exists fails too, so the exemption cannot outlive
-- its reason silently.
--
-- WHY A FUNCTION AND NOT A `do` BLOCK: scripts/verify-0020-password-gate.sh
-- calls it again after the build, and a verification script that cannot
-- re-run the assertion has to reimplement it — which is how two spellings of
-- one rule get started.
-- ---------------------------------------------------------------------------

create or replace function public.assert_password_gate_on_every_policy()
returns void
language plpgsql
stable
set search_path = ''
as $$
declare
  -- Policies that may authorise without consulting the gate, each with the
  -- reason it must. Format: '<table>.<policy>'.
  --   profiles.profiles_select_self -- the holder must be able to read its own
  --     profile row while the gate is closed, because that row is where
  --     src/hooks/useProfile.ts learns there is an obligation at all.
  c_exempt constant text[] := array['profiles.profiles_select_self'];

  -- The predicates that must carry the gate IN THEIR OWN BODY, not merely
  -- inherit it. Checked separately from the reachability closure below,
  -- because that closure cannot see the difference: has_permission() calls
  -- is_active_user(), so it counts as gated whether or not it states the gate
  -- itself, and the restatement could be deleted without any reachability
  -- check noticing. A redundant guard that no assertion pins is a guard that
  -- will be removed by someone tidying up.
  c_must_state_gate constant text[] := array['is_active_user', 'has_permission'];

  v_scanned     integer;
  v_ungated     text;
  v_unexplained text;
  v_stale       text;
  v_silent      text;
begin
  -- One query, four answers. Everything derives from the same policy set, so
  -- computing them together makes it impossible for the count that licenses
  -- the result to be taken over a different population than the findings.
  with recursive gated as (
    select p.proname
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and (p.proname = 'must_change_password'
            or p.prosrc ~ '\mmust_change_password[[:space:]]*\(')
    union
    select p.proname
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
      join gated g on p.prosrc ~ ('public\.' || g.proname || '[[:space:]]*\(')
     where n.nspname = 'public'
  ),
  -- Every policy on a `public` table that the `authenticated` role can reach.
  -- `{0}` is PUBLIC, i.e. a policy with no role list, which reaches
  -- `authenticated` through its membership of PUBLIC.
  pol as (
    select pc.relname as tbl,
           p.polname  as pname,
           coalesce(pg_catalog.pg_get_expr(p.polqual, p.polrelid), '') || ' ' ||
           coalesce(pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid), '') as expr
      from pg_catalog.pg_policy p
      join pg_catalog.pg_class pc on pc.oid = p.polrelid
      join pg_catalog.pg_namespace n on n.oid = pc.relnamespace
     where n.nspname = 'public'
       and (p.polroles = '{0}'::oid[]
            or 'authenticated'::regrole::oid = any (p.polroles))
  ),
  public_functions as (
    select distinct p.proname
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
  ),
  -- Which public functions each policy's expression names. Policy expressions
  -- are rendered without the `public.` prefix, so the match is on a bare,
  -- word-bounded name followed by an open parenthesis.
  refs as (
    select pol.tbl, pol.pname, f.proname
      from pol
      join public_functions f
        on pol.expr ~ ('\m' || f.proname || '[[:space:]]*\(')
  ),
  per_policy as (
    select pol.tbl,
           pol.pname,
           (select string_agg(r.proname, '+' order by r.proname)
              from refs r where r.tbl = pol.tbl and r.pname = pol.pname) as preds,
           exists (select 1 from refs r
                    where r.tbl = pol.tbl and r.pname = pol.pname
                      and r.proname in (select proname from gated))   as reaches_gate,
           exists (select 1 from refs r
                    where r.tbl = pol.tbl and r.pname = pol.pname)    as names_a_function
      from pol
  )
  select
    (select count(*) from pol),
    (select string_agg(tbl || '.' || pname || ' [' || preds || ']', ', ' order by tbl, pname)
       from per_policy
      where names_a_function and not reaches_gate
        and (tbl || '.' || pname) <> all (c_exempt)),
    (select string_agg(tbl || '.' || pname, ', ' order by tbl, pname)
       from per_policy
      where not names_a_function
        and (tbl || '.' || pname) <> all (c_exempt)),
    (select string_agg(e, ', ' order by e)
       from unnest(c_exempt) as e
      where not exists (select 1 from per_policy pp where pp.tbl || '.' || pp.pname = e))
  into v_scanned, v_ungated, v_unexplained, v_stale;

  -- A zero here is the one answer that must never read as a pass: it would
  -- mean the catalogue query is wrong, not that the schema has no policies.
  -- Every table in this schema has row level security enabled.
  if coalesce(v_scanned, 0) = 0 then
    raise exception
      'assert_password_gate_on_every_policy() scanned 0 policies. This schema has row level security enabled on every table, so 0 means this query is broken rather than that nothing needs checking.'
      using errcode = '42501';
  end if;

  if v_ungated is not null then
    raise exception
      'these policies authorise through a predicate that does not consult public.must_change_password(): %. An account holding an administrator-set password it has not replaced would hold permission through them. Add the gate to the predicate, or declare the policy exempt in public.assert_password_gate_on_every_policy() with the reason it must authorise an account whose actions are not attributable to one person.',
      v_ungated
      using errcode = '42501';
  end if;

  -- A policy naming NO public function cannot inherit the gate at all, so it
  -- has to be declared rather than discovered.
  if v_unexplained is not null then
    raise exception
      'these policies authorise without calling any function in schema public, so no gate can reach them: %. Declare each one exempt in public.assert_password_gate_on_every_policy(), with the reason an account whose actions are not attributable to one person may still use it.',
      v_unexplained
      using errcode = '42501';
  end if;

  -- And the other direction: an exemption whose policy has gone.
  if v_stale is not null then
    raise exception
      'public.assert_password_gate_on_every_policy() exempts policies that no longer exist: %. Remove the exemption; an exemption that outlives its policy silently licenses the next one to take that name.',
      v_stale
      using errcode = '42501';
  end if;

  -- LAST, deliberately. Reachability is the substantive claim and must be the
  -- message a failing build shows; this is the drift guard on top of it. With
  -- the order reversed, reverting is_active_user() reported "no longer states
  -- the gate" and the reachability check never ran at all -- so the control
  -- that exists to exercise reachability was exercising this instead, and
  -- passed. Each check now owns the failure only it can detect.
  select string_agg(n, ', ' order by n) into v_silent
    from unnest(c_must_state_gate) as n
   where not exists (
           select 1
             from pg_catalog.pg_proc p
             join pg_catalog.pg_namespace ns on ns.oid = p.pronamespace
            where ns.nspname = 'public'
              and p.proname = n
              and p.prosrc ~ '\mmust_change_password[[:space:]]*\('
         );

  if v_silent is not null then
    raise exception
      'these predicates no longer state public.must_change_password() in their own body: %. is_active_user() is the gate and has_permission() restates it, so that a reader of the 21 policies naming has_permission finds the gate in the predicate they are reading. Reachability alone cannot see this: has_permission() inherits the gate from is_active_user() either way.',
      v_silent
      using errcode = '42501';
  end if;
end;
$$;

comment on function public.assert_password_gate_on_every_policy() is
  'Fails if any row-level-security policy reachable by the authenticated role authorises through a predicate from which public.must_change_password() is unreachable. Exists because 0019 gated one of the two authorization chains and nothing in the build could see the other; a hand-checked list of policies cannot see the next policy. profiles_select_self is the one declared exemption, and the check fails in both directions so the exemption cannot outlive its reason.';


-- ---------------------------------------------------------------------------
-- 6. Privileges.
--
-- The new assertion function is service_role only, like every other assertion
-- in this schema: it reads the whole policy catalogue, and nothing a signed-in
-- browser does needs it. is_active_user() and has_permission() keep the grants
-- 0009 gave them -- `create or replace` preserves an existing ACL -- and both
-- are on the `authenticated` allowlist inside assert_function_privileges()
-- because row-level-security policies evaluate them.
--
-- public.must_change_password() stays revoked from `authenticated` (0019
-- section 5). The two gated functions are SECURITY DEFINER, so EXECUTE on the
-- rule is checked against the owner rather than the caller. That is a claim
-- about privilege and reachability rather than about code, so the verification
-- script calls is_active_user() as the `authenticated` role and asserts it
-- returns a value instead of raising insufficient_privilege.
-- ---------------------------------------------------------------------------

revoke all on function public.assert_password_gate_on_every_policy()
  from public, anon, authenticated;
grant execute on function public.assert_password_gate_on_every_policy() to service_role;

-- Re-issued because sections 3 and 4 dropped these two functions, and a drop
-- takes the ACL with it. Byte-for-byte the statements 0019 section 5 made.
revoke all on function public.rpc_record_admin_password_set(uuid, text, text, text, uuid, text)
  from public, anon, authenticated;
grant execute on function public.rpc_record_admin_password_set(uuid, text, text, text, uuid, text)
  to service_role;

revoke all on function public.rpc_record_password_changed(uuid, text)
  from public, anon, authenticated;
grant execute on function public.rpc_record_password_changed(uuid, text) to service_role;

select public.assert_function_privileges();
select public.assert_password_gate_on_every_policy();
