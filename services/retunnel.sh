#!/usr/bin/env bash
# Manual recovery tool: kill dead tunnels, open fresh ones, and restart
# frontend dev servers with the updated VITE_API_URL.
#
# Run this inside the worker container when tunnels go dead:
#   bash /home/worker/repo/muaddib/services/retunnel.sh
#
# From the host:
#   docker exec -it <container-name> bash /home/worker/repo/muaddib/services/retunnel.sh
#
# What it does:
#   1. Kills cloudflared and localhost.run SSH tunnel processes
#   2. Opens a new API tunnel (cloudflared → localhost.run fallback)
#   3. Kills the existing Vite dev-server restart wrappers in start-servers.js
#      so the old VITE_API_URL can't be re-injected
#   4. Restarts frontend dev servers with the new VITE_API_URL
#   5. Opens new frontend tunnels
#   6. Updates /tmp/preview-urls-${WORKER_INDEX}.env and worker state
#   7. Prints the new URLs

set -euo pipefail

REPO="${REPO_DIR:-/home/worker/repo}"
WORKER="${WORKER_INDEX:-1}"
CONFIG="$REPO/.muaddib/manifest.json"
STATE_CLI="$REPO/muaddib/orchestrator/state-cli.js"
EMIT_CLI="$REPO/muaddib/orchestrator/emit-cli.js"

# NOTE: log/warn MUST write to stderr. open_tunnel() returns its URL on stdout
# via command substitution ($(open_tunnel ...)); anything these helpers print to
# stdout would be captured into the URL and corrupt it.
log()  { echo "[retunnel w${WORKER}] $*" >&2; }
warn() { echo "[retunnel w${WORKER}] WARNING: $*" >&2; }

CF_URL_RE='https://[a-zA-Z0-9-]+\.trycloudflare\.com'
LR_URL_RE='https://[a-zA-Z0-9-]+\.lhr\.[a-z]+'

# ── Read project config ────────────────────────────────────────────────────────

API_PORT=$(jq -r '.projects[] | select(.seedScript != null) | .port' "$CONFIG" | head -1)
API_DEV_SCRIPT=$(jq -r '.projects[] | select(.seedScript != null) | .devScript' "$CONFIG" | head -1)

readarray -t FRONTEND_NAMES  < <(jq -r '.projects[] | select(.seedScript == null and .devScript != null) | .name' "$CONFIG")
readarray -t FRONTEND_PORTS  < <(jq -r '.projects[] | select(.seedScript == null and .devScript != null) | .port // empty' "$CONFIG")
readarray -t FRONTEND_SCRIPTS< <(jq -r '.projects[] | select(.seedScript == null and .devScript != null) | .devScript' "$CONFIG")

log "API port: ${API_PORT}"
log "frontend projects: ${FRONTEND_NAMES[*]:-none}"

# ── 1. Kill existing tunnel processes ─────────────────────────────────────────
# Only kill tunnels for the ports WE manage (API + frontends). A blanket
# `pkill -f "cloudflared tunnel"` also kills the webhook receiver's tunnel on
# :9090 (owned by watch-feedback.js), which silently breaks /feedback delivery
# until the container is rebuilt. Scope the kill to our managed ports instead.

MANAGED_PORTS=("$API_PORT" "${FRONTEND_PORTS[@]:-}")
for port in "${MANAGED_PORTS[@]}"; do
  [ -z "$port" ] && continue
  log "killing tunnels for :${port}..."
  pkill -f "cloudflared tunnel --url http://localhost:${port}" 2>/dev/null \
    && log "killed cloudflared for :${port}" || log "no cloudflared for :${port}"
  # localhost.run fallback uses an SSH remote-forward "80:localhost:<port>"
  pkill -f "80:localhost:${port}" 2>/dev/null \
    && log "killed localhost.run SSH for :${port}" || true
done

sleep 1

# ── 2. Kill start-servers.js restart wrappers ─────────────────────────────────
# The wrappers have VITE_API_URL baked into their closure. Kill the node
# process so it can't relaunch Vite with the stale URL. The API dev server
# and Vite processes themselves become orphans and keep running briefly —
# we'll kill the Vite ones next, and leave the API server running.

log "killing start-servers.js wrapper process..."
pkill -f "start-servers.js" 2>/dev/null && log "killed start-servers.js" || log "no start-servers.js process found"

sleep 1

# ── 3. Kill frontend dev servers on their ports ───────────────────────────────
# fuser -k kills whatever is bound to the port. On Alpine/Debian containers
# fuser comes from psmisc. Fallback: lsof.

for port in "${FRONTEND_PORTS[@]:-}"; do
  [ -z "$port" ] && continue
  log "killing process on port ${port}..."
  if command -v fuser >/dev/null 2>&1; then
    fuser -k "${port}/tcp" 2>/dev/null || true
  else
    local_pid=$(lsof -ti :"$port" 2>/dev/null || true)
    [ -n "$local_pid" ] && kill "$local_pid" 2>/dev/null || true
  fi
