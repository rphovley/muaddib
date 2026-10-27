#!/usr/bin/env bash
# Reconcile the running preview after a /feedback code change.
#
# The feedback cycle (claude-feedback → muaddib-feedback skill) edits code,
# commits, and pushes, but never reconciles the live `servers` job. `tsx watch`
# and Vite HMR hot-reload most in-place edits, but anything outside a watcher's
# scope silently goes stale in the preview: new migrations (migrate:up never
# reruns), package.json/dependency changes (no npm install), non-watched config.
# The orchestrator runs this script after every feedback pass so the preview a
# reviewer looks at actually reflects the fix they asked for.
#
# This is retunnel.sh's proven recovery flow MINUS tunnel recreation (the
# cloudflared/localhost.run tunnels stay open — URL and webhook registration are
# untouched) PLUS an idempotent migrate:up / npm install reconcile PLUS a
# restart_ready / restart_failed event so the orchestrator (and, on failure, a
# human) knows whether the bounced backend actually came back.
#
# Fully manifest-driven (.muaddib/manifest.json), so it needs no per-project
# hook cooperation — identical selectors to retunnel.sh:
#   API project      = the project with a non-null seedScript
#   frontend project = seedScript == null && devScript != null
#
# Contract with the orchestrator: this script ALWAYS emits exactly one terminal
# event on the bus before exiting —
#   servers restart_ready   {}                 on success
#   servers restart_failed  {"ports":[...]}    when a managed port never recovers
# An EXIT trap guarantees this even on an unexpected failure, so the orchestrator
# (which awaits one of these) can never wedge in RECONCILING.
#
# Usage:
#   bash services/restart-servers.sh
#   RESTART_SERVERS_PRINT_CONFIG=1 bash services/restart-servers.sh   # parse-only, for tests

set -euo pipefail

REPO="${REPO_DIR:-/home/worker/repo}"
WORKER="${WORKER_INDEX:-1}"
# Mirror orchestrator/muaddib-root.js: a consuming project nests muaddib under
# REPO/muaddib; muaddib self-hosting has no such nesting. Resolve it the same way
# so EMIT_CLI/NOTIFY point at the real files in both layouts (retunnel.sh
# hardcodes REPO/muaddib and would break self-hosting — don't repeat that here).
if [ -d "$REPO/muaddib" ]; then MUADDIB_ROOT="$REPO/muaddib"; else MUADDIB_ROOT="$REPO"; fi
CONFIG="$REPO/.muaddib/manifest.json"
EMIT_CLI="$MUADDIB_ROOT/orchestrator/emit-cli.js"
NOTIFY="$MUADDIB_ROOT/services/notify.sh"
URLS_FILE="/tmp/preview-urls-${WORKER}.env"

log()  { echo "[restart-servers w${WORKER}] $*" >&2; }
warn() { echo "[restart-servers w${WORKER}] WARNING: $*" >&2; }

# ── Terminal signal (exactly once, guaranteed by the EXIT trap) ────────────────

SIGNALED=0
emit_ready() {
  [ "$SIGNALED" -eq 1 ] && return 0
  SIGNALED=1
  node "$EMIT_CLI" "$WORKER" servers restart_ready '{}' || true
}
emit_failed() {
  # $1: JSON payload (e.g. '{"ports":[9000]}'); $2: human subtitle for notify.
  [ "$SIGNALED" -eq 1 ] && return 0
  SIGNALED=1
  node "$EMIT_CLI" "$WORKER" servers restart_failed "${1:-{\}}" || true
  # Attention tier — cloudflared would otherwise silently proxy to a dead backend.
  bash "$NOTIFY" "$WORKER" "muaddib preview (worker ${WORKER})" "${2:-server restart failed}" alert 2>/dev/null || true
}
on_exit() {
  # A crash (set -e) or early return that never reached a terminal signal would
  # otherwise leave the orchestrator awaiting restart_ready/restart_failed
  # forever. Emit failed as a last resort so RECONCILING always resolves.
  if [ "$SIGNALED" -eq 0 ]; then
    warn "exiting without a terminal signal — emitting restart_failed"
    emit_failed '{"reason":"unexpected_exit"}' "server reconcile crashed unexpectedly"
  fi
}
trap on_exit EXIT

# ── Read project config (identical selectors to retunnel.sh) ───────────────────

if [ ! -f "$CONFIG" ]; then
  warn "no manifest at $CONFIG — nothing to reconcile"
  emit_ready
  exit 0
fi

API_PORT=$(jq -r '.projects[] | select(.seedScript != null) | .port // empty'   "$CONFIG" | head -1)
API_PATH=$(jq -r '.projects[] | select(.seedScript != null) | .path // empty'   "$CONFIG" | head -1)
API_DEV_SCRIPT=$(jq -r '.projects[] | select(.seedScript != null) | .devScript // empty' "$CONFIG" | head -1)

