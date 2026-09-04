#!/usr/bin/env bash
# Test suite for bin/read-config.sh — specifically the ticket-source config
# exports (ticketSource / githubOwner / githubRepo). Points read-config.sh at a
# fixture manifest via MUADDIB_REPO (its documented REPO_ROOT override) and
# asserts the exported vars. Self-contained — no container needed.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
READ_CONFIG="$REPO_ROOT/bin/read-config.sh"

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

# Source read-config.sh with REPO_ROOT forced to the fixture repo (via
# MUADDIB_REPO) and echo the three ticket-source vars on one line as
# "<source>|<owner>|<repo>". Runs in a subshell so exports don't leak and a
# `return 1` from read-config.sh surfaces as a non-zero exit.
source_config() {
  (
    export MUADDIB_REPO="$1"
    if source "$READ_CONFIG" >/dev/null 2>&1; then
      printf '%s|%s|%s\n' \
        "$MUADDIB_TICKET_SOURCE" "$MUADDIB_GITHUB_OWNER" "$MUADDIB_GITHUB_REPO"
    else
      exit 3
    fi
  )
}

# ─── tests ────────────────────────────────────────────────────────────────────

test_default_linear() {
  # No ticketSource key → defaults to linear, empty owner/repo.
  local tmp="$1"
  write_manifest "$tmp" '{"projectName":"t"}'
  local got; got=$(source_config "$tmp")
  [ "$got" = "linear||" ] || { echo "expected 'linear||', got '$got'"; return 1; }
}

test_explicit_linear() {
  local tmp="$1"
  write_manifest "$tmp" '{"projectName":"t","ticketSource":"linear"}'
  local got; got=$(source_config "$tmp")
  [ "$got" = "linear||" ] || { echo "expected 'linear||', got '$got'"; return 1; }
}

test_explicit_github() {
  local tmp="$1"
  write_manifest "$tmp" '{"projectName":"t","ticketSource":"github","githubOwner":"rphovley","githubRepo":"muaddib"}'
  local got; got=$(source_config "$tmp")
  [ "$got" = "github|rphovley|muaddib" ] || { echo "expected 'github|rphovley|muaddib', got '$got'"; return 1; }
}

test_invalid_source_fails() {
  # A typo'd backend must fail loud, not silently fall back to linear.
  local tmp="$1"
  write_manifest "$tmp" '{"projectName":"t","ticketSource":"jira"}'
  if source_config "$tmp" >/dev/null 2>&1; then
    echo "expected sourcing to fail for invalid ticketSource"; return 1
  fi
}

test_github_requires_identifiers() {
  # ticketSource=github with no owner/repo must fail.
  local tmp="$1"
  write_manifest "$tmp" '{"projectName":"t","ticketSource":"github"}'
  if source_config "$tmp" >/dev/null 2>&1; then
    echo "expected sourcing to fail when github owner/repo missing"; return 1
  fi
}

test_github_requires_both() {
  # Only owner set, repo missing → still fails.
  local tmp="$1"
  write_manifest "$tmp" '{"projectName":"t","ticketSource":"github","githubOwner":"rphovley"}'
  if source_config "$tmp" >/dev/null 2>&1; then
    echo "expected sourcing to fail when githubRepo missing"; return 1
  fi
}

# ─── run ─────────────────────────────────────────────────────────────────────

cd "$REPO_ROOT"

run_test "no ticketSource → linear, empty owner/repo"      test_default_linear
run_test "ticketSource=linear → linear, empty owner/repo"  test_explicit_linear
run_test "ticketSource=github + owner/repo → exported"     test_explicit_github
run_test "invalid ticketSource → sourcing fails"           test_invalid_source_fails
run_test "github without owner/repo → sourcing fails"      test_github_requires_identifiers
run_test "github with only owner → sourcing fails"         test_github_requires_both

echo ""
echo "$PASS/$((PASS + FAIL)) passed"
[ "$FAIL" -eq 0 ] || exit 1
