#!/usr/bin/env bash
#
# Verify 0019_admin_managed_passwords.sql as a CONTROL, in both directions —
# modelled on scripts/verify-0018-commissioning-grant.sh and for the same
# reason: a script that only ever ran the happy path would report a pass
# whether or not the gate does anything.
#
# WHAT IT PROVES
#   0. The INPUT SET, before any instrument is trusted: the two columns exist
#      with the declared type and nullability, the profile population is
#      non-empty, and no account that exists is forced to change. The order is
#      deliberate — a positive control reads its subject through the same
#      machinery as the check it validates, so an empty population would make
#      every later assertion pass vacuously.
#   1. THE RULE. An admin set arms the change; the holder's own change clears
#      it; a later reset re-arms it; and identical timestamps resolve to TRUE,
#      with a one-microsecond control proving that probe can return FALSE.
#   2. THE GATE. require_permission REFUSES a permission the account GENUINELY
#      HOLDS while a change is outstanding, and the SAME call SUCCEEDS once the
#      change is recorded. Both halves, through the direct function AND through
#      a real RPC (rpc_retry_dead_lettered), because "no permission by any
#      route" is a claim about routes. A suspended account that also owes a
#      change is told it is SUSPENDED.
#   3. THE RPCs. rpc_record_password_changed works for an actor holding NO
#      permissions at all; rpc_record_admin_password_set refuses a self-target
#      and an empty reason, and leaves nothing behind when it refuses; the
#      Edge-shaped idempotency claim is accepted and a foreign one is not; and
#      no audit payload contains a credential.
#   4. PRIVILEGES. PUBLIC, anon and authenticated can execute none of the new
#      functions — asserted against the ACLs that actually exist, with a
#      positive control proving the probe can return TRUE, because a revoke
#      that is never read back has been observed in this codebase to be inert.
#      Plus the one that the whole gate rests on: `authenticated` holds no
#      UPDATE on public.profiles, so the forced change cannot be self-cleared
#      through PostgREST.
#
# EVERY NEGATIVE HAS A POSITIVE CONTROL. Where a check asserts that something
# is refused, absent or false, there is a sibling check asserting the same
# probe returns the opposite for a case that should pass. Without it a broken
# probe and a working control are indistinguishable.
#
# WHAT IT DOES NOT PROVE: that RLS denies a real request, that Supabase Auth
# accepts the password, or that the Edge Functions call these RPCs correctly.
# This is a plain PostgreSQL database with a shim — see
# scripts/local-sql-shim.sql.
#
# Usage:  scripts/verify-0019-admin-managed-passwords.sh [dbname]
#
set -euo pipefail

DB="${1:-bff_0019_scratch}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

MIGRATION="supabase/migrations/0019_admin_managed_passwords.sql"

# The accounts. Fixed uuids so every assertion names its subject in the output.
ADMIN_ID='aaaaaaaa-0000-4000-8000-000000000001'
ADMIN2_ID='aaaaaaaa-0000-4000-8000-000000000002'
OP_ID='bbbbbbbb-0000-4000-8000-000000000001'
PENDING_ID='cccccccc-0000-4000-8000-000000000001'
SUSP_ID='dddddddd-0000-4000-8000-000000000001'
ADMIN='founder-0019@example.invalid'
ADMIN2='second-admin-0019@example.invalid'
OPERATOR='operator-0019@example.invalid'
PENDING='pending-0019@example.invalid'
SUSPENDED='suspended-0019@example.invalid'

HASH="sha256:$(printf 'a%.0s' $(seq 1 64))"

# Same safety guard as verify-migrations.sh, for the same reason: this script
# drops the database it is given, and a prompt is a control that fails under
# haste. Refuse anything that does not look unmistakably like a throwaway.
if [[ ! "$DB" =~ ^bff_[a-z0-9_]*(check|verify|scratch|tmp)[a-z0-9_]*$ ]]; then
  echo "REFUSING to touch database '$DB' — it must match" >&2
  echo "  ^bff_[a-z0-9_]*(check|verify|scratch|tmp)[a-z0-9_]*\$" >&2
  exit 2
fi
if [ ! -e "$MIGRATION" ]; then
  echo "FAIL: $MIGRATION does not exist. Nothing was verified." >&2
  exit 1