done

sleep 1

# ── 3b. Ensure the API dev server is running ──────────────────────────────────
# Step 2 killed start-servers.js, which was supervising the API dev server.
# If the API origin is down, a freshly opened tunnel just returns HTTP 502.
# Restart it under a self-healing loop when it's not listening; leave a healthy
# one alone (a cold `tsx watch` restart costs ~a minute of API downtime).

port_up() { (echo > "/dev/tcp/localhost/$1") 2>/dev/null; }

if port_up "$API_PORT"; then
  log "API already listening on :${API_PORT} — leaving it running"
else
  log "API not listening on :${API_PORT} — starting: ${API_DEV_SCRIPT}"
  ( while true; do
      sh -c "$API_DEV_SCRIPT" >> /tmp/preview-api.log 2>&1
      echo "[api] exited, restarting in 2s..." >> /tmp/preview-api.log
      sleep 2
    done ) &
  for i in $(seq 1 90); do
    port_up "$API_PORT" && { log "API ready on :${API_PORT}"; break; }
    sleep 1
  done
  port_up "$API_PORT" || warn "API still not listening on :${API_PORT} after 90s — tunnel will 502"
fi

# ── 4. Open new API tunnel ────────────────────────────────────────────────────

open_tunnel() {
  local port="$1" cf_log="$2" lr_log="$3"

  # Try cloudflared first.
  log ":${port} trying cloudflared..."
  truncate -s 0 "$cf_log"
  cloudflared tunnel --url "http://localhost:${port}" --no-autoupdate --protocol http2 \
    > "$cf_log" 2>&1 &
  CF_PID=$!

  local cf_url=""
  for i in $(seq 1 30); do
    cf_url=$(grep -oE "$CF_URL_RE" "$cf_log" 2>/dev/null | head -1 || true)
    [ -n "$cf_url" ] && break
    if grep -qiE '429|error code: 1015|failed to unmarshal|failed to request' "$cf_log" 2>/dev/null; then
      log ":${port} cloudflared rate-limited or failed — switching to localhost.run"
      kill "$CF_PID" 2>/dev/null || true
      break
    fi
    sleep 1
  done

  if [ -n "$cf_url" ]; then
    log ":${port} → ${cf_url} (cloudflared)"
    printf '%s' "$cf_url"
    return
  fi

  # Fall back to localhost.run.
  log ":${port} trying localhost.run..."
  truncate -s 0 "$lr_log"
  SSH_ARGS=(-R "80:localhost:${port}"
    -o StrictHostKeyChecking=no -o BatchMode=yes
    -o ExitOnForwardFailure=yes -o ConnectTimeout=30
    -o ServerAliveInterval=30  -o ServerAliveCountMax=3)
  [ -n "${LOCALHOST_RUN_SSH_KEY_FILE:-}" ] && SSH_ARGS+=(-i "$LOCALHOST_RUN_SSH_KEY_FILE")
  ssh "${SSH_ARGS[@]}" nokey@localhost.run >> "$lr_log" 2>&1 &

  local lr_url=""
  for i in $(seq 1 60); do
    lr_url=$(grep -oE "$LR_URL_RE" "$lr_log" 2>/dev/null | head -1 || true)
    [ -n "$lr_url" ] && break
    sleep 1
  done

  if [ -n "$lr_url" ]; then
    log ":${port} → ${lr_url} (localhost.run)"
  else
    warn ":${port} — all tunnel methods failed; URL will be empty"
  fi
  printf '%s' "${lr_url:-}"
}

log "opening new API tunnel on :${API_PORT}..."
API_TUNNEL_URL=$(open_tunnel "$API_PORT" /tmp/cf-api.log /tmp/lr-api.log)

if [ -z "$API_TUNNEL_URL" ]; then
  warn "could not get API tunnel URL — frontend will use empty VITE_API_URL"
fi
log "API tunnel URL: ${API_TUNNEL_URL:-<empty>}"

# ── 5. Restart frontend dev servers with new VITE_API_URL ────────────────────

log "restarting frontend dev servers with VITE_API_URL=${API_TUNNEL_URL:-}..."
for i in "${!FRONTEND_NAMES[@]}"; do
  name="${FRONTEND_NAMES[$i]}"
  script="${FRONTEND_SCRIPTS[$i]}"
  logfile="/tmp/preview-${name}.log"
  (while true; do
    VITE_API_URL="$API_TUNNEL_URL" sh -c "$script" >> "$logfile" 2>&1 || true
    echo "[${name}] exited, restarting in 2s..." >> "$logfile"
    sleep 2
  done) &
  log "started ${name} dev server (log: ${logfile})"
done

# Wait for frontend ports to be ready (up to 60 s each).
for port in "${FRONTEND_PORTS[@]:-}"; do
  [ -z "$port" ] && continue
  log "waiting for :${port}..."
  for i in $(seq 1 60); do
    (echo > /dev/tcp/localhost/"$port") 2>/dev/null && break
    sleep 1
  done
  (echo > /dev/tcp/localhost/"$port") 2>/dev/null \
    && log ":${port} ready" \
    || warn ":${port} not ready after 60s — continuing anyway"
