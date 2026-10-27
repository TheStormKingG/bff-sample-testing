-- ---------------------------------------------------------------------------
-- 0022_schema_drift_recovery.sql
--
-- A SUPPORTED WAY OUT OF THE DRIFT LATCH, and the correction of two advertised
-- settings that disagree with the code.
--
-- ===========================================================================
-- WHAT WENT WRONG
-- ===========================================================================
-- The latch was write-only. rpc_mark_schema_drifted sets schema_drifted = true
-- with the divergences behind it; nothing cleared it. The one path that could
-- have — rpc_write_workbook_verification with p_schema_drifted => false — was
-- never reached with that argument, because schema-verify/index.ts carried the
-- stored flag forward verbatim on a clean run:
--
--     schemaDrifted: previous.schemaDrifted
--
-- while ALSO passing the seven stages it had just verified. That pair is
-- refused by this file's sibling guard in 0014 (BFF_DRIFT_WITH_VERIFIED_STAGES,
-- SQLSTATE 22023) and the refusal surfaced to the operator as HTTP 500
-- "Something went wrong. Nothing was saved." So an operator who FIXED the
-- workbook was left with a check that kept failing, and the only remedy was a
-- hand-written service_role UPDATE. Nobody in the plant has that.
--
-- ===========================================================================
-- WHY THIS NEEDS A FUNCTION OF ITS OWN
-- ===========================================================================
-- rpc_write_workbook_verification can already set schema_drifted = false, and
-- the primary fix in schema-verify/index.ts could have used it. Two things it
-- cannot do, both of which matter for an UN-latch specifically:
--
--  1. IT IS NOT FENCED. It takes no owner and no fence token. Latching is
--     fenced because "a slow run that lost the workbook must not overwrite a
--     newer worker's verdict" — and that argument is STRONGER in the other
--     direction. A schema-verify run that stalled before a repair, woke up
--     holding a stale reading, and then cleared a latch a newer run had just
--     set would unfence a workbook nobody has verified. So clearing is fenced
--     exactly like latching: same lease, same assert_sheet_lease, same
--     monotonic token.
--
--  2. IT WRITES NO AUDIT EVENT. Latching records one inside its own
--     transaction, so the flag and its evidence cannot disagree. Clearing has
--     to meet the same bar: who lifted the block, when, and what was cleared,
--     committed with the clearing itself rather than written afterwards by a
--     caller whose audit write can fail independently.
--
-- ===========================================================================
-- WHY THIS CANNOT BECOME A "MARK IT FINE" SWITCH
-- ===========================================================================
-- p_verified_stages must name EVERY operational stage, checked here against
-- enum_range(public.sample_stage) rather than against a literal list, so
-- adding an eighth stage tightens this function automatically instead of
-- leaving a gap. A caller that read only some tabs, or that read none, cannot
-- satisfy it. Combined with the caller-side rule that the list is built from
-- what verifySchema() cleared out of a live reading taken in the same request,
-- there is no argument an operator can send that clears a latch over a
-- workbook this function has not been told is wholly clean.
--
-- The guard is deliberately in SQL as well as in TypeScript. The TypeScript
-- planner is what decides; this is what makes a mistaken or malicious second
-- caller fail closed.
-- ---------------------------------------------------------------------------


-- ---------------------------------------------------------------------------
-- rpc_clear_schema_drift(p_workbook_key, p_owner, p_fence, p_actor,
--                        p_verified_at, p_verified_stages)
--
-- Call site: _shared/adapters/store.ts, SupabaseSyncStore.clearSchemaDrift.
-- Returns the number of recorded problems it cleared, so the caller can say
-- whether a latch was actually standing rather than guess.
--
-- p_actor is the authenticated user who ran the check, or NULL for the
-- scheduler, which has no user identity. It is recorded on the audit event as
-- the actor; the scheduler case is attributable through p_owner, which is the
-- request's correlation id, carried in the event payload.
-- ---------------------------------------------------------------------------

