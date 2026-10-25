#!/usr/bin/env bash
#
# Apply every migration, in order, to a throwaway PostgreSQL database and
# report the first failure with its file and line.
#
# WHY THIS EXISTS: `supabase db reset` needs Docker. Where Docker is
# unavailable, the alternative is reading the SQL and hoping — and reading
# demonstrably misses things. This project had two migration-ABORTING defects
# that no amount of TypeScript checking could see: a foreign key inserted
# before its referent, and a function redefined with a widened return type
# (which fails both as CREATE FUNCTION and as CREATE OR REPLACE). Both were
# found by eye; a third of that class would not have been.
#
# WHAT A PASS MEANS: the SQL is valid, self-consistent, and applies in the
# order the filenames imply. It does NOT mean the RLS policies deny what they
# should under a real JWT, because this is not Supabase — see the caveats at
# the top of scripts/local-sql-shim.sql. Use `supabase db reset` for that.
#
# Usage:
#   scripts/verify-migrations.sh [dbname]          # migrations + production seed
#   WITH_TEST_FIXTURES=1 scripts/verify-migrations.sh
#
set -euo pipefail

DB="${1:-bff_migration_check}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# ---------------------------------------------------------------------------
# SAFETY GUARD.
#
# This script DROPS the database it is given. That is fine for a scratch
# database and catastrophic for anything else, and the same server may host
# unrelated work. So the name must look unmistakably like a throwaway, and
# anything else is refused rather than confirmed-by-prompt: a prompt is a
# control that fails under haste.
# ---------------------------------------------------------------------------
if [[ ! "$DB" =~ ^bff_[a-z0-9_]*(check|verify|scratch|tmp)[a-z0-9_]*$ ]]; then
  echo "REFUSING to touch database '$DB'." >&2
  echo "This script drops the database it is given, so the name must match" >&2
  echo "  ^bff_[a-z0-9_]*(check|verify|scratch|tmp)[a-z0-9_]*\$" >&2
  echo "e.g. bff_migration_check. Pass a throwaway name." >&2
  exit 2
fi

if ! command -v psql >/dev/null 2>&1; then
  echo "psql not found. Install PostgreSQL, or run 'supabase db reset' with Docker." >&2
  exit 2
fi
if ! pg_isready -q 2>/dev/null; then
  echo "No PostgreSQL server is accepting connections." >&2
  exit 2
fi

echo "== Recreating $DB =="
dropdb --if-exists "$DB"
createdb "$DB"

apply() {
  local file="$1" label="$2"
  # ON_ERROR_STOP makes psql exit non-zero on the FIRST error instead of
  # ploughing on and reporting a confusing cascade.
  if out="$(psql -v ON_ERROR_STOP=1 -q -X -f "$file" "$DB" 2>&1)"; then
    printf '  ok    %s\n' "$label"
    return 0
  fi
  printf '  FAIL  %s\n' "$label"
  printf '%s\n' "$out" | sed 's/^/        /'
  return 1
}

echo "== Supabase shim =="
apply scripts/local-sql-shim.sql "local-sql-shim.sql"

