#!/usr/bin/env bash
# Test suite for the lavish-axi sketch-review bind fix (muaddib#156).
#
# Background: lavish-axi refuses to bind a wildcard address (0.0.0.0) and
# silently downgrades it to 127.0.0.1, which Docker's `${WORKER_SKETCH_PORT}:4387`
# publish can't reach through the container's network namespace — the operator
# got ERR_CONNECTION_RESET. The fix binds lavish to the container's own routable
# IP in worker-entrypoint.sh (a specific, non-wildcard address lavish accepts and
# exactly what the port publish forwards to), and removes the ineffective
# `LAVISH_AXI_HOST: "0.0.0.0"` from docker-compose.worker.yml.
#
# Covers:
#   - worker-entrypoint.sh resolves LAVISH_AXI_HOST to a routable IPv4 (via
#     `ip route get`, falling back to `hostname -I`) and exports it before the
#     task/interactive branch (so orchestrator/job/claude/lavish all inherit it)
#   - the REAL resolution+guard block (extracted from the entrypoint and run
#     under stubbed `ip`/`hostname`) picks a routable IPv4 for good inputs AND
#     fails loud for the empty / loopback / IPv6-first regressions
#   - docker-compose.worker.yml no longer sets LAVISH_AXI_HOST at all (and in
#     particular not 0.0.0.0), while keeping the ${WORKER_SKETCH_PORT}:4387 publish
#   - spawn-worker.sh's operator-facing sketch URL stays localhost-based, matching
#     the sketch skill's WORKER_SKETCH_PORT URL
#
# Self-contained — no docker daemon, no worker container, no lavish install.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

ENTRYPOINT="$REPO_ROOT/worker-entrypoint.sh"
COMPOSE="$REPO_ROOT/docker-compose.worker.yml"
SPAWN="$REPO_ROOT/bin/spawn-worker.sh"
SKETCH_SKILL="$REPO_ROOT/claude/skills/sketch/SKILL.md"

PASS=0; FAIL=0

run_test() {
  local name="$1" fn="$2" tmp log
  tmp=$(mktemp -d); log="$tmp/test.log"
  if "$fn" "$tmp" >"$log" 2>&1; then
    echo "  $name... PASS"; PASS=$((PASS + 1))
  else
    echo "  $name... FAIL"; sed 's/^/    /' "$log"; FAIL=$((FAIL + 1))
  fi
  rm -rf "$tmp"
}

# ─── worker-entrypoint.sh ──────────────────────────────────────────────────────

test_entrypoint_resolves_routable_host() {
  # The entrypoint must prefer `ip route get` (the source IPv4 the kernel uses to
  # leave the container) and must NOT resolve via the unreliable `hostname -i`.
  grep -Eq 'ip[[:space:]]+-4[[:space:]]+route[[:space:]]+get' "$ENTRYPOINT" \
    || { echo "worker-entrypoint.sh should resolve LAVISH_AXI_HOST via \`ip route get\`"; return 1; }
  ! grep -Eq 'LAVISH_AXI_HOST=.*hostname[[:space:]]+-i\b' "$ENTRYPOINT" \
    || { echo "worker-entrypoint.sh must not resolve LAVISH_AXI_HOST from \`hostname -i\` (unreliable)"; return 1; }
}

test_entrypoint_guards_bad_host() {
  # A fail-loud guard must reject an empty / loopback / IPv6 result instead of
  # exporting it (per commit 3c00882 convention).
  grep -Eq 'case[[:space:]]+"\$LAVISH_AXI_HOST"' "$ENTRYPOINT" \
    && grep -Eq '127\.\*' "$ENTRYPOINT" \
    || { echo "worker-entrypoint.sh should guard LAVISH_AXI_HOST against empty/loopback/IPv6"; return 1; }
}

test_entrypoint_exports_before_task_branch() {
  # The export must land before the `if [ -n "${TASK:-}" ]` branch so every
  # descendant (orchestrator/job/claude/lavish) inherits it in BOTH task and
  # interactive modes.
  local export_line branch_line
  export_line=$(grep -nE 'export[[:space:]]+LAVISH_AXI_HOST\b' "$ENTRYPOINT" | head -1 | cut -d: -f1)
  branch_line=$(grep -nE 'if \[ -n "\$\{TASK:-\}" \]' "$ENTRYPOINT" | head -1 | cut -d: -f1)
  [ -n "$export_line" ] || { echo "no LAVISH_AXI_HOST export found"; return 1; }
  [ -n "$branch_line" ] || { echo "could not find the TASK branch marker"; return 1; }
  [ "$export_line" -lt "$branch_line" ] \
    || { echo "export (line $export_line) must precede the TASK branch (line $branch_line)"; return 1; }
}

# Pull the ACTUAL resolution+guard block out of the entrypoint so the tests below
# exercise the real code (including its fail-loud guard) rather than a re-typed
# copy that can drift.
extract_resolve_block() {
  awk '/^# --- resolve lavish bind host/{f=1} f; /^# --- end resolve lavish bind host/{f=0}' "$ENTRYPOINT"
}

# $1=tmp dir; $2=`ip -4 route get 1` src IPv4 (empty => ip prints nothing);
# $3=`hostname -I` output. Stubs both tools, runs the extracted block under
# `set -euo pipefail`, and on success prints "RESULT=<resolved host>". Returns
# the block's exit status (non-zero when the guard aborts).
run_resolve_block() {
  local tmp="$1" ip_src="$2" hostname_i="$3"
  mkdir -p "$tmp/bin"
  cat > "$tmp/bin/ip" <<EOF
#!/usr/bin/env bash
if [ "\$*" = "-4 route get 1" ]; then
  ${ip_src:+echo "1.0.0.0 via 172.31.0.1 dev eth0 src $ip_src uid 1000"}
  exit 0
fi
exit 0
EOF
  cat > "$tmp/bin/hostname" <<EOF
#!/usr/bin/env bash
case "\${1:-}" in
  -I|-i) echo "$hostname_i" ;;