create function public.rpc_clear_schema_drift(
  p_workbook_key    text,
  p_owner           text,
  p_fence           bigint,
  p_actor           uuid,
  p_verified_at     timestamptz,
  p_verified_stages text[]
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_stages   public.sample_stage[] := '{}'::public.sample_stage[];
  v_name     text;
  v_expected integer;
  v_cleared  integer;
  v_problems jsonb;
begin
  -- Fenced, exactly as rpc_mark_schema_drifted is. A stale run is refused
  -- here, before it can unfence anything.
  perform public.assert_sheet_lease(p_workbook_key, p_owner, p_fence);

  if p_verified_at is null then
    raise exception
      'BFF_VERIFIED_AT_REQUIRED: clearing drift records WHEN the workbook was read clean'
      using errcode = '22023';
  end if;

  foreach v_name in array coalesce(p_verified_stages, '{}'::text[])
  loop
    if not exists (
      select 1 from unnest(enum_range(null::public.sample_stage)) as e(v)
      where e.v::text = v_name
    ) then
      raise exception
        'BFF_UNKNOWN_STAGE: "%" is not one of the operational stages', v_name
        using errcode = '22023';
    end if;
    if not (v_name::public.sample_stage = any (v_stages)) then
      v_stages := v_stages || v_name::public.sample_stage;
    end if;
  end loop;

  select count(*) into v_expected
  from unnest(enum_range(null::public.sample_stage)) as e(v);

  -- THE GUARD. A partial pass is not a clean workbook, and an empty list is
  -- not a clean workbook either. Counted against the enum, so a new stage
  -- raises the bar without an edit here.
  if cardinality(v_stages) <> v_expected then
    raise exception
      'BFF_PARTIAL_VERIFICATION: the drift block is lifted only by a read that cleared all % operational tabs; this call cleared %',
      v_expected, cardinality(v_stages)
      using errcode = '22023';
  end if;

  select w.schema_problems into v_problems
  from public.sheet_workbook_state w
  where w.workbook_key = p_workbook_key
  for update;

  if not found then
    raise exception 'BFF_UNKNOWN_WORKBOOK: no state row for workbook "%"', p_workbook_key
      using errcode = '23503';
  end if;

  v_cleared := coalesce(jsonb_array_length(coalesce(v_problems, '[]'::jsonb)), 0);

  update public.sheet_workbook_state w
     set schema_drifted   = false,
         schema_problems  = '[]'::jsonb,
         verified_stages  = v_stages,
         last_verified_at = p_verified_at
   where w.workbook_key = p_workbook_key;

  -- In the SAME transaction as the clearing, so the lifted block and the
  -- record of who lifted it cannot disagree. Outcome 'succeeded': this is a
  -- normal, supported operation, unlike the drift event it closes.
  perform public.record_audit_event(
    p_action      => 'sheet_sync.schema_drift_cleared',
    p_entity_type => 'sheet_sync',
    p_entity_id   => p_workbook_key,
    p_reason      => 'A live read of the workbook matched the registry on every operational tab, so the write block recorded by an earlier check was lifted.',
    p_before      => jsonb_build_object('schema_drifted', true, 'problems', coalesce(v_problems, '[]'::jsonb)),
    p_after       => jsonb_build_object(
                       'schema_drifted', false,
                       'verified_stages', to_jsonb(v_stages),
                       'verified_at', p_verified_at,
                       'cleared_by_run', p_owner,
                       'problems_cleared', v_cleared
                     ),
    p_outcome     => 'succeeded',
    p_actor_id    => p_actor
  );

  return v_cleared;
end;
$$;

comment on function public.rpc_clear_schema_drift(text, text, bigint, uuid, timestamptz, text[]) is
  'Lift the schema-drift write block. Fenced on the workbook lease and refused unless the caller names every operational stage as verified, so the block can only be cleared as a consequence of a passing read of the live workbook.';


-- ---------------------------------------------------------------------------
-- PRIVILEGES.
--
-- A SECURITY DEFINER function is EXECUTE-granted to PUBLIC at creation and
-- `ALTER DEFAULT PRIVILEGES ... REVOKE` is inert against that implicit grant,
-- so the revoke names this exact signature. `authenticated` gets nothing: a
-- browser that could call this directly could unfence a workbook without
-- reading it, which is the whole property this file is built to preserve.
-- ---------------------------------------------------------------------------

revoke all on function public.rpc_clear_schema_drift(text, text, bigint, uuid, timestamptz, text[])
  from public, anon, authenticated;
grant execute on function public.rpc_clear_schema_drift(text, text, bigint, uuid, timestamptz, text[])
  to service_role;


-- ---------------------------------------------------------------------------
-- TWO ADVERTISED SETTINGS THAT DISAGREED WITH THE CODE.
--
-- system_config is documentation an operator reads to predict behaviour, and
-- these two rows predicted the wrong behaviour:
--
--   sheet_sync_lease_seconds   advertised 120   code: DEFAULT_LEASE_TTL_MS
--                                               = 60_000 (_shared/lease.ts)
--   sheet_sync_max_attempts    advertised   8   code: DEFAULT_BACKOFF
--                                               .maxAttempts = 6 (backoff.ts)
--
-- Nothing reads either row. Grep over the whole tree finds no reference to
-- sheet_sync_lease_seconds or sheet_sync_max_attempts outside 0005 itself, so
-- these are advertisements, not settings, and the divergence is silent.
--
-- CORRECTED TOWARDS THE CODE, not the other way round, because both code
-- values are reasoned about where they are defined and changing them changes
-- live behaviour: six attempts spanning ~1s to 32s is chosen against the
-- Sheets quota of 60 writes per minute, and the 60-second lease is what the
-- renewal threshold (DEFAULT_RENEW_BEFORE_MS = 20s) is sized against. Raising
-- the advertised numbers to match reality is a documentation fix; lowering the
-- code to match the documentation would be a behaviour change nobody asked
-- for.
--
-- The descriptions now name the constant each value mirrors, so the next
-- divergence is visible in the row itself.
-- ---------------------------------------------------------------------------

update public.system_config
   set value       = '6',
       description = 'Attempts before an outbox event moves to dead_letter and becomes a visible needs-attention item. MIRRORS DEFAULT_BACKOFF.maxAttempts in supabase/functions/_shared/backoff.ts, which is the value actually used; nothing reads this row. Chosen against the Sheets quota of 60 write requests per minute.'
 where key = 'sheet_sync_max_attempts';

update public.system_config
   set value       = '60',
       description = 'How long a sync worker may hold the single-writer lease before it is considered dead and the lease may be taken over with a higher fence token. MIRRORS DEFAULT_LEASE_TTL_MS in supabase/functions/_shared/lease.ts, which is the value actually used; nothing reads this row. DEFAULT_RENEW_BEFORE_MS (20s) is sized against it.'
 where key = 'sheet_sync_lease_seconds';


-- ---------------------------------------------------------------------------
-- The privilege assertion from 0009, run last, over the function this file
-- added. A pass means no function in `public` grants EXECUTE to PUBLIC, anon,
-- or authenticated outside the named RLS-helper allowlist.
-- ---------------------------------------------------------------------------

select public.assert_function_privileges();