fi

fails=0
checks=0

# ONE STATEMENT PER CALL, and that is load-bearing rather than tidy. psql wraps
# several statements passed in a single -c in ONE transaction, and now() is
# constant for a whole transaction — so an admin set and the holder's own
# change issued together would carry the identical timestamp and hit the tie
# case on purpose-built state instead of the case under test. Separate calls
# are separate transactions, which is also what two HTTP requests are.
q() { psql -X -q -t -A -v ON_ERROR_STOP=1 "$DB" -c "$1"; }

pass() { checks=$((checks + 1)); printf '  ok    %s\n' "$1"; }
fail() { checks=$((checks + 1)); fails=$((fails + 1)); printf '  FAIL  %s\n' "$1"; }

# Assert on a VALUE, never on an exit code alone: a query that errors prints
# nothing and exits non-zero, which must not be read as "the value was empty".
expect() { # expect <label> <actual> <wanted>
  if [ "$2" = "$3" ]; then pass "$1 ($3)"; else fail "$1 — wanted '$3', got '$2'"; fi
}

# A refusal is only the right refusal if it names the right reason. "It threw"
# is satisfied by a typo in the SQL, by a missing function, and by the control
# working — three outcomes that must not share an assertion.
raises() { # raises <label> <sql> <expected substring>
  local out
  if out="$(psql -X -q -t -A -v ON_ERROR_STOP=1 "$DB" -c "$2" 2>&1)"; then
    fail "$1 — the call SUCCEEDED; nothing was refused"
    return
  fi
  if printf '%s' "$out" | grep -q -- "$3"; then
    pass "$1 (refused with $3)"
  else
    fail "$1 — refused, but not with $3. Got: $(printf '%s' "$out" | head -2 | tr '\n' ' ')"
  fi
}

succeeds() { # succeeds <label> <sql>
  if psql -X -q -t -A -v ON_ERROR_STOP=1 "$DB" -c "$2" >/dev/null 2>&1; then
    pass "$1"
  else
    fail "$1 — the call raised when it should have been allowed"
  fi
}

echo "== Building $DB from scratch (every migration, in order) =="
BOOTSTRAP_ADMIN_EMAIL="$ADMIN" scripts/verify-migrations.sh "$DB" >/dev/null 2>&1 \
  || { echo "FAIL: scripts/verify-migrations.sh did not pass; fix that first." >&2; exit 1; }
pass "schema applied, including $(basename "$MIGRATION")"

# ---------------------------------------------------------------------------
echo "== 0. The input set, before any instrument is trusted =="
# ---------------------------------------------------------------------------
expect "password_set_by_admin_at exists, timestamptz, nullable" \
  "$(q "select data_type||'/'||is_nullable from information_schema.columns
         where table_schema='public' and table_name='profiles'
           and column_name='password_set_by_admin_at'")" \
  "timestamp with time zone/YES"
expect "password_changed_at exists, timestamptz, nullable" \
  "$(q "select data_type||'/'||is_nullable from information_schema.columns
         where table_schema='public' and table_name='profiles'
           and column_name='password_changed_at'")" \
  "timestamp with time zone/YES"
expect "must_change_password(uuid) exists exactly once" \
  "$(q "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
         where n.nspname='public' and p.proname='must_change_password'")" "1"
expect "both new RPCs exist" \
  "$(q "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
         where n.nspname='public'
           and p.proname in ('rpc_record_admin_password_set','rpc_record_password_changed')")" "2"

# A Google sign-in, through the system's own provisioning trigger. This is the
# account every existing account resembles: never given a password by anybody.
q "insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data)
   values ('$ADMIN_ID','$ADMIN',jsonb_build_object('full_name','Founder 0019'),'{}'::jsonb)" >/dev/null
expect "the founder provisioned itself active, through the bootstrap path" \
  "$(q "select status from public.profiles where id='$ADMIN_ID'")" "active"

# THE DENOMINATOR, asserted before the property. "0 accounts are forced to
# change" is also what an empty table reports, and that reading would make
# every later check vacuous.
POP="$(q "select count(*) from public.profiles")"
if [ "$POP" -gt 0 ]; then pass "the profile population is non-empty ($POP)"
else fail "no profiles exist — every 'nobody is forced to change' check below would pass vacuously"; fi
expect "NO existing account is forced to change (the Google-OAuth case)" \
  "$(q "select count(*) from public.profiles p where public.must_change_password(p.id)")" "0"
