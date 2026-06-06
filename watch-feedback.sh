#!/usr/bin/env bash
# Background feedback watcher. Runs inside the worker container after the
# implementation PR is opened.
#
# Setup:
#   1. Starts webhook-receiver.js on port 9090 — validates Linear-Signature HMAC,
#      drops a flag file when a new Comment is created on the watched issue.
#   2. Opens a cloudflared quick tunnel to port 9090 and registers a Linear team
#      webhook pointing at it. Cleans up the webhook on EXIT via trap.
#   3. Hot path: polls a local flag file at 1 s — no network in the loop.
#      On new comment  → spawns /muaddib-feedback in a new tmux window.
#      On PR merge     → detected by a separate 30 s GitHub poll; writes DONE_FINAL.
#
# Usage (called by implementation-fleet after PR creation):
#   PR_NUMBER=<n> \
#   LINEAR_ISSUE_ID=<uuid> \
#   LINEAR_ISSUE_IDENTIFIER=<QUO-123> \
#   LINEAR_TEAM_ID=<uuid> \
#   nohup /home/worker/repo/muaddib/watch-feedback.sh \
#       > /tmp/feedback-watcher.log 2>&1 &
#
# Required env: WORKER_INDEX, PR_NUMBER, LINEAR_ISSUE_ID, LINEAR_ISSUE_IDENTIFIER,
#               LINEAR_TEAM_ID, LINEAR_API_KEY, REPO_URL, GITHUB_TOKEN
set -euo pipefail

: "${WORKER_INDEX:?}"
: "${PR_NUMBER:?}"
: "${LINEAR_ISSUE_ID:?}"
: "${LINEAR_ISSUE_IDENTIFIER:?}"
: "${LINEAR_TEAM_ID:?}"
: "${LINEAR_API_KEY:?}"
: "${REPO_URL:?}"

STATUS_FILE="/var/run/agent-status/worker-${WORKER_INDEX}.state"
COMMENT_FLAG="/tmp/wf-comment-${WORKER_INDEX}"
RECEIVER_LOG="/tmp/webhook-receiver.log"
TUNNEL_LOG="/tmp/cf-webhook.log"
WEBHOOK_PORT=9090
MERGE_POLL_INTERVAL=30  # seconds between GitHub PR state checks

REPO=$(echo "$REPO_URL" | sed 's|^github\.com/||')
PERM="${CLAUDE_PERMISSION_MODE:-bypassPermissions}"
SESSION="w${WORKER_INDEX}"

note() { printf '%s %s\n' "$1" "$(date -u +%FT%TZ)" > "$STATUS_FILE" 2>/dev/null || true; }
log()  { echo "[watch-feedback w${WORKER_INDEX}] $*"; }

linear_gql() {
    curl -s -X POST https://api.linear.app/graphql \
        -H "Authorization: ${LINEAR_API_KEY}" \
        -H "Content-Type: application/json" \
        --data-binary "$1"
}

HOOK_ID=""
RECEIVER_PID=""

cleanup() {
    log "cleaning up"
    if [ -n "$HOOK_ID" ]; then
        log "deleting Linear webhook ${HOOK_ID}"
        linear_gql "{\"query\":\"mutation { webhookDelete(id: \\\"${HOOK_ID}\\\") { success } }\"}" \
            > /dev/null 2>&1 || true
    fi
    [ -n "$RECEIVER_PID" ] && kill "$RECEIVER_PID" 2>/dev/null || true
    rm -f "$COMMENT_FLAG"
}
trap cleanup EXIT

# --- 1. Generate webhook secret ---
WEBHOOK_SECRET=$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))")

# Write context files for the feedback skill to read
echo "$LINEAR_ISSUE_IDENTIFIER" > /tmp/linear-issue-identifier
echo "$PR_NUMBER" > /tmp/pr-number

# --- 2. Start the webhook receiver ---
rm -f "$COMMENT_FLAG"
WEBHOOK_SECRET="$WEBHOOK_SECRET" \
LINEAR_ISSUE_ID="$LINEAR_ISSUE_ID" \
COMMENT_FLAG="$COMMENT_FLAG" \
PORT="$WEBHOOK_PORT" \
    node /home/worker/repo/muaddib/webhook-receiver.js > "$RECEIVER_LOG" 2>&1 &
