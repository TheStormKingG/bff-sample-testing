#!/usr/bin/env bash
#
# Static analysis for the Supabase Edge Functions — the ONE implementation,
# called by `npm run verify:functions` and by .github/workflows/ci.yml.
#
# ===========================================================================
# WHY THIS FILE EXISTS AT ALL
# ===========================================================================
# supabase/functions/** is about 8,500 lines of authorisation, idempotency and
# external-write logic, and NEITHER of the project's two obvious checkers reads
# it:
#
#   tsconfig.app.json   "include": ["src", "tests"]      — the tree is outside
#   eslint.config.js    ignores: [... 'supabase/functions/**']
#
# so `npm run typecheck` exiting 0 and `npm run lint` reporting no errors say
# nothing whatsoever about it. That is not an oversight in either config: these
# are Deno modules (`Deno.serve`, `Deno.env`, `npm:` specifiers) and tsc and
# eslint would report a wall of phantom diagnostics while checking nothing real.
# Deno is the right checker, and this script is it.
#
# The CI workflow has run these checks since the round that added them. What it
# did NOT have was a way to run them locally: the logic lived inline in the
# YAML, so a developer had to read the workflow and retype it, and the inline
# copy was the only copy. The ci.yml header warns about exactly that shape — "a
# copied-out test list drifts from the real one, and the copy that drifts is
# always the one guarding production". So the implementation moved here and both
# callers invoke it.
#
# ===========================================================================
# WHAT THIS GATE ESTABLISHES, AND WHAT IT DOES NOT
# ===========================================================================
# ESTABLISHES: every module under supabase/functions/** type-checks under the
# pinned Deno, and passes Deno's own lint rules minus one named exclusion.
#
# DOES NOT ESTABLISH that the module graph LOADS. Type checking and module
# resolution are different questions over the same import statement. The server
# modules reach shared domain code in src/** through `import type`, which is
# ERASED before any runtime module graph exists — so a specifier that Vite
# resolves and Deno does not passes this gate and fails the deploy. That is
# measured, not assumed: with a real such defect present, `deno check` over
# every function module exited 0. `scripts/check-shared-module-imports.mjs` is
# the gate for that class, and it is a separate step on purpose.
#
# DOES NOT ESTABLISH anything about the SQL, the RLS policies, or whether an RPC
# this code calls exists. Those are `scripts/verify-migrations.sh`,
# `scripts/verify-rls.sh` and `tests/rpcContract.test.ts`.
#
# ===========================================================================
# USAGE
# ===========================================================================
#   scripts/check-edge-functions.sh --self-test   validate the gate, then exit
#   scripts/check-edge-functions.sh --typecheck   deno check only
#   scripts/check-edge-functions.sh --lint        deno lint only
#   scripts/check-edge-functions.sh              self-test, typecheck, lint
#
set -euo pipefail

# Run from the repository root whatever the caller's working directory is: the
# tree path below is relative, and `npm run` and a CI step do not agree on cwd.
cd "$(dirname "$0")/.."

TREE='supabase/functions'
# Pinned in .github/workflows/ci.yml via denoland/setup-deno. Deno ships its own
# TypeScript, so a different minor version is a different checker over the same
# tree. Reported, not enforced: refusing to run locally on 2.8.1 would mean the
# gate is unavailable exactly when somebody wants it.
EXPECTED_DENO='2.8.0'

# `no-import-prefix` rejects the inline `npm:@supabase/supabase-js@2.47.10`
# specifiers Supabase Edge Functions are written with, and its suggested fix
# would change how the deployed runtime resolves that dependency. Excluded BY
# NAME so the exclusion is visible in the diff and in the log.
LINT_EXCLUDE='no-import-prefix'

# GitHub turns `::error::` into an annotation; everywhere else it is just text.
annotate() {
  if [ -n "${GITHUB_ACTIONS:-}" ]; then printf '::error::%s\n' "$1" >&2
  else printf 'ERROR: %s\n' "$1" >&2
  fi
}

