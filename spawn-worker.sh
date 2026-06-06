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

# Build the shared worker image once if it doesn't exist. All workers share
# quotethat-worker:latest — nothing worker-specific is baked in. To force a
# rebuild (e.g. after lockfile changes): `docker rmi quotethat-worker:latest`.
if ! docker image inspect quotethat-worker:latest >/dev/null 2>&1; then
    echo "→ Building worker image (first run or image removed)…"
    docker build -f "$FLEET_DIR/Dockerfile.worker" -t quotethat-worker:latest "$REPO_ROOT"
fi

docker compose -p "$PROJECT" -f docker-compose.worker.yml up -d

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

# Events-file watcher: tails the JSONL event bus written by the orchestrator
# inside the container.
EVENTS_FILE="$FLEET_DIR/status/worker-${WORKER}.events"
(
    # Wait up to 60 s for the events file to appear (created at first orchestrator emit).
    for _i in $(seq 1 60); do
        [ -f "$EVENTS_FILE" ] && break
        sleep 1
    done
    [ -f "$EVENTS_FILE" ] || exit 0  # container exited before events were written

    # Parse orchestrator state from a JSONL line using node (always available).
    _parse_state() {
        node -e "
          try {
            const e = JSON.parse(process.argv[1]);
            if (e.job === 'orchestrator' && e.event === 'state_changed')
              process.stdout.write(e.payload.state || '');
          } catch (_) {}
        " "$1" 2>/dev/null || true
    }

    while IFS= read -r _ev_line; do
        _state=$(_parse_state "$_ev_line")
        [ -z "$_state" ] && continue

        case "$_state" in
            WAITING_FOR_INPUT) osascript -e "display notification \"Questions posted to Linear — needs your answers\" with title \"muaddib: worker-${WORKER}\" sound name \"Glass\"" 2>/dev/null || true ;;
            BLOCKED)           osascript -e "display notification \"Waiting for your input\" with title \"muaddib: worker-${WORKER}\" sound name \"Glass\"" 2>/dev/null || true ;;
            WATCHING)          osascript -e "display notification \"Preview live — watching for Linear feedback\" with title \"muaddib: worker-${WORKER}\" sound name \"Glass\"" 2>/dev/null || true ;;
            WATCHING_FEEDBACK) osascript -e "display notification \"Addressing PR feedback\" with title \"muaddib: worker-${WORKER}\" sound name \"Glass\"" 2>/dev/null || true ;;
            DONE_FINAL)        osascript -e "display notification \"PR merged — preview torn down ✓\" with title \"muaddib: worker-${WORKER}\" sound name \"Glass\"" 2>/dev/null || true ;;
            FAILED)            osascript -e "display notification \"Worker failed — check logs\" with title \"muaddib: worker-${WORKER}\" sound name \"Glass\"" 2>/dev/null || true ;;
        esac

        case "$_state" in
            DONE|DONE_FINAL|FAILED)
                echo "→ Worker ${WORKER} finished (${_state}) — tearing down..."
                "$FLEET_DIR/teardown-worker.sh" "$WORKER" 2>/dev/null || true
                break
                ;;
        esac
    done < <(tail -n 0 -f "$EVENTS_FILE" 2>/dev/null)
) &
disown $!

# Drop straight into the agent's interactive session when we have a terminal.
# Ctrl-b then d detaches and leaves the worker running. Opt out with
# MUADIB_NO_ATTACH=1 (e.g. when fire-and-forging several workers from a script).
if [ "${MUADIB_NO_ATTACH:-0}" != "1" ] && [ -t 0 ] && [ -t 1 ]; then
    echo "  Attaching — Ctrl-b then d to detach (worker keeps running)."
    echo "  Re-attach: ./attach.sh ${WORKER}  ·  Monitor: ./attend.sh  ·  Stop: ./teardown-worker.sh ${WORKER}"
    docker exec -it "$(worker_cid)" tmux attach -t "w${WORKER}" || true
    # After detach or task completion, teardown immediately if the task is done.
    # (The background watcher above handles the no-attach case within ~5 s.)
    state="$(cut -d' ' -f1 "$FLEET_DIR/status/worker-${WORKER}.state" 2>/dev/null || echo "")"
    if [ "$state" = "DONE" ] || [ "$state" = "FAILED" ]; then
        echo "→ Task complete — tearing down worker ${WORKER}..."
        "$FLEET_DIR/teardown-worker.sh" "$WORKER" 2>/dev/null || true
    fi
    exit 0
fi

cat <<EOF
  Attach    : ./attach.sh ${WORKER}
  Monitor   : ./attend.sh
  Tear down : ./teardown-worker.sh ${WORKER}
EOF
