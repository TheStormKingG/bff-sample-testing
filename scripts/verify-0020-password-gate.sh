#!/usr/bin/env bash
#
# verify-0020-password-gate.sh
#
# Proves that migration 0020 closes the two defects it claims to close, and
# that it does not break the three things the feature cannot survive losing.
#
# WHAT THIS PROVES, AND WHAT IT DOES NOT.
#
# It exercises the ROW-LEVEL-SECURITY route as the `authenticated` role with
# `request.jwt.claims` set, which is the only role in which RLS is evaluated at
# all: the database owner and `service_role` both bypass it, and a script that
# never leaves service_role cannot observe a policy. That is precisely how the
# PostgREST hole in 0019 survived a 74-assertion verification run.
#
# It does NOT prove that PostgREST itself authorises a real HTTP request the
# way this script authorises a SQL statement. `scripts/local-sql-shim.sql`
# reproduces `auth.uid()` and the three grant-target roles and nothing else.
# What it does prove is the thing the shim is faithful to: which policy admits
# which statement for which subject. Run `supabase db reset` for the rest.
#
# It does NOT prove anything about the Edge TypeScript. `deno check` is the
# only gate that reads those files.
#
# Every assertion compares a VALUE. An exit code is never the assertion: a
# function returning false still exits 0, and `psql -c` succeeds while
# answering "no".
#
# Usage:
#   scripts/verify-0020-password-gate.sh
#
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

DB_AFTER="bff_gate_check"           # every migration, including 0020
DB_BEFORE="bff_gate_before_check"   # 0001..0019 only, for the before/after comparison

# Fixed subjects, so the two databases hold the same accounts.
U_ADMIN='c0de0000-0000-4000-8000-000000000001'   # active administrator, user.manage
U_ARMED='c0de0000-0000-4000-8000-000000000002'   # active operator, armed
U_LEGACY='c0de0000-0000-4000-8000-000000000003'  # active operator, both columns NULL
U_SUSP='c0de0000-0000-4000-8000-000000000004'    # suspended operator, armed
U_SUSP2='c0de0000-0000-4000-8000-000000000005'   # suspended operator, NOT armed
U_ARMED2='c0de0000-0000-4000-8000-000000000006'  # active operator, armed, NEVER discharged
S_ARMED='5a3b0000-0000-4000-8000-000000000001'   # draft sample owned by U_ARMED
S_LEGACY='5a3b0000-0000-4000-8000-000000000002'  # draft sample owned by U_LEGACY

PASS=0; FAIL=0; TOTAL=0

check() { # label expected actual
  TOTAL=$((TOTAL + 1))
  if [ "$3" = "$2" ]; then
    printf '  ok    %s\n' "$1"; PASS=$((PASS + 1))
  else
    printf '  FAIL  %s\n          expected [%s]\n          got      [%s]\n' "$1" "$2" "$3"
    FAIL=$((FAIL + 1))
  fi
}

# A scalar answer, or the literal QUERY_ERROR. The two are distinguished
# deliberately: a checker that renders a failed query as an empty string
# reports "no rows" for "never ran", and that is the failure mode this whole
# script exists because of.
q() { # db sql
  local out rc
  out="$(psql -X -q -t -A -v ON_ERROR_STOP=1 "$1" -c "$2" 2>&1)"; rc=$?
  if [ "$rc" -ne 0 ]; then printf 'QUERY_ERROR: %s' "$(printf '%s' "$out" | tr '\n' ' ' | cut -c1-120)";
  else printf '%s' "$out"; fi
}

# ALLOWED, or the BFF_ error code raised, or RAISED_OTHER:<text>.
outcome() { # db sql
  local out rc
  out="$(psql -X -q -t -A -v ON_ERROR_STOP=1 "$1" -c "$2" 2>&1)"; rc=$?
  if [ "$rc" -eq 0 ]; then printf 'ALLOWED'; return; fi
  local code; code="$(printf '%s' "$out" | grep -oE 'BFF_[A-Z_]+' | head -1)"
  if [ -n "$code" ]; then printf '%s' "$code"
  else printf 'RAISED_OTHER: %s' "$(printf '%s' "$out" | tr '\n' ' ' | cut -c1-110)"; fi
}