require_deno() {
  if ! command -v deno >/dev/null 2>&1; then
    annotate "deno is not installed, so the Edge Functions were NOT checked. Install Deno $EXPECTED_DENO (https://deno.land) or run this in CI."
    exit 1
  fi
  local found
  found="$(deno --version | head -1 | awk '{print $2}')"
  if [ "$found" != "$EXPECTED_DENO" ]; then
    printf 'NOTE: deno %s found, %s is pinned in ci.yml. Deno ships its own TypeScript, so diagnostics may differ from the gate that blocks the deployment.\n' \
      "$found" "$EXPECTED_DENO" >&2
  fi
}

# The population, counted independently of the checker. `deno check` given
# nothing to check exits 0, so a renamed or moved directory would quietly turn
# this gate into a pass. A gate that cannot tell "nothing is wrong" from
# "nothing was examined" is not a gate.
module_count() {
  find "$TREE" -type f -name '*.ts' | wc -l | tr -d ' '
}

# ---------------------------------------------------------------------------
# SELF-TEST — validate the instrument BEFORE believing its verdict.
#
# A checker cannot see what it gates: a `deno check` that silently examined
# nothing prints success in exactly the same words as one that worked. This
# writes a module with a genuine type error into the tree, requires the gate to
# fail on it, removes it, and requires the gate to pass again. Both halves are
# needed — a control that only shows a refusal proves nothing without a positive
# control showing the same call succeeds when it should.
#
# THE FIXTURE GOES INSIDE THE TREE, not into a scratch directory, and that is
# deliberate: Deno discovers its configuration by walking up from the working
# directory, and these modules only resolve their `@/`-aliased and extensionless
# src/** imports under the project's own config. A fixture checked somewhere
# else would be checked under different rules than the thing it certifies.
#
# IT IS REMOVED BEFORE THE REAL CHECK RUNS, by a trap that fires on any exit,
# so a failure in the middle cannot leave a deliberately broken module behind
# for another agent's `find` to pick up.
# ---------------------------------------------------------------------------
self_test() {
  require_deno

  local before after fixture_dir fixture log
  before="$(module_count)"
  if [ "$before" -eq 0 ]; then
    annotate "no Deno modules found under $TREE/ — this gate would check nothing"
    exit 1
  fi

  fixture_dir="$TREE/__gate_self_test_$$"
  fixture="$fixture_dir/broken.ts"
  # shellcheck disable=SC2064  # expand $fixture_dir now, while it is in scope
  trap "rm -rf '$fixture_dir'" EXIT
  mkdir -p "$fixture_dir"
  cat > "$fixture" <<'FIXTURE'
// Deliberately broken fixture for scripts/check-edge-functions.sh --self-test.
// Written, checked and deleted inside one run. If you are reading this file on
// disk, a self-test crashed between creating and removing it: delete it.
//
// The error is an undefined symbol on a success path — the exact defect class
// this gate was added for, after one shipped to production in a committed Edge
// Function and passed lint, typecheck, every unit test, the build and the
// bundle scan.
export function gateSelfTest(): string {
  return thisSymbolIsNotDefinedAnywhere;
}
FIXTURE

  after="$(module_count)"
  if [ "$after" -ne $(( before + 1 )) ]; then
    annotate "self-test fixture did not land in the checked set ($before then $after modules) — the enumeration below does not see what it should"
    exit 1
  fi

  log="$(mktemp)"
  if NO_COLOR=1 deno check "$fixture" > "$log" 2>&1; then
    annotate "SELF-TEST FAILED: deno check accepted a module with an undefined symbol. The verdict of this gate means nothing. Output: $(tr '\n' ' ' < "$log")"
    rm -f "$log"
    exit 1
  fi
  # Which refusal, not merely that something refused. A fixture whose file was
  # never written, or whose path was wrong, also makes `deno check` exit
  # non-zero — and would be counted as the gate working.
  if ! grep -q 'thisSymbolIsNotDefinedAnywhere' "$log"; then
    annotate "SELF-TEST INCONCLUSIVE: deno check failed on the fixture but did not name the undefined symbol, so something other than the planted error refused it. Output: $(tr '\n' ' ' < "$log")"
    rm -f "$log"
    exit 1
  fi
  rm -f "$log"

  rm -rf "$fixture_dir"
  trap - EXIT
  if [ "$(module_count)" -ne "$before" ]; then
    annotate "self-test fixture was not removed — $TREE/ is left in a modified state"
    exit 1
  fi

  # Positive control: the same command on the real tree must SUCCEED. Without
  # it, a gate that refuses everything would pass the refusal half above.
  if ! NO_COLOR=1 typecheck_quiet; then
    annotate "SELF-TEST FAILED: the real tree does not type-check, so the refusal above cannot be attributed to the planted error rather than to a pre-existing fault."
    exit 1
  fi

  printf 'Self-test passed: the gate refuses an undefined symbol by name and accepts the real tree (%s modules).\n' "$before"
}