# `// ""`, not `// empty`: a frontend project missing a port or path must still
# occupy a slot, or these arrays shift out of step with FRONTEND_NAMES and every
# later lookup by index reads a different project's value.
readarray -t FRONTEND_NAMES   < <(jq -r '.projects[] | select(.seedScript == null and .devScript != null) | .name'        "$CONFIG")
readarray -t FRONTEND_PORTS   < <(jq -r '.projects[] | select(.seedScript == null and .devScript != null) | .port // ""' "$CONFIG")
readarray -t FRONTEND_PATHS   < <(jq -r '.projects[] | select(.seedScript == null and .devScript != null) | .path // ""' "$CONFIG")
readarray -t FRONTEND_SCRIPTS < <(jq -r '.projects[] | select(.seedScript == null and .devScript != null) | .devScript'   "$CONFIG")

# Parse-only mode for the config unit test — print the selection and stop before
# touching any port, migration, or process.
if [ -n "${RESTART_SERVERS_PRINT_CONFIG:-}" ]; then
  SIGNALED=1  # suppress the EXIT trap's failed-signal in this hermetic mode
  echo "API_PORT=${API_PORT}"
  echo "API_PATH=${API_PATH}"
  echo "API_DEV_SCRIPT=${API_DEV_SCRIPT}"
  echo "FRONTEND_NAMES=${FRONTEND_NAMES[*]:-}"
  echo "FRONTEND_PORTS=${FRONTEND_PORTS[*]:-}"
  echo "FRONTEND_PATHS=${FRONTEND_PATHS[*]:-}"
  echo "FRONTEND_SCRIPTS=${FRONTEND_SCRIPTS[*]:-}"
  exit 0
fi

log "API: port=${API_PORT:-none} path=${API_PATH:-none}"
log "frontends: ${FRONTEND_NAMES[*]:-none}"

# A project with nothing to preview (e.g. muaddib self-hosting: no seedScript,
# no frontends) has nothing to reconcile — signal ready and stop. Count only
# non-empty ports: FRONTEND_PORTS keeps a slot for a port-less frontend to stay
# index-aligned with FRONTEND_NAMES, and such a slot is nothing to bounce.
FRONTEND_PORT_COUNT=0
for p in "${FRONTEND_PORTS[@]:-}"; do [ -n "$p" ] && FRONTEND_PORT_COUNT=$((FRONTEND_PORT_COUNT + 1)); done

if [ -z "$API_PORT" ] && [ "$FRONTEND_PORT_COUNT" -eq 0 ]; then
  log "no managed servers — nothing to reconcile"
  emit_ready
  exit 0
fi

# ── Port helpers ───────────────────────────────────────────────────────────────
# port_up / kill_port / wait_port_free / wait_port_up now live in the shared lib
# so retunnel.sh and the restart-preview skill get the same ss fallback (the
# base worker image ships neither fuser nor lsof). Sourced relative to this
# script so it resolves in both the nested and self-hosting layouts.

# shellcheck source=lib/port-utils.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/port-utils.sh"
# kill_stale_supervisors / supervise_port — shared with retunnel.sh so both
# recovery paths agree on who may relaunch a dev server. Sourced after log/warn
# (messages keep this script's prefix) and after WORKER (names the pidfile).
# shellcheck source=lib/supervisors.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/supervisors.sh"

# ── npm reconcile helper ───────────────────────────────────────────────────────

has_npm_script() {  # $1 project dir (absolute), $2 script name
  local pkg="$1/package.json"
  [ -f "$pkg" ] || return 1
  jq -e --arg s "$2" '(.scripts // {}) | has($s)' "$pkg" >/dev/null 2>&1
}

# Idempotent dependency + migration reconcile for a project directory.
reconcile_project() {  # $1 project dir (absolute)
  local dir="$1"
  [ -f "$dir/package.json" ] || { log "no package.json in ${dir} — skipping reconcile"; return 0; }
  # Pick up package.json / lockfile changes the watchers never react to.
  log "npm install in ${dir}..."
  npm install --prefix "$dir" >>/tmp/restart-reconcile.log 2>&1 || warn "npm install failed in ${dir} (see /tmp/restart-reconcile.log)"
}

# ── 1. Reconcile migrations + dependencies (idempotent) ────────────────────────

FAILED_PORTS=()

if [ -n "$API_PATH" ]; then
  API_DIR="$REPO/$API_PATH"
  reconcile_project "$API_DIR"
  if has_npm_script "$API_DIR" migrate:up; then
    log "running migrate:up in ${API_DIR}..."
    npm run --prefix "$API_DIR" migrate:up >>/tmp/restart-reconcile.log 2>&1 \
      || warn "migrate:up failed in ${API_DIR} (see /tmp/restart-reconcile.log)"
  else
    log "no migrate:up script in ${API_DIR} — skipping"
  fi
fi

for i in "${!FRONTEND_PATHS[@]}"; do
  fpath="${FRONTEND_PATHS[$i]:-}"
  [ -z "$fpath" ] && continue
  reconcile_project "$REPO/$fpath"
