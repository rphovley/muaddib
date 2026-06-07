#!/usr/bin/env bash
# branch — Script step in the feature workflow.
#
# Creates a fresh git branch from main using the ticket identifier + title.
# Fails fast if the working tree is dirty.
#
# Reads state (via env):  STATE_TICKET_IDENTIFIER, STATE_TICKET_TITLE
# Writes state:           branch

set -euo pipefail

: "${STATE_TICKET_IDENTIFIER:?branch.sh requires STATE_TICKET_IDENTIFIER}"
: "${WORKER_INDEX:?WORKER_INDEX not set}"

WORKER="$WORKER_INDEX"
REPO="${REPO_DIR:-/home/worker/repo}"
STATE_CLI="$REPO/muaddib/orchestrator/state-cli.js"

log() { echo "[branch w${WORKER}] $*"; }

cd "$REPO"

# ── 1. Guard: dirty tree ─────────────────────────────────────────────────────

if ! git diff --quiet || ! git diff --cached --quiet; then
    echo "ERROR: working tree has uncommitted changes — cannot branch" >&2
    git status >&2
    exit 1
fi

# ── 2. Build branch name ─────────────────────────────────────────────────────

ID_LOWER=$(printf '%s' "$STATE_TICKET_IDENTIFIER" | tr '[:upper:]' '[:lower:]')

SLUG=$(printf '%s' "${STATE_TICKET_TITLE:-}" \
    | tr '[:upper:]' '[:lower:]' \
    | sed 's/[^a-z0-9]/-/g; s/--*/-/g; s/^-//; s/-$//' \
    | cut -c1-40)

BRANCH="${ID_LOWER}${SLUG:+-${SLUG}}"
log "branch name: $BRANCH"

# ── 3. Branch from main ──────────────────────────────────────────────────────

git checkout main
git pull --rebase origin main
git checkout -B "$BRANCH"

# ── 4. Write state ───────────────────────────────────────────────────────────

node "$STATE_CLI" "$WORKER" set branch "$BRANCH"
log "done — branch: $BRANCH"
