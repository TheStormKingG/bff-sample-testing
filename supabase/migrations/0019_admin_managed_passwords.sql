-- ===========================================================================
-- 0019_admin_managed_passwords.sql
--
-- Administrator-managed email/password sign-in, with a FORCED FIRST CHANGE
-- enforced in the database rather than in the user interface.
--
-- WHY THIS EXISTS. Until now the only way in is Google OAuth. Plant-floor
-- operators do not all have Google accounts, and this project has NO custom
-- SMTP (verified on the live project: `smtp_host` is null,
-- `rate_limit_email_sent` is 2, and Supabase's shared sender only delivers to
-- members of the Supabase organisation). Self-service signup and
-- "forgot password" both depend on delivering a message to the person, so
-- neither can work here. The model that needs no email delivery at all is:
--
--   an administrator creates the account with a TEMPORARY password and tells
--   the holder; the holder signs in and must choose a new one before they can
--   do anything; a forgotten password is reset the same way.
--
-- WHY THE GATE IS IN THE DATABASE AND NOT IN THE UI. A temporary password is,
-- by construction, known to the administrator who typed it. Until it is
-- changed, two people can authenticate as that account, so an action taken
-- under it is not attributable to one person. Attribution is the entire
-- purpose of this system, so a prompt on a screen is not a control: anyone can
-- navigate past it, and PostgREST, the Edge Functions and the RPCs are all
-- reachable without visiting it. The gate therefore lives inside
-- public.require_permission(), the one statement every authority-bearing RPC
-- runs first, so an account with an outstanding change holds NO permission by
-- ANY route.
--
-- WHAT STILL WORKS WHILE A CHANGE IS OUTSTANDING, and must:
--   * signing in — authentication is not a permission;
--   * public.rpc_authority_context() — it deliberately has no permission check
--     (0012), which is what lets the pending/blocked screens render at all;
--   * public.rpc_record_password_changed() below — it must not require a
--     permission, because the whole point is that the caller holds none.
-- Everything else refuses. That is the difference between a control and a
-- prompt.
--
-- PRECEDENT FOLLOWED
--   * 0011_server_authority.sql:201 — require_permission(). It already does
--     STATUS before PERMISSION; the new check is inserted between them, for
--     the reason stated at that point in the file.
--   * 0001_identity.sql:524 — tg_handle_new_auth_user() is PROVIDER-AGNOSTIC.
--     It fires on any auth.users insert, demands an email, derives
--     display_name from raw_user_meta_data->>'full_name' then ->>'name' then
--     the email local part, and lands the profile 'pending'. An
--     administrator-created account therefore provisions itself correctly with
--     no change here, PROVIDED the creation call passes `full_name` in
--     user_metadata. Nothing in this migration touches that trigger.
--   * 0015_rpc_domain_and_admin.sql:1095 — rpc_set_user_roles() is the shape
--     rpc_record_admin_password_set() copies: require_permission, then
--     claim_mutation, then assert_administers_other, then a mandatory reason.
--   * 0018_commissioning_all_roles_grant.sql — house style: idempotent,
--     refuses rather than silently doing nothing, writes an audit event,
--     revokes PUBLIC execute, and ends with assert_function_privileges().
--
-- WHAT THIS FILE NEVER SEES. No password, temporary or chosen, is passed to,
-- stored by, or audited by anything here. Credentials live in `auth.users`,
-- written through the Supabase admin API by the Edge Functions. These
-- functions record only THAT a credential was set and WHEN, which is the part
-- the quality record needs and the only part that is safe to keep.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. The two columns.
--
-- BOTH NULLABLE, and that is the load-bearing decision. Every account that
-- exists today arrived through Google OAuth and has never had an administrator
-- set a password, so NULL is the honest value for them: not "changed long ago"
-- and not "change overdue", but "this never happened". The rule below is
-- written so that NULL in `password_set_by_admin_at` means NO forced change,
-- which is what keeps every current sign-in working. A NOT NULL column with a
-- default would have had to invent a date for a reset that never occurred, and
-- any default would have been either a fabricated history or an immediate
-- lock-out of every existing account.
--
-- `if not exists` so the file survives being applied twice, consistent with
-- 0018's reasoning: idempotency has to hold for the whole file.
-- ---------------------------------------------------------------------------

alter table public.profiles
  add column if not exists password_set_by_admin_at timestamptz,
  add column if not exists password_changed_at      timestamptz;

comment on column public.profiles.password_set_by_admin_at is
  'When an administrator last set this account a password it did not choose. NULL means never -- which is the state of every Google OAuth account and must not force a change. Not a credential and not a hash: only the instant.';

