#!/usr/bin/env bash
# Webhook job — started by the orchestrator at container boot.
#
# 1. Starts webhook-receiver.js + cloudflared tunnel immediately.
# 2. Polls /tmp/pr-number-${WORKER_INDEX} until the Claude job writes the PR.
# 3. Registers a GitHub repo webhook for issue_comment events.
# 4. Main loop:
#    /feedback PR comment → emits webhook:feedback on the event bus
#    PR merged/closed     → emits webhook:merged, exits
# 5. Deletes the GitHub webhook on EXIT.
#
# State transitions are driven by the emitted events; this script does not
# write to the worker state file.
#
# Required env: WORKER_INDEX, REPO_URL, GITHUB_TOKEN
set -euo pipefail

: "${WORKER_INDEX:?}"
: "${REPO_URL:?}"
: "${GITHUB_TOKEN:?}"

WORKER="$WORKER_INDEX"
REPO=$(echo "$REPO_URL" | sed 's|^github\.com/||')
REPO_DIR="${REPO_DIR:-/home/worker/repo}"
EMIT_CLI="$REPO_DIR/muaddib/lib/emit-cli.js"
COMMENT_FLAG="/tmp/wf-comment-${WORKER}"
RECEIVER_LOG="/tmp/webhook-receiver.log"
TUNNEL_LOG="/tmp/cf-webhook.log"
WEBHOOK_PORT=9090
MERGE_POLL_INTERVAL=30

log() { echo "[watch-feedback w${WORKER}] $*"; }

HOOK_ID=""
RECEIVER_PID=""

cleanup() {
    log "cleaning up"
    if [ -n "$HOOK_ID" ]; then
        log "deleting GitHub webhook ${HOOK_ID}"
        gh api "repos/${REPO}/hooks/${HOOK_ID}" -X DELETE 2>/dev/null || true
    fi
    [ -n "$RECEIVER_PID" ] && kill "$RECEIVER_PID" 2>/dev/null || true
    rm -f "$COMMENT_FLAG"
}
trap cleanup EXIT

WEBHOOK_SECRET=$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))")

# --- 1. Start receiver ---
rm -f "$COMMENT_FLAG"
WEBHOOK_SECRET="$WEBHOOK_SECRET" \
COMMENT_FLAG="$COMMENT_FLAG" \
PORT="$WEBHOOK_PORT" \
    node "$REPO_DIR/muaddib/webhook-receiver.js" > "$RECEIVER_LOG" 2>&1 &
RECEIVER_PID=$!
log "receiver PID ${RECEIVER_PID} on :${WEBHOOK_PORT}"

for i in $(seq 1 10); do
    (echo > /dev/tcp/localhost/$WEBHOOK_PORT) 2>/dev/null && break
    sleep 1
done

# --- 2. Open cloudflared tunnel ---
nohup cloudflared tunnel --url "http://localhost:${WEBHOOK_PORT}" --no-autoupdate --protocol http2 \
    > "$TUNNEL_LOG" 2>&1 &

WEBHOOK_URL=""
for i in $(seq 1 30); do
    WEBHOOK_URL=$(grep -oE 'https://[a-zA-Z0-9-]+\.trycloudflare\.com' \
        "$TUNNEL_LOG" 2>/dev/null | head -1 || true)
    [ -n "$WEBHOOK_URL" ] && break
    sleep 1
done

if [ -z "$WEBHOOK_URL" ]; then
    log "ERROR: failed to get webhook tunnel URL"
    exit 1
fi
log "webhook tunnel: ${WEBHOOK_URL}"

# --- 3. Wait for PR number ---
PR_NUMBER_FILE="/tmp/pr-number-${WORKER}"
log "waiting for PR number at ${PR_NUMBER_FILE}..."
while true; do
    PR_NUMBER=$(cat "$PR_NUMBER_FILE" 2>/dev/null || true)
    [ -n "$PR_NUMBER" ] && break
    sleep 2
done
log "PR #${PR_NUMBER} — registering webhook"

# Tell the receiver which PR to filter on
kill -s USR1 "$RECEIVER_PID" 2>/dev/null || true  # receiver ignores this; PR_NUMBER passed via restart
WEBHOOK_SECRET="$WEBHOOK_SECRET" \
COMMENT_FLAG="$COMMENT_FLAG" \
PR_NUMBER="$PR_NUMBER" \
PORT="$WEBHOOK_PORT" \
    node "$REPO_DIR/muaddib/webhook-receiver.js" > "$RECEIVER_LOG" 2>&1 &
kill "$RECEIVER_PID" 2>/dev/null || true
RECEIVER_PID=$!
log "restarted receiver with PR_NUMBER=${PR_NUMBER}"

# --- 4. Register GitHub webhook ---
HOOK_RESPONSE=$(gh api "repos/${REPO}/hooks" \
    -f "name=web" \
    -f "active=true" \
    -f "config[url]=${WEBHOOK_URL}" \
    -f "config[content_type]=json" \
    -f "config[secret]=${WEBHOOK_SECRET}" \
    -f "events[]=issue_comment" 2>&1 || true)
HOOK_ID=$(printf '%s' "$HOOK_RESPONSE" | jq -r '.id // empty' 2>/dev/null || true)
if [ -z "$HOOK_ID" ]; then
    log "ERROR: GitHub webhook registration failed — feedback loop disabled"
    log "response: $HOOK_RESPONSE"
    exit 1
fi
log "registered GitHub webhook ${HOOK_ID}"

# --- 5. Main loop ---
LAST_MERGE_CHECK=0

while true; do
    sleep 1

    if [ -f "$COMMENT_FLAG" ]; then
        rm -f "$COMMENT_FLAG"
        log "new /feedback comment — emitting feedback event"
        node "$EMIT_CLI" "$WORKER" webhook feedback '{}'
    fi

    NOW=$(date +%s)
    if [ $((NOW - LAST_MERGE_CHECK)) -ge $MERGE_POLL_INTERVAL ]; then
        LAST_MERGE_CHECK=$NOW
        PR_STATE=$(gh pr view "$PR_NUMBER" --json state --jq '.state' 2>/dev/null || echo "UNKNOWN")
        if [ "$PR_STATE" = "MERGED" ] || [ "$PR_STATE" = "CLOSED" ]; then
            log "PR #${PR_NUMBER} is ${PR_STATE} — emitting merged"
            node "$EMIT_CLI" "$WORKER" webhook merged "{\"state\":\"${PR_STATE}\"}"
            exit 0
        fi
    fi
done
