#!/usr/bin/env bash
# Test suite for herdr-plugin/ — the optional herdr local plugin that dispatches
# a muaddib worker from inside herdr (see herdr-plugin/README.md).
#
# herdr itself is a host-only macOS binary and isn't present in the worker
# container, so these tests exercise the wrapper (dispatch-action.sh) against a
# *stub* muaddib checkout and a *stub* `herdr` on PATH — verifying the pure
# call-through behavior without spawning a real worker or needing herdr:
#   - mode → correct existing entry point (default/plan/fast)
#   - the ticket ID is prompted for and forwarded verbatim (whitespace trimmed)
#   - dispatch goes through `herdr plugin pane open ... -- <entry> <ticket>`
#   - graceful fallback to a direct dispatch when herdr isn't on PATH
#   - unknown mode / empty input are rejected
# Plus a couple of static checks on the manifest. Self-contained — no container.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
WRAPPER="$REPO_ROOT/herdr-plugin/dispatch-action.sh"
MANIFEST="$REPO_ROOT/herdr-plugin/herdr-plugin.toml"

PASS=0; FAIL=0

# ─── test runner ─────────────────────────────────────────────────────────────
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

# ─── fixture helpers ─────────────────────────────────────────────────────────

# Build a fake muaddib checkout in $1: a copy of the real wrapper under
# herdr-plugin/ (so its BASH_SOURCE-relative "../" root resolution points here)
# plus stub entry scripts that just echo how they were called. Returns nothing;
# the wrapper is at $1/herdr-plugin/dispatch-action.sh.
make_fixture() {
  local root="$1"
  mkdir -p "$root/herdr-plugin"
  cp "$WRAPPER" "$root/herdr-plugin/dispatch-action.sh"
  chmod +x "$root/herdr-plugin/dispatch-action.sh"
  local m
  for m in muaddib muaddib-plan muaddib-fast; do
    cat >"$root/$m.sh" <<EOF
#!/usr/bin/env bash
echo "DISPATCH $m \$*"
EOF
    chmod +x "$root/$m.sh"
  done
}

# A stub \`herdr\` that records its argv (one per line) to \$HERDR_LOG. Placed
# first on PATH so the wrapper's \`command -v herdr\` finds it.
make_stub_herdr() {
  local bindir="$1"
  mkdir -p "$bindir"
  cat >"$bindir/herdr" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$@" >>"$HERDR_LOG"
EOF
  chmod +x "$bindir/herdr"
}

# Run the wrapper for a fixture, feeding $ticket on stdin. Extra env passed
# through the caller. Echoes the wrapper's stdout+stderr; returns its exit code.
run_wrapper() {
  local root="$1" mode="$2" ticket="$3"
  printf '%s\n' "$ticket" | bash "$root/herdr-plugin/dispatch-action.sh" "$mode"
}

# ─── tests ───────────────────────────────────────────────────────────────────

# With a stub herdr present, each mode dispatches through
# `herdr plugin pane open ... -- <entry> <ticket>` and picks the right entry.
test_mode_routing_via_herdr() {
  local tmp="$1"
  make_fixture "$tmp"
  make_stub_herdr "$tmp/bin"
  export HERDR_LOG="$tmp/herdr.log"

  local mode entry pair
  for pair in "default:muaddib.sh" "plan:muaddib-plan.sh" "fast:muaddib-fast.sh"; do
    mode="${pair%%:*}"; entry="${pair##*:}"
    : >"$HERDR_LOG"
    PATH="$tmp/bin:$PATH" run_wrapper "$tmp" "$mode" "QUO-9"

    grep -qx "plugin" "$HERDR_LOG"  || { echo "mode=$mode: expected 'plugin' subcommand"; return 1; }
    grep -qx "pane"   "$HERDR_LOG"  || { echo "mode=$mode: expected 'pane'";   return 1; }
    grep -qx "open"   "$HERDR_LOG"  || { echo "mode=$mode: expected 'open'";   return 1; }
    grep -qx "$tmp/$entry" "$HERDR_LOG" || {
      echo "mode=$mode: expected entry $tmp/$entry in argv"; sed 's/^/      /' "$HERDR_LOG"; return 1; }
    grep -qx "QUO-9" "$HERDR_LOG" || { echo "mode=$mode: ticket not forwarded"; return 1; }
  done
}

