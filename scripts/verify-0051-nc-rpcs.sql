-- ===========================================================================
-- Behavioural proof for the eight nonconformity RPCs of migration 0051.
--
-- WHY THIS IS NOT INSIDE THE MIGRATION
-- ------------------------------------
-- It needs three REAL accounts with three different permission sets, and a
-- migration cannot invent those: a profile row is an account somebody was
-- granted, and manufacturing one inside a migration would either fail on the
-- auth foreign key or create a privileged account nobody approved. So the
-- actors are resolved from whatever the project actually has, and the script
-- refuses to run — loudly — if the project cannot supply them. It never
-- skips: a verifier that reports success because its fixture was missing is
-- worse than no verifier.
--
-- EVERYTHING IT WRITES IS ROLLED BACK. The work happens inside a plpgsql
-- sub-block that ends by raising a sentinel, which the outer handler catches;
-- that discards the sub-block's writes, the allocated NC numbers included.
-- Two assertions at the end prove the rollback actually happened, because a
-- probe that leaves rows behind in a live quality system is a defect of its
-- own.
--
-- Run it with:  scripts/run-sql.py <project-ref> < scripts/verify-0051-nc-rpcs.sql
-- or any psql session against the target database. Success is silent.
-- ===========================================================================
do $probe$
declare
  v_sup  uuid;   -- can close
  v_gm   uuid;   -- a DIFFERENT person who can close, for the self_verified pair
  v_off  uuid;   -- can act but must NOT be able to close
  v_id   uuid;
  v_act  uuid;
  v_num  text;
  v_msg  text;
  v_self boolean;
  v_cols text[] := array['classification','severity','correction',
                         'ca_required','ca_rationale','root_cause'];
  v_col  text;
  v_case text;
  v_resid integer;

  -- Build a nonconformity that satisfies every gate-1 precondition, entirely
  -- through the RPCs, and return its id. Each caller then breaks exactly one
  -- thing. A single shared fixture would let one case's breakage mask another.
