-- ===========================================================================
-- 0050 — who holds the nonconformity permissions, and who may read the rows.
--
-- Separate from 0049 because a new enum value cannot be used in the
-- transaction that adds it. See that migration's header.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Role mapping.
--
-- `administrator` is deliberately NOT given any of these. It administers
-- accounts and lists; it does not make quality decisions, and the role split
-- in this system has held that line everywhere else.
-- ---------------------------------------------------------------------------
insert into public.role_permissions (role, permission) values
  ('operator',           'nc.raise'),
  ('quality_officer',    'nc.raise'),
  ('quality_officer',    'nc.act'),
  ('quality_supervisor', 'nc.raise'),
  ('quality_supervisor', 'nc.act'),
  ('quality_supervisor', 'nc.close')
on conflict do nothing;


-- ---------------------------------------------------------------------------
-- 2. Row-level security.
--
-- READ mirrors `samples_select_viewers`: `has_permission('sample.view')`.
-- The draft-owner branch that policy carries has no counterpart here — a
-- nonconformity has no draft state and no private phase.
--
-- THERE IS NO INSERT, UPDATE OR DELETE POLICY, on purpose. Every write goes
-- through a SECURITY DEFINER RPC holding the service role, exactly as
-- samples do. An absent policy denies by default, and that default is the
-- control: a signed-in account with a hacked browser cannot write these
-- tables at all, only call the functions it has permission for.
-- ---------------------------------------------------------------------------
alter table public.nonconformities    enable row level security;
alter table public.nc_actions         enable row level security;
alter table public.nc_number_sequence enable row level security;

create policy nonconformities_select_viewers on public.nonconformities
  for select using (public.has_permission('sample.view'::public.app_permission));

create policy nc_actions_select_viewers on public.nc_actions
  for select using (public.has_permission('sample.view'::public.app_permission));

-- The sequence table is readable by nobody. It holds no quality information
-- — only a counter — and the number it issues is on the nonconformity.


-- ---------------------------------------------------------------------------
-- 3. Prove it.
--
-- Both halves on every refusal, and a control for every refusal: a check
-- that something is denied passes just as well when the subject does not
-- exist, when the role was never assumed, or when the statement was
-- malformed for an unrelated reason.
-- ---------------------------------------------------------------------------
do $$
declare
  v_who    uuid;
  v_raised text;
  v_n      integer;
  v_fail   text := '';
begin
  select id into v_who from public.profiles where status='active' limit 1;

  -- a. The role mapping landed, and landed where it was aimed.
  select count(*) into v_n from public.role_permissions
   where permission::text in ('nc.raise','nc.act','nc.close');
  if v_n <> 6 then
    v_fail := v_fail || format('expected 6 nc role grants, found %s; ', v_n);
  end if;

  if exists (select 1 from public.role_permissions
              where role = 'administrator' and permission::text like 'nc.%') then
    v_fail := v_fail || 'administrator was granted a nonconformity permission; ';
  end if;

  if not exists (select 1 from public.role_permissions
                  where role = 'operator' and permission::text = 'nc.raise') then
    v_fail := v_fail || 'operator cannot raise a nonconformity; ';
  end if;

  if exists (select 1 from public.role_permissions
              where role = 'operator' and permission::text = 'nc.close') then
    v_fail := v_fail || 'operator can close a nonconformity; ';
  end if;

  -- b. RLS is actually ON. A policy on a table with RLS disabled is
  --    decoration, and reads exactly like a protected table.
  select count(*) into v_n from pg_class
   where relname in ('nonconformities','nc_actions','nc_number_sequence')
     and relrowsecurity;
  if v_n <> 3 then
    v_fail := v_fail || format('RLS enabled on %s of 3 tables; ', v_n);
  end if;

  -- c. There is no write policy on any of the three.
  select count(*) into v_n from pg_policy p join pg_class c on c.oid = p.polrelid
   where c.relname in ('nonconformities','nc_actions','nc_number_sequence')
     and p.polcmd <> 'r';
  if v_n <> 0 then
    v_fail := v_fail || format('%s write polic(ies) exist; writes must go through RPCs; ', v_n);
  end if;

  -- d. REFUSAL, both halves: `authenticated` cannot insert directly.
  begin
    set local role authenticated;
    v_raised := null;
    begin
      insert into public.nonconformities (nc_number, title, description, detected_by)
      values ('NC-2098-001', 'x', 'x', v_who);
    exception when others then v_raised := sqlerrm;
    end;
    reset role;
  exception when others then
    reset role;
    raise;
  end;
  if v_raised is null then
    v_fail := v_fail || 'authenticated inserted a nonconformity directly; ';
  end if;
  select count(*) into v_n from public.nonconformities where nc_number = 'NC-2098-001';
  if v_n <> 0 then
    v_fail := v_fail || 'the directly-inserted row exists anyway; ';
  end if;

  -- e. CONTROL for (d). The same insert as the owner SUCCEEDS, so (d) is not
  --    passing because the statement itself was wrong.
  --
  --    Undone by rolling the sub-block back, NOT by deleting the row: this
  --    schema forbids deleting a nonconformity, and the first draft of this
  --    control tried to tidy up with a DELETE and failed on its own guard.
  --    A control that cannot clean up after itself is still a control that
  --    does not run.
  begin
    insert into public.nonconformities (nc_number, title, description, detected_by)
    values ('NC-2098-002', 'x', 'x', v_who);
    raise exception 'BFF_0050_CONTROL_ROLLBACK';
  exception when others then
    if sqlerrm <> 'BFF_0050_CONTROL_ROLLBACK' then
      v_fail := v_fail || 'control: the owner could not insert either (' || sqlerrm || '); ';
    end if;
  end;

  -- f. ...and the control left nothing behind.
  select count(*) into v_n from public.nonconformities where nc_number = 'NC-2098-002';
  if v_n <> 0 then
    v_fail := v_fail || 'the control row survived its rollback; ';
  end if;

  if v_fail <> '' then
    raise exception 'BFF_0050: %', v_fail using errcode = '22023';
  end if;
end $$;
