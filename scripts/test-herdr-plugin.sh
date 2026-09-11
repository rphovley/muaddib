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
#   - the target checkout is resolved at run time: herdr pane CWD → registry
#     picker → the checkout the plugin is linked inside (multi-project support)
# Plus a couple of static checks on the manifest. Self-contained — no container.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
WRAPPER="$REPO_ROOT/herdr-plugin/dispatch-action.sh"
MANIFEST="$REPO_ROOT/herdr-plugin/herdr-plugin.toml"
REGISTER="$REPO_ROOT/bin/herdr-register.sh"

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

# Write stub entry scripts (muaddib/-plan/-fast) into checkout dir $1. Each echoes
# how it was called *and the checkout it lives in*, so a test can tell which of
# several registered checkouts a dispatch actually landed in.
make_entries() {
  local root="$1" m
  mkdir -p "$root"
  for m in muaddib muaddib-plan muaddib-fast; do
    cat >"$root/$m.sh" <<EOF
#!/usr/bin/env bash
echo "DISPATCH $m $root \$*"
EOF
    chmod +x "$root/$m.sh"
  done
}

# Build a fake muaddib checkout in $1: a copy of the real wrapper under
# herdr-plugin/ (so its "../" legacy root resolution points at this checkout)
# plus stub entry scripts. The wrapper is at $1/herdr-plugin/dispatch-action.sh.
make_fixture() {
  local root="$1"
  make_entries "$root"
  mkdir -p "$root/herdr-plugin"
  cp "$WRAPPER" "$root/herdr-plugin/dispatch-action.sh"
  chmod +x "$root/herdr-plugin/dispatch-action.sh"
}

# Install just the wrapper (no sibling entry scripts) at $1 — models a plugin
# linked from a neutral location, NOT from inside a checkout, so legacy "../"
# resolution finds nothing and the pane-CWD / registry paths take over.
make_neutral_plugin() {
  local dir="$1"
  mkdir -p "$dir"
  cp "$WRAPPER" "$dir/dispatch-action.sh"
  chmod +x "$dir/dispatch-action.sh"
}

# A stub `herdr` that records its argv (one per line) to $HERDR_LOG. Placed
# first on PATH so the wrapper's `command -v herdr` finds it.
make_stub_herdr() {
  local bindir="$1"
  mkdir -p "$bindir"
  cat >"$bindir/herdr" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$@" >>"$HERDR_LOG"
EOF
  chmod +x "$bindir/herdr"
}

# Run the fixture wrapper for legacy (inside-checkout) resolution, feeding
# $ticket on stdin. Isolate resolution from the *developer's* real environment:
# point the registry at a nonexistent file and clear the pane-CWD / override
# vars, so resolution deterministically falls through to the plugin's own
# checkout ("../"). Caller-provided PATH / HERDR_LOG are preserved by `env`.
run_wrapper() {
  local root="$1" mode="$2" ticket="$3"
  printf '%s\n' "$ticket" | \
    env MUADDIB_HERDR_REGISTRY="$root/no-such-registry" \
        HERDR_PANE_CWD='' HERDR_CWD='' MUADDIB_DIR='' \
        bash "$root/herdr-plugin/dispatch-action.sh" "$mode"
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
  # Minimal PATH with no herdr; /usr/bin:/bin cover env/bash/dirname/etc.
  out=$(PATH="/usr/bin:/bin" run_wrapper "$tmp" "plan" "QUO-42")
  echo "$out" | grep -q "DISPATCH muaddib-plan $tmp QUO-42" || {
    echo "expected direct dispatch of muaddib-plan with QUO-42; got:"; echo "$out"; return 1; }
}