comment on column public.profiles.password_changed_at is
  'When the holder last set their own password. NULL means never. Compared against password_set_by_admin_at by public.must_change_password(); see the <= there.';


-- ---------------------------------------------------------------------------
-- 2. The rule, in exactly one place.
--
-- A forced change is OUTSTANDING when an administrator has set a password and
-- the holder has not changed it SINCE.
--
-- WHY `<=` AND NOT `<`. Both instants come from now(), which is constant for a
-- whole transaction and has microsecond resolution, so an administrator's
-- reset and the holder's own change CAN carry the identical timestamp -- the
-- same transaction, or two transactions that start inside the same microsecond.
-- The tie has to resolve in favour of STILL REQUIRING the change, because the
-- two errors are not symmetric:
--
--   with `<=`, a tie means the holder is asked to change a password they may
--   just have changed. The cost is one extra screen.
--
--   with `<`, a tie means an administrator's reset is treated as already
--   satisfied by a change that happened before it. The account keeps running
--   on a credential the administrator knows, the reset reports success, and
--   nothing anywhere records that it was silently cleared. That is the exact
--   failure this feature exists to prevent, arrived at through the operator
--   doing nothing wrong.
--
-- So the comparison is deliberately biased toward the inconvenient answer.
--
-- SECURITY DEFINER, like public.actor_status() in 0011, because it reads
-- public.profiles and must give the same answer regardless of the calling
-- role's row level security. The coalesce makes the result strictly boolean:
-- a `select` over a missing row yields NULL, and a NULL in `if ... then` is
-- treated as false, so an unprovisioned id would otherwise pass the gate by
-- accident rather than by decision. False is the right answer for it -- no
-- administrator has set it a password -- but it is stated rather than
-- inherited, and require_permission() refuses such an account one check
-- earlier anyway.
-- ---------------------------------------------------------------------------

create or replace function public.must_change_password(p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (
      select p.password_set_by_admin_at is not null
         and (
           p.password_changed_at is null
           -- <= not < : see the file comment above. A tie must mean "still
           -- outstanding", because the alternative silently clears a reset.
           or p.password_changed_at <= p.password_set_by_admin_at
         )
        from public.profiles p
       where p.id = p_user
    ),
    false
  );
$$;

comment on function public.must_change_password(uuid) is
  'True when an administrator set this account a password and the holder has not changed it since. The tie (identical timestamps) resolves to TRUE deliberately: see 0019. Read by public.require_permission(), which is why an outstanding change withholds every permission by every route.';


-- ---------------------------------------------------------------------------
-- 3. THE GATE.
--
-- public.require_permission() is defined in 0011_server_authority.sql:201 and
-- redefined here with `create or replace`, preserving every check it already
-- performs, its signature, its volatility, its empty search_path and its
-- existing grants. Nothing is removed; one check is inserted.
--
-- THE ORDER IS THE DESIGN, and it is:
--
--   1. assert_actor_is_caller  -- is this actor the caller at all
--   2. account active          -- is this account allowed to exist today
--   3. must_change_password    -- is this credential attributable to one person
--   4. the permission itself   -- is this account allowed to do this
--   5. authority basis         -- can the decision be explained in evidence
--
-- Steps 2 and 3 are in that order for a reason worth stating. A suspended
-- account that ALSO owes a password change must be told it is SUSPENDED. The
-- account answer outranks the credential answer because it is the one that
-- cannot be worked around: reversing them would send somebody to change the
-- password on an account that is going to refuse them immediately afterwards,
-- which reads as a broken system and teaches people that the change screen
-- does not work. 0011 already put status before permission on the same
-- reasoning -- "a suspended account with a role still gets the account answer
-- and not the authority answer" -- so this is that rule applied once more,
-- not a new one.
--
-- Step 3 before step 4 matters too, and in the opposite direction: the
-- credential answer outranks the authority answer. An account with an
-- outstanding change must be refused EVEN WHERE IT HOLDS the permission,
-- otherwise the gate would only ever fire for accounts that were going to be
-- refused anyway and would be indistinguishable from doing nothing.
-- ---------------------------------------------------------------------------

