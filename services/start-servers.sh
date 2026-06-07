#!/usr/bin/env bash
# Servers job — started by the orchestrator at container boot.
# Runs DB migrations, preview seed, starts API + frontend dev servers, opens
# Cloudflare tunnels. Emits tunnel_ready when all URLs are confirmed, then
# stays alive so background servers keep running until the container exits.
#
# Writes /tmp/preview-urls-${WORKER_INDEX}.env for the Claude job to source.
#
# Required env: WORKER_INDEX
set -euo pipefail

: "${WORKER_INDEX:?WORKER_INDEX not set}"
WORKER="$WORKER_INDEX"
REPO="${REPO_DIR:-/home/worker/repo}"
EMIT_CLI="$REPO/muaddib/orchestrator/emit-cli.js"
CONFIG="$REPO/.muaddib.json"

log() { echo "[start-servers w${WORKER}] $*"; }

# ── Parse API project from config (the one with a seedScript) ─────────────────

API_PROJECT=$(jq -c '.projects[] | select(.seedScript != null)' "$CONFIG" | head -1)
API_PATH=$(printf '%s' "$API_PROJECT"       | jq -r '.path')
API_DEV_SCRIPT=$(printf '%s' "$API_PROJECT" | jq -r '.devScript')
API_PORT=$(printf '%s' "$API_PROJECT"       | jq -r '.port')
SEED_SCRIPT=$(printf '%s' "$API_PROJECT"    | jq -r '.seedScript')

# --- 1. DB migrations ---
log "running migrations..."
cd "$REPO" && npm run --prefix "$API_PATH" migrate:up

# --- 2. Preview seed — capture credentials for the PR body ---
log "running preview seed..."
cd "$REPO" && npx --prefix "$API_PATH" tsx "$SEED_SCRIPT" \
    > /tmp/seed-preview-out.txt 2>/tmp/seed-preview.log || true
SEED_JSON="$(tail -1 /tmp/seed-preview-out.txt 2>/dev/null || true)"
[ -z "$SEED_JSON" ] && SEED_JSON='{"email":"(seed failed — see /tmp/seed-preview.log)","password":"","homeowner_magic_link":null}'
PREVIEW_EMAIL=$(printf '%s' "$SEED_JSON"    | jq -r '.email // "(unknown)"')
PREVIEW_PASSWORD=$(printf '%s' "$SEED_JSON" | jq -r '.password // "(unknown)"')
HO_MAGIC_LINK=$(printf '%s' "$SEED_JSON"   | jq -r '.homeowner_magic_link // ""')

# --- 3. API dev server ---
log "starting API dev server..."
cd "$REPO"
nohup npm run "$API_DEV_SCRIPT" > /tmp/preview-api.log 2>&1 &

for i in $(seq 1 60); do
    (echo > /dev/tcp/localhost/"$API_PORT") 2>/dev/null && break
    sleep 1
done

# --- 4. API tunnel ---
log "opening API tunnel..."
nohup cloudflared tunnel --url "http://localhost:${API_PORT}" --no-autoupdate --protocol http2 \
    > /tmp/cf-api.log 2>&1 &
API_TUNNEL_URL=""
for i in $(seq 1 30); do
    API_TUNNEL_URL=$(grep -oE 'https://[a-zA-Z0-9-]+\.trycloudflare\.com' \
        /tmp/cf-api.log 2>/dev/null | head -1 || true)
    [ -n "$API_TUNNEL_URL" ] && break
    sleep 1
done

# --- 5. Frontend dev servers ---
log "starting frontend dev servers..."

FRONTEND_PORTS=()
while IFS= read -r project; do
    NAME=$(printf '%s' "$project" | jq -r '.name')
    DEV_SCRIPT=$(printf '%s' "$project" | jq -r '.devScript')
    PORT=$(printf '%s' "$project" | jq -r '.port // empty')
    [ -n "$PORT" ] && FRONTEND_PORTS+=("$PORT")
    (while true; do
        VITE_API_URL="$API_TUNNEL_URL" npm run "$DEV_SCRIPT" >> "/tmp/preview-${NAME}.log" 2>&1 || true
        echo "[${NAME}] exited, restarting in 2s..." >> "/tmp/preview-${NAME}.log"
        sleep 2
    done) &