expect "and the founder specifically is not" \
  "$(q "select public.must_change_password('$ADMIN_ID')")" "f"

# The other accounts. A second administrator exists because
# assert_administers_other refuses a self-target, so arming the FIRST
# administrator requires a real second one rather than a hand-written column.
q "insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data)
   values ('$ADMIN2_ID','$ADMIN2',jsonb_build_object('full_name','Second Admin'),'{}'::jsonb)" >/dev/null
q "update public.profiles set status='active', approval_basis='approved_by_administrator',
          approved_by='$ADMIN_ID', approved_at=now() where id='$ADMIN2_ID'" >/dev/null
q "insert into public.user_roles (user_id, role, granted_by, reason)
   values ('$ADMIN2_ID','administrator','$ADMIN_ID','second administrator for 0019 verification')" >/dev/null
q "insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data)
   values ('$OP_ID','$OPERATOR',jsonb_build_object('full_name','Plant Operator'),'{}'::jsonb)" >/dev/null
q "update public.profiles set status='active', approval_basis='approved_by_administrator',
          approved_by='$ADMIN_ID', approved_at=now() where id='$OP_ID'" >/dev/null
q "insert into public.user_roles (user_id, role, granted_by, reason)
   values ('$OP_ID','operator','$ADMIN_ID','operator for 0019 verification')" >/dev/null
q "insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data)
   values ('$PENDING_ID','$PENDING','{}'::jsonb,'{}'::jsonb)" >/dev/null
q "insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data)
   values ('$SUSP_ID','$SUSPENDED','{}'::jsonb,'{}'::jsonb)" >/dev/null
q "update public.profiles set status='suspended' where id='$SUSP_ID'" >/dev/null
expect "the operator is active and holds operator" \
  "$(q "select p.status||'/'||string_agg(ur.role::text,',') from public.profiles p
         join public.user_roles ur on ur.user_id=p.id
         where p.id='$OP_ID' group by p.status")" "active/operator"
expect "the pending account holds NO roles at all" \
  "$(q "select count(*) from public.user_roles where user_id='$PENDING_ID'")" "0"

# THE INSTRUMENT'S OWN INPUT ASSERTION. Everything in section 2 turns on this
# permission being genuinely held BEFORE anything is armed. If it is not, a
# later refusal proves nothing about the gate.
expect "the operator GENUINELY holds sample.register, before anything is armed" \
  "$(q "select public.require_permission('$OP_ID','sample.register')")" "base_role:operator"

# ---------------------------------------------------------------------------
echo "== 1. The rule in public.must_change_password =="
# ---------------------------------------------------------------------------
succeeds "an administrator records a password set for the operator (through the RPC)" \
  "select 1 from public.rpc_record_admin_password_set(
     '$ADMIN_ID','verify-0019-set-operator-001','$HASH','verify',
     '$OP_ID','temporary password issued at the plant')"
expect "after the admin set, must_change_password is TRUE" \
  "$(q "select public.must_change_password('$OP_ID')")" "t"
expect "password_set_by_admin_at was written, password_changed_at was not" \
  "$(q "select (password_set_by_admin_at is not null)::text||'/'||(password_changed_at is null)::text
         from public.profiles where id='$OP_ID'")" "true/true"

succeeds "the holder records their own change (through the RPC)" \
  "select 1 from (select public.rpc_record_password_changed('$OP_ID','verify')) s"
expect "after the holder's own change, must_change_password is FALSE" \
  "$(q "select public.must_change_password('$OP_ID')")" "f"

succeeds "a SECOND administrator resets it again, after that change" \
  "select 1 from public.rpc_record_admin_password_set(
     '$ADMIN2_ID','verify-0019-reset-operator-002','$HASH','verify',
     '$OP_ID','password forgotten; reset at the plant')"
expect "a reset AFTER a change makes it TRUE again" \
  "$(q "select public.must_change_password('$OP_ID')")" "t"

