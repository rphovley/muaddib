#!/usr/bin/env bash
# Provision and launch one isolated worker.
#   ./spawn-worker.sh <worker-number> [initial task prompt...]
#
# Ports (per your spec): API = 8090 + (N-1), Postgres = 5442 + (N-1).
# Secrets: subscription + GitHub tokens come from your shell env; non-prod app
# secrets come from a local non-prod.env, injected as VALUES into the container.
set -euo pipefail

FLEET_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$FLEET_DIR/.." && pwd)"
cd "$FLEET_DIR"

WORKER="${1:?usage: spawn-worker.sh <worker-number> [task...]}"
shift || true
TASK="${*:-}"
[[ "$WORKER" =~ ^[0-9]+$ ]] || { echo "worker number must be an integer" >&2; exit 1; }

API_PORT=$((8089 + WORKER)) # worker 1 -> 8090
DB_PORT=$((5441 + WORKER))  # worker 1 -> 5442
PROJECT="quotethat-w${WORKER}"
BRANCH="agent/w${WORKER}/$(date -u +%Y%m%d-%H%M%S)"

# --- host-provided inputs ---
REPO_URL="${REPO_URL:-$(git -C "$REPO_ROOT" remote get-url origin \
    | sed -E 's#^git@github.com:#github.com/#; s#^https://##; s#^http://##')}"
CLAUDE_SKILLS_DIR="${CLAUDE_SKILLS_DIR:-$HOME/.claude/skills}"

# Merge personal skills from host with fleet skills from this repo. Fleet
# skills take precedence so /muaddib and its variants are always current.
MERGED_SKILLS="$FLEET_DIR/status/.skills-${WORKER}"
rm -rf "$MERGED_SKILLS" && mkdir -p "$MERGED_SKILLS"
[ -d "$CLAUDE_SKILLS_DIR" ] && cp -r "$CLAUDE_SKILLS_DIR/." "$MERGED_SKILLS/"
cp -r "$FLEET_DIR/claude/skills/." "$MERGED_SKILLS/"
CLAUDE_SKILLS_DIR="$MERGED_SKILLS"

: "${CLAUDE_CODE_OAUTH_TOKEN:?export your subscription token first: run 'claude setup-token'}"
: "${GITHUB_TOKEN:?export a repo-scoped GitHub token (push branches + open PRs only)}"

# --- non-prod app secrets: a local dotenv file (dev/local values only) ---
SHARED_ENV="${WORKER_SHARED_ENV:-$FLEET_DIR/non-prod.env}"
[ -f "$SHARED_ENV" ] || {
    echo "missing ${SHARED_ENV} — copy non-prod.env.example to non-prod.env and fill it in" >&2
    exit 1
}
ENV_FILE="$FLEET_DIR/.worker-${WORKER}.env"
cp "$SHARED_ENV" "$ENV_FILE"

# Append worker-specific dynamic values. PG_*/DATABASE_URL are force-overridden
# in compose to the local sidecar, so DB connection can't point at prod here.
cat >>"$ENV_FILE" <<EOF
CLAUDE_CODE_OAUTH_TOKEN=${CLAUDE_CODE_OAUTH_TOKEN}
GITHUB_TOKEN=${GITHUB_TOKEN}
REPO_URL=${REPO_URL}
BRANCH=${BRANCH}
WORKER_INDEX=${WORKER}
TASK=${TASK}
CLAUDE_PERMISSION_MODE=${CLAUDE_PERMISSION_MODE:-bypassPermissions}
NODE_ENV=development
EOF

# Let LINEAR_API_KEY come from the shell env too (overrides non-prod.env if set).
[ -n "${LINEAR_API_KEY:-}" ] && echo "LINEAR_API_KEY=${LINEAR_API_KEY}" >>"$ENV_FILE"

chmod 600 "$ENV_FILE"

mkdir -p "$FLEET_DIR/status" && chmod 777 "$FLEET_DIR/status"

export WORKER_API_PORT="$API_PORT" WORKER_DB_PORT="$DB_PORT" \
    WORKER_ENV_FILE="$ENV_FILE" WORKER_INDEX="$WORKER" \
    CLAUDE_SKILLS_DIR="$CLAUDE_SKILLS_DIR" \
    HOST_TMPDIR="${TMPDIR:-/tmp}" \
    HOST_DESKTOP="$HOME/Desktop"

STATE_FILE="$FLEET_DIR/status/worker-${WORKER}.state"
: >"$STATE_FILE" # clear any stale state from a previous run

echo "→ Spawning ${PROJECT}: API :${API_PORT}  DB :${DB_PORT}  branch ${BRANCH}"
docker compose -p "$PROJECT" -f docker-compose.worker.yml up -d --build