done

# ── 2. Kill every existing supervisor ──────────────────────────────────────────
# Anything still supervising these servers relaunches one 2s after we free its
# port, and then two processes fight over it indefinitely. Killing only
# start-servers.js (what this step used to do) left the project's own
# on-servers-start hook alive — that hook is where the restart timers actually
# live, so the "sole supervisor" claim was false and the API port flapped.
# kill_stale_supervisors() covers the hook, both servers jobs, and loops left by
# an earlier run of this script or retunnel.sh. Dev-server children are orphaned
# briefly; we kill each port next and relaunch it ourselves.

log "killing stale dev-server supervisors..."
kill_stale_supervisors

# ── 3. API bounce ──────────────────────────────────────────────────────────────
# An external kill+relaunch (unlike tsx watch's in-place restart) must wait for
# the old process to fully release the port before the new one binds. We own the
# API restart so migrations/deps are picked up deterministically.

if [ -n "$API_PORT" ]; then
  log "bouncing API on :${API_PORT}..."
  kill_port "$API_PORT"
  if ! wait_port_free "$API_PORT" 15; then
    # supervise_port adopts whatever holds the port rather than fighting it, so
    # the practical outcome is "not actually bounced": the API keeps running on
    # pre-reconcile code. Say that, instead of the old "relaunching anyway" —
    # which described a relaunch that could only ever lose with EADDRINUSE.
    warn "API port :${API_PORT} still bound after 15s — adopting the existing process; migrations/deps from this pass may not be live"
  fi

  if [ -n "$API_DEV_SCRIPT" ]; then
    log "relaunching API: ${API_DEV_SCRIPT}"
    # devScript is a SHELL COMMAND ("npm run api:dev"), which is how the
    # project's on-servers-start hook runs it. This step used to run it as
    # `npm run "$API_DEV_SCRIPT"`, i.e. `npm run "npm run api:dev"` — a
    # "Missing script" error on every 2s iteration, so the port never came
    # back and every reconcile ended in restart_failed.
    supervise_port api "$API_PORT" "$API_DEV_SCRIPT" /tmp/preview-api.log
  else
    warn "no devScript for the API project — cannot relaunch"
  fi

  if wait_port_up "$API_PORT" 90; then
    log "API ready on :${API_PORT}"
  else
    warn "API never came back on :${API_PORT} after 90s"
    FAILED_PORTS+=("$API_PORT")
  fi
fi

# ── 4. Frontend bounce ─────────────────────────────────────────────────────────
# We killed the shared supervisor above, so nothing else will bring the frontends
# back — this script relaunches each one under its own loop, mirroring the API
# path. VITE_API_URL is unchanged (we reuse the open API tunnel), so the
# relaunched process inherits the same URL — we do NOT recreate tunnels and never
# touch the webhook tunnel on :9090. The API tunnel URL was written to URLS_FILE
# by start-servers.sh at boot; reuse it so the frontend keeps talking to the API.

API_TUNNEL_URL=""
if [ -f "$URLS_FILE" ]; then
  # shellcheck disable=SC1090
  . "$URLS_FILE" 2>/dev/null || true
fi

for i in "${!FRONTEND_NAMES[@]}"; do
  name="${FRONTEND_NAMES[$i]}"
  port="${FRONTEND_PORTS[$i]:-}"
  script="${FRONTEND_SCRIPTS[$i]:-}"
  [ -z "$port" ] && continue
  log "bouncing frontend ${name} on :${port}..."
  kill_port "$port"
  if [ -n "$script" ]; then
    log "relaunching frontend ${name}: ${script}"
    # devScript is a shell command — see the API relaunch above.
    supervise_port "$name" "$port" "$script" "/tmp/preview-${name}.log" \
      "VITE_API_URL=${API_TUNNEL_URL}"
  else
    warn "no devScript for frontend ${name} — cannot relaunch"
  fi
done

for i in "${!FRONTEND_NAMES[@]}"; do
  name="${FRONTEND_NAMES[$i]}"
  port="${FRONTEND_PORTS[$i]:-}"
  [ -z "$port" ] && continue
  if wait_port_up "$port" 60; then
    log "frontend ${name} ready on :${port}"
  else
    warn "frontend ${name} never came back on :${port} after 60s"
    FAILED_PORTS+=("$port")
  fi
done

# ── 5. Terminal signal ─────────────────────────────────────────────────────────

if [ "${#FAILED_PORTS[@]}" -gt 0 ]; then
  PORTS_JSON=$(printf '%s\n' "${FAILED_PORTS[@]}" | jq -R 'tonumber? // .' | jq -sc '{ports: .}')
  warn "restart_failed — ports never recovered: ${FAILED_PORTS[*]}"
  emit_failed "$PORTS_JSON" "server restart failed — ports ${FAILED_PORTS[*]} did not recover"
  exit 1
fi

log "restart_ready — all managed ports listening"
emit_ready
exit 0