# A statement run as the real end-user role, with the subject's claims, inside
# one transaction that is rolled back. `set local role` and `set local
# request.jwt.claims` both revert at the end of the transaction, and the
# rollback makes the write probes repeatable.
#
# TRANSACTION SCOPE IS PART OF THE CLAIM. Everything asked here is a question
# about two STORED timestamps, so it gives the same answer whatever the
# boundary. The one assertion that is about two INSTANTS -- the tie -- is run
# separately and labelled, because now() is constant inside a transaction and
# a probe built the convenient way would certify the tie case while claiming to
# test the ordinary one.
as_user() { # db subject sql
  q "$1" "begin; set local role authenticated;
          set local request.jwt.claims = '{\"sub\":\"$2\",\"role\":\"authenticated\"}';
          $3 ; rollback;"
}

as_user_outcome() { # db subject sql
  outcome "$1" "begin; set local role authenticated;
                set local request.jwt.claims = '{\"sub\":\"$2\",\"role\":\"authenticated\"}';
                $3 ; rollback;"
}

# The full error text, or ALLOWED. `outcome` truncates and collapses, which is
# right for an assertion on an error CODE and wrong for a control that must
# prove the error came from the assertion rather than from its own setup.
raw_outcome() { # db sql
  local out rc
  out="$(psql -X -q -t -A -v ON_ERROR_STOP=1 "$1" -c "$2" 2>&1)"; rc=$?
  if [ "$rc" -eq 0 ]; then printf 'ALLOWED'; else printf '%s' "$(printf '%s' "$out" | tr '\n' ' ')"; fi
}

