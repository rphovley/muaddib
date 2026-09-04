#!/usr/bin/env bash
# Test suite for muaddib.sh's ticket-vs-task classification. Exercises the
# --dry-run path, which classifies the argument (via fetch-ticket.js's
# extractIdentifier, gated on the project's declared ticketSource) and prints
# `source=<linear|github|raw>` + `task=<...>` before any spawn call. Dispatch
# is always direct — see muaddib.sh's header comment for why there is no
# routing decision left to test here.
#
# Points muaddib.sh at a fixture manifest via MUADDIB_REPO (read-config.sh's
# documented REPO_ROOT override — same seam test-read-config.sh uses), so no
# container is needed. Self-contained.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MUADDIB_SH="$REPO_ROOT/muaddib.sh"

PASS=0; FAIL=0

# ─── test runner ─────────────────────────────────────────────────────────────
# Each test function receives a fresh $TMP dir as $1.

run_test() {
  local name="$1" fn="$2"
  local tmp log
  tmp=$(mktemp -d)
  log="$tmp/test.log"
  if "$fn" "$tmp" >"$log" 2>&1; then
    echo "  $name... PASS"; PASS=$((PASS + 1))
  else
    echo "  $name... FAIL"; sed 's/^/    /' "$log"; FAIL=$((FAIL + 1))
  fi
  rm -rf "$tmp"
}

# ─── helpers ─────────────────────────────────────────────────────────────────

# Write a fixture manifest ($2 = JSON) into $1/.muaddib/manifest.json.
write_manifest() {
  mkdir -p "$1/.muaddib"
  printf '%s\n' "$2" > "$1/.muaddib/manifest.json"
}

LINEAR_MANIFEST='{"projectName":"t","ticketSource":"linear"}'
GITHUB_MANIFEST='{"projectName":"t","ticketSource":"github","githubOwner":"rphovley","githubRepo":"muaddib"}'

# Run muaddib.sh --dry-run against a fixture repo. Args after $1 are passed
# through verbatim (may include --raw). Prints "<source>|<task>" on success.
dispatch() {
  local repo="$1"; shift
  local out src task
  out="$(MUADDIB_REPO="$repo" bash "$MUADDIB_SH" --dry-run "$@" 2>/dev/null)" || return 1
  src="$(printf '%s\n' "$out"  | sed -n 's/^source=//p')"
  task="$(printf '%s\n' "$out" | sed -n 's/^task=//p')"
  printf '%s|%s\n' "$src" "$task"
}

# Assert dispatch(repo, args...) equals "<expected-source>|<expected-task>".
assert_dispatch() {
  local repo="$1" expected="$2"; shift 2
  local got; got="$(dispatch "$repo" "$@")"
  [ "$got" = "$expected" ] || { echo "args=[$*] expected '$expected', got '$got'"; return 1; }
}

# ─── ticket dispatch: linear ─────────────────────────────────────────────────

test_linear_url() {
  local tmp="$1"; write_manifest "$tmp" "$LINEAR_MANIFEST"
  assert_dispatch "$tmp" \
    "linear|/muaddib https://linear.app/quotethat/issue/QUO-227/some-title" \
    "https://linear.app/quotethat/issue/QUO-227/some-title"
}

test_linear_bare_id() {
  local tmp="$1"; write_manifest "$tmp" "$LINEAR_MANIFEST"
  assert_dispatch "$tmp" "linear|/muaddib QUO-123" "QUO-123"
}

# ─── ticket dispatch: github ─────────────────────────────────────────────────

test_github_issues_url() {
  local tmp="$1"; write_manifest "$tmp" "$GITHUB_MANIFEST"
  assert_dispatch "$tmp" \
    "github|/muaddib https://github.com/rphovley/muaddib/issues/36" \
    "https://github.com/rphovley/muaddib/issues/36"
}

test_github_bare_number() {
  local tmp="$1"; write_manifest "$tmp" "$GITHUB_MANIFEST"
  assert_dispatch "$tmp" "github|/muaddib 36" "36"
}

test_github_hash_number() {
  local tmp="$1"; write_manifest "$tmp" "$GITHUB_MANIFEST"
  assert_dispatch "$tmp" "github|/muaddib #36" "#36"
}

# ─── raw dispatch: free-form text ────────────────────────────────────────────

test_github_sentence_with_number_is_raw() {
  # A stray digit in a sentence must NOT be misread as issue #32 (the #73
  # false-positive class) — the whole argument has to be a bare number.
  local tmp="$1"; write_manifest "$tmp" "$GITHUB_MANIFEST"
  assert_dispatch "$tmp" \
    "raw|Investigate why there are only 32 items left" \
    "Investigate why there are only 32 items left"
}

test_linear_sentence_is_raw() {
  # Free-form text with no TEAM-123 token → raw on a linear project.
  local tmp="$1"; write_manifest "$tmp" "$LINEAR_MANIFEST"
  assert_dispatch "$tmp" \
    "raw|fix the auth token expiry bug in the portal" \
    "fix the auth token expiry bug in the portal"
}

# ─── --raw forces raw even for a ticket-shaped argument ──────────────────────

test_raw_flag_forces_raw_linear() {
  # --raw skips detection: a Linear-shaped arg is treated as task text.
  local tmp="$1"; write_manifest "$tmp" "$LINEAR_MANIFEST"
  assert_dispatch "$tmp" "raw|QUO-123" --raw "QUO-123"
}

test_raw_flag_forces_raw_github() {
  local tmp="$1"; write_manifest "$tmp" "$GITHUB_MANIFEST"
  assert_dispatch "$tmp" "raw|36" --raw "36"
}

# ─── usage-error-on-empty preserved ──────────────────────────────────────────

test_empty_arg_errors() {
  local tmp="$1"; write_manifest "$tmp" "$LINEAR_MANIFEST"
  if MUADDIB_REPO="$tmp" bash "$MUADDIB_SH" --dry-run >/dev/null 2>&1; then
    echo "expected non-zero exit for empty argument"; return 1
  fi
}

test_raw_flag_empty_arg_errors() {
  # muaddib.sh --raw with no argument must still error (muaddib-task.sh relies
  # on this to preserve its usage-error-on-empty behavior).
  local tmp="$1"; write_manifest "$tmp" "$LINEAR_MANIFEST"
  if MUADDIB_REPO="$tmp" bash "$MUADDIB_SH" --dry-run --raw >/dev/null 2>&1; then
    echo "expected non-zero exit for --raw with empty argument"; return 1
  fi
}

# ─── run ─────────────────────────────────────────────────────────────────────

cd "$REPO_ROOT"

run_test "linear URL → linear ticket dispatch"              test_linear_url
run_test "linear TEAM-123 → linear ticket dispatch"         test_linear_bare_id
run_test "github issues URL → github ticket dispatch"       test_github_issues_url
run_test "github bare number → github ticket dispatch"      test_github_bare_number
run_test "github #number → github ticket dispatch"          test_github_hash_number
run_test "github sentence w/ number → raw"                  test_github_sentence_with_number_is_raw
run_test "linear free-form sentence → raw"                  test_linear_sentence_is_raw
run_test "--raw forces raw (linear ticket-shaped arg)"      test_raw_flag_forces_raw_linear
run_test "--raw forces raw (github ticket-shaped arg)"      test_raw_flag_forces_raw_github
run_test "empty argument → usage error"                     test_empty_arg_errors
run_test "--raw + empty argument → usage error"             test_raw_flag_empty_arg_errors

echo ""
echo "$PASS/$((PASS + FAIL)) passed"
[ "$FAIL" -eq 0 ] || exit 1
