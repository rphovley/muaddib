#!/usr/bin/env bash
# Standalone integration test for webhook-receiver.js.
#
# Starts the receiver locally, opens a cloudflared quick tunnel (or uses a
# provided URL), registers a real Linear webhook, posts a test comment on the
# target issue, and confirms the flag file is written within 15 s. Cleans up
# the Linear webhook on exit.
#
# Note: pass --config /dev/null to cloudflared so any local named-tunnel config
# is ignored and a genuine quick tunnel is created.
#
# Usage:
#   LINEAR_API_KEY=<key> ./muaddib/test-webhook-receiver.sh --issue QUO-NNN
#
# Optional env:
#   WEBHOOK_RECEIVER_URL  — skip cloudflared, use this URL for the webhook
#   WEBHOOK_PORT          — local port to bind (default: 19090)
#   WEBHOOK_DEBUG         — set to 1 to enable verbose receiver logging (default: 1)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ISSUE_IDENTIFIER=""

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

WEBHOOK_PORT="${WEBHOOK_PORT:-19090}"
WEBHOOK_DEBUG="${WEBHOOK_DEBUG:-1}"
COMMENT_FLAG="/tmp/twhr-comment-$$"
RECEIVER_LOG="/tmp/twhr-receiver-$$.log"
TUNNEL_LOG="/tmp/twhr-tunnel-$$.log"
WEBHOOK_SECRET=$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))")

linear_gql() {
    curl -s -X POST https://api.linear.app/graphql \
        -H "Authorization: ${LINEAR_API_KEY}" \
        -H "Content-Type: application/json" \
        --data-binary "$1"
}

HOOK_ID=""
RECEIVER_PID=""
CF_PID=""

cleanup() {
    if [[ -n "$HOOK_ID" ]]; then
        echo "[test-webhook-receiver] deleting Linear webhook ${HOOK_ID}"
        linear_gql "{\"query\":\"mutation { webhookDelete(id: \\\"${HOOK_ID}\\\") { success } }\"}" > /dev/null 2>&1 || true
    fi
    [[ -n "$RECEIVER_PID" ]] && kill "$RECEIVER_PID" 2>/dev/null || true
    [[ -n "$CF_PID" ]] && kill "$CF_PID" 2>/dev/null || true
    rm -f "$COMMENT_FLAG" "$RECEIVER_LOG" "$TUNNEL_LOG"
}
trap cleanup EXIT

log() { echo "[test-webhook-receiver] $*"; }

# --- 1. Resolve issue UUID and team ID from the identifier ---
log "resolving issue ${ISSUE_IDENTIFIER} via Linear API..."
ISSUE_RESP=$(linear_gql "$(jq -n --arg id "$ISSUE_IDENTIFIER" \
    '{"query": "query($id: String!) { issue(id: $id) { id team { id } } }", "variables": {"id": $id}}')")
ISSUE_UUID=$(echo "$ISSUE_RESP" | jq -r '.data.issue.id // empty')
TEAM_ID=$(echo "$ISSUE_RESP" | jq -r '.data.issue.team.id // empty')

if [[ -z "$ISSUE_UUID" || -z "$TEAM_ID" ]]; then
    log "ERROR: could not resolve issue ${ISSUE_IDENTIFIER}"
    log "response: $ISSUE_RESP"
    exit 1
fi
log "issue UUID=${ISSUE_UUID} team=${TEAM_ID}"

# --- 2. Start the webhook receiver ---
rm -f "$COMMENT_FLAG"
WEBHOOK_SECRET="$WEBHOOK_SECRET" \
LINEAR_ISSUE_ID="$ISSUE_UUID" \
LINEAR_ISSUE_IDENTIFIER="$ISSUE_IDENTIFIER" \
COMMENT_FLAG="$COMMENT_FLAG" \
PORT="$WEBHOOK_PORT" \
WEBHOOK_DEBUG="$WEBHOOK_DEBUG" \
    node "${SCRIPT_DIR}/webhook-receiver.js" > "$RECEIVER_LOG" 2>&1 &
RECEIVER_PID=$!
log "receiver PID ${RECEIVER_PID} on :${WEBHOOK_PORT}"

# Wait for receiver to bind (up to 10 s)
BOUND=false
for i in $(seq 1 10); do
    (echo > /dev/tcp/localhost/$WEBHOOK_PORT) 2>/dev/null && BOUND=true && break
    sleep 1
done
if [[ "$BOUND" != "true" ]]; then
    log "ERROR: receiver did not bind on :${WEBHOOK_PORT} within 10 s"
    cat "$RECEIVER_LOG"
    exit 1
fi

# --- 3. Get tunnel URL ---
if [[ -n "${WEBHOOK_RECEIVER_URL:-}" ]]; then
    WEBHOOK_URL="$WEBHOOK_RECEIVER_URL"
    log "using provided URL: ${WEBHOOK_URL}"