done < <(jq -c '.projects[] | select(.seedScript == null and .devScript != null)' "$CONFIG")

if [ "${#FRONTEND_PORTS[@]}" -gt 0 ]; then
    for i in $(seq 1 60); do
        all_ready=1
        for port in "${FRONTEND_PORTS[@]}"; do
            (echo > /dev/tcp/localhost/"$port") 2>/dev/null || { all_ready=0; break; }
        done
        [ "$all_ready" -eq 1 ] && break
        sleep 1
    done
fi

# --- 6. Frontend tunnels ---
log "opening frontend tunnels..."

declare -A TUNNEL_URLS

while IFS= read -r project; do
    NAME=$(printf '%s' "$project" | jq -r '.name')
    PORT=$(printf '%s' "$project" | jq -r '.port // empty')
    [ -z "$PORT" ] && continue
    nohup cloudflared tunnel --url "http://localhost:${PORT}" --no-autoupdate --protocol http2 \
        > "/tmp/cf-${NAME}.log" 2>&1 &
done < <(jq -c '.projects[] | select(.seedScript == null and .devScript != null)' "$CONFIG")

for i in $(seq 1 30); do
    all_found=1
    while IFS= read -r project; do
        NAME=$(printf '%s' "$project" | jq -r '.name')
        PORT=$(printf '%s' "$project" | jq -r '.port // empty')
        [ -z "$PORT" ] && continue
        url=$(grep -oE 'https://[a-zA-Z0-9-]+\.trycloudflare\.com' \
            "/tmp/cf-${NAME}.log" 2>/dev/null | head -1 || true)
        if [ -n "$url" ]; then
            TUNNEL_URLS[$NAME]="$url"
        else
            all_found=0
        fi
    done < <(jq -c '.projects[] | select(.seedScript == null and .devScript != null)' "$CONFIG")
    [ "$all_found" -eq 1 ] && break
    sleep 1
done

# Backward-compatible aliases used by skills and the PR template
PORTAL_URL="${TUNNEL_URLS[portal]:-}"
HO_URL="${TUNNEL_URLS[homeowner]:-}"

# --- 7. Write shared env file for Claude job ---
URLS_FILE="/tmp/preview-urls-${WORKER}.env"
{
    printf 'API_TUNNEL_URL=%s\n' "${API_TUNNEL_URL:-}"
    while IFS= read -r project; do
        NAME=$(printf '%s' "$project" | jq -r '.name')
        NAME_UPPER=$(printf '%s' "$NAME" | tr '[:lower:]' '[:upper:]')
        printf '%s_URL=%s\n' "$NAME_UPPER" "${TUNNEL_URLS[$NAME]:-}"
    done < <(jq -c '.projects[] | select(.seedScript == null and .devScript != null)' "$CONFIG")
    printf 'PORTAL_URL=%s\n'       "${PORTAL_URL:-}"
    printf 'HO_URL=%s\n'           "${HO_URL:-}"
    printf 'PREVIEW_EMAIL=%s\n'    "${PREVIEW_EMAIL:-}"
    printf 'PREVIEW_PASSWORD=%s\n' "${PREVIEW_PASSWORD:-}"
    printf 'HO_MAGIC_LINK=%s\n'    "${HO_MAGIC_LINK:-}"
} > "$URLS_FILE"
log "wrote $URLS_FILE"

# --- 8. Write tunnel URLs to worker state for runner STATE_* injection ---
STATE_CLI="$REPO/muaddib/orchestrator/state-cli.js"
node "$STATE_CLI" "$WORKER" set api_tunnel_url "${API_TUNNEL_URL:-}"
node "$STATE_CLI" "$WORKER" set portal_url     "${PORTAL_URL:-}"
node "$STATE_CLI" "$WORKER" set ho_url         "${HO_URL:-}"

# --- 9. Signal orchestrator that servers are ready ---
log "emitting tunnel_ready"
node "$EMIT_CLI" "$WORKER" servers tunnel_ready \
    "{\"api\":\"${API_TUNNEL_URL:-}\",\"portal\":\"${PORTAL_URL:-}\",\"homeowner\":\"${HO_URL:-}\"}"

log "servers running"
tail -f /dev/null
