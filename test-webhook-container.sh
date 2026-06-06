#!/usr/bin/env bash
# Container-level integration test for the muaddib feedback webhook flow.
#
# Spins up a throwaway Docker container using the worker image, starts
# webhook-receiver.js + a cloudflared tunnel inside it (exactly as a real worker
# does), registers a Linear webhook, posts a test comment, and confirms the flag
# file is written within the timeout. Exercises Docker Desktop NAT + QUIC/HTTP2
# behaviour — the same environment where previous failures occurred.
#
# Usage:
#   LINEAR_API_KEY=<key> ./muaddib/test-webhook-container.sh --issue QUO-NNN
#
# Optional env:
#   WEBHOOK_TEST_IMAGE  — Docker image to use (default: quotethat-worker)
#   WEBHOOK_PORT        — port receiver listens on inside the container (default: 9090)
#   FLAG_TIMEOUT        — seconds to wait for flag file (default: 30)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

ISSUE_IDENTIFIER=""
IMAGE="${WEBHOOK_TEST_IMAGE:-quotethat-worker}"
WEBHOOK_PORT="${WEBHOOK_PORT:-9090}"
FLAG_TIMEOUT="${FLAG_TIMEOUT:-30}"
CONTAINER_NAME="test-webhook-$$"
FLAG_PATH="/tmp/twc-comment"

while [[ $# -gt 0 ]]; do
    case "$1" in
        --issue) ISSUE_IDENTIFIER="$2"; shift 2 ;;
        *) echo "Unknown argument: $1" >&2; exit 1 ;;
    esac
done

if [[ -z "$ISSUE_IDENTIFIER" ]]; then
    echo "Usage: LINEAR_API_KEY=<key> $0 --issue QUO-NNN" >&2
    exit 1
fi
: "${LINEAR_API_KEY:?Must set LINEAR_API_KEY}"

log()  { echo "[test-webhook-container] $*"; }
fail() { echo "FAIL — $*"; exit 1; }

# --- prerequisite checks ---
if ! docker image inspect "$IMAGE" > /dev/null 2>&1; then
    fail "image '${IMAGE}' not found — run: docker build -f muaddib/Dockerfile.worker -t quotethat-worker ."
fi

linear_gql() {
    curl -s -X POST https://api.linear.app/graphql \
        -H "Authorization: ${LINEAR_API_KEY}" \
        -H "Content-Type: application/json" \
        --data-binary "$1"
}

# --- resolve issue ---
log "resolving ${ISSUE_IDENTIFIER} via Linear API..."
ISSUE_RESP=$(linear_gql "$(jq -n --arg id "$ISSUE_IDENTIFIER" \
    '{"query":"query($id:String!){issue(id:$id){id team{id}}}","variables":{"id":$id}}')")
ISSUE_UUID=$(echo "$ISSUE_RESP" | jq -r '.data.issue.id // empty')
TEAM_ID=$(echo   "$ISSUE_RESP" | jq -r '.data.issue.team.id // empty')
if [[ -z "$ISSUE_UUID" || -z "$TEAM_ID" ]]; then
    log "ERROR: could not resolve issue. Response: $ISSUE_RESP"
    exit 1
fi
log "issue UUID=${ISSUE_UUID}  team=${TEAM_ID}"

WEBHOOK_SECRET=$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))")

HOOK_ID=""
cleanup() {
    if [[ -n "$HOOK_ID" ]]; then
        log "deleting Linear webhook ${HOOK_ID}"
        linear_gql "{\"query\":\"mutation { webhookDelete(id: \\\"${HOOK_ID}\\\") { success } }\"}" \
            > /dev/null 2>&1 || true
    fi
    if docker inspect "$CONTAINER_NAME" > /dev/null 2>&1; then
        log "stopping container ${CONTAINER_NAME}"
        docker rm -f "$CONTAINER_NAME" > /dev/null 2>&1 || true
    fi
}
trap cleanup EXIT

# --- start container ---
log "starting container from image '${IMAGE}'..."
docker run -d \
    --name "$CONTAINER_NAME" \
    --entrypoint tail \
    -v "${SCRIPT_DIR}/webhook-receiver.js:/home/worker/webhook-receiver.js:ro" \
    "$IMAGE" \
    -f /dev/null > /dev/null
log "container ${CONTAINER_NAME} running"

# --- start webhook receiver inside container ---
# Write env vars to a file first so docker exec -d can source them.
# (docker exec -d doesn't allow inline env expansion, and -e flag isn't available
# in all Docker versions — sourcing a file is portable.)
log "starting webhook-receiver inside container..."
docker exec "$CONTAINER_NAME" sh -c "printf '%s\n' \
    'WEBHOOK_SECRET=${WEBHOOK_SECRET}' \
    'LINEAR_ISSUE_ID=${ISSUE_UUID}' \
    'LINEAR_ISSUE_IDENTIFIER=${ISSUE_IDENTIFIER}' \
    'COMMENT_FLAG=${FLAG_PATH}' \
    'PORT=${WEBHOOK_PORT}' \
    'WEBHOOK_DEBUG=1' \
    > /tmp/receiver.env"

docker exec -d "$CONTAINER_NAME" \
    sh -c 'set -a; . /tmp/receiver.env; set +a; node /home/worker/webhook-receiver.js > /tmp/receiver.log 2>&1'

