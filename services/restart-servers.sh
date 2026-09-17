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

readarray -t FRONTEND_NAMES   < <(jq -r '.projects[] | select(.seedScript == null and .devScript != null) | .name'        "$CONFIG")
readarray -t FRONTEND_PORTS   < <(jq -r '.projects[] | select(.seedScript == null and .devScript != null) | .port // empty' "$CONFIG")
readarray -t FRONTEND_PATHS   < <(jq -r '.projects[] | select(.seedScript == null and .devScript != null) | .path // empty' "$CONFIG")
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
# no frontends) has nothing to reconcile — signal ready and stop.
if [ -z "$API_PORT" ] && [ "${#FRONTEND_PORTS[@]}" -eq 0 ]; then
  log "no managed servers — nothing to reconcile"
  emit_ready
  exit 0
fi

# ── Port helpers ───────────────────────────────────────────────────────────────

# Listening check via bash's /dev/tcp — no external tooling required.
port_up() { (echo > "/dev/tcp/127.0.0.1/$1") 2>/dev/null; }

# Kill whatever is bound to a port. fuser (psmisc) then lsof, as retunnel.sh; ss
# is the last fallback since the base worker image ships neither fuser nor lsof.
kill_port() {
  local port="$1" pids=""
  if command -v fuser >/dev/null 2>&1; then
    fuser -k "${port}/tcp" 2>/dev/null || true
    return 0
  fi
  if command -v lsof >/dev/null 2>&1; then
    pids=$(lsof -ti :"$port" 2>/dev/null || true)
  elif command -v ss >/dev/null 2>&1; then
    pids=$(ss -ltnpH "sport = :${port}" 2>/dev/null | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u)
  fi
  [ -n "$pids" ] && kill $pids 2>/dev/null || true
}

wait_port_free() {  # $1 port, $2 max seconds (default 15)
  local port="$1" max="${2:-15}" i
  for i in $(seq 1 "$max"); do port_up "$port" || return 0; sleep 1; done
  return 1
}
wait_port_up() {    # $1 port, $2 max seconds (default 90)
  local port="$1" max="${2:-90}" i
  for i in $(seq 1 "$max"); do port_up "$port" && return 0; sleep 1; done
  return 1
}

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

# ── 2. Kill the existing supervisor ────────────────────────────────────────────
# start-servers.js supervises the API and frontend dev servers, relaunching each
# 2s after it exits. If we kill a port and relaunch under our own loop without
# first killing that supervisor, both loops fight over the same port — a 2s flap.
# Kill it once (as retunnel.sh does) so this script becomes the sole supervisor
# for every port it bounces below. The dev-server children are orphaned briefly;
# we kill each port next and relaunch it ourselves.

log "killing start-servers.js supervisor..."
pkill -f "start-servers.js" 2>/dev/null && log "killed start-servers.js" || log "no start-servers.js supervisor found"
sleep 1

# ── 3. API bounce ──────────────────────────────────────────────────────────────
# An external kill+relaunch (unlike tsx watch's in-place restart) must wait for
# the old process to fully release the port before the new one binds. We own the
# API restart so migrations/deps are picked up deterministically.

if [ -n "$API_PORT" ]; then
  log "bouncing API on :${API_PORT}..."
  kill_port "$API_PORT"
  if ! wait_port_free "$API_PORT" 15; then
    warn "API port :${API_PORT} still bound after 15s — relaunching anyway"
  fi

  if [ -n "$API_DEV_SCRIPT" ]; then
    log "relaunching API: ${API_DEV_SCRIPT}"
    # devScript is an npm script name (e.g. "api:dev"), not a shell command, so
    # it must run via `npm run` — matching start-servers.sh. `sh -c "api:dev"`
    # would fail with "api:dev: not found".
    ( cd "$REPO" && while true; do
        npm run "$API_DEV_SCRIPT" >> /tmp/preview-api.log 2>&1 || true
        echo "[api] exited, restarting in 2s..." >> /tmp/preview-api.log
        sleep 2
      done ) &
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
    # devScript is an npm script name, not a shell command — run via `npm run`.
    ( cd "$REPO" && while true; do
        VITE_API_URL="$API_TUNNEL_URL" npm run "$script" >> "/tmp/preview-${name}.log" 2>&1 || true
        echo "[${name}] exited, restarting in 2s..." >> "/tmp/preview-${name}.log"
        sleep 2
      done ) &
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