begin
  -- The fixture, resolved from the project rather than assumed.
  select p.id into v_sup from public.profiles p
   where p.status = 'active' and public.actor_has_permission(p.id, 'nc.close')
   order by p.email limit 1;
  select p.id into v_gm from public.profiles p
   where p.status = 'active' and public.actor_has_permission(p.id, 'nc.close')
     and p.id <> v_sup
   order by p.email limit 1;
  select p.id into v_off from public.profiles p
   where p.status = 'active' and public.actor_has_permission(p.id, 'nc.act')
     and not public.actor_has_permission(p.id, 'nc.close')
   order by p.email limit 1;

  if v_sup is null or v_gm is null or v_off is null then
    raise exception
      'BFF_0051_NO_FIXTURE: this needs two active accounts that can close a nonconformity and one that can act but not close. Found close=%, second close=%, act-only=%. Nothing was verified.',
      v_sup, v_gm, v_off using errcode = '22023';
  end if;

  begin  -- ===== everything below is rolled back by the sentinel at the end ====

    -- -------------------------------------------------------------------
    -- A. The happy path, end to end.
    -- -------------------------------------------------------------------
    select nc_number, nonconformity_id into v_num, v_id
      from public.rpc_raise_nonconformity(
        v_sup, gen_random_uuid()::text, 'sha256:' || encode(sha256('a'::bytea), 'hex'),
        'probe', 'Fines in the pellet cooler', 'Observed excessive fines on the cooler discharge.',
        null, null);
    if v_num !~ '^NC-2026-[0-9]{3,}$' then
      raise exception 'BFF_0051_A1: number % has the wrong shape', v_num using errcode = '22023';
    end if;
    if (select status from public.nonconformities where id = v_id) <> 'open' then
      raise exception 'BFF_0051_A2: a raised nonconformity must be open' using errcode = '22023';
    end if;
    if (select classification from public.nonconformities where id = v_id) is not null then
      raise exception 'BFF_0051_A3: classification must NOT be set at raise time'
        using errcode = '22023';
    end if;

    -- Gate 1 refuses it right now, because nothing has been investigated.
    begin
      perform public.rpc_submit_nc_for_verification(
        v_sup, gen_random_uuid()::text, 'sha256:' || encode(sha256('b'::bytea), 'hex'),
        'probe', v_id);
      raise exception 'BFF_0051_A4: gate 1 passed a nonconformity with nothing filled in'
        using errcode = '22023';
    exception when others then
      if sqlerrm like 'BFF_0051_%' then raise; end if;
      v_msg := sqlerrm;
      if v_msg not like '%BFF_NC_GATE_UNMET%' then
        raise exception 'BFF_0051_A5: wrong refusal: %', v_msg using errcode = '22023';
      end if;
      -- It names EVERY unmet precondition, not the first one.
      if v_msg not like '%classification%' or v_msg not like '%severity%'
         or v_msg not like '%correction%' or v_msg not like '%evaluated%' then
        raise exception 'BFF_0051_A6: the refusal did not list every unmet item: %', v_msg
          using errcode = '22023';
      end if;
    end;

    -- -------------------------------------------------------------------
    -- B. One negative control per precondition.
    --
    -- A single run that fails for one reason proves one check works and says
    -- nothing about the other five. Each case below builds a record that
    -- passes the gate, breaks exactly one thing, and asserts the refusal
    -- names THAT thing.
    -- -------------------------------------------------------------------
    foreach v_col in array v_cols || array['no_actions','action_open'] loop
      -- a complete, gate-passing record
      select nonconformity_id into v_id from public.rpc_raise_nonconformity(
        v_sup, gen_random_uuid()::text, 'sha256:' || encode(sha256('c'::bytea), 'hex'),
        'probe', 'Case ' || v_col, 'Built to pass, then broken in one place.', null, null);
      perform public.rpc_update_nonconformity(
        v_sup, gen_random_uuid()::text, 'sha256:' || encode(sha256('d'::bytea), 'hex'),
        'probe', v_id, 1, 'process', 'minor', 'Cooler airflow reset.',
        'Damper linkage had slipped.', 'five_whys',
        array['Fines high','Airflow low','Damper shut','Linkage slipped','No check on the linkage'],
        true, 'Recurred twice this month.');
      select action_id into v_act from public.rpc_add_nc_action(
        v_sup, gen_random_uuid()::text, 'sha256:' || encode(sha256('e'::bytea), 'hex'),
        'probe', v_id, 'Add the linkage to the weekly check.', v_off, current_date);

      if v_col <> 'action_open' then
        perform public.rpc_complete_nc_action(
          v_sup, gen_random_uuid()::text, 'sha256:' || encode(sha256('f'::bytea), 'hex'),
          'probe', v_act, 'Added to the weekly check sheet, revision 4.');
      end if;

      if v_col = 'no_actions' then
        delete from public.nc_actions where id = v_act;
        v_case := 'at least one action';
      elsif v_col = 'action_open' then
        v_case := 'outstanding';
      else
        execute format('update public.nonconformities set %I = null where id = $1', v_col)
          using v_id;
        v_case := case v_col
                    when 'classification' then 'classification'
                    when 'severity'       then 'severity'
                    when 'correction'     then 'correction'
                    when 'ca_required'    then 'evaluated'
                    when 'ca_rationale'   then 'reason for that evaluation'
                    when 'root_cause'     then 'root cause'
                  end;
      end if;

      begin
        perform public.rpc_submit_nc_for_verification(
          v_sup, gen_random_uuid()::text, 'sha256:' || encode(sha256('g'::bytea), 'hex'),
          'probe', v_id);
        raise exception 'BFF_0051_B1: gate 1 passed with % missing', v_col using errcode = '22023';
      exception when others then
        if sqlerrm like 'BFF_0051_%' then raise; end if;
        v_msg := sqlerrm;
        if v_msg not like '%BFF_NC_GATE_UNMET%' or v_msg not like '%' || v_case || '%' then
          raise exception 'BFF_0051_B2: breaking % gave the wrong refusal: %', v_col, v_msg
            using errcode = '22023';
        end if;
      end;
    end loop;

    -- -------------------------------------------------------------------
    -- C. The complete record passes. Without this, every control above is
    --    satisfied by a gate that refuses everything.
    -- -------------------------------------------------------------------
    select nonconformity_id into v_id from public.rpc_raise_nonconformity(
      v_gm, gen_random_uuid()::text, 'sha256:' || encode(sha256('h'::bytea), 'hex'),
      'probe', 'Moisture over limit at the cooler', 'Two consecutive samples over 12.2 %.',
      null, null);
    perform public.rpc_update_nonconformity(
      v_gm, gen_random_uuid()::text, 'sha256:' || encode(sha256('i'::bytea), 'hex'),
      'probe', v_id, 1, 'product', 'major', 'Batch held and re-dried.',
      'Cooler retention time cut to meet a shipping deadline.', 'five_whys',
      array['Moisture high','Retention short','Deadline','No rule','Nobody owned the trade-off'],
      true, 'Second occurrence in a month.');
    select action_id into v_act from public.rpc_add_nc_action(
      v_gm, gen_random_uuid()::text, 'sha256:' || encode(sha256('j'::bytea), 'hex'),
      'probe', v_id, 'Write a minimum retention time into the pelleting SOP.', v_off, current_date);
    perform public.rpc_complete_nc_action(
      v_gm, gen_random_uuid()::text, 'sha256:' || encode(sha256('k'::bytea), 'hex'),
      'probe', v_act, 'SOP-PEL-02 revision 3 issued.');
    perform public.rpc_submit_nc_for_verification(
      v_gm, gen_random_uuid()::text, 'sha256:' || encode(sha256('l'::bytea), 'hex'),
      'probe', v_id);
    if (select status from public.nonconformities where id = v_id) <> 'awaiting_verification' then
      raise exception 'BFF_0051_C1: a complete record did not reach awaiting_verification'
        using errcode = '22023';
    end if;

    -- -------------------------------------------------------------------
    -- D. self_verified is COMPUTED, both ways.
    --
    -- The false control is the one that matters: without it, a hardcoded
    -- `true` passes the true case and nothing notices.
    -- -------------------------------------------------------------------
    -- D1 — FALSE: raised and actioned by gmail, closed by yahoo.
    select self_verified into v_self from public.rpc_close_nonconformity(
      v_sup, gen_random_uuid()::text, 'sha256:' || encode(sha256('m'::bytea), 'hex'),
      'probe', v_id, 'Checked SOP-PEL-02 rev 3 and four days of cooler records.');
    if v_self is not false then
      raise exception 'BFF_0051_D1: self_verified must be FALSE when a different person verifies (got %)',
        v_self using errcode = '22023';
    end if;
    if (select status from public.nonconformities where id = v_id) <> 'closed' then
      raise exception 'BFF_0051_D2: the record did not close' using errcode = '22023';
    end if;

    -- D2 — TRUE: raised, actioned and closed by the same person.
    select nonconformity_id into v_id from public.rpc_raise_nonconformity(
      v_sup, gen_random_uuid()::text, 'sha256:' || encode(sha256('n'::bytea), 'hex'),
      'probe', 'Bagging scale drifting', 'Three bags 300 g light.', null, null);
    perform public.rpc_update_nonconformity(
      v_sup, gen_random_uuid()::text, 'sha256:' || encode(sha256('o'::bytea), 'hex'),
      'probe', v_id, 1, 'process', 'minor', 'Scale recalibrated.', null, null, null,
      false, 'One-off; the load cell was knocked during cleaning.');
    perform public.rpc_submit_nc_for_verification(
      v_sup, gen_random_uuid()::text, 'sha256:' || encode(sha256('p'::bytea), 'hex'),
      'probe', v_id);
    select self_verified into v_self from public.rpc_close_nonconformity(
      v_sup, gen_random_uuid()::text, 'sha256:' || encode(sha256('q'::bytea), 'hex'),
      'probe', v_id, 'Weighed ten bags; all within tolerance.');
    if v_self is not true then
      raise exception 'BFF_0051_D3: self_verified must be TRUE when the detector verifies (got %)',
        v_self using errcode = '22023';
    end if;

    -- -------------------------------------------------------------------
    -- E. Authority. The officer can act but must not close.
    -- -------------------------------------------------------------------
    select nonconformity_id into v_id from public.rpc_raise_nonconformity(
      v_off, gen_random_uuid()::text, 'sha256:' || encode(sha256('r'::bytea), 'hex'),
      'probe', 'Sieve shaker stopped mid-test', 'Shaker cut out at four minutes.', null, null);
    perform public.rpc_update_nonconformity(
      v_off, gen_random_uuid()::text, 'sha256:' || encode(sha256('s'::bytea), 'hex'),
      'probe', v_id, 1, 'process', 'minor', 'Test repeated.', null, null, null,
      false, 'Loose plug; no systemic cause.');
    perform public.rpc_submit_nc_for_verification(
      v_off, gen_random_uuid()::text, 'sha256:' || encode(sha256('t'::bytea), 'hex'),
      'probe', v_id);
    begin
      perform public.rpc_close_nonconformity(
        v_off, gen_random_uuid()::text, 'sha256:' || encode(sha256('u'::bytea), 'hex'),
        'probe', v_id, 'Looks fine to me.');
      raise exception 'BFF_0051_E1: an account without nc.close closed a nonconformity'
        using errcode = '22023';
    exception when others then
      if sqlerrm like 'BFF_0051_%' then raise; end if;
      null;  -- refused, which is the point
    end;

    -- -------------------------------------------------------------------
    -- F. Void is reachable from awaiting_verification, and needs a reason.
    -- -------------------------------------------------------------------
    begin
      perform public.rpc_void_nonconformity(
        v_sup, gen_random_uuid()::text, 'sha256:' || encode(sha256('v'::bytea), 'hex'),
        'probe', v_id, '   ');
      raise exception 'BFF_0051_F1: a nonconformity was voided with a blank reason'
        using errcode = '22023';
    exception when others then
      if sqlerrm like 'BFF_0051_%' then raise; end if;
      null;
    end;
    perform public.rpc_void_nonconformity(
      v_sup, gen_random_uuid()::text, 'sha256:' || encode(sha256('w'::bytea), 'hex'),
      'probe', v_id, 'Raised on a mis-read; the shaker log shows a full eight minutes.');
    if (select status from public.nonconformities where id = v_id) <> 'voided' then
      raise exception 'BFF_0051_F2: the record did not void' using errcode = '22023';
    end if;

    -- -------------------------------------------------------------------
    -- G. A closed record is frozen, and a stale revision is refused.
    -- -------------------------------------------------------------------
    select nonconformity_id into v_id from public.rpc_raise_nonconformity(
      v_sup, gen_random_uuid()::text, 'sha256:' || encode(sha256('x'::bytea), 'hex'),
      'probe', 'Concurrency check', 'Two people editing one record.', null, null);
    begin
      perform public.rpc_update_nonconformity(
        v_sup, gen_random_uuid()::text, 'sha256:' || encode(sha256('y'::bytea), 'hex'),
        'probe', v_id, 99, 'process', 'minor', 'x', null, null, null, false, 'y');
      raise exception 'BFF_0051_G1: a stale revision was accepted' using errcode = '22023';
    exception when others then
      if sqlerrm like 'BFF_0051_%' then raise; end if;
      if sqlerrm not like '%BFF_STALE_REVISION%' then
        raise exception 'BFF_0051_G2: wrong refusal for a stale revision: %', sqlerrm
          using errcode = '22023';
      end if;
    end;

    raise exception 'BFF_0051_ROLLBACK';
  exception when others then
    if sqlerrm <> 'BFF_0051_ROLLBACK' then raise; end if;
  end;

  -- The probe left nothing behind.
  select count(*) into v_resid from public.nonconformities;
  if v_resid <> 0 then
    raise exception 'BFF_0051_RESIDUE: % nonconformity row(s) survived the probe', v_resid
      using errcode = '22023';
  end if;
  select count(*) into v_resid from public.nc_number_sequence;
  if v_resid <> 0 then
    raise exception 'BFF_0051_RESIDUE_SEQ: the number sequence was not rolled back'
      using errcode = '22023';
  end if;
end $probe$;