# Surrounding whitespace on the entered ticket is trimmed before dispatch.
test_ticket_whitespace_trimmed() {
  local tmp="$1"
  make_fixture "$tmp"
  local out
  out=$(PATH="/usr/bin:/bin" run_wrapper "$tmp" "default" "   QUO-7   ")
  # default mode inserts a literal '--' guard before the argument (so hyphen-
  # leading task text isn't parsed as a muaddib.sh flag), hence '... -- QUO-7'.
  echo "$out" | grep -q "DISPATCH muaddib $tmp -- QUO-7$" || {
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
  out=$(printf 'QUO-1\n' | env MUADDIB_HERDR_REGISTRY="$tmp/none" \
          HERDR_PANE_CWD='' HERDR_CWD='' MUADDIB_DIR='' \
          bash "$tmp/herdr-plugin/dispatch-action.sh" "bogus" 2>&1); rc=$?
  [ "$rc" -eq 2 ] || { echo "expected exit 2 for unknown mode, got $rc"; return 1; }
  echo "$out" | grep -qi "unknown mode" || { echo "expected 'unknown mode' message; got:"; echo "$out"; return 1; }
}

# herdr pane CWD wins: a plugin linked from a neutral dir (no sibling checkout)
# still dispatches into the checkout enclosing the pane it was invoked from,
# even from a deep subdirectory.
test_pane_cwd_resolution() {
  local tmp="$1"
  make_neutral_plugin "$tmp/plugin"
  make_entries "$tmp/projA"
  mkdir -p "$tmp/projA/deep/sub"
  local out
  out=$(printf 'QUO-3\n' | env MUADDIB_HERDR_REGISTRY="$tmp/none" \
          HERDR_PANE_CWD="$tmp/projA/deep/sub" HERDR_CWD='' MUADDIB_DIR='' \
          PATH="/usr/bin:/bin" bash "$tmp/plugin/dispatch-action.sh" default)
  echo "$out" | grep -q "DISPATCH muaddib $tmp/projA -- QUO-3$" || {
    echo "expected pane-CWD to resolve the enclosing checkout projA; got:"; echo "$out"; return 1; }
}

# A registry with exactly one entry resolves it silently (no picker prompt),
# even when the plugin is linked from a neutral dir.
test_registry_single_entry() {
  local tmp="$1"
  make_neutral_plugin "$tmp/plugin"
  make_entries "$tmp/projA"
  local reg="$tmp/registry"
  printf '# my projects\nprojA   %s\n' "$tmp/projA" > "$reg"
  local out
  out=$(printf 'QUO-8\n' | env MUADDIB_HERDR_REGISTRY="$reg" \
          HERDR_PANE_CWD='' HERDR_CWD='' MUADDIB_DIR='' \
          PATH="/usr/bin:/bin" bash "$tmp/plugin/dispatch-action.sh" plan)
  echo "$out" | grep -q "DISPATCH muaddib-plan $tmp/projA QUO-8$" || {
    echo "expected single registry entry projA (no prompt); got:"; echo "$out"; return 1; }
}

# A registry with several entries prompts a picker; selecting by number and by
# shortname both resolve the right checkout.
test_registry_prompt_selects() {
  local tmp="$1"
  make_neutral_plugin "$tmp/plugin"
  make_entries "$tmp/projA"
  make_entries "$tmp/projB"
  local reg="$tmp/registry"
  printf 'projA %s\nprojB %s\n' "$tmp/projA" "$tmp/projB" > "$reg"

  local out
  # By number: '2' → projB (second entry). First stdin line is the pick.
  out=$(printf '2\nQUO-11\n' | env MUADDIB_HERDR_REGISTRY="$reg" \
          HERDR_PANE_CWD='' HERDR_CWD='' MUADDIB_DIR='' \
          PATH="/usr/bin:/bin" bash "$tmp/plugin/dispatch-action.sh" default 2>/dev/null)
  echo "$out" | grep -q "DISPATCH muaddib $tmp/projB -- QUO-11$" || {
    echo "expected numeric pick '2' → projB; got:"; echo "$out"; return 1; }

  # By name: 'projA' → projA.
  out=$(printf 'projA\nQUO-12\n' | env MUADDIB_HERDR_REGISTRY="$reg" \
          HERDR_PANE_CWD='' HERDR_CWD='' MUADDIB_DIR='' \
          PATH="/usr/bin:/bin" bash "$tmp/plugin/dispatch-action.sh" default 2>/dev/null)
  echo "$out" | grep -q "DISPATCH muaddib $tmp/projA -- QUO-12$" || {
    echo "expected name pick 'projA' → projA; got:"; echo "$out"; return 1; }
}

# When nothing resolves — neutral plugin, no pane CWD, no registry — the wrapper
# aborts with guidance and never dispatches.
test_unresolvable_errors() {
  local tmp="$1"
  make_neutral_plugin "$tmp/plugin"
  local out rc
  out=$(printf 'QUO-1\n' | env MUADDIB_HERDR_REGISTRY="$tmp/none" \
          HERDR_PANE_CWD='' HERDR_CWD='' MUADDIB_DIR='' \
          PATH="/usr/bin:/bin" bash "$tmp/plugin/dispatch-action.sh" default 2>&1); rc=$?
  [ "$rc" -ne 0 ] || { echo "expected non-zero exit when no checkout resolvable, got 0"; return 1; }
  echo "$out" | grep -qi "couldn't determine which muaddib checkout" || {
    echo "expected resolution-guidance message; got:"; echo "$out"; return 1; }
  echo "$out" | grep -q "DISPATCH" && { echo "must not dispatch when unresolvable"; return 1; }
  return 0
}

# An explicit MUADDIB_DIR override beats every other resolution path.
test_explicit_override_wins() {
  local tmp="$1"
  make_neutral_plugin "$tmp/plugin"
  make_entries "$tmp/projA"           # override target
  make_entries "$tmp/projB"           # a registry decoy that must NOT win
  local reg="$tmp/registry"
  printf 'projB %s\n' "$tmp/projB" > "$reg"
  local out
  out=$(printf 'QUO-4\n' | env MUADDIB_HERDR_REGISTRY="$reg" \
          HERDR_PANE_CWD='' HERDR_CWD='' MUADDIB_DIR="$tmp/projA" \
          PATH="/usr/bin:/bin" bash "$tmp/plugin/dispatch-action.sh" fast)
  echo "$out" | grep -q "DISPATCH muaddib-fast $tmp/projA QUO-4$" || {
    echo "expected MUADDIB_DIR override → projA; got:"; echo "$out"; return 1; }
}

# bin/herdr-register.sh writes a fresh entry into a new registry file.
test_register_adds_entry() {
  local tmp="$1"
  make_entries "$tmp/projA"
  local reg="$tmp/registry"
  MUADDIB_HERDR_REGISTRY="$reg" bash "$REGISTER" projA "$tmp/projA" >/dev/null || {
    echo "register exited non-zero"; return 1; }
  [ "$(awk '$1=="projA"{print $2}' "$reg")" = "$tmp/projA" ] || {
    echo "projA not registered at $tmp/projA:"; cat "$reg"; return 1; }
}

# Re-registering a shortname updates that one entry in place (no duplicate) and
# leaves other entries and comments untouched.
test_register_updates_and_preserves() {
  local tmp="$1"
  make_entries "$tmp/projA"; make_entries "$tmp/projA2"; make_entries "$tmp/projB"
  local reg="$tmp/registry"
  printf '# my projects\nprojB\t%s\n' "$tmp/projB" > "$reg"
  MUADDIB_HERDR_REGISTRY="$reg" bash "$REGISTER" projA "$tmp/projA"  >/dev/null
  MUADDIB_HERDR_REGISTRY="$reg" bash "$REGISTER" projA "$tmp/projA2" >/dev/null  # update
  [ "$(awk '$1=="projA"' "$reg" | wc -l | tr -d ' ')" = "1" ] || {
    echo "projA duplicated instead of updated:"; cat "$reg"; return 1; }
  [ "$(awk '$1=="projA"{print $2}' "$reg")" = "$tmp/projA2" ] || {
    echo "projA not updated to projA2:"; cat "$reg"; return 1; }
  [ "$(awk '$1=="projB"{print $2}' "$reg")" = "$tmp/projB" ] || {
    echo "projB entry was lost:"; cat "$reg"; return 1; }
  grep -qx "# my projects" "$reg" || { echo "comment line lost:"; cat "$reg"; return 1; }
}

# A dir that isn't a muaddib checkout (no muaddib.sh) is rejected, and nothing is
# written to the registry.
test_register_rejects_non_checkout() {
  local tmp="$1"
  mkdir -p "$tmp/notcheckout"
  local reg="$tmp/registry" rc
  MUADDIB_HERDR_REGISTRY="$reg" bash "$REGISTER" bad "$tmp/notcheckout" >/dev/null 2>&1; rc=$?
  [ "$rc" -ne 0 ] || { echo "expected non-zero for non-checkout dir"; return 1; }
  [ -s "$reg" ] && { echo "registry must not gain an entry on rejection:"; cat "$reg"; return 1; }
  return 0
}

# With no dir argument, the checkout defaults to the one the helper is invoked
# from (bin/..), so `./bin/herdr-register.sh name` works from inside a checkout.
test_register_defaults_to_own_checkout() {
  local tmp="$1"
  make_entries "$tmp"                    # $tmp is now a checkout (has muaddib.sh)
  mkdir -p "$tmp/bin"
  cp "$REGISTER" "$tmp/bin/herdr-register.sh"; chmod +x "$tmp/bin/herdr-register.sh"
  local reg="$tmp/registry"
  MUADDIB_HERDR_REGISTRY="$reg" bash "$tmp/bin/herdr-register.sh" selfproj >/dev/null || {
    echo "register exited non-zero"; return 1; }
  [ "$(awk '$1=="selfproj"{print $2}' "$reg")" = "$tmp" ] || {
    echo "expected default checkout $tmp:"; cat "$reg"; return 1; }
}

# A registry populated by the helper is consumed correctly by the dispatch
# wrapper — the round trip the two scripts are meant to share.
test_register_roundtrips_into_dispatch() {
  local tmp="$1"
  make_neutral_plugin "$tmp/plugin"
  make_entries "$tmp/projA"
  local reg="$tmp/registry"
  MUADDIB_HERDR_REGISTRY="$reg" bash "$REGISTER" projA "$tmp/projA" >/dev/null
  local out
  out=$(printf 'QUO-77\n' | env MUADDIB_HERDR_REGISTRY="$reg" \
          HERDR_PANE_CWD='' HERDR_CWD='' MUADDIB_DIR='' \
          PATH="/usr/bin:/bin" bash "$tmp/plugin/dispatch-action.sh" plan)
  echo "$out" | grep -q "DISPATCH muaddib-plan $tmp/projA QUO-77$" || {
    echo "registered entry didn't drive a dispatch; got:"; echo "$out"; return 1; }
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
run_test "pane CWD resolves enclosing checkout" test_pane_cwd_resolution
run_test "registry single entry (no prompt)" test_registry_single_entry
run_test "registry picker selects by number and name" test_registry_prompt_selects
run_test "unresolvable checkout errors with guidance" test_unresolvable_errors
run_test "explicit MUADDIB_DIR override wins" test_explicit_override_wins
run_test "register adds a new entry" test_register_adds_entry
run_test "register updates in place, preserves others" test_register_updates_and_preserves
run_test "register rejects a non-checkout dir" test_register_rejects_non_checkout
run_test "register defaults to its own checkout" test_register_defaults_to_own_checkout
run_test "register → dispatch round trip" test_register_roundtrips_into_dispatch
run_test "manifest declares all actions" test_manifest_declares_actions
run_test "wrapper is executable" test_wrapper_executable

echo ""
echo "herdr-plugin: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