create or replace function public.require_permission(
  p_actor      uuid,
  p_permission public.app_permission
)
returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  v_basis text;
begin
  perform public.assert_actor_is_caller(p_actor);

  -- Status before permission, so a suspended account with a role still gets
  -- the account answer and not the authority answer. (0011)
  if not public.actor_is_active(p_actor) then
    raise exception
      'BFF_ACCOUNT_NOT_ACTIVE: account % is %', p_actor,
      coalesce(public.actor_status(p_actor)::text, 'not provisioned')
      using errcode = '42501';
  end if;

  -- Credential before authority. An administrator-set password is known to
  -- that administrator, so until the holder replaces it nothing done under
  -- this account is attributable to one person -- and attribution is what
  -- every record this system writes claims to have. The message says what to
  -- DO, because the person reading it has done nothing wrong and the remedy
  -- is entirely in their hands.
  if public.must_change_password(p_actor) then
    raise exception
      'BFF_PASSWORD_CHANGE_REQUIRED: account % is still using the password an administrator set for it. Choose your own password before continuing -- until you do, the administrator who set it can also sign in as you, so nothing recorded under this account would name one person. Sign in and change it at /change-password; this will then work unchanged.',
      p_actor
      using errcode = '42501';
  end if;

  if not public.actor_has_permission(p_actor, p_permission) then
    raise exception
      'BFF_NOT_AUTHORISED: % is not authorised to %', p_actor, p_permission
      using errcode = '42501';
  end if;

  v_basis := public.actor_authority_basis(p_actor, p_permission);
  if v_basis is null then
    -- actor_has_permission() said yes and actor_authority_basis() cannot name
    -- how. The two read the same tables, so this is unreachable unless they
    -- drift. Refuse: a decision that cannot be explained must not be recorded,
    -- because holds and dispositions store the basis as evidence.
    raise exception
      'BFF_AUTHORITY_UNEXPLAINED: % holds % but no basis could be recorded',
      p_actor, p_permission
      using errcode = '42501';
  end if;

  return v_basis;
end;
$$;

comment on function public.require_permission(uuid, public.app_permission) is
  'The first statement of every authority-bearing RPC. Raises on a non-active account, on an outstanding administrator-set password, or on a missing permission -- in that order -- and returns the authority basis to be recorded as evidence.';