esac
exit 0
EOF
  chmod +x "$tmp/bin/ip" "$tmp/bin/hostname"
  PATH="$tmp/bin:$PATH" bash -c "set -euo pipefail
$(extract_resolve_block)
printf 'RESULT=%s' \"\$LAVISH_AXI_HOST\""
}

test_resolve_prefers_ip_route() {
  local tmp="$1" out
  # ip route wins; the (different) hostname -I value must be ignored.
  out=$(run_resolve_block "$tmp" "172.31.0.2" "10.9.9.9" 2>&1) \
    || { echo "block failed unexpectedly: $out"; return 1; }
  echo "$out" | grep -q 'RESULT=172.31.0.2' \
    || { echo "expected RESULT=172.31.0.2, got: $out"; return 1; }
}

test_resolve_falls_back_to_hostname_I() {
  local tmp="$1" out
  # No ip route src; fall back to the first routable IPv4 from `hostname -I`.
  out=$(run_resolve_block "$tmp" "" "172.31.0.5 fe80::42:acff:fe1f:5" 2>&1) \
    || { echo "block failed unexpectedly: $out"; return 1; }
  echo "$out" | grep -q 'RESULT=172.31.0.5' \
    || { echo "expected RESULT=172.31.0.5, got: $out"; return 1; }
}

test_resolve_rejects_loopback() {
  local tmp="$1"
  # A loopback src (e.g. hostname -i style 127.0.1.1) must be rejected, not bound.
  if run_resolve_block "$tmp" "127.0.1.1" "" >/dev/null 2>&1; then
    echo "guard should have rejected loopback 127.0.1.1"; return 1
  fi
}

test_resolve_rejects_ipv6_only() {
  local tmp="$1"
  # IPv6-first with no IPv4 anywhere must fail loud, not bind an IPv6 address.
  if run_resolve_block "$tmp" "" "fe80::42:acff:fe1f:2" >/dev/null 2>&1; then
    echo "guard should have rejected an IPv6-only resolution"; return 1
  fi
}

test_resolve_rejects_empty() {
  local tmp="$1"
  # Nothing resolvable at all → fail loud rather than export an empty value.
  if run_resolve_block "$tmp" "" "" >/dev/null 2>&1; then
    echo "guard should have rejected an empty resolution"; return 1
  fi
}

# ─── docker-compose.worker.yml ─────────────────────────────────────────────────

test_compose_no_lavish_host() {
  # The compose must not set LAVISH_AXI_HOST at all — the entrypoint owns it now.
  # (A wildcard 0.0.0.0 here was the original bug.)
  ! grep -Eq '^[[:space:]]*LAVISH_AXI_HOST[[:space:]]*:' "$COMPOSE" \
    || { echo "docker-compose.worker.yml must not set LAVISH_AXI_HOST (entrypoint owns it)"; return 1; }
}

test_compose_keeps_sketch_publish() {
  # The port publish that forwards to lavish's 4387 must remain.
  grep -Eq 'WORKER_SKETCH_PORT[^:]*:[^:]*:4387' "$COMPOSE" \
    || { echo "docker-compose.worker.yml lost the \${WORKER_SKETCH_PORT}:4387 publish"; return 1; }
}

# ─── consistency: operator-facing URL stays localhost-based ─────────────────────

test_spawn_url_localhost() {
  grep -Eq 'http://localhost:\$\{SKETCH_PORT\}' "$SPAWN" \
    || { echo "spawn-worker.sh should advertise http://localhost:\${SKETCH_PORT}"; return 1; }
}

test_sketch_skill_url_localhost() {
  grep -Eq 'http://localhost:\$\{WORKER_SKETCH_PORT' "$SKETCH_SKILL" \
    || { echo "sketch SKILL.md should build http://localhost:\${WORKER_SKETCH_PORT}..."; return 1; }
}

# ─── run ───────────────────────────────────────────────────────────────────────

cd "$REPO_ROOT"

run_test "entrypoint: resolves via ip route (not hostname -i)"   test_entrypoint_resolves_routable_host
run_test "entrypoint: guards empty/loopback/IPv6 result"         test_entrypoint_guards_bad_host
run_test "entrypoint: export precedes the TASK branch"           test_entrypoint_exports_before_task_branch
run_test "resolve: prefers ip route get src"                     test_resolve_prefers_ip_route
run_test "resolve: falls back to first IPv4 of hostname -I"      test_resolve_falls_back_to_hostname_I
run_test "resolve: rejects loopback (fails loud)"                test_resolve_rejects_loopback
run_test "resolve: rejects IPv6-only (fails loud)"               test_resolve_rejects_ipv6_only
run_test "resolve: rejects empty (fails loud)"                   test_resolve_rejects_empty
run_test "compose: no LAVISH_AXI_HOST override (no 0.0.0.0)"      test_compose_no_lavish_host
run_test "compose: keeps \${WORKER_SKETCH_PORT}:4387 publish"    test_compose_keeps_sketch_publish
run_test "consistency: spawn-worker advertises localhost URL"    test_spawn_url_localhost
run_test "consistency: sketch skill builds localhost URL"        test_sketch_skill_url_localhost

echo ""
echo "$PASS/$((PASS + FAIL)) passed"
[ "$FAIL" -eq 0 ] || exit 1