# THE TIE. Identical timestamps cannot be produced by two separate
# transactions, so they are written directly — which is honest about what is
# being tested: the COMPARISON, not the writers. The state is reachable in
# reality whenever both records land in one transaction (now() is constant for
# a transaction), which is exactly when the wrong answer would be silent.
q "update public.profiles
      set password_set_by_admin_at = '2026-01-01 12:00:00.123456+00',
          password_changed_at      = '2026-01-01 12:00:00.123456+00'
    where id='$OP_ID'" >/dev/null
expect "IDENTICAL timestamps resolve to TRUE (the <= case: a tie must not clear a reset)" \
  "$(q "select public.must_change_password('$OP_ID')")" "t"
# The control. Without it, a probe hardwired to 't' would pass the line above.
q "update public.profiles set password_changed_at = '2026-01-01 12:00:00.123457+00'
    where id='$OP_ID'" >/dev/null
expect "one microsecond LATER resolves to FALSE (so the tie probe can return f)" \
  "$(q "select public.must_change_password('$OP_ID')")" "f"
q "update public.profiles set password_changed_at = '2026-01-01 12:00:00.123455+00'
    where id='$OP_ID'" >/dev/null
expect "one microsecond EARLIER resolves to TRUE" \
  "$(q "select public.must_change_password('$OP_ID')")" "t"
expect "an id with no profile is FALSE, not null (the gate must not be entered by accident)" \
  "$(q "select public.must_change_password('00000000-0000-4000-8000-00000000dead')")" "f"

# ---------------------------------------------------------------------------
echo "== 2. The gate in public.require_permission — BOTH halves =="
# ---------------------------------------------------------------------------
# The operator still owes a change (set at 12:00:00.123456, changed
# 12:00:00.123455). The permission it holds has not changed.
raises "a permission the account GENUINELY HOLDS is refused while a change is outstanding" \
  "select public.require_permission('$OP_ID','sample.register')" \
  "BFF_PASSWORD_CHANGE_REQUIRED"

succeeds "the holder clears it again" \
  "select 1 from (select public.rpc_record_password_changed('$OP_ID','verify')) s"
expect "THE POSITIVE CONTROL: the SAME call now SUCCEEDS" \
  "$(q "select public.require_permission('$OP_ID','sample.register')")" "base_role:operator"

# The real-RPC route, on an account that genuinely holds the RPC's permission.
# administrator carries sync.retry, so rpc_retry_dead_lettered is a route that
# must close while a change is outstanding and open again once it is recorded.
expect "the founder holds sync.retry, before anything is armed" \
  "$(q "select public.require_permission('$ADMIN_ID','sync.retry')")" "base_role:administrator"
succeeds "rpc_retry_dead_lettered SUCCEEDS for the founder while nothing is outstanding" \
  "select public.rpc_retry_dead_lettered('$ADMIN_ID','verify')"
succeeds "a second administrator arms the founder, through the RPC" \
  "select 1 from public.rpc_record_admin_password_set(
     '$ADMIN2_ID','verify-0019-arm-founder-003','$HASH','verify',
     '$ADMIN_ID','founder password reset by the second administrator')"
raises "that RPC route now CLOSES — no permission by any route, not only the direct one" \
  "select public.rpc_retry_dead_lettered('$ADMIN_ID','verify')" \
  "BFF_PASSWORD_CHANGE_REQUIRED"
succeeds "the founder records its own change" \
  "select 1 from (select public.rpc_record_password_changed('$ADMIN_ID','verify')) s"
succeeds "THE POSITIVE CONTROL for the route: the SAME RPC call succeeds again" \
  "select public.rpc_retry_dead_lettered('$ADMIN_ID','verify')"

# Status outranks credential. A suspended account that also owes a change must
# be told it is SUSPENDED, so nobody is sent to fix a password on an account
# that will refuse them afterwards anyway.
q "update public.profiles set password_set_by_admin_at = now() where id='$SUSP_ID'" >/dev/null
expect "the suspended account genuinely owes a change (so the next check is not vacuous)" \
  "$(q "select public.must_change_password('$SUSP_ID')")" "t"
raises "a SUSPENDED account that also owes a change is told it is NOT ACTIVE" \
  "select public.require_permission('$SUSP_ID','sample.view')" \
  "BFF_ACCOUNT_NOT_ACTIVE"
