-- ===========================================================================
-- 0023 — the reads the Edge Functions make directly, and an assertion that
--        they are possible.
--
-- WHAT WAS BROKEN. An administrator could not create an account. The attempt
-- failed with a bare `internal`, twice, and left nothing behind: no row in
-- `auth.users`, none in `public.profiles`. Measured on the live project, there
-- had NEVER been a successful `admin_action.create_account` in the audit log —
-- the action had not regressed, it had never once worked.
--
-- The cause is one line. `refuseIfAddressTaken`
-- (_shared/handlers/admin.ts:190) checks whether an address is already in use
-- with a DIRECT PostgREST read:
--
--     admin.from('profiles').select('id').eq('email', email).maybeSingle()
--
-- and `admin` is the service-role client. Measured by impersonation:
--
--     set local role service_role; select count(*) from public.profiles;
--       -> ERROR: permission denied for table profiles
--
-- `service_role` holds REFERENCES, TRIGGER and TRUNCATE on every table in
-- `public` and nothing else, with one exception — SELECT on `audit_events`,
-- granted explicitly at 0006:269. The handler turns the permission error into
-- `ApiError('internal')`, which is what the administrator saw.
--
-- FIVE SITES, NOT ONE. The same probe, run against every table an Edge
-- Function reads directly, refused all five and returned the one granted table
-- as readable — so the measurement discriminates rather than failing
-- uniformly:
--
--     profiles                REFUSED      admin.ts:192          create_account
--     samples                 REFUSED      disposition.ts:207    set-disposition
--     sample_measurements     REFUSED      disposition.ts:223    set-disposition
--     specification_versions  REFUSED      specification.ts:94   approve/reject
--     sheet_sync_outbox       REFUSED      sync-action:87        retry sync
--     audit_events            READABLE     (the positive control)
--
-- WHY A GRANT RATHER THAN FIVE NEW RPCs. The alternative was to route each
-- read through a SECURITY DEFINER function, matching how every WORKING path
-- reaches the database. It was rejected on the security question, which is the
-- one that decides it: a SECURITY DEFINER function owned by `postgres` reads
-- these tables with RLS bypassed, and `service_role` reads them with RLS
-- bypassed. The exposure is identical. What differs is only how much code
-- stands between the two, and `service_role` can ALREADY invoke the RPCs that
-- WRITE every one of these tables — so a read grant is strictly less
-- capability than it holds today, not more.
--
-- The grants below are SELECT only, and only on the five tables that are
-- actually read. No INSERT, no UPDATE, no DELETE: every write still goes
-- through a SECURITY DEFINER RPC that re-authorises the actor, which is the
-- control that matters and which this migration does not touch.
--
-- WHY THIS WAS NOT CAUGHT. `assert_function_privileges()` (0009) is a careful,
-- re-run-on-every-migration guard, and it asserts in ONE DIRECTION ONLY: that
-- nothing holds more than it should. `anon` can execute nothing, no function
-- grants EXECUTE to PUBLIC, `authenticated` stays inside its allowlist. There
-- is no assertion anywhere of the opposite shape — that something which NEEDS
-- a privilege HAS it. A hardening suite that only ever subtracts cannot tell
-- the difference between a capability correctly withheld and a capability the
-- application depends on and was never given. That asymmetry is the root
-- cause, and `assert_service_role_reads()` below is the missing half.
-- ===========================================================================

grant select on public.profiles               to service_role;
grant select on public.samples                to service_role;
grant select on public.sample_measurements    to service_role;
grant select on public.specification_versions to service_role;
grant select on public.sheet_sync_outbox      to service_role;


-- ---------------------------------------------------------------------------
-- The assertion in the POSITIVE direction.
--
-- The list below is the contract: these are the tables an Edge Function reads
-- directly, through the service-role client. It is duplicated — deliberately —
-- in `tests/serviceRoleReadContract.test.ts`, which derives the same set by
-- reading every `.from('<table>')` in `supabase/functions` and fails if the two
-- disagree in either direction. So a new direct read that nobody granted fails
-- the test suite, and a grant listed here that no function uses fails it too,
-- which is what stops this list rotting into a permanent widening.
--
-- Written as a function and called immediately, in the style of
-- `assert_function_privileges`, so it is available to be re-run by any later
-- migration that touches grants.
-- ---------------------------------------------------------------------------

create or replace function public.assert_service_role_reads()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  -- The declared contract. Keep in step with tests/serviceRoleReadContract.
  c_tables constant text[] := array[
    'profiles',
    'samples',
    'sample_measurements',
    'specification_versions',
    'sheet_sync_outbox',
    'audit_events'
  ];
  v_missing text;
begin
  select string_agg(t, ', ' order by t)
    into v_missing
  from unnest(c_tables) as t
  where not has_table_privilege('service_role', format('public.%I', t), 'SELECT');

  if v_missing is not null then
    raise exception
      'service_role cannot SELECT from: %. An Edge Function reads each of these directly through the service-role client, so without the grant the request fails with a bare "internal" and the operator is told nothing useful. Grant SELECT, or stop reading the table directly.',
      v_missing
      using errcode = '42501';
  end if;
end;
$$;

revoke all on function public.assert_service_role_reads() from public, anon, authenticated;
grant execute on function public.assert_service_role_reads() to service_role;

comment on function public.assert_service_role_reads() is
  'Fails if service_role cannot SELECT from a table an Edge Function reads directly. The complement of assert_function_privileges, which only ever asserts that nothing holds TOO MUCH; this asserts that what the application depends on is actually granted.';

-- Prove it now, so this migration cannot apply while the defect is present.
select public.assert_service_role_reads();

-- And the existing guard, unchanged, because this migration creates a function.
select public.assert_function_privileges();
