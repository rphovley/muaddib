#!/usr/bin/env bash
# Test suite for conductor.sh's launch-routing decision. Exercises the --dry-run
# path, which resolves `mode=<fg|bg|reuse|stop|start>` + `prompt=<...>` from the
# flags, the ticket/task argument, and whether a daemon is already up — and prints
# it before any node/nohup call (or the token check), so the dispatch is testable
# without a real daemon or a subscription token.
#
# "Is a daemon already up?" is keyed on CONDUCTOR_PID_FILE (an override conductor.sh
# honours precisely so this test can fake it): pointing it at a file holding this
# test's own live PID makes the reuse path fire; pointing it at a nonexistent path
# makes the no-daemon paths fire. Self-contained.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CONDUCTOR_SH="$REPO_ROOT/conductor.sh"

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

# Run conductor.sh --dry-run with a given PID file (arg 1) and pass the rest
# through verbatim. Prints "<mode>|<prompt>" on success.
dispatch() {
  local pidfile="$1"; shift
  local out mode prompt
  out="$(CONDUCTOR_PID_FILE="$pidfile" bash "$CONDUCTOR_SH" --dry-run "$@" 2>/dev/null)" || return 1
  mode="$(printf '%s\n' "$out"   | sed -n 's/^mode=//p')"
  prompt="$(printf '%s\n' "$out" | sed -n 's/^prompt=//p')"
  printf '%s|%s\n' "$mode" "$prompt"
}

# Assert dispatch(pidfile, args...) equals "<expected-mode>|<expected-prompt>".
assert_dispatch() {
  local pidfile="$1" expected="$2"; shift 2
  local got; got="$(dispatch "$pidfile" "$@")"
  [ "$got" = "$expected" ] || { echo "args=[$*] expected '$expected', got '$got'"; return 1; }
}

# A PID file guaranteed NOT to point at a live process (nonexistent path).
dead_pidfile()  { printf '%s\n' "$1/no-daemon.pid"; }
# A PID file pointing at a live process (this test's own PID).
alive_pidfile() { local f="$1/daemon.pid"; printf '%s\n' "$$" > "$f"; printf '%s\n' "$f"; }

# ─── no daemon running: start / fg / bg ──────────────────────────────────────

test_bare_start() {
  # No flags, no ticket → bare idle foreground daemon.
  local tmp="$1"
  assert_dispatch "$(dead_pidfile "$tmp")" "start|"
}

test_bare_bg_start() {
  # --bg with no ticket → bare idle detached daemon (still "start").
  local tmp="$1"
  assert_dispatch "$(dead_pidfile "$tmp")" "start|" --bg
}

test_ticket_foreground() {
  # No daemon + a ticket + foreground → fg, prompt = the ticket.
  local tmp="$1"
  assert_dispatch "$(dead_pidfile "$tmp")" "fg|QUO-507" QUO-507
}

test_ticket_background() {
  # No daemon + a ticket + --bg → bg, prompt = the ticket.
  local tmp="$1"
  assert_dispatch "$(dead_pidfile "$tmp")" "bg|QUO-507" --bg QUO-507
}

test_multiword_task() {
  # Free-form task text passed as separate words is joined into the prompt.
  local tmp="$1"
  assert_dispatch "$(dead_pidfile "$tmp")" \
    "fg|look into the flaky preview" look into the flaky preview
}

test_leading_slash_skill_verbatim() {
  # A leading-`/` skill argument passes through as the prompt verbatim (claude's
  # TUI interprets the slash — conductor.sh does no special-casing).
  local tmp="$1"
  assert_dispatch "$(dead_pidfile "$tmp")" "fg|/inspect QUO-507" "/inspect QUO-507"
}

# ─── daemon already running: reuse ───────────────────────────────────────────

test_reuse_when_daemon_alive() {
  # A live daemon + a ticket → reuse (send to the existing session), not a 2nd fg.
  local tmp="$1"
  assert_dispatch "$(alive_pidfile "$tmp")" "reuse|QUO-507" QUO-507
}

test_reuse_wins_over_bg() {
  # Reuse is chosen whenever the daemon is alive, even with --bg given.
  local tmp="$1"
  assert_dispatch "$(alive_pidfile "$tmp")" "reuse|QUO-507" --bg QUO-507
}

# ─── stop ────────────────────────────────────────────────────────────────────

test_stop() {
  local tmp="$1"
  assert_dispatch "$(dead_pidfile "$tmp")" "stop|" --stop
}

# ─── unknown flag → usage error ──────────────────────────────────────────────

test_unknown_flag_errors() {
  local tmp="$1"
  if CONDUCTOR_PID_FILE="$(dead_pidfile "$tmp")" \
     bash "$CONDUCTOR_SH" --dry-run --bogus >/dev/null 2>&1; then
    echo "expected non-zero exit for an unknown leading flag"; return 1
  fi
}

# ─── run ─────────────────────────────────────────────────────────────────────

cd "$REPO_ROOT"

run_test "bare (no args) → start"                        test_bare_start
run_test "--bg, no ticket → start"                       test_bare_bg_start
run_test "ticket, no daemon → fg"                        test_ticket_foreground
run_test "--bg + ticket, no daemon → bg"                 test_ticket_background
run_test "multi-word task → fg (joined prompt)"          test_multiword_task
run_test "leading /skill → fg (verbatim prompt)"         test_leading_slash_skill_verbatim
run_test "ticket + live daemon → reuse"                  test_reuse_when_daemon_alive
run_test "--bg + ticket + live daemon → reuse"           test_reuse_wins_over_bg
run_test "--stop → stop"                                 test_stop
run_test "unknown leading flag → usage error"            test_unknown_flag_errors

echo ""
echo "$PASS/$((PASS + FAIL)) passed"
[ "$FAIL" -eq 0 ] || exit 1
