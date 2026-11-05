#!/usr/bin/env bash
#
# NC-YYYY-NNN must be unique under concurrent allocation.
#
# WHY THIS IS NOT A MIGRATION PROBE, AND NOT A VITEST TEST
# --------------------------------------------------------
# Two inserts inside one transaction test SEQUENTIAL allocation and look
# identical in the output to a concurrency test. A probe's transaction
# boundary decides which case it exercised, and it is chosen by the
# invocation syntax rather than by the author's intent — so the proof has to
# come from genuinely separate sessions.
#
# It is not a Vitest test either: that suite has no database access. It mocks
# Supabase, and a mock answers whatever it is asked, so the test would pass
# against any allocator at all — including the `max+1` this exists to rule
# out. The first draft of the plan specified exactly that and would have
# shipped a test incapable of failing.
#
# WHAT IT PROVES
# --------------
# N connections each allocate M numbers against the same year, concurrently.
# A correct allocator issues N*M distinct numbers. `max(nc_number)+1` reads a
# value another session is about to write and issues duplicates — a collision
# that never reproduces in single-user testing.
#
# It also checks the three-digit padding survives past 99, because a
# formatter written for two digits truncates or collides exactly there.
#
# THE FIXTURE IS DELIBERATELY NARROW. This project cannot be rebuilt from an
# empty database (open decision D-12: verify-migrations.sh fails at 0039,
# which asserts on seeded rows, and the seed itself fails on a missing
# materials row). That is no loss here: the allocator's atomicity depends on
# no other table, so a full schema could only obscure a failure.
#
# Usage: scripts/verify-nc-numbering.sh [dbname] [connections] [per_connection]
#
set -uo pipefail

DB="${1:-bff_nc_numbering_check}"
CONNECTIONS="${2:-20}"
PER_CONNECTION="${3:-10}"
YEAR=2099

# The same guard verify-uat03-concurrency.sh uses: this script drops and
# recreates its database, so it must never be pointed at a real one.
if [[ ! "$DB" =~ ^bff_[a-z0-9_]*(check|verify|scratch|tmp)[a-z0-9_]*$ ]]; then
  echo "REFUSING to touch database '$DB' — the name must mark it as scratch." >&2
  exit 2
fi

TOTAL=$((CONNECTIONS * PER_CONNECTION))
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

dropdb --if-exists "$DB" >/dev/null 2>&1
createdb "$DB" || { echo "could not create $DB" >&2; exit 2; }

# THE FIXTURE IS EXTRACTED FROM THE MIGRATION, NOT TRANSCRIBED.
#
# This script used to carry its own hand-written copy of the table and the
# allocator. It raced that copy 200 times and printed a pass, and no change to
# the SHIPPED allocator in 0048 could make it fail — the one regression it
# exists to catch. A review pointed at the specification found it: replace the
# real function's upsert with `max(last_number)+1` and this script stays green,
# because it was never executing the real function at all.
#
# So the two objects are cut out of the migration by text. A full rebuild is
# impossible here (open decision D-12: verify-migrations.sh fails at 0039), and
# that is why the fixture is narrow — but narrow is not the same as a copy.
MIG="$(cd "$(dirname "$0")/.." && pwd)/supabase/migrations/0048_nonconformity_schema.sql"
[[ -r "$MIG" ]] || { echo "cannot read $MIG" >&2; exit 2; }

# The table, from its `create table` to the line that closes it.
awk '/^create table public\.nc_number_sequence \(/,/^\);/' "$MIG" > "$WORK/fixture.sql"
# The allocator, from its `create function` to the `end $$;` that ends it.
awk '/^create function public\.allocate_nc_number\(/,/^end \$\$;/' "$MIG" >> "$WORK/fixture.sql"

# INSTRUMENT CHECK. An awk range that matches nothing produces an empty file
# and a silent, cheerful pass over a database with no allocator in it — which
# is the same failure as before, wearing different clothes.
grep -q 'create table public\.nc_number_sequence' "$WORK/fixture.sql" || {
  echo "EXTRACTION FAILED: no nc_number_sequence table found in $MIG" >&2; exit 2; }
grep -q 'create function public\.allocate_nc_number' "$WORK/fixture.sql" || {
  echo "EXTRACTION FAILED: no allocate_nc_number function found in $MIG" >&2; exit 2; }