else
    log "opening cloudflared tunnel..."
    cloudflared tunnel --config /dev/null --url "http://localhost:${WEBHOOK_PORT}" --no-autoupdate \
        > "$TUNNEL_LOG" 2>&1 &
    CF_PID=$!

    WEBHOOK_URL=""
    for i in $(seq 1 30); do
        WEBHOOK_URL=$(grep -oE 'https://[a-zA-Z0-9-]+\.trycloudflare\.com' "$TUNNEL_LOG" 2>/dev/null | head -1 || true)
        [[ -n "$WEBHOOK_URL" ]] && break
        sleep 1
    done

    if [[ -z "$WEBHOOK_URL" ]]; then
        log "ERROR: failed to get cloudflared tunnel URL within 30 s"
        cat "$TUNNEL_LOG"
        exit 1
    fi
    log "tunnel: ${WEBHOOK_URL}"
fi

# --- 3b. Verify receiver responds locally (expect 401 for unsigned request) ---
LOCAL_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 -X POST "http://localhost:${WEBHOOK_PORT}") || true
log "local receiver check: HTTP ${LOCAL_CODE} (expect 401)"
if [[ "$LOCAL_CODE" != "401" ]]; then
    log "ERROR: receiver not responding correctly on localhost:${WEBHOOK_PORT}"
    cat "$RECEIVER_LOG"
    exit 1
fi

# --- 3c. Verify tunnel forwards to receiver (retry up to 15 s for edge propagation) ---
# Use DNS-over-HTTPS to bypass local resolver: some routers hijack UDP/53 and return
# NXDOMAIN for *.trycloudflare.com even when 1.1.1.1 is specified directly.
log "health-checking tunnel (up to 15 s for edge propagation)..."
HEALTH_CODE="000"
for i in $(seq 1 15); do
    HEALTH_CODE=$(curl -sS --doh-url "https://cloudflare-dns.com/dns-query" \
        -o /dev/null -w "%{http_code}" --max-time 3 -X POST "$WEBHOOK_URL" \
        2>>"$TUNNEL_LOG") || true
    [[ "$HEALTH_CODE" = "401" ]] && break
    sleep 1
done
log "tunnel health check: HTTP ${HEALTH_CODE} (expect 401)"
if [[ "$HEALTH_CODE" != "401" ]]; then
    log "ERROR: tunnel not forwarding to receiver after 15 s — cloudflared log:"
    cat "${TUNNEL_LOG:-/dev/null}"
    exit 1
fi

# --- 4. Register Linear webhook (team-scoped, Comment events only) ---
HOOK_RESPONSE=$(linear_gql "$(jq -n \
    --arg url "$WEBHOOK_URL" \
    --arg teamId "$TEAM_ID" \
    --arg secret "$WEBHOOK_SECRET" \
    '{
        query: "mutation WebhookCreate($input: WebhookCreateInput!) { webhookCreate(input: $input) { success webhook { id } } }",
        variables: { input: { url: $url, teamId: $teamId, secret: $secret, resourceTypes: ["Comment"] } }
    }')")
HOOK_ID=$(echo "$HOOK_RESPONSE" | jq -r '.data.webhookCreate.webhook.id // empty')
if [[ -z "$HOOK_ID" ]]; then
    log "ERROR: Linear webhook registration failed"
    log "response: $HOOK_RESPONSE"
    exit 1
fi
log "registered webhook ${HOOK_ID}"

# --- 5. Post a test comment on the issue ---
log "posting test comment on ${ISSUE_IDENTIFIER}..."
COMMENT_BODY="test-webhook-receiver probe ($(date -u +%FT%TZ))"
COMMENT_RESP=$(linear_gql "$(jq -n \
    --arg issueId "$ISSUE_UUID" \
    --arg body "$COMMENT_BODY" \
    '{"query": "mutation($issueId: String!, $body: String!) { commentCreate(input: { issueId: $issueId, body: $body }) { success } }", "variables": {"issueId": $issueId, "body": $body}}')")
log "comment response: $(echo "$COMMENT_RESP" | jq -c .)"
COMMENT_OK=$(echo "$COMMENT_RESP" | jq -r '.data.commentCreate.success // false')
if [[ "$COMMENT_OK" != "true" ]]; then
    log "WARNING: comment may not have been created"
fi

# --- 6. Wait for flag file (15 s) ---
log "waiting for flag file (max 15 s)..."
ELAPSED=0
PASS=false
for i in $(seq 1 15); do
    if [[ -f "$COMMENT_FLAG" ]]; then
        PASS=true
        ELAPSED=$i
        break
    fi
    sleep 1
done

echo ""
log "receiver log:"
cat "$RECEIVER_LOG"
echo ""

if [[ "$PASS" = "true" ]]; then
    echo "PASS — flag file written in ${ELAPSED}s"
    exit 0
else
    echo "FAIL — flag file not written within 15 s"
    exit 1
fi
