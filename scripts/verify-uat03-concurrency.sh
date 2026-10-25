#!/usr/bin/env bash
#
# UAT-03 — concurrent registration must yield unique, durable identifiers.
#
# PRD §13: "simulate at least 20 simultaneous registrations on the same date
# and stage; ensure unique durable IDs, no overwrites and all acknowledgments
# reconcile to rows." Master Prompt §5 additionally forbids computing the
# sequence by COUNTIF, by scanning the last sheet row, or by any frontend
# counter — all three are read-then-write races.
#
# This test is deliberately harder than the requirement:
#
#   * 20 CONCURRENT CONNECTIONS, each allocating repeatedly, so contention is
#     sustained rather than a single thundering-herd instant that a lucky
#     scheduler could serialise by accident.
#   * 200 TOTAL ALLOCATIONS, which also exercises the "expands beyond 99"
#     rule for real: sequences 100+ must render as three digits, and a
#     two-digit-only formatter would collide or truncate here.
#   * TWO PREFIXES IN PARALLEL on the same date, because the counter key is
#     (prefix, collection_date); a counter keyed on date alone would pass the
#     single-prefix test and fail this one.
#
# A pass means the allocator is genuinely atomic under contention on this
# PostgreSQL. It does not exercise PostgREST, Supabase pooling, or the
# Google Sheets projection — see docs/uat-plan.md.
#
# Usage: scripts/verify-uat03-concurrency.sh [dbname] [connections] [per_connection]
#
set -uo pipefail

DB="${1:-bff_migration_check}"
CONNECTIONS="${2:-20}"
PER_CONNECTION="${3:-10}"
COLLECTION_DATE="2026-11-02"   # a date no other check uses, so counters start clean

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

if [[ ! "$DB" =~ ^bff_[a-z0-9_]*(check|verify|scratch|tmp)[a-z0-9_]*$ ]]; then
  echo "REFUSING to touch database '$DB' (see scripts/verify-migrations.sh)." >&2
  exit 2
fi

TOTAL=$((CONNECTIONS * PER_CONNECTION))
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "== UAT-03: $CONNECTIONS concurrent connections x $PER_CONNECTION allocations = $TOTAL per prefix =="

# Clear any prior counter for this date so the expected sequence set is exact.
psql -v ON_ERROR_STOP=1 -q -X "$DB" >/dev/null <<SQL
delete from public.sample_id_counters where collection_local_date = '$COLLECTION_DATE';
SQL
if [ $? -ne 0 ]; then echo "FAIL: could not reset counters" >&2; exit 1; fi

# One psql per connection. Each loops inside a single session, so the
# allocator is hit repeatedly from genuinely parallel backends.
launch() {
  local prefix="$1" idx="$2"
  psql -v ON_ERROR_STOP=1 -q -X -t -A "$DB" \
    -c "select public.allocate_sample_id('$prefix', '$COLLECTION_DATE') from generate_series(1, $PER_CONNECTION);" \
    > "$WORK/${prefix}_${idx}.out" 2> "$WORK/${prefix}_${idx}.err"
  echo "$?" > "$WORK/${prefix}_${idx}.rc"
}

start=$(date +%s)
for i in $(seq 1 "$CONNECTIONS"); do
  launch RM "$i" &
  launch AM "$i" &
done
wait
elapsed=$(( $(date +%s) - start ))
echo "  all connections finished in ${elapsed}s"

fail=0

