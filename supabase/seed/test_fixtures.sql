-- ===========================================================================
--
--   ######################################################################
--   ##                                                                  ##
--   ##   T E S T   O N L Y  -  N E V E R   L O A D   I N T O            ##
--   ##   P R O D U C T I O N                                            ##
--   ##                                                                  ##
--   ##   THIS IS THE ONLY FILE IN THE REPOSITORY IN WHICH AN APPROVED   ##
--   ##   ACCEPTANCE LIMIT MAY APPEAR.                                   ##
--   ##                                                                  ##
--   ######################################################################
--
-- supabase/seed/test_fixtures.sql
--
-- WHY THIS FILE EXISTS
--
-- UAT-06 exercises the boundary behaviour of the assessment engine: with an
-- approved 84-86 degC rule for conditioned mash temperature, 84 and 86 must
-- read Within Limit and 83.9 and 86.1 must read Outside Limit. That test
-- cannot run on production data, because production data contains NO approved
-- rule at all - 0 of the 34 workbook `Limits` entries is approved, so every
-- measurement there correctly assesses as Not Assessable. The two facts are
-- not in tension: one is the engine's arithmetic, the other is the plant's
-- actual approval state.
--
-- So the approved rule lives here, in a file that production never loads.
--
-- WHY 84-86 IS NOT AN INVENTED LIMIT
--
-- Build rule 7 forbids inventing a numeric acceptance limit anywhere. The
-- number here is not invented: 84-86 degC is workbook `Limits` entry 15, and
-- the registry's own help text quotes the workbook - "After conditioning the
-- target is 84 to 86 degC so the mash cooks through". What this file adds is
-- not the NUMBER, it is the APPROVAL - and the approval is fictional, which is
-- exactly why it must not escape into a production database.
--
-- In the real workbook entry 15 carries status "Set", which is a POLINUTRI
-- VENDOR REFERENCE from the feed factory specialist's visit of 23 October
-- 2026, not a Bounty Farm approval. Treating a vendor's recommendation as an
-- approved acceptance limit is the precise failure this system exists to
-- prevent, and it is the failure this file would cause if it were ever
-- applied to production. The reference-only import of entry 15 stays exactly
-- as it is (version 1, `reference_only`); this file adds a SEPARATE version 2.
--
-- WHY IT IS NOT IN config.toml
--
-- supabase/config.toml lists only the two production-safe seed files in
-- `[db.seed].sql_paths`, and says why this one is absent. `supabase db reset`
-- therefore never applies it.
--
-- ---------------------------------------------------------------------------
-- HOW TO RUN IT  (test databases only)
--
--   psql "$TEST_DB_URL" -v ON_ERROR_STOP=1 \
--     -c "set app.allow_test_fixtures = 'yes';" \
--     -f supabase/seed/test_fixtures.sql
--
-- The opt-in setting is the control, and it is an honest one: this file
-- refuses to do anything without it, and `supabase db reset` does not set it,
-- so the file cannot be dragged into the production seed path by accident or
-- by somebody adding it to sql_paths.
--
-- What the setting is NOT: it is not a detector of production. Nothing in a
-- database reliably says "I am production" - a deployment_version, a hostname
-- or a row count can all be made to look like anything - so this file does not
-- pretend to check. It requires a human to say yes, in the open, at the
-- command line. If you are typing that flag against a production URL, no
-- guard in this file will save you.
--
-- ---------------------------------------------------------------------------
-- WHAT IT CREATES
--
--   * three test identities on the reserved `.test` TLD (RFC 2606), so no
--     fixture address can ever route to a real mailbox:
--       uat.admin@bff-sample-testing.test       administrator
--       uat.officer@bff-sample-testing.test     quality_officer   (proposer)
--       uat.supervisor@bff-sample-testing.test  quality_supervisor (approver)
--   * one APPROVED specification version: conditioned.temperature, 84-86 degC.
--
-- Two separate people are required, not as a convention but because
-- `specification_versions_two_person_approval` is a CHECK constraint: an
-- approved row must name a proposer AND a different approver. Even a fixture
-- cannot store a self-approved rule. The approver is the quality_supervisor,
-- because that is the only role holding spec.approve; the administrator holds
-- no quality authority and could not approve this rule in the application
-- either.
--
-- The approved version deliberately carries NO `workbook_entry_no` and no
-- `workbook_status`: it is a locally authored rule, not an imported workbook
-- row. That keeps the production import's own "0 of 34 approved" gate green
-- and keeps the two kinds of record distinguishable in an audit.
--
-- Re-runnable: every insert conflicts to DO NOTHING.
-- ===========================================================================

begin;

