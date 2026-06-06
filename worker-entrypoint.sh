#!/usr/bin/env bash
# Runs as PID-ish entry of the worker container. Fetches the repo source onto a
# new branch OVER the image's pre-baked node_modules, then launches an attachable
# tmux session running Claude Code with broad permissions. Keeps the container
# alive so you can attach on demand.
set -euo pipefail

: "${REPO_URL:?REPO_URL not set}"
: "${BRANCH:?BRANCH not set}"
: "${GITHUB_TOKEN:?GITHUB_TOKEN not set}"
: "${WORKER_INDEX:?WORKER_INDEX not set}"

STATUS_FILE="/var/run/agent-status/worker-${WORKER_INDEX}.state"
note() { printf '%s %s\n' "$1" "$(date -u +%FT%TZ)" >"$STATUS_FILE" 2>/dev/null || true; }

# On ANY failed command (set -e), record FAILED + the offending command, so the
# container doesn't just disappear: spawn-worker.sh dumps these logs and
# attend.sh shows FAILED instead of a stale PROVISIONING.
trap 'rc=$?; echo "✗ provisioning FAILED (exit $rc) at line ${BASH_LINENO[0]}: ${BASH_COMMAND}" >&2; note "FAILED rc=$rc"; exit $rc' ERR

note "PROVISIONING"

# The image already contains the full repo source + .git (baked at build time).
# Just authenticate the remote and fetch the delta since the image was built —
# typically zero or a handful of commits, much faster than a fresh clone.
WORKDIR=/home/worker/repo
cd "$WORKDIR"
git remote set-url origin "https://x-access-token:${GITHUB_TOKEN}@${REPO_URL}"
git config user.name "agent-worker-${WORKER_INDEX}"
git config user.email "agent+w${WORKER_INDEX}@quotethat.local"
git fetch --depth 1 origin main
git checkout -f -B "$BRANCH" FETCH_HEAD

# Refresh deps ONLY for projects whose lockfile drifted from the baked one
# (the common case is no drift → zero work).
for p in projects/api projects/portal projects/homeowner projects/app_install; do
    [ -d "$p/node_modules" ] || continue
    baked="/home/worker/.deps-lock/$p/package-lock.json"
    if [ -f "$p/package-lock.json" ] && [ -f "$baked" ] \
        && ! cmp -s "$p/package-lock.json" "$baked"; then
        echo "→ lockfile drift in $p — running npm ci"
        (cd "$p" && npm ci)
    fi
done

# Optional: materialize the dev Firebase service-account FILE (it's gitignored,
# so it isn't in the fresh clone). Only needed when the agent runs the dev
# server — test mode skips Firebase init. Provide it base64-encoded in the GCP
# bundle as FIREBASE_DEV_SA_JSON_B64.
if [ -n "${FIREBASE_DEV_SA_JSON_B64:-}" ]; then
    KEYS_DIR="projects/api/src/config/keys"
    FNAME="${FIREBASE_DEV_SA_FILENAME:-dev.quotethat-test-firebase-adminsdk-fbsvc-54518044be.json}"
    mkdir -p "$KEYS_DIR"
    printf '%s' "$FIREBASE_DEV_SA_JSON_B64" | base64 -d >"$KEYS_DIR/$FNAME"
    echo "→ wrote dev Firebase service account to $KEYS_DIR/$FNAME"
fi

# Wire the Linear MCP via API key (Bearer header) — no OAuth/browser. Same
# endpoint + tool names as the host's OAuth setup, so muaddib's mcp__linear__*
# calls work unchanged. User scope keeps it out of the repo clone.
if [ -n "${LINEAR_API_KEY:-}" ]; then
    if claude mcp add --scope user --transport http linear \
        https://mcp.linear.app/mcp \
        --header "Authorization: Bearer ${LINEAR_API_KEY}" >/dev/null 2>&1; then
        echo "→ Linear MCP configured (API key)"
    else
        echo "⚠ failed to configure Linear MCP — muaddib ticket read/post-back will not work"
    fi
fi

# Keep lastOnboardingVersion in sync with whatever version is installed so
# Claude never shows the theme-picker / welcome screen after a version bump.
CLAUDE_VER=$(claude --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)
if [ -n "$CLAUDE_VER" ]; then
    jq --arg v "$CLAUDE_VER" '.lastOnboardingVersion = $v' ~/.claude.json > /tmp/claude.json.tmp \
        && mv /tmp/claude.json.tmp ~/.claude.json
    echo "→ lastOnboardingVersion patched to $CLAUDE_VER"
fi

SESSION="w${WORKER_INDEX}"

if [ -n "${TASK:-}" ]; then
    # Task mode: hand off to the orchestrator. Create a bare tmux session for
    # job windows, then exec the orchestrator as the container's main process.
    # The orchestrator owns the state machine (BOOTING → READY → … → DONE).
    tmux new-session -d -s "$SESSION"
    export REPO_DIR="$WORKDIR"
    echo "Worker ${WORKER_INDEX} starting orchestrator on branch ${BRANCH}."
    echo "Attach: docker compose -p quotethat-w${WORKER_INDEX} exec worker tmux attach -t ${SESSION}"
    exec node "$WORKDIR/muaddib/lib/orchestrator.js"
else
    # Interactive mode: drop to bash after Claude exits, keep container alive.
    note "READY"
    PERM="${CLAUDE_PERMISSION_MODE:-bypassPermissions}"
    if [ "$PERM" = "bypassPermissions" ]; then
        PERM_FLAG="--dangerously-skip-permissions"
    else
        PERM_FLAG="--permission-mode $PERM"
    fi
    tmux new-session -d -s "$SESSION" \
        "claude $PERM_FLAG; exec bash"
    echo "Worker ${WORKER_INDEX} ready (interactive) on branch ${BRANCH}."
    echo "Attach: docker compose -p quotethat-w${WORKER_INDEX} exec worker tmux attach -t ${SESSION}"
    tail -f /dev/null
fi
