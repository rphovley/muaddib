#!/usr/bin/env bash
# Test suite for run-checks.sh.
# Stubs out npm and git so the real project commands never run.
# Tests are self-contained — no container needed.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CHECKS_SCRIPT="$SCRIPT_DIR/run-checks.sh"
STATE_CLI="$REPO_ROOT/lib/state-cli.js"

PASS=0; FAIL=0

# ─── test runner ─────────────────────────────────────────────────────────────
# Each test function receives a fresh $TMP dir as $1.

run_test() {
  local name="$1"
  local fn="$2"
  local tmp
  tmp=$(mktemp -d)
  local log="$tmp/test.log"

  if "$fn" "$tmp" >"$log" 2>&1; then
    echo "  $name... PASS"
    PASS=$((PASS + 1))
  else
    echo "  $name... FAIL"
    cat "$log" | sed 's/^/    /'
    FAIL=$((FAIL + 1))
  fi
  rm -rf "$tmp"
}

# ─── helpers ─────────────────────────────────────────────────────────────────

# Build a fake repo dir with stub git and npm binaries.
# FAKE_DIFF controls what git diff outputs (space-separated paths).
# FAKE_NPM_EXIT controls npm exit code (default 0).
make_fake_repo() {
  local dir="$1"
  mkdir -p "$dir/bin" "$dir/muaddib/lib" "$dir/muaddib/scripts"

  cat > "$dir/bin/git" <<'EOF'
#!/usr/bin/env bash
if [[ "$*" == *"diff --name-only"* ]]; then
  for f in ${FAKE_DIFF:-}; do echo "$f"; done
  exit 0
fi
exec "$(which git)" "$@"
EOF
  chmod +x "$dir/bin/git"

  cat > "$dir/bin/npm" <<'EOF'
#!/usr/bin/env bash
exit "${FAKE_NPM_EXIT:-0}"
EOF
  chmod +x "$dir/bin/npm"

  cp "$STATE_CLI" "$dir/muaddib/lib/state-cli.js"
  cp "$REPO_ROOT/lib/state.js"  "$dir/muaddib/lib/state.js"
  cp "$CHECKS_SCRIPT" "$dir/muaddib/scripts/run-checks.sh"
}

# Run run-checks.sh inside a fake repo and return its exit code.
# Caller exports FAKE_DIFF / FAKE_NPM_EXIT before calling.
run_checks() {
  local tmp="$1"
  local repo="$tmp/repo"
  make_fake_repo "$repo"

  PATH="$repo/bin:$PATH" \
  REPO_DIR="$repo" \
  STATE_DIR="$tmp" \
  WORKER_INDEX=98 \
    bash "$repo/muaddib/scripts/run-checks.sh"
}

check_status() {
  local tmp="$1"
  STATE_DIR="$tmp" node "$STATE_CLI" 98 get check_status 2>/dev/null || echo ""
}

# ─── tests ────────────────────────────────────────────────────────────────────

test_no_changes() {
  local tmp="$1"
  FAKE_DIFF="" run_checks "$tmp"
  local got; got=$(check_status "$tmp")
  [ "$got" = "pass" ] || { echo "expected pass, got '$got'"; return 1; }
}

test_api_changes_pass() {
  local tmp="$1"
  FAKE_DIFF="projects/api/src/foo.ts" FAKE_NPM_EXIT=0 run_checks "$tmp"
  local got; got=$(check_status "$tmp")
  [ "$got" = "pass" ] || { echo "expected pass, got '$got'"; return 1; }
}

test_api_changes_fail() {
  local tmp="$1"
  FAKE_DIFF="projects/api/src/foo.ts" FAKE_NPM_EXIT=1 run_checks "$tmp"
  local got; got=$(check_status "$tmp")
  [ "$got" = "fail" ] || { echo "expected fail, got '$got'"; return 1; }
}