fixtures_sql() { cat <<FIXTURES
insert into auth.users (id, email, raw_user_meta_data) values
 ('$U_ADMIN', 'gate-admin@example.invalid',  '{"full_name":"Gate Administrator"}'::jsonb),
 ('$U_ARMED', 'gate-armed@example.invalid',  '{"full_name":"Gate Armed Operator"}'::jsonb),
 ('$U_LEGACY','gate-legacy@example.invalid', '{"full_name":"Gate Legacy Operator"}'::jsonb),
 ('$U_SUSP',  'gate-susp@example.invalid',   '{"full_name":"Gate Suspended Armed"}'::jsonb),
 ('$U_SUSP2', 'gate-susp2@example.invalid',  '{"full_name":"Gate Suspended Clean"}'::jsonb),
 ('$U_ARMED2','gate-armed2@example.invalid', '{"full_name":"Gate Armed Reference"}'::jsonb);

update public.profiles
   set status = 'active', approval_basis = 'first_administrator_bootstrap', approved_at = now()
 where id = '$U_ADMIN';
update public.profiles
   set status = 'active', approval_basis = 'approved_by_administrator',
       approved_by = '$U_ADMIN', approved_at = now()
 where id in ('$U_ARMED', '$U_LEGACY', '$U_ARMED2');
-- The two suspended accounts carry a complete approval history, because a
-- suspension follows an approval. The CHECK only constrains 'active'.
update public.profiles
   set status = 'suspended', approval_basis = 'approved_by_administrator',
       approved_by = '$U_ADMIN', approved_at = now()
 where id in ('$U_SUSP', '$U_SUSP2');

insert into public.user_roles (user_id, role, granted_by) values
 ('$U_ADMIN', 'administrator', null),
 ('$U_ARMED', 'operator',  '$U_ADMIN'),
 ('$U_LEGACY','operator',  '$U_ADMIN'),
 ('$U_SUSP',  'operator',  '$U_ADMIN'),
 ('$U_SUSP2', 'operator',  '$U_ADMIN'),
 ('$U_ARMED2','operator',  '$U_ADMIN');

-- One draft sample each, for the write probe on the RLS route. DELETE is the
-- only write privilege \`authenticated\` holds on this table; INSERT and UPDATE
-- are refused by the absence of a grant, not by any policy.
insert into public.samples
 (id, stage, prefix, collection_instant, collection_local_date, collection_local_time, created_by, capture_state)
values
 ('$S_ARMED', 'raw_materials','RM', now(), current_date, localtime, '$U_ARMED',  'draft'),
 ('$S_LEGACY','raw_materials','RM', now(), current_date, localtime, '$U_LEGACY', 'draft');
FIXTURES
}

# ---------------------------------------------------------------------------
echo "== 1. Build both schemas from scratch =="
# ---------------------------------------------------------------------------
if ! command -v psql >/dev/null 2>&1; then echo "psql not found." >&2; exit 2; fi
if ! pg_isready -q 2>/dev/null; then echo "No PostgreSQL server is accepting connections." >&2; exit 2; fi

# AFTER: the whole pipeline, so this run also proves 0020 applies in order.
if ! out="$(scripts/verify-migrations.sh "$DB_AFTER" 2>&1)"; then
  echo "FAIL: scripts/verify-migrations.sh did not complete." >&2
  printf '%s\n' "$out" | tail -25 >&2
  exit 1
fi
applied="$(printf '%s\n' "$out" | grep -c '^  ok    0[0-9][0-9][0-9]_')"
echo "  ok    full pipeline applied ($applied migrations)"

# BEFORE: the same migrations up to and including 0019, and nothing else. This
# is what makes the pre-0019-account comparison a comparison rather than an
# argument -- the same account is created on two real schemas.
dropdb --if-exists "$DB_BEFORE" && createdb "$DB_BEFORE"
psql -X -q -v ON_ERROR_STOP=1 "$DB_BEFORE" -f scripts/local-sql-shim.sql >/dev/null 2>&1 \
  || { echo "FAIL: shim did not apply to $DB_BEFORE" >&2; exit 1; }
before_count=0
for f in supabase/migrations/*.sql; do
  case "$(basename "$f")" in 0020_*) continue ;; esac
  psql -X -q -v ON_ERROR_STOP=1 "$DB_BEFORE" -f "$f" >/dev/null 2>&1 \
    || { echo "FAIL: $f did not apply to $DB_BEFORE" >&2; exit 1; }
  before_count=$((before_count + 1))
done
echo "  ok    pre-0020 comparison schema built ($before_count migrations, 0020 withheld)"

# A guard on the instrument rather than on the schema: if these two numbers are
# equal, the "before" database contains 0020 and every comparison below is
# vacuous while reading as a pass.
TOTAL=$((TOTAL + 1))
if [ "$before_count" -lt "$applied" ]; then
  printf '  ok    the two schemas really do differ (%s vs %s migrations)\n' "$before_count" "$applied"
  PASS=$((PASS + 1))
else
  printf '  FAIL  the two schemas do not differ (%s vs %s) -- every before/after comparison below would be vacuous\n' "$before_count" "$applied"
  FAIL=$((FAIL + 1))
fi

echo
echo "== 2. Fixtures (committed, as separate transactions) =="
for db in "$DB_AFTER" "$DB_BEFORE"; do
  fixtures_sql | psql -X -q -v ON_ERROR_STOP=1 "$db" >/dev/null 2>&1 \
    || { echo "FAIL: fixtures did not apply to $db" >&2; exit 1; }
done
echo "  ok    five accounts and two draft samples created in both databases"

# ARM the armed account through the REAL RPC, in its own transaction, in both
# databases. This is not a column update: it also produces the audit row that
# section 7 reads, so D3 is tested through the code path that writes it.
#
# Dated an hour ago so the holder's own change, below, is strictly later. The
# tie is tested on purpose in section 6 instead of being reached by accident.
arm_one() { # db
  psql -X -q -t -A -v ON_ERROR_STOP=1 "$1" >/dev/null 2>&1 <<ARM
select public.rpc_begin_idempotent_request(
  'gate-verify-arm-the-armed-account', 'admin_action.set_password',
  '$U_ADMIN', 'sha256:$(printf 'gate-arm' | shasum -a 256 | cut -d' ' -f1)', 60000);
select public.rpc_record_admin_password_set(
  '$U_ADMIN', 'gate-verify-arm-the-armed-account',
  'sha256:$(printf 'gate-arm' | shasum -a 256 | cut -d' ' -f1)', 'verify-0020',
  '$U_ARMED', 'Verification: arming the forced change through the real RPC.');
ARM
}
for db in "$DB_AFTER" "$DB_BEFORE"; do arm_one "$db"; done
# Back-date the arming so the discharge below is strictly later than it, and
# arm the suspended account the same way. Done as a direct update because it is
# fixture surgery on the clock, not a thing under test.
for db in "$DB_AFTER" "$DB_BEFORE"; do
  psql -X -q -v ON_ERROR_STOP=1 "$db" >/dev/null 2>&1 <<SETUP
update public.profiles set password_set_by_admin_at = now() - interval '1 hour'
 where id = '$U_ARMED';
update public.profiles set password_set_by_admin_at = now() - interval '1 hour',
       password_changed_at = null
 where id in ('$U_SUSP', '$U_ARMED2');
SETUP
done
echo "  ok    the armed account was armed through public.rpc_record_admin_password_set()"

echo
echo "== 3. Input assertions (these run BEFORE any control) =="
check "must_change_password(armed) is true"   "t" "$(q "$DB_AFTER" "select public.must_change_password('$U_ARMED');")"
check "must_change_password(legacy) is false"  "f" "$(q "$DB_AFTER" "select public.must_change_password('$U_LEGACY');")"
check "legacy: both new columns are NULL"      "t" "$(q "$DB_AFTER" "select password_set_by_admin_at is null and password_changed_at is null from public.profiles where id = '$U_LEGACY';")"
# Without this one, a refusal below could be a missing role rather than the
# gate. actor_has_permission() does not consult the gate, so it answers the
# question "does this account hold the permission at all".
check "armed genuinely HOLDS sample.draft (so a refusal is the gate)" "t" \
  "$(q "$DB_AFTER" "select public.actor_has_permission('$U_ARMED','sample.draft');")"
check "armed account's status is active (so the refusal is not the status)" "active" \
  "$(q "$DB_AFTER" "select status from public.profiles where id = '$U_ARMED';")"
check "the RLS probe really runs as role authenticated" "authenticated" \
  "$(as_user "$DB_AFTER" "$U_ARMED" "select current_user;")"
check "the probe role does not bypass RLS" "f" \
  "$(q "$DB_AFTER" "select rolbypassrls from pg_roles where rolname = 'authenticated';")"
check "no table in public has FORCE ROW LEVEL SECURITY off-by-owner escape counted" "0" \
  "$(q "$DB_AFTER" "select count(*) from pg_tables where schemaname='public' and not rowsecurity;")"

echo
echo "== 4. The armed account is refused on BOTH routes =="
echo "   -- RPC route (the raising chain) --"
check "armed refused by require_permission" "BFF_PASSWORD_CHANGE_REQUIRED" \
  "$(outcome "$DB_AFTER" "select public.require_permission('$U_ARMED','sample.draft');")"
check "CONTROL legacy allowed by require_permission" "ALLOWED" \
  "$(outcome "$DB_AFTER" "select public.require_permission('$U_LEGACY','sample.draft');")"

echo "   -- PostgREST/RLS route, as the authenticated role --"
check "armed: has_permission('sample.draft') is false" "f" \
  "$(as_user "$DB_AFTER" "$U_ARMED" "select public.has_permission('sample.draft');")"
check "armed: is_active_user() is false" "f" \
  "$(as_user "$DB_AFTER" "$U_ARMED" "select public.is_active_user();")"
check "armed: DELETE of its own draft sample removes 0 rows" "0" \
  "$(as_user "$DB_AFTER" "$U_ARMED" "with d as (delete from public.samples where id = '$S_ARMED' returning 1) select count(*) from d;")"
check "armed: samples visible = 0" "0" \
  "$(as_user "$DB_AFTER" "$U_ARMED" "select count(*) from public.samples;")"
check "armed: role_permissions visible = 0 (an is_active_user-only policy)" "0" \
  "$(as_user "$DB_AFTER" "$U_ARMED" "select count(*) from public.role_permissions;")"
check "armed: staff directory visible = 1 (its own row only, via select_self)" "1" \
  "$(as_user "$DB_AFTER" "$U_ARMED" "select count(*) from public.profiles;")"

echo "   -- the same probes for a legacy account: the positive controls --"
check "CONTROL legacy: has_permission('sample.draft') is true" "t" \
  "$(as_user "$DB_AFTER" "$U_LEGACY" "select public.has_permission('sample.draft');")"
check "CONTROL legacy: is_active_user() is true" "t" \
  "$(as_user "$DB_AFTER" "$U_LEGACY" "select public.is_active_user();")"
check "CONTROL legacy: DELETE of its own draft removes 1 row" "1" \
  "$(as_user "$DB_AFTER" "$U_LEGACY" "with d as (delete from public.samples where id = '$S_LEGACY' returning 1) select count(*) from d;")"
check "CONTROL legacy: role_permissions visible = 42" "42" \
  "$(as_user "$DB_AFTER" "$U_LEGACY" "select count(*) from public.role_permissions;")"

echo
echo "== 5. The armed account can still read its own profile row =="
check "armed: its OWN profile row is readable" "1" \
  "$(as_user "$DB_AFTER" "$U_ARMED" "select count(*) from public.profiles where id = '$U_ARMED';")"
check "armed: the two columns the client computes the obligation from are readable" "t" \
  "$(as_user "$DB_AFTER" "$U_ARMED" "select password_set_by_admin_at is not null and password_changed_at is null from public.profiles where id = '$U_ARMED';")"
check "CONTROL armed: ANOTHER account's profile row is NOT readable" "0" \
  "$(as_user "$DB_AFTER" "$U_ARMED" "select count(*) from public.profiles where id = '$U_ADMIN';")"
# The gate calls a function `authenticated` cannot execute. That works only
# because both callers are SECURITY DEFINER, so EXECUTE is checked against the
# owner. Asserted by execution, because a grant decides which branch can run.
check "armed: is_active_user() returns a value, not insufficient_privilege" "f" \
  "$(as_user "$DB_AFTER" "$U_ARMED" "select public.is_active_user();")"
check "CONTROL a DIRECT call to must_change_password() as authenticated is refused" "RAISED" \
  "$(as_user_outcome "$DB_AFTER" "$U_ARMED" "select public.must_change_password('$U_ARMED');" | grep -q 'RAISED_OTHER' && echo RAISED || echo NOT_REFUSED)"

echo
echo "== 6. The SAME account, after recording its own change, succeeds on both =="
echo "   (a separate transaction from the arming: see the note on scope above)"
# Run the discharge in BOTH databases. Only the AFTER answers are asserted
# here; the BEFORE row exists so section 9's control can show that the UNFIXED
# code got the before-state wrong for BOTH RPCs rather than just the one.
q "$DB_BEFORE" "select public.rpc_record_password_changed('$U_ARMED','verify-0020') is not null;" >/dev/null
discharged="$(q "$DB_AFTER" "select public.rpc_record_password_changed('$U_ARMED','verify-0020') is not null;")"
check "rpc_record_password_changed() returned an instant" "t" "$discharged"
check "must_change_password(armed) is now false" "f" \
  "$(q "$DB_AFTER" "select public.must_change_password('$U_ARMED');")"
check "armed is now ALLOWED by require_permission (RPC route restored)" "ALLOWED" \
  "$(outcome "$DB_AFTER" "select public.require_permission('$U_ARMED','sample.draft');")"
check "armed: has_permission('sample.draft') is now true (RLS route restored)" "t" \
  "$(as_user "$DB_AFTER" "$U_ARMED" "select public.has_permission('sample.draft');")"
check "armed: is_active_user() is now true" "t" \
  "$(as_user "$DB_AFTER" "$U_ARMED" "select public.is_active_user();")"
check "armed: DELETE of its own draft now removes 1 row (RLS write restored)" "1" \
  "$(as_user "$DB_AFTER" "$U_ARMED" "with d as (delete from public.samples where id = '$S_ARMED' returning 1) select count(*) from d;")"
check "armed: role_permissions visible again = 42" "42" \
  "$(as_user "$DB_AFTER" "$U_ARMED" "select count(*) from public.role_permissions;")"

echo "   -- the tie, tested on purpose rather than reached by accident --"
# Both instants come from now(), which is constant for a whole transaction, so
# an arming and a discharge in ONE transaction carry the identical timestamp.
# 0019 resolves that tie toward STILL REQUIRING the change. A probe that ran
# the two calls in one -c argument would test this case while claiming to test
# the one above, and would pass.
tie="$(psql -X -q -t -A "$DB_AFTER" -c "begin;
       update public.profiles set password_set_by_admin_at = now(), password_changed_at = null where id = '$U_LEGACY';
       select public.rpc_record_password_changed('$U_LEGACY','verify-0020');
       select public.must_change_password('$U_LEGACY');
       rollback;" 2>&1 | tail -1)"
check "same-instant arming and discharge leaves the change OUTSTANDING" "t" "$tie"
# And the ordinary case, so the tie assertion is not satisfied by a rule that
# never clears at all: one hour apart, in the same transaction, must clear.
ord="$(psql -X -q -t -A "$DB_AFTER" -c "begin;
       update public.profiles set password_set_by_admin_at = now() - interval '1 hour', password_changed_at = null where id = '$U_LEGACY';
       select public.rpc_record_password_changed('$U_LEGACY','verify-0020');
       select public.must_change_password('$U_LEGACY');
       rollback;" 2>&1 | tail -1)"
check "CONTROL the same calls an hour apart DO clear it" "f" "$ord"

echo
echo "== 7. A suspended AND armed account gets the ACCOUNT answer =="
check "suspended + armed: the ACCOUNT answer, not the password answer" "BFF_ACCOUNT_NOT_ACTIVE" \
  "$(outcome "$DB_AFTER" "select public.require_permission('$U_SUSP','sample.draft');")"
check "CONTROL suspended + NOT armed: the same account answer" "BFF_ACCOUNT_NOT_ACTIVE" \
  "$(outcome "$DB_AFTER" "select public.require_permission('$U_SUSP2','sample.draft');")"
# Without this, the assertion above is satisfied by a system that never gives
# the password answer at all.
# Rolled back rather than committed: a committed flip that failed to flip back
# would leave the account active, and the next assertion would silently test an
# active account while reading as a pass.
check "CONTROL active + armed: the PASSWORD answer, so the two are distinguishable" "BFF_PASSWORD_CHANGE_REQUIRED" \
  "$(outcome "$DB_AFTER" "begin;
       update public.profiles set status = 'active' where id = '$U_SUSP';
       select public.require_permission('$U_SUSP','sample.draft');
       rollback;")"
check "CONTROL ...and the suspended account is still suspended afterwards" "suspended" \
  "$(q "$DB_AFTER" "select status from public.profiles where id = '$U_SUSP';")"
check "suspended + armed on the RLS route: nothing but its own profile row" "1" \
  "$(as_user "$DB_AFTER" "$U_SUSP" "select count(*) from public.profiles;")"

echo
echo "== 8. A pre-0019 account is unaffected: before/after on two real schemas =="
for probe in \
  "is_active_user|select public.is_active_user();" \
  "has_permission(sample.draft)|select public.has_permission('sample.draft');" \
  "samples visible|select count(*) from public.samples;" \
  "profiles visible|select count(*) from public.profiles;" \
  "role_permissions visible|select count(*) from public.role_permissions;" \
  "sample_prefixes visible|select count(*) from public.sample_prefixes;"
do
  label="${probe%%|*}"; sql="${probe#*|}"
  b="$(as_user "$DB_BEFORE" "$U_LEGACY" "$sql")"
  a="$(as_user "$DB_AFTER"  "$U_LEGACY" "$sql")"
  check "legacy unchanged on the RLS route: $label (before=[$b])" "$b" "$a"
done
b="$(outcome "$DB_BEFORE" "select public.require_permission('$U_LEGACY','sample.draft');")"
a="$(outcome "$DB_AFTER"  "select public.require_permission('$U_LEGACY','sample.draft');")"
check "legacy unchanged on the RPC route (before=[$b])" "$b" "$a"
# The comparison is only meaningful if the SAME probes DO differ for an armed
# account across the two schemas. Otherwise "unchanged" could mean the probe
# is insensitive to 0020 altogether.
# U_ARMED2 is armed in both databases and is never discharged, so this
# comparison is not quietly taken against the account section 6 just cleared.
b="$(as_user "$DB_BEFORE" "$U_ARMED2" "select public.has_permission('sample.draft');")"
a="$(as_user "$DB_AFTER"  "$U_ARMED2" "select public.has_permission('sample.draft');")"
check "CONTROL the same probe DOES differ for a STILL-armed account (before=[$b] after=[$a])" "t|f" "$b|$a"

echo
echo "== 9. D3: the audit rows now show the transition =="
check "arming event: before.must_change_password" "false" \
  "$(q "$DB_AFTER" "select before_payload->>'must_change_password' from public.audit_events where action = 'identity.password_set_by_administrator' and entity_id = '$U_ARMED' order by occurred_at limit 1;")"
check "arming event: after.must_change_password" "true" \
  "$(q "$DB_AFTER" "select after_payload->>'must_change_password' from public.audit_events where action = 'identity.password_set_by_administrator' and entity_id = '$U_ARMED' order by occurred_at limit 1;")"
check "discharge event: before.must_change_password" "true" \
  "$(q "$DB_AFTER" "select before_payload->>'must_change_password' from public.audit_events where action = 'identity.password_changed' and entity_id = '$U_ARMED' order by occurred_at limit 1;")"
check "discharge event: after.must_change_password" "false" \
  "$(q "$DB_AFTER" "select after_payload->>'must_change_password' from public.audit_events where action = 'identity.password_changed' and entity_id = '$U_ARMED' order by occurred_at limit 1;")"
check "no password event records before == after on that field" "0" \
  "$(q "$DB_AFTER" "select count(*) from public.audit_events where action in ('identity.password_set_by_administrator','identity.password_changed') and before_payload->>'must_change_password' is not distinct from after_payload->>'must_change_password';")"
check "both events exist at all (so the count above is over a real population)" "2" \
  "$(q "$DB_AFTER" "select count(*) from public.audit_events where action in ('identity.password_set_by_administrator','identity.password_changed') and entity_id = '$U_ARMED';")"
# The same assertion against the unfixed code, on the pre-0020 schema. Without
# it, a passing count of 0 could mean the rows are right or that nothing wrote
# any rows to be wrong.
check "CONTROL pre-0020: the same events DO record before == after" "2" \
  "$(q "$DB_BEFORE" "select count(*) from public.audit_events where action in ('identity.password_set_by_administrator','identity.password_changed') and before_payload->>'must_change_password' is not distinct from after_payload->>'must_change_password';")"
check "arming event: the raw timestamp halves differ too" "t" \
  "$(q "$DB_AFTER" "select (before_payload->>'password_set_by_admin_at') is distinct from (after_payload->>'password_set_by_admin_at') from public.audit_events where action = 'identity.password_set_by_administrator' and entity_id = '$U_ARMED' order by occurred_at limit 1;")"
check "no password event payload contains anything password-shaped" "0" \
  "$(q "$DB_AFTER" "select count(*) from public.audit_events where action in ('identity.password_set_by_administrator','identity.password_changed') and (before_payload::text ~* 'passw[o0]rd\"?\s*:\s*\"[^\"]{6,}' or after_payload::text ~* 'passw[o0]rd\"?\s*:\s*\"[^\"]{6,}');")"

echo
echo "== 10. The drift assertion, and the controls that make it mean something =="
check "assert_password_gate_on_every_policy() passes as built" "ok" \
  "$(q "$DB_AFTER" "select 'ok' from (select public.assert_password_gate_on_every_policy()) s;")"
check "it scanned every policy in the schema, not a subset" "37" \
  "$(q "$DB_AFTER" "select count(*) from pg_policies where schemaname = 'public';")"
# Each control reverts something in a rolled-back transaction. Nothing on disk
# is modified: a probe may only mutate what this script owns, and 0001 is not
# in its ownership list.
ctl() { # label sql-that-breaks-it refuse|accept expected-message-fragment
  local got
  got="$(raw_outcome "$DB_AFTER" "begin; $2 ; select public.assert_password_gate_on_every_policy(); rollback;")"
  TOTAL=$((TOTAL + 1))
  if [ "$3" = "refuse" ]; then
    case "$got" in
      ALLOWED)
        printf '  FAIL  %s\n          the assertion PASSED on a schema it exists to reject\n' "$1"
        FAIL=$((FAIL + 1)) ;;
      *"$4"*)
        printf '  ok    %s\n' "$1"; PASS=$((PASS + 1)) ;;
      *)
        # It failed, but not for the stated reason. A control satisfied by its
        # own broken setup certifies nothing, and reads identically to one that
        # worked.
        printf '  FAIL  %s\n          it failed, but not with the assertion message [%s]\n          got: %s\n' \
          "$1" "$4" "$(printf '%s' "$got" | cut -c1-160)"
        FAIL=$((FAIL + 1)) ;;
    esac
  else
    if [ "$got" = "ALLOWED" ]; then printf '  ok    %s\n' "$1"; PASS=$((PASS + 1))
    else printf '  FAIL  %s\n          got: %s\n' "$1" "$(printf '%s' "$got" | cut -c1-160)"; FAIL=$((FAIL + 1)); fi
  fi
}

# The parameter name below is p_permission, not p: `create or replace` refuses
# to rename an input parameter, so a control written with a shorter name fails
# on its own DDL and never reaches the assertion -- while still reporting as a
# pass under any "did it raise?" test. That is why ctl matches the message.
HP_UNGATED="create or replace function public.has_permission(p_permission public.app_permission) returns boolean language sql stable security definer set search_path = '' as \$f\$ select public.is_active_user() and exists (select 1 from public.user_roles ur join public.role_permissions rp on rp.role = ur.role where ur.user_id = auth.uid() and rp.permission = p_permission); \$f\$;"
IAU_UNGATED="create or replace function public.is_active_user() returns boolean language sql stable security definer set search_path = '' as \$f\$ select coalesce(public.current_user_status() = 'active', false); \$f\$;"

ctl "CONTROL it REFUSES when is_active_user() is reverted to its 0001 body" \
  "$IAU_UNGATED" refuse "policies authorise through a predicate that does not consult"
ctl "CONTROL it REFUSES when ONLY has_permission() keeps the gate (the 15 is_active_user-only policies)" \
  "$IAU_UNGATED $HP_UNGATED create or replace function public.has_permission(p_permission public.app_permission) returns boolean language sql stable security definer set search_path = '' as \$f\$ select public.is_active_user() and not public.must_change_password(auth.uid()) and exists (select 1 from public.user_roles ur join public.role_permissions rp on rp.role = ur.role where ur.user_id = auth.uid() and rp.permission = p_permission); \$f\$;" \
  refuse "policies authorise through a predicate that does not consult"
ctl "CONTROL it REFUSES a new policy on a brand-new ungated predicate" \
  "create function public.gate_control_predicate() returns boolean language sql stable security definer set search_path = '' as \$f\$ select auth.uid() is not null; \$f\$; create policy gate_control_a on public.suppliers for select to authenticated using (public.gate_control_predicate());" \
  refuse "gate_control_a"
ctl "CONTROL it REFUSES a policy that calls no function in public at all" \
  "create policy gate_control_b on public.suppliers for select to authenticated using (auth.uid() is not null);" \
  refuse "authorise without calling any function in schema public"
ctl "CONTROL it REFUSES when its own exemption goes stale" \
  "drop policy profiles_select_self on public.profiles;" \
  refuse "exempts policies that no longer exist"
ctl "CONTROL it REFUSES when has_permission() stops STATING the gate, though it still inherits it" \
  "$HP_UNGATED" refuse "no longer state public.must_change_password() in their own body"
ctl "it ACCEPTS a new policy whose predicate only WRAPS has_permission (closure is transitive)" \
  "create function public.gate_control_wrapper() returns boolean language sql stable security definer set search_path = '' as \$f\$ select public.has_permission('sample.view'); \$f\$; create policy gate_control_c on public.suppliers for select to authenticated using (public.gate_control_wrapper());" \
  accept ""

# The point of the by-name check, demonstrated rather than argued: with the
# restatement removed from has_permission() the RUNTIME is still completely
# correct, because the gate is inherited from is_active_user(). So no
# behavioural probe anywhere can detect that it was lost -- only the by-name
# assertion can. Both facts are established in one rolled-back transaction.
still_refused="$(q "$DB_AFTER" "begin; $HP_UNGATED
  set local role authenticated;
  set local request.jwt.claims = '{\"sub\":\"$U_ARMED2\",\"role\":\"authenticated\"}';
  select public.has_permission('sample.draft');
  rollback;" | tail -1)"
check "CONTROL with the restatement gone the armed account is STILL refused at runtime" "f" "$still_refused"

echo
echo "== 11. REPORTED, NOT FIXED: the pre-existing idempotency-operation defect =="
echo "   D10. adminSpec() records 'admin_action.<action>'; the admin RPCs in 0015"
echo "   hand claim_mutation a bare literal. Settled here by execution on the real"
echo "   functions, rolled back. 0015 is NOT edited by this change."
h="sha256:$(printf 'd10' | shasum -a 256 | cut -d' ' -f1)"
mismatch="$(outcome "$DB_AFTER" "begin;
  select public.rpc_begin_idempotent_request('d10-operation-mismatch-key','admin_action.set_roles','$U_ADMIN','$h',60000);
  select public.rpc_set_user_roles('$U_ADMIN','d10-operation-mismatch-key','$h','verify-0020','$U_LEGACY', array['operator'],'D10 probe');
  rollback;")"
matched="$(outcome "$DB_AFTER" "begin;
  select public.rpc_begin_idempotent_request('d10-operation-match-key-okay','set_user_roles','$U_ADMIN','$h',60000);
  select public.rpc_set_user_roles('$U_ADMIN','d10-operation-match-key-okay','$h','verify-0020','$U_LEGACY', array['operator'],'D10 probe');
  rollback;")"
check "D10 PROVED: the Edge adapter's operation string is refused by the RPC" "BFF_IDEMPOTENCY_CONFLICT" "$mismatch"
check "CONTROL the identical call succeeds when only that string is changed" "ALLOWED" "$matched"

echo
echo "== Total =="
printf '  %s assertions: %s ok, %s FAIL\n' "$TOTAL" "$PASS" "$FAIL"
if [ "$FAIL" -ne 0 ]; then exit 1; fi
# A zero-assertion run must not read as a pass.
if [ "$TOTAL" -lt 50 ]; then
  printf '  FAIL  only %s assertions ran; this script defines more than that, so something was skipped.\n' "$TOTAL"
  exit 1
fi
echo "  All assertions passed."
