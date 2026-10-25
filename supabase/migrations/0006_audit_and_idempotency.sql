-- ===========================================================================
-- 0006_audit_and_idempotency.sql
--
-- The append-only audit trail, and the request registry that makes a retry
-- safe.
--
-- NFR-005: "event time, actor, original value, new value, reason, disposition
-- and ruleset version maintained; no unlogged destructive changes. Backups
-- alone do not substitute for an audit trail."
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- audit_events  append-only, for every consequential action.
--
-- WHY A TRIGGER AND NOT ONLY A REVOKE.
-- A REVOKE cannot bind a table's owner: the owner holds every privilege
-- implicitly and can re-grant at will, and the SECURITY DEFINER functions that
-- write this table run AS the owner. So `REVOKE UPDATE, DELETE` keeps
-- `authenticated`, `anon` and `service_role` out  worth having  but it is
-- not the control that makes the table append-only. The BEFORE trigger is: a
-- row-level trigger fires for every writer including the owner, and the only
-- way around it (session_replication_role = replica) needs superuser, which a
-- Supabase project role does not have.
--
-- Both are applied below. 0013_security_posture.sql then READS THE CATALOGUE
-- back to confirm the trigger exists and the grants are absent, because a
-- statement returning success is not evidence that it changed anything.
-- ---------------------------------------------------------------------------

create table public.audit_events (
  -- A gapless monotonic sequence, so events can be ordered without relying on
  -- a clock. Two events in the same transaction share occurred_at.
  seq                bigint generated always as identity primary key,
  event_uuid         uuid not null default gen_random_uuid() unique,
  occurred_at        timestamptz not null default now(),

  -- The actor, or NULL for a system action such as the sync worker. The email
  -- is copied in because a profile may later be renamed or disabled and the
  -- event must still say who acted.
  actor_id           uuid references public.profiles (id) on delete restrict,
  actor_email        text,
  -- Resolved from the role membership at the time of the action.
  actor_roles        text[],
  authority_basis    text,

  action             text not null,
  entity_type        text not null,
  entity_id          text,
  sample_uuid        uuid references public.samples (id) on delete restrict,
  reason             text,

  before_payload     jsonb,
  after_payload      jsonb,

  -- The idempotency key of the request that caused it, so a replay can be
  -- traced to the original.
  request_id         uuid,
  -- 'succeeded' | 'denied' | 'failed'. A DENIED attempt is recorded: FR-002
  -- requires an operator's attempt to approve a limit or clear a hold to be
  -- logged, not merely refused. This is why the authority checks in the RPCs
  -- RETURN a denial rather than raising  raising would roll back the very
  -- row that records the attempt.
  outcome            text not null default 'succeeded',
  denial_code        text,
  deployment_version text,

  constraint audit_events_action_present check (length(btrim(action)) > 0),
  constraint audit_events_entity_type_present check (length(btrim(entity_type)) > 0),
  constraint audit_events_outcome_valid
    check (outcome in ('succeeded', 'denied', 'failed')),
  constraint audit_events_denial_has_code
    check (outcome <> 'denied' or denial_code is not null)
);

create index audit_events_sample_idx on public.audit_events (sample_uuid, seq desc)
  where sample_uuid is not null;
create index audit_events_actor_idx on public.audit_events (actor_id, seq desc);
create index audit_events_action_idx on public.audit_events (action, seq desc);
create index audit_events_occurred_idx on public.audit_events (occurred_at desc);
create index audit_events_denied_idx on public.audit_events (seq desc)
  where outcome = 'denied';
create index audit_events_request_idx on public.audit_events (request_id)
  where request_id is not null;

comment on table public.audit_events is
  'Append-only. Enforced by a BEFORE UPDATE OR DELETE trigger, which binds the table owner too; the REVOKEs below are defence in depth, not the control.';
comment on column public.audit_events.outcome is
  'succeeded | denied | failed. Denied attempts are recorded, which is why authority checks return a denial instead of raising.';

create trigger audit_events_append_only
  before update or delete on public.audit_events
  for each row execute function public.tg_append_only();

-- Truncate is not an UPDATE or a DELETE and would not fire the row trigger, so
-- it gets its own statement-level block.
create function public.tg_block_truncate()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception '% cannot be truncated', tg_table_name
    using errcode = '23514';
end;
$$;

create trigger audit_events_block_truncate
  before truncate on public.audit_events
  for each statement execute function public.tg_block_truncate();