# And the control that the password error is reachable at all for that subject:
# flip only the status and the SAME call must give the other answer.
q "update public.profiles set status='active', approval_basis='approved_by_administrator',
        approved_by='$ADMIN_ID', approved_at=now() where id='$SUSP_ID'" >/dev/null
raises "once active, the SAME call gives the PASSWORD answer (so status really did outrank it)" \
  "select public.require_permission('$SUSP_ID','sample.view')" \
  "BFF_PASSWORD_CHANGE_REQUIRED"

# ---------------------------------------------------------------------------
echo "== 3. The two RPCs =="
# ---------------------------------------------------------------------------
# The whole point of rpc_record_password_changed: it runs for somebody who
# holds nothing. A pending account holds no permission whatever its roles.
raises "the pending account holds NO permission (so the next check means something)" \
  "select public.require_permission('$PENDING_ID','sample.view')" \
  "BFF_ACCOUNT_NOT_ACTIVE"
succeeds "rpc_record_password_changed WORKS for an actor holding no permissions" \
  "select 1 from (select public.rpc_record_password_changed('$PENDING_ID','verify')) s"
expect "and it wrote password_changed_at for that account" \
  "$(q "select (password_changed_at is not null) from public.profiles where id='$PENDING_ID'")" "t"
expect "and it wrote exactly one 'identity.password_changed' event for it" \
  "$(q "select count(*) from public.audit_events
         where action='identity.password_changed' and entity_id='$PENDING_ID'")" "1"
raises "it refuses an id with no profile rather than reporting success over nothing" \
  "select public.rpc_record_password_changed('00000000-0000-4000-8000-00000000dead','verify')" \
  "BFF_UNKNOWN_USER"
raises "it refuses a null actor" \
  "select public.rpc_record_password_changed(null,'verify')" \
  "BFF_ACTOR_REQUIRED"

raises "rpc_record_admin_password_set REFUSES a self-target" \
  "select 1 from public.rpc_record_admin_password_set(
     '$ADMIN_ID','verify-0019-self-target-004','$HASH','verify',
     '$ADMIN_ID','administrator resetting their own password')" \
  "BFF_SELF_ADMINISTRATION"
# The refusal must leave nothing behind, including the idempotency claim it
# took one statement earlier. A control that refuses but commits half its work
# is a different defect wearing the same output.
expect "the refused self-target left NO idempotency claim behind" \
  "$(q "select count(*) from public.idempotency_requests
         where idempotency_key='verify-0019-self-target-004'")" "0"
expect "and the founder's own obligation is unchanged by the refusal" \
  "$(q "select public.must_change_password('$ADMIN_ID')")" "f"
raises "it refuses an empty reason" \
  "select 1 from public.rpc_record_admin_password_set(
     '$ADMIN2_ID','verify-0019-no-reason-005','$HASH','verify','$OP_ID','   ')" \
  "BFF_REASON_REQUIRED"
raises "it refuses an unknown target" \
  "select 1 from public.rpc_record_admin_password_set(
     '$ADMIN2_ID','verify-0019-unknown-006','$HASH','verify',
     '00000000-0000-4000-8000-00000000dead','target does not exist')" \
  "BFF_UNKNOWN_USER"

expect "it wrote 'identity.password_set_by_administrator' events, attributed to the administrator" \
  "$(q "select count(*) from public.audit_events a
         where a.action='identity.password_set_by_administrator'
           and a.actor_id in ('$ADMIN_ID','$ADMIN2_ID')")" "3"
# No credential anywhere in the audit trail. The RPC is never told the
# password, so this asserts the design rather than a redaction step — which is
# the version that cannot rot.
expect "NO audit payload written by either new action mentions a password value" \
  "$(q "select count(*) from public.audit_events
         where action in ('identity.password_set_by_administrator','identity.password_changed')
           and (coalesce(before_payload::text,'') ~* '(temporary_?password|\"password\")'
             or coalesce(after_payload::text,'')  ~* '(temporary_?password|\"password\")')")" "0"