typecheck_quiet() {
  find "$TREE" -type f -name '*.ts' -print0 | xargs -0 deno check > /dev/null 2>&1
}

typecheck() {
  require_deno
  local count log rc own shared
  count="$(module_count)"
  if [ "$count" -eq 0 ]; then
    annotate "no Deno modules found under $TREE/ — this gate checked nothing"
    exit 1
  fi
  printf 'Type-checking %s Deno modules under %s/\n' "$count" "$TREE"

  # Every module, not only the entrypoints: a _shared module no entrypoint
  # imports yet still ships and still has to compile.
  #
  # No --no-config: these modules import shared domain code from src/** with
  # extensionless and `@/`-aliased specifiers, which only resolve under the
  # project's own tsconfig. Disabling config discovery turns every one of those
  # imports into TS2307 and the gate reports on module resolution instead of on
  # the code.
  #
  # No --all either: that type-checks inside npm:@supabase/supabase-js — a
  # report on someone else's library, and a gate that turns red when they
  # publish.
  #
  # NO_COLOR because the attribution below greps for "at file:///…" and Deno
  # writes a colour escape between the "at" and the path. With colour on, that
  # grep matches nothing and the summary confidently reports zero of each.
  export NO_COLOR=1
  log="$(mktemp)"
  rc=0
  find "$TREE" -type f -name '*.ts' -print0 | xargs -0 deno check 2>&1 | tee "$log" || rc=$?

  if [ "$rc" -ne 0 ]; then
    # Attribute before grading. `deno check` reports on every module in the
    # import graph, so a failure here can belong to either of two owners: the
    # Edge Functions, or the shared src/** domain code they import. Both must
    # fail this gate, but they are different findings for different people, and
    # a bare red exit code says neither.
    own="$(grep -cE 'at file:.*/supabase/functions/' "$log" || true)"
    shared="$(grep -cE 'at file:.*/src/' "$log" || true)"
    annotate "Edge Function typecheck failed: $own diagnostic(s) in $TREE/**, $shared in shared src/** modules reached by import. Both block the deployment; they do not block the same person."
    rm -f "$log"
    exit "$rc"
  fi
  rm -f "$log"

  # Reconcile the instrument's own denominator against the population, by a
  # means the instrument does not share. A precise non-zero count reads as proof
  # the checker is working; the number that matters is how many modules it
  # SHOULD have seen.
  printf 'All %s Edge Function modules type-check.\n' "$count"
}

lint() {
  require_deno
  local count
  count="$(module_count)"
  if [ "$count" -eq 0 ]; then
    annotate "no Deno modules found under $TREE/ — nothing was linted"
    exit 1
  fi
  printf 'Linting %s Deno modules under %s/ (excluding rule %s)\n' "$count" "$TREE" "$LINT_EXCLUDE"
  # `deno fmt --check` is deliberately absent: deno fmt wants double quotes and
  # an 80-column width and reports every module as unformatted. Adding it would
  # mean reformatting the whole tree to satisfy a style nothing in this
  # repository has chosen — a diff, not a gate.
  deno lint "--rules-exclude=$LINT_EXCLUDE" "$TREE/"
}

case "${1:---all}" in
  --self-test) self_test ;;
  --typecheck) typecheck ;;
  --lint)      lint ;;
  --all)       self_test; typecheck; lint ;;
  *)
    printf 'usage: %s [--self-test|--typecheck|--lint|--all]\n' "$0" >&2
    exit 2
    ;;
esac
