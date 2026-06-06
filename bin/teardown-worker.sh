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
WORKER_CID=$(docker compose -p "$PROJECT" -f "$FLEET_DIR/docker-compose.worker.yml" ps -q worker 2>/dev/null | head -1)
[ -n "$WORKER_CID" ] && docker exec "$WORKER_CID" tmux detach-client -s "w${WORKER}" 2>/dev/null || true

docker compose -p "$PROJECT" -f "$FLEET_DIR/docker-compose.worker.yml" down -v
rm -f "$FLEET_DIR/.worker-${WORKER}.env" \
    "$FLEET_DIR/status/worker-${WORKER}.state"
rm -rf "$FLEET_DIR/status/.skills-${WORKER}"
echo "✓ tore down ${PROJECT}"