# REACHABILITY THROUGH THE EDGE PATH. The mutation adapter claims the key
# first, under 'admin_action.<action>'; claim_mutation then refuses any key
# whose stored operation differs from the string the RPC hands it. If this
# fails, the RPC is unreachable from the Edge Function that is meant to call
# it — which no other check here would notice.
succeeds "an Edge-shaped claim under admin_action.set_password is taken" \
  "select 1 from public.rpc_begin_idempotent_request(
     'verify-0019-edge-setpw-007','admin_action.set_password','$ADMIN2_ID','$HASH',30000)"
succeeds "and the RPC RUNS on that pre-claimed key (reachable from the Edge Function)" \
  "select 1 from public.rpc_record_admin_password_set(
     '$ADMIN2_ID','verify-0019-edge-setpw-007','$HASH','verify',
     '$OP_ID','reset through the admin-action Edge Function')"
succeeds "the same holds for the create_account action" \
  "select 1 from public.rpc_begin_idempotent_request(
     'verify-0019-edge-create-008','admin_action.create_account','$ADMIN2_ID','$HASH',30000)"
succeeds "and the RPC RUNS on that one too" \
  "select 1 from public.rpc_record_admin_password_set(
     '$ADMIN2_ID','verify-0019-edge-create-008','$HASH','verify',
     '$PENDING_ID','account created with a temporary password')"
# The negative half: the endpoint check is still a check.
q "select 1 from public.rpc_begin_idempotent_request(
     'verify-0019-foreign-op-009','admin_action.set_roles','$ADMIN2_ID','$HASH',30000)" >/dev/null
raises "a key claimed by an UNRELATED endpoint is still refused" \
  "select 1 from public.rpc_record_admin_password_set(
     '$ADMIN2_ID','verify-0019-foreign-op-009','$HASH','verify','$OP_ID','wrong endpoint')" \
  "operation_mismatch"

# ---------------------------------------------------------------------------
echo "== 4. Privileges, read back from the ACLs that actually exist =="
# ---------------------------------------------------------------------------
# A revoke reports success whether or not it removed anything: a revoke can
# only delete a grant that was RECORDED. So the claim is checked against the
# catalogue, never inferred from the statements having run.
for sig in \
  'public.must_change_password(uuid)' \
  'public.rpc_record_admin_password_set(uuid,text,text,text,uuid,text)' \
  'public.rpc_record_password_changed(uuid,text)' \
  'public.require_permission(uuid,public.app_permission)'
do
  expect "PUBLIC cannot execute $sig" \
    "$(q "select has_function_privilege('public','$sig','execute')")" "f"
  expect "anon cannot execute $sig" \
    "$(q "select has_function_privilege('anon','$sig','execute')")" "f"
  expect "authenticated cannot execute $sig" \
    "$(q "select has_function_privilege('authenticated','$sig','execute')")" "f"
  expect "service_role CAN execute $sig" \
    "$(q "select has_function_privilege('service_role','$sig','execute')")" "t"
done
# THE PROBE'S OWN CONTROL. Every line above reads 'f'. A probe that can only
# ever return 'f' would produce exactly that output, so one case that must read
# 't' is required before any of it is evidence.
expect "the probe CAN return true (authenticated may execute the RLS helper is_active_user)" \
  "$(q "select has_function_privilege('authenticated','public.is_active_user()','execute')")" "t"
expect "assert_function_privileges() passes over the whole schema" \
  "$(q "select coalesce((select 'raised' from (select public.assert_function_privileges()) s where false),'clean')")" \
  "clean"

# The gate rests on this. If `authenticated` could UPDATE public.profiles, any
# signed-in operator could clear their own password_changed_at through
# PostgREST and walk straight past the gate — no Edge Function involved.
expect "authenticated holds NO UPDATE on public.profiles" \
  "$(q "select has_table_privilege('authenticated','public.profiles','update')")" "f"
expect "...and the probe CAN return true: it does hold SELECT" \
  "$(q "select has_table_privilege('authenticated','public.profiles','select')")" "t"
expect "anon holds no SELECT on public.profiles either" \
  "$(q "select has_table_privilege('anon','public.profiles','select')")" "f"

# ---------------------------------------------------------------------------
echo
echo "== Assertions run: $checks (failed: $fails) =="
if [ "$fails" -eq 0 ]; then
  echo "== PASS: all $checks checks held for $DB =="
else
  echo "== FAIL: $fails of $checks check(s) failed for $DB ==" >&2
  exit 1
fi