# Every connection must have succeeded. A deadlock or serialisation failure
# would show here, and reporting only on the IDs would hide it.
for f in "$WORK"/*.rc; do
  if [ "$(cat "$f")" != "0" ]; then
    base="${f%.rc}"
    echo "  FAIL  connection $(basename "$base") exited $(cat "$f"):"
    sed 's/^/        /' "$base.err" | head -5
    fail=1
  fi
done

check_prefix() {
  local prefix="$1"
  local all="$WORK/all_$prefix.txt"
  cat "$WORK/${prefix}_"*.out 2>/dev/null | grep -v '^$' > "$all"

  local count unique
  count=$(wc -l < "$all" | tr -d ' ')
  unique=$(sort -u "$all" | wc -l | tr -d ' ')

  echo "  -- $prefix --"
  echo "     allocated=$count unique=$unique expected=$TOTAL"

  if [ "$count" -ne "$TOTAL" ]; then
    echo "  FAIL  $prefix: allocated $count, expected $TOTAL"; fail=1
  fi
  if [ "$unique" -ne "$count" ]; then
    echo "  FAIL  $prefix: $((count - unique)) DUPLICATE identifier(s):"
    sort "$all" | uniq -d | head -5 | sed 's/^/        /'
    fail=1
  else
    echo "     ok   no duplicates"
  fi

  # Format and exact sequence coverage: 1..TOTAL with no gaps.
  local badformat
  badformat=$(grep -cvE "^${prefix}-261102-[0-9]{2,}$" "$all" || true)
  if [ "$badformat" != "0" ]; then
    echo "  FAIL  $prefix: $badformat identifier(s) malformed:"
    grep -vE "^${prefix}-261102-[0-9]{2,}$" "$all" | head -3 | sed 's/^/        /'
    fail=1
  else
    echo "     ok   all identifiers match ${prefix}-261102-NN"
  fi

  local missing
  missing=$(comm -23 \
    <(seq 1 "$TOTAL" | sort) \
    <(sed -E "s/^${prefix}-261102-0*([0-9]+)$/\1/" "$all" | sort) | head -5)
  if [ -n "$missing" ]; then
    echo "  FAIL  $prefix: sequence not contiguous; missing: $(echo "$missing" | tr '\n' ' ')"; fail=1
  else
    echo "     ok   sequence covers 1..$TOTAL with no gaps"
  fi

  # The >99 expansion must actually have happened, otherwise this run never
  # tested it and a two-digit formatter would have passed by luck.
  if [ "$TOTAL" -gt 99 ]; then
    local threeDigit
    threeDigit=$(grep -cE "^${prefix}-261102-[0-9]{3,}$" "$all" || true)
    if [ "$threeDigit" -lt 1 ]; then
      echo "  FAIL  $prefix: no identifier above 99 was issued, so expansion was untested"; fail=1
    else
      echo "     ok   $threeDigit identifier(s) above 99 (expansion exercised)"
    fi
  fi
}

check_prefix RM
check_prefix AM

echo "  -- counter integrity --"
counters=$(psql -X -q -t -A -F'|' -c "
  select prefix, next_sequence from public.sample_id_counters
   where collection_local_date = '$COLLECTION_DATE' order by prefix;" "$DB")
echo "$counters" | sed 's/^/     /'

rows=$(printf '%s\n' "$counters" | grep -c . || true)
if [ "$rows" -ne 2 ]; then
  echo "  FAIL  expected exactly 2 counter rows (one per prefix), got $rows"; fail=1
else
  echo "     ok   one counter row per (prefix, date)"
fi

# AM and RM must not have shared a counter: each must have advanced to TOTAL
# independently. A date-only counter key would leave one at 2*TOTAL.
while IFS='|' read -r p n; do
  [ -z "$p" ] && continue
  expected=$((TOTAL + 1))
  if [ "$n" != "$expected" ] && [ "$n" != "$TOTAL" ]; then
    echo "  FAIL  counter for $p is $n; expected $TOTAL or $expected (prefixes may share a counter)"
    fail=1
  fi
done <<< "$counters"

echo
if [ "$fail" -eq 0 ]; then
  echo "== UAT-03 PASS: $((TOTAL * 2)) concurrent allocations across 2 prefixes, 0 duplicates =="
else
  echo "== UAT-03 FAIL =="
fi
exit "$fail"
