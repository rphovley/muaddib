#!/usr/bin/env bash
# fetch-ticket — Script step in the feature workflow.
#
# Calls the Linear GraphQL API to fetch the ticket (and its comments) for the
# issue identified in $TASK. Saves the full response to a temp JSON file that
# downstream Claude steps can read, then writes key fields to worker state.
#
# If a "## Plan" comment is already present (on this ticket or its parent),
# copies the plan body to .muaddib/plan.md and sets plan_status=found so the
# analyze-ticket step is skipped.
#
# Required env: LINEAR_API_KEY, TASK (Linear issue URL), WORKER_INDEX
# Writes state:  ticket_identifier, ticket_url, ticket_title, plan_status

set -euo pipefail

: "${LINEAR_API_KEY:?LINEAR_API_KEY not set — add it to non-prod.env}"
: "${TASK:?TASK not set}"
: "${WORKER_INDEX:?WORKER_INDEX not set}"

WORKER="$WORKER_INDEX"
REPO="${REPO_DIR:-/home/worker/repo}"
STATE_CLI="$REPO/muaddib/orchestrator/state-cli.js"
TICKET_JSON="/tmp/ticket-${WORKER}.json"

log() { echo "[fetch-ticket w${WORKER}] $*"; }

# ── 1. Extract identifier from TASK URL ──────────────────────────────────────

IDENTIFIER=$(printf '%s' "$TASK" | grep -oE '[A-Z]+-[0-9]+' | head -1 || true)
if [ -z "$IDENTIFIER" ]; then
    echo "ERROR: could not extract ticket identifier from TASK=${TASK}" >&2
    exit 1
fi
log "identifier: $IDENTIFIER"

# ── 2. Fetch issue + comments from Linear ────────────────────────────────────

linear_gql() {
    curl -sf -X POST https://api.linear.app/graphql \
        -H "Authorization: ${LINEAR_API_KEY}" \
        -H "Content-Type: application/json" \
        --data-binary "$1"
}

QUERY=$(jq -n --arg id "$IDENTIFIER" '{
    "query": "query($id:String!){ issue(id:$id){ id identifier title description url parentId comments { nodes { id body createdAt } } } }",
    "variables": {"id": $id}
}')

RESPONSE=$(linear_gql "$QUERY")

ISSUE_ID=$(printf '%s' "$RESPONSE" | jq -r '.data.issue.id // empty')
if [ -z "$ISSUE_ID" ]; then
    echo "ERROR: Linear returned no issue for ${IDENTIFIER}" >&2
    printf '%s\n' "$RESPONSE" >&2
    exit 1
fi

printf '%s\n' "$RESPONSE" > "$TICKET_JSON"
log "saved ticket JSON to $TICKET_JSON"

TICKET_URL=$(printf '%s'   "$RESPONSE" | jq -r '.data.issue.url')
TICKET_TITLE=$(printf '%s' "$RESPONSE" | jq -r '.data.issue.title')
PARENT_ID=$(printf '%s'    "$RESPONSE" | jq -r '.data.issue.parentId // empty')

# ── 3. Check for ## Plan comment ─────────────────────────────────────────────

find_plan() {
    local resp="$1"
    printf '%s' "$resp" | jq -r '
        [ .data.issue.comments.nodes[]
          | select(.body | startswith("## Plan")) ]
        | sort_by(.createdAt) | last | .body // empty
    ' 2>/dev/null || true
}

PLAN_BODY=$(find_plan "$RESPONSE")

if [ -z "$PLAN_BODY" ] && [ -n "$PARENT_ID" ]; then
    log "no plan on ${IDENTIFIER} — checking parent ${PARENT_ID}..."
    PARENT_QUERY=$(jq -n --arg id "$PARENT_ID" '{
        "query": "query($id:String!){ issue(id:$id){ comments { nodes { body createdAt } } } }",
        "variables": {"id": $id}
    }')
    PARENT_RESPONSE=$(linear_gql "$PARENT_QUERY")
    PLAN_BODY=$(printf '%s' "$PARENT_RESPONSE" | jq -r '
        [ .data.issue.comments.nodes[]
          | select(.body | startswith("## Plan")) ]
        | sort_by(.createdAt) | last | .body // empty
    ' 2>/dev/null || true)
fi

# ── 4. Write plan to local file if found ─────────────────────────────────────

PLAN_STATUS="missing"

if [ -n "$PLAN_BODY" ]; then
    PLAN_STATUS="found"
    mkdir -p "$REPO/.muaddib"
    printf '%s\n' "$PLAN_BODY" > "$REPO/.muaddib/plan.md"
    log "plan found → wrote to .muaddib/plan.md"
else
    log "no plan comment found — analyze-ticket step will create one"
fi

# ── 5. Write state ───────────────────────────────────────────────────────────

node "$STATE_CLI" "$WORKER" set ticket_identifier "$IDENTIFIER"
node "$STATE_CLI" "$WORKER" set ticket_url        "$TICKET_URL"
node "$STATE_CLI" "$WORKER" set ticket_title      "$TICKET_TITLE"
node "$STATE_CLI" "$WORKER" set plan_status       "$PLAN_STATUS"

log "done — ${IDENTIFIER}: ${TICKET_TITLE} (plan: ${PLAN_STATUS})"
