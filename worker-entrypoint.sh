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
# Rewrite SSH submodule URLs to HTTPS so the GitHub token works (no SSH key in container).
git config --global url."https://x-access-token:${GITHUB_TOKEN}@github.com/".insteadOf "git@github.com:"
git submodule update --init --recursive --force

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

# Run the project hook (if present). Projects drop their own setup logic here
# (e.g. materializing secrets, writing config files) instead of baking it into
# this entrypoint. The hook receives the full worker env.
HOOK="$WORKDIR/.muaddib/hooks/on-worker-start.sh"
if [ -x "$HOOK" ]; then
    bash "$HOOK"
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

# Materialize the inner-tmux prefix binding fresh on every boot, before any tmux
# server starts. ~/.tmux.conf sources this file (source-file -q), so both the
# task-mode and interactive `new-session` calls below inherit the rebind. Writing
# it fresh (`>`, never append) guarantees a manifest change or restart never leaves
# a stale binding behind. See read-config.sh's MUADDIB_TMUX_PREFIX (default "C-w")
# for why: herdr's outer pane also uses C-b, so the nested session needs a
# non-colliding prefix.
cat > /home/worker/.tmux-prefix.conf <<EOF
set -g prefix ${MUADDIB_TMUX_PREFIX}
unbind C-b
bind ${MUADDIB_TMUX_PREFIX} send-prefix
EOF

# --- resolve lavish bind host (tested by scripts/test-lavish-bind.sh) ---------
# lavish-axi (the sketch review loop) refuses to bind a wildcard address and
# silently downgrades any 0.0.0.0 request to 127.0.0.1, which Docker's port
# publish (${WORKER_SKETCH_PORT}:4387 in docker-compose.worker.yml) can't reach
# through the container's network namespace — the operator gets ERR_CONNECTION_RESET.
# Bind lavish to the container's own routable IPv4 (a specific, non-wildcard
# address lavish accepts, and exactly what the port publish DNATs to) so the
# published sketch port works. Exported before the task/interactive branch so
# every descendant — orchestrator, job, `claude`, `npx lavish-axi` — inherits it
# in both modes. The operator-facing URL still uses `localhost`; lavish's
# Host-header allow list always includes localhost.
#
# Prefer `ip route get`: it reports the source IPv4 the kernel actually uses to
# leave the container, i.e. the address the port publish forwards to. Avoid
# `hostname -i` — it's unreliable in a container, often printing 127.0.1.1 (from
# /etc/hosts) or an IPv6 address first, either of which silently reintroduces the
# unreachable-bind bug. Fall back only to the IPv4-only `hostname -I`.
LAVISH_AXI_HOST="$(ip -4 route get 1 2>/dev/null \
    | awk '{for (i = 1; i <= NF; i++) if ($i == "src") { print $(i + 1); exit }}')"
if [ -z "$LAVISH_AXI_HOST" ]; then
    LAVISH_AXI_HOST="$(hostname -I 2>/dev/null | tr ' ' '\n' \
        | grep -Ev '^(127\.|169\.254\.)' | grep -E '^[0-9]+(\.[0-9]+){3}$' | head -1)"
fi
# Fail loud (per commit 3c00882) rather than export an empty / loopback / IPv6
# value that would silently downgrade lavish back to an unreachable bind. Note a
# bare `export LAVISH_AXI_HOST="$(...)"` would let `set -e` mask a failed
# resolution (the assignment's status is the substitution's, but export is a
# special builtin), so resolve into the variable first, then validate explicitly.
case "$LAVISH_AXI_HOST" in
    ""|127.*|0.0.0.0|::1|*:*)
        echo "✗ could not resolve a routable IPv4 for LAVISH_AXI_HOST (got '${LAVISH_AXI_HOST:-<empty>}')" >&2
        exit 1 ;;
esac
export LAVISH_AXI_HOST
echo "→ LAVISH_AXI_HOST=$LAVISH_AXI_HOST"
# --- end resolve lavish bind host ---------------------------------------------

if [ -n "${TASK:-}" ]; then
    # Task mode: hand off to the orchestrator. Create a bare tmux session for
    # job windows, then exec the orchestrator as the container's main process.
    # The orchestrator owns the state machine (BOOTING → READY → … → DONE).
    tmux new-session -d -s "$SESSION"
    export REPO_DIR="$WORKDIR"
    echo "Worker ${WORKER_INDEX} starting orchestrator on branch ${BRANCH}."
    echo "Attach: docker compose -p ${MUADDIB_PROJECT_NAME}-w${WORKER_INDEX} exec worker tmux attach -t ${SESSION}"
    exec node "$MUADDIB_ROOT/orchestrator/orchestrator.js"
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
    echo "Attach: docker compose -p ${MUADDIB_PROJECT_NAME}-w${WORKER_INDEX} exec worker tmux attach -t ${SESSION}"
    tail -f /dev/null
fi
