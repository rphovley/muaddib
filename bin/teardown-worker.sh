#!/usr/bin/env bash
# Stop a worker and remove its containers, volumes, env file, and status entry.
set -euo pipefail
FLEET_DIR="$(cd "$(dirname "$0")/.." && pwd)"
source "$FLEET_DIR/bin/read-config.sh"
WORKER="${1:?usage: teardown-worker.sh <worker-number>}"
PROJECT="${MUADDIB_PROJECT_NAME}-w${WORKER}"

# Compute the same values spawn-worker.sh uses so this script works standalone.
export WORKER_API_PORT=$((8089 + WORKER))
export WORKER_DB_PORT=$((5442 + WORKER))
export WORKER_ENV_FILE="$FLEET_DIR/.worker-${WORKER}.env"
export WORKER_INDEX="$WORKER"
export CLAUDE_SKILLS_DIR="${CLAUDE_SKILLS_DIR:-$HOME/.claude/skills}"
export HOST_TMPDIR="${TMPDIR:-/tmp}"
export HOST_DESKTOP="$HOME/Desktop"

STATUS_DIR="$FLEET_DIR/status"

# Read the worker's state before bringing the container down.
CURRENT_STATE="$(cut -d' ' -f1 "$STATUS_DIR/worker-${WORKER}.state" 2>/dev/null || true)"

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
        clients=$(docker exec "$WORKER_CID" tmux list-clients -t "w${WORKER}" 2>/dev/null | wc -l) || clients=0
        clients=$((clients + 0))
        [ "$clients" -eq 0 ] && break
        sleep 0.2
    done
    sleep 0.5  # small extra buffer for PTY buffer flush after last client drops
fi

docker compose -p "$PROJECT" -f "$FLEET_DIR/docker-compose.worker.yml" down -v

# Remove env file (always).
rm -f "$FLEET_DIR/.worker-${WORKER}.env"

if [ "$CURRENT_STATE" = "FAILED" ]; then
    TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
    DEST="$STATUS_DIR/failed/worker-${WORKER}-${TIMESTAMP}"
    mkdir -p "$DEST"
    for f in \
        "worker-${WORKER}.state" \
        "worker-${WORKER}.events" \
        "worker-${WORKER}-branch.log" \
        "worker-${WORKER}-fetch-ticket.log" \
        "worker-${WORKER}-servers.log" \
        "worker-${WORKER}-webhook.log" \
        "worker-${WORKER}-checks.log" \
        "worker-${WORKER}-tokens.json"; do
        [ -f "$STATUS_DIR/$f" ] && mv "$STATUS_DIR/$f" "$DEST/" || true
    done
    [ -d "$STATUS_DIR/.skills-${WORKER}" ] && mv "$STATUS_DIR/.skills-${WORKER}" "$DEST/" || true
    echo "✓ tore down ${PROJECT} — artifacts preserved at ${DEST}"
else
    rm -f "$STATUS_DIR/worker-${WORKER}.state" \
        "$STATUS_DIR/worker-${WORKER}.events" \
        "$STATUS_DIR/worker-${WORKER}-branch.log" \
        "$STATUS_DIR/worker-${WORKER}-fetch-ticket.log" \
        "$STATUS_DIR/worker-${WORKER}-servers.log" \
        "$STATUS_DIR/worker-${WORKER}-webhook.log" \
        "$STATUS_DIR/worker-${WORKER}-checks.log" \
        "$STATUS_DIR/worker-${WORKER}-tokens.json"
    rm -rf "$STATUS_DIR/.skills-${WORKER}"
    echo "✓ tore down ${PROJECT}"
fi
