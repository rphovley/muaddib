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
EMIT_CLI="$REPO/muaddib/lib/emit-cli.js"

log() { echo "[start-servers w${WORKER}] $*"; }

# --- 1. DB migrations ---
log "running migrations..."
cd "$REPO" && npm run --prefix projects/api migrate:up

# --- 2. Preview seed — capture credentials for the PR body ---
log "running preview seed..."
SEED_JSON=$(cd "$REPO" && npx --prefix projects/api tsx \
    projects/api/scripts/seed-preview.ts 2>/tmp/seed-preview.log \
    | tail -1 \
    || echo '{"email":"(seed failed — see /tmp/seed-preview.log)","password":"","homeowner_magic_link":null}')
PREVIEW_EMAIL=$(printf '%s' "$SEED_JSON"    | jq -r '.email // "(unknown)"')
PREVIEW_PASSWORD=$(printf '%s' "$SEED_JSON" | jq -r '.password // "(unknown)"')
HO_MAGIC_LINK=$(printf '%s' "$SEED_JSON"   | jq -r '.homeowner_magic_link // ""')

# --- 3. API dev server ---
log "starting API dev server..."
cd "$REPO"
nohup npm run api:dev > /tmp/preview-api.log 2>&1 &

for i in $(seq 1 60); do
    (echo > /dev/tcp/localhost/8081) 2>/dev/null && break
    sleep 1
done

# --- 4. API tunnel ---
log "opening API tunnel..."
nohup cloudflared tunnel --url http://localhost:8081 --no-autoupdate --protocol http2 \
    > /tmp/cf-api.log 2>&1 &
API_TUNNEL_URL=""
for i in $(seq 1 30); do
    API_TUNNEL_URL=$(grep -oE 'https://[a-zA-Z0-9-]+\.trycloudflare\.com' \
        /tmp/cf-api.log 2>/dev/null | head -1 || true)
    [ -n "$API_TUNNEL_URL" ] && break
    sleep 1
done

# --- 5. Portal and homeowner dev servers ---
log "starting frontend dev servers..."
VITE_API_URL="$API_TUNNEL_URL" nohup npm run portal:dev \
    > /tmp/preview-portal.log 2>&1 &
VITE_API_URL="$API_TUNNEL_URL" nohup npm run homeowner:dev \
    > /tmp/preview-homeowner.log 2>&1 &

for i in $(seq 1 60); do
    (echo > /dev/tcp/localhost/5173) 2>/dev/null && \
    (echo > /dev/tcp/localhost/5174) 2>/dev/null && break
    sleep 1
done

# --- 6. Frontend tunnels ---
log "opening frontend tunnels..."
nohup cloudflared tunnel --url http://localhost:5173 --no-autoupdate --protocol http2 \
    > /tmp/cf-portal.log 2>&1 &
nohup cloudflared tunnel --url http://localhost:5174 --no-autoupdate --protocol http2 \
    > /tmp/cf-homeowner.log 2>&1 &

PORTAL_URL=""
HO_URL=""
for i in $(seq 1 30); do
    PORTAL_URL=$(grep -oE 'https://[a-zA-Z0-9-]+\.trycloudflare\.com' \
        /tmp/cf-portal.log 2>/dev/null | head -1 || true)
    HO_URL=$(grep -oE 'https://[a-zA-Z0-9-]+\.trycloudflare\.com' \
        /tmp/cf-homeowner.log 2>/dev/null | head -1 || true)
    [ -n "$PORTAL_URL" ] && [ -n "$HO_URL" ] && break
    sleep 1
done

# --- 7. Write shared env file for Claude job ---
URLS_FILE="/tmp/preview-urls-${WORKER}.env"
{
    printf 'API_TUNNEL_URL=%s\n'   "${API_TUNNEL_URL:-}"
    printf 'PORTAL_URL=%s\n'       "${PORTAL_URL:-}"
    printf 'HO_URL=%s\n'           "${HO_URL:-}"
    printf 'PREVIEW_EMAIL=%s\n'    "${PREVIEW_EMAIL:-}"
    printf 'PREVIEW_PASSWORD=%s\n' "${PREVIEW_PASSWORD:-}"
    printf 'HO_MAGIC_LINK=%s\n'    "${HO_MAGIC_LINK:-}"
} > "$URLS_FILE"
log "wrote $URLS_FILE"

# --- 8. Signal orchestrator that servers are ready ---
log "emitting tunnel_ready"
node "$EMIT_CLI" "$WORKER" servers tunnel_ready \
    "{\"api\":\"${API_TUNNEL_URL:-}\",\"portal\":\"${PORTAL_URL:-}\",\"homeowner\":\"${HO_URL:-}\"}"

log "servers running"
tail -f /dev/null