grep -q 'end \$\$;' "$WORK/fixture.sql" || {
  echo "EXTRACTION FAILED: the allocator was cut off before its end" >&2; exit 2; }

psql -q -v ON_ERROR_STOP=1 -d "$DB" -f "$WORK/fixture.sql" >/dev/null || {
  echo "the extracted fixture did not load — read $WORK/fixture.sql" >&2; exit 2; }

# MAX+1 MODE: REPLACE the extracted allocator with the naive one, to prove
# this script can fail. A verifier that has only ever been seen to pass has not
# been tested. Note what this does and does not prove: it shows the harness
# detects duplicate numbers. What makes the run meaningful is the extraction
# above — that the function being raced is the one that ships.
if [[ "${NC_NUMBERING_NAIVE:-0}" == "1" ]]; then
  psql -q -v ON_ERROR_STOP=1 -d "$DB" >/dev/null <<'SQL'
  create table public.nc_issued (nc_number text);
  create or replace function public.allocate_nc_number(p_year integer)
  returns text language plpgsql set search_path = '' as $$
  declare v_next integer; v_num text;
  begin
    select coalesce(max(substring(nc_number from 9)::int), 0) + 1
      into v_next from public.nc_issued;
    v_num := 'NC-' || p_year::text || '-' || lpad(v_next::text, 3, '0');
    perform pg_sleep(0.005);            -- widen the read-then-write window
    insert into public.nc_issued values (v_num);
    return v_num;
  end $$;
SQL
  echo "NAIVE MODE: allocator replaced with max+1 — this run is EXPECTED TO FAIL."
fi

echo "Allocating ${TOTAL} numbers from ${CONNECTIONS} concurrent connections…"
for ((c = 0; c < CONNECTIONS; c++)); do
  (
    for ((i = 0; i < PER_CONNECTION; i++)); do
      psql -t -A -q -d "$DB" -c "select public.allocate_nc_number(${YEAR});"
    done
  ) >"$WORK/out.$c" 2>"$WORK/err.$c" &
done
wait

cat "$WORK"/out.* | grep -E '^NC-' | sort >"$WORK/all"
GOT=$(wc -l <"$WORK/all" | tr -d ' ')
DISTINCT=$(sort -u "$WORK/all" | wc -l | tr -d ' ')

fail=0

# 1. Every allocation returned something.
if [[ "$GOT" != "$TOTAL" ]]; then
  echo "FAIL: ${GOT} numbers returned, expected ${TOTAL}" >&2
  head -3 "$WORK"/err.* >&2
  fail=1
fi

# 2. THE COLLISION CHECK.
if [[ "$DISTINCT" != "$GOT" ]]; then
  echo "FAIL: ${DISTINCT} distinct of ${GOT} — the allocator issued duplicates:" >&2
  sort "$WORK/all" | uniq -d | head -5 >&2
  fail=1
fi

# 3. Padding survives past 99. A two-digit formatter collides or truncates
#    exactly here, which is why TOTAL is above 100 by default.
WIDEST=$(sed 's/^NC-[0-9]*-//' "$WORK/all" | awk '{ print length }' | sort -rn | head -1)
if (( TOTAL >= 100 )) && [[ "$WIDEST" -lt 3 ]]; then
  echo "FAIL: widest sequence is ${WIDEST} digits; ${TOTAL} allocations need 3" >&2
  fail=1
fi

# 4. The stored counter agrees with what was handed out.
if [[ "${NC_NUMBERING_NAIVE:-0}" != "1" ]]; then
  LAST=$(psql -t -A -q -d "$DB" -c \
    "select last_number from public.nc_number_sequence where year = ${YEAR};")
  if [[ "$LAST" != "$TOTAL" ]]; then
    echo "FAIL: nc_number_sequence says ${LAST}, ${TOTAL} were issued" >&2
    fail=1
  fi
fi

dropdb --if-exists "$DB" >/dev/null 2>&1

if (( fail )); then
  echo "NC NUMBERING: FAILED"
  exit 1
fi
echo "NC NUMBERING OK — ${DISTINCT} distinct numbers from ${CONNECTIONS} concurrent connections."
