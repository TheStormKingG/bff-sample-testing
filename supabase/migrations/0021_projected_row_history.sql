-- ===========================================================================
-- 0021_projected_row_history.sql
--
-- One read: every row this system has projected for a sample, and which of
-- them was the confirmed one.
--
-- WHY THIS EXISTS. The sync worker located an operational row by its sample ID
-- in column A and then rewrote EVERY column of it. A cell a Quality Officer
-- had corrected by hand in Google Sheets — a tester's name, a comment such as
-- "Accepted. Aflatoxin within vendor reference." — became an empty string, and
-- the outcome reported was `confirmed`. No warning, no dead letter, nothing on
-- the needs-attention list. In a quality record the hand-written correction is
-- frequently the most important cell on the row: it is the human judgement the
-- record exists to capture.
--
-- The system already said it would not do this, in two places.
-- `_shared/reconcile.ts` emits "The sheet was edited directly; the system will
-- not overwrite it without review", and `_shared/projection.ts` quotes Master
-- Prompt section 7: "surface drift caused by direct human sheet edits instead
-- of silently overwriting important records". Reconciliation classified the
-- condition correctly as `cell_mismatch` -> `administrator_must_review_edit`
-- and excluded it from requeue — but reconciliation only REPORTS, and
-- `reconcile-sheets/index.ts` states that its report blocks nothing. The
-- vocabulary existed; the enforcement did not.
--
-- WHAT THE WRITER WAS MISSING. `decideProjection()` already blocked on
-- duplicate rows, a vanished confirmed row, a row in the protected header
-- region, a bad row width and a column-A identity mismatch. It had no check
-- for "the located row's CONTENT is not what we last put there", because
-- nothing gave it the material to make that comparison: the claimed event
-- carries its OWN `projected_row`, which is what the app is about to write,
-- and a legitimate update differs from the sheet by exactly the cells it means
-- to change. Comparing against the intended row therefore cannot tell "the app
-- is updating this" from "a human typed this". The honest comparison is
-- against what the app PREVIOUSLY projected, and that is what this function
-- returns.
--
-- WHY THE WHOLE SET AND NOT JUST THE CONFIRMED ROW. A write can land and then
-- time out: the event is unconfirmed while its row IS in the sheet. The next
-- event for the same sample would then find content no confirmed baseline
-- explains, and would be blocked although the app itself wrote it. That
-- ordering is reachable, not theoretical: rpc_claim_outbox_batch orders by
-- next_retry_at, so a freshly enqueued revision 2 (next_retry_at = now())
-- sorts ahead of a revision 1 waiting out a backoff.
--
-- WHY `last_attempt_at is not null` IS THE FILTER. It is the precise form of
-- "this system could have put that content in the sheet". rpc_claim_outbox_batch
-- sets last_attempt_at when it claims the event, which is BEFORE the write, so
-- the filter also admits a worker that died between writing the row and
-- recording the outcome. `attempt_count > 0` would not: the counter is
-- incremented by rpc_record_outbox_outcome, which is exactly the step that
-- never ran in that case, so the row would be in the sheet with the counter
-- still at zero and the next event would refuse to proceed.
--
-- An event that was never claimed cannot explain anything in the sheet, and
-- admitting its projection would let content a human typed pass the guard
-- whenever it happened to match a queued revision. So the filter is a
-- correctness condition in both directions.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- rpc_read_sample_projected_rows(p_sample_uuid)
--
-- Call site: _shared/adapters/store.ts, one named argument. Return shape:
-- SampleProjectionRow (declared in _shared/rpc.ts).
--
-- Serves BOTH of the worker's needs from one query, cached per sample for the
-- duration of one event:
--
--   projectedRowsFor() -> every row in this result, the set the located row
--                         must match one of
--   confirmedRow()     -> the row of the single `was_confirmed` entry, used
--                         ONLY to name the cells a human changed in the
--                         blocked message
--
-- NEWEST FIRST so the caller never has to sort. A sample has one stage, so
-- every projected_row in the result has the same width and no per-stage filter
-- is needed; the sample's own stage is the only one it can have.
--
-- STABLE and read-only. It reads one sample's own outbox events and returns no
-- identifier, no spreadsheet id and no credential.
-- ---------------------------------------------------------------------------

create function public.rpc_read_sample_projected_rows(p_sample_uuid uuid)
returns table (
  payload_revision integer,
  -- True for the event whose write was verified by a read-back. At most one
  -- row of the result carries true: sheet_sync_outbox_one_per_revision makes
  -- the (sample, kind, revision) unique, and only a confirmed event may hold a
  -- confirmed_at (sheet_sync_outbox_confirmation_shape).
  was_confirmed    boolean,
  projected_row    text[]
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    o.payload_revision,
    o.state = 'confirmed',
    o.projected_row
  from public.sheet_sync_outbox o
  where o.sample_uuid = p_sample_uuid
    -- Claimed at least once, so this system could have written it. See the
    -- header: deliberately NOT attempt_count > 0.
    and o.last_attempt_at is not null
  order by o.payload_revision desc, o.created_at desc;
$$;

comment on function public.rpc_read_sample_projected_rows(uuid) is
  'Every row this system has projected for one sample in an outbox event that was CLAIMED at least once, newest first, with the confirmed one flagged. The writer compares the row currently in the sheet against this set; a row matching none of them was edited by hand and is refused rather than overwritten.';


-- ---------------------------------------------------------------------------
-- Privileges.
--
-- A SECURITY DEFINER function is EXECUTE-granted to PUBLIC by default, and
-- `alter default privileges ... revoke` cannot remove a grant that was never
-- recorded, so the revoke has to name this signature. Revoked from anon and
-- authenticated as well as PUBLIC: a signed-in user reaches the database
-- through an Edge Function and a service-role RPC, never a direct PostgREST
-- call. assert_function_privileges() below is the check that this held.
-- ---------------------------------------------------------------------------

revoke all on function public.rpc_read_sample_projected_rows(uuid)
  from public, anon, authenticated;
grant execute on function public.rpc_read_sample_projected_rows(uuid) to service_role;

select public.assert_function_privileges();