# Wait for the worker to finish provisioning (clone + deps + MCP). If it dies,
# surface its logs to THIS console instead of reporting a false "up".
worker_cid() { docker ps -aq --filter "label=com.docker.compose.project=${PROJECT}" --filter "name=worker" | head -1; }
echo "→ provisioning (clone + deps + MCP)…"
SECONDS=0
while :; do
    [ "$(cut -d' ' -f1 "$STATE_FILE" 2>/dev/null || true)" = "READY" ] && break
    if [ -z "$(docker ps -q --filter "label=com.docker.compose.project=${PROJECT}" --filter "name=worker")" ]; then
        {
            echo
            echo "✗ Worker ${WORKER} exited during provisioning. Last log lines:"
            echo "────────────────────────────────────────────────────────────"
            docker logs "$(worker_cid)" 2>&1 | tail -30
            echo "────────────────────────────────────────────────────────────"
            echo "Fix the cause, then:  ./teardown-worker.sh ${WORKER}  &&  re-run."
        } >&2
        exit 1
    fi
    if [ "$SECONDS" -ge 300 ]; then
        echo "✗ Worker ${WORKER} not READY after ${SECONDS}s. Recent logs:" >&2
        docker logs "$(worker_cid)" 2>&1 | tail -30 >&2
        echo "(container still running — attach to inspect)" >&2
        exit 1
    fi
    sleep 2
done

echo
echo "✓ Worker ${WORKER} up and READY."

PREVIEW_FILE="$FLEET_DIR/status/worker-${WORKER}.preview"
if [ -f "$PREVIEW_FILE" ]; then
    echo "  Preview: $(cat "$PREVIEW_FILE")"
fi

# Background watcher: tear down automatically once the container exits (task
# done in TASK mode, or the user stops it). Harmless for interactive workers —
# it just fires when the container is already stopped.
CID=$(worker_cid)
( docker wait "$CID" >/dev/null 2>&1 || true
  echo "→ Worker ${WORKER} container exited — tearing down..."
  state="$(cut -d' ' -f1 "$FLEET_DIR/status/worker-${WORKER}.state" 2>/dev/null || echo "UNKNOWN")"
  case "$state" in
    DONE)    msg="Task complete ✓" ;;
    FAILED)  msg="Worker failed — check logs" ;;
    *)       msg="Worker stopped (state: $state)" ;;
  esac
  osascript -e "display notification \"$msg\" with title \"muaddib: worker-${WORKER}\" sound name \"Glass\"" 2>/dev/null || true
  "$FLEET_DIR/teardown-worker.sh" "$WORKER" 2>/dev/null || true ) &
disown $!

# Background PR lifecycle watcher: posts the preview URL as a comment when the
# PR opens, then tears the worker down when the PR is merged or closed.
# Runs entirely on the host using the GITHUB_TOKEN already in scope.
(
    TUNNEL_URL=""
    for _ in $(seq 1 30); do
        [ -f "$PREVIEW_FILE" ] && TUNNEL_URL="$(cat "$PREVIEW_FILE")" && break
        sleep 2
    done
    [ -z "$TUNNEL_URL" ] && { echo "→ PR watcher: no preview URL — skipping"; exit 0; }

    # Wait up to 20 min for the agent to open a PR on this branch.
    PR_URL=""
    for _ in $(seq 1 240); do
        PR_URL=$(gh pr list --head "$BRANCH" --json url -q '.[0].url' 2>/dev/null || true)
        [ -n "$PR_URL" ] && break
        sleep 5
    done
    [ -z "$PR_URL" ] && { echo "→ PR watcher: no PR opened after 20 min — exiting"; exit 0; }

    gh pr comment "$PR_URL" --body "**Preview environment:** $TUNNEL_URL" 2>/dev/null \
        && echo "→ Posted preview URL to $PR_URL"

    # Poll until the PR is merged or closed, then teardown.
    while true; do
        PR_STATE=$(gh pr view "$PR_URL" --json state -q '.state' 2>/dev/null || echo "")
        case "$PR_STATE" in
            MERGED|CLOSED)
                echo "→ PR ${PR_STATE} — tearing down worker ${WORKER}…"
                "$FLEET_DIR/teardown-worker.sh" "$WORKER" 2>/dev/null || true
                exit 0 ;;
        esac
        sleep 30
    done
) &
disown $!

# Drop straight into the agent's interactive session when we have a terminal.
# Ctrl-b then d detaches and leaves the worker running. Opt out with
# MUADIB_NO_ATTACH=1 (e.g. when fire-and-forging several workers from a script).
if [ "${MUADIB_NO_ATTACH:-0}" != "1" ] && [ -t 0 ] && [ -t 1 ]; then
    echo "  Attaching — Ctrl-b then d to detach (worker keeps running)."
    echo "  Re-attach: ./attach.sh ${WORKER}  ·  Monitor: ./attend.sh  ·  Stop: ./teardown-worker.sh ${WORKER}"
    exec docker exec -it "$(worker_cid)" tmux attach -t "w${WORKER}"
fi

cat <<EOF
  Attach    : ./attach.sh ${WORKER}
  Monitor   : ./attend.sh
  Tear down : ./teardown-worker.sh ${WORKER}
EOF
