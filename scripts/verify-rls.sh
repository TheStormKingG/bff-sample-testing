#!/usr/bin/env bash
#
# Prove the RLS policies DENY.
#
# A policy is a claim about a refusal, and an unexercised policy is an
# untested one. "RLS is enabled on 31 of 31 tables" says nothing about whether
# any of them actually stops anybody: a permissive `using (true)`, a policy on
# the wrong command, or an UPDATE policy with a USING clause and no WITH CHECK
# all leave RLS "enabled" and the table open.
#
# Every check below runs as the `authenticated` role with a JWT subject set the
# way PostgREST sets it, inside a transaction that is rolled back.
#
# Run scripts/verify-migrations.sh first — this expects its database.
#
# Usage: scripts/verify-rls.sh [dbname]
#
set -uo pipefail

DB="${1:-bff_migration_check}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

if [[ ! "$DB" =~ ^bff_[a-z0-9_]*(check|verify|scratch|tmp)[a-z0-9_]*$ ]]; then
  echo "REFUSING to touch database '$DB' (see scripts/verify-migrations.sh)." >&2
  exit 2
fi

PENDING_ID='11111111-1111-4111-8111-111111111111'
OPERATOR_ID='22222222-2222-4222-8222-222222222222'
ADMIN_ID='33333333-3333-4333-8333-333333333333'

pass=0; fail=0

# Seed three identities with the superuser connection (bypasses RLS by owning
# the tables), so the checks below have something real to be denied.
psql -v ON_ERROR_STOP=1 -q -X "$DB" >/dev/null <<SQL
insert into auth.users (id, email) values
  ('$PENDING_ID','pending@example.invalid'),
  ('$OPERATOR_ID','operator@example.invalid'),
  ('$ADMIN_ID','admin@example.invalid')
on conflict (id) do nothing;

-- The profiles_active_requires_approval constraint forbids an active profile
-- without a recorded approval, which is the "no self-assigned access" rule
-- enforced in the schema rather than only in application code. So the two
-- active identities below must carry an approval basis; the administrator
-- uses the bootstrap basis (approved_by null, approved_at set), the only
-- shape the constraint allows for a first administrator.
insert into public.profiles
  (id, email, display_name, status, approval_basis, approved_by, approved_at)
values
  ('$PENDING_ID','pending@example.invalid','Pending Person','pending', null, null, null),
  ('$ADMIN_ID','admin@example.invalid','Admin Person','active',
     'first_administrator_bootstrap', null, now()),
  ('$OPERATOR_ID','operator@example.invalid','Operator Person','active',
     'approved_by_administrator','$ADMIN_ID', now())
on conflict (id) do update set
  status         = excluded.status,
  approval_basis = excluded.approval_basis,
  approved_by    = excluded.approved_by,
  approved_at    = excluded.approved_at;

-- user_roles_no_self_grant is CHECK (granted_by IS DISTINCT FROM user_id):
-- nobody may grant a role to themselves. NULL satisfies it, which is how a
-- first administrator can exist at all without a prior administrator to
-- approve them. The operator is granted by the administrator, as in real use.
insert into public.user_roles (user_id, role, granted_by, reason) values
  ('$ADMIN_ID','administrator', null, 'rls verification bootstrap'),
  ('$OPERATOR_ID','operator','$ADMIN_ID','rls verification')
on conflict do nothing;

-- samples_registered_has_evidence: a registered sample must record who
-- registered it and when. "Preserve evidence" is a stated product principle
-- and the schema enforces it rather than trusting the writer, which is why a
-- plausible-looking row without registered_by is rejected here.
insert into public.samples
  (sample_id, stage, prefix, collection_instant, collection_local_date,
   collection_local_time, sampled_by_name, created_by, capture_state,
   registered_by, registered_at)
values
  ('RM-261024-01','raw_materials','RM', now(), current_date, '08:15',
   'Operator Person','$OPERATOR_ID','registered','$OPERATOR_ID', now())
on conflict (sample_id) do nothing;
SQL
if [ $? -ne 0 ]; then echo "FAILED to seed identities; cannot verify RLS." >&2; exit 1; fi

