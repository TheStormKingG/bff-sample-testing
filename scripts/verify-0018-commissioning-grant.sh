#!/usr/bin/env bash
#
# Verify 0018_commissioning_all_roles_grant.sql as a CONTROL, in both
# directions — the way scripts/verify-migrations.sh verifies the
# first-administrator bootstrap, and for the same reason: a script that only
# ever ran the happy path would report a pass whether or not the refusals work.
#
# WHAT IT PROVES
#   1. The migration applies with NO address supplied and grants nothing.
#      (This is what production does. It is the only case that must never
#      grant anything, so it is checked first.)
#   2. Supplying an address grants every role in public.app_role, with
#      granted_by = NULL, a stated reason, and ONE audit event.
#   3. Re-running the WHOLE FILE leaves the count unchanged and writes no
#      second audit event.
#   4. A role granted by a named person is NOT overwritten or wiped by a
#      re-run — the thing ON CONFLICT DO NOTHING exists to guarantee.
#   5. An unknown address is refused, loudly, rather than reported as applied.
#   6. A pending account is refused, because roles on a non-active account
#      grant nothing and a success there would mislead.
#   7. granted_by = NULL satisfies user_roles_no_self_grant AND
#      granted_by = user_id does not — the positive and the negative control
#      for the three-valued-logic claim the migration's comment relies on.
#
# WHAT IT DOES NOT PROVE: that RLS denies a real request. This is a plain
# PostgreSQL database with a shim, not Supabase. See scripts/local-sql-shim.sql.
#
# Usage:  scripts/verify-0018-commissioning-grant.sh [dbname]
#
set -euo pipefail

DB="${1:-bff_0018_scratch}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

MIGRATION="supabase/migrations/0018_commissioning_all_roles_grant.sql"
SETTING="app.commissioning_role_grant_email"
TARGET="commissioning-check@example.invalid"
PENDING="pending-check@example.invalid"

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
q()    { psql -X -q -t -A -v ON_ERROR_STOP=1 "$DB" -c "$1"; }
pass() { printf '  ok    %s\n' "$1"; }
fail() { printf '  FAIL  %s\n' "$1"; fails=$((fails + 1)); }

# Assert on a VALUE, never on an exit code alone: a query that errors prints
# nothing and exits non-zero, which must not be read as "the value was empty".
expect() { # expect <label> <actual> <wanted>
  if [ "$2" = "$3" ]; then pass "$1 ($3)"; else fail "$1 — wanted '$3', got '$2'"; fi
}

echo "== Building $DB from scratch =="
BOOTSTRAP_ADMIN_EMAIL="$TARGET" scripts/verify-migrations.sh "$DB" >/dev/null 2>&1 \
  || { echo "FAIL: scripts/verify-migrations.sh did not pass; fix that first." >&2; exit 1; }
pass "schema applied, including $(basename "$MIGRATION")"

echo "== 1. Applied with no address supplied (what production does) =="
expect "no roles granted at all" "$(q "select count(*) from public.user_roles")" "0"
expect "no commissioning audit event" \
  "$(q "select count(*) from public.audit_events where action='identity.commissioning_role_grant'")" "0"
expect "the function exists and is ready" \
  "$(q "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
         where n.nspname='public' and p.proname='apply_commissioning_role_grant'")" "1"

echo "== 2. A real sign-in, through the system's own bootstrap path =="
# verify-migrations.sh armed the allowlist for $TARGET. Inserting the auth.users
# row is what a Google sign-in does; the trigger does the rest. This reproduces
# the live shape exactly: ONE identity, active, administrator, NULL grantor.
q "insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data)
   values (gen_random_uuid(), '$TARGET', jsonb_build_object('full_name','Commissioning Check'), '{}'::jsonb)" >/dev/null
expect "profile is active"        "$(q "select status from public.profiles where email='$TARGET'")" "active"
expect "holds administrator only" "$(q "select string_agg(role::text,',' order by role) from public.user_roles")" "administrator"

echo "== 3. A role granted by a NAMED person, to prove the re-run preserves it =="
# A second profile, so there is somebody who is not the target to be the
# grantor — which user_roles_no_self_grant requires of any non-system grant.
q "insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data)
   values (gen_random_uuid(), 'peer-check@example.invalid', '{}'::jsonb, '{}'::jsonb)" >/dev/null
q "insert into public.user_roles (user_id, role, granted_by, reason)
   select t.id, 'operator'::public.app_role, g.id, 'granted by a named person'
     from public.profiles t, public.profiles g
    where t.email='$TARGET' and g.email='peer-check@example.invalid'" >/dev/null
expect "operator carries a named grantor" \
  "$(q "select reason from public.user_roles ur join public.profiles p on p.id=ur.user_id
         where p.email='$TARGET' and ur.role='operator'")" "granted by a named person"

echo "== 4. Supplying an address grants every role =="
ROLE_COUNT="$(q "select count(*) from unnest(enum_range(null::public.app_role))")"
psql -X -q -v ON_ERROR_STOP=1 "$DB" \
  -c "set $SETTING = '$TARGET';" -f "$MIGRATION" >/dev/null 2>&1 \
  || fail "the migration errored when an address was supplied"
expect "holds every role in public.app_role" \
  "$(q "select count(*) from public.user_roles ur join public.profiles p on p.id=ur.user_id
         where p.email='$TARGET'")" "$ROLE_COUNT"