echo "== Migrations =="
migration_count=0
for f in supabase/migrations/*.sql; do
  [ -e "$f" ] || continue
  apply "$f" "$(basename "$f")"
  migration_count=$((migration_count + 1))
done

# An empty loop would print nothing and exit 0 — a silent pass that looks
# identical to success. Fail closed instead.
if [ "$migration_count" -eq 0 ]; then
  echo "FAIL: no migrations were found in supabase/migrations/. Nothing was verified." >&2
  exit 1
fi

echo "== Production seed =="
BOOTSTRAP_SEED="supabase/seed/bootstrap_first_administrator.sql"
seed_count=0
for f in supabase/seed/*.sql; do
  [ -e "$f" ] || continue
  base="$(basename "$f")"
  if [ "$base" = "test_fixtures.sql" ] && [ "${WITH_TEST_FIXTURES:-0}" != "1" ]; then
    printf '  skip  %s (test-only; set WITH_TEST_FIXTURES=1 to include)\n' "$base"
    continue
  fi
  if [ "$f" = "$BOOTSTRAP_SEED" ]; then
    # Handled below: it is parameterised and must be exercised in BOTH
    # directions, so a plain apply would be the wrong test.
    continue
  fi
  apply "$f" "$base"
  seed_count=$((seed_count + 1))
done

# ---------------------------------------------------------------------------
# The first-administrator bootstrap is a CONTROL, so verify it as one.
#
# It must refuse to run without an explicitly supplied address, because the
# alternative — a hardcoded personal email in a migration — is what the
# requirement forbids. A script that only ever ran it the happy way would
# report a pass whether or not that refusal worked.
# ---------------------------------------------------------------------------
if [ -e "$BOOTSTRAP_SEED" ]; then
  echo "== First-administrator bootstrap (both directions) =="

  if psql -v ON_ERROR_STOP=1 -q -X -f "$BOOTSTRAP_SEED" "$DB" >/dev/null 2>&1; then
    echo "  FAIL  negative control: it ran with no app.bootstrap_admin_email set" >&2
    echo "        That would mean the address came from somewhere other than the operator." >&2
    exit 1
  fi
  echo "  ok    refuses to run with no address supplied (negative control)"

  BOOTSTRAP_EMAIL="${BOOTSTRAP_ADMIN_EMAIL:-migration-check@example.invalid}"
  if out="$(psql -v ON_ERROR_STOP=1 -q -X \
        -c "set app.bootstrap_admin_email = '${BOOTSTRAP_EMAIL}';" \
        -f "$BOOTSTRAP_SEED" "$DB" 2>&1)"; then
    echo "  ok    runs when an address is supplied explicitly"
    seed_count=$((seed_count + 1))
  else
    echo "  FAIL  bootstrap_first_administrator.sql with an address supplied"
    printf '%s\n' "$out" | sed 's/^/        /'
    exit 1
  fi

  # Re-running must not quietly mint a second administrator.
  if psql -v ON_ERROR_STOP=1 -q -X \
        -c "set app.bootstrap_admin_email = 'someone-else@example.invalid';" \
        -f "$BOOTSTRAP_SEED" "$DB" >/dev/null 2>&1; then
    echo "  warn  re-running the bootstrap succeeded; confirm it did not add a second admin"
  else
    echo "  ok    refuses to run twice (one-shot)"
  fi
fi

echo "== Post-apply facts =="
psql -X -q -t -A -F' ' -c "
  select
    (select count(*) from pg_tables where schemaname = 'public')                                as tables,
    (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname like 'rpc_%')                                   as rpc_functions,
    (select count(*) from pg_policies where schemaname = 'public')                              as policies,
    (select count(*) from pg_tables where schemaname = 'public' and rowsecurity)                as rls_enabled_tables,
    (select count(*) from pg_tables where schemaname = 'public' and not rowsecurity)            as rls_disabled_tables
" "$DB" | awk '{printf "  tables=%s rpc_functions=%s policies=%s rls_on=%s rls_off=%s\n",$1,$2,$3,$4,$5}'

# Zero approved specifications is a REQUIREMENT, not an accident: 0 of the 34
# workbook limits are approved, so every measurement must assess as
# Not Assessable (FR-009, UAT-05, risk R-01). Assert it on the real data.
approved="$(psql -X -q -t -A -c "
  select count(*) from public.specification_versions
   where status = 'approved' and approved_by is not null
" "$DB" 2>/dev/null || echo 'ERR')"
echo "  approved_specifications=$approved"
if [ "${WITH_TEST_FIXTURES:-0}" != "1" ] && [ "$approved" != "0" ]; then
  echo "FAIL: production seed contains $approved approved specification(s). It must contain none." >&2
  exit 1
fi

echo "== Done. Migrations applied: $migration_count, seed files: $seed_count =="
echo "   A pass here means the SQL is valid and applies in order."
echo "   It does NOT prove RLS denies a real request — run 'supabase db reset' for that."
