#!/usr/bin/env python3
"""
Check that every table and column the frontend SELECTs actually exists.

WHY THIS EXISTS. The frontend reaches Postgres directly through PostgREST, so
a column name in a `.select('...')` string is a contract with the schema that
nothing enforces. It is a plain string: TypeScript cannot check it, the linter
cannot check it, the unit tests do not touch the database, and the migrations
know nothing about the frontend. The first time anyone finds out is when a
screen renders an error in front of a user.

That is not hypothetical. `profiles.full_name` reached production and broke the
post-sign-in access check; the column has been `display_name` since the first
migration. Running this check for the first time found 39 such mismatches
across 125 selected columns — 31% of the frontend's data access — including an
entire table that does not exist under the name the frontend used.

It also resolves a select built from a module constant — `.select(SAMPLE_COLUMNS)`
rather than `.select('id,stage')`. That is not a refinement either. Ten call
sites were written that way, carrying 70 of the frontend's columns, and all ten
were invisible to the first two versions of this script: it reported PASS over
24 of the 34 call sites that exist, in the same words it would use for all 34.
Two of the ten were in files nobody had touched or reviewed.

WHAT IT CANNOT DO. It matches `.from(X).select(Y)` where X is a literal, a
`TABLES.<alias>` or a constant, and Y is a literal or a constant. A select
assembled at runtime, an embedded resource (`a(b)`), or a column named only
inside an RPC payload is still out of scope, and the count it prints is the
honest size of what it checked, not of what exists.

Requires a database with the migrations applied — run scripts/verify-migrations.sh
first. Usage: scripts/check-frontend-schema.py [dbname]
"""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SRC = REPO / "src"

# `.from(X)` ... `.select('cols')`.
#
# X is any of: a string literal, `TABLES.<alias>`, or a bare constant such as
# `PROFILES_TABLE`. The bare-constant form is not an edge case — the first
# version of this script handled only the first two and therefore MISSED
# `useProfile.ts`, the one file whose broken column had already reached a user.
# A checker that silently skips a call site reports a smaller number in exactly
# the same words as a clean one.
#
# The SELECT argument is likewise a literal or an identifier. The identifier
# form is not an edge case: `.select(SAMPLE_COLUMNS)` is how the samples list,
# the sample detail page, the specifications screen and the dashboard all read
# their data, and a checker that skips it passes them silently.
CALL = re.compile(
    r"\.from\(\s*(?:'(?P<literal>[^']+)'|(?P<ident>[A-Za-z_$][\w$]*(?:\.\w+)?))\s*\)"
    r"(?P<between>[\s\S]{0,400}?)"
    r"\.select\(\s*(?:'(?P<cols>[^']+)'|(?P<colsident>[A-Za-z_$][\w$]*))"
)
# Object entry: `samples: 'samples',`   Constant: `const PROFILES_TABLE = 'profiles'`
TABLE_ALIAS = re.compile(r"^\s*(\w+):\s*'([^']+)',", re.M)
STRING_CONST = re.compile(r"\bconst\s+([A-Z][A-Z0-9_]*)\s*(?::[^=]+)?=\s*'([^']+)'")
# A constant may be declared in one file and used in another, so resolution is
# global across src. First definition wins, and a collision is reported rather
# than resolved silently — two different column lists under one name would make
# every result from that name untrustworthy.



def load_schema(db: str) -> dict[str, set[str]]:
    result = subprocess.run(
        ["psql", "-X", "-q", "-t", "-A", "-F", "\x1f", db, "-c",
         "select table_name, column_name from information_schema.columns "
         "where table_schema = 'public'"],
        capture_output=True, text=True,
    )
    if result.returncode != 0:
        sys.exit(
            f"Could not read the schema from database '{db}'.\n"
            f"{result.stderr.strip()}\n"
            "Run scripts/verify-migrations.sh first."
        )
    schema: dict[str, set[str]] = {}
    for line in result.stdout.strip().splitlines():
        if not line:
            continue
        table, column = line.split("\x1f")
        schema.setdefault(table, set()).add(column)
    return schema


