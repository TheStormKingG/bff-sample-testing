-- ===========================================================================
-- Behavioural proof for the nonconformity lifecycle: the eight RPCs of
-- migration 0051 and the five fixes of 0052.
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
-- Run it with:  npm run verify:nc-lifecycle
-- (which is scripts/run-sql.py reading the project ref out of .env)
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
  v_resid  integer;
  v_nc0    integer;
  v_act0   integer;
  v_seq0   integer;
  v_a2     uuid;
  v_third  uuid;

  -- Build a nonconformity that satisfies every gate-1 precondition, entirely
  -- through the RPCs, and return its id. Each caller then breaks exactly one
  -- thing. A single shared fixture would let one case's breakage mask another.
begin
  -- The row counts BEFORE anything is written.
  --
  -- The first version of this asserted the tables were EMPTY afterwards. That
  -- precondition disappears permanently the first time somebody raises a real
  -- nonconformity, after which the proof can only fail and would be deleted
  -- or commented out — the standard way a verifier is lost. What the rollback
  -- actually claims is that it changed nothing, so that is what is measured.
  select count(*) into v_nc0  from public.nonconformities;
  select count(*) into v_act0 from public.nc_actions;
  select count(*) into v_seq0 from public.nc_number_sequence;

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
      'BFF_NCV_NO_FIXTURE: this needs two active accounts that can close a nonconformity and one that can act but not close. Found close=%, second close=%, act-only=%. Nothing was verified.',
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
      raise exception 'BFF_NCV_A1: number % has the wrong shape', v_num using errcode = '22023';
    end if;
    if (select status from public.nonconformities where id = v_id) <> 'open' then
      raise exception 'BFF_NCV_A2: a raised nonconformity must be open' using errcode = '22023';
    end if;
    if (select classification from public.nonconformities where id = v_id) is not null then
      raise exception 'BFF_NCV_A3: classification must NOT be set at raise time'
        using errcode = '22023';
    end if;

    -- Gate 1 refuses it right now, because nothing has been investigated.
    begin
      perform public.rpc_submit_nc_for_verification(
        v_sup, gen_random_uuid()::text, 'sha256:' || encode(sha256('b'::bytea), 'hex'),
        'probe', v_id);
      raise exception 'BFF_NCV_A4: gate 1 passed a nonconformity with nothing filled in'
        using errcode = '22023';
    exception when others then
      if sqlerrm like 'BFF_NCV_%' then raise; end if;
      v_msg := sqlerrm;
      if v_msg not like '%BFF_NC_GATE_UNMET%' then
        raise exception 'BFF_NCV_A5: wrong refusal: %', v_msg using errcode = '22023';
      end if;
      -- It names EVERY unmet precondition, not the first one.
      if v_msg not like '%classification%' or v_msg not like '%severity%'
         or v_msg not like '%correction%' or v_msg not like '%evaluated%' then
        raise exception 'BFF_NCV_A6: the refusal did not list every unmet item: %', v_msg
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
        raise exception 'BFF_NCV_B1: gate 1 passed with % missing', v_col using errcode = '22023';
      exception when others then
        if sqlerrm like 'BFF_NCV_%' then raise; end if;
        v_msg := sqlerrm;
        if v_msg not like '%BFF_NC_GATE_UNMET%' or v_msg not like '%' || v_case || '%' then
          raise exception 'BFF_NCV_B2: breaking % gave the wrong refusal: %', v_col, v_msg
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
      raise exception 'BFF_NCV_C1: a complete record did not reach awaiting_verification'
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
      raise exception 'BFF_NCV_D1: self_verified must be FALSE when a different person verifies (got %)',
        v_self using errcode = '22023';
    end if;
    if (select status from public.nonconformities where id = v_id) <> 'closed' then
      raise exception 'BFF_NCV_D2: the record did not close' using errcode = '22023';
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
      raise exception 'BFF_NCV_D3: self_verified must be TRUE when the detector verifies (got %)',
        v_self using errcode = '22023';
    end if;

    -- -------------------------------------------------------------------
    -- D3 — TRUE via the OTHER limb: the verifier completed an action but did
    --      not detect the nonconformity.
    --
    -- `self_verified` is `detected_by = actor OR an action was completed by
    -- actor`. D1 and D2 between them only ever exercise the first limb: D2's
    -- verifier is also the detector, and D2 has no completed action at all.
    -- The `completed_by` limb could be DELETED and both would still pass,
    -- which is precisely the hole the FALSE control was added to close —
    -- reappearing one clause along.
    -- -------------------------------------------------------------------
    select nonconformity_id into v_third from public.rpc_raise_nonconformity(
      v_gm, gen_random_uuid()::text, 'sha256:' || encode(sha256('n2'::bytea), 'hex'),
      'probe', 'Mixer discharge gate sticking', 'Gate held open on two batches.', null, null);
    perform public.rpc_update_nonconformity(
      v_gm, gen_random_uuid()::text, 'sha256:' || encode(sha256('o2'::bytea), 'hex'),
      'probe', v_third, 1, 'process', 'minor', 'Gate freed and greased.',
      'Grease interval too long for the duty.', 'other', null,
      true, 'Second time on the same gate.');
    select action_id into v_a2 from public.rpc_add_nc_action(
      v_gm, gen_random_uuid()::text, 'sha256:' || encode(sha256('p2'::bytea), 'hex'),
      'probe', v_third, 'Shorten the greasing interval in the PM schedule.', v_off, current_date);
    -- Completed by v_sup, who did NOT raise it, and who then verifies it.
    perform public.rpc_complete_nc_action(
      v_sup, gen_random_uuid()::text, 'sha256:' || encode(sha256('q2'::bytea), 'hex'),
      'probe', v_a2, 'PM schedule updated to weekly.');
    perform public.rpc_submit_nc_for_verification(
      v_gm, gen_random_uuid()::text, 'sha256:' || encode(sha256('r2'::bytea), 'hex'),
      'probe', v_third);
    select self_verified into v_self from public.rpc_close_nonconformity(
      v_sup, gen_random_uuid()::text, 'sha256:' || encode(sha256('s2'::bytea), 'hex'),
      'probe', v_third, 'Checked the PM schedule and two weeks of greasing records.');
    if v_self is not true then
      raise exception
        'BFF_NCV_D4: self_verified must be TRUE when the verifier completed one of the actions, even though somebody else raised it (got %)',
        v_self using errcode = '22023';
    end if;

    -- -------------------------------------------------------------------
    -- H. Gate 1 is not one-shot (0052).
    --
    -- The update RPC must refuse once the record has left `open`, because
    -- everything it writes is a gate-1 precondition. Before 0052 this
    -- sequence produced a closed, frozen record asserting that corrective
    -- action was required with no root cause and no action ever raised.
    -- -------------------------------------------------------------------
    select nonconformity_id into v_id from public.rpc_raise_nonconformity(
      v_sup, gen_random_uuid()::text, 'sha256:' || encode(sha256('h1'::bytea), 'hex'),
      'probe', 'Gate-1 one-shot check', 'Passes the gate the easy way, then tries to change it.',
      null, null);
    perform public.rpc_update_nonconformity(
      v_sup, gen_random_uuid()::text, 'sha256:' || encode(sha256('h2'::bytea), 'hex'),
      'probe', v_id, 1, 'process', 'minor', 'Reset.', null, null, null,
      false, 'One-off; no systemic cause.');
    perform public.rpc_submit_nc_for_verification(
      v_sup, gen_random_uuid()::text, 'sha256:' || encode(sha256('h3'::bytea), 'hex'),
      'probe', v_id);

    begin
      perform public.rpc_update_nonconformity(
        v_sup, gen_random_uuid()::text, 'sha256:' || encode(sha256('h4'::bytea), 'hex'),
        -- Revision 3, which is CORRECT: raise -> 1, update -> 2, submit -> 3.
        -- A wrong revision here would be refused by the stale-revision check
        -- and this control would pass without the status check existing at
        -- all — which is how it first went green against a mutant.
        'probe', v_id, 3, null, null, null, null, null, null, true, null);
      raise exception
        'BFF_NCV_H1: a gate-1 input was changed AFTER the record passed gate 1'
        using errcode = '22023';
    exception when others then
      if sqlerrm like 'BFF_NCV_%' then raise; end if;
      if sqlerrm not like '%BFF_NC_NOT_OPEN%' then
        raise exception 'BFF_NCV_H2: the post-gate update was refused for the wrong reason: %',
          sqlerrm using errcode = '22023';
      end if;
    end;
    -- Adding an action after the gate is refused too, so the record cannot be
    -- given work it will never be made to complete.
    begin
      perform public.rpc_add_nc_action(
        v_sup, gen_random_uuid()::text, 'sha256:' || encode(sha256('h5'::bytea), 'hex'),
        'probe', v_id, 'Too late.', v_off, current_date);
      raise exception 'BFF_NCV_H3: an action was added after the record passed gate 1'
        using errcode = '22023';
    exception when others then
      if sqlerrm like 'BFF_NCV_%' then raise; end if;
      if sqlerrm not like '%BFF_NC_NOT_OPEN%' then
        raise exception 'BFF_NCV_H4: adding a late action was refused for the wrong reason: %',
          sqlerrm using errcode = '22023';
      end if;
    end;

    -- -------------------------------------------------------------------
    -- I. Gate 2 re-checks gate 1, driven through the one path that can still
    --    reach the bad state.
    --
    -- With H in place, no sequence of RPC calls can make gate 2's re-check
    -- fire, so the check would never once have run. The 0048 guard still
    -- permits a direct UPDATE in `awaiting_verification` — a future RPC, a
    -- migration or a hand-edit — and that is the path a closed, frozen record
    -- would arrive by. A check that cannot be made to fail has not been
    -- tested, so it is made to fail here, deliberately, outside the RPCs.
    -- -------------------------------------------------------------------
    update public.nonconformities set ca_required = true where id = v_id;
    begin
      perform public.rpc_close_nonconformity(
        v_sup, gen_random_uuid()::text, 'sha256:' || encode(sha256('i1'::bytea), 'hex'),
        'probe', v_id, 'Looks done to me.');
      raise exception
        'BFF_NCV_I1: a record was CLOSED while failing the gate it had passed — no root cause, no action'
        using errcode = '22023';
    exception when others then
      if sqlerrm like 'BFF_NCV_%' then raise; end if;
      if sqlerrm not like '%BFF_NC_GATE_UNMET%' then
        raise exception 'BFF_NCV_I2: gate 2 refused, but not on the gate-1 predicate: %', sqlerrm
          using errcode = '22023';
      end if;
      if sqlerrm not like '%root cause%' or sqlerrm not like '%at least one action%' then
        raise exception 'BFF_NCV_I3: gate 2 did not name what was unmet: %', sqlerrm
          using errcode = '22023';
      end if;
    end;
    -- Put it back and close it, so I is not satisfied by a gate 2 that
    -- refuses everything.
    update public.nonconformities set ca_required = false where id = v_id;
    perform public.rpc_close_nonconformity(
      v_sup, gen_random_uuid()::text, 'sha256:' || encode(sha256('i2'::bytea), 'hex'),
      'probe', v_id, 'Scale rechecked against a known weight.');
    if (select status from public.nonconformities where id = v_id) <> 'closed' then
      raise exception 'BFF_NCV_I4: a record satisfying the gate did not close' using errcode = '22023';
    end if;

    -- -------------------------------------------------------------------
    -- J. The `nc_closed_is_verified` CHECK constraint, on its own.
    --
    -- 0048's assertion A7 is labelled "a nonconformity was closed with no
    -- verification" and is in fact satisfied by the lifecycle TRIGGER
    -- refusing the transition. The constraint behind it had no test anywhere.
    -- Tested here through the one transition the trigger permits —
    -- awaiting_verification -> closed — with `verified_by` left null.
    -- -------------------------------------------------------------------
    select nonconformity_id into v_id from public.rpc_raise_nonconformity(
      v_sup, gen_random_uuid()::text, 'sha256:' || encode(sha256('j1'::bytea), 'hex'),
      'probe', 'Constraint check', 'Reaches verification so the guard will allow closure.',
      null, null);
    perform public.rpc_update_nonconformity(
      v_sup, gen_random_uuid()::text, 'sha256:' || encode(sha256('j2'::bytea), 'hex'),
      'probe', v_id, 1, 'process', 'minor', 'Reset.', null, null, null, false, 'One-off.');
    perform public.rpc_submit_nc_for_verification(
      v_sup, gen_random_uuid()::text, 'sha256:' || encode(sha256('j3'::bytea), 'hex'),
      'probe', v_id);
    begin
      update public.nonconformities set status = 'closed' where id = v_id;
      raise exception
        'BFF_NCV_J1: a nonconformity was closed with no verifier, no note and no self_verified'
        using errcode = '22023';
    exception when others then
      if sqlerrm like 'BFF_NCV_%' then raise; end if;
      if sqlerrm not like '%nc_closed_is_verified%' then
        raise exception 'BFF_NCV_J2: closure without a verifier was refused by % , not by the constraint',
          sqlerrm using errcode = '22023';
      end if;
    end;

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
      raise exception 'BFF_NCV_E1: an account without nc.close closed a nonconformity'
        using errcode = '22023';
    exception when others then
      if sqlerrm like 'BFF_NCV_%' then raise; end if;
      -- NAMED, not "any error at all". A bare handler here passes on a typo in
      -- the call, a missing row, a null argument — anything that throws — and
      -- reads exactly like a proof that the permission was enforced.
      if sqlerrm not like '%BFF_NOT_AUTHORISED%' then
        raise exception 'BFF_NCV_E2: the officer was refused, but not for want of authority: %',
          sqlerrm using errcode = '22023';
      end if;
      if sqlerrm not like '%nc.close%' then
        raise exception 'BFF_NCV_E3: the refusal did not name the permission it was about: %',
          sqlerrm using errcode = '22023';
      end if;
    end;

    -- -------------------------------------------------------------------
    -- F. Void is reachable from awaiting_verification, and needs a reason.
    -- -------------------------------------------------------------------
    begin
      perform public.rpc_void_nonconformity(
        v_sup, gen_random_uuid()::text, 'sha256:' || encode(sha256('v'::bytea), 'hex'),
        'probe', v_id, '   ');
      raise exception 'BFF_NCV_F1: a nonconformity was voided with a blank reason'
        using errcode = '22023';
    exception when others then
      if sqlerrm like 'BFF_NCV_%' then raise; end if;
      if sqlerrm not like '%BFF_VOID_REASON_REQUIRED%' then
        raise exception 'BFF_NCV_F3: the blank void reason was refused for the wrong reason: %',
          sqlerrm using errcode = '22023';
      end if;
    end;
    perform public.rpc_void_nonconformity(
      v_sup, gen_random_uuid()::text, 'sha256:' || encode(sha256('w'::bytea), 'hex'),
      'probe', v_id, 'Raised on a mis-read; the shaker log shows a full eight minutes.');
    if (select status from public.nonconformities where id = v_id) <> 'voided' then
      raise exception 'BFF_NCV_F2: the record did not void' using errcode = '22023';
    end if;

    -- -------------------------------------------------------------------
    -- G. A closed record is frozen, and a stale revision is refused.
    -- -------------------------------------------------------------------
    select nonconformity_id into v_id from public.rpc_raise_nonconformity(
      v_sup, gen_random_uuid()::text, 'sha256:' || encode(sha256('x'::bytea), 'hex'),
      'probe', 'Concurrency check', 'Two people editing one record.', null, null);
    -- BOTH DIRECTIONS. The first version of this passed 99 — a revision ABOVE
    -- the row's — which is not the lost-update case at all. A check written as
    -- `p_expected_revision > revision` would have refused it and passed this
    -- control while admitting every real lost update. The stale case is a
    -- revision BELOW the row's, and it is tested first for that reason.
    begin
      perform public.rpc_update_nonconformity(
        v_sup, gen_random_uuid()::text, 'sha256:' || encode(sha256('y'::bytea), 'hex'),
        'probe', v_id, 0, 'process', 'minor', 'x', null, null, null, false, 'y');
      raise exception 'BFF_NCV_G1: a STALE (lower) revision was accepted — this is the lost update'
        using errcode = '22023';
    exception when others then
      if sqlerrm like 'BFF_NCV_%' then raise; end if;
      if sqlerrm not like '%BFF_STALE_REVISION%' then
        raise exception 'BFF_NCV_G2: wrong refusal for a stale revision: %', sqlerrm
          using errcode = '22023';
      end if;
    end;
    begin
      perform public.rpc_update_nonconformity(
        v_sup, gen_random_uuid()::text, 'sha256:' || encode(sha256('y2'::bytea), 'hex'),
        'probe', v_id, 99, 'process', 'minor', 'x', null, null, null, false, 'y');
      raise exception 'BFF_NCV_G3: a revision ABOVE the row''s was accepted' using errcode = '22023';
    exception when others then
      if sqlerrm like 'BFF_NCV_%' then raise; end if;
      if sqlerrm not like '%BFF_STALE_REVISION%' then
        raise exception 'BFF_NCV_G4: wrong refusal for an impossible revision: %', sqlerrm
          using errcode = '22023';
      end if;
    end;
    -- And the CORRECT revision is accepted. Without this, G1 and G3 are
    -- satisfied by a function that refuses every update it is ever given.
    perform public.rpc_update_nonconformity(
      v_sup, gen_random_uuid()::text, 'sha256:' || encode(sha256('y3'::bytea), 'hex'),
      'probe', v_id, 1, 'process', 'minor', 'Accepted at the right revision.',
      null, null, null, false, 'No systemic cause.');
    if (select revision from public.nonconformities where id = v_id) <> 2 then
      raise exception 'BFF_NCV_G5: a correct revision did not advance the row' using errcode = '22023';
    end if;

    raise exception 'BFF_NCV_ROLLBACK';
  exception when others then
    if sqlerrm <> 'BFF_NCV_ROLLBACK' then raise; end if;
  end;

  -- The probe changed nothing. Measured as a DIFFERENCE, so it keeps working
  -- on a project that holds real nonconformities.
  select count(*) into v_resid from public.nonconformities;
  if v_resid <> v_nc0 then
    raise exception 'BFF_NCV_RESIDUE: nonconformities went from % to %; the rollback did not hold',
      v_nc0, v_resid using errcode = '22023';
  end if;
  select count(*) into v_resid from public.nc_actions;
  if v_resid <> v_act0 then
    raise exception 'BFF_NCV_RESIDUE_ACTIONS: nc_actions went from % to %', v_act0, v_resid
      using errcode = '22023';
  end if;
  -- The allocated numbers are rolled back too, so the counter must not have
  -- advanced. This is what stops the probe burning NC numbers on every run.
  select count(*) into v_resid from public.nc_number_sequence;
  if v_resid <> v_seq0 then
    raise exception 'BFF_NCV_RESIDUE_SEQ: nc_number_sequence went from % to % rows', v_seq0, v_resid
      using errcode = '22023';
  end if;

end $probe$;