# $1 label, $2 expectation: 'rows'|'norows'|'error', $3 subject uuid or '', $4 sql
check() {
  local label="$1" expect="$2" subject="$3" sql="$4"
  local claims="" out rc
  if [ -n "$subject" ]; then
    claims="set local request.jwt.claims = '{\"sub\":\"$subject\",\"role\":\"authenticated\"}';"
  fi
  out="$(psql -v ON_ERROR_STOP=1 -q -X -t -A "$DB" 2>&1 <<SQL
begin;
set local role authenticated;
$claims
$sql
rollback;
SQL
)"; rc=$?

  local verdict="FAIL" detail=""
  case "$expect" in
    error)
      if [ $rc -ne 0 ]; then verdict="ok"; else detail="expected a refusal, statement succeeded"; fi ;;
    norows)
      if [ $rc -eq 0 ] && [ "$(printf '%s' "$out" | tr -d '[:space:]')" = "0" ]; then verdict="ok"
      else detail="expected 0 rows, got: $(printf '%s' "$out" | head -c 120)"; fi ;;
    rows)
      if [ $rc -eq 0 ] && [ "$(printf '%s' "$out" | tr -d '[:space:]')" != "0" ]; then verdict="ok"
      else detail="expected rows, got: $(printf '%s' "$out" | head -c 120)"; fi ;;
  esac

  if [ "$verdict" = "ok" ]; then
    printf '  ok    %s\n' "$label"; pass=$((pass+1))
  else
    printf '  FAIL  %s\n        %s\n' "$label" "$detail"; fail=$((fail+1))
  fi
}

echo "== Reads: an unapproved account must see nothing =="
check "unauthenticated cannot read samples"            norows ""            "select count(*) from public.samples;"
check "unauthenticated cannot read profiles"           norows ""            "select count(*) from public.profiles;"
check "unauthenticated cannot read audit events"       norows ""            "select count(*) from public.audit_events;"
check "PENDING account cannot read samples"            norows "$PENDING_ID" "select count(*) from public.samples;"
check "PENDING account cannot read specifications"     norows "$PENDING_ID" "select count(*) from public.specification_versions;"
check "active operator CAN read samples"               rows   "$OPERATOR_ID" "select count(*) from public.samples;"

echo "== Self-elevation must be impossible =="
check "operator cannot grant themselves a role"        error "$OPERATOR_ID" \
  "insert into public.user_roles (user_id, role, granted_by, reason) values ('$OPERATOR_ID','quality_supervisor','$OPERATOR_ID','self');"
check "operator cannot grant themselves administrator" error "$OPERATOR_ID" \
  "insert into public.user_roles (user_id, role, granted_by, reason) values ('$OPERATOR_ID','administrator','$OPERATOR_ID','self');"
check "pending account cannot activate itself"         error "$PENDING_ID" \
  "update public.profiles set status = 'active' where id = '$PENDING_ID';"
check "operator cannot delete their role row"          error "$OPERATOR_ID" \
  "delete from public.user_roles where user_id = '$OPERATOR_ID';"

echo "== Append-only and privileged tables reject direct client writes =="
check "nobody writes audit events directly"            error "$ADMIN_ID" \
  "insert into public.audit_events (action, entity_type, outcome) values ('forged','sample','allowed');"
check "nobody rewrites an audit event"                 error "$ADMIN_ID" \
  "update public.audit_events set action = 'tampered';"
check "operator cannot approve a specification"        error "$OPERATOR_ID" \
  "update public.specification_versions set status = 'approved', approved_by = '$OPERATOR_ID';"
check "operator cannot write the sync outbox"          error "$OPERATOR_ID" \
  "insert into public.sheet_sync_outbox (sample_uuid, intended_tab, state) values (gen_random_uuid(),'1 Raw materials','pending');"
check "administrator cannot clear a hold directly"     error "$ADMIN_ID" \
  "update public.samples set hold_flag = false, disposition = 'accepted';"
check "operator cannot forge a sample identifier"      error "$OPERATOR_ID" \
  "insert into public.samples (sample_id, stage, prefix, collection_instant, collection_local_date, collection_local_time, sampled_by_name, created_by, capture_state) values ('RM-261024-99','raw_materials','RM', now(), current_date, '09:00','x','$OPERATOR_ID','registered');"

echo
echo "== $pass passed, $fail failed =="
[ "$fail" -eq 0 ] || exit 1
