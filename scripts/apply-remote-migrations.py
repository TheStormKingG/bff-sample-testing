#!/usr/bin/env python3
"""
Apply the migrations and production seed to a hosted Supabase project.

WHY THIS EXISTS, and why it is not `supabase db push`:
`db push` opens a direct Postgres connection and therefore needs the project's
DATABASE PASSWORD. This uses the Management API's query endpoint instead, which
authenticates with the Supabase ACCESS TOKEN the CLI already holds, so the
database password is never needed, never typed and never stored anywhere.

The token is read from the environment or from the macOS Keychain entry the
Supabase CLI created. It is held in memory only and is never printed, never
written to disk and never included in any output — including on error.

Usage:
    scripts/apply-remote-migrations.py <project-ref> [--include-seed]
    SUPABASE_ACCESS_TOKEN=sbp_... scripts/apply-remote-migrations.py <ref>

Deliberately NOT applied:
  * scripts/local-sql-shim.sql       — a stand-in for GoTrue, used only for
                                       local verification. Supabase has the real
                                       `auth` schema; applying the shim would
                                       collide with it.
  * supabase/seed/test_fixtures.sql  — the ONLY file containing an approved
                                       specification limit. It exists so UAT-06
                                       can run and must never reach a project
                                       that records real samples.
  * bootstrap_first_administrator.sql — refuses to run without an explicitly
                                       supplied address, by design. Choosing an
                                       address on the operator's behalf would
                                       defeat the control, so it is left to them.
"""

from __future__ import annotations

import base64
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

API = "https://api.supabase.com/v1/projects/{ref}/database/query"

REPO = Path(__file__).resolve().parent.parent
MIGRATIONS = REPO / "supabase" / "migrations"
SEED = REPO / "supabase" / "seed"

SKIP_SEED = {"test_fixtures.sql", "bootstrap_first_administrator.sql"}


def read_token() -> str:
    """Return the access token. Never log or echo the value."""
    env = os.environ.get("SUPABASE_ACCESS_TOKEN", "").strip()
    if env:
        return env

    try:
        raw = subprocess.run(
            ["security", "find-generic-password", "-s", "Supabase CLI", "-a", "supabase", "-w"],
            capture_output=True,
            text=True,
            check=True,
        ).stdout.strip()
    except (subprocess.CalledProcessError, FileNotFoundError):
        sys.exit(
            "No access token. Set SUPABASE_ACCESS_TOKEN, or run `supabase login` so the\n"
            "CLI stores one in the Keychain."
        )

    # go-keyring base64-encodes values containing characters it cannot store raw.
    for prefix in ("go-keyring-encoded:", "go-keyring-base64:"):
        if raw.startswith(prefix):
            raw = base64.b64decode(raw[len(prefix) :]).decode("utf-8", "strict")
            break

    if not raw.startswith("sbp_"):
        sys.exit("The stored credential is not a Supabase access token (expected an sbp_ prefix).")
    return raw


def run_sql(ref: str, token: str, sql: str) -> tuple[bool, str]:
    request = urllib.request.Request(
        API.format(ref=ref),
        data=json.dumps({"query": sql}).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=300) as response:
            return True, response.read().decode("utf-8", "replace")[:400]
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", "replace")
        try:
            body = json.loads(body).get("message", body)
        except json.JSONDecodeError:
            pass
        # The token is in the request headers, not in the response: safe to show.
        return False, f"HTTP {exc.code}: {body[:600]}"
    except urllib.error.URLError as exc:
        return False, f"network error: {exc.reason}"


def main() -> int:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    flags = {a for a in sys.argv[1:] if a.startswith("--")}
    if not args:
        return int(bool(sys.exit(__doc__)))

    ref = args[0]
    token = read_token()

    files = sorted(MIGRATIONS.glob("*.sql"))
    if not files:
        sys.exit("No migrations found. Nothing was applied.")

    # --from <prefix> resumes after a failure. Each Management API request is
    # its own transaction, so a migration that failed rolled back completely
    # and can simply be re-run; the ones before it are already applied and
    # would fail on "already exists".
    resume = next((a.split("=", 1)[1] for a in flags if a.startswith("--from=")), None)
    if resume:
        start = next((i for i, p in enumerate(files) if p.name.startswith(resume)), None)
        if start is None:
            sys.exit(f"No migration starts with {resume!r}.")
        skipped = [p.name for p in files[:start]]
        files = files[start:]
        print(f"Resuming at {files[0].name}; assuming {len(skipped)} earlier file(s) are applied.\n")

    if "--include-seed" in flags:
        files += [p for p in sorted(SEED.glob("*.sql")) if p.name not in SKIP_SEED]

    print(f"Applying {len(files)} file(s) to project {ref}\n")
    failed = 0
    for path in files:
        sql = path.read_text()
        ok, detail = run_sql(ref, token, sql)
        if ok:
            print(f"  ok    {path.name}")
        else:
            print(f"  FAIL  {path.name}")
            for line in detail.splitlines():
                print(f"        {line}")
            failed += 1
            # Stop at the first failure: later migrations assume earlier ones
            # applied, so continuing would bury the real cause under cascades.
            break

    print()
    if failed:
        print("Stopped at the first failure. Nothing after it was attempted.")
        return 1
    print(f"Applied {len(files)} file(s) with no errors.")
    print("Not applied, by design: test_fixtures.sql (the only approved limit) and")
    print("bootstrap_first_administrator.sql (needs an explicitly chosen address).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