-- The canonical way to write an audit event. Every RPC calls this rather than
-- inserting directly, so no call site can forget a field that the audit
-- requires.
create function public.record_audit_event(
  p_action             text,
  p_entity_type        text,
  p_entity_id          text default null,
  p_sample_uuid        uuid default null,
  p_reason             text default null,
  p_before             jsonb default null,
  p_after              jsonb default null,
  p_request_id         uuid default null,
  p_outcome            text default 'succeeded',
  p_denial_code        text default null,
  p_authority_basis    text default null,
  p_actor_id           uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor   uuid := coalesce(p_actor_id, auth.uid());
  v_email   text;
  v_roles   text[];
  v_version text;
  v_uuid    uuid;
begin
  select p.email into v_email from public.profiles p where p.id = v_actor;

  select array_agg(ur.role::text order by ur.role) into v_roles
  from public.user_roles ur
  where ur.user_id = v_actor;

  select c.value into v_version
  from public.system_config c
  where c.key = 'deployment_version';

  insert into public.audit_events (
    actor_id, actor_email, actor_roles, authority_basis,
    action, entity_type, entity_id, sample_uuid, reason,
    before_payload, after_payload, request_id,
    outcome, denial_code, deployment_version
  )
  values (
    v_actor, v_email, v_roles, p_authority_basis,
    p_action, p_entity_type, p_entity_id, p_sample_uuid, p_reason,
    p_before, p_after, p_request_id,
    p_outcome, p_denial_code, v_version
  )
  returning event_uuid into v_uuid;

  return v_uuid;
end;
$$;

comment on function public.record_audit_event is
  'The single writer of public.audit_events. Resolves the actor email, role list and deployment version so a call site cannot omit them.';


-- ---------------------------------------------------------------------------
-- idempotency_requests  one row per client-generated request key.
--
-- Replay semantics, which are the whole point (UAT-04, UAT-13):
--   same key + same payload hash  -> the STORED response is returned, and no
--                                    second sample is created;
--   same key + different payload  -> REJECTED. A retry that is not the same
--                                    request is a programming error or an
--                                    attack, and answering it would silently
--                                    discard one of the two payloads;
--   same key + different actor    -> REJECTED, for the same reason.
--
-- The payload hash is computed by the server from the payload it received. A
-- client-supplied hash would let a caller claim two different payloads are the
-- same request.
-- ---------------------------------------------------------------------------

create table public.idempotency_requests (
  request_id       uuid primary key,
  actor_id         uuid not null references public.profiles (id) on delete restrict,
  operation        text not null,
  payload_hash     text not null,
  outcome          text not null,
  response_payload jsonb not null,
  sample_uuid      uuid references public.samples (id) on delete restrict,
  created_at       timestamptz not null default now(),
  completed_at     timestamptz,
  replay_count     integer not null default 0,
  last_replay_at   timestamptz,

  constraint idempotency_requests_operation_present check (length(btrim(operation)) > 0),
  constraint idempotency_requests_hash_shape check (payload_hash ~ '^[0-9a-f]{64}$'),
  constraint idempotency_requests_outcome_valid
    check (outcome in ('succeeded', 'denied', 'failed')),
  constraint idempotency_requests_replay_count_nonneg check (replay_count >= 0)
);

create index idempotency_requests_actor_idx on public.idempotency_requests (actor_id, created_at desc);
create index idempotency_requests_sample_idx on public.idempotency_requests (sample_uuid)
  where sample_uuid is not null;

comment on table public.idempotency_requests is
  'Replay registry. A repeated key with the same payload returns the same response; with a different payload or actor it is rejected.';

-- SHA-256 of the canonical JSON text. jsonb normalises key order and
-- whitespace on input, so two payloads that differ only in formatting hash
-- identically  which is the behaviour a retry needs. `sha256` is a core
-- function (PostgreSQL 11+), so no extension is required.
create function public.payload_hash(p_payload jsonb)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select encode(sha256(convert_to(coalesce(p_payload, '{}'::jsonb)::text, 'UTF8')), 'hex');
$$;


-- ---------------------------------------------------------------------------
-- Row level security.
-- ---------------------------------------------------------------------------

alter table public.audit_events          enable row level security;
alter table public.idempotency_requests  enable row level security;

create policy audit_events_select_auditors on public.audit_events
  for select to authenticated
  using (public.has_permission('audit.view'));

-- A user may look up their OWN request by key, which is how a client recovers
-- from a timeout: "ask for the status of request X before retrying it"
-- (PRD section 10.3). It discloses only what that client already sent.
create policy idempotency_requests_select_own on public.idempotency_requests
  for select to authenticated
  using (actor_id = auth.uid() and public.is_active_user());

create policy idempotency_requests_select_auditors on public.idempotency_requests
  for select to authenticated
  using (public.has_permission('audit.view'));

-- No write policy on either. Both are written only by SECURITY DEFINER
-- functions.


-- ---------------------------------------------------------------------------
-- Privileges.
-- ---------------------------------------------------------------------------

-- service_role is included in the revoke because an Edge Function must not be
-- able to amend the audit trail even with the service key. It keeps SELECT so
-- an administrative function can read the log, and nothing else.
revoke all on public.audit_events         from anon, authenticated, service_role;
revoke all on public.idempotency_requests from anon, authenticated;

grant select on public.audit_events         to authenticated, service_role;
grant select on public.idempotency_requests to authenticated;

revoke all on function public.tg_block_truncate() from public;

revoke all on function public.record_audit_event(
  text, text, text, uuid, text, jsonb, jsonb, uuid, text, text, text, uuid
) from public;
grant execute on function public.record_audit_event(
  text, text, text, uuid, text, jsonb, jsonb, uuid, text, text, text, uuid
) to service_role;

revoke all on function public.payload_hash(jsonb) from public;
grant execute on function public.payload_hash(jsonb) to authenticated, service_role;