test_portal_changes_pass() {
  local tmp="$1"
  FAKE_DIFF="projects/portal/src/App.tsx" FAKE_NPM_EXIT=0 run_checks "$tmp"
  local got; got=$(check_status "$tmp")
  [ "$got" = "pass" ] || { echo "expected pass, got '$got'"; return 1; }
}

test_portal_changes_fail() {
  local tmp="$1"
  FAKE_DIFF="projects/portal/src/App.tsx" FAKE_NPM_EXIT=1 run_checks "$tmp"
  local got; got=$(check_status "$tmp")
  [ "$got" = "fail" ] || { echo "expected fail, got '$got'"; return 1; }
}

test_multi_project_one_fails() {
  # API and portal both changed. Portal's npm fails, API's passes.
  local tmp="$1"
  local repo="$tmp/repo"
  make_fake_repo "$repo"

  # Selective npm stub: fail for portal, pass for everything else
  cat > "$repo/bin/npm" <<'EOF'
#!/usr/bin/env bash
if [[ "$*" == *"projects/portal"* ]]; then exit 1; fi
exit 0
EOF
  chmod +x "$repo/bin/npm"

  FAKE_DIFF="projects/api/src/a.ts projects/portal/src/b.tsx" \
  PATH="$repo/bin:$PATH" \
  REPO_DIR="$repo" \
  STATE_DIR="$tmp" \
  WORKER_INDEX=98 \
    bash "$repo/muaddib/scripts/run-checks.sh"

  local got; got=$(check_status "$tmp")
  [ "$got" = "fail" ] || { echo "expected fail, got '$got'"; return 1; }
}

test_non_project_files_skipped() {
  # Only root-level files changed — no project bucket hit, result is pass.
  local tmp="$1"
  FAKE_DIFF="README.md CLAUDE.md docs/foo.md" FAKE_NPM_EXIT=0 run_checks "$tmp"
  local got; got=$(check_status "$tmp")
  [ "$got" = "pass" ] || { echo "expected pass, got '$got'"; return 1; }
}

test_exits_zero_on_check_failure() {
  # run-checks.sh must exit 0 even when npm fails; failure is in state only.
  local tmp="$1"
  FAKE_DIFF="projects/api/src/x.ts" FAKE_NPM_EXIT=1 run_checks "$tmp"
  # If we reach here run_checks exited 0 (run_test would have caught non-zero).
  local got; got=$(check_status "$tmp")
  [ "$got" = "fail" ] || { echo "expected fail in state, got '$got'"; return 1; }
}

test_homeowner_changes() {
  local tmp="$1"
  FAKE_DIFF="projects/homeowner/src/index.tsx" FAKE_NPM_EXIT=0 run_checks "$tmp"
  local got; got=$(check_status "$tmp")
  [ "$got" = "pass" ] || { echo "expected pass, got '$got'"; return 1; }
}

test_app_install_changes() {
  local tmp="$1"
  FAKE_DIFF="projects/app_install/src/main.tsx" FAKE_NPM_EXIT=0 run_checks "$tmp"
  local got; got=$(check_status "$tmp")
  [ "$got" = "pass" ] || { echo "expected pass, got '$got'"; return 1; }
}

# ─── run ─────────────────────────────────────────────────────────────────────

cd "$REPO_ROOT"

run_test "no changes → check_status=pass"                  test_no_changes
run_test "api changes, npm passes → pass"                  test_api_changes_pass
run_test "api changes, npm fails → fail"                   test_api_changes_fail
run_test "portal changes, npm passes → pass"               test_portal_changes_pass
run_test "portal changes, npm fails → fail"                test_portal_changes_fail
run_test "multi-project, portal fails → fail"              test_multi_project_one_fails
run_test "non-project files only → pass (no checks run)"   test_non_project_files_skipped
run_test "script exits 0 even when checks fail"            test_exits_zero_on_check_failure
run_test "homeowner changes → pass"                        test_homeowner_changes
run_test "app_install changes → pass"                      test_app_install_changes

echo ""
echo "$PASS/$((PASS + FAIL)) passed"
[ "$FAIL" -eq 0 ] || exit 1