def alias_map() -> tuple[dict[str, str], dict[str, str]]:
    """Resolve `TABLES.<alias>` and bare `UPPER_CASE` string constants.

    Constants resolve globally across src, because a column list is declared
    in one module and used in several — `SAMPLE_COLUMNS` lives in useSamples
    and is read by useSampleDetail. Two different values under one name would
    make every lookup of that name a coin toss, so a genuine collision is
    returned as a problem instead of being resolved to whichever file sorted
    first.
    """
    out: dict[str, str] = {}
    origin: dict[str, str] = {}
    clashing: dict[str, str] = {}
    for path in sorted(SRC.rglob("*.ts")) + sorted(SRC.rglob("*.tsx")):
        rel = str(path.relative_to(REPO))
        text = path.read_text()
        if "TABLES = {" in text:
            body = text.split("TABLES = {", 1)[1].split("}", 1)[0]
            for alias, table in TABLE_ALIAS.findall(body):
                out[alias] = table
                out[f"TABLES.{alias}"] = table
        for name, value in STRING_CONST.findall(text):
            if name in out and out[name] != value:
                # Poison the name rather than announce it. Most clashes are on
                # constants no query ever touches — `INPUT_CLASS` is a CSS
                # class declared in two component files — and reporting those
                # is noise that buries the real findings. A poisoned name is
                # reported only if a `.from()` or `.select()` actually uses it,
                # which is the only place the ambiguity can do harm.
                clashing[name] = (
                    f"declared with two different values, in {origin[name]} "
                    f"and {rel}"
                )
                del out[name]
                continue
            if name in clashing:
                continue
            out.setdefault(name, value)
            origin.setdefault(name, rel)
    return out, clashing


def selected_columns(cols: str) -> list[str]:
    # Split on top-level commas, drop embedded resources and aliases.
    out = []
    for part in re.split(r",(?![^(]*\))", cols):
        name = part.strip().split(":")[0].strip()
        if not name or name == "*" or "(" in name:
            continue
        out.append(name)
    return out


def main() -> int:
    db = sys.argv[1] if len(sys.argv) > 1 else "bff_migration_check"
    schema = load_schema(db)

    # Instrument check: an empty schema would pass everything vacuously.
    if len(schema) < 5:
        print(f"FAIL  only {len(schema)} table(s) found in '{db}'. The migrations are "
              "probably not applied, so nothing was really checked.", file=sys.stderr)
        return 1

    aliases, clashing = alias_map()
    problems: list[str] = []
    checked = 0
    call_sites = 0

    for path in sorted(SRC.rglob("*.ts")) + sorted(SRC.rglob("*.tsx")):
        text = path.read_text()
        for match in CALL.finditer(text):
            call_sites += 1
            key = match.group("literal") or match.group("ident")
            table = aliases.get(key, key)
            rel = path.relative_to(REPO)

            # Resolve the select argument. An identifier that resolves to
            # nothing is REPORTED: an unchecked call site is a finding, not a
            # silent pass. This is the same rule as for an unresolved table,
            # and it is here because the absence of it is what hid ten sites.
            cols = match.group("cols")
            if cols is None:
                name = match.group("colsident")
                if name not in aliases:
                    detail = (
                        f" — it is {clashing[name]}"
                        if name in clashing
                        else ""
                    )
                    problems.append(
                        f"{rel}: select list `{name}` could not be resolved{detail}, "
                        f"so the columns read from '{table}' were NOT checked"
                    )
                    continue
                cols = aliases[name]

            if key in clashing:
                problems.append(
                    f"{rel}: table name `{key}` is {clashing[key]}, so this "
                    "call site could not be checked"
                )
                continue
            if table not in schema:
                # An identifier this script could not resolve is reported, not
                # skipped: an unresolved name is an unchecked call site.
                problems.append(
                    f"{rel}: table '{table}'"
                    + ("" if match.group("literal") else f" (from `{key}`)")
                    + " does not exist"
                )
                continue
            for column in selected_columns(cols):
                checked += 1
                if column not in schema[table]:
                    problems.append(f"{rel}: {table}.{column} does not exist")

    # A zero here means the matcher is broken, not that the frontend is clean.
    if call_sites == 0:
        print("FAIL  found no .from(...).select('...') call sites. The matcher is "
              "broken, or the data access moved; either way nothing was checked.",
              file=sys.stderr)
        return 1

    print(f"Checked {checked} selected column(s) across {call_sites} call site(s) "
          f"against database '{db}'.")

    if problems:
        print(f"\nFAIL  {len(problems)} mismatch(es) between the frontend and the schema:",
              file=sys.stderr)
        for problem in problems:
            print(f"  {problem}", file=sys.stderr)
        print("\nEach of these is a screen that errors in front of a user.", file=sys.stderr)
        return 1

    print("\nPASS  every selected table and column exists.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
