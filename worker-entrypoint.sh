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

# Pin the worker index to a fixed, container-local path. Each container is
# dedicated to exactly one worker for its whole life (spawn-worker.sh names
# the docker-compose project itself `-w${WORKER_INDEX}`), so this value never
# changes after boot. Skills read it as a fallback when $WORKER_INDEX isn't
# present in a given shell — e.g. a re-exec/background path that doesn't
# inherit the per-job wrapper's `export WORKER_INDEX=...` (see job.js) —
# instead of silently defaulting to the wrong worker.
echo -n "$WORKER_INDEX" > /tmp/worker-index

STATUS_FILE="/var/run/agent-status/worker-${WORKER_INDEX}.state"
note() { printf '%s %s\n' "$1" "$(date -u +%FT%TZ)" >"$STATUS_FILE" 2>/dev/null || true; }

# Temporary timing instrumentation for measuring pool ROI (see issue #115).
# Appends to the same file spawn-worker.sh writes on the host side, via the
# status/ bind mount — one unified timeline per dispatch. Diagnostic-only;
# safe to delete this block (and its call sites below) once measured.
TIMING_FILE="/var/run/agent-status/worker-${WORKER_INDEX}-timing.log"
mark() { printf '%s\t%s\t%s\n' "$1" "$(date -u +%s)" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >>"$TIMING_FILE" 2>/dev/null || true; }
mark entrypoint_start

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
git config user.email "agent+w${WORKER_INDEX}@${MUADDIB_PROJECT_NAME:-quotethat}.local"
git fetch --depth 1 origin main
git checkout -f -B "$BRANCH" FETCH_HEAD
mark git_checked_out
# Rewrite SSH submodule URLs to HTTPS so the GitHub token works (no SSH key in container).
git config --global url."https://x-access-token:${GITHUB_TOKEN}@github.com/".insteadOf "git@github.com:"
git submodule update --init --recursive --force
mark submodules_updated

# Consuming projects have muaddib checked out as a nested submodule
# (WORKDIR/muaddib); muaddib building itself has no such nesting — the
# clone IS muaddib, so its own bin/ sits directly at WORKDIR.
if [ -d "$WORKDIR/muaddib" ]; then
    MUADDIB_ROOT="$WORKDIR/muaddib"
else
    MUADDIB_ROOT="$WORKDIR"
fi
source "$MUADDIB_ROOT/bin/read-config.sh"

# Refresh deps ONLY for projects whose lockfile drifted from the baked one
# (the common case is no drift → zero work).
while IFS= read -r p; do
    [ -d "$p/node_modules" ] || continue
    baked="/home/worker/.deps-lock/$p/package-lock.json"
    if [ -f "$p/package-lock.json" ] && [ -f "$baked" ] \
        && ! cmp -s "$p/package-lock.json" "$baked"; then
        echo "→ lockfile drift in $p — running npm ci"
        (cd "$p" && npm ci)
    fi
done < <(jq -r '.projects[].path' "${MUADDIB_CONFIG_FILE:-$WORKDIR/.muaddib/manifest.json}")
mark deps_checked

# Run the project hook (if present). Projects drop their own setup logic here
# (e.g. materializing secrets, writing config files) instead of baking it into
# this entrypoint. The hook receives the full worker env.
HOOK="$WORKDIR/.muaddib/hooks/on-worker-start.sh"
if [ -x "$HOOK" ]; then
    bash "$HOOK"
fi
mark hook_done

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
mark mcp_wired

# Keep lastOnboardingVersion in sync with whatever version is installed so
# Claude never shows the theme-picker / welcome screen after a version bump.
CLAUDE_VER=$(claude --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)
if [ -n "$CLAUDE_VER" ]; then
    jq --arg v "$CLAUDE_VER" '.lastOnboardingVersion = $v' ~/.claude.json > /tmp/claude.json.tmp \
        && mv /tmp/claude.json.tmp ~/.claude.json
    echo "→ lastOnboardingVersion patched to $CLAUDE_VER"
fi
mark entrypoint_provisioning_done

SESSION="w${WORKER_INDEX}"

if [ -n "${TASK:-}" ]; then
    # Task mode: hand off to the orchestrator. Create a bare tmux session for
    # job windows, then exec the orchestrator as the container's main process.
    # The orchestrator owns the state machine (BOOTING → READY → … → DONE).
    mark orchestrator_handoff
    tmux new-session -d -s "$SESSION"
    export REPO_DIR="$WORKDIR"
    echo "Worker ${WORKER_INDEX} starting orchestrator on branch ${BRANCH}."
    echo "Attach: docker compose -p ${MUADDIB_PROJECT_NAME}-w${WORKER_INDEX} exec worker tmux attach -t ${SESSION}"
    exec node "$MUADDIB_ROOT/orchestrator/orchestrator.js"
else
    # Interactive mode: drop to bash after Claude exits, keep container alive.
    mark interactive_ready
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
    echo "Attach: docker compose -p ${MUADDIB_PROJECT_NAME}-w${WORKER_INDEX} exec worker tmux attach -t ${SESSION}"
    tail -f /dev/null
fi
