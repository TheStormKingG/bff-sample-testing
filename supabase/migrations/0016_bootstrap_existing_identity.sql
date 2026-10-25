-- ---------------------------------------------------------------------------
-- 0016 — apply the first-administrator grant to an identity that ALREADY exists.
--
-- THE GAP THIS CLOSES.
--
-- `supabase/seed/bootstrap_first_administrator.sql` arms an allowlist row, and
-- the ONLY thing that consumes it is `public.tg_handle_new_auth_user()`, which
-- is `after insert on auth.users`. That works when the allowlist is armed
-- before anyone signs in.
--
-- It does not work in the order that actually happened: the founding identity
-- signed in FIRST, so `auth.users` already holds that row and the insert
-- trigger will never fire for it again. Arming the grant afterwards leaves it
-- unconsumed forever, the profile stays `pending`, and there is no
-- administrator anywhere who could approve it — the precise "unrecoverable
-- system" the seed's own comment warns about, reached from the other
-- direction. The failure is silent: the seed reports success, because arming
-- the grant IS all the seed claims to do.
--
-- So this is a second consumption path for an identity that already exists. It
-- performs exactly what the trigger performs, including the same audit action,
-- so a system bootstrapped either way is indistinguishable afterwards.
--
-- It is NOT a way to appoint further administrators. It refuses when any
-- administrator exists, exactly as the seed does. Subsequent appointments go
-- through `public.grant_role()`, which records who granted them and why.
--
-- An Administrator still holds NO quality authority: no specification
-- approval, no hold clearing, no material release. That is in
-- `public.role_permissions` and this changes none of it.
-- ---------------------------------------------------------------------------

create function public.apply_bootstrap_admin_grant()
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_admin_count bigint;
  v_grant_email text;
  v_user_id     uuid;
begin
  -- Same refusal as the seed and the trigger: the founding bootstrap is for an
  -- empty system.
  select count(*) into v_admin_count
    from public.user_roles ur
   where ur.role = 'administrator';

  if v_admin_count > 0 then
    raise exception
      'Refusing to run: % administrator(s) already exist. The founding bootstrap is for an empty system.',
      v_admin_count
      using errcode = '42501',
            hint = 'A further administrator is appointed by an existing administrator through public.grant_role(), which records who granted it and why.';
  end if;

  -- Select the unconsumed grant whose address ALREADY HAS A PROFILE, rather
  -- than any unconsumed grant.
  --
  -- More than one grant can legitimately be armed at a time — a verification
  -- harness arms one, or a nomination was made for somebody who has not signed
  -- in yet. Picking an arbitrary unconsumed row then fails on the wrong
  -- address and reports that the identity "has not signed in", which is true
  -- of that row and irrelevant to the caller. Joining to `profiles` makes the
  -- function select the only grant it can actually act on.
  --
  -- FOR UPDATE for the same reason the trigger takes it: two callers racing
  -- for one grant must not both win. `of g` locks the grant row only, since
  -- the join to profiles is a lookup rather than a row this function claims.
  select g.email, p.id
    into v_grant_email, v_user_id
    from public.bootstrap_admin_grants g
    join public.profiles p on p.email = g.email
   where g.consumed_at is null
   order by g.email
   limit 1
   for update of g;

  if v_grant_email is null then
    raise exception
      'No unconsumed first-administrator grant matches an existing profile. Either no grant is armed (arm one with supabase/seed/bootstrap_first_administrator.sql), or the allowlisted identity has not signed in yet — in which case the sign-in trigger will consume it without this function.'
      using errcode = 'P0002';
  end if;

  update public.profiles
     set status         = 'active',
         approval_basis = 'first_administrator_bootstrap',
         approved_by    = null,
         approved_at    = now()
   where id = v_user_id;

  insert into public.user_roles (user_id, role, granted_by, reason)
  values (v_user_id, 'administrator', null, 'first-administrator bootstrap');

  update public.bootstrap_admin_grants
     set consumed_at = now(),
         consumed_by = v_user_id
   where email = v_grant_email;

  -- Same action name as the trigger writes, so the audit trail does not record
  -- two different kinds of founding. The reason distinguishes the path.
  insert into public.audit_events (
    actor_id, actor_email, action, entity_type, entity_id, reason, after_payload, outcome
  )
  values (
    v_user_id, v_grant_email, 'identity.bootstrap_administrator', 'profile', v_user_id::text,
    'First-administrator bootstrap allowlist consumed for an identity that had already signed in',
    jsonb_build_object('role', 'administrator', 'status', 'active'), 'succeeded'
  );

  return v_grant_email;
end;
$$;

-- A SECURITY DEFINER function is granted EXECUTE to PUBLIC by default, and
-- `alter default privileges ... revoke` cannot remove a grant that was never
-- recorded as a default. State the revoke per signature.
revoke all on function public.apply_bootstrap_admin_grant() from public, anon, authenticated;
grant execute on function public.apply_bootstrap_admin_grant() to service_role;

comment on function public.apply_bootstrap_admin_grant() is
  'Consumes the first-administrator allowlist for an identity that already exists in auth.users, which the after-insert sign-in trigger can no longer do. Refuses when any administrator exists. service_role only.';

select public.assert_function_privileges();