# wait for receiver to bind (up to 10 s)
# Use curl rather than /dev/tcp — the container's sh is dash, which lacks the bash
# /dev/tcp pseudo-device. curl exits 0 on any HTTP response (incl. 401 = receiver up).
BOUND=false
for i in $(seq 1 10); do
    docker exec "$CONTAINER_NAME" \
        curl -s -o /dev/null --max-time 1 "http://localhost:${WEBHOOK_PORT}" \
        && BOUND=true && break
    sleep 1
done
if [[ "$BOUND" != "true" ]]; then
    log "ERROR: receiver did not bind within 10 s — receiver log:"
    docker exec "$CONTAINER_NAME" cat /tmp/receiver.log 2>/dev/null || true
    fail "receiver failed to start"
fi
log "receiver bound on :${WEBHOOK_PORT}"

# --- start cloudflared tunnel inside container ---
log "starting cloudflared tunnel inside container (--protocol http2)..."
docker exec -d "$CONTAINER_NAME" \
    sh -c "cloudflared tunnel --url http://localhost:${WEBHOOK_PORT} --no-autoupdate --protocol http2 > /tmp/cf-test.log 2>&1"

# wait for tunnel URL (up to 30 s)
WEBHOOK_URL=""
for i in $(seq 1 30); do
    WEBHOOK_URL=$(docker exec "$CONTAINER_NAME" sh -c \
        "grep -oE 'https://[a-zA-Z0-9-]+\.trycloudflare\.com' /tmp/cf-test.log 2>/dev/null | head -1" \
        || true)
    [[ -n "$WEBHOOK_URL" ]] && break
    sleep 1
done
if [[ -z "$WEBHOOK_URL" ]]; then
    log "ERROR: tunnel URL not found within 30 s — cloudflared log:"
    docker exec "$CONTAINER_NAME" cat /tmp/cf-test.log 2>/dev/null || true
    fail "cloudflared tunnel failed to start"
fi
log "tunnel URL: ${WEBHOOK_URL}"

# --- health check: confirm tunnel forwards to receiver ---
log "health-checking tunnel (up to 15 s for edge propagation)..."
HEALTH_CODE="000"
for i in $(seq 1 15); do
    HEALTH_CODE=$(curl -sS \
        --doh-url "https://cloudflare-dns.com/dns-query" \
        -o /dev/null -w "%{http_code}" --max-time 5 \
        -X POST "$WEBHOOK_URL" 2>/dev/null) || true
    [[ "$HEALTH_CODE" = "401" ]] && break
    sleep 1
done
log "tunnel health: HTTP ${HEALTH_CODE} (expect 401)"
if [[ "$HEALTH_CODE" != "401" ]]; then
    log "cloudflared log:"
    docker exec "$CONTAINER_NAME" cat /tmp/cf-test.log 2>/dev/null || true
    fail "tunnel not forwarding after 15 s (got HTTP ${HEALTH_CODE})"
fi

# --- register Linear webhook ---
log "registering Linear webhook..."
HOOK_RESPONSE=$(linear_gql "$(jq -n \
    --arg url    "$WEBHOOK_URL" \
    --arg teamId "$TEAM_ID" \
    --arg secret "$WEBHOOK_SECRET" \
    '{
        query: "mutation WebhookCreate($input: WebhookCreateInput!) { webhookCreate(input: $input) { success webhook { id } } }",
        variables: { input: { url: $url, teamId: $teamId, secret: $secret, resourceTypes: ["Comment"] } }
    }')")
HOOK_ID=$(echo "$HOOK_RESPONSE" | jq -r '.data.webhookCreate.webhook.id // empty')
if [[ -z "$HOOK_ID" ]]; then
    log "webhook registration failed: $HOOK_RESPONSE"
    fail "could not register Linear webhook"
fi
log "registered webhook ${HOOK_ID}"

# --- post test comment ---
log "posting test comment on ${ISSUE_IDENTIFIER}..."
COMMENT_BODY="test-webhook-container probe ($(date -u +%FT%TZ))"
COMMENT_RESP=$(linear_gql "$(jq -n \
    --arg issueId "$ISSUE_UUID" \
    --arg body    "$COMMENT_BODY" \
    '{"query":"mutation($issueId:String!,$body:String!){commentCreate(input:{issueId:$issueId,body:$body}){success}}","variables":{"issueId":$issueId,"body":$body}}')")
COMMENT_OK=$(echo "$COMMENT_RESP" | jq -r '.data.commentCreate.success // false')
if [[ "$COMMENT_OK" != "true" ]]; then
    log "WARNING: comment may not have been created — response: $COMMENT_RESP"
fi

# --- wait for flag file inside container ---
log "waiting for flag file inside container (max ${FLAG_TIMEOUT} s)..."
ELAPSED=0
PASS=false
for i in $(seq 1 "$FLAG_TIMEOUT"); do
    if docker exec "$CONTAINER_NAME" test -f "$FLAG_PATH" 2>/dev/null; then
        PASS=true
        ELAPSED=$i
        break
    fi
    sleep 1
done

echo ""
log "receiver log:"
docker exec "$CONTAINER_NAME" cat /tmp/receiver.log 2>/dev/null || true
echo ""
log "cloudflared log (last 20 lines):"
docker exec "$CONTAINER_NAME" sh -c 'tail -20 /tmp/cf-test.log' 2>/dev/null || true
echo ""

if [[ "$PASS" = "true" ]]; then
    echo "PASS — flag file written inside container in ${ELAPSED}s"
    exit 0
else
    echo "FAIL — flag file not written within ${FLAG_TIMEOUT}s"
    exit 1
fi
