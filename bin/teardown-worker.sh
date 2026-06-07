#!/usr/bin/env bash
# Stop a worker and remove its containers, volumes, env file, and status entry.
set -euo pipefail
FLEET_DIR="$(cd "$(dirname "$0")/.." && pwd)"
WORKER="${1:?usage: teardown-worker.sh <worker-number>}"
PROJECT="quotethat-w${WORKER}"

# Compute the same values spawn-worker.sh uses so this script works standalone.
export WORKER_API_PORT=$((8089 + WORKER))
export WORKER_DB_PORT=$((5441 + WORKER))
export WORKER_ENV_FILE="$FLEET_DIR/.worker-${WORKER}.env"
export WORKER_INDEX="$WORKER"
export CLAUDE_SKILLS_DIR="${CLAUDE_SKILLS_DIR:-$HOME/.claude/skills}"
export HOST_TMPDIR="${TMPDIR:-/tmp}"
export HOST_DESKTOP="$HOME/Desktop"

# Detach any attached tmux clients before killing the container so tmux can
# send its own cleanup sequences and leave the host terminal in a clean state.
# Then wait for the docker exec process to exit before bringing the container
# down — without the wait, compose down races the PTY flush and the host
# terminal is left with mouse-tracking escape sequences still active.
WORKER_CID=$(docker compose -p "$PROJECT" -f "$FLEET_DIR/docker-compose.worker.yml" ps -q worker 2>/dev/null | head -1)
if [ -n "$WORKER_CID" ]; then
    docker exec "$WORKER_CID" tmux detach-client -s "w${WORKER}" 2>/dev/null || true
    # Poll until no clients remain (PTY has flushed its cleanup sequences) or we
    # time out. This is the window where tmux sends \033[?1000l etc. to the host.
    for _i in $(seq 1 20); do
        clients=$(docker exec "$WORKER_CID" tmux list-clients -t "w${WORKER}" 2>/dev/null | wc -l || echo 0)
        [ "$clients" -eq 0 ] && break
        sleep 0.2
    done
    sleep 0.5  # small extra buffer for PTY buffer flush after last client drops
fi

docker compose -p "$PROJECT" -f "$FLEET_DIR/docker-compose.worker.yml" down -v
rm -f "$FLEET_DIR/.worker-${WORKER}.env" \
    "$FLEET_DIR/status/worker-${WORKER}.state"
rm -rf "$FLEET_DIR/status/.skills-${WORKER}"
echo "✓ tore down ${PROJECT}"