RECEIVER_PID=$!
log "receiver PID ${RECEIVER_PID} on :${WEBHOOK_PORT}"

# Wait for receiver to bind (up to 10 s)
for i in $(seq 1 10); do
    (echo > /dev/tcp/localhost/$WEBHOOK_PORT) 2>/dev/null && break
    sleep 1
done

# --- 3. Open cloudflared tunnel for the webhook receiver ---
nohup cloudflared tunnel --url "http://localhost:${WEBHOOK_PORT}" --no-autoupdate \
    > "$TUNNEL_LOG" 2>&1 &

WEBHOOK_URL=""
for i in $(seq 1 30); do
    WEBHOOK_URL=$(grep -oE 'https://[a-zA-Z0-9-]+\.trycloudflare\.com' \
        "$TUNNEL_LOG" 2>/dev/null | head -1 || true)
    [ -n "$WEBHOOK_URL" ] && break
    sleep 1
done

if [ -z "$WEBHOOK_URL" ]; then
    log "ERROR: failed to get webhook tunnel URL — feedback loop disabled"
    exit 1
fi
log "webhook tunnel: ${WEBHOOK_URL}"

# --- 4. Register Linear webhook (team-scoped, Comment events only) ---
HOOK_RESPONSE=$(linear_gql "$(jq -n \
    --arg url "$WEBHOOK_URL" \
    --arg teamId "$LINEAR_TEAM_ID" \
    --arg secret "$WEBHOOK_SECRET" \
    '{
        query: "mutation WebhookCreate($input: WebhookCreateInput!) { webhookCreate(input: $input) { success webhook { id } } }",
        variables: { input: { url: $url, teamId: $teamId, secret: $secret, resourceTypes: ["Comment"] } }
    }')")

HOOK_ID=$(printf '%s' "$HOOK_RESPONSE" | jq -r '.data.webhookCreate.webhook.id // empty')
if [ -z "$HOOK_ID" ]; then
    log "ERROR: Linear webhook registration failed — feedback loop disabled"
    log "response: $HOOK_RESPONSE"
    exit 1
fi
log "registered Linear webhook ${HOOK_ID} for issue ${LINEAR_ISSUE_IDENTIFIER}"

note "WATCHING"

# --- 5. Main loop: poll comment flag at 1 s; poll GitHub merge state every 30 s ---
LAST_MERGE_CHECK=0

while true; do
    sleep 1

    # Check for new Linear comment
    if [ -f "$COMMENT_FLAG" ]; then
        rm -f "$COMMENT_FLAG"
        log "new comment on ${LINEAR_ISSUE_IDENTIFIER} — spawning feedback session"
        note "WATCHING_FEEDBACK"

        DONE_FILE="/tmp/feedback-done-$$-$(date +%s)"
        WINDOW="feedback-$(date +%s)"
        rm -f "$DONE_FILE"

        tmux new-window -d -t "$SESSION" -n "$WINDOW" \
            "claude --permission-mode $PERM \"/muaddib-feedback ${LINEAR_ISSUE_IDENTIFIER}\"; touch $DONE_FILE"

        # Wait up to 45 min (15 s polls)
        for _ in $(seq 1 180); do
            [ -f "$DONE_FILE" ] && break
            tmux list-windows -t "$SESSION" 2>/dev/null | grep -q "$WINDOW" || break
            sleep 15
        done
        rm -f "$DONE_FILE" 2>/dev/null || true

        note "WATCHING"
        log "feedback session done — resuming watch"
    fi

    # Periodically check whether the PR was merged
    NOW=$(date +%s)
    if [ $((NOW - LAST_MERGE_CHECK)) -ge $MERGE_POLL_INTERVAL ]; then
        LAST_MERGE_CHECK=$NOW
        PR_STATE=$(gh pr view "$PR_NUMBER" --json state --jq '.state' 2>/dev/null || echo "UNKNOWN")
        if [ "$PR_STATE" = "MERGED" ] || [ "$PR_STATE" = "CLOSED" ]; then
            log "PR #${PR_NUMBER} is ${PR_STATE} — writing DONE_FINAL"
            note "DONE_FINAL"
            exit 0  # cleanup trap fires
        fi
    fi
done