done

# ── 6. Open new frontend tunnels ──────────────────────────────────────────────

declare -A TUNNEL_URLS
for i in "${!FRONTEND_NAMES[@]}"; do
  name="${FRONTEND_NAMES[$i]}"
  port="${FRONTEND_PORTS[$i]:-}"
  [ -z "$port" ] && continue
  TUNNEL_URLS[$name]=$(open_tunnel "$port" "/tmp/cf-${name}.log" "/tmp/lr-${name}.log")
done

# ── 7. Update env file and worker state ───────────────────────────────────────

# Preserve existing seed credentials from the original env file.
URLS_FILE="/tmp/preview-urls-${WORKER}.env"
PREVIEW_EMAIL=$(grep '^PREVIEW_EMAIL=' "$URLS_FILE" 2>/dev/null | cut -d= -f2- || true)
PREVIEW_PASSWORD=$(grep '^PREVIEW_PASSWORD=' "$URLS_FILE" 2>/dev/null | cut -d= -f2- || true)
HO_MAGIC_LINK=$(grep '^HO_MAGIC_LINK=' "$URLS_FILE" 2>/dev/null | cut -d= -f2- || true)

{
  printf 'API_TUNNEL_URL=%s\n' "${API_TUNNEL_URL:-}"
  for i in "${!FRONTEND_NAMES[@]}"; do
    name="${FRONTEND_NAMES[$i]}"
    port="${FRONTEND_PORTS[$i]:-}"
    [ -z "$port" ] && continue
    printf '%s_URL=%s\n' "$(printf '%s' "$name" | tr '[:lower:]' '[:upper:]')" "${TUNNEL_URLS[$name]:-}"
  done
  printf 'PREVIEW_EMAIL=%s\n'    "${PREVIEW_EMAIL:-}"
  printf 'PREVIEW_PASSWORD=%s\n' "${PREVIEW_PASSWORD:-}"
  printf 'HO_MAGIC_LINK=%s\n'    "${HO_MAGIC_LINK:-}"
} > "$URLS_FILE"
log "updated $URLS_FILE"

node "$STATE_CLI" "$WORKER" set api_tunnel_url "${API_TUNNEL_URL:-}"
for i in "${!FRONTEND_NAMES[@]}"; do
  name="${FRONTEND_NAMES[$i]}"
  port="${FRONTEND_PORTS[$i]:-}"
  [ -z "$port" ] && continue
  node "$STATE_CLI" "$WORKER" set "${name}_url" "${TUNNEL_URLS[$name]:-}"
done

# ── 8. Re-emit tunnel_ready so skills that source the env file get new URLs ───
# Nested, not spread — a frontend project literally named "api" (a
# misconfiguration: devScript+port but no seedScript) would otherwise
# silently clobber the real API tunnel URL at the top level. Built in a
# single jq call (name/url pairs piped in as raw lines) rather than spawning
# one jq process per frontend project.

FRONTEND_JSON=$(
  for i in "${!FRONTEND_NAMES[@]}"; do
    name="${FRONTEND_NAMES[$i]}"
    port="${FRONTEND_PORTS[$i]:-}"
    [ -z "$port" ] && continue
    printf '%s\n%s\n' "$name" "${TUNNEL_URLS[$name]:-}"
  done | jq -R -n '[inputs] | . as $lines | reduce range(0; length; 2) as $i ({}; . + {($lines[$i]): $lines[$i+1]})'
)

node "$EMIT_CLI" "$WORKER" servers tunnel_ready \
  "$(jq -n --arg api "${API_TUNNEL_URL:-}" --argjson frontends "$FRONTEND_JSON" '{api: $api, frontends: $frontends}')"

# ── 9. Print summary ──────────────────────────────────────────────────────────

echo ""
echo "=== retunnel complete ==="
echo "  API tunnel:  ${API_TUNNEL_URL:-<empty>}"
for i in "${!FRONTEND_NAMES[@]}"; do
  name="${FRONTEND_NAMES[$i]}"
  port="${FRONTEND_PORTS[$i]:-}"
  [ -z "$port" ] && continue
  printf '  %-12s %s\n' "${name}:" "${TUNNEL_URLS[$name]:-<empty>}"
done
echo ""
echo "Preview credentials (unchanged):"
echo "  email:    ${PREVIEW_EMAIL:-}"
echo "  password: ${PREVIEW_PASSWORD:-}"
[ -n "${HO_MAGIC_LINK:-}" ] && echo "  HO link:  ${HO_MAGIC_LINK:-}"
echo ""
echo "NOTE: if the API dev server also needs to be restarted:"
echo "  pkill -f 'npm run api:dev' && (nohup npm run api:dev > /tmp/preview-api.log 2>&1 &)"
