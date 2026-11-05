#!/usr/bin/env python3
"""
Run one SQL script against a hosted Supabase project, read from stdin.

This exists for the verify-*.sql proofs, which need a live database but must
not need the database PASSWORD. It reuses `apply-remote-migrations.py`'s token
reader, so authentication is the Supabase ACCESS TOKEN the CLI already holds
in the Keychain. The token is held in memory only and is never printed — not
on success, not on error.

Usage:
    scripts/run-sql.py [project-ref] < scripts/verify-nc-lifecycle.sql

With no argument the ref is taken from VITE_SUPABASE_URL in `.env` — the
project this checkout is pointed at. That is deliberate: a verification script
whose target is a positional argument gets run against the wrong project once,
and the one it gets run against is whichever one somebody typed.

Exit status is 0 only if the server accepted the script. A verify-*.sql proof
is silent on success and raises on failure, so a zero exit IS the result.
"""

from __future__ import annotations

import importlib.util
import json
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
_APPLY = REPO / "scripts" / "apply-remote-migrations.py"


def _load_apply():
    spec = importlib.util.spec_from_file_location("arm", _APPLY)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _ref_from_env_file() -> str | None:
    """The project ref out of VITE_SUPABASE_URL. Never the keys beside it."""
    env = REPO / ".env"
    if not env.is_file():
        return None
    for line in env.read_text().splitlines():
        if line.startswith("VITE_SUPABASE_URL"):
            host = line.split("=", 1)[1].strip().strip("\"'")
            m = re.search(r"https://([a-z0-9]+)\.supabase\.co", host)
            return m.group(1) if m else None
    return None


def main() -> int:
    if len(sys.argv) > 2:
        print(__doc__.strip(), file=sys.stderr)
        return 2

    ref = sys.argv[1] if len(sys.argv) == 2 else _ref_from_env_file()
    if not ref:
        print("no project ref given and none found in .env", file=sys.stderr)
        return 2
    sql = sys.stdin.read()
    if not sql.strip():
        print("nothing on stdin", file=sys.stderr)
        return 2

    apply = _load_apply()
    request = urllib.request.Request(
        apply.API.format(ref=ref),
        data=json.dumps({"query": sql}).encode(),
        headers={
            "Authorization": f"Bearer {apply.read_token()}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=300) as response:
            body = response.read().decode()
    except urllib.error.HTTPError as error:
        # The body carries the server's own message, which is what a failed
        # assertion looks like. It never contains the token.
        print(error.read().decode()[:4000], file=sys.stderr)
        return 1
    if body.strip() not in ("[]", ""):
        print(body)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