do $$
declare
  v_optin      text := coalesce(current_setting('app.allow_test_fixtures', true), '');
  v_admin      uuid := '00000000-0000-4000-8000-000000000a01';
  v_officer    uuid := '00000000-0000-4000-8000-000000000a02';
  v_supervisor uuid := '00000000-0000-4000-8000-000000000a03';
  v_existing   uuid;
  v_spec       uuid;
  v_next_ver   integer;
  v_approved   integer;
begin
  if v_optin <> 'yes' then
    raise exception
      'supabase/seed/test_fixtures.sql refuses to run: app.allow_test_fixtures is not ''yes''.'
      using hint = 'This file creates an APPROVED acceptance limit and must never be loaded into production. On a test database, run psql with -c "set app.allow_test_fixtures = ''yes'';" first.';
  end if;

  -- -----------------------------------------------------------------------
  -- Identities. Inserted into auth.users so the real provisioning trigger
  -- creates the profiles, which is what production does: a fixture that wrote
  -- public.profiles directly would be testing a path no sign-in ever takes.
  -- -----------------------------------------------------------------------
  insert into auth.users (
    id, instance_id, aud, role, email, encrypted_password,
    email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
    created_at, updated_at
  ) values
    (v_admin, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
     'uat.admin@bff-sample-testing.test', null, now(),
     '{"provider":"google","providers":["google"]}'::jsonb,
     '{"full_name":"UAT Administrator"}'::jsonb, now(), now()),
    (v_officer, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
     'uat.officer@bff-sample-testing.test', null, now(),
     '{"provider":"google","providers":["google"]}'::jsonb,
     '{"full_name":"UAT Quality Officer"}'::jsonb, now(), now()),
    (v_supervisor, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
     'uat.supervisor@bff-sample-testing.test', null, now(),
     '{"provider":"google","providers":["google"]}'::jsonb,
     '{"full_name":"UAT Quality Supervisor"}'::jsonb, now(), now())
  on conflict (id) do nothing;

  -- Somebody has to have let these accounts in. If the database already has a
  -- founding administrator, reuse it rather than minting a second one:
  -- `profiles_single_bootstrap_basis` permits exactly one profile to carry the
  -- founding basis, ever.
  select p.id into v_existing
    from public.profiles p
   where p.approval_basis = 'first_administrator_bootstrap'
   limit 1;

  -- `v_existing = v_admin` is the re-run case: this fixture already made its
  -- own administrator the founding one. It takes the founding branch again,
  -- which is idempotent. Routing it through the else branch instead would set
  -- `approved_by` to the account's own id and be rejected by
  -- `profiles_no_self_approval`.
  if v_existing is null or v_existing = v_admin then
    -- Fresh database (the normal case after `supabase db reset`): the fixture
    -- administrator becomes the founding one. A founding grant has no approver
    -- and no grantor by definition - there is nobody else in the system yet -
    -- and `profiles_active_requires_approval` allows exactly that shape.
    update public.profiles
       set status = 'active',
           approval_basis = 'first_administrator_bootstrap',
           approved_by = null,
           approved_at = now()
     where id = v_admin;
    v_existing := v_admin;

    insert into public.user_roles (user_id, role, granted_by, reason)
    values (v_admin, 'administrator', null, 'UAT fixture founding administrator')
    on conflict (user_id, role) do nothing;
  else
    -- A founding administrator already exists, so this one is an ORDINARY
    -- appointment and must look like one: approved by a named person and
    -- granted by a named person. Activating the profile and granting the role
    -- have to move together - a pending profile holding the administrator role
    -- is an incoherent record, and a NULL grantor would falsely claim the row
    -- was a founding bootstrap.
    update public.profiles
       set status = 'active',
           approval_basis = 'approved_by_administrator',
           approved_by = v_existing,
           approved_at = now()
     where id = v_admin
       and status <> 'active';

    insert into public.user_roles (user_id, role, granted_by, reason)
    values (v_admin, 'administrator', v_existing, 'UAT fixture administrator, appointed by the existing founding administrator')
    on conflict (user_id, role) do nothing;
  end if;

  -- The two quality accounts are approved by the administrator, which is the
  -- real route: `profiles_active_requires_approval` will not let an account be
  -- active without naming who let it in.
  update public.profiles
     set status = 'active',
         approval_basis = 'approved_by_administrator',
         approved_by = v_existing,
         approved_at = now()
   where id in (v_officer, v_supervisor)
     and status <> 'active';

  insert into public.user_roles (user_id, role, granted_by, reason) values
    (v_officer,    'quality_officer',    v_existing, 'UAT fixture: proposer of the UAT-06 rule'),
    (v_supervisor, 'quality_supervisor', v_existing, 'UAT fixture: approver of the UAT-06 rule')
  on conflict (user_id, role) do nothing;

  -- -----------------------------------------------------------------------
  -- The approved rule: conditioned.temperature, 84-86 degC inclusive.
  --
  -- src/lib/assessment.ts compares with `value < lowerBound` and
  -- `value > upperBound`, so the bounds are INCLUSIVE and UAT-06 reads:
  --     84    -> Within Limit      (not below 84)
  --     86    -> Within Limit      (not above 86)
  --     83.9  -> Outside Limit     (below 84)
  --     86.1  -> Outside Limit     (above 86)
  -- -----------------------------------------------------------------------
  select id into v_spec
    from public.specifications
   where parameter_key = 'conditioned.temperature';

  if v_spec is null then
    raise exception
      'Test fixture cannot run: specification conditioned.temperature does not exist.'
      using hint = 'Apply the production seed first (supabase db reset applies seed/0001 and seed/0002), then this fixture.';
  end if;

  select count(*) into v_approved
    from public.specification_versions
   where parameter_key = 'conditioned.temperature'
     and status = 'approved';

  if v_approved = 0 then
    select coalesce(max(version), 0) + 1 into v_next_ver
      from public.specification_versions
     where specification_id = v_spec;

    insert into public.specification_versions (
      specification_id, version, parameter_key, stage,
      unit, lower_bound, upper_bound,
      status, effective_from,
      proposed_by, proposed_at, approved_by, approved_at,
      source_evidence
    ) values (
      v_spec, v_next_ver, 'conditioned.temperature', 'conditioned',
      '°C', 84, 86,
      'approved', '2026-10-24 00:00:00+00'::timestamptz,
      v_officer, now(), v_supervisor, now(),
      'TEST FIXTURE ONLY (supabase/seed/test_fixtures.sql). A FICTIONAL approval of the '
      || '84-86 degC conditioned-mash range so UAT-06 can exercise the boundary arithmetic. '
      || 'The number is workbook `Limits` entry 15, whose real status is "Set" - a Polinutri '
      || 'vendor reference from the visit of 23 October 2026, NOT a Bounty Farm approval. '
      || 'This row must never exist in a production database.'
    );
  end if;

  -- -----------------------------------------------------------------------
  -- End-state gate: read back what is actually there.
  -- -----------------------------------------------------------------------

  -- All three fixture accounts must be ACTIVE. A pending profile holds no
  -- permission at all, so a fixture that left one pending would make a test
  -- fail with an authorisation error that looks like a product defect. This
  -- check exists because an earlier version of this file did exactly that:
  -- on a database that already had a founding administrator it granted the
  -- administrator role while skipping the activation, and nothing complained.
  if (select count(*) from public.profiles
       where id in (v_admin, v_officer, v_supervisor) and status = 'active') <> 3 then
    raise exception
      'Test fixture gate failed: not all three fixture accounts are active (%).',
      (select string_agg(format('%s=%s', email, status), ', ' order by email)
         from public.profiles where id in (v_admin, v_officer, v_supervisor));
  end if;

  -- A NULL grantor on a role row is reserved for the founding bootstrap. Any
  -- other role grant naming no grantor misrepresents how authority was
  -- conferred, which is the one thing the audit trail exists to answer.
  if (select count(*) from public.user_roles ur
        join public.profiles p on p.id = ur.user_id
       where ur.user_id in (v_admin, v_officer, v_supervisor)
         and ur.granted_by is null
         and p.approval_basis <> 'first_administrator_bootstrap') <> 0 then
    raise exception
      'Test fixture gate failed: a fixture role grant has no grantor but the holder is not the founding administrator.';
  end if;

  select count(*) into v_approved
    from public.specification_versions
   where parameter_key = 'conditioned.temperature'
     and status = 'approved'
     and lower_bound = 84
     and upper_bound = 86
     and approved_by is not null
     and approved_by <> proposed_by
     and workbook_entry_no is null;

  if v_approved <> 1 then
    raise exception
      'Test fixture gate failed: expected exactly 1 approved 84-86 conditioned.temperature rule with two distinct actors and no workbook provenance, found %. UAT-06 would report a misleading result.',
      v_approved;
  end if;

  -- More than one approved rule for this parameter would make the engine
  -- report `ambiguous_rules` (Not Assessable) rather than a boundary verdict,
  -- and UAT-06 would fail for a reason that has nothing to do with the
  -- boundary arithmetic it is testing.
  if (select count(*) from public.specification_versions
       where parameter_key = 'conditioned.temperature' and status = 'approved') <> 1 then
    raise exception
      'Test fixture gate failed: more than one approved rule for conditioned.temperature. The engine would return ambiguous_rules instead of a boundary verdict.';
  end if;

  raise notice
    'TEST FIXTURE applied. An APPROVED 84-86 degC rule now exists for conditioned.temperature. This database must never be promoted to production.';
end $$;

commit;