# Without herdr on PATH the wrapper falls back to running the entry directly,
# so we see the stub entry's own DISPATCH line — and the right entry per mode.
test_fallback_direct_dispatch() {
  local tmp="$1"
  make_fixture "$tmp"
  local out
  # Minimal PATH with no herdr; /usr/bin:/bin cover cd/dirname/etc.
  out=$(PATH="/usr/bin:/bin" run_wrapper "$tmp" "plan" "QUO-42")
  echo "$out" | grep -q "DISPATCH muaddib-plan QUO-42" || {
    echo "expected direct dispatch of muaddib-plan with QUO-42; got:"; echo "$out"; return 1; }
}

# Surrounding whitespace on the entered ticket is trimmed before dispatch.
test_ticket_whitespace_trimmed() {
  local tmp="$1"
  make_fixture "$tmp"
  local out
  out=$(PATH="/usr/bin:/bin" run_wrapper "$tmp" "default" "   QUO-7   ")
  # default mode inserts a literal '--' guard before the argument (so hyphen-
  # leading task text isn't parsed as a muaddib.sh flag), hence 'muaddib -- QUO-7'.
  echo "$out" | grep -q "DISPATCH muaddib -- QUO-7$" || {
    echo "expected trimmed 'QUO-7'; got:"; echo "$out"; return 1; }
}

# Empty / whitespace-only input aborts with a non-zero exit and no dispatch.
test_empty_ticket_rejected() {
  local tmp="$1"
  make_fixture "$tmp"
  local out rc
  out=$(PATH="/usr/bin:/bin" run_wrapper "$tmp" "default" "    " 2>&1); rc=$?
  [ "$rc" -ne 0 ] || { echo "expected non-zero exit on empty ticket, got 0"; return 1; }
  echo "$out" | grep -qi "no ticket" || { echo "expected 'no ticket' message; got:"; echo "$out"; return 1; }
  echo "$out" | grep -q "DISPATCH" && { echo "must not dispatch on empty ticket"; return 1; }
  return 0
}

# An unrecognized mode is rejected with exit 2 before any prompt/dispatch.
test_unknown_mode_rejected() {
  local tmp="$1"
  make_fixture "$tmp"
  local out rc
  out=$(printf 'QUO-1\n' | bash "$tmp/herdr-plugin/dispatch-action.sh" "bogus" 2>&1); rc=$?
  [ "$rc" -eq 2 ] || { echo "expected exit 2 for unknown mode, got $rc"; return 1; }
  echo "$out" | grep -qi "unknown mode" || { echo "expected 'unknown mode' message; got:"; echo "$out"; return 1; }
}

# Static: the manifest declares all three action ids and points at the wrapper.
test_manifest_declares_actions() {
  local id
  for id in muaddib-dispatch muaddib-dispatch-plan muaddib-dispatch-fast; do
    grep -q "\"$id\"" "$MANIFEST" || grep -q "id = \"$id\"" "$MANIFEST" || {
      echo "manifest missing action id: $id"; return 1; }
  done
  grep -q "dispatch-action.sh" "$MANIFEST" || { echo "manifest doesn't reference dispatch-action.sh"; return 1; }
}

# Static: the shipped wrapper is executable (herdr runs it as a command).
test_wrapper_executable() {
  [ -x "$WRAPPER" ] || { echo "$WRAPPER is not executable"; return 1; }
}

# ─── run ─────────────────────────────────────────────────────────────────────
echo "herdr-plugin dispatch wrapper tests:"
run_test "mode routing via herdr pane open" test_mode_routing_via_herdr
run_test "fallback direct dispatch (no herdr)" test_fallback_direct_dispatch
run_test "ticket whitespace trimmed" test_ticket_whitespace_trimmed
run_test "empty ticket rejected" test_empty_ticket_rejected
run_test "unknown mode rejected" test_unknown_mode_rejected
run_test "manifest declares all actions" test_manifest_declares_actions
run_test "wrapper is executable" test_wrapper_executable

echo ""
echo "herdr-plugin: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