expect "the system-granted rows carry granted_by = NULL" \
  "$(q "select count(*) from public.user_roles ur join public.profiles p on p.id=ur.user_id
         where p.email='$TARGET' and ur.granted_by is null")" "$((ROLE_COUNT - 1))"
expect "every row states a reason" \
  "$(q "select count(*) from public.user_roles ur join public.profiles p on p.id=ur.user_id
         where p.email='$TARGET' and coalesce(btrim(ur.reason),'')=''")" "0"
expect "exactly one commissioning audit event" \
  "$(q "select count(*) from public.audit_events where action='identity.commissioning_role_grant'")" "1"
expect "the audit event records a system actor, not the beneficiary" \
  "$(q "select coalesce(actor_id::text,'NULL') from public.audit_events
         where action='identity.commissioning_role_grant'")" "NULL"
expect "the named grantor was NOT overwritten" \
  "$(q "select reason from public.user_roles ur join public.profiles p on p.id=ur.user_id
         where p.email='$TARGET' and ur.role='operator'")" "granted by a named person"

echo "== 5. Re-running the WHOLE FILE is a no-op =="
psql -X -q -v ON_ERROR_STOP=1 "$DB" \
  -c "set $SETTING = '$TARGET';" -f "$MIGRATION" >/dev/null 2>&1 \
  || fail "re-running the migration errored"
expect "still holds exactly every role" \
  "$(q "select count(*) from public.user_roles ur join public.profiles p on p.id=ur.user_id
         where p.email='$TARGET'")" "$ROLE_COUNT"
expect "still exactly one audit event (no duplicate)" \
  "$(q "select count(*) from public.audit_events where action='identity.commissioning_role_grant'")" "1"
expect "the named grantor still survives" \
  "$(q "select reason from public.user_roles ur join public.profiles p on p.id=ur.user_id
         where p.email='$TARGET' and ur.role='operator'")" "granted by a named person"

echo "== 6. Refusals (negative controls) =="
if psql -X -q -v ON_ERROR_STOP=1 "$DB" \
     -c "select public.apply_commissioning_role_grant('nobody@example.invalid')" >/dev/null 2>&1; then
  fail "an unknown address was accepted"
else
  pass "an unknown address is refused"
fi
if psql -X -q -v ON_ERROR_STOP=1 "$DB" \
     -c "select public.apply_commissioning_role_grant('')" >/dev/null 2>&1; then
  fail "an empty address was accepted"
else
  pass "an empty address is refused"
fi
q "insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data)
   values (gen_random_uuid(), '$PENDING', '{}'::jsonb, '{}'::jsonb)" >/dev/null
expect "the second identity landed on pending" \
  "$(q "select status from public.profiles where email='$PENDING'")" "pending"
if psql -X -q -v ON_ERROR_STOP=1 "$DB" \
     -c "select public.apply_commissioning_role_grant('$PENDING')" >/dev/null 2>&1; then
  fail "a pending account was accepted — the grant would have looked applied and done nothing"
else
  pass "a pending account is refused"
fi
expect "the refused account holds no roles" \
  "$(q "select count(*) from public.user_roles ur join public.profiles p on p.id=ur.user_id
         where p.email='$PENDING'")" "0"

echo "== 7. The constraint claim the migration's comment depends on =="
# Positive AND negative. The positive alone would also pass against a
# constraint that had been dropped, so it proves nothing on its own.
if q "begin;
      insert into public.user_roles (user_id, role, granted_by, reason)
      select p.id,'auditor'::public.app_role,null,'probe' from public.profiles p
       where p.email='$PENDING';
      rollback;" >/dev/null 2>&1; then
  pass "granted_by = NULL satisfies user_roles_no_self_grant"
else
  fail "granted_by = NULL was rejected — the migration's premise is false"
fi
if psql -X -q -v ON_ERROR_STOP=1 "$DB" -c "begin;
      insert into public.user_roles (user_id, role, granted_by, reason)
      select p.id,'auditor'::public.app_role,p.id,'probe' from public.profiles p
       where p.email='$PENDING';
      rollback;" >/dev/null 2>&1; then
  fail "granted_by = user_id was ACCEPTED — the constraint is not enforcing"
else
  pass "granted_by = user_id is rejected (the constraint is live, not inert)"
fi

echo "== 8. What every role still does NOT unlock =="
expect "exactly one permission is held by no role" \
  "$(q "select count(*) from unnest(enum_range(null::public.app_permission)) e(v)
         where not exists (select 1 from public.role_permissions rp where rp.permission=e.v)")" "1"
expect "and it is disposition.override_release" \
  "$(q "select e.v::text from unnest(enum_range(null::public.app_permission)) e(v)
         where not exists (select 1 from public.role_permissions rp where rp.permission=e.v)")" \
  "disposition.override_release"
expect "user_delegations.granted_by is NOT NULL (no system escape hatch)" \
  "$(q "select is_nullable from information_schema.columns
         where table_schema='public' and table_name='user_delegations' and column_name='granted_by'")" "NO"

echo
if [ "$fails" -eq 0 ]; then
  echo "== PASS: all checks held for $DB =="
else
  echo "== FAIL: $fails check(s) failed for $DB ==" >&2
  exit 1
fi