-- ---------------------------------------------------------------------------
-- 4a. rpc_record_admin_password_set
--
-- Call site: the `create_account` and `set_password` actions of the
-- `admin-action` Edge Function, both under `user.manage`. The Edge Function
-- writes the credential to auth.users through the admin API; this records that
-- it happened, which is what arms the forced change.
--
-- Scaffolding copied from rpc_set_user_roles (0015): require_permission, then
-- claim_mutation, then assert_administers_other, then a mandatory reason.
--
-- WHY assert_administers_other IS NOT OPTIONAL HERE. It refuses a self-target.
-- An administrator setting their OWN password through the admin path would be
-- choosing a credential and then not having to change it -- the one account in
-- the system holding `user.manage` would be the one account exempt from the
-- control, and it would be exempt by using the control. That is the same
-- self-elevation the function was written for (0015: "the self-approval, the
-- self-reinstatement and the self-elevation, all at once"). An administrator
-- changes their own password the same way everybody else does, through
-- rpc_record_password_changed below.
--
-- NO STATUS CHECK ON THE TARGET, deliberately. `create_account` calls this
-- immediately after provisioning, when tg_handle_new_auth_user has just landed
-- the profile 'pending'. Requiring an active target would make the primary
-- call site impossible. assert_administers_other still requires the profile to
-- EXIST, so a typo'd uuid is refused rather than recorded against nobody.
--
-- THE OPERATION STRING GIVEN TO claim_mutation IS READ, NOT ASSUMED, and this
-- is a deviation from the siblings that needs stating. The Edge mutation
-- adapter claims the key first, under `admin_action.<action>` (adminSpec() in
-- _shared/handlers/admin.ts). claim_mutation() then refuses any key whose
-- stored operation differs from the string it is handed. Two things follow:
--
--   * This RPC is reachable from TWO actions, `create_account` and
--     `set_password`, so no single hardcoded string can serve both. The set of
--     endpoints that may legitimately claim a key for this RPC is therefore
--     enumerated below rather than assumed to have one member.
--   * Verified against a local build of this schema: claiming a key as the
--     Edge adapter does and then calling the sibling rpc_set_user_roles raises
--     `BFF_IDEMPOTENCY_CONFLICT: operation_mismatch`, because that function
--     hands claim_mutation 'set_user_roles' while the adapter recorded
--     'admin_action.set_roles'. That is a PRE-EXISTING defect in the sibling
--     RPCs, reported separately and deliberately NOT copied here.
--
-- What is NOT weakened: claim_mutation still enforces the actor, the payload
-- hash, the committed-work refusal and the completed-replay refusal, which are
-- the checks that make a retry safe. Only the endpoint name is supplied from
-- the claim, and only after it has been checked against the two-member list.
-- ---------------------------------------------------------------------------

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
  v_basis     text;
  v_operation text;
  v_before    timestamptz;
  v_now       timestamptz := now();
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
    p_before             => jsonb_build_object(
                              'password_set_by_admin_at', v_before,
                              'must_change_password', public.must_change_password(p_target_user)
                            ),
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
  'Records that an administrator set another account a password, which arms the forced change. Refuses a self-target through assert_administers_other: an administrator exempting themselves by using the control is the one case that would defeat it. Never receives or stores the password.';


-- ---------------------------------------------------------------------------
-- 4b. rpc_record_password_changed
--
-- Call site: the `change-own-password` Edge Function, after the holder's new
-- password has been accepted. Acts on p_actor and nothing else; there is no
-- target parameter at all, so there is no argument that could point it at
-- somebody else's account.
--
-- IT MUST NOT CALL require_permission(), and this is not an oversight to be
-- "hardened" later. At the moment this runs, require_permission() is raising
-- BFF_PASSWORD_CHANGE_REQUIRED for exactly this actor -- that is the state the
-- call exists to clear. A permission check here would make the only escape
-- from the gate unreachable and lock every administrator-created account out
-- of the system permanently, while every individual statement looked prudent.
--
-- WHAT STANDS IN ITS PLACE. assert_actor_is_caller(), which is the check that
-- actually matters for this function: it refuses a null actor, and it refuses
-- any caller naming somebody other than themselves whenever an end-user JWT is
-- present. Combined with the absence of a target parameter and the
-- service_role-only grant, the worst a compromised caller can do is record
-- that its own password changed.
--
-- NO STATUS CHECK EITHER, for the same reason as 4a: a 'pending'
-- administrator-created account must be able to clear its temporary credential
-- before it is approved, and a pending account holds no permission regardless.
-- ---------------------------------------------------------------------------

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
  v_before timestamptz;
  v_now    timestamptz := now();
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

  update public.profiles p
     set password_changed_at = v_now
   where p.id = p_actor;

  perform public.record_audit_event(
    p_action             => 'identity.password_changed',
    p_entity_type        => 'profile',
    p_entity_id          => p_actor::text,
    p_reason             => 'The holder set their own password.',
    p_before             => jsonb_build_object(
                              'password_changed_at', v_before,
                              'must_change_password', public.must_change_password(p_actor)
                            ),
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
  'Records that the holder set their own password, clearing an outstanding administrator-set credential. Deliberately does NOT call require_permission(): the caller holds no permission at that moment, by design, and requiring one would make the gate inescapable. Verifies the actor is the caller instead, and has no target parameter.';


-- ---------------------------------------------------------------------------
-- 5. Privileges.
--
-- A SECURITY DEFINER function arrives with EXECUTE granted to PUBLIC by the
-- SQL default, and a Supabase project's default privileges additionally record
-- EXECUTE for `anon` and `authenticated` on every new function in `public`.
-- PUBLIC, anon and authenticated are three different grantees and revoking one
-- does not touch the others, so all three are named per signature. See 0009:
-- `alter default privileges ... revoke` cannot delete a grant that was never
-- recorded as a default, which is why that statement is defence in depth and
-- these are the control.
--
-- `authenticated` gets NONE of these, and must_change_password() is the one to
-- be most careful about: it answers a question about an arbitrary uuid, so a
-- client able to call it could enumerate which accounts in the plant are
-- running on a password an administrator typed for them.
--
-- The assertion at the end is what makes the revokes above more than an
-- intention -- it reads the ACLs that actually exist rather than trusting that
-- these statements had an effect.
-- ---------------------------------------------------------------------------

revoke all on function public.must_change_password(uuid) from public, anon, authenticated;
grant execute on function public.must_change_password(uuid) to service_role;

revoke all on function public.require_permission(uuid, public.app_permission)
  from public, anon, authenticated;
grant execute on function public.require_permission(uuid, public.app_permission)
  to service_role;

revoke all on function public.rpc_record_admin_password_set(uuid, text, text, text, uuid, text)
  from public, anon, authenticated;
grant execute on function public.rpc_record_admin_password_set(uuid, text, text, text, uuid, text)
  to service_role;

revoke all on function public.rpc_record_password_changed(uuid, text)
  from public, anon, authenticated;
grant execute on function public.rpc_record_password_changed(uuid, text) to service_role;

select public.assert_function_privileges();
