#!/usr/bin/env bash
# Dispatch daemon entry point — manages the daemon via Docker Compose.
#   ./dispatch.sh          — foreground (Ctrl-C stops cleanly)
#   ./dispatch.sh --bg     — start detached (restart: unless-stopped)
#   ./dispatch.sh --stop   — deregister webhook, remove container
set -euo pipefail

FLEET_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$FLEET_DIR/bin/read-config.sh"
COMPOSE_FILE="${FLEET_DIR}/docker-compose.dispatch.yml"
PROJECT="${MUADDIB_PROJECT_NAME}-dispatch"
export MUADDIB_DISPATCH_IMAGE="${MUADDIB_PROJECT_NAME}-dispatch:latest"

# HOST_FLEET_DIR is the real host-filesystem path to muaddib/.
# spawn-worker.sh uses it so `docker compose` resolves volume mounts on the
# host rather than against the container's bind-mount path.
export HOST_FLEET_DIR="$FLEET_DIR"

case "${1:-}" in
  --bg)
    docker compose -p "$PROJECT" -f "$COMPOSE_FILE" up -d --build
    echo "→ dispatch-daemon started (logs: docker compose -p ${PROJECT} -f ${COMPOSE_FILE} logs -f)"
    ;;
  --stop)
    docker compose -p "$PROJECT" -f "$COMPOSE_FILE" down
    echo "→ dispatch-daemon stopped"
    ;;
  "")
    docker compose -p "$PROJECT" -f "$COMPOSE_FILE" up --build
    ;;
  *)
    echo "usage: dispatch.sh [--bg|--stop]" >&2
    exit 1
    ;;
esac
